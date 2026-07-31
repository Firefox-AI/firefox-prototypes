/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** @import { ChatConversation } from "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs" */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  JsonSchema: "resource://gre/modules/JsonSchema.sys.mjs",
  GetPageContent: "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs",
  buildConversation:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  loadPrompt:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  MODEL_FEATURES: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  renderPrompt: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  openAIEngine:
    "moz-src:///browser/components/aiwindow/models/openAIEngine.sys.mjs",
});

// Packaged component schemas (see services/aitab/jar.mn). The service produces
// a validated page config only.
// component_schema.json is a JSON array of schema objects,
// each identified by a short bare $id (e.g. "header") that is both the key used
// for $ref resolution and the block `type`.
const ASSET_BASE = "chrome://browser/content/aiwindow/aitab/";
const COMPONENT_SCHEMA_FILE = "component_schema.json";
// $id of the top-level page schema within the array.
const PAGE_SCHEMA_NAME = "page";

// Dev override: when the pref browser.smartwindow.aitab.components holds a
// non-empty string, it is parsed as the component schema array instead of the
// packaged component_schema.json, so schemas can be iterated on without
// rebuilding.
const COMPONENTS_PREF = "browser.smartwindow.aitab.components";

// Total budget (characters) for page text sent to the model, split evenly
// across the requested tabs so multi-tab requests don't overflow the prompt.
const SOURCE_TEXT_BUDGET = 8000;
// Separator inserted between each page's text in the model prompt.
const PAGE_BREAK = "\n\n<----- PAGE BREAK ---->\n\n";

// ---------------------------------------------------------------- assets ----

/** @type {Promise<object>|undefined} */
let gPackagedEnvPromise;

/**
 * Build a schema `env` from `[name, schema]` entries, where `name` is the
 * schema's bare $id (e.g. "header") — also the token the schemas' $refs use and
 * the block `type`. Indexes the schemas by name, records the block type set
 * (every schema except the page schema) and the ordered name list, and builds a
 * JsonSchema validator rooted at the page schema with the component schemas
 * registered for $ref resolution.
 *
 * @param {Array<[string, object]>} entries
 * @returns {{byName: object, typeSchema: object, names: string[], validator: object|null}}
 */
function makeEnv(entries) {
  const byName = {};
  const typeSchema = {};
  const names = [];
  for (const [name, schema] of entries) {
    if (!(name in byName)) {
      names.push(name);
    }
    byName[name] = schema;
    if (name !== PAGE_SCHEMA_NAME) {
      // name is the bare $id, which is also the block `type`.
      typeSchema[name] = name;
    }
  }
  // Build a spec-compliant validator once: the page schema is the root and each
  // component schema is registered under its $id so the page schema's relative
  // $refs (e.g. "list") resolve.
  const pageSchema = byName[PAGE_SCHEMA_NAME];
  let validator = null;
  if (pageSchema) {
    validator = new lazy.JsonSchema.Validator(pageSchema, {
      shortCircuit: false,
    });
    for (const [name, schema] of Object.entries(byName)) {
      if (name !== PAGE_SCHEMA_NAME) {
        validator.addSchema(schema, schema.$id);
      }
    }
  }
  return {
    byName,
    typeSchema,
    names,
    validator,
  };
}

/**
 * Convert a JSON array of schema objects into `[name, schema]` entries, keyed
 * by each schema's bare $id (e.g. "header"). The trailing split guards against a
 * path-style $id, but the packaged schemas use bare names.
 *
 * @param {object[]} components
 * @returns {Array<[string, object]>}
 */
function entriesFromComponents(components) {
  if (!Array.isArray(components)) {
    throw new Error("aitab component schema must be a JSON array of schemas");
  }
  return components.map(schema => {
    const id = schema?.$id;
    if (!id) {
      throw new Error("aitab component schema entry is missing $id");
    }
    return [id.split("/").pop(), schema];
  });
}

/**
 * Build a schema env from the browser.smartwindow.aitab.components pref when it
 * holds a non-empty string, otherwise null. Read on every call so pref edits
 * take effect without restarting.
 *
 * @returns {object|null}
 */
