/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** @import { ChatConversation } from "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs" */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
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
