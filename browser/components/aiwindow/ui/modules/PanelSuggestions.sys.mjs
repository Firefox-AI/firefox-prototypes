/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  makeJSONSchemaBlob,
  MODEL_FEATURES,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";
import { AuthProvider } from "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  buildConversation:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  GetPageContent: "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs",
});

const MAX_ACTIONS = 4;
const MAX_LABEL = 80;
const MAX_TEXT = 400;
const MAX_PAGE_CHARS = 8000;

/** @type {Map<string, object[]>} */
const suggestionCache = new Map();

/**
 * The menu entries last suggested for a page, if this session already asked.
 *
 * @param {string} url
 * @returns {?object[]}
 */
export function cachedPanelActions(url) {
  return suggestionCache.get(url) ?? null;
}

const HANDLERS = new Set([
  "zoom-in",
  "summarize-page",
  "reader-view",
  "find-in-page",
  "bookmark-page",
  "open-smart-page",
  "compare-pages",
  "create-smart-page",
  "create-monitor",
  "notify-at",
]);

const BLOCK_TYPES = new Set(["text", "longtext", "pages", "frequency", "time"]);

const SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["immediate", "form"] },
          handler: { type: "string" },
          menuLabel: { type: "string" },
          title: { type: "string" },
          submitLabel: { type: "string" },
          params: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
              highlight: { type: "boolean" },
              focus: { type: "string" },
              note: { type: "string" },
              prompt: { type: "string" },
              name: { type: "string" },
              time: { type: "string" },
              frequency: { type: "string" },
            },
          },
          blocks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: {
                  type: "string",
                  enum: ["text", "longtext", "pages", "frequency", "time"],
                },
                id: { type: "string" },
                label: { type: "string" },
                placeholder: { type: "string" },
                required: { type: "boolean" },
              },
              required: ["type", "id"],
            },
          },
        },
        required: ["kind", "menuLabel"],
      },
    },
  },
  required: ["actions"],
};

const SYSTEM_PROMPT = `You suggest up to 4 menu items for the browser page the user is reading.
Each item must be something that page specifically calls for. Use names, prices, dates, and phrases from the page.

An item is either "immediate" (one click) or "form" (a short follow-up panel).
handler must be one of: find-in-page, bookmark-page, summarize-page, open-smart-page, compare-pages, create-smart-page, create-monitor, notify-at, reader-view, zoom-in.
Omit handler for a form that only collects input and does not run yet.

params prefill the action:
- find-in-page: query is the exact word or phrase to find. highlight true means highlight every match.
- summarize-page and open-smart-page: focus is the instruction for the generated page.
- bookmark-page: name is the bookmark title.
- notify-at: time is HH:MM (24-hour). note is the reminder text.
- create-monitor and create-smart-page: prompt is what to watch for. name is the task title. frequency is daily or weekly. time is HH:MM.

blocks, in order, build a form. type is text, longtext, pages, frequency, or time.
id is query, focus, note, prompt, name, pages, frequency, or time.
label and placeholder are specific to this page.
For a form, submitLabel is the button text, specific to this page.

Prefer one immediate find-in-page that highlights a concrete phrase from the page.
Return JSON {"actions": [...]} and nothing else.`;

/**
 * Asks for a few menu entries that fit the page the user has open.
 * The page text comes from GetPageContent, the same read the tools use.
 * A failure returns no entries; the static menu stays.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.pageTitle]
 * @returns {Promise<object[]>}
 */
export async function suggestPanelActions({ url, pageTitle }) {
  const conversation = await lazy.buildConversation(
    MODEL_FEATURES.AGENT_MONITOR
  );
  const results = await lazy.GetPageContent.getPageContent(
    { url_list: [url] },
    conversation
  );
  const page = results.find(result => result.ok && result.content?.trim());
  if (!page) {
    return [];
  }
  const content = page.content.slice(0, MAX_PAGE_CHARS);
  conversation.setSystemMessage(SYSTEM_PROMPT);
  conversation.addUserMessage(
    `Title: ${pageTitle || "Untitled"}\nURL: ${url}\n\n${content}`
  );
  const response = await conversation.run({
    token: await AuthProvider.getToken(),
    inferenceParams: {
      response_format: makeJSONSchemaBlob(
        "PanelSuggestions",
        SUGGESTION_SCHEMA
      ),
    },
    tools: [],
  });
  const actions = sanitizeSuggestions(response?.finalOutput);
  if (actions.length) {
    suggestionCache.set(url, actions);
  }
  return actions;
}

/**
 * @param {string} [raw]
 * @returns {object[]}
 */
function sanitizeSuggestions(raw) {
  const parsed = parseJson(raw);
  let list = [];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (Array.isArray(parsed?.actions)) {
    list = parsed.actions;
  }
  const actions = [];
  for (const item of list) {
    if (actions.length >= MAX_ACTIONS) {
      break;
    }
    const action = sanitizeAction(item, actions.length);
    if (action) {
      actions.push(action);
    }
  }
  return actions;
}

/**
 * @param {object} item
 * @param {number} index
 * @returns {?object}
 */
