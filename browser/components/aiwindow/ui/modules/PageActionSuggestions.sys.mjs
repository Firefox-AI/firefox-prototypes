/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Reads the selected page for toolbar suggestions, and builds the generated
 * page the user picks.
 *
 * Choosing one generates an AI Tab from the page and opens it. It does not
 * start a conversation.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AITab: "moz-src:///browser/components/aiwindow/models/aitab/AITab.sys.mjs",
  AITabStore:
    "moz-src:///browser/components/aiwindow/ui/modules/AITabStore.sys.mjs",
  ChatConversation:
    "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs",
  URILoadingHelper: "resource:///modules/URILoadingHelper.sys.mjs",
});

const MAX_FOCUS = 400;
const MAX_PAGE_CHARS = 6000;

/**
 * Reads the open tab. A missing actor or an empty body is not fatal: the
 * suggestion can still be made from the title and URL once loading finishes.
 *
 * @param {Element} [browser]
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<{text: string, pending: boolean}>}
 */
export async function readSelectedPage(browser, url, signal) {
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
