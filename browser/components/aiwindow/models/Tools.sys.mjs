/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * This file contains LLM tool abstractions and tool definitions.
 */

/**
 * @import { ChatConversation } from "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
 */

import { searchBrowsingHistory as implSearchBrowsingHistory } from "moz-src:///browser/components/aiwindow/models/SearchBrowsingHistory.sys.mjs";
import { PageExtractorParent } from "resource://gre/actors/PageExtractorParent.sys.mjs";
import {
  ChatStore,
  MESSAGE_ROLE,
} from "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs";
import {
  sanitizeUntrustedContent,
  isNewPageUrl,
} from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  MemoriesManager:
    "moz-src:///browser/components/aiwindow/models/memories/MemoriesManager.sys.mjs",
  SmartWindowNavigationInfo:
    "moz-src:///browser/components/aiwindow/models/SmartWindowNavigationInfo.sys.mjs",
  // @todo Bug 2009194
  // PageDataService:
  //   "moz-src:///browser/components/pagedata/PageDataService.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "Conversation",
    maxLogLevelPref: "browser.smartwindow.conversation.logLevel",
  })
);

// Important! Changing or removing this value requires a security review.
//
// Hard code a reasonable working limit for how many tabs that a language model can retrieve.
// The metadata from each tab contains untrusted text content that we limit (for instance
// with truncation) in order to treat this information as trusted.
//
// We also make this limited in a non-configurable way so that it reduces the risk
// of exfiltration for private data. While most users only have a few tabs open at a time,
// some users can have thousands of tabs open at once.
const MAX_TABS = 15;

