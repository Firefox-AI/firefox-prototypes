/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Smart Form Fill (spike POC).
 *
 * Single-shot, non-conversational LLM request that suggests values for one or
 * more form fields using the user's open tabs (and, best effort, memories).
 * Single-field fill is the same path as multi-field: a form with fields.length
 * of 1. This is deliberately NOT routed through the Smart Window chat
 * (Chat/ChatConversation/ChatStore) so nothing is persisted to chat history.
 *
 * Safety invariants for the spike:
 * - The user's saved data (form history, addresses, cards, logins) is NEVER
 *   sent to the model. This module receives field STRUCTURE plus currentValue
 *   for fields.
 * - Only contextual fields reach the model. Identity classification and the
 *   decision to call this module at all live in SmartFormFillParent.
 */

import {
  openAIEngine,
  MODEL_FEATURES,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";
import { sanitizeUntrustedContent } from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  MemoriesManager:
    "moz-src:///browser/components/aiwindow/models/memories/MemoriesManager.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  buildEngineForFeature:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "SmartFormFill",
    // POC: force-on so the spike trace is always visible.
    maxLogLevel: "Debug",
  })
);

// Mirror the Smart Window tab tool: cap how many tabs we expose as context and
// only ever look at normal web pages. These are untrusted and get sanitized.
const MAX_CONTEXT_TABS = 15;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Hard cap on the generated value regardless of the field's own maxlength.
const MAX_VALUE_LENGTH = 200;

// Cap alternatives requested from the model (matches UI pref clamp).
const MAX_ALTERNATIVES = 5;

/**
 * POC system prompt. Production would load this from Remote Settings via its
 * own MODEL_FEATURES entry so it can be versioned + evaluated.
 *
 * @param {number} alternativeCount  How many alternatives beyond the primary.
 * @returns {string}
 */
function buildSystemPrompt(alternativeCount) {
  const n = Math.max(0, Math.min(MAX_ALTERNATIVES, alternativeCount | 0));
  const altRules =
    n === 0
      ? `- For each field set "alternatives" to an empty array [].`
      : `- For each field provide exactly ${n} alternative suggestion(s) in
  "alternatives", each with its own value, confidence (0..1), and short
  reasoning (one sentence).
- Alternatives MUST be meaningfully different from the primary "value" and
  from each other — vary phrasing, specificity, or plausible options (e.g.
  different cities, product terms, or phrasings). Do not repeat near-duplicates.
- Rank alternatives by confidence descending when possible. Prefer grounded
  variety from open tabs / memories when available; otherwise offer distinct
  plausible demo options.`;

  return `You help a user fill out web form fields for a DEMO.

You are given: the page (url + title), an array of fields to fill (each with
id, purpose, input type, max length, and currentValue if present), a list of
the user's currently open browser tabs (titles and urls only), and a list of
saved memories about the user. Optionally you are also given extraTabContext
containing the full extracted page content (title, url, content) from one
specific tab the user chose. You are also told alternativeCount (${n}): how
many alternative suggestions to include per field beyond the primary value.

The fields array may contain one field or many. Treat both the same: propose a
primary value for every field in the array.

This is a prototype demonstration. Your job is to show the feature by always
returning a non-empty primary value for each field.

First classify the page as one of: "travel", "registration", "product_search",
or "other". Then propose the best primary value for each field, inferred from
the open tabs, the memories, the page itself, and the other fields being filled
(keep multi-field values consistent).

Rules:
- This is a DEMO / PROTOTYPE. Always provide a primary value for each field to
  demonstrate the feature working. It is expected and desired that you make a
  reasonable best-effort guess or use a typical placeholder when context is
  limited.
- NEVER invent personal identity data (real names, emails, addresses, phone
  numbers, payment details). Only return empty value in those cases.
- Prefer values grounded in the open tabs or saved memories when available.
- Respect each field's max length when provided.
- Use currentValue (if present) on a field as a starting point and edit or
  complete using context.
- If extraTabContext is provided, use relevant information from its page content
  to help fill the fields.
- Do not refuse or return empty because of low confidence, missing context, or
  concern that a guess "could mislead". For demo purposes, always fill a
  plausible primary value (a common term, typical default, or short generic
  string). It is fine and expected to guess for the demo. Report low confidence
  if appropriate.
- Keep multi-field answers consistent (e.g. same trip, same product intent).
- In overall "reasoning", list every open tab you were given (by title) and say
  in a few words why you used or ignored each one. This must reflect ALL tabs
  provided.
${altRules}

Respond with ONLY a JSON object, no prose, no code fences:
{"pageType": "...", "reasoning": "...", "fields": [{"id": 0, "value": "...", "confidence": 0.0, "reasoning": "...", "alternatives": [{"value": "...", "confidence": 0.0, "reasoning": "..."}]}, ...]}

- "fields" MUST include one entry for every input field id you were given.
- Match each entry's "id" to the corresponding field id from the input.
- Primary "value" is the best single choice; "alternatives" holds ${n} other
  option(s) (or [] if ${n} is 0).
- IMPORTANT FOR DEMO: each primary "value" must be a non-empty string (except
  only for the personal identity rule). Always return a value string per field.
`;
}

