/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Suggests generated pages for the tab the user is reading, and builds the
 * one they pick.
 *
 * The labels are specific to that page: a recipe might be "Vegan version" or
 * "Double for a party". Choosing one generates an AI Tab from the page and
 * opens it. It does not start a conversation. A follow-up panel for extra
 * input can come later; these suggestions already carry the focus they need.
 */

import {
  makeJSONSchemaBlob,
  MODEL_FEATURES,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";
import { AuthProvider } from "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AITab: "moz-src:///browser/components/aiwindow/models/aitab/AITab.sys.mjs",
  AITabStore:
    "moz-src:///browser/components/aiwindow/ui/modules/AITabStore.sys.mjs",
  ChatConversation:
    "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs",
  URILoadingHelper: "resource:///modules/URILoadingHelper.sys.mjs",
  buildConversation:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
});

const MAX_IDEAS = 2;
const MAX_LABEL = 48;
const MAX_FOCUS = 400;
const MAX_PAGE_CHARS = 6000;

const IDEA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          focus: { type: "string" },
        },
        required: ["label", "focus"],
      },
    },
  },
  required: ["pages"],
};

const SYSTEM_PROMPT = `You suggest up to 2 toolbar buttons for making a new page from the page the user is reading.
Each button is a specific version of that page. Use its names, amounts, and details.
A recipe might be "Vegan version" or "Double for a party". A product might be "Gift shortlist".
label is the button text: at most 4 words, no ending punctuation.
focus is the instruction for the page generator, one or two sentences, specific to this page.
The page text may be missing. When it is, use the title and URL.
Only suggest a new page. Do not suggest summarizing, chatting, or watching the page.
Return JSON {"pages": [{"label", "focus"}]} and nothing else.`;

const SELECTION_SYSTEM_PROMPT = `You suggest up to 2 toolbar buttons for making a new page about the part of the page the user selected.
The selection is highlighted text, or a description of a region they circled. It is the only subject.
Every label and every focus must be about the selection. Do not make a button about the rest of the page.
Use names, amounts, and details from the selection. Use the page only to interpret the selection.
label is the button text: at most 4 words, no ending punctuation.
focus is one or two sentences telling the page generator what to make from the selection.
Only suggest a new page. Do not suggest summarizing, chatting, or watching the page.
Return JSON {"pages": [{"label", "focus"}]} and nothing else.`;

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.pageTitle]
 * @param {Element} [options.browser] - Selected browser. Read in place so a
 *   Classic window is not limited to tabs open in a Smart Window.
 * @param {string} [options.selectionText] - Image description of a region the
 *   user selected. When present it is the primary subject.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{
 *   ideas: Array<{label: string, focus: string}>,
 *   pending: boolean,
 * }>} pending is true when the document is still loading and has no text yet.
 *   The caller should ask again and should not cache that result.
 */
export async function suggestPageActions({
  url,
  pageTitle,
  browser,
  selectionText,
  signal,
}) {
  signal?.throwIfAborted();
  if (!/^https?:/i.test(url ?? "")) {
    return { ideas: [], pending: false };
  }

  const selection = selectionText?.trim() ?? "";
  const { text, pending } = await readSelectedPage(browser, url, signal);
  if (pending && !selection) {
    return { ideas: [], pending: true };
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
    ? `The user selected this region. Every button must be about it:\n${selection}\n\n`
    : "";
  const again = selection
    ? "\n\nEvery button is a new page about the selected region above. Do not use the rest of the page as the subject."
    : "";
  conversation.addUserMessage(
    `${selected}Title: ${pageTitle || "Untitled"}\nURL: ${url}${body}${again}`
  );
  const response = await conversation.run({
    token: await AuthProvider.getToken(),
    inferenceParams: {
      response_format: makeJSONSchemaBlob("PageActionSuggestions", IDEA_SCHEMA),
    },
    tools: [],
  });
  signal?.throwIfAborted();
  const ideas = sanitizeIdeas(response?.finalOutput);
  if (!ideas.length) {
    console.error("Page suggestions were empty for", url);
  }
  return { ideas, pending: false };
}

/**
 * Reads the open tab. A missing actor or an empty body is not fatal: the
 * suggestion can still be made from the title and URL once loading finishes.
 *
 * @param {Element} [browser]
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<{text: string, pending: boolean}>}
 */
async function readSelectedPage(browser, url, signal) {
  signal?.throwIfAborted();
  let loading = false;
  try {
    loading = !!browser?.webProgress?.isLoadingDocument;
  } catch {
    loading = false;
  }

  let text = "";
  try {
    const windowContext = browser?.browsingContext?.currentWindowContext;
    if (windowContext) {
      const pageExtractor = await windowContext.getActor("PageExtractor");
      signal?.throwIfAborted();
      const extraction = await pageExtractor.getText({
        sufficientLength: MAX_PAGE_CHARS,
        cleanWhitespace: true,
        removeBoilerplate: true,
        sourceUrl: url,
      });
      signal?.throwIfAborted();
      text = extraction?.text?.trim() ?? "";
    }
  } catch (error) {
    if (error?.name == "AbortError" || signal?.aborted) {
      throw error?.name == "AbortError"
        ? error
        : new DOMException("Aborted", "AbortError");
    }
    console.error("Failed to read the page for suggestions:", error);
  }

  return {
    text: text.slice(0, MAX_PAGE_CHARS),
    pending: loading && !text,
  };
}

/**
 * Builds an AI Tab from the current page using the suggestion's focus, then
 * opens it. Nothing is shown in the chat sidebar.
 *
 * @param {ChromeWindow} win
 * @param {object} idea
 * @param {string} idea.focus
 * @param {string} idea.label
 * @returns {Promise<void>}
 */
export async function openSuggestedPage(win, { focus, label }) {
  const url = win.gBrowser?.selectedTab?.linkedBrowser?.currentURI?.spec ?? "";
  const instruction = clip(focus, MAX_FOCUS);
  if (!/^https?:/i.test(url) || !instruction) {
    return;
  }

  const conversation = new lazy.ChatConversation({});
  const result = await lazy.AITab.generateAITab(
    { urlList: [url], focus: instruction, howInitiated: "chat" },
    conversation
  );
  if (result.error || win.closed) {
    if (result.error) {
      console.error("Failed to generate a suggested page:", result.error);
    }
    return;
  }

  const { context, convId, toolConvId, ...pageMetadata } = result.metadata;
  const stored = await lazy.AITabStore.create({
    convId: convId ?? conversation.id,
    toolConvId,
    slug: result.metadata.id,
    title: result.metadata.title || label || instruction,
    context,
    components: { metadata: pageMetadata, surface: result.surface },
  });
  if (win.closed) {
    return;
  }
  lazy.URILoadingHelper.openTrustedLinkIn(
    win,
    lazy.AITab.buildViewerURL(stored.slug),
    "tab"
  );
}

/**
 * @param {string} [raw]
 * @returns {Array<{label: string, focus: string}>}
 */
function sanitizeIdeas(raw) {
  const parsed = parseJson(raw);
  const list = Array.isArray(parsed?.pages) ? parsed.pages : [];
  const ideas = [];
  const seen = new Set();
  for (const item of list) {
    if (ideas.length >= MAX_IDEAS) {
      break;
    }
    const label = clip(item?.label, MAX_LABEL).replace(/[.!?]+$/, "");
    const focus = clip(item?.focus, MAX_FOCUS);
    const key = label.toLowerCase();
    if (!label || !focus || seen.has(key)) {
      continue;
    }
    seen.add(key);
    ideas.push({ label, focus });
  }
  return ideas;
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