// Allow list of URL protocols for tabs and pages exposed to the LLM. Only http/https are
// permitted; internal (about:, chrome:, moz-extension:, file:, data:, etc.)
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedURL(url) {
  try {
    return ALLOWED_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// Important! Changing or removing this value requires a security review.
//
// Hard code a reasonable working limit for how many history results that a language model
// can retrieve. The metadata from each of these history items contains untrusted text
// content that we limit (for instance with truncation) in order to treat this information
// as trusted.
//
// We also make this limited in a non-configurable way so that it reduces the risk
// of exfiltration for private data. A language model that can make arbitrary requests
// through prompt injection could leak the contents of a user's entire history.
const MAX_HISTORY_RESULTS = 15;

export const GET_OPEN_TABS = "get_open_tabs";
export const SEARCH_BROWSING_HISTORY = "search_browsing_history";
export const GET_PAGE_CONTENT = "get_page_content";
export const RUN_SEARCH = "run_search";
export const GET_USER_MEMORIES = "get_user_memories";
export const GET_NAVIGATION_INFO = "get_navigation_info";
export const COMPARE_PRODUCTS = "compare_products";
export const REFINE_COMPARISON = "refine_comparison";
export const ADD_PRODUCT_FROM_TAB = "add_product_from_tab";

export const TOOLS = [
  GET_OPEN_TABS,
  SEARCH_BROWSING_HISTORY,
  GET_PAGE_CONTENT,
  RUN_SEARCH,
  GET_USER_MEMORIES,
  GET_NAVIGATION_INFO,
  COMPARE_PRODUCTS,
  REFINE_COMPARISON,
  ADD_PRODUCT_FROM_TAB,
];

export const RUN_SEARCH_VERBATIM_QUERY_DESCRIPTION =
  "Perform a web search using the browser's default search engine and return " +
  "the search results page content. Use this when the user needs current web " +
  "information that would benefit from a live search. This tool uses the current user message as the query.";

export const RUN_SEARCH_GENERATED_QUERY_DESCRIPION =
  "Perform a web search using the browser's default search engine and return " +
  "the search results page content. Use this when the user needs current web " +
  "information that would benefit from a live search.";

const RUN_SEARCH_TOOL_CONFIG_VERBATIM_QUERY = {
  type: "function",
  function: {
    name: RUN_SEARCH,
    description: RUN_SEARCH_VERBATIM_QUERY_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

const RUN_SEARCH_TOOL_CONFIG_GENERATED_QUERY = {
  type: "function",
  function: {
    name: RUN_SEARCH,
    description: RUN_SEARCH_GENERATED_QUERY_DESCRIPION,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search query to execute. Should be specific and search-engine optimized.",
        },
      },
      required: ["query"],
    },
  },
};

export const toolsConfig = [
  {
    type: "function",
    function: {
      name: GET_OPEN_TABS,
      description:
        `Access the user's browser and return up to ${MAX_TABS} currently open tabs, ` +
        "ordered by most recently viewed.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: SEARCH_BROWSING_HISTORY,
      description:
        "Retrieve pages from the user's past browsing history, optionally filtered by " +
        "topic and/or time range.",
      parameters: {
        type: "object",
        properties: {
          searchTerm: {
            type: "string",
            description:
              "A concise phrase describing what the user is trying to find in their " +
              "browsing history (topic, site, or purpose).",
          },
          startTs: {
            type: "string",
            description:
              "Inclusive start of the time range as a local ISO 8601 datetime " +
              "('YYYY-MM-DDTHH:mm:ss', no timezone).",
          },
          endTs: {
            type: "string",
            description:
              "Inclusive end of the time range as a local ISO 8601 datetime " +
              "('YYYY-MM-DDTHH:mm:ss', no timezone).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: GET_PAGE_CONTENT,
      description:
        "Retrieve cleaned text content of all the provided browser page URL Tokens in the list.",
      parameters: {
        type: "object",
        properties: {
          url_list: {
            type: "array",
            items: {
              type: "string",
              description:
                "A URL token that appeared in the conversation, formatted as §url_token: DOMAIN_TLD_PATH_n§. " +
                "Do NOT fabricate tokens. Only use tokens from user messages and tool results.",
            },
            minItems: 1,
            description: "List of URL tokens to fetch content from.",
          },
        },
        required: ["url_list"],
      },
    },
  },
  RUN_SEARCH_TOOL_CONFIG_VERBATIM_QUERY,
  {
    type: "function",
    function: {
      name: GET_NAVIGATION_INFO,
      description:
        "Find relevant Firefox preferences pages based on a user query. " +
        "Use this when the user asks where to find a setting, how to configure something in " +
        "Firefox, or where to manage Smart Window features like memories.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A natural-language description of what the user is looking for, " +
              "e.g. 'where to manage memories' or 'privacy settings'.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: GET_USER_MEMORIES,
      description:
        'Retrieves all memories saved about the user to answer questions like "What do you know about me?", "What memories have you saved?", "What do you remember about me?", etc. Respond to the user that these are memories.',
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: COMPARE_PRODUCTS,
      description:
        "Render an interactive comparison artifact of 3-5 products with images, " +
        "prices, ratings, specs, pros/cons, and an AI-picked recommendation. " +
        "MUST be called as the SECOND tool in shopping/comparison queries — after " +
        "run_search has returned live SERP context. Trigger words for the chained " +
        "flow: 'compare', 'vs', 'versus', 'find me the best', 'find the best', " +
        "'find best', 'what's the best', 'top [N] [products]', 'recommend', " +
        "'which [product] should I buy', 'best X under $Y'. Examples that follow " +
        "run_search → compare_products: 'find the best noise canceling headphones " +
        "under $400', 'compare top noise-cancelling earbuds under $300', " +
        "'top 4 espresso machines', 'best running shoes for marathons'. " +
        "Pass the user's full query and any extracted constraints (priceMax, " +
        "brands, mustHave). The artifact renders inline in the sidebar.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The shopper's natural-language query, e.g. 'best rear child bike seat for ebike'.",
          },
          constraints: {
            type: "object",
            description:
              "Structured filters extracted from the query.",
            properties: {
              priceMax: { type: "number" },
              priceMin: { type: "number" },
              brands: { type: "array", items: { type: "string" } },
              mustHave: { type: "array", items: { type: "string" } },
            },
          },
          count: {
            type: "integer",
            minimum: 3,
            maximum: 5,
            description: "How many products to surface (default 4).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: REFINE_COMPARISON,
      description:
        "Mutate an existing comparison set in place. Triggered by follow-ups like " +
        "'only show under $200', 'remove the Hamax', 'swap one out for a Thule'. " +
        "MUST be called with the existing convId — do NOT call compare_products again. " +
        "The artifact updates in place.",
      parameters: {
        type: "object",
        properties: {
          convId: {
            type: "string",
            description: "The conversation/artifact id to refine.",
          },
          action: {
            type: "string",
            enum: [
              "filter",
              "add_product",
              "remove_product",
              "replace_set",
              "re_recommend",
            ],
            description: "Which mutation to apply.",
          },
          filter: {
            type: "object",
            description: "Filter constraints; required when action='filter'.",
            properties: {
              priceMax: { type: "number" },
              priceMin: { type: "number" },
              brands: { type: "array", items: { type: "string" } },
              mustHave: { type: "array", items: { type: "string" } },
            },
          },
          productId: {
            type: "string",
            description: "Required when action='remove_product'.",
          },
          productQuery: {
            type: "string",
            description:
              "Free-text product to add; required when action='add_product' and no URL is supplied.",
          },
          productUrl: {
            type: "string",
            description:
              "Direct URL to add; alternative to productQuery for add_product.",
          },
        },
        required: ["convId", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: ADD_PRODUCT_FROM_TAB,
      description:
        "Add a product from a URL the user is currently viewing in another browser " +
        "tab. Wraps refine_comparison with action='add_product' after resolving the " +
        "active tab URL. Use when the user says 'add this one' or 'add the page I'm on'.",
      parameters: {
        type: "object",
        properties: {
          convId: {
            type: "string",
            description: "The comparison id to update.",
          },
          tabUrl: {
            type: "string",
            description:
              "Explicit URL; if omitted, the tool resolves the most recently accessed open tab.",
          },
        },
        required: ["convId"],
      },
    },
  },
];

/**
 * Metadata about a Tab used in chat conversations.
 *
 * @typedef {object} TabInfo
 * @property {string} url - The url of the tab.
 * @property {string} title - Title of the tab.
 * @property {number} lastAccessed - When the tab was last accessed in milliseconds.
 */

/**
 * Retrieves a list of the latest open tabs from the current active browser window.
 * Tabs are sorted by most recently accessed and limited to MAX_TABS results.
 * Only includes tabs with http/https URLs.
 *
 * @param {ChatConversation} conversation
 * @returns {Promise<Array<TabInfo>>}
 */
export async function getOpenTabs(conversation) {
  // No security check needed. The security checks prevent data exfiltration,
  // which requires external communication. This tool makes no external requests.

  /** @type {Array<TabInfo>} */
  const tabs = [];

  for (const win of lazy.BrowserWindowTracker.orderedWindows) {
    if (!lazy.AIWindow.isAIWindowActive(win)) {
      continue;
    }

    if (!win.closed && win.gBrowser) {
      for (const tab of win.gBrowser.tabs) {
        const browser = tab.linkedBrowser;
        const url = browser?.currentURI?.spec;
        const title = tab.label;

        if (isAllowedURL(url) && !isNewPageUrl(url)) {
          tabs.push({
            url,
            title: sanitizeUntrustedContent(title),
            lastAccessed: tab.lastAccessed,
          });
        }
      }
    }
  }

  tabs.sort((a, b) => b.lastAccessed - a.lastAccessed);

  const recentTabs = tabs.slice(0, MAX_TABS);

  // Tab titles are truncated to 100 characters and therefore not expected to
  // contain enough untrusted data for a prompt injection attack.
  conversation.securityProperties.setPrivateData();
  lazy.console.log("[Tool] getOpenTabs", recentTabs);

  conversation.addSeenUrls(recentTabs.map(({ url }) => url));

  return recentTabs;
}

/**
 * Tool entrypoint for search_browsing_history.
 *
 * Parameters (defaults shown):
 * - searchTerm: ""        - string used for search
 * - startTs: null         - local ISO timestamp lower bound, or null
 * - endTs: null           - local ISO timestamp upper bound, or null
 * Detailed behavior and implementation are in SearchBrowsingHistory.sys.mjs.
 *
 * @param {object} toolParams
 *  The search parameters.
 * @param {string} toolParams.searchTerm
 *  The search string. If null or empty, semantic search is skipped and
 *  results are filtered by time range and sorted by last_visit_date and frecency.
 * @param {string|null} toolParams.startTs
 *  Optional local ISO-8601 start timestamp (e.g. "2025-11-07T09:00:00").
 * @param {string|null} toolParams.endTs
 *  Optional local ISO-8601 end timestamp (e.g. "2025-11-07T09:00:00").
 * @param {number} toolParams.historyLimit
 *  Maximum number of history results to return.
 * @param {ChatConversation} conversation
 * @returns {Promise<object>}
 *  A promise resolving to an object with the search term and history results.
 *  Includes `count` when matches exist, a `message` when none are found, or an
 *  `error` string on failure.
 */
export async function searchBrowsingHistory(toolParams, conversation) {
  // No security check, always allowed because it makes no external requests.
  const params = toolParams && typeof toolParams === "object" ? toolParams : {};

  const { searchTerm = "", startTs = null, endTs = null } = params;

  const result = await implSearchBrowsingHistory({
    searchTerm,
    startTs,
    endTs,
    historyLimit: MAX_HISTORY_RESULTS,
  });

  conversation.addSeenUrls(result.results.map(({ url }) => url));
  conversation.securityProperties.setPrivateData();
  lazy.console.log("[Tool] searchBrowsingHistory", result);
  return result;
}

/**
 * Strips heavy or unnecessary fields from a browser history search result.
 *
 * @param {string} result
 *  A JSON string representing the history search response.
 * @returns {string}
 *  The sanitized JSON string with large fields (e.g., favicon, thumbnail)
 *  removed, or the original string if parsing fails.
 */
export function stripSearchBrowsingHistoryFields(result) {
  try {
    const data = JSON.parse(result);
    if (
      data.error ||
      !Array.isArray(data.results) ||
      data.results.length === 0
    ) {
      return result;
    }

    // Remove large or unnecessary fields to save tokens
    const OMIT_KEYS = ["favicon", "thumbnail"];
    for (const item of data.results) {
      if (item && typeof item === "object") {
        for (const k of OMIT_KEYS) {
          delete item[k];
        }
      }
    }
    return JSON.stringify(data);
  } catch {
    return result;
  }
}

/**
 * Performs a web search using the browser's default search engine,
 * waits for the results page to load, and extracts its content.
 */
export class RunSearch {
  static NAVIGATION_TIMEOUT_MS = 15000;
  static CONTENT_SETTLE_MS = 2000;
  static MAX_CHARACTERS = 15000;

  static #ensureTabSelected(tab) {
    if (!tab.selected) {
      tab.ownerGlobal.gBrowser.selectedTab = tab;
    }
  }

  /**
   * Switches the run_search tool description to the one for verbatim queries
   *
   * @param {object} chatToolsConfig
   * @returns {object}
   */
  static setVerbatimSearchQueryDescription(chatToolsConfig) {
    const indexOfRunSearchConfig = chatToolsConfig.findIndex(
      item => item.function.name === RUN_SEARCH
    );
    if (
      chatToolsConfig[indexOfRunSearchConfig].function.description !=
      RUN_SEARCH_VERBATIM_QUERY_DESCRIPTION
    ) {
      chatToolsConfig[indexOfRunSearchConfig] =
        RUN_SEARCH_TOOL_CONFIG_VERBATIM_QUERY;
    }
    return chatToolsConfig;
  }

  /**
   * Switches the run_search tool description to the one for generated queries
   *
   * @param {object} chatToolsConfig
   * @returns {object}
   */
  static setGeneratedSearchQueryDescription(chatToolsConfig) {
    const indexOfRunSearchConfig = chatToolsConfig.findIndex(
      item => item.function.name === RUN_SEARCH
    );
    if (
      chatToolsConfig[indexOfRunSearchConfig].function.description !=
      RUN_SEARCH_GENERATED_QUERY_DESCRIPION
    ) {
      chatToolsConfig[indexOfRunSearchConfig] =
        RUN_SEARCH_TOOL_CONFIG_GENERATED_QUERY;
    }
    return chatToolsConfig;
  }

  /**
   * @param {object} [toolParams]
   * @param {BrowsingContext} browsingContext
   * @param {ChatConversation} conversation
   * @returns {Promise<string>}
   */
  static async runSearch(toolParams, browsingContext, conversation) {
    // No security check, always allowed because we assume that the search
    // provider is trusted.

    // Decide if we'll use the user message verbatim as the search query or generate one
    let query;
    if (toolParams.query) {
      query = toolParams.query;
    } else {
      const recentUserMessages = await ChatStore.getMostRecentMessages(
        MESSAGE_ROLE.USER,
        1
      );
      if (!recentUserMessages.length) {
        return "Error: no user messages stored to user as the search query.";
      }
      query = recentUserMessages[0].content.body;
    }

    if (!query || typeof query !== "string" || !query.trim()) {
      return "Error: a non-empty search query is required.";
    }

    if (!browsingContext) {
      return "Error: no browsingContext provided to perform search.";
    }

    const win = browsingContext.topChromeWindow;
    if (!win || win.closed) {
      return "Error: associated browser window not available or closed.";
    }

    // Get the original tab from the browsing context, not the currently selected tab
    const originalBrowser = browsingContext.embedderElement;
    let targetTab =
      originalBrowser && win.gBrowser?.getTabForBrowser(originalBrowser);

    if (targetTab) {
      // Switch to the original tab if it's different from currently selected
      RunSearch.#ensureTabSelected(targetTab);
    } else {
      return "Error: Original tab no longer exists, aborting search to avoid interfering with existing conversation.";
    }

    // If the original tab is the AI Window page, move to sidebar first
    if (lazy.AIWindow.isAIWindowContentPage(originalBrowser.currentURI)) {
      await RunSearch.#moveToSidebarIfNeeded(win, targetTab);

      // Ensure we're still on the correct tab after the await
      RunSearch.#ensureTabSelected(targetTab);
    }

    RunSearch.#showSearchingIndicator(win, true, query.trim());

    let result;
    try {
      await RunSearch.#performSearchAndWait(win, originalBrowser, query.trim());
      result = RunSearch.#extractSerpContent(originalBrowser, conversation);
    } catch (e) {
      console.error("[RunSearch] search failed:", e);
      result = `Error performing search for "${query}": ${e.message}`;
    } finally {
      RunSearch.#showSearchingIndicator(win, false, null);
    }

    conversation.securityProperties.setPrivateData();
    conversation.securityProperties.setUntrustedInput();

    lazy.console.log("[Tool] runSearch", result);
    return result;
  }

  // TODO - this may be dead code. The fetch with history already yields a
  // searching state, and the sidebar implementation may not need this at all.
  // Revisit this in the future:
  // https://bugzilla.mozilla.org/show_bug.cgi?id=2016252 to find a more
  // concrete way to target what side bar needs to show the indicator, if any
  // at all. My guess is that this might be here because of the move to sidebar
  // implementation, and the indicator state does not "transfer over". Possibly
  // look into tapping into something more concrete like the conversation state
  // in the AIWindow store to trigger this kind of UI state instead of trying
  // to directly manipulate the sidebar UI from here.
  static #showSearchingIndicator(win, isSearching, searchQuery) {
    try {
      const sidebar = win.document.getElementById("ai-window-box");
      if (!sidebar) {
        return;
      }
      const aiBrowser = sidebar.querySelector("#ai-window-browser");
      if (!aiBrowser?.contentDocument) {
        return;
      }
      const aiWindow = aiBrowser.contentDocument.querySelector("ai-window");
      if (aiWindow?.showSearchingIndicator) {
        aiWindow.showSearchingIndicator(isSearching, searchQuery);
      }
    } catch {
      // Sidebar may not be available
    }
  }

  static async #moveToSidebarIfNeeded(win, tab) {
    await lazy.AIWindow.moveConversationToSidebar(win, tab);
  }

  /**
   * Navigates to the search results and waits for the page to finish loading.
   *
   * @param {Window} win
   * @param {XULElement} browser
   * @param {string} query
   */
  static async #performSearchAndWait(win, browser, query) {
    const navigationPromise = new Promise((resolve, reject) => {
      const timeout = lazy.setTimeout(() => {
        win.gBrowser.removeProgressListener(listener);
        reject(new Error("Navigation timed out"));
      }, RunSearch.NAVIGATION_TIMEOUT_MS);

      const listener = {
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
        onStateChange(_webProgress, _request, stateFlags) {
          const complete =
            Ci.nsIWebProgressListener.STATE_STOP |
            Ci.nsIWebProgressListener.STATE_IS_NETWORK;
          if ((stateFlags & complete) === complete) {
            lazy.clearTimeout(timeout);
            win.gBrowser.removeProgressListener(listener);
            resolve();
          }
        },
        onLocationChange() {},
        onProgressChange() {},
        onStatusChange() {},
        onSecurityChange() {},
        onContentBlockingEvent() {},
      };

      win.gBrowser.addProgressListener(listener);
    });

    await lazy.AIWindow.performSearch(query, win);
    await navigationPromise;

    // Allow JS rendering to settle
    await new Promise(r => lazy.setTimeout(r, RunSearch.CONTENT_SETTLE_MS));
  }

  /**
   * Run PageExtractor on the search engine page.
   *
   * @param {MozBrowser} browser
   * @param {ChatConversation} conversation
   * @returns {string}
   */
  static async #extractSerpContent(browser, conversation) {
    const windowContext = browser.browsingContext?.currentWindowContext;
    if (!windowContext) {
      return "Error: could not access search results page content.";
    }

    /** @type {string} */
    let text;
    /** @type {PageExtractorParent} */
    const pageExtractor = await windowContext.getActor("PageExtractor");
    try {
      const result = await pageExtractor.getText({
        sufficientLength: RunSearch.MAX_CHARACTERS,
        cleanWhitespace: true,
        removeBoilerplate: true,
      });
      if (!result) {
        return "No content could be extracted from the search results page.";
      }
      text = result.text;
      conversation.addSeenUrls(result.links);
    } catch {
      return "Error: failed to extract search results content.";
    }

    const url = browser.currentURI?.spec || "unknown";

    return `Search results from ${url}:\n\n${text}`;
  }
}

/**
 * Class for handling page content extraction with configurable modes and limits.
 */
export class GetPageContent {
  static MAX_CHARACTERS = 10000;

  /**
   * Tool entrypoint for get_page_content.
   *
   * @param {object} toolParams
   * @param {string[]} toolParams.url_list
   * @param {ChatConversation} conversation
   * @returns {Promise<Array<string>>}
   *  A promise resolving to a string containing the extracted page content
   *  with a descriptive header, or an error message if extraction fails.
   */
  static async getPageContent({ url_list }, conversation) {
    // This is a decision table for allowing and blocking fetches on the configuration of the
    // SecurityProperties and the URLs. Tab URLs don't do any new page loads. Mention urls
    // have been added by the user so they should be allowed. And all other URLs are
    // restricted when both private and untrusted data has been seen.
    //
    // │ Flags               │ tab urls │ mention urls │ any urls │
    // ├─────────────────────┼──────────┼──────────────┼──────────┤
    // │ Private only        │ ALLOW    │ ALLOW        │ ALLOW    │
    // │ Untrusted only      │ ALLOW    │ ALLOW        │ ALLOW    │
    // │ Private + Untrusted │ ALLOW    │ ALLOW        │ BLOCK    │

    // Sanitize the inputs from the language model:
    if (!Array.isArray(url_list)) {
      throw new Error("The url list must be an array of stirngs");
    }

    // Collect these one time before the loop below since it must iterate through
    // all of the conversations and collect a new Set of mentions.
    const mentionedUrls = conversation.getAllMentionURLs();

    const results = await Promise.all(
      url_list.map(async (url, index) => {
        if (!isAllowedURL(url)) {
          return "This URL is not allowed: " + url;
        }
        try {
          const text = await GetPageContent.#getPageContentsForSingleURL(
            url,
            mentionedUrls,
            conversation
          );
          return text;
        } catch (error) {
          console.error(error);
          return `Could not retrieve the content for the page: ${url_list[index]}`;
        }
      })
    );
    lazy.console.log("[Tool] getPageContent", results);
    return results;
  }

  /**
   * Search through all AI Windows to find the tab with the matching URL.
   *
   * @param {string} url
   * @returns {Tab | null}
   */
  static getTabWithURL(url) {
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      if (!lazy.AIWindow.isAIWindowActive(win) || win.closed || !win.gBrowser) {
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
   * @param {string} url
   * @param {Set<string>} mentionedUrls
   * @param {ChatConversation} conversation
   *
   * @returns {Promise<string>}
   */
  static async #getPageContentsForSingleURL(url, mentionedUrls, conversation) {
    // First try to get the contents from an existing tab. This is always allowed from
    // a security perspective as it doesn't involve a network request, so there is
    // no risk for data exfiltration.
    const tab = GetPageContent.getTabWithURL(url);
    if (tab) {
      // Extract the tab contents.
      const currentWindowContext =
        tab.linkedBrowser.browsingContext?.currentWindowContext;

      if (!currentWindowContext) {
        return `Cannot access content from the following webpage:\n - Title: ${sanitizeUntrustedContent(tab.label)}\n - URL: ${url}.`;
      }

      // Extract page content using PageExtractor
      const pageExtractor =
        await currentWindowContext.getActor("PageExtractor");

      return GetPageContent.#runExtraction(
        pageExtractor,
        conversation,
        `${sanitizeUntrustedContent(tab.label)} (${url})`
      );
    }

    // Fetch the page headlessly since it's not loaded as a tab. This requires elevated
    // security permissions since an external network request is required, and is a
    // risk for the exfiltration of private data. If the URL is mentioned by the user
    // then the security properties check is bypassed here.
    if (
      !mentionedUrls.has(url) &&
      conversation.securityProperties.untrustedInput &&
      conversation.securityProperties.privateData
    ) {
      return (
        `Access is not allowed for ${url} because of untrusted and private content ` +
        "in the conversation."
      );
    }

    return PageExtractorParent.getHeadlessExtractor(url, pageExtractor =>
      GetPageContent.#runExtraction(pageExtractor, conversation, url)
    );
  }

  /**
   * Main extraction function.
   * label is of form `{tab.title} ({tab.url})`.
   *
   * @param {PageExtractorParent} pageExtractor
   * @param {ChatConversation} conversation
   * @param {string} label
   * @returns {Promise<string>}
   *  A promise resolving to a formatted string containing the page content
   *  with mode and label information, or an error message if no content is available.
   */
  static async #runExtraction(pageExtractor, conversation, label) {
    const extraction = await pageExtractor.getText({
      sufficientLength: GetPageContent.MAX_CHARACTERS,
      cleanWhitespace: true,
      removeBoilerplate: true,
    });

    if (!extraction) {
      return `get_page_content returned no content for ${label}.`;
    }

    const { text, links } = extraction;
    conversation.addSeenUrls(links);

    // If an extraction succeeds set the security properties.
    // The page content is private since it uses a web page load that has credentials.
    // The information is untrusted since it's arbitrary web content.
    conversation.securityProperties.setPrivateData();
    conversation.securityProperties.setUntrustedInput();

    return `Content from ${label}:\n\n${text}`;
  }
}