function loadOverrideEnv() {
  const pref = Services.prefs.getStringPref(COMPONENTS_PREF, "").trim();
  if (!pref) {
    return null;
  }
  let components;
  try {
    components = JSON.parse(pref);
  } catch (e) {
    throw new Error(`failed to parse ${COMPONENTS_PREF}: ${e.message}`);
  }
  return makeEnv(entriesFromComponents(components));
}

/** Fetch and cache the packaged component schema array from chrome://. */
function loadPackagedEnv() {
  if (!gPackagedEnvPromise) {
    gPackagedEnvPromise = fetch(`${ASSET_BASE}${COMPONENT_SCHEMA_FILE}`)
      .then(r => r.json())
      .then(components => makeEnv(entriesFromComponents(components)))
      .catch(error => {
        gPackagedEnvPromise = undefined;
        throw error;
      });
  }
  return gPackagedEnvPromise;
}

/**
 * Load the component schemas: from the browser.smartwindow.aitab.components pref
 * when it is set (see loadOverrideEnv), otherwise from the packaged set.
 *
 * @returns {Promise<{env: object}>}
 */
export async function loadAssets() {
  const env = loadOverrideEnv() ?? (await loadPackagedEnv());
  return { env };
}

/**
 * Validate a page config against the component schemas. The page config is
 * structured data; rendering it to HTML happens in the external viewer, so this
 * service only validates and never assembles markup.
 *
 * @param {object} page
 * @param {object} env
 * @returns {{ok: true, page: object} | {ok: false, errors: object[]}}
 */
export function buildPage(page, env) {
  if (!env.validator) {
    return { ok: false, errors: [{ message: "no page schema" }] };
  }
  // The page schema $refs every component schema (added to the validator in
  // makeEnv), so validating the whole page config covers the header, each body
  // block (via blocks[].oneOf), and the footer in one pass.
  const { valid, errors } = env.validator.validate(page);
  if (!valid) {
    return { ok: false, errors };
  }
  return { ok: true, page };
}

// --------------------------------------------------------- LLM generation ---

/**
 * Concatenate the loaded component schemas for injection into a prompt's
 * `{schemas}` placeholder.
 *
 * @param {object} env
 * @returns {string}
 */
function schemaText(env) {
  // Compact JSON (no indentation) and drop validator-only keys ($id/$schema)
  // the model doesn't need: the `=== name ===` header already identifies each
  // schema, so this trims prompt tokens without losing any guidance.
  return env.names
    .map(name => {
      const schema = { ...env.byName[name] };
      delete schema.$id;
      delete schema.$schema;
      return `=== ${name} ===\n${JSON.stringify(schema)}`;
    })
    .join("\n\n");
}

/**
 * Load the aitab prompt templates and engine from Remote Settings. The
 * "ai-window-prompts" collection ships a packaged dump
 * (services/settings/dumps/main/ai-window-prompts.json), so the records are
 * always available — offline and on first run — without an in-tree fallback.
 * A genuine failure propagates and is surfaced as a generation error by the
 * caller.
 *
 * @returns {Promise<{conversation: object, system: string, user: string}>}
 */
async function resolvePromptSet() {
  const conversation = await lazy.buildConversation(lazy.MODEL_FEATURES.AITAB);
  const [{ prompt: system }, { prompt: user }] = await Promise.all([
    lazy.loadPrompt(lazy.MODEL_FEATURES.AITAB, {
      module: "system-instructions",
    }),
    lazy.loadPrompt(lazy.MODEL_FEATURES.AITAB, { module: "user-data" }),
  ]);
  return { conversation, system, user };
}

/**
 * Extract a JSON object from the model's text output, tolerating markdown code
 * fences or surrounding prose.
 *
 * @param {string} text
 * @returns {object|null}
 */
function parsePageConfig(text) {
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    candidate = fence[1].trim();
  }
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Ask the model for a validated page config for the given source content.
 * Returns the validated page config on success, or an object with an `error`
 * string describing why generation failed.
 *
 * @param {object} options
 * @param {string} options.sourceText
 * @param {string} [options.focus]
 * @returns {Promise<{page: object} | {error: string}>}
 */
