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
 *   sent to the model. This module only ever receives field STRUCTURE.
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
  loadCallContext:
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
const SYSTEM_PROMPT = `You help a user fill out a single web form field.

You are given: the page (url + title), the field to fill (its purpose, input
type, and max length), the other fields on the form for context, a list of the
user's currently open browser tabs, and a list of saved memories about the user.

First classify the page as one of: "travel", "registration", "product_search",
or "other". Then propose the single best value for the target field, inferred
from the open tabs, the memories, and the page itself.

Rules:
- NEVER invent personal identity data (real names, emails, addresses, phone
  numbers, payment details). If the field needs that, return an empty value.
- Prefer values grounded in the open tabs or saved memories (a destination being
  researched, a product being shopped for, a likely search query).
- Respect the field's max length when provided.
- If you are not reasonably confident, return an empty value with low confidence.
- In "reasoning", list every open tab you were given (by title) and say in a few
  words why you used or ignored each one. This must reflect ALL tabs provided.

Respond with ONLY a JSON object, no prose, no code fences:
{"pageType": "...", "value": "...", "confidence": 0.0, "reasoning": "..."}`;

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
 * @param {object} options.field         The clicked field descriptor (no value).
 * @param {Array<object>} options.siblingFields  Other fields on the form (no values).
 * @returns {Promise<{pageType: string, value: string, confidence: number, reasoning: string} | null>}
 */
export async function generateSuggestion({ page, field, siblingFields }) {
  try {
    // POC: borrow an existing feature's call context to get a working model.
    // Production gets its own MODEL_FEATURES + Remote Settings prompt config.
    const callContext = await lazy.loadCallContext(
      MODEL_FEATURES.TITLE_GENERATION
    );
    // POC: reuse the borrowed feature's purpose verbatim. `purpose` is sent as
    // an HTTP header the endpoint validates against known features, so a custom
    // value (e.g. "smart_form_fill") is rejected with a 400. Production gets its
    // own registered feature + purpose.
    const engine = await openAIEngine.build({
      model: callContext.model,
      serviceType: callContext.serviceType,
      purpose: callContext.purpose,
      feature: MODEL_FEATURES.TITLE_GENERATION,
    });

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
    };

    lazy.console.info(
      `generateSuggestion: field=${JSON.stringify(field)} tabs=${tabs.length} memories=${memories.length}`
    );
    lazy.console.info(
      `open tabs sent as context (${tabs.length}):\n` +
        tabs.map((t, i) => `  ${i + 1}. ${t.title} | ${t.url}`).join("\n")
    );
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
      ...callContext.parameters,
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