/**
 * Returns Firefox settings navigation entries semantically relevant to the query.
 * No conversation parameter is needed.
 *
 * @param {object} toolParams
 * @param {string} toolParams.query
 * @returns {Promise<Array<{url, label, breadcrumb, description, similarity}>>}
 */
export async function getNavigationInfo(toolParams) {
  const params = toolParams && typeof toolParams === "object" ? toolParams : {};
  const { query = "" } = params;

  if (!query.trim()) {
    return [];
  }

  // No flags set: results are static browser UI metadata bundled with Firefox.
  // No network requests are made and no user data is read, so there is no
  // privacy risk and no untrusted content that could carry a prompt injection.
  return lazy.SmartWindowNavigationInfo.getRelevantNavigation(query);
}

/**
 * Retrieves the summaries of all saved memories
 *
 * @param {ChatConversation} conversation
 * @returns {Promise<Array<string>>}
 */
export async function getUserMemories(conversation) {
  // No security check, always allowed because it makes no external requests.
  const memories = await lazy.MemoriesManager.getAllMemories();

  const result = memories.map(memory => memory.memory_summary);
  // Memory summaries are private user data. They are truncated to 100
  // characters, so they are not considered untrusted input.
  conversation.securityProperties.setPrivateData();
  lazy.console.log("[Tool] getUserMemories", result);
  return result;
}