async function generateStructuredPage({ sourceText, focus }) {
  try {
    const { env } = await loadAssets();

    const { conversation, system, user } = await resolvePromptSet();
    conversation.setSystemMessage(
      lazy.renderPrompt(system, { schemas: schemaText(env) })
    );
    conversation.addUserMessage(
      lazy.renderPrompt(user, { focus: focus ?? "", pageContent: sourceText })
    );

    const response = await conversation.run({
      fxAccountToken: await lazy.openAIEngine.getFxAccountToken(),
    });

    const text = response?.finalOutput?.trim();
    console.warn(
      `[AITab] model returned ${text ? text.length : 0} chars`,
      text ? text.slice(0, 500) : response
    );
    if (!text) {
      return { error: "the model returned an empty response" };
    }

    const page = parsePageConfig(text);
    if (!page) {
      console.error("[AITab] model did not return valid JSON:", text);
      return { error: "the model did not return valid JSON" };
    }

    const result = buildPage(page, env);
    if (!result.ok) {
      console.error(
        "[AITab] page config failed validation",
        result.errors,
        page
      );
      return { error: "the generated page did not match the required format" };
    }

    console.warn("[AITab] structured page validated successfully");
    return { page: result.page };
  } catch (error) {
    console.error("[AITab] structured generation failed", error);
    return { error: `page generation failed: ${error?.message ?? error}` };
  }
}

/**
 * System prompt for reshaping an existing page config.
 * Uses the same single-schema env as generate (component_schema.json / pref).
 *
 * @param {object} env
 * @returns {string}
 */
function buildReshapeSystemPrompt(env) {
  return `You reshape an existing AITab "page config" according to a user edit.

Respond with ONLY a single JSON object — no prose, no markdown fences.

Rules:
- Return a full page object that validates against the page schema below.
- Apply the EDIT completely (e.g. fewer options, prioritize price, vegetarian).
- Keep the same job and preserve source URLs/hrefs from the current config whenever they still apply.
- Do not invent new facts, prices, ratings, or URLs. Prefer omitting over guessing.
- Keep todo done flags only when still accurate after the edit.
- Prefer the same block mix (list / todo / info / footer) unless the edit requires a structural change.
- Refresh footer buttons: keep useful act links; replace reshape chips (app://aitab/reshape?edit=…) with options still relevant after the edit (omit already-true edits).

SCHEMAS:
${schemaText(env)}`;
}

/**
 * Ask the model to rewrite a prior page config under an edit instruction.
 *
 * @param {object} options
 * @param {object} options.priorPage
 * @param {string} options.edit
 * @returns {Promise<{page: object} | {error: string}>}
 */
async function reshapeStructuredPage({ priorPage, edit }) {
  try {
    const { env } = await loadAssets();

    const conversation = await lazy.buildConversation(lazy.MODEL_FEATURES.CHAT);
    conversation.setSystemMessage(buildReshapeSystemPrompt(env));
    conversation.addUserMessage(
      `EDIT: ${edit}\n\nCURRENT PAGE CONFIG:\n${JSON.stringify(priorPage)}`
    );

    const response = await conversation.run({
      fxAccountToken: await lazy.openAIEngine.getFxAccountToken(),
    });

    const text = response?.finalOutput?.trim();
    if (!text) {
      return { error: "the model returned an empty response" };
    }

    const page = parsePageConfig(text);
    if (!page) {
      return { error: "the model did not return valid JSON" };
    }

    const result = buildPage(page, env);
    if (!result.ok) {
      return { error: "the reshaped page did not match the required format" };
    }

    return { page: result.page };
  } catch (error) {
    return { error: `page reshape failed: ${error?.message ?? error}` };
  }
}

// ------------------------------------------------------------------ public --