/**
 * Collect open tabs as lightweight, sanitized context.
 *
 * @returns {Array<{title: string, url: string}>}
 */
function gatherOpenTabs() {
  const tabs = [];
  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    if (lazy.PrivateBrowsingUtils?.isWindowPrivate?.(win)) {
      continue;
    }
    for (const tab of win.gBrowser?.tabs ?? []) {
      const uri = tab.linkedBrowser?.currentURI;
      if (!uri || !ALLOWED_PROTOCOLS.has(uri.scheme + ":")) {
        continue;
      }
      tabs.push({
        title: sanitizeUntrustedContent(tab.label ?? ""),
        url: uri.spec,
      });
      if (tabs.length >= MAX_CONTEXT_TABS) {
        return tabs;
      }
    }
  }
  return tabs;
}

/**
 * Memory summaries, read from the same source the Smart Window chat uses
 * (MemoriesManager.getAllMemories). Best effort: returns none on any failure or
 * when the memories feature is off.
 *
 * @returns {Promise<Array<string>>}
 */
async function gatherMemories() {
  try {
    const memories = await lazy.MemoriesManager.getAllMemories();
    return memories.map(m => m.memory_summary).filter(Boolean);
  } catch (e) {
    lazy.console.warn("gatherMemories failed", e);
    return [];
  }
}

/**
 * @param {object} alt
 * @returns {{value: string, confidence: number, reasoning: string} | null}
 */
function normalizeAlternative(alt) {
  if (!alt || typeof alt.value !== "string" || !alt.value.trim()) {
    return null;
  }
  return {
    value: alt.value.slice(0, MAX_VALUE_LENGTH),
    confidence: Number(alt.confidence) || 0,
    reasoning: String(alt.reasoning ?? "").trim(),
  };
}

/**
 * Normalize one field suggestion from model output.
 *
 * @param {object} entry
 * @param {string} pageType
 * @param {string} overallReasoning
 * @param {number} maxAlternatives
 * @returns {{id: number, pageType: string, value: string, confidence: number, reasoning: string, alternatives: Array<{value: string, confidence: number, reasoning: string}>} | null}
 */
function normalizeFieldSuggestion(
  entry,
  pageType,
  overallReasoning,
  maxAlternatives
) {
  if (!entry || typeof entry.value !== "string") {
    return null;
  }
  const value = entry.value.slice(0, MAX_VALUE_LENGTH);
  const alternatives = [];
  if (maxAlternatives > 0 && Array.isArray(entry.alternatives)) {
    const seen = new Set([value.toLowerCase()]);
    for (const raw of entry.alternatives) {
      const alt = normalizeAlternative(raw);
      if (!alt) {
        continue;
      }
      const key = alt.value.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      alternatives.push(alt);
      if (alternatives.length >= maxAlternatives) {
        break;
      }
    }
  }
  return {
    id: Number.isFinite(Number(entry.id)) ? Number(entry.id) : -1,
    pageType,
    value,
    confidence: Number(entry.confidence) || 0,
    reasoning: String(entry.reasoning ?? overallReasoning ?? ""),
    alternatives,
  };
}

/**
 * Parse the model's response into per-field suggestions keyed by field id.
 *
 * Accepts the batch shape, and is forgiving about a legacy single-field object
 * ({value, confidence, ...}) when only one field was requested.
 *
 * @param {string} raw
 * @param {number} expectedCount
 * @param {number} maxAlternatives
 * @returns {Map<number, object> | null}
 */
function parseSuggestions(raw, expectedCount, maxAlternatives) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  // Be forgiving about stray code fences or surrounding text.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    const pageType = String(parsed.pageType ?? "other");
    const overallReasoning = String(parsed.reasoning ?? "");
    const byId = new Map();

    if (Array.isArray(parsed.fields)) {
      for (const entry of parsed.fields) {
        const suggestion = normalizeFieldSuggestion(
          entry,
          pageType,
          overallReasoning,
          maxAlternatives
        );
        if (suggestion && suggestion.id >= 0) {
          byId.set(suggestion.id, suggestion);
        }
      }
      // If the model omitted ids but returned the right count, map by index.
      if (!byId.size && parsed.fields.length === expectedCount) {
        parsed.fields.forEach((entry, index) => {
          const suggestion = normalizeFieldSuggestion(
            { ...entry, id: index },
            pageType,
            overallReasoning,
            maxAlternatives
          );
          if (suggestion) {
            byId.set(index, suggestion);
          }
        });
      }
    } else if (typeof parsed.value === "string" && expectedCount === 1) {
      // Single-field object shape (or model collapsed a 1-field form).
      const suggestion = normalizeFieldSuggestion(
        {
          id: 0,
          value: parsed.value,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          alternatives: parsed.alternatives,
        },
        pageType,
        overallReasoning,
        maxAlternatives
      );
      if (suggestion) {
        byId.set(0, suggestion);
      }
    }

    return byId.size ? byId : null;
  } catch (e) {
    lazy.console.warn("Failed to parse suggestions JSON", e);
    return null;
  }
}