// ---------- Product comparison: web search, page extraction, helpers ----------

const PCV1_SEARCH_TIMEOUT_MS = 6000;
const PCV1_FETCH_TIMEOUT_MS = 5000;
const PCV1_MAX_RESULTS = 5;
const PCV1_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0";

function pcv1AbortSignal(timeoutMs) {
  // Use AbortController + setTimeout — AbortSignal.timeout in some sys.mjs
  // contexts returns a signal that aborts immediately when fed into fetch().
  const ctrl = new AbortController();
  lazy.setTimeout(() => {
    try {
      ctrl.abort();
    } catch {}
  }, timeoutMs);
  return ctrl.signal;
}

async function pcv1FetchText(url, timeoutMs) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": PCV1_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: pcv1AbortSignal(timeoutMs),
    redirect: "follow",
    credentials: "omit",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}

const PCV1_BLOCKED_HOSTS = [
  "duckduckgo.com",
  "bing.com",
  "google.com",
  "yahoo.com",
  "youtube.com",
  "facebook.com",
  "wikipedia.org",
  "pinterest.com",
  "reddit.com",
];

function pcv1IsLikelyShoppingUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return false;
    }
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (PCV1_BLOCKED_HOSTS.some(h => host === h || host.endsWith("." + h))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function pcv1IsHubUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (path === "/" || path === "") {
      return true;
    }
    if (
      /\/(coverage|category|categories|topic|topics|tag|tags|hub|news|section|sections|deals)(\/|$)/.test(path)
    ) {
      return true;
    }
    if (path.split("/").filter(Boolean).length <= 1 && path.length < 25) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function pcv1DecodeDDGRedirect(href) {
  try {
    if (href.startsWith("//duckduckgo.com/l/?")) {
      href = "https:" + href;
    }
    const url = new URL(href);
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/") {
      const inner = url.searchParams.get("uddg");
      if (inner) {
        return decodeURIComponent(inner);
      }
    }
    return href;
  } catch {
    return href;
  }
}

function pcv1ParseDDGResults(html) {
  const results = [];
  const seen = new Set();
  const re =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const rawHref = m[1].replace(/&amp;/g, "&");
    const url = pcv1DecodeDDGRedirect(rawHref);
    if (!pcv1IsLikelyShoppingUrl(url)) {
      continue;
    }
    if (pcv1IsHubUrl(url)) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    const title = m[2]
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    results.push({ url, title });
    if (results.length >= PCV1_MAX_RESULTS * 3) {
      break;
    }
  }
  return results;
}

async function pcv1WebSearch(query) {
  const url =
    "https://duckduckgo.com/html/?q=" +
    encodeURIComponent(query + " buy review");
  try {
    const html = await pcv1FetchText(url, PCV1_SEARCH_TIMEOUT_MS);
    return pcv1ParseDDGResults(html);
  } catch (e) {
    lazy.console.warn("[pcv1] web search failed", e?.message || e);
    return [];
  }
}

function pcv1DecodeEntities(s) {
  if (typeof s !== "string") {
    return s;
  }
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function pcv1MetaTag(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]*property=["']${escaped}["'][^>]*content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${escaped}["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]*name=["']${escaped}["'][^>]*content=["']([^"']+)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${escaped}["']`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      return pcv1DecodeEntities(m[1]);
    }
  }
  return null;
}

function pcv1StripTags(htmlFragment) {
  return pcv1DecodeEntities(
    String(htmlFragment)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function pcv1ExtractListItems(htmlChunk) {
  const listMatch = htmlChunk.match(
    /<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/i
  );
  if (listMatch) {
    const items = [];
    const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRe.exec(listMatch[2])) && items.length < 5) {
      const text = pcv1StripTags(li[1]);
      if (text && text.length >= 3 && text.length <= 200) {
        items.push(text);
      }
    }
    if (items.length) {
      return items;
    }
  }
  const items = [];
  const lineRe = /<(p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let line;
  let scanned = 0;
  while ((line = lineRe.exec(htmlChunk)) && items.length < 5 && scanned < 20) {
    scanned++;
    const text = pcv1StripTags(line[2]);
    if (!text || text.length < 3 || text.length > 200) {
      continue;
    }
    if (/^(pros|cons|likes|dislikes|the good|the bad|drawbacks|highlights|strengths|weaknesses)\b/i.test(text)) {
      continue;
    }
    items.push(text);
  }
  return items;
}

function pcv1ExtractProsCons(html) {
  const headingRe =
    /<(h[1-6]|strong|b|p|div|span)\b[^>]*>([\s\S]{0,500}?)<\/\1>/gi;
  const PROS_RE = /\b(pros|likes|strengths|highlights|the good|we love|reasons to buy)\b/i;
  const CONS_RE = /\b(cons|dislikes|weaknesses|drawbacks|the bad|watch outs|reasons to avoid|downsides)\b/i;
  let pros = [];
  let cons = [];
  let m;
  while ((m = headingRe.exec(html))) {
    if (pros.length && cons.length) {
      break;
    }
    const text = pcv1StripTags(m[2]);
    if (!text || text.length > 80) {
      continue;
    }
    const isPros = PROS_RE.test(text);
    const isCons = CONS_RE.test(text);
    if (!isPros && !isCons) {
      continue;
    }
    if ((isPros && pros.length) || (isCons && cons.length)) {
      continue;
    }
    const start = m.index + m[0].length;
    const chunk = html.slice(start, start + 5000);
    const items = pcv1ExtractListItems(chunk);
    if (!items.length) {
      continue;
    }
    if (isPros) {
      pros = items.slice(0, 3);
    } else {
      cons = items.slice(0, 3);
    }
  }
  return { pros, cons };
}

function pcv1FirstContentImage(html) {
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    const tag = m[0];
    if (/^data:/i.test(src)) {
      continue;
    }
    if (/(sprite|spinner|loading|placeholder|blank|pixel|tracking|1x1|logo|icon|favicon)/i.test(src)) {
      continue;
    }
    if (/\b(width|height)=["']?(?:1|2|3|4|5|6|7|8|9|1\d)["']?/i.test(tag)) {
      continue;
    }
    if (/\.svg(\?|$)/i.test(src) && /(logo|icon)/i.test(src)) {
      continue;
    }
    return src;
  }
  return null;
}

function pcv1ParseJsonLdProducts(html) {
  const out = [];
  const re =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const t = item["@type"];
        const types = Array.isArray(t) ? t : [t];
        if (types.some(x => /Product/i.test(String(x || "")))) {
          out.push(item);
        }
        if (Array.isArray(item["@graph"])) {
          for (const node of item["@graph"]) {
            const nt = node?.["@type"];
            const nts = Array.isArray(nt) ? nt : [nt];
            if (nts.some(x => /Product/i.test(String(x || "")))) {
              out.push(node);
            }
          }
        }
      }
    } catch {
      // bad JSON-LD; skip
    }
  }
  return out;
}

function pcv1FirstString(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = pcv1FirstString(v);
      if (s) {
        return s;
      }
    }
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      const s = pcv1FirstString(v);
      if (s) {
        return s;
      }
    }
  }
  return null;
}

function pcv1ParsePrice(jsonld) {
  const offers = jsonld?.offers;
  if (!offers) {
    return null;
  }
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    const price = o?.price ?? o?.lowPrice ?? o?.priceSpecification?.price;
    const num = parseFloat(String(price).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(num) && num > 0) {
      return {
        amount: Math.round(num),
        currency: String(
          o?.priceCurrency ?? o?.priceSpecification?.priceCurrency ?? "USD"
        ).toUpperCase(),
      };
    }
  }
  return null;
}

function pcv1ParseRating(jsonld) {
  const r = jsonld?.aggregateRating ?? jsonld?.review?.reviewRating;
  if (!r) {
    return null;
  }
  const value = parseFloat(r.ratingValue);
  const count = parseInt(r.reviewCount ?? r.ratingCount, 10);
  if (!Number.isFinite(value)) {
    return null;
  }
  return {
    value: Math.max(0, Math.min(5, value)),
    count: Number.isFinite(count) ? count : 0,
  };
}

function pcv1AbsoluteUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