/**
 * Turn a title into a lowercase snake_case slug. No persistence, so this is
 * best-effort (not guaranteed unique) — a stable id for the returned metadata.
 *
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return slug || "aitab";
}

// Pref holding the external AITab viewer's base URL. The generate_aitab chat
// tool returns a link to this viewer with the page config in the hash fragment;
// when the pref is empty the tool reports that the viewer is not configured.
const AITAB_VIEWER_URL_PREF = "browser.smartwindow.aitab.viewerURL";

/**
 * Build the external viewer URL for a validated page config. The JSON is placed
 * in the hash fragment so it is never sent to the viewer host.
 *
 * @param {string} viewerBase - Pref-configured base URL (https only).
 * @param {object} page - The validated page config.
 * @returns {string}
 */
export function buildViewerURL(viewerBase, page) {
  const base = viewerBase.trim().replace(/#.*$/, "");
  const hash = encodeURIComponent(JSON.stringify(page));
  return `${base}#${hash}`;
}

/**
 * Resolve and validate the viewer base URL from prefs. Returns null when the
 * pref is empty or is not an https URL.
 *
 * @returns {string|null}
 */
export function getViewerBaseURL() {
  const raw = Services.prefs.getStringPref(AITAB_VIEWER_URL_PREF, "").trim();
  if (!raw) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") {
    return null;
  }
  return raw.replace(/#.*$/, "");
}

/**
 * Generate an AITab from a list of URLs. Each URL's readable content is pulled
 * via get_page_content, then an LLM composes a structured page config that is
 * validated against the packaged schemas. The validated config and its derived
 * metadata are returned to the caller — nothing is persisted and no HTML is
 * assembled here (rendering happens in the external viewer). If generation
 * fails, an `error` string describing the problem is returned instead.
 *
 * @param {object} options
 * @param {string[]} options.url_list - The URLs to include, already expanded
 *   from URL tokens by the tool dispatcher.
 * @param {string} [options.focus] - What the user wants the page to focus on.
 * @param {AbortSignal} [options.signal] - Cancels in-flight page extractions.
 * @param {ChatConversation} conversation
 * @returns {Promise<{metadata: object, page: object} | {error: string}>}
 *   The derived metadata and validated page config, or an error description.
 */
export async function generateAITab(
  { url_list, focus, signal } = {},
  conversation
) {
  const urls = Array.isArray(url_list)
    ? url_list.filter(url => typeof url === "string")
    : [];

  if (!urls.length) {
    return { error: "no URLs were provided to build a page from" };
  }

  // Pull the readable content for each requested URL (order-aligned with urls).
  const contents = await lazy.GetPageContent.getPageContent(
    { url_list: urls, signal },
    conversation
  );

  // Split the source-text budget evenly across the requested tabs so the model
  // prompt stays bounded no matter how many tabs are included.
  const perTabBudget = Math.floor(SOURCE_TEXT_BUDGET / urls.length);

  const urlsUsed = [];
  const sourceParts = [];
  urls.forEach((url, index) => {
    // Prefer the open tab's title for the heading; fall back to the URL.
    const tab = lazy.GetPageContent.getTabWithURL(url);
    const heading = tab?.label || url;
    const text = contents[index] ?? "";
    urlsUsed.push({
      url,
      title: heading,
      favIconUrl: `page-icon:${url}`,
      extractedText: text,
    });
    // Trim each page's text to its share of the budget before sending to the
    // model.
    const budgetedText =
      text.length > perTabBudget ? text.slice(0, perTabBudget) : text;
    sourceParts.push(`## ${heading}\nURL: ${url}\n\n${budgetedText}`);
  });

  const focusText = typeof focus === "string" ? focus.trim() : "";

  // Compose the page with the LLM. Pages are separated by an explicit
  // page-break marker in the prompt.
  const structured = await generateStructuredPage({
    sourceText: sourceParts.join(PAGE_BREAK),
    focus: focusText,
  });

  if (structured.error) {
    return { error: structured.error };
  }

  const title =
    structured.page.header?.title ||
    focusText ||
    (urls.length === 1 && urlsUsed[0].title) ||
    "Generated page";

  const metadata = {
    id: slugify(title),
    title,
    howCreated: "chat",
    themeId: structured.page.theme || "default",
    context: {
      creationPrompt: focusText,
      urlsUsed,
      relevantMemories: [],
    },
    components: structured.page.blocks || [],
  };

  return { metadata, page: structured.page };
}

/**
 * Find an open tab by URL in any browser window (not only AI windows).
 * Used by the GenTab menu companion path.
 *
 * @param {string} url
 * @returns {object|null} tab
 */
function getOpenTabWithURL(url) {
  if (!url) {
    return null;
  }
  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    if (win.closed || !win.gBrowser) {
      continue;
    }
    for (const tab of win.gBrowser.tabs) {
      if (tab?.linkedBrowser?.currentURI?.spec === url) {
        return tab;
      }
    }
  }
  return null;
}

