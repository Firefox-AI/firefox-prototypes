/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * One suggestion call for the actions toolbar.
 *
 * The model ranks chat, search, new-page, and watch actions together and
 * returns at most six. A weak action is left out. Search is only for a live
 * lookup the page does not already show. A new page carries the focus the
 * generator needs.
 */

import { AuthProvider } from "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs";
import { addMemoriesToPrompt } from "moz-src:///browser/components/aiwindow/models/ConversationSuggestions.sys.mjs";
import { sanitizeUntrustedContent } from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";
import {
  makeJSONSchemaBlob,
  MODEL_FEATURES,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";
import { readSelectedPage } from "moz-src:///browser/components/aiwindow/ui/modules/PageActionSuggestions.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  buildConversation:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  loadPrompt:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
});

const MAX_ACTIONS = 6;
const MAX_CHAT_WORDS = 6;
const MAX_CHAT = 48;
const MAX_LABEL = 48;
const MAX_SEARCH = 64;
const MAX_FOCUS = 400;
const MAX_OTHER_TABS = 5;

const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          label: { type: "string" },
          detail: { type: "string" },
        },
        required: ["kind", "label", "detail"],
      },
    },
  },
  required: ["actions"],
};

const SHARED_RULES = `Return at most 6 actions, most useful first. Stop when the next one would be weak. An empty list is fine.
Each idea gets one kind. Do not suggest the same change twice.

kind "page": a new document made from this page. Choosing it builds that page. label is at most 4 words, no ending punctuation. detail is one or two sentences for the page generator. A recipe might be "Vegan version" or "Double for a party". A rewritten page is always this kind.

kind "chat": a short question to talk through, at most 6 words, no ending punctuation. detail is "". Use it for a judgment, an explanation, or a choice. A recipe might be "Is this too spicy" or "Which beans are optional". A new version of the page is not a chat. "Vegetarian version" next to "Vegan version" is the same page idea, so keep only the page.

kind "search": a web search for something this page does not already show: another seller, nearby stock, another place, hours somewhere else, or reviews the page lacks. A Best Buy page that lists a MacBook price might be "MacBook Air open-box near me", never "MacBook price". A Boston chili page might be "best chili in Boston", never "chili powder substitute". Do not invent a city the page does not name. detail is "". A search is not a new page and not a question the assistant can answer.

kind "watch": label is one of the watch ids listed below. detail is "". Include one only when that task is more useful than another action.

A how-to or a substitute is a chat. A rewritten page is a page. A live lookup is a search.
Return JSON {"actions": [{"kind", "label", "detail"}]} and nothing else.`;

const PAGE_LEAD = `You choose toolbar actions for the page the user is reading.`;

const SELECTION_LEAD = `You choose toolbar actions for the part of the page the user selected.
The selection is highlighted text, or a description of a region they circled. It is the only subject.
Every action must be about the selection. The rest of the page is background.`;

/**
 * @typedef {object} ToolbarWatchChoice
 * @property {string} id - Stable watch id, used as the action label.
 * @property {string} description - What the task does, for the prompt only.
 */

/**
 * @typedef {object} ToolbarSuggestedAction
 * @property {"chat"|"search"|"page"|"watch"} kind - Which action this is.
 * @property {string} [label] - Button text. For a watch, this is the id.
 * @property {string} [focus] - Instruction for a new page.
 * @property {string} [id] - Watch id.
 */

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.pageTitle]
 * @param {Element} [options.browser]
 * @param {string} [options.selectionText] - Highlighted text or a circled
 *   region. When present it is the only subject.
 * @param {Array<{title: string, url: string}>} [options.otherTabs]
 * @param {boolean} [options.useMemories]
 * @param {ToolbarWatchChoice[]} [options.watches] - Tasks this page can offer.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{actions: ToolbarSuggestedAction[], pending: boolean}>}
 *   pending is true when the document is still loading and has no text yet.
 */
export async function suggestToolbarActions({
  url,
  pageTitle,
  browser,
  selectionText,
  otherTabs = [],
  useMemories = false,
  watches = [],
  signal,
}) {
  signal?.throwIfAborted();
  const webPage = /^https?:/i.test(url ?? "");
  const selection = selectionText?.trim() ?? "";
  let text = "";
  let pending = false;
  if (webPage) {
    const read = await readSelectedPage(browser, url, signal);
    text = read.text;
    pending = read.pending;
  }
  if (pending && !selection) {
    return { actions: [], pending: true };
  }

  const conversation = await lazy.buildConversation(
    MODEL_FEATURES.AGENT_MONITOR
  );
  signal?.throwIfAborted();
  conversation.setSystemMessage(systemMessage(selection, watches, webPage));

  const selected = selection
    ? "The user selected this region. Every action must be about it:\n" +
      `${selection}\n\n`
    : "";
  const others = formatOtherTabs(otherTabs);
  const body = text ? `\n\nPage text, background only:\n${text}` : "";
  let message =
    `${selected}Title: ${pageTitle || "Untitled"}\nURL: ${url}` +
    `${others}${body}`;
  if (useMemories) {
    message = await withMemories(message, signal);
  }
  message += closingRule(selection, webPage);
  conversation.addUserMessage(message);

  const response = await conversation.run({
    token: await AuthProvider.getToken(),
    inferenceParams: {
      response_format: makeJSONSchemaBlob(
        "ToolbarActionSuggestions",
        ACTION_SCHEMA
      ),
    },
    tools: [],
  });
  signal?.throwIfAborted();
  return {
    actions: sanitizeActions(response?.finalOutput, watches, webPage),
    pending: false,
  };
}