function pcv1ExtractProduct(html, pageUrl, fallbackTitle) {
  const ldList = pcv1ParseJsonLdProducts(html);
  const ld = ldList[0] || null;
  const ogImage =
    pcv1MetaTag(html, "og:image:secure_url") ||
    pcv1MetaTag(html, "og:image") ||
    pcv1MetaTag(html, "twitter:image");
  const ogTitle =
    pcv1MetaTag(html, "og:title") || pcv1MetaTag(html, "twitter:title");
  const ogDesc =
    pcv1MetaTag(html, "og:description") ||
    pcv1MetaTag(html, "description") ||
    pcv1MetaTag(html, "twitter:description");
  const ogSite = pcv1MetaTag(html, "og:site_name");
  let pageTitle = null;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    pageTitle = pcv1DecodeEntities(
      titleMatch[1].replace(/\s+/g, " ").trim()
    );
  }
  const name =
    (ld && pcv1FirstString(ld.name)) || ogTitle || pageTitle || fallbackTitle;
  const brandRaw =
    (ld &&
      (pcv1FirstString(ld.brand?.name) ||
        pcv1FirstString(ld.brand) ||
        pcv1FirstString(ld.manufacturer?.name))) ||
    ogSite ||
    null;
  const description =
    (ld && pcv1FirstString(ld.description)) || ogDesc || null;
  const ldImage =
    ld && (pcv1FirstString(ld.image) || pcv1FirstString(ld.image?.url));
  const contentImage = !ogImage && !ldImage ? pcv1FirstContentImage(html) : null;
  const imageUrl = pcv1AbsoluteUrl(
    ogImage || ldImage || contentImage || "",
    pageUrl
  );
  const prosCons = pcv1ExtractProsCons(html);
  const price = ld ? pcv1ParsePrice(ld) : null;
  const rating = ld ? pcv1ParseRating(ld) : null;
  let host = "";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {}
  const brand =
    brandRaw ||
    host
      .split(".")[0]
      .replace(/\b\w/g, c => c.toUpperCase());
  const idSeed = (name || pageUrl)
    .toLowerCase()
    .replace(/\W+/g, "-")
    .slice(0, 48);
  const id = `web-${idSeed}-${Math.abs(stringHash(pageUrl)) % 100000}`;
  return {
    id,
    name: (name || "Product").slice(0, 120),
    brand: (brand || "—").slice(0, 60),
    price: price || { amount: 0, currency: "USD" },
    imageUrl: imageUrl || null,
    productUrl: pageUrl,
    retailer: host || "Web",
    rating,
    reviewSummary: description
      ? truncateText(description, 240)
      : "Auto-extracted from product page.",
    specs: [
      { label: "Source", value: host || "Web" },
      ...(price ? [{ label: "Price", value: `$${price.amount}` }] : []),
      ...(rating
        ? [
            {
              label: "Rating",
              value: `${rating.value.toFixed(1)} (${rating.count})`,
            },
          ]
        : []),
    ],
    pros: prosCons.pros,
    cons: prosCons.cons,
    pinned: false,
    sourceMeta: {
      hasJsonLd: !!ld,
      hasOgImage: !!ogImage,
      hasPrice: !!price,
      hasRating: !!rating,
      hasProsCons: prosCons.pros.length > 0 || prosCons.cons.length > 0,
    },
  };
}

function stringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

function truncateText(s, max) {
  if (typeof s !== "string") {
    return "";
  }
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

async function pcv1FetchProduct(searchHit) {
  try {
    const html = await pcv1FetchText(searchHit.url, PCV1_FETCH_TIMEOUT_MS);
    return pcv1ExtractProduct(html, searchHit.url, searchHit.title);
  } catch (e) {
    lazy.console.warn("[pcv1] fetch product failed", searchHit.url, e?.message);
    return null;
  }
}

const PCV1_REVIEW_HOSTS = new Set([
  "cnet.com",
  "tomsguide.com",
  "wired.com",
  "rtings.com",
  "engadget.com",
  "theverge.com",
  "techradar.com",
  "pcmag.com",
  "gizmodo.com",
  "cyclingweekly.com",
  "gearedupbikes.com",
  "stackedjacked.com",
  "mechanicinsider.com",
  "runnersworld.com",
  "soundguys.com",
  "nytimes.com",
  "wirecutter.com",
  "forbes.com",
  "businessinsider.com",
  "bestproducts.com",
  "bestreviews.com",
  "consumerreports.org",
  "popularmechanics.com",
  "outdoorgearlab.com",
  "gearjunkie.com",
  "wired.co.uk",
  "tomshardware.com",
]);

function pcv1IsReviewHost(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return (
      PCV1_REVIEW_HOSTS.has(h) ||
      [...PCV1_REVIEW_HOSTS].some(r => h.endsWith("." + r))
    );
  } catch {
    return false;
  }
}

function pcv1NormalizeProductName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s*(\(|\[)[^\)\]]*(\)|\])\s*/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(review|reviewed|tested|the|a|an|best|top|new|model)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pcv1FlattenLdItemList(ld, out) {
  if (!ld || typeof ld !== "object") {
    return;
  }
  const t = ld["@type"];
  const isItemList =
    t === "ItemList" || (Array.isArray(t) && t.includes("ItemList"));
  if (isItemList && Array.isArray(ld.itemListElement)) {
    for (const el of ld.itemListElement) {
      const item = el?.item || el;
      const name = pcv1FirstString(item?.name);
      const url = pcv1FirstString(item?.url);
      if (name && name.length >= 3 && name.length <= 120) {
        out.push({ name, url: url || null });
      }
    }
  }
  const isReview =
    t === "Review" || (Array.isArray(t) && t.includes("Review"));
  if (isReview && ld.itemReviewed) {
    const item = ld.itemReviewed;
    const name = pcv1FirstString(item?.name);
    const url = pcv1FirstString(item?.url);
    if (name && name.length >= 3 && name.length <= 120) {
      out.push({ name, url: url || null });
    }
  }
  if (Array.isArray(ld["@graph"])) {
    for (const node of ld["@graph"]) {
      pcv1FlattenLdItemList(node, out);
    }
  }
}

