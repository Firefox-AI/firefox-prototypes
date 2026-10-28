/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Suggests web searches for the tab the user is reading, and runs the one
 * they pick in a new tab.
 *
 * Each query needs a live result the page does not already show. A Best Buy
 * MacBook page that lists the price might be "MacBook Air open-box near me",
 * not "MacBook price". A Boston chili page might be "best chili in Boston".
 * Choosing one loads the default search engine. It does not start a
 * conversation.
 */

import { AuthProvider } from "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs";
import {
  makeJSONSchemaBlob,
  MODEL_FEATURES,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";
import { readSelectedPage } from "moz-src:///browser/components/aiwindow/ui/modules/PageActionSuggestions.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  buildConversation:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchUIUtils: "moz-src:///browser/components/search/SearchUIUtils.sys.mjs",
});

const MAX_QUERIES = 2;
const MAX_QUERY = 64;

const CHAT_QUERY =
  /^(please|can you|could you|would you|help me|tell me|explain|summarize|summarise|rewrite|write|chat about|what do you think)\b/i;

const SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    searches: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["searches"],
};

const SYSTEM_PROMPT = `You suggest up to 2 toolbar buttons. Each button runs a web search for something this page does not already show.
Read the page first. If it shows a price, spec, rating, or hours, that fact is not a search.
A Best Buy page that lists a MacBook's price might be "MacBook Air open-box near me" or "MacBook Air Costco price". It must not be "MacBook price".
A chili recipe from Boston might be "best chili in Boston". It must not be "chili powder substitute" or "best chili toppings".
A search is another place, another seller, nearby stock, hours somewhere else, tickets, or recent reviews the page does not include.
Do not suggest general knowledge. Substitutes, toppings, techniques, and "how do I" are for a chat.
Use a place, business, or product named on the page. Do not invent a city the page does not mention. "Near me" is fine when the page has no place.
The string is the search text and the button label: at most 6 words, no ending punctuation.
Skip a search when the page already answers it. An empty list is fine.
Return JSON {"searches": ["query"]} and nothing else.`;

const SELECTION_SYSTEM_PROMPT = `You suggest up to 2 toolbar buttons. Each button runs a web search about the part of the page the user selected.
The selection is highlighted text, or a description of a region they circled. It is the only subject.
Every query must be about that selection and must look up something the selection and the page do not already show.
If the selection shows a price, spec, rating, or hours, do not search for that fact.
A search is another place, another seller, nearby stock, or recent reviews that are not already written there.
Do not suggest general knowledge. Substitutes, toppings, techniques, and "how do I" are for a chat.
Use a place, business, or product from the selection. Do not invent a city the selection does not mention.
The string is the search text and the button label: at most 6 words, no ending punctuation.
Skip a search when the selection already answers it. An empty list is fine.
Return JSON {"searches": ["query"]} and nothing else.`;

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.pageTitle]
 * @param {Element} [options.browser] - Selected browser. Read in place so a
 *   Classic window is not limited to tabs open in a Smart Window.
 * @param {string} [options.selectionText] - Highlighted text or a description
 *   of a region the user circled. When present it is the only subject.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{queries: string[], pending: boolean}>} pending is true
 *   when the document is still loading and has no text yet.
 */
export async function suggestSearchActions({
  url,
  pageTitle,
  browser,
  selectionText,
  signal,
}) {
  signal?.throwIfAborted();
  if (!/^https?:/i.test(url ?? "")) {
    return { queries: [], pending: false };
  }

  const selection = selectionText?.trim() ?? "";
  const { text, pending } = await readSelectedPage(browser, url, signal);
  if (pending && !selection) {
    return { queries: [], pending: true };
  }

  const conversation = await lazy.buildConversation(
    MODEL_FEATURES.AGENT_MONITOR
  );
  signal?.throwIfAborted();
  conversation.setSystemMessage(
    selection ? SELECTION_SYSTEM_PROMPT : SYSTEM_PROMPT
  );
  const body = text ? `\n\nPage text, background only:\n${text}` : "";
  const selected = selection
    ? "The user selected this region. Every search must be about it:\n" +
      `${selection}\n\n`
    : "";
  const again = selection
    ? "\n\nEvery search is about the selected region above and looks up something it does not already show. " +
      "Do not search for a price, spec, or fact written there."
    : "\n\nEvery search looks up something this page does not already show. " +
      "If the page lists a price, do not search for that product's price.";
  conversation.addUserMessage(
    `${selected}Title: ${pageTitle || "Untitled"}\nURL: ${url}${body}${again}`
  );
  const response = await conversation.run({
    token: await AuthProvider.getToken(),
    inferenceParams: {
      response_format: makeJSONSchemaBlob(
        "SearchActionSuggestions",
        SEARCH_SCHEMA
      ),
    },
    tools: [],
  });
  signal?.throwIfAborted();
  return { queries: sanitizeQueries(response?.finalOutput), pending: false };
}

/**
 * Loads the query in the default search engine in a new tab. The current
 * page stays put, and no conversation opens.
 *
 * @param {ChromeWindow} win
 * @param {string} query
 * @returns {Promise<void>}
 */
export async function openSearchQuery(win, query) {
  const searchText = clip(query);
  if (!searchText || win.closed) {
    return;
  }
  await lazy.SearchUIUtils.loadSearch({
    window: win,
    searchText,
    where: "tab",
    usePrivateWindow: lazy.PrivateBrowsingUtils.isWindowPrivate(win),
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    sapSource: "smartwindow_assistant",
  });
}

/**
 * @param {string} [raw]
 * @returns {string[]}
 */
function sanitizeQueries(raw) {
  const parsed = parseJson(raw);
  const list = Array.isArray(parsed?.searches) ? parsed.searches : [];
  const queries = [];
  const seen = new Set();
  for (const item of list) {
    if (queries.length >= MAX_QUERIES) {
      break;
    }
    const query = clip(item).replace(/[.!?]+$/, "");
    const key = query.toLowerCase();
    if (!query || CHAT_QUERY.test(query) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    queries.push(query);
  }
  return queries;
}

/**
 * @param {string} [raw]
 * @returns {?object}
 */
function parseJson(raw) {
  const text = String(raw ?? "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced ? fenced[1].trim() : text);
  } catch {
    return null;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function clip(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY);
}