/**
 * Extract cleaned text from an already-open tab (no network fetch).
 *
 * @param {object} tab
 * @param {string} url
 * @returns {Promise<string>}
 */
async function extractOpenTabText(tab, url) {
  try {
    const currentWindowContext =
      tab.linkedBrowser?.browsingContext?.currentWindowContext;
    if (!currentWindowContext) {
      return "";
    }
    const pageExtractor = await currentWindowContext.getActor("PageExtractor");
    const extraction = await pageExtractor.getText({
      sufficientLength: SOURCE_TEXT_BUDGET,
      cleanWhitespace: true,
      removeBoilerplate: true,
      sourceUrl: url,
    });
    return extraction?.text || "";
  } catch (error) {
    console.warn("AITab: open-tab extract failed", url, error);
    return "";
  }
}

/**
 * Build the companion focus string for menu-created AITabs.
 *
 * @param {object} options
 * @param {string} [options.groupLabel]
 * @param {number} options.sourceCount
 * @returns {string}
 */
export function companionFocusForSources({ groupLabel, sourceCount }) {
  const parts = [
    "Companion plan from the user's open tabs: condensed, revisit-worthy next steps.",
    "Prefer todo (actionable steps) plus list when comparing options; ground hrefs in source URLs.",
    "Include footer act link(s) and 2–4 reshape chips (app://aitab/reshape?edit=…).",
  ];
  if (groupLabel) {
    parts.push(`Job label from tab group: "${groupLabel}".`);
  }
  if (sourceCount > 1) {
    parts.push(`Synthesize across all ${sourceCount} open source tabs.`);
  }
  return parts.join(" ");
}

/**
 * Generate an AITab from open browser tabs (GenTab menu companion path).
 * Does not require a chat conversation. Only reads already-open tabs
 * (no headless fetch). Opens nothing — returns the viewer URL + page.
 *
 * @param {object} options
 * @param {string[]} options.url_list - Open tab URLs to include
 * @param {string} [options.focus] - Companion focus / group intent
 * @param {string} [options.groupLabel] - Tab group name (folded into focus)
 * @returns {Promise<{url: string, page: object} | {error: string}>}
 */
export async function generateAITabFromOpenTabs({
  url_list,
  focus,
  groupLabel,
} = {}) {
  const viewerBase = getViewerBaseURL();
  if (!viewerBase) {
    return {
      error:
        "AITab viewer URL is not configured (set browser.smartwindow.aitab.viewerURL to an https URL)",
    };
  }

  const urls = Array.isArray(url_list)
    ? [...new Set(url_list.filter(url => typeof url === "string" && url))]
    : [];
  if (!urls.length) {
    return { error: "no URLs were provided to build a page from" };
  }

  const perTabBudget = Math.floor(SOURCE_TEXT_BUDGET / urls.length);
  const sourceParts = [];

  for (const url of urls) {
    const tab = getOpenTabWithURL(url);
    if (!tab) {
      sourceParts.push(`## ${url}\nURL: ${url}\n\n(Tab not open; skipped.)`);
      continue;
    }
    const heading = tab.label || url;
    const text = await extractOpenTabText(tab, url);
    const budgetedText =
      text.length > perTabBudget ? text.slice(0, perTabBudget) : text;
    sourceParts.push(`## ${heading}\nURL: ${url}\n\n${budgetedText}`);
  }

  const hasContent = sourceParts.some(
    part => !part.includes("(Tab not open; skipped.)") && part.length > 40
  );
  if (!hasContent) {
    return { error: "could not extract content from the selected tabs" };
  }

  let focusText =
    typeof focus === "string" && focus.trim()
      ? focus.trim()
      : companionFocusForSources({
          groupLabel: typeof groupLabel === "string" ? groupLabel.trim() : "",
          sourceCount: urls.length,
        });
  if (groupLabel && !focusText.includes(groupLabel)) {
    focusText = `${focusText} Job label: "${groupLabel}".`;
  }

  const structured = await generateStructuredPage({
    sourceText: sourceParts.join(PAGE_BREAK),
    focus: focusText,
  });

  if (structured.error) {
    return { error: structured.error };
  }

  return {
    url: buildViewerURL(viewerBase, structured.page),
    page: structured.page,
  };
}