function sanitizeAction(item, index) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const menuLabel = clip(item.menuLabel, MAX_LABEL);
  if (!menuLabel) {
    return null;
  }
  let kind = item.kind === "immediate" ? "immediate" : "form";
  let handler = HANDLERS.has(item.handler) ? item.handler : "";
  if (kind === "immediate" && !handler) {
    return null;
  }
  const params = sanitizeParams(item.params);
  let blocks = sanitizeBlocks(item.blocks);
  if (kind === "form" && !blocks.length) {
    blocks = defaultBlocks(handler);
  }
  if (kind === "form" && !blocks.length && !handler) {
    return null;
  }
  // One click needs the value it will use. Otherwise open the form.
  if (kind === "immediate" && !immediateReady(handler, params)) {
    kind = "form";
    if (!blocks.length) {
      blocks = defaultBlocks(handler);
    }
  }
  const action = {
    id: `suggested-${index}`,
    kind,
    suggested: true,
    menuLabel,
    params,
  };
  if (handler) {
    action.handler = handler;
  }
  const title = clip(item.title, MAX_LABEL);
  if (title) {
    action.title = title;
  }
  const submitLabel = clip(item.submitLabel, MAX_LABEL);
  if (submitLabel) {
    action.submitLabel = submitLabel;
  }
  if (kind === "form") {
    action.blocks = blocks;
  }
  if (handler === "create-monitor" || handler === "create-smart-page") {
    action.requiresMonitorSlot = true;
  }
  return action;
}

/**
 * @param {string} handler
 * @param {object} params
 * @returns {boolean}
 */
function immediateReady(handler, params) {
  switch (handler) {
    case "find-in-page":
      return Boolean(params.query);
    case "notify-at":
      return Boolean(params.time);
    case "bookmark-page":
    case "summarize-page":
    case "open-smart-page":
    case "reader-view":
    case "zoom-in":
    case "create-monitor":
      return handler !== "create-monitor" || Boolean(params.prompt);
    default:
      return false;
  }
}

/**
 * @param {string} handler
 * @returns {object[]}
 */
function defaultBlocks(handler) {
  switch (handler) {
    case "find-in-page":
      return [
        {
          type: "text",
          id: "query",
          l10nId: "smartwindow-monitor-panel-find-query",
          l10nAttrs: "label,placeholder",
          errorL10nId: "smartwindow-monitor-panel-find-error",
          required: true,
        },
      ];
    case "bookmark-page":
      return [
        {
          type: "text",
          id: "name",
          l10nId: "smartwindow-monitor-panel-bookmark-name",
          l10nAttrs: "label,placeholder",
        },
      ];
    case "summarize-page":
    case "open-smart-page":
      return [
        {
          type: "text",
          id: "focus",
          l10nId: "smartwindow-monitor-panel-custom-focus",
          l10nAttrs: "label,placeholder",
          errorL10nId: "smartwindow-monitor-panel-custom-focus-error",
          required: true,
        },
      ];
    case "notify-at":
      return [
        {
          type: "longtext",
          id: "note",
          l10nId: "smartwindow-monitor-panel-note-body",
          errorL10nId: "smartwindow-monitor-panel-note-error",
        },
        { type: "time", id: "time" },
      ];
    case "compare-pages":
      return [
        { type: "longtext", id: "focus" },
        { type: "pages", id: "pages", required: true },
      ];
    case "create-monitor":
      return [
        { type: "text", id: "name", l10nId: "ai-tasks-alert-name" },
        {
          type: "longtext",
          id: "prompt",
          l10nId: "smartwindow-monitor-panel-price-query",
          errorL10nId: "smartwindow-monitor-panel-price-error",
          required: true,
        },
        {
          type: "pages",
          id: "pages",
          l10nId: "ai-tasks-alert-pages",
          required: true,
        },
        { type: "frequency", id: "frequency" },
        { type: "time", id: "time" },
      ];
    case "create-smart-page":
      return [
        {
          type: "text",
          id: "name",
          l10nId: "ai-tasks-alert-name",
          required: true,
        },
        {
          type: "longtext",
          id: "focus",
          l10nId: "smartwindow-monitor-panel-news-focus",
          required: true,
        },
        {
          type: "pages",
          id: "pages",
          l10nId: "ai-tasks-alert-pages",
          required: true,
        },
        { type: "frequency", id: "frequency" },
        { type: "time", id: "time" },
      ];
    default:
      return [{ type: "longtext", id: "note", required: true }];
  }
}

/**
 * @param {object} [params]
 * @returns {object}
 */
function sanitizeParams(params) {
  if (!params || typeof params !== "object") {
    return {};
  }
  const clean = {};
  for (const key of ["query", "focus", "note", "prompt", "name"]) {
    const value = clip(params[key], MAX_TEXT);
    if (value) {
      clean[key] = value;
    }
  }
  if (params.highlight === true) {
    clean.highlight = true;
  }
  if (params.frequency === "weekly" || params.frequency === "daily") {
    clean.frequency = params.frequency;
  }
  if (/^\d{1,2}:\d{2}$/.test(params.time ?? "")) {
    clean.time = params.time;
  }
  return clean;
}

/**
 * @param {object[]} [blocks]
 * @returns {object[]}
 */
function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) {
    return [];
  }
  const clean = [];
  for (const block of blocks) {
    const idOk = /^[a-z0-9-]{1,32}$/.test(block?.id ?? "");
    if (!BLOCK_TYPES.has(block?.type) || !idOk) {
      continue;
    }
    const next = { type: block.type, id: block.id };
    const label = clip(block.label, MAX_LABEL);
    if (label) {
      next.label = label;
    }
    const placeholder = clip(block.placeholder, MAX_LABEL);
    if (placeholder) {
      next.placeholder = placeholder;
    }
    if (block.required === true) {
      next.required = true;
    }
    clean.push(next);
    if (clean.length >= 5) {
      break;
    }
  }
  return clean;
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