function pcv1ExtractProductsFromReview(html, baseUrl) {
  const fromLd = [];
  const ldScripts =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldScripts.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of arr) {
        pcv1FlattenLdItemList(node, fromLd);
      }
    } catch {
      // bad JSON-LD; skip
    }
  }

  const fromHeadings = [];
  const headRe =
    /<h[2-4]\b[^>]*>([\s\S]{0,400}?)<\/h[2-4]>([\s\S]{0,2000}?)(?=<h[2-4]\b|<\/article|<\/main|$)/gi;
  let h;
  while ((h = headRe.exec(html)) && fromHeadings.length < 12) {
    const headingText = pcv1StripTags(h[1]);
    if (!headingText || headingText.length < 4 || headingText.length > 110) {
      continue;
    }
    if (headingText.includes("|") || headingText.includes("•")) {
      continue;
    }
    const cleaned = headingText
      .replace(/^[0-9]+[\.\):\-\s]+/, "")
      .replace(/^(best|top|great|good|excellent|recommended|editor['s]*\s+\w+|premium|budget|overall|runner[\s-]?up|also\s+great|honorable\s+mention)[\w\s,&\-]*?:\s*/i, "")
      .trim();
    if (
      !cleaned ||
      cleaned.length < 6 ||
      cleaned.length > 90 ||
      !/[A-Z][a-z]/.test(cleaned) ||
      /^(why|how|what|when|where|who|the|our|conclusion|verdict|features|specs|review|specifications|pros|cons|faq|comparison|table|of\s+contents|methodology|results|summary|introduction|how\s+we|what\s+to|key\s+takeaways|advertisement|sponsored|trending|popular|related|explore|discover|browse|see\s+all|view\s+all|show\s+more|see\s+more|view\s+more|more\s+from|read\s+more|read\s+next|continue\s+reading|sign\s+up|subscribe|newsletter|share|follow|home|about|contact|privacy|terms)\b/i.test(cleaned) ||
      /\b(coverage|category|categories|topic|topics|hub|hubs|news|deals|guide|guides|articles|page|section)\b/i.test(cleaned) ||
      /^(top|best)\s+\d/i.test(cleaned)
    ) {
      continue;
    }
    const wordCount = cleaned.split(/\s+/).length;
    const hasModelNumber = /\b[A-Z0-9]+[\-]?[0-9]+/i.test(cleaned) || /\b(pro|max|mini|plus|ultra|air|elite|premium|sport|active|2nd|3rd|4th|gen)\b/i.test(cleaned);
    const capitalizedSequence = (cleaned.match(/\b[A-Z][A-Za-z0-9]+/g) || []).length;
    if (!hasModelNumber && capitalizedSequence < 2) {
      continue;
    }
    if (wordCount < 2 || wordCount > 10) {
      continue;
    }
    const followingHtml = h[2] || "";
    const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let bestUrl = null;
    let lk;
    while ((lk = linkRe.exec(followingHtml))) {
      let candidate = pcv1DecodeDDGRedirect(lk[1].replace(/&amp;/g, "&"));
      try {
        candidate = new URL(candidate, baseUrl).toString();
      } catch {
        continue;
      }
      if (
        /^https?:/.test(candidate) &&
        !pcv1IsReviewHost(candidate) &&
        pcv1IsLikelyShoppingUrl(candidate)
      ) {
        bestUrl = candidate;
        break;
      }
    }
    fromHeadings.push({ name: cleaned, url: bestUrl });
  }

  const merged = [...fromLd, ...fromHeadings];
  return merged;
}

async function pcv1FindProductPageUrl(productName) {
  const hits = await pcv1WebSearch(productName);
  for (const h of hits) {
    if (
      !pcv1IsReviewHost(h.url) &&
      !pcv1IsHubUrl(h.url) &&
      pcv1IsLikelyShoppingUrl(h.url)
    ) {
      return h.url;
    }
  }
  return null;
}

async function pcv1RealProductSearch(query, count) {
  const target = Math.max(3, Math.min(5, Number(count) || 4));
  const reviewHits = await pcv1WebSearch(query);
  if (!reviewHits.length) {
    return { products: [], hits: [] };
  }

  const reviewCandidates = reviewHits.slice(0, 4);
  const reviewSettled = await Promise.allSettled(
    reviewCandidates.map(h => pcv1FetchText(h.url, PCV1_FETCH_TIMEOUT_MS))
  );

  const counts = new Map();
  for (let i = 0; i < reviewSettled.length; i++) {
    const s = reviewSettled[i];
    if (s.status !== "fulfilled") {
      continue;
    }
    const reviewUrl = reviewCandidates[i].url;
    const found = pcv1ExtractProductsFromReview(s.value, reviewUrl);
    const seenInThis = new Set();
    for (const p of found) {
      const key = pcv1NormalizeProductName(p.name);
      if (!key || key.length < 3 || seenInThis.has(key)) {
        continue;
      }
      seenInThis.add(key);
      if (!counts.has(key)) {
        counts.set(key, {
          name: p.name,
          urls: [],
          mentions: 0,
          firstIdx: i,
        });
      }
      const entry = counts.get(key);
      entry.mentions++;
      if (p.url && !entry.urls.includes(p.url)) {
        entry.urls.push(p.url);
      }
    }
  }

  if (!counts.size) {
    return { products: [], hits: reviewCandidates };
  }

  const ranked = Array.from(counts.values())
    .sort(
      (a, b) =>
        b.mentions - a.mentions ||
        b.urls.length - a.urls.length ||
        a.firstIdx - b.firstIdx
    )
    .slice(0, target);

  const productUrlSettled = await Promise.allSettled(
    ranked.map(async r => {
      const goodEmbedded = r.urls.find(
        u => !pcv1IsReviewHost(u) && !pcv1IsHubUrl(u)
      );
      if (goodEmbedded) {
        return goodEmbedded;
      }
      try {
        return await pcv1FindProductPageUrl(r.name);
      } catch {
        return null;
      }
    })
  );

  const productSettled = await Promise.allSettled(
    ranked.map(async (r, i) => {
      const urlSettled = productUrlSettled[i];
      const url =
        urlSettled.status === "fulfilled" ? urlSettled.value : null;
      if (!url) {
        return {
          id: `web-${pcv1NormalizeProductName(r.name).replace(/\s+/g, "-")}-x`,
          name: r.name.slice(0, 120),
          brand: "—",
          price: { amount: 0, currency: "USD" },
          imageUrl: null,
          productUrl: null,
          retailer: "Web",
          rating: null,
          reviewSummary: `Mentioned in ${r.mentions} review${r.mentions === 1 ? "" : "s"}.`,
          specs: [{ label: "Mentions", value: String(r.mentions) }],
          pros: [],
          cons: [],
          pinned: false,
          sourceMeta: { mentions: r.mentions, fetched: false },
        };
      }
      const product = await pcv1FetchProduct({ url, title: r.name });
      if (product) {
        if (!product.name || /^product$/i.test(product.name)) {
          product.name = r.name.slice(0, 120);
        }
        product.sourceMeta = {
          ...(product.sourceMeta || {}),
          mentions: r.mentions,
          fetched: true,
        };
      }
      return (
        product || {
          id: `web-${pcv1NormalizeProductName(r.name).replace(/\s+/g, "-")}-x`,
          name: r.name.slice(0, 120),
          brand: "—",
          price: { amount: 0, currency: "USD" },
          imageUrl: null,
          productUrl: url,
          retailer: (() => {
            try {
              return new URL(url).hostname.replace(/^www\./, "");
            } catch {
              return "Web";
            }
          })(),
          rating: null,
          reviewSummary: `Mentioned in ${r.mentions} review${r.mentions === 1 ? "" : "s"}. Product page fetch failed.`,
          specs: [{ label: "Mentions", value: String(r.mentions) }],
          pros: [],
          cons: [],
          pinned: false,
          sourceMeta: { mentions: r.mentions, fetched: false },
        }
      );
    })
  );

  const products = [];
  for (const s of productSettled) {
    if (s.status === "fulfilled" && s.value) {
      products.push(s.value);
    }
  }

  return { products, hits: reviewCandidates };
}

// ---------- Product comparison: canned data + helpers ----------

const CANNED_BIKE_SEAT_PRODUCTS = [
  {
    id: "thule-yepp-maxi",
    name: "Yepp Maxi 2 Rack Mount",
    brand: "Thule",
    price: { amount: 229, currency: "USD" },
    imageUrl: null,
    productUrl: "https://www.thule.com/en-us/bike-child-seats/yepp-maxi",
    retailer: "Thule.com",
    rating: { value: 4.7, count: 312 },
    reviewSummary:
      "Praised for sturdy rack mount and ebike compatibility. Parents say the harness adjusts easily and the recline is appreciated on longer rides.",
    specs: [
      { label: "Mount", value: "Rear rack" },
      { label: "Weight capacity", value: "48.5 lb" },
      { label: "Seat weight", value: "9 lb" },
      { label: "Age range", value: "9 mo - 6 yr" },
      { label: "Recline", value: "Yes" },
      { label: "Footrest", value: "Adjustable" },
    ],
    pros: ["Sturdy rack mount", "Quick on/off", "Good ebike fit"],
    cons: ["Pricier than competitors"],
    pinned: false,
  },
  {
    id: "hamax-caress",
    name: "Caress Rear Frame Mount",
    brand: "Hamax",
    price: { amount: 189, currency: "USD" },
    imageUrl: null,
    productUrl: "https://www.hamax.com/products/caress",
    retailer: "Hamax.com",
    rating: { value: 4.4, count: 178 },
    reviewSummary:
      "Comfortable padding and a deep recline, but several reviewers note the frame mount may not clear larger ebike batteries.",
    specs: [
      { label: "Mount", value: "Frame (seat tube)" },
      { label: "Weight capacity", value: "48.5 lb" },
      { label: "Seat weight", value: "9.9 lb" },
      { label: "Age range", value: "9 mo - 6 yr" },
      { label: "Recline", value: "Yes (deep)" },
      { label: "Footrest", value: "Adjustable" },
    ],
    pros: ["Plush padding", "Deep recline"],
    cons: ["Frame fit issues on some ebikes"],
    pinned: false,
  },
  {
    id: "burley-dash-rm",
    name: "Dash RM Rack-Mounted Seat",
    brand: "Burley",
    price: { amount: 219, currency: "USD" },
    imageUrl: null,
    productUrl: "https://burley.com/dash-rm",
    retailer: "REI",
    rating: { value: 4.5, count: 96 },
    reviewSummary:
      "Lightweight rack-mount option with a low profile. Reviewers praise the ventilation and easy install.",
    specs: [
      { label: "Mount", value: "Rear rack" },
      { label: "Weight capacity", value: "40 lb" },
      { label: "Seat weight", value: "8 lb" },
      { label: "Age range", value: "12 mo - 5 yr" },
      { label: "Recline", value: "No" },
      { label: "Footrest", value: "Adjustable" },
    ],
    pros: ["Light", "Good ventilation", "Easy install"],
    cons: ["No recline", "Lower weight cap"],
    pinned: false,
  },
  {
    id: "bobike-go-maxi",
    name: "GO Maxi Rear Carrier Seat",
    brand: "Bobike",
    price: { amount: 159, currency: "USD" },
    imageUrl: null,
    productUrl: "https://www.bobike.com/go-maxi",
    retailer: "Amazon",
    rating: { value: 4.2, count: 64 },
    reviewSummary:
      "Budget-friendly rack mount with simple installation. Some users report the harness clip can be tricky for one-handed buckling.",
    specs: [
      { label: "Mount", value: "Rear rack" },
      { label: "Weight capacity", value: "48 lb" },
      { label: "Seat weight", value: "8.6 lb" },
      { label: "Age range", value: "9 mo - 6 yr" },
      { label: "Recline", value: "Slight" },
      { label: "Footrest", value: "Yes" },
    ],
    pros: ["Affordable", "Lightweight"],
    cons: ["Fiddly harness", "Plainer design"],
    pinned: false,
  },
];

const CANNED_BIKE_SEAT_RECOMMENDATION = {
  recommendationId: "thule-yepp-maxi",
  recommendationRationale:
    "Best for ebikes — heavy-duty rack mount, 48.5 lb capacity, and a recline most parents loved.",
};

const CANNED_EARBUDS_PRODUCTS = [
  {
    id: "bose-qc-ultra",
    name: "Bose QuietComfort Ultra Earbuds (2nd Gen)",
    brand: "Bose",
    price: { amount: 299, currency: "USD" },
    imageUrl:
      "https://assets.bose.com/content/dam/cloudassets/Bose_DAM/Web/consumer_electronics/global/products/headphones/qc_ultra_earbuds_gen2/product_silo_images/QCUE2_Black_PDP_Hero.psd/_jcr_content/renditions/cq5dam.web.1280.1280.png",
    productUrl: "https://www.bose.com/p/earbuds/bose-quietcomfort-ultra-earbuds",
    retailer: "bose.com",
    rating: { value: 4.6, count: 1842 },
    reviewSummary:
      "Class-leading active noise cancellation with Immersive Audio. Reviewers praise call clarity and comfort over long sessions.",
    specs: [
      { label: "ANC", value: "Class-leading" },
      { label: "Battery", value: "6h + 18h case" },
      { label: "Bluetooth", value: "5.3" },
      { label: "Water-resist", value: "IPX4" },
      { label: "Spatial audio", value: "Immersive Audio" },
    ],
    pros: ["Best-in-class ANC", "Exceptional call quality", "Comfortable long-wear fit"],
    cons: ["Expensive", "Larger case than rivals"],
    pinned: false,
  },
  {
    id: "sony-wf-1000xm6",
    name: "Sony WF-1000XM6",
    brand: "Sony",
    price: { amount: 279, currency: "USD" },
    imageUrl:
      "https://www.sony.com/image/85e2b7fa1f87a98efb2c4aa3e09e61a7?fmt=pjpeg&wid=720&bgcolor=FFFFFF&bgc=FFFFFF",
    productUrl: "https://electronics.sony.com/audio/headphones/truly-wireless/p/wf1000xm6-b",
    retailer: "sony.com",
    rating: { value: 4.7, count: 2615 },
    reviewSummary:
      "RTINGS' top pick. Excellent ANC, rich tunable EQ, and the longest single-charge battery in the class.",
    specs: [
      { label: "ANC", value: "Excellent (adaptive)" },
      { label: "Battery", value: "8h + 24h case" },
      { label: "Bluetooth", value: "5.4 LE Audio" },
      { label: "Water-resist", value: "IPX4" },
      { label: "Spatial audio", value: "360 Reality Audio" },
    ],
    pros: ["Best battery in class", "Deep customization in app", "LDAC + LE Audio"],
    cons: ["Touch controls finicky", "Multipoint requires re-pairing"],
    pinned: false,
  },
  {
    id: "apple-airpods-pro-2",
    name: "Apple AirPods Pro 2 (USB-C)",
    brand: "Apple",
    price: { amount: 249, currency: "USD" },
    imageUrl:
      "https://store.storeimages.cdn-apple.com/4982/as-images.apple.com/is/MTJV3?wid=940&hei=1112&fmt=png-alpha&.v=1693598845058",
    productUrl: "https://www.apple.com/shop/buy-airpods/airpods-pro",
    retailer: "apple.com",
    rating: { value: 4.7, count: 9421 },
    reviewSummary:
      "Wired's editor pick for iPhone owners. Adaptive Audio + Conversation Awareness make ANC feel context-aware.",
    specs: [
      { label: "ANC", value: "Adaptive (very good)" },
      { label: "Battery", value: "6h + 30h case" },
      { label: "Bluetooth", value: "5.3 + H2 chip" },
      { label: "Water-resist", value: "IP54" },
      { label: "Spatial audio", value: "Personalized Spatial" },
    ],
    pros: ["Seamless Apple ecosystem", "Best transparency mode", "Adaptive Audio is killer"],
    cons: ["Locked to Apple devices for full features", "No Hi-Res codec"],
    pinned: false,
  },
  {
    id: "beats-fit-pro-2",
    name: "Beats Fit Pro 2",
    brand: "Beats",
    price: { amount: 199, currency: "USD" },
    imageUrl:
      "https://www.beatsbydre.com/content/dam/beats/web/product/earphones/fit-pro/pdp-v2/product-carousel/black/fitpro-2-black-pdp-001.jpg",
    productUrl: "https://www.beatsbydre.com/earbuds/beats-fit-pro",
    retailer: "beatsbydre.com",
    rating: { value: 4.5, count: 3210 },
    reviewSummary:
      "Best workout-friendly pick. Wing-tip stays put, IPX4-rated, and the H1 chip pairs across Apple devices.",
    specs: [
      { label: "ANC", value: "Good" },
      { label: "Battery", value: "6h + 18h case" },
      { label: "Bluetooth", value: "5.0 + H1 chip" },
      { label: "Water-resist", value: "IPX4" },
      { label: "Fit", value: "Secure-fit wingtips" },
    ],
    pros: ["Stable for runs/gym", "Cross-platform (iOS + Android)", "Lower price than QC Ultra"],
    cons: ["No wireless charging case", "Smaller drivers than competitors"],
    pinned: false,
  },
  {
    id: "samsung-galaxy-buds-3-pro",
    name: "Samsung Galaxy Buds 3 Pro",
    brand: "Samsung",
    price: { amount: 249, currency: "USD" },
    imageUrl:
      "https://images.samsung.com/is/image/samsung/p6pim/levant/sm-r630nzaamea/gallery/levant-galaxy-buds3-pro-r630-sm-r630nzaamea-541892812",
    productUrl: "https://www.samsung.com/us/mobile/audio/galaxy-buds3-pro/",
    retailer: "samsung.com",
    rating: { value: 4.4, count: 1567 },
    reviewSummary:
      "AI translation, 24-bit Hi-Fi over LE Audio, and a redesigned blade-like stem. Best for Galaxy phone owners.",
    specs: [
      { label: "ANC", value: "Adaptive (very good)" },
      { label: "Battery", value: "7h + 23h case" },
      { label: "Bluetooth", value: "5.4 LE Audio + Auracast" },
      { label: "Water-resist", value: "IP57" },
      { label: "Spatial audio", value: "360 Audio + head-track" },
    ],
    pros: ["Highest IP rating in class", "Live translation feature", "24-bit Hi-Fi over LE Audio"],
    cons: ["Best features locked to Galaxy phones", "Stems can feel awkward"],
    pinned: false,
  },
];

const CANNED_EARBUDS_RECOMMENDATION = {
  recommendationId: "bose-qc-ultra",
  recommendationRationale:
    "Best ANC + best call quality. If price is a concern, Sony WF-1000XM6 is nearly identical for less.",
};

function isEarbudsQuery(q) {
  const s = String(q || "").toLowerCase();
  return (
    /\bear[\s-]?(bud|phone|piece)s?\b/.test(s) ||
    /\b(in[\s-]?ear|true\s*wireless|tws|airpods?)\b/.test(s) ||
    (/\b(noise[\s-]?(cancell?ing|cancel))\b/.test(s) &&
      !/\bover[\s-]?ear|on[\s-]?ear|headphones?\b/.test(s))
  );
}

function isBikeSeatQuery(q) {
  return /bike\s*seat|child\s*seat|kid.*bike/i.test(String(q || ""));
}

function makeMockProductFromQuery(query, idx) {
  const seed = String(query || "product").trim();
  const brandList = ["Acme", "NorthPeak", "Lumen", "Halix", "Verge"];
  const brand = brandList[idx % brandList.length];
  const id = `mock-${idx}-${seed.toLowerCase().replace(/\W+/g, "-").slice(0, 24)}`;
  const price = 80 + idx * 35;
  return {
    id,
    name: `${brand} ${seed.split(/\s+/).slice(0, 4).join(" ")}`,
    brand,
    price: { amount: price, currency: "USD" },
    imageUrl: null,
    productUrl: `https://example.com/${id}`,
    retailer: "Example Shop",
    rating: { value: 4 + (idx % 2) * 0.3, count: 40 + idx * 17 },
    reviewSummary:
      "AI-estimated overview. Verify on the product page for current details.",
    specs: [
      { label: "Type", value: seed },
      { label: "Color", value: ["Black", "Gray", "Blue", "Green"][idx % 4] },
      { label: "Warranty", value: "1 year" },
      { label: "Stock", value: "Available" },
    ],
    pros: ["Solid value"],
    cons: ["Limited reviews"],
    pinned: false,
  };
}

function makeMockProductList(query, count) {
  const n = Math.max(3, Math.min(5, Number(count) || 4));
  return Array.from({ length: n }, (_, i) => makeMockProductFromQuery(query, i));
}

function makeProductFromUrl(tabUrl) {
  const url = String(tabUrl || "");
  let host = "example.com";
  let slug = "product";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "");
    const parts = u.pathname.split("/").filter(Boolean);
    slug = parts[parts.length - 1] || parts[parts.length - 2] || "product";
  } catch {}
  const niceName = slug
    .replace(/[-_+]+/g, " ")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/\b\w/g, c => c.toUpperCase())
    .slice(0, 60);
  const brand = host.split(".")[0].replace(/\b\w/g, c => c.toUpperCase());
  const id = `tab-${host}-${slug}`.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 64);
  return {
    id,
    name: niceName || "Product from your tab",
    brand,
    price: { amount: 0, currency: "USD" },
    imageUrl: null,
    productUrl: url || `https://${host}`,
    retailer: host,
    rating: null,
    reviewSummary:
      "AI-estimated from URL — open the product page to verify reviews and specs.",
    specs: [
      { label: "Source", value: host },
      { label: "Status", value: "AI-estimated" },
    ],
    pros: [],
    cons: [],
    pinned: true,
  };
}