/**
 * @param {string} selection
 * @param {ToolbarWatchChoice[]} watches
 * @param {boolean} webPage
 * @returns {string}
 */
function systemMessage(selection, watches, webPage) {
  const lead = selection ? SELECTION_LEAD : PAGE_LEAD;
  const limit = webPage
    ? ""
    : '\nThis is not a web page. Use only kind "chat".';
  const watch = watches.length
    ? `Watch ids you may use:\n${watches
        .map(item => `- ${item.id}: ${item.description}`)
        .join("\n")}`
    : 'Do not use kind "watch".';
  return `${lead}\n${SHARED_RULES}${limit}\n${watch}`;
}

/**
 * @param {string} selection
 * @param {boolean} webPage
 * @returns {string}
 */
function closingRule(selection, webPage) {
  const subject = selection
    ? "Every action is about the selected region above."
    : "Every action is about this page.";
  const search = webPage
    ? " Do not search for a price, spec, or fact the page already shows."
    : "";
  return (
    `\n\n${subject} At most 6, most useful first. Each chat is at most 6 words. ` +
    "A new version of this page is kind page only. " +
    "Do not also add a chat for that same change. " +
    `Chat is a question. Search is a live lookup the page does not answer.${search}`
  );
}

/**
 * @param {Array<{title: string, url: string}>} otherTabs
 * @returns {string}
 */
function formatOtherTabs(otherTabs) {
  const lines = [];
  for (const tab of otherTabs) {
    if (lines.length >= MAX_OTHER_TABS) {
      break;
    }
    const title = sanitizeUntrustedContent(tab?.title || tab?.url || "");
    if (title) {
      lines.push(`- ${title}`);
    }
  }
  if (!lines.length) {
    return "";
  }
  return `\n\nOther open tabs, background only:\n${lines.join("\n")}`;
}

/**
 * @param {string} message
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function withMemories(message, signal) {
  signal?.throwIfAborted();
  const { prompt } = await lazy.loadPrompt(
    MODEL_FEATURES.CONVERSATION_SUGGESTIONS_MEMORIES
  );
  signal?.throwIfAborted();
  return addMemoriesToPrompt(message, prompt);
}

/**
 * @param {string} [raw]
 * @param {ToolbarWatchChoice[]} watches
 * @param {boolean} webPage
 * @returns {ToolbarSuggestedAction[]}
 */
function sanitizeActions(raw, watches, webPage) {
  const parsed = parseJson(raw);
  const list = Array.isArray(parsed?.actions) ? parsed.actions : [];
  const allowedWatch = new Set(watches.map(item => item.id));
  const actions = [];
  const seen = new Set();
  for (const item of list) {
    if (actions.length >= MAX_ACTIONS) {
      break;
    }
    const kind = String(item?.kind ?? "")
      .trim()
      .toLowerCase();
    const built = buildAction(kind, item, allowedWatch, webPage);
    if (!built) {
      continue;
    }
    const key = `${built.kind}:${(built.id || built.label).toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    actions.push(built);
  }
  return actions;
}

/**
 * @param {string} kind
 * @param {object} item
 * @param {Set<string>} allowedWatch
 * @param {boolean} webPage
 * @returns {?ToolbarSuggestedAction}
 */
function buildAction(kind, item, allowedWatch, webPage) {
  if (!webPage && kind != "chat") {
    return null;
  }
  if (kind == "watch") {
    const id = clip(item?.label, MAX_LABEL);
    if (!allowedWatch.has(id)) {
      return null;
    }
    return { kind, id };
  }
  if (kind == "page") {
    const label = clip(item?.label, MAX_LABEL).replace(/[.!?]+$/, "");
    const focus = clip(item?.detail, MAX_FOCUS);
    if (!label || !focus) {
      return null;
    }
    return { kind, label, focus };
  }
  if (kind == "search") {
    const label = clip(item?.label, MAX_SEARCH).replace(/[.!?]+$/, "");
    if (!label) {
      return null;
    }
    return { kind, label };
  }
  if (kind == "chat") {
    const label = clipWords(item?.label, MAX_CHAT_WORDS, MAX_CHAT).replace(
      /[.!?]+$/,
      ""
    );
    if (!label) {
      return null;
    }
    return { kind, label };
  }
  return null;
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
 * @param {number} max
 * @returns {string}
 */
function clip(value, max) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * @param {string} value
 * @param {number} maxWords
 * @param {number} maxChars
 * @returns {string}
 */
function clipWords(value, maxWords, maxChars) {
  return clip(value, maxChars).split(" ").slice(0, maxWords).join(" ");
}
