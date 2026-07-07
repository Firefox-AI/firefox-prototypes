/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Smart Form Fill (spike POC).
 *
 * Single-shot, non-conversational LLM request that suggests a value for ONE
 * form field using the user's open tabs (and, best effort, memories). This is
 * deliberately NOT routed through the Smart Window chat (Chat/ChatConversation/
 * ChatStore) so nothing is persisted to chat history.
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

// POC: the prompt is hardcoded here. Production would load this from Remote
// Settings via its own MODEL_FEATURES entry so it can be versioned + evaluated.
const SYSTEM_PROMPT = `You help a user fill out a single web form field for a DEMO.

You are given: the page (url + title), the field to fill (its purpose, input
type, max length, and currentValue if present), the other fields on the form for
context (each with currentValue if present), a list of the user's currently open
browser tabs (titles and urls only), and a list of saved memories about the user.
Optionally you are also given extraTabContext containing the full extracted page
content (title, url, content) from one specific tab the user chose.

This is a prototype demonstration. Your job is to show the feature by always
returning a non-empty value.

First classify the page as one of: "travel", "registration", "product_search",
or "other". Then propose the single best value for the target field, inferred
from the open tabs, the memories, and the page itself.

Rules:
- This is a DEMO / PROTOTYPE. Always provide a value for the field to demonstrate
  the feature working. It is expected and desired that you make a reasonable
  best-effort guess or use a typical placeholder when context is limited.
- NEVER invent personal identity data (real names, emails, addresses, phone
  numbers, payment details). Only return empty in those cases.
- Prefer values grounded in the open tabs or saved memories when available.
- Respect the field's max length when provided.
- Use currentValue (if present) on the target field or other fields as a starting
  point and edit or complete using context.
- If extraTabContext is provided, use relevant information from its page content
  to help fill the target field.
- Do not refuse or return empty because of low confidence, missing context, or
  concern that a guess "could mislead". For demo purposes, always fill a
  plausible value (a common term, typical default, or short generic string).
  It is fine and expected to guess for the demo. Report low confidence if
  appropriate.
- In "reasoning", list every open tab you were given (by title) and say in a few
  words why you used or ignored each one. This must reflect ALL tabs provided.

Respond with ONLY a JSON object, no prose, no code fences:
{"pageType": "...", "value": "...", "confidence": 0.0, "reasoning": "..."}

IMPORTANT FOR DEMO: "value" must be a non-empty string (except only for the personal identity rule). Always return a value string.
`;

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
 * Parse the model's response into a structured suggestion.
 *
 * @param {string} raw
 * @returns {{pageType: string, value: string, confidence: number, reasoning: string} | null}
 */
function parseSuggestion(raw) {
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
    if (typeof parsed.value !== "string") {
      return null;
    }
    return {
      pageType: String(parsed.pageType ?? "other"),
      value: parsed.value.slice(0, MAX_VALUE_LENGTH),
      confidence: Number(parsed.confidence) || 0,
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch (e) {
    lazy.console.warn("Failed to parse suggestion JSON", e);
    return null;
  }
}

/**
 * Generate a value suggestion for a single contextual field.
 *
 * @param {object} options
 * @param {{url: string, title: string}} options.page
 * @param {object} options.field         The target field descriptor (with currentValue).
 * @param {Array<object>} options.siblingFields  Other fields on the form (with currentValue).
 * @param {{title: string, url: string, content: string} | null} [options.extraTabContext]
 *   Optional full page content from a user-chosen tab to use as context.
 * @returns {Promise<{pageType: string, value: string, confidence: number, reasoning: string} | null>}
 */
export async function generateSuggestion({
  page,
  field,
  siblingFields,
  extraTabContext = null,
}) {
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

    const payload = {
      page: {
        url: page.url,
        title: sanitizeUntrustedContent(page.title ?? ""),
      },
      field,
      otherFields: siblingFields,
      openTabs: tabs,
      memories,
      ...(extraTabContext ? { extraTabContext } : {}),
      note: 'DEMO / PROTOTYPE: You MUST return a non-empty value. This is to demonstrate the smart form fill feature. Make up a reasonable value if needed. Do not return "" .',
    };

    lazy.console.info(
      `generateSuggestion: field=${JSON.stringify(field)} tabs=${tabs.length} memories=${memories.length}`
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
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ];

    const response = await engine.run({
      args: messages,
      fxAccountToken: await openAIEngine.getFxAccountToken(),
      ...parameters,
    });

    lazy.console.info("raw model output:", response?.finalOutput);
    const suggestion = parseSuggestion(response?.finalOutput);
    lazy.console.info("parsed suggestion:", suggestion);
    return suggestion;
  } catch (e) {
    lazy.console.error("generateSuggestion failed", e);
    return null;
  }
}