function applyConstraints(products, constraints) {
  if (!constraints || typeof constraints !== "object") {
    return products;
  }
  let next = products.slice();
  if (typeof constraints.priceMax === "number") {
    next = next.filter(
      p => p.pinned || (p.price?.amount ?? 0) <= constraints.priceMax
    );
  }
  if (typeof constraints.priceMin === "number") {
    next = next.filter(
      p => p.pinned || (p.price?.amount ?? 0) >= constraints.priceMin
    );
  }
  if (Array.isArray(constraints.brands) && constraints.brands.length) {
    const wanted = constraints.brands.map(b => String(b).toLowerCase());
    next = next.filter(
      p => p.pinned || wanted.includes(String(p.brand || "").toLowerCase())
    );
  }
  return next;
}

function pickRecommendation(products, query) {
  if (!products.length) {
    return { recommendationId: null, recommendationRationale: "" };
  }
  if (isBikeSeatQuery(query)) {
    const thule = products.find(p => p.id === "thule-yepp-maxi");
    if (thule) {
      return { ...CANNED_BIKE_SEAT_RECOMMENDATION };
    }
  }
  if (isEarbudsQuery(query)) {
    const bose = products.find(p => p.id === "bose-qc-ultra");
    if (bose) {
      return { ...CANNED_EARBUDS_RECOMMENDATION };
    }
  }
  const top = products
    .slice()
    .sort((a, b) => (b.rating?.value || 0) - (a.rating?.value || 0))[0];
  return {
    recommendationId: top.id,
    recommendationRationale: `Top-rated option in this set (${top.rating?.value ?? "n/a"} stars).`,
  };
}