/**
 * Normalize a viewer base URL for comparison (strip hash + trailing slash).
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeViewerBase(url) {
  return url.trim().replace(/#.*$/, "").replace(/\/$/, "");
}

/**
 * True when the URI (without hash) matches the configured AITab viewer base.
 *
 * @param {string|nsIURI} uri
 * @returns {boolean}
 */
export function isAITabViewerURI(uri) {
  const viewerBase = getViewerBaseURL();
  if (!viewerBase || !uri) {
    return false;
  }
  const spec = typeof uri === "string" ? uri : uri.spec;
  if (!spec) {
    return false;
  }
  const base = normalizeViewerBase(spec.split("#")[0] || spec);
  return base === normalizeViewerBase(viewerBase);
}

/**
 * Parse and lightly check page JSON from an AITab viewer tab URI hash.
 * Does not full-schema-validate (that happens after reshape); returns null
 * when the URI is not the configured viewer or the hash is not an object.
 *
 * @param {string|nsIURI} uri
 * @returns {object|null}
 */
export function parsePageFromViewerURI(uri) {
  if (!isAITabViewerURI(uri)) {
    return null;
  }
  const spec = typeof uri === "string" ? uri : uri.spec;
  const hashIndex = spec.indexOf("#");
  if (hashIndex < 0 || hashIndex === spec.length - 1) {
    return null;
  }
  const rawHash = spec.slice(hashIndex + 1);
  let page;
  try {
    page = JSON.parse(decodeURIComponent(rawHash));
  } catch {
    try {
      page = JSON.parse(rawHash);
    } catch {
      return null;
    }
  }
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    return null;
  }
  if (!Array.isArray(page.blocks)) {
    return null;
  }
  return page;
}

/**
 * Reshape an existing AITab page config and return a new viewer URL.
 * Prior page is typically parsed from the current tab URI hash.
 *
 * @param {object} options
 * @param {object} options.priorPage - Existing validated-ish page config
 * @param {string} options.edit - Reshape instruction (e.g. "Fewer options")
 * @returns {Promise<{url: string, page: object} | {error: string}>}
 */
export async function refineAITab({ priorPage, edit } = {}) {
  const viewerBase = getViewerBaseURL();
  if (!viewerBase) {
    return {
      error:
        "AITab viewer URL is not configured (set browser.smartwindow.aitab.viewerURL to an https URL)",
    };
  }

  const editText = typeof edit === "string" ? edit.trim() : "";
  if (!editText) {
    return { error: "no edit instruction was provided" };
  }
  if (!priorPage || typeof priorPage !== "object") {
    return { error: "no prior page config was provided" };
  }

  const structured = await reshapeStructuredPage({
    priorPage,
    edit: editText,
  });
  if (structured.error) {
    return { error: structured.error };
  }

  return {
    url: buildViewerURL(viewerBase, structured.page),
    page: structured.page,
  };
}

/**
 * Navigate a browser to a viewer URL (same tab). Only accepts URLs whose base
 * matches the configured viewer (prevents open redirects from tool output).
 *
 * @param {MozBrowser} browser
 * @param {string} url
 * @returns {boolean}
 */
export function loadAITabViewerURL(browser, url) {
  if (!browser || typeof url !== "string") {
    return false;
  }
  if (!isAITabViewerURI(url)) {
    return false;
  }
  try {
    browser.documentGlobal.openLinkIn(url, "current", {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal(
        {}
      ),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
    });
    return true;
  } catch (error) {
    console.error("AITab: failed to load viewer URL", error);
    return false;
  }
}
