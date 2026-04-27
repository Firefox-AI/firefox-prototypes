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
export const GENERATE_TRAVEL_PLAN = "generate_travel_plan";
// Trip Planner v1 tools.
export const PLAN_TRIP = "plan_trip";
export const PROPOSE_TAB_SCOPE = "propose_tab_scope";
export const MUTATE_TRIP = "mutate_trip";
export const OPEN_SEARCH_SPLIT_VIEW = "open_search_split_view";

export const TOOLS = [
  GET_OPEN_TABS,
  SEARCH_BROWSING_HISTORY,
  GET_PAGE_CONTENT,
  RUN_SEARCH,
  GET_USER_MEMORIES,
  GET_NAVIGATION_INFO,
  GENERATE_TRAVEL_PLAN,
  PLAN_TRIP,
  PROPOSE_TAB_SCOPE,
  MUTATE_TRIP,
  OPEN_SEARCH_SPLIT_VIEW,
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
      name: GENERATE_TRAVEL_PLAN,
      description:
        "Generate a self-contained interactive HTML travel plan and open it in a new tab. " +
        "IMPORTANT: Call this tool AUTOMATICALLY as soon as you have enough information to build " +
        "an itinerary (at minimum: destination and duration). Do NOT ask the user for permission " +
        "before calling this tool — just call it. First use get_open_tabs and search_browsing_history " +
        "to find travel-related pages, extract details with get_page_content, then call this tool " +
        "with a complete plan. The plan parameter must be a JSON string.",
      parameters: {
        type: "object",
        properties: {
          plan: {
            type: "string",
            description:
              'A JSON string containing the travel plan data with fields: ' +
              'name (string), destination (string), dates (string), nights (number), ' +
              'adults (number), budget_total (number), budget_estimated (number), ' +
              'preferences (array of strings), bookings (array of {name, detail, price, status}), ' +
              'itinerary (array of {day, title, activities: [{time, text, note}]}), ' +
              'packing (object with category keys mapping to arrays of {name, important}), ' +
              'alerts (array of {type, text}), source_urls (array of strings), ' +
              'weather ({location, temp_high, temp_low, condition, season_note}), ' +
              'flights (array of {airline, flight_number, departure, arrival, departure_time, arrival_time, price, status, source_url}), ' +
              'hotels (array of {name, check_in, check_out, price_per_night, total_price, rating, address, source_url}).',
          },
        },
        required: ["plan"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: PLAN_TRIP,
      description:
        "Trip Planner v1: produce a structured TripPlan and render it as an interactive itinerary " +
        "artifact in the chat. Empty hotel/flight slots are intentional — do NOT fabricate hotel " +
        "names, flight numbers, or prices. Slots fill only via open_search_split_view (user picks) " +
        "or mutate_trip (user provided full details inline).",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string" },
          duration_days: { type: "integer", minimum: 1, maximum: 14 },
          start_date: { type: "string" },
          interests: { type: "array", items: { type: "string" } },
          use_tab_context: { type: "boolean" },
          tab_ids: { type: "array", items: { type: "string" } },
        },
        required: ["destination", "duration_days"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: PROPOSE_TAB_SCOPE,
      description:
        "Returns currently open Firefox tabs whose titles or URLs match the trip destination or a " +
        "travel-domain allowlist. Surfaces the in-chat permission card. Returns titles and URLs only.",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string" },
          start_date: { type: "string" },
          duration_days: { type: "integer" },
        },
        required: ["destination"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: MUTATE_TRIP,
      description:
        "Apply a targeted slot mutation to the active trip. Use replace_flight / replace_hotel " +
        "directly when the user provides full inline details. Otherwise call open_search_split_view " +
        "first. Never invent missing fields.",
      parameters: {
        type: "object",
        properties: {
          trip_id: { type: "string" },
          mutation_type: {
            type: "string",
            enum: [
              "swap_activity",
              "replace_hotel",
              "replace_flight",
              "clear_hotel",
              "clear_flight",
              "reorder_days",
              "change_duration",
            ],
          },
          payload: { type: "object" },
        },
        required: ["trip_id", "mutation_type", "payload"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: OPEN_SEARCH_SPLIT_VIEW,
      description:
        "Open a side-by-side stubbed search view (hotel or flight) pre-filtered to trip dates. " +
        "Returns 5 sample results labeled 'Sample results - real search coming in v1.1'. Use when " +
        "user wants to add a slot but did not provide full details inline.",
      parameters: {
        type: "object",
        properties: {
          slot_type: { type: "string", enum: ["hotel", "flight"] },
          destination: { type: "string" },
          dates: { type: "object" },
          trip_id: { type: "string" },
        },
        required: ["slot_type", "destination", "trip_id"],
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

/**
 * Generates a travel plan, stores the data for the full-page HTML view,
 * opens the trip plan page in a new tab, and returns the plan data for
 * the sidebar artifact.
 *
 * @param {object} toolParams
 * @param {string} toolParams.plan - JSON string of the travel plan data
 * @param {SecurityProperties} securityProperties
 * @param {object} context
 * @returns {Promise<object>}
 */
export async function generateTravelPlan(toolParams, securityProperties, context) {
  let planData;
  try {
    planData = typeof toolParams.plan === "string"
      ? JSON.parse(toolParams.plan)
      : toolParams.plan;
  } catch {
    return { error: "Invalid JSON in plan parameter" };
  }

  if (!planData.destination) {
    return { error: "Destination is required" };
  }

  // Store the plan data in a pref for the full-page HTML to read
  try {
    Services.prefs.setStringPref(
      "browser.smartwindow.tripPlanData",
      JSON.stringify(planData)
    );
    Services.obs.notifyObservers(null, "trip-plan-data-updated");
  } catch (e) {
    lazy.console.error("[Tool] generateTravelPlan pref error:", e);
  }

  // Open the trip plan page in split view with the user's content tab
  try {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (win?.gBrowser) {
      // Find the user's actual content tab (http/https), not an internal page
      let contentTab = null;
      const selected = win.gBrowser.selectedTab;
      const selectedUrl = selected.linkedBrowser?.currentURI?.spec || "";
      if (
        selectedUrl.startsWith("http://") ||
        selectedUrl.startsWith("https://")
      ) {
        contentTab = selected;
      } else {
        // Fall back to the most recent tab with a web URL
        const tabs = [...win.gBrowser.tabs].reverse();
        for (const tab of tabs) {
          const url = tab.linkedBrowser?.currentURI?.spec || "";
          if (url.startsWith("http://") || url.startsWith("https://")) {
            contentTab = tab;
            break;
          }
        }
      }

      const planTab = win.gBrowser.addTab(
        "chrome://browser/content/aiwindow/tripPlan.html",
        {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
          inBackground: true,
        }
      );

      if (contentTab) {
        // If content tab is already in a split view, unsplit first
        if (contentTab.splitView) {
          contentTab.splitView.unsplitTabs();
        }
        // Create split view: user's page on the left, plan on the right
        win.gBrowser.addTabSplitView([contentTab, planTab]);
      } else {
        // No web content tab found — just select the plan tab
        win.gBrowser.selectedTab = planTab;
      }
    }
  } catch (e) {
    lazy.console.error("[Tool] generateTravelPlan tab open error:", e);
  }

  securityProperties.setPrivateData();
  lazy.console.log("[Tool] generateTravelPlan", planData);
  return planData;
}

// ---------------------------------------------------------------------------
// Trip Planner v1 — see _prototype/2026-04-26-trip-planner/spec.md
// ---------------------------------------------------------------------------

const TRAVEL_DOMAIN_ALLOWLIST = [
  "booking.com",
  "airbnb.com",
  "kayak.com",
  "google.com/flights",
  "google.com/travel",
  "expedia.com",
  "tripadvisor.com",
  "maps.google.com",
  "weather.com",
];

const SF_HOTEL_STUBS = [
  {
    id: "hotel-zephyr",
    name: "Hotel Zephyr",
    rating: 4.2,
    price: "$189",
    priceNight: 189,
    amenities: ["Wharf", "Pet-friendly", "Bay view"],
    source_url: "https://www.google.com/search?q=Hotel+Zephyr+San+Francisco",
  },
  {
    id: "hotel-vitale",
    name: "Hotel Vitale",
    rating: 4.5,
    price: "$245",
    priceNight: 245,
    amenities: ["Embarcadero", "Spa", "Skyline view"],
    source_url: "https://www.google.com/search?q=Hotel+Vitale+San+Francisco",
  },
  {
    id: "kimpton-buchanan",
    name: "Kimpton Buchanan",
    rating: 4.3,
    price: "$172",
    priceNight: 172,
    amenities: ["Japantown", "Free Wi-Fi", "Bike rentals"],
    source_url:
      "https://www.google.com/search?q=Kimpton+Buchanan+San+Francisco",
  },
  {
    id: "hotel-via",
    name: "Hotel Via",
    rating: 4.4,
    price: "$219",
    priceNight: 219,
    amenities: ["South Beach", "Rooftop bar", "Steps from ballpark"],
    source_url: "https://www.google.com/search?q=Hotel+Via+San+Francisco",
  },
  {
    id: "stanford-court",
    name: "Stanford Court",
    rating: 4.0,
    price: "$159",
    priceNight: 159,
    amenities: ["Nob Hill", "Cable car stop", "Quiet"],
    source_url: "https://www.google.com/search?q=Stanford+Court+San+Francisco",
  },
];

const SF_FLIGHT_STUBS = [
  {
    id: "ua-230",
    carrier: "United",
    flight_no: "UA 230",
    depart: "JFK 06:30",
    arrive: "SFO 09:45",
    price: "$340",
    notes: "Nonstop, 6h 15m",
    source_url: "https://www.google.com/flights",
  },
  {
    id: "aa-178",
    carrier: "American",
    flight_no: "AA 178",
    depart: "JFK 08:00",
    arrive: "SFO 11:25",
    price: "$312",
    notes: "Nonstop, 6h 25m",
    source_url: "https://www.google.com/flights",
  },
  {
    id: "dl-415",
    carrier: "Delta",
    flight_no: "DL 415",
    depart: "JFK 09:15",
    arrive: "SFO 12:38",
    price: "$365",
    notes: "Nonstop, 6h 23m",
    source_url: "https://www.google.com/flights",
  },
  {
    id: "b6-1241",
    carrier: "JetBlue",
    flight_no: "B6 1241",
    depart: "JFK 17:00",
    arrive: "SFO 20:30",
    price: "$289",
    notes: "Nonstop, 6h 30m",
    source_url: "https://www.google.com/flights",
  },
  {
    id: "as-89",
    carrier: "Alaska",
    flight_no: "AS 89",
    depart: "JFK 12:45",
    arrive: "SFO 16:12",
    price: "$321",
    notes: "Nonstop, 6h 27m",
    source_url: "https://www.google.com/flights",
  },
];

function makeStubTripPlan({
  destination,
  duration_days,
  start_date,
  use_tab_context,
  tabs = [],
}) {
  const isoStart = (() => {
    if (start_date) {
      const d = new Date(start_date);
      if (!isNaN(d)) {
        return d;
      }
    }
    const fallback = new Date();
    fallback.setHours(0, 0, 0, 0);
    return fallback;
  })();
  const days = Math.max(1, Math.min(14, parseInt(duration_days, 10) || 3));
  const isoEnd = new Date(isoStart);
  isoEnd.setDate(isoEnd.getDate() + days);

  // SF-flavored stub itinerary if destination matches; otherwise a generic
  // template. v1 demo seed targets San Francisco.
  const isSF = /\bs(an\s*f(rancisco)?|f)\b/i.test(destination || "");

  const sfDays = [
    {
      day: 1,
      title: "The Mission",
      activities: [
        {
          id: "d1-a1",
          time: "09:00",
          title: "Tartine bakery",
          location: "Mission District",
          lat: 37.7614,
          lng: -122.4241,
        },
        {
          id: "d1-a2",
          time: "12:00",
          title: "Mission murals walk",
          location: "Balmy Alley",
          lat: 37.7541,
          lng: -122.4115,
        },
        {
          id: "d1-a3",
          time: "19:00",
          title: "Foreign Cinema dinner",
          location: "Mission District",
          lat: 37.7559,
          lng: -122.4196,
        },
      ],
    },
    {
      day: 2,
      title: "Golden Gate",
      activities: [
        {
          id: "d2-a1",
          time: "10:00",
          title: "SFMOMA",
          location: "SoMa",
          lat: 37.7857,
          lng: -122.401,
        },
        {
          id: "d2-a2",
          time: "14:00",
          title: "Golden Gate Park",
          location: "Richmond",
          lat: 37.7694,
          lng: -122.4862,
        },
        {
          id: "d2-a3",
          time: "18:00",
          title: "Cliff House sunset",
          location: "Outer Richmond",
          lat: 37.7787,
          lng: -122.5138,
        },
      ],
    },
    {
      day: 3,
      title: "Wharf & Alcatraz",
      activities: [
        {
          id: "d3-a1",
          time: "09:30",
          title: "Alcatraz tour",
          location: "Pier 33",
          lat: 37.8267,
          lng: -122.4233,
        },
        {
          id: "d3-a2",
          time: "13:00",
          title: "Fisherman's Wharf",
          location: "Wharf",
          lat: 37.808,
          lng: -122.4177,
        },
        {
          id: "d3-a3",
          time: "17:00",
          title: "Pier 39 sea lions",
          location: "Pier 39",
          lat: 37.8087,
          lng: -122.4098,
        },
      ],
    },
  ];

  const dayTemplates = isSF
    ? sfDays.slice(0, days)
    : Array.from({ length: days }, (_, i) => ({
        day: i + 1,
        title: `Day ${i + 1}`,
        activities: [
          {
            id: `d${i + 1}-a1`,
            time: "10:00",
            title: "Plan this day",
            location: destination,
          },
        ],
      }));
  // Pad with empty placeholders if days > template length.
  while (dayTemplates.length < days) {
    const i = dayTemplates.length;
    dayTemplates.push({
      day: i + 1,
      title: `Day ${i + 1}`,
      activities: [],
    });
  }

  const weather = dayTemplates.map((_, i) => ({
    day: i + 1,
    high_f: 68 + ((i * 3) % 7),
    low_f: 52 + ((i * 2) % 5),
    condition: ["sunny", "cloudy", "rain", "partly-cloudy"][i % 4],
  }));

  const tripId = `trip-${Date.now()}`;
  return {
    schema: "TripPlanV1",
    trip_id: tripId,
    destination,
    date_range: {
      start: isoStart.toISOString().slice(0, 10),
      end: isoEnd.toISOString().slice(0, 10),
    },
    day_count: days,
    flight_slot: { filled: false, placeholder: "Pick a flight" },
    hotel_slot: { filled: false, placeholder: "Add a hotel" },
    weather,
    days: dayTemplates,
    map_bbox: { north: 37.835, south: 37.74, east: -122.36, west: -122.52 },
    grounding: {
      source: use_tab_context ? "tabs" : "general",
      tab_count: tabs.length,
    },
    tabs: tabs.slice(0, 10).map(t => ({
      id: t.url || t.id,
      title: t.title,
      url: t.url,
      favicon: t.url ? `page-icon:${t.url}` : null,
    })),
  };
}

/**
 * propose_tab_scope: returns the matched-tab list for the in-chat permission card.
 *
 * @param {object} toolParams
 * @param {ChatConversation} conversation
 * @returns {Promise<object>}
 */
export async function proposeTabScope(toolParams, conversation) {
  const params = toolParams && typeof toolParams === "object" ? toolParams : {};
  const destination = String(params.destination || "").trim();
  const tabs = await getOpenTabs(conversation);

  const destLower = destination.toLowerCase();
  const matched = tabs.filter(t => {
    const title = (t.title || "").toLowerCase();
    let host = "";
    try {
      host = new URL(t.url).hostname.toLowerCase();
    } catch {}
    if (destLower && (title.includes(destLower) || host.includes(destLower))) {
      return true;
    }
    if (TRAVEL_DOMAIN_ALLOWLIST.some(d => (host + t.url).includes(d))) {
      return true;
    }
    return false;
  });

  const result = {
    schema: "TabScopeV1",
    matched_tabs: matched.slice(0, 10).map(t => ({
      id: t.url,
      title: t.title,
      url: t.url,
      favicon: `page-icon:${t.url}`,
    })),
    match_count: matched.length,
    destination,
  };
  conversation.securityProperties.setPrivateData();
  lazy.console.log("[Tool] proposeTabScope", result);
  return result;
}

/**
 * plan_trip: build a structured TripPlan and dispatch the v1 artifact.
 *
 * @param {object} toolParams
 * @param {ChatConversation} conversation
 * @param {object} context
 * @returns {Promise<object>}
 */
export async function planTrip(toolParams, conversation, context) {
  const params = toolParams && typeof toolParams === "object" ? toolParams : {};
  if (!params.destination) {
    return { error: "Destination is required" };
  }

  let tabs = [];
  if (params.use_tab_context) {
    if (Array.isArray(params.tab_ids) && params.tab_ids.length) {
      const allTabs = await getOpenTabs(conversation);
      const ids = new Set(params.tab_ids);
      tabs = allTabs.filter(t => ids.has(t.url));
    } else {
      const proposal = await proposeTabScope({ destination: params.destination }, conversation);
      tabs = proposal.matched_tabs.map(t => ({ url: t.url, title: t.title }));
    }
  }

  const plan = makeStubTripPlan({
    destination: params.destination,
    duration_days: params.duration_days,
    start_date: params.start_date,
    use_tab_context: !!params.use_tab_context,
    tabs,
  });

  conversation.securityProperties.setPrivateData();
  lazy.console.log("[Tool] planTrip", plan);

  // Stash the live trip on the conversation so mutate_trip / open_search can find it.
  conversation._tripPlanV1 = plan;
  return plan;
}

/**
 * mutate_trip: apply a slot-targeted diff to the active TripPlan.
 *
 * @param {object} toolParams
 * @param {ChatConversation} conversation
 * @returns {Promise<object>}
 */
export async function mutateTrip(toolParams, conversation) {
  const params = toolParams && typeof toolParams === "object" ? toolParams : {};
  const plan = conversation._tripPlanV1;
  if (!plan) {
    return { error: "No active trip to mutate." };
  }
  if (params.trip_id && params.trip_id !== plan.trip_id) {
    return { error: "trip_id does not match the active trip." };
  }

  const diff = [];
  let mutatedPath = null;
  const { mutation_type: type, payload = {} } = params;

  switch (type) {
    case "swap_activity": {
      const dayIdx = plan.days.findIndex(d => d.day === payload.day);
      if (dayIdx === -1) {
        return { error: `Day ${payload.day} not found.` };
      }
      const day = plan.days[dayIdx];
      let actIdx = day.activities.findIndex(a => a.id === payload.activity_id);
      if (actIdx === -1 && payload.activity_index != null) {
        actIdx = payload.activity_index;
      }
      if (actIdx < 0 || actIdx >= day.activities.length) {
        return { error: "Activity not found." };
      }
      const before = { ...day.activities[actIdx] };
      day.activities[actIdx] = {
        ...before,
        title: payload.new_title || before.title,
        location: payload.new_location ?? before.location,
      };
      diff.push({
        op: "replace",
        path: `days[${dayIdx}].activities[${actIdx}]`,
        value: day.activities[actIdx],
      });
      mutatedPath = { kind: "activity", activity_id: day.activities[actIdx].id };
      break;
    }
    case "replace_hotel": {
      plan.hotel_slot = {
        filled: true,
        name: payload.name,
        price: payload.price,
        check_in: payload.check_in,
        check_out: payload.check_out,
        source_url: payload.source_url,
      };
      diff.push({ op: "replace", path: "hotel_slot", value: plan.hotel_slot });
      mutatedPath = { kind: "hotel" };
      break;
    }
    case "replace_flight": {
      plan.flight_slot = {
        filled: true,
        carrier: payload.carrier,
        flight_no: payload.flight_no,
        depart: payload.depart,
        arrive: payload.arrive,
        price: payload.price,
        source_url: payload.source_url,
      };
      diff.push({ op: "replace", path: "flight_slot", value: plan.flight_slot });
      mutatedPath = { kind: "flight" };
      break;
    }
    case "clear_hotel": {
      plan.hotel_slot = { filled: false, placeholder: "Add a hotel" };
      diff.push({ op: "replace", path: "hotel_slot", value: plan.hotel_slot });
      mutatedPath = { kind: "hotel" };
      break;
    }
    case "clear_flight": {
      plan.flight_slot = { filled: false, placeholder: "Pick a flight" };
      diff.push({ op: "replace", path: "flight_slot", value: plan.flight_slot });
      mutatedPath = { kind: "flight" };
      break;
    }
    case "change_duration": {
      const newDuration = Math.max(
        1,
        Math.min(14, parseInt(payload.new_duration, 10) || plan.day_count)
      );
      while (plan.days.length < newDuration) {
        const i = plan.days.length;
        plan.days.push({
          day: i + 1,
          title: `Day ${i + 1}`,
          activities: [],
        });
        plan.weather.push({
          day: i + 1,
          high_f: 68,
          low_f: 54,
          condition: "partly-cloudy",
        });
      }
      while (plan.days.length > newDuration) {
        plan.days.pop();
        plan.weather.pop();
      }
      plan.day_count = newDuration;
      diff.push({ op: "replace", path: "day_count", value: newDuration });
      mutatedPath = { kind: "duration" };
      break;
    }
    case "reorder_days": {
      if (!Array.isArray(payload.new_order)) {
        return { error: "reorder_days requires payload.new_order array." };
      }
      const reordered = payload.new_order
        .map(n => plan.days.find(d => d.day === n))
        .filter(Boolean);
      if (reordered.length !== plan.days.length) {
        return { error: "new_order must list every day exactly once." };
      }
      reordered.forEach((d, i) => (d.day = i + 1));
      plan.days = reordered;
      diff.push({ op: "replace", path: "days", value: plan.days });
      mutatedPath = { kind: "days" };
      break;
    }
    default:
      return { error: `Unknown mutation_type: ${type}` };
  }

  conversation._tripPlanV1 = plan;
  conversation.securityProperties.setPrivateData();
  lazy.console.log("[Tool] mutateTrip", { type, diff });
  return {
    diff,
    updated_trip: plan,
    mutated_path: mutatedPath,
    mutation_type: type,
  };
}

/**
 * open_search_split_view: open a sibling chrome page with stubbed search results.
 *
 * @param {object} toolParams
 * @param {ChatConversation} conversation
 * @returns {Promise<object>}
 */
export async function openSearchSplitView(toolParams, conversation) {
  const params = toolParams && typeof toolParams === "object" ? toolParams : {};
  const slotType = params.slot_type === "flight" ? "flight" : "hotel";
  const stubResults = slotType === "hotel" ? SF_HOTEL_STUBS : SF_FLIGHT_STUBS;
  const splitViewId = `split-${Date.now()}`;

  const payload = {
    schema: "SampleSearchV1",
    split_view_id: splitViewId,
    slot_type: slotType,
    destination: params.destination,
    dates: params.dates ?? null,
    trip_id: params.trip_id,
    stub_results: stubResults,
  };

  try {
    Services.prefs.setStringPref(
      "browser.smartwindow.tripSampleSearchData",
      JSON.stringify(payload)
    );
    Services.obs.notifyObservers(null, "trip-sample-search-data-updated");
  } catch (e) {
    lazy.console.error("[Tool] openSearchSplitView pref error:", e);
  }

  // Open the sample search page in the top normal window's tab strip in
  // split-view alongside the user's current content tab. Mirrors the v0
  // generateTravelPlan pattern.
  try {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (win?.gBrowser) {
      let contentTab = null;
      const selected = win.gBrowser.selectedTab;
      const selectedUrl = selected.linkedBrowser?.currentURI?.spec || "";
      if (
        selectedUrl.startsWith("http://") ||
        selectedUrl.startsWith("https://")
      ) {
        contentTab = selected;
      } else {
        const tabs = [...win.gBrowser.tabs].reverse();
        for (const tab of tabs) {
          const url = tab.linkedBrowser?.currentURI?.spec || "";
          if (url.startsWith("http://") || url.startsWith("https://")) {
            contentTab = tab;
            break;
          }
        }
      }

      const searchTab = win.gBrowser.addTab(
        "chrome://browser/content/aiwindow/sampleSearch.html",
        {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
          inBackground: true,
        }
      );

      if (contentTab) {
        if (contentTab.splitView) {
          contentTab.splitView.unsplitTabs();
        }
        win.gBrowser.addTabSplitView([contentTab, searchTab]);
      } else {
        win.gBrowser.selectedTab = searchTab;
      }
    }
  } catch (e) {
    lazy.console.error("[Tool] openSearchSplitView tab open error:", e);
  }

  conversation.securityProperties.setPrivateData();
  lazy.console.log("[Tool] openSearchSplitView", payload);
  return payload;
}

export const toolFns = {
  getOpenTabs,
  searchBrowsingHistory,
  getUserMemories,
  getNavigationInfo,
  generateTravelPlan,
  planTrip,
  proposeTabScope,
  mutateTrip,
  openSearchSplitView,
};

// Global observer: when sampleSearch.html "Add to trip" fires, route the pick
// back into the active Smart Window as a follow-up that the LLM will pick up
// and call mutate_trip on. v1 demo glue.
let _tripPickObserverRegistered = false;
function registerTripPickObserver() {
  if (_tripPickObserverRegistered) {
    return;
  }
  _tripPickObserverRegistered = true;
  const observer = {
    observe(_subject, topic) {
      if (topic !== "trip-sample-search-pick") {
        return;
      }
      let pick = null;
      try {
        const raw = Services.prefs.getStringPref(
          "browser.smartwindow.tripSampleSearchPick",
          ""
        );
        if (!raw) {
          return;
        }
        pick = JSON.parse(raw);
      } catch (e) {
        lazy.console.warn("trip pick parse failed", e);
        return;
      }

      // Find the Smart Window's chat browser and dispatch a follow-up.
      try {
        for (const win of lazy.BrowserWindowTracker.orderedWindows) {
          if (!lazy.AIWindow.isAIWindowActive(win)) {
            continue;
          }
          const browser = win.document.getElementById?.("aichat-browser");
          if (!browser) {
            continue;
          }
          const text = pick.slot_type === "flight"
            ? `Add ${pick.result.carrier} ${pick.result.flight_no} ${pick.result.depart} -> ${pick.result.arrive} for ${pick.result.price} to my trip.`
            : `Add ${pick.result.name} at ${pick.result.price}/night to my trip.`;
          const actor =
            browser?.browsingContext?.currentWindowContext?.getActor?.(
              "AIChatContent"
            );
          actor?.sendAsyncMessage("AIChatContent:DispatchMessage", {
            content: { body: text, type: "text" },
            kind: "follow-up",
          });
          break;
        }
      } catch (e) {
        lazy.console.warn("trip pick dispatch failed", e);
      }
    },
  };
  try {
    Services.obs.addObserver(observer, "trip-sample-search-pick");
  } catch (e) {
    lazy.console.warn("trip pick observer registration failed", e);
  }
}

// Lazily register the observer on module load.
try {
  registerTripPickObserver();
} catch (_) {}