/**
 * Strip anything the model must not see (e.g. ContentDOMReference ids).
 *
 * @param {object} field
 * @param {number} id
 * @returns {object}
 */
function toModelField(field, id) {
  return {
    id,
    fieldName: field.fieldName || "",
    inputType: field.inputType || "",
    name: field.name || "",
    maxLength: field.maxLength ?? null,
    currentValue: field.currentValue ?? null,
  };
}

/**
 * Generate value suggestions for one or more contextual fields in a single
 * model call. A single field is just fields.length === 1.
 *
 * @param {object} options
 * @param {{url: string, title: string}} options.page
 * @param {Array<object>} options.fields
 *   Field descriptors to fill (structure + currentValue only). Order is stable;
 *   results are keyed by the 0-based index assigned here.
 * @param {{title: string, url: string, content: string} | null} [options.extraTabContext]
 *   Optional full page content from a user-chosen tab to use as context.
 * @param {number} [options.alternativeCount]
 *   How many alternative suggestions to request per field (beyond primary).
 * @returns {Promise<Map<number, object> | null>}
 */
export async function generateSuggestions({
  page,
  fields,
  extraTabContext = null,
  alternativeCount = 0,
}) {
  if (!Array.isArray(fields) || !fields.length) {
    return null;
  }

  const maxAlternatives = Math.max(
    0,
    Math.min(MAX_ALTERNATIVES, alternativeCount | 0)
  );

  try {
    // POC: borrow an existing feature's call context to get a working model.
    // Production gets its own MODEL_FEATURES + Remote Settings prompt config.
    const { engine, parameters } = await lazy.buildEngineForFeature(
      MODEL_FEATURES.TITLE_GENERATION
    );
    // POC: reuse the borrowed feature's purpose verbatim. `purpose` is sent as
    // an HTTP header the endpoint validates against known features, so a custom
    // value (e.g. "smart_form_fill") is rejected with a 400. Production gets its
    // own registered feature + purpose.

    const tabs = gatherOpenTabs();
    const memories = await gatherMemories();
    const modelFields = fields.map((field, id) => toModelField(field, id));

    const payload = {
      page: {
        url: page.url,
        title: sanitizeUntrustedContent(page.title ?? ""),
      },
      fields: modelFields,
      openTabs: tabs,
      memories,
      alternativeCount: maxAlternatives,
      ...(extraTabContext ? { extraTabContext } : {}),
      note: 'DEMO / PROTOTYPE: You MUST return a non-empty primary value for every field. Make up a reasonable value if needed. Do not return "" . Provide distinct alternatives when alternativeCount > 0.',
    };

    lazy.console.info(
      `generateSuggestions: fields=${modelFields.length} alternatives=${maxAlternatives} tabs=${tabs.length} memories=${memories.length}`
    );
    lazy.console.info(
      `fields to fill:\n` +
        modelFields
          .map(
            f =>
              `  id=${f.id} name=${f.name} fieldName=${f.fieldName} current=${JSON.stringify(f.currentValue)}`
          )
          .join("\n")
    );
    lazy.console.info(
      `open tabs sent as context (${tabs.length}):\n` +
        tabs.map((t, i) => `  ${i + 1}. ${t.title} | ${t.url}`).join("\n")
    );
    if (extraTabContext) {
      lazy.console.info(
        `extra tab context: ${extraTabContext.title} | ${extraTabContext.url} (content len=${(extraTabContext.content || "").length})`
      );
    }
    lazy.console.info(
      `memories sent as context (${memories.length}):\n` +
        memories.map((m, i) => `  ${i + 1}. ${m}`).join("\n")
    );
    lazy.console.debug("full prompt payload:", JSON.stringify(payload));

    const messages = [
      { role: "system", content: buildSystemPrompt(maxAlternatives) },
      { role: "user", content: JSON.stringify(payload) },
    ];

    const response = await engine.run({
      args: messages,
      fxAccountToken: await openAIEngine.getFxAccountToken(),
      ...parameters,
    });

    lazy.console.info("raw model output:", response?.finalOutput);
    const suggestions = parseSuggestions(
      response?.finalOutput,
      modelFields.length,
      maxAlternatives
    );
    lazy.console.info(
      "parsed suggestions:",
      suggestions ? Object.fromEntries(suggestions) : null
    );
    return suggestions;
  } catch (e) {
    lazy.console.error("generateSuggestions failed", e);
    return null;
  }
}