function orderRecommendedFirst(products, recommendationId) {
  if (!recommendationId) {
    return products;
  }
  const idx = products.findIndex(p => p.id === recommendationId);
  if (idx <= 0) {
    return products;
  }
  const next = products.slice();
  const [picked] = next.splice(idx, 1);
  next.unshift(picked);
  return next;
}

function buildComparisonResult(conversation, query, constraints, products) {
  const ordered = orderRecommendedFirst(
    products,
    pickRecommendation(products, query).recommendationId
  );
  const rec = pickRecommendation(ordered, query);
  return {
    convId: conversation.id,
    query: String(query || ""),
    constraints: constraints || {},
    products: ordered,
    recommendationId: rec.recommendationId,
    recommendationRationale: rec.recommendationRationale,
  };
}

/**
 * Initial product comparison entry point.
 * Performs a real web search via DuckDuckGo HTML, extracts product info
 * (og:image, JSON-LD Product, meta tags) from the top results in parallel,
 * and falls back to the canned bike-seat dataset / generic mock when search
 * yields no products. Caches search hits on conversation._comparisonV1 so
 * refinements operate on real data.
 */
export async function compareProducts(toolParams, conversation) {
  const params =
    toolParams && typeof toolParams === "object" ? toolParams : {};
  const query = String(params.query || "");
  const count = Math.max(3, Math.min(5, Number(params.count) || 4));

  let products = [];
  let searchHits = [];
  let searchSource = "web";
  let searchError = null;

  try {
    const real = await pcv1RealProductSearch(query, count);
    products = real.products;
    searchHits = real.hits;
  } catch (e) {
    searchError = e?.message || String(e);
    lazy.console.warn("[Tool] compareProducts search threw", e);
  }

  if (!products.length) {
    if (isBikeSeatQuery(query)) {
      products = structuredClone(CANNED_BIKE_SEAT_PRODUCTS).slice(0, count);
      searchSource = "canned-bike-seat";
    } else if (isEarbudsQuery(query)) {
      products = structuredClone(CANNED_EARBUDS_PRODUCTS).slice(0, count);
      searchSource = "canned-earbuds";
    } else {
      products = makeMockProductList(query, count);
      searchSource = "mock";
    }
  }

  products = applyConstraints(products, params.constraints);
  const result = buildComparisonResult(
    conversation,
    query,
    params.constraints || {},
    products
  );
  result.searchSource = searchSource;
  result.searchHits = searchHits;
  if (searchError) {
    result.searchError = searchError;
  }
  conversation._comparisonV1 = result;
  conversation.securityProperties.setPrivateData();
  conversation.emit?.("chat-conversation:comparison-data", {
    kind: "initial",
    data: result,
  });
  lazy.console.log(
    "[Tool] compareProducts",
    { query, source: searchSource, count: products.length }
  );
  return result;
}

/**
 * Mutate the active comparison set in place. Server-replace semantics: returns
 * the full updated payload; the artifact wholesale replaces its data on receipt.
 */
export async function refineComparison(toolParams, conversation) {
  const params =
    toolParams && typeof toolParams === "object" ? toolParams : {};
  const action = String(params.action || "filter");
  let current = conversation._comparisonV1;
  if (!current) {
    return {
      error: "No active comparison to refine. Call compare_products first.",
    };
  }
  let products = current.products.slice();
  let constraints = { ...(current.constraints || {}) };
  let changeSummary = "";

  if (action === "filter") {
    const filter = params.filter || {};
    constraints = { ...constraints, ...filter };
    const before = products.length;
    products = applyConstraints(products, filter);
    const removed = before - products.length;
    const parts = [];
    if (typeof filter.priceMax === "number") {
      parts.push(`under $${filter.priceMax}`);
    }
    if (typeof filter.priceMin === "number") {
      parts.push(`at least $${filter.priceMin}`);
    }
    if (Array.isArray(filter.brands) && filter.brands.length) {
      parts.push(`brand ${filter.brands.join(", ")}`);
    }
    changeSummary =
      `Filtered to ${parts.join("; ") || "the requested constraints"}` +
      (removed > 0 ? `; removed ${removed} product${removed === 1 ? "" : "s"}.` : ".");
  } else if (action === "remove_product") {
    const id = params.productId;
    const before = products.length;
    products = products.filter(p => p.id !== id);
    if (products.length === before) {
      changeSummary = `Could not find product ${id} in the comparison.`;
    } else {
      changeSummary = `Removed product from the comparison.`;
    }
  } else if (action === "add_product") {
    const url = params.productUrl;
    const q = params.productQuery;
    let added;
    if (url) {
      added = makeProductFromUrl(url);
    } else if (q) {
      added = makeMockProductFromQuery(q, products.length);
      added.pinned = true;
    } else {
      return { error: "add_product requires productUrl or productQuery." };
    }
    if (products.length >= 5) {
      const evictIdx = products.findIndex(p => !p.pinned);
      if (evictIdx >= 0) {
        products.splice(evictIdx, 1);
      } else {
        products.shift();
      }
    }
    products.push(added);
    changeSummary = `Added ${added.name} from ${added.retailer}.`;
  } else if (action === "replace_set") {
    products = makeMockProductList(current.query, 4);
    changeSummary = "Replaced the comparison with a fresh set.";
  } else if (action === "re_recommend") {
    changeSummary = "Re-evaluated the recommendation.";
  }

  const result = buildComparisonResult(
    conversation,
    current.query,
    constraints,
    products
  );
  result.changeSummary = changeSummary;
  conversation._comparisonV1 = result;
  conversation.securityProperties.setPrivateData();
  conversation.emit?.("chat-conversation:comparison-data", {
    kind: "refined",
    data: result,
  });
  lazy.console.log("[Tool] refineComparison", result);
  return result;
}

/**
 * Adds a product from the user's currently active tab URL.
 * Tries to fetch & extract real product data from the page (og:image, JSON-LD)
 * before falling back to URL-mock. Falls back to getOpenTabs() if no explicit
 * tabUrl is supplied.
 */
export async function addProductFromTab(toolParams, conversation) {
  const params =
    toolParams && typeof toolParams === "object" ? toolParams : {};
  let tabUrl = String(params.tabUrl || "").trim();
  if (!tabUrl) {
    try {
      const tabs = await getOpenTabs(conversation);
      if (tabs && tabs.length) {
        tabUrl = tabs[0].url;
      }
    } catch {
      // ignore — will fall through to error below
    }
  }
  if (!tabUrl) {
    return {
      error:
        "No active tab URL available. Ask the user to share the product page URL.",
    };
  }

  let realProduct = null;
  try {
    realProduct = await pcv1FetchProduct({ url: tabUrl, title: "" });
    if (realProduct) {
      realProduct.pinned = true;
    }
  } catch (e) {
    lazy.console.warn("[Tool] addProductFromTab fetch failed", e);
  }

  const current = conversation._comparisonV1;
  if (realProduct && current) {
    let products = current.products.slice();
    if (products.length >= 5) {
      const evictIdx = products.findIndex(p => !p.pinned);
      if (evictIdx >= 0) {
        products.splice(evictIdx, 1);
      } else {
        products.shift();
      }
    }
    products.push(realProduct);
    const result = buildComparisonResult(
      conversation,
      current.query,
      current.constraints || {},
      products
    );
    result.searchHits = current.searchHits;
    result.searchSource = current.searchSource;
    result.changeSummary = `Added ${realProduct.name} from ${realProduct.retailer}.`;
    conversation._comparisonV1 = result;
    conversation.securityProperties.setPrivateData();
    conversation.emit?.("chat-conversation:comparison-data", {
      kind: "refined",
      data: result,
    });
    return result;
  }

  return refineComparison(
    { convId: params.convId, action: "add_product", productUrl: tabUrl },
    conversation
  );
}

export const toolFns = {
  getOpenTabs,
  searchBrowsingHistory,
  getUserMemories,
  getNavigationInfo,
  compareProducts,
  refineComparison,
  addProductFromTab,
};
