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
  HistoryQuery:
    "moz-src:///browser/components/aiwindow/models/HistoryQuery.sys.mjs",
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
export const LOOKUP_LODGING_HISTORY = "lookup_lodging_history";

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
  LOOKUP_LODGING_HISTORY,
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
        "Open a self-contained interactive HTML travel plan in a new tab and switch the AI Window " +
        "to sidebar mode. The plan is a SKELETON — flights, hotels, and activities can be empty; " +
        "the user fills them in conversationally afterward. Call this AS SOON AS you have a " +
        "destination (and dates if mentioned). Do NOT block on hotel/flight/activity details; " +
        "do NOT fabricate any. Empty fields render as 'Click to add ...' placeholders that the " +
        "user fills via follow-up chat. The plan parameter must be a JSON string with at minimum " +
        "{ destination }. Other fields (dates, flights, hotels, itinerary, etc.) are optional.",
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
        "first. Never invent missing fields. The `trip_id` parameter is OPTIONAL — only pass it " +
        "if the active plan explicitly exposed one. If you don't have a trip_id, omit the field; " +
        "the system will mutate the single active trip.",
      parameters: {
        type: "object",
        properties: {
          trip_id: { type: "string" },
          mutation_type: {
            type: "string",
            enum: [
              "swap_activity",
              "replace_day",
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
        required: ["mutation_type", "payload"],
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
  {
    type: "function",
    function: {
      name: LOOKUP_LODGING_HISTORY,
      description:
        "Search the user's local browsing history (last 30 days) for lodging-related " +
        "pages they've already viewed (Airbnb, Vrbo, Booking, hotel chains). Use this " +
        "when the user mentions where they're staying ('I'm staying at an airbnb', " +
        "'we booked the Marriott'). Returns matching pages so the user can pick which " +
        "one they actually booked. NEVER fabricate matches — if 0 results, ask the " +
        "user for the booking URL. Local Places query only, never hits the network.",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description:
              "The lodging brand or type the user mentioned ('airbnb', 'marriott', " +
              "'hotel'). Drives the domain filter. Generic words fall back to a full " +
              "lodging-domain allowlist.",
          },
          destination: {
            type: "string",
            description:
              "The trip destination, used to rank matches whose title or URL " +
              "mentions the destination higher. Optional but recommended when known.",
          },
          days: {
            type: "number",
            description: "Lookback window in days. Defaults to 30.",
          },
        },
        required: ["keyword"],
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

  // De-duplicate by canonical URL. Keep the most-recently-accessed entry
  // (tabs is already sorted desc by lastAccessed). Pinned-and-content
  // duplicate URLs would otherwise produce duplicate chips downstream
  // (BUILD-2 in qa-report-1.md: "2 chips for same URL").
  const seenUrls = new Set();
  const dedupedTabs = [];
  for (const t of tabs) {
    if (seenUrls.has(t.url)) {
      continue;
    }
    seenUrls.add(t.url);
    dedupedTabs.push(t);
  }

  const recentTabs = dedupedTabs.slice(0, MAX_TABS);

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
// WMO weather code → human-readable condition. Subset covering the common cases.
const WMO_CONDITION = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Heavy showers",
  82: "Violent showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Severe thunderstorm",
};

function seasonForLatitude(lat, isoDate) {
  const month = new Date(isoDate || Date.now()).getMonth();
  const north = lat >= 0;
  if ([2, 3, 4].includes(month)) {
    return north ? "Spring" : "Autumn";
  }
  if ([5, 6, 7].includes(month)) {
    return north ? "Summer" : "Winter";
  }
  if ([8, 9, 10].includes(month)) {
    return north ? "Autumn" : "Spring";
  }
  return north ? "Winter" : "Summer";
}

/**
 * Fetch live weather for a destination via Open-Meteo (no auth required).
 * Returns null on any failure (offline, geocoding miss, parse error). Callers
 * MUST tolerate null — never fabricate.
 *
 * @param {string} destination
 * @returns {Promise<{condition: string, temp_high: number, temp_low: number, season_note: string}|null>}
 */
async function fetchDestinationWeather(destination) {
  if (
    !destination ||
    typeof destination !== "string" ||
    destination.trim().toLowerCase() === "trip"
  ) {
    return null;
  }
  // Hard cap so a slow Open-Meteo can never block generate_travel_plan.
  const TIMEOUT_MS = 4000;
  const timeout = ms =>
    new Promise(resolve => lazy.setTimeout(() => resolve(null), ms));
  const fetchJson = async url => {
    const resp = await fetch(url);
    if (!resp.ok) {
      return null;
    }
    return resp.json();
  };
  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(destination)}&count=1&format=json`;
    const geo = await Promise.race([fetchJson(geoUrl), timeout(TIMEOUT_MS)]);
    const place = geo?.results?.[0];
    if (!place) {
      return null;
    }
    const { latitude, longitude } = place;
    const fcUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}` +
      `&longitude=${longitude}&current_weather=true&temperature_unit=fahrenheit` +
      `&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto`;
    const fc = await Promise.race([fetchJson(fcUrl), timeout(TIMEOUT_MS)]);
    const code =
      fc?.current_weather?.weathercode ?? fc?.daily?.weathercode?.[0];
    const high = Math.round(fc?.daily?.temperature_2m_max?.[0] ?? NaN);
    const low = Math.round(fc?.daily?.temperature_2m_min?.[0] ?? NaN);
    if (!Number.isFinite(high) || !Number.isFinite(low)) {
      return null;
    }
    const dayCount = Math.min(
      5,
      fc?.daily?.time?.length || 0,
      fc?.daily?.temperature_2m_max?.length || 0
    );
    const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const forecast = [];
    for (let i = 0; i < dayCount; i++) {
      const isoDay = fc.daily.time[i];
      const dayHigh = Math.round(fc.daily.temperature_2m_max[i]);
      const dayLow = Math.round(fc.daily.temperature_2m_min[i]);
      const dayCode = fc.daily.weathercode?.[i];
      if (!Number.isFinite(dayHigh) || !Number.isFinite(dayLow)) {
        continue;
      }
      const dt = new Date(isoDay + "T12:00:00");
      forecast.push({
        date: i === 0 ? "Today" : dayLabels[dt.getUTCDay()] || isoDay,
        condition: WMO_CONDITION[dayCode] || "Mixed",
        high: dayHigh,
        low: dayLow,
      });
    }
    return {
      condition: WMO_CONDITION[code] || "Mixed",
      temp_high: high,
      temp_low: low,
      season_note: seasonForLatitude(latitude, fc?.daily?.time?.[0]),
      forecast,
    };
  } catch (e) {
    lazy.console.warn("[Tool] fetchDestinationWeather failed:", e);
    return null;
  }
}

/**
 * Fetch Open Graph metadata for a URL. Returns null on any failure.
 * Used to enrich hotel cards with hero images + canonical titles when the
 * user pastes a booking URL.
 *
 * @param {string} url
 * @returns {Promise<{image_url: string|null, title: string|null, description: string|null, site_name: string|null}|null>}
 */
async function fetchOgMeta(url) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return null;
  }
  const TIMEOUT_MS = 3000;
  const timeout = ms =>
    new Promise(resolve => lazy.setTimeout(() => resolve(null), ms));
  // Many sites (Expedia, Airbnb, Booking) gate scraping by User-Agent and
  // return either a 403 or a stub page when called without a real browser UA.
  // Forward a desktop Chrome UA so the response actually contains og:* tags.
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml",
  };
  try {
    const resp = await Promise.race([
      fetch(url, { redirect: "follow", headers }),
      timeout(TIMEOUT_MS),
    ]);
    if (!resp || !resp.ok) {
      return null;
    }
    const html = await Promise.race([resp.text(), timeout(TIMEOUT_MS)]);
    if (!html || typeof html !== "string") {
      return null;
    }
    // Cap the slice we scan to avoid running regex on multi-MB pages.
    const head = html.slice(0, 200000);
    const meta = prop => {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`,
        "i"
      );
      const tag = head.match(re);
      if (!tag) {
        return null;
      }
      const content = tag[0].match(/content=["']([^"']+)["']/i);
      return content ? content[1] : null;
    };
    let imageUrl = meta("og:image") || meta("twitter:image") || null;
    if (imageUrl && imageUrl.startsWith("//")) {
      imageUrl = "https:" + imageUrl;
    }
    return {
      image_url: imageUrl,
      title: meta("og:title") || null,
      description: meta("og:description") || null,
      site_name: meta("og:site_name") || null,
    };
  } catch (e) {
    lazy.console.warn("[Tool] fetchOgMeta failed:", e);
    return null;
  }
}

// Destination-keyed activity pools for mock itineraries. Slots per day are
// chosen from a 6-slot template and the day's activities are picked
// deterministically by day index so the same trip stays stable across renders.
const ITIN_TIMESLOTS = [
  "9:00 AM",
  "11:30 AM",
  "1:00 PM",
  "3:00 PM",
  "6:00 PM",
  "8:30 PM",
];
const ITIN_POOLS = {
  nyc: [
    { title: "Breakfast at Russ & Daughters", note: "Iconic appetizing shop, classic NYC bagel" },
    { title: "Statue of Liberty + Ellis Island ferry", note: "Book Crown access in advance" },
    { title: "The Met museum", note: "Suggested $30; allow 3+ hours" },
    { title: "Central Park stroll + Bethesda Terrace", note: "Rent a bike at Columbus Circle" },
    { title: "Lunch at Katz's Deli", note: "Pastrami on rye, no compromises" },
    { title: "Top of the Rock observation deck", note: "Sunset slot has the best view" },
    { title: "Broadway show at Richard Rodgers", note: "Hamilton, last-minute lottery $10" },
    { title: "High Line + Chelsea Market dinner", note: "Walk the elevated park then graze" },
    { title: "Brooklyn Bridge walk at golden hour", note: "Start from Manhattan side" },
    { title: "9/11 Memorial + Oculus", note: "Contemplative; book museum 30-min entry" },
    { title: "MoMA visit", note: "Free Friday evenings 4-8 PM" },
    { title: "Jazz at the Village Vanguard", note: "Reservations strongly recommended" },
    { title: "SoHo shopping + Joe's Pizza slice", note: "Window shop, then a perfect $4 slice" },
    { title: "Greenwich Village walking tour", note: "Folk history + Washington Square" },
    { title: "Williamsburg dinner at Lilia", note: "Take the L train; pasta worth the wait" },
  ],
  sf: [
    { title: "Coffee at Sightglass", note: "SOMA roastery, third-wave classic" },
    { title: "Golden Gate Bridge walk + Battery Spencer", note: "Bus 30 to Marin side for the view" },
    { title: "Alcatraz tour", note: "Book 2+ weeks ahead" },
    { title: "Mission District burrito at La Taqueria", note: "Carnitas, no rice — local rules" },
    { title: "Lands End coastal trail", note: "Sutro Baths ruins at the end" },
    { title: "SFMOMA visit", note: "Free for 18 and under" },
    { title: "Cable car to Ghirardelli Square", note: "Powell-Hyde line for the steep hills" },
    { title: "Dim sum in Chinatown at Hang Ah", note: "Oldest in SF — har gow + char siu bao" },
    { title: "Painted Ladies + Alamo Square", note: "Full House row, photo-op" },
    { title: "Ferry Building farmers market", note: "Saturday mornings only" },
    { title: "Sunset at Twin Peaks", note: "Drive or Muni 37" },
    { title: "Jazz at SFJAZZ Center", note: "Hayes Valley, world-class lineups" },
  ],
  tokyo: [
    { title: "Sushi breakfast at Tsukiji outer market", note: "Aim for 7 AM, beat the lines" },
    { title: "Senso-ji temple + Nakamise shopping street", note: "Asakusa; wear walking shoes" },
    { title: "Shibuya scramble + Hachiko statue", note: "Best from Starbucks 2nd floor" },
    { title: "Ramen at Ichiran Shinjuku", note: "Tonkotsu broth, solo booth experience" },
    { title: "TeamLab Borderless / Planets", note: "Reserve timed entry online" },
    { title: "Meiji Shrine + Yoyogi Park", note: "Forested oasis in central Tokyo" },
    { title: "Robot show or izakaya in Shinjuku Golden Gai", note: "Tiny bars, big personality" },
    { title: "Ueno Park + Tokyo National Museum", note: "Cherry blossoms in spring" },
    { title: "Dinner in Ginza — sukiyaki or kaiseki", note: "Reserve weeks ahead at Kanesaka" },
    { title: "Kabuki at Kabuki-za theater", note: "Single-act tickets available same-day" },
    { title: "Akihabara electronics + arcade hop", note: "Don Quijote for souvenirs" },
    { title: "Day trip to Kamakura Big Buddha", note: "Easy 1hr train from Tokyo Station" },
  ],
  generic: [
    { title: "Walking tour of the historic center", note: "Most cities offer free morning tours" },
    { title: "Local breakfast spot recommended by hotel", note: "Ask the front desk for a tip" },
    { title: "Top-rated museum visit", note: "Buy timed entry online if popular" },
    { title: "Lunch at a local market", note: "Cheaper, more authentic than restaurants" },
    { title: "Iconic neighborhood stroll", note: "Pick the most walkable district" },
    { title: "Sunset viewpoint", note: "Search for 'best sunset view' + city name" },
    { title: "Dinner at a regional specialty restaurant", note: "Avoid tourist-trap zones" },
    { title: "Live music or theater night", note: "Check Time Out + local listings" },
    { title: "Coffee at a famous cafe", note: "Most cities have at least one institution" },
    { title: "Day trip to nearby town", note: "30-90 min away by train or bus" },
    { title: "Park or waterfront walk", note: "Pack a snack" },
    { title: "Local cooking class", note: "Hands-on, bring an appetite" },
  ],
};
function poolForDestination(destination) {
  const k = String(destination || "").toLowerCase();
  if (/new york|nyc|manhattan|brooklyn/.test(k)) {
    return ITIN_POOLS.nyc;
  }
  if (/san francisco|sf|bay area/.test(k)) {
    return ITIN_POOLS.sf;
  }
  if (/tokyo|japan/.test(k)) {
    return ITIN_POOLS.tokyo;
  }
  return ITIN_POOLS.generic;
}
function mockItinerary(destination, dayCount) {
  const pool = poolForDestination(destination);
  const dayTitles = pool === ITIN_POOLS.generic ? null : null;
  const itinerary = [];
  let activityIdx = 0;
  for (let d = 0; d < dayCount; d++) {
    // 3-6 activities per day, varying so it doesn't feel uniform.
    const slotCount = 3 + ((d * 7) % 4); // 3, 4, 5, 6, 3, 4, ...
    const activities = [];
    const slots = ITIN_TIMESLOTS.slice(0, slotCount);
    for (let s = 0; s < slotCount; s++) {
      const item = pool[activityIdx % pool.length];
      activityIdx++;
      activities.push({
        time: slots[s],
        text: item.title,
        note: item.note,
      });
    }
    itinerary.push({
      day: d + 1,
      title: dayTitles ? dayTitles[d] : `Day ${d + 1}`,
      activities,
    });
  }
  return itinerary;
}

function mockFlight(destination) {
  const k = String(destination || "").toLowerCase();
  let arrivalCode = "LGA";
  let arrivalCity = "New York";
  if (/san francisco|sf|bay area/.test(k)) {
    arrivalCode = "SFO";
    arrivalCity = "San Francisco";
  } else if (/tokyo|japan/.test(k)) {
    arrivalCode = "NRT";
    arrivalCity = "Tokyo";
  } else if (/los angeles|la\b/.test(k)) {
    arrivalCode = "LAX";
    arrivalCity = "Los Angeles";
  } else if (/london|uk/.test(k)) {
    arrivalCode = "LHR";
    arrivalCity = "London";
  } else if (/paris|france/.test(k)) {
    arrivalCode = "CDG";
    arrivalCity = "Paris";
  } else if (/new york|nyc|manhattan/.test(k)) {
    arrivalCode = "JFK";
    arrivalCity = "New York";
  }
  return {
    airline: "United",
    flight_number: "UA1116",
    status: "Ticketed",
    departure: "San Francisco",
    departure_code: "SFO",
    departure_time: "12:35 pm",
    arrival: arrivalCity,
    arrival_code: arrivalCode,
    arrival_time: "6:16 pm",
    price: "350",
    confirmation: "DT3P56",
    fare: "Economy",
    class: "Economy (W)",
    duration: "3h 41m",
    terminal: "3",
    gate: "--",
    mocked: true,
  };
}

// Per-night spend ranges (USD) used to derive the budget mock from
// destination + nights + adults. Keep these conservative for the prototype.
const BUDGET_DAILY = {
  nyc: { food: 90, transit: 25, activities: 60 },
  sf: { food: 80, transit: 20, activities: 55 },
  tokyo: { food: 60, transit: 15, activities: 50 },
  generic: { food: 70, transit: 20, activities: 50 },
};
function budgetKeyForDestination(destination) {
  const k = String(destination || "").toLowerCase();
  if (/new york|nyc|manhattan/.test(k)) {
    return "nyc";
  }
  if (/san francisco|sf|bay area/.test(k)) {
    return "sf";
  }
  if (/tokyo|japan/.test(k)) {
    return "tokyo";
  }
  return "generic";
}
function mockBudget(destination, nights, adults, flights, hotels) {
  const safeNights = Math.max(1, Number(nights) || 3);
  const safeAdults = Math.max(1, Number(adults) || 1);
  const rates = BUDGET_DAILY[budgetKeyForDestination(destination)];

  const flightCost =
    (flights || []).reduce(
      (sum, f) => sum + (Number(String(f.price).replace(/[^\d]/g, "")) || 0),
      0
    ) * safeAdults || 350 * safeAdults;
  const hotelNightly =
    Number((hotels || [])[0]?.price_per_night) ||
    (budgetKeyForDestination(destination) === "tokyo" ? 220 : 320);
  const hotelCost = hotelNightly * safeNights;
  const foodCost = rates.food * safeNights * safeAdults;
  const transitCost = rates.transit * safeNights * safeAdults;
  const activitiesCost = rates.activities * safeNights * safeAdults;
  const miscCost = Math.round((foodCost + transitCost + activitiesCost) * 0.1);

  const bookings = [
    { name: "Flights", price: flightCost },
    { name: "Hotel", price: hotelCost },
    { name: "Food & dining", price: foodCost },
    { name: "Local transit", price: transitCost },
    { name: "Activities & tickets", price: activitiesCost },
    { name: "Misc + buffer", price: miscCost },
  ];
  const estimated = bookings.reduce((s, b) => s + b.price, 0);
  // Set the "limit" 12% above estimate so the user reads as under budget.
  const total = Math.round((estimated * 1.12) / 50) * 50;
  return { bookings, estimated, total };
}

function mockPacking(destination, nights) {
  const safeNights = Math.max(1, Number(nights) || 3);
  const k = String(destination || "").toLowerCase();
  const isCold = /tokyo|japan|london|paris/.test(k);
  const isWarm = !isCold;
  const tops = Math.min(8, Math.max(3, safeNights));
  const bottoms = Math.min(4, Math.ceil(safeNights / 2));

  const clothing = [
    `${tops} shirts / tops`,
    `${bottoms} pairs of pants or shorts`,
    "Underwear + socks for each day",
    "Light jacket or hoodie",
    "Comfortable walking shoes",
  ];
  if (isWarm) {
    clothing.push("Sunglasses + hat");
    clothing.push("Sandals or sneakers");
  }
  if (isCold) {
    clothing.push("Warm coat");
    clothing.push("Scarf + gloves");
  }
  const dressy =
    /new york|nyc|manhattan|san francisco|sf|tokyo|paris/.test(k);
  if (dressy) {
    clothing.push("One nicer outfit for dinner");
  }

  return {
    Documents: [
      "Passport / ID",
      "Travel insurance card",
      "Booking confirmations (printed + on phone)",
      "Credit + debit cards",
      "Some local cash",
    ],
    Clothing: clothing,
    Toiletries: [
      "Toothbrush + toothpaste",
      "Deodorant",
      "Shampoo + conditioner",
      "Sunscreen",
      "Any prescription medication",
      "Contact lenses / glasses",
    ],
    Electronics: [
      "Phone + charger",
      "Portable battery pack",
      "Headphones",
      "Camera (optional)",
      "Travel adapter (if international)",
    ],
    "Day bag": [
      "Reusable water bottle",
      "Refillable snacks",
      "Light umbrella or rain shell",
      "Hand sanitizer",
      "Notebook + pen",
    ],
  };
}

function mockHotel(destination) {
  const k = String(destination || "").toLowerCase();
  if (/new york|nyc|manhattan/.test(k)) {
    return {
      name: "The Plaza",
      check_in: "2026-05-19",
      check_out: "2026-05-20",
      address: "768 5th Ave, New York, NY 10019",
      price_per_night: "",
      total_price: "",
      source_url:
        "https://www.expedia.com/New-York-Hotels-The-Plaza-Hotel.h28044.Hotel-Information?chkin=2026-05-19&chkout=2026-05-20&x_pwa=1&rfrr=HSR&pwa_ts=1778016852293&referrerUrl=aHR0cHM6Ly93d3cuZXhwZWRpYS5jb20vSG90ZWwtU2VhcmNo&useRewards=false&rm1=a2&regionId=2621&destination=New+York%2C+New+York%2C+United+States+of+America&destType=MARKET&neighborhoodId=553248633938969338&selected=28044&latLong=40.712843%2C-74.005966&sort=RECOMMENDED&top_dp=2138&top_cur=USD&gclid=CjwKCAjwqubPBhBOEiwAzgZX2pXVHTFhLp2Ce-3lVN3qLm_otC6DKGEFbtxjThen9vhG0uMA7pRY2hoCFA0QAvD_BwE&semcid=US.B.GOOGLE.BD-c-EN.HOTEL&semdtl=a118930182577.b1150843516384.g1kwd-309376493642.e1c.m1CjwKCAjwqubPBhBOEiwAzgZX2pXVHTFhLp2Ce-3lVN3qLm_otC6DKGEFbtxjThen9vhG0uMA7pRY2hoCFA0QAvD_BwE.r18593aef9e30cb6ef591574221b22d031edc381296cf844ef2ea416870ead5161.c16CpyebuuOcfC9YnvBqLSQA.j11013697.k1.d1640987373014.h1p.i1.l1.n1.o1.p1.q1.s1expedia+new+york.t1.x1.f1.u1.v1.w1&userIntent=&selectedRoomType=201286654&selectedRatePlan=206233023&categorySearch=any_option&searchId=b7a1f963-d594-4f2a-ab8c-2244d082110f",
      // Wikimedia photo of The Plaza — rendered immediately so the card
      // isn't blank when Expedia rate-limits the OG fetch (it usually does).
      // The async OG fetch can still upgrade this if it succeeds.
      image_url:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/Plaza_Hotel_May_2010.JPG/1280px-Plaza_Hotel_May_2010.JPG",
      site_name: "expedia.com",
      rating: "4.5",
      mocked: true,
    };
  }
  return {
    name: "Hotel placeholder",
    check_in: "",
    check_out: "",
    address: "",
    price_per_night: "",
    total_price: "",
    source_url: "",
    image_url: "",
    site_name: "",
    mocked: true,
  };
}

export async function generateTravelPlan(toolParams, securityProperties, context) {
  // Be permissive: a parse failure or missing param should never block the
  // user. Default to {} and let the skeleton-fill below produce a usable
  // plan from the destination alone.
  let planData = {};
  try {
    if (typeof toolParams?.plan === "string") {
      planData = JSON.parse(toolParams.plan);
    } else if (toolParams?.plan && typeof toolParams.plan === "object") {
      planData = toolParams.plan;
    }
  } catch (e) {
    lazy.console.warn("[Tool] generateTravelPlan parse failed; using empty plan:", e);
    planData = {};
  }
  planData = planData && typeof planData === "object" ? planData : {};

  // Don't clobber a populated plan with a skeleton. If the LLM called with
  // no destination but the user already has an active trip in the pref,
  // inherit the existing destination + any fields the LLM didn't supply.
  // This protects against the "click Generate again, plan goes blank" trap.
  const incomingHasDestination =
    planData.destination &&
    String(planData.destination).trim() &&
    String(planData.destination).trim().toLowerCase() !== "trip";
  if (!incomingHasDestination) {
    try {
      const existingRaw = Services.prefs.getStringPref(
        "browser.smartwindow.tripPlanData",
        ""
      );
      const existing = existingRaw ? JSON.parse(existingRaw) : null;
      if (
        existing &&
        existing.destination &&
        String(existing.destination).trim().toLowerCase() !== "trip"
      ) {
        planData.destination = planData.destination || existing.destination;
        if (!planData.name && existing.name) {
          planData.name = existing.name;
        }
        if (!planData.dates && existing.dates) {
          planData.dates = existing.dates;
        }
        if (!planData.nights && existing.nights) {
          planData.nights = existing.nights;
        }
        if (!planData.adults && existing.adults) {
          planData.adults = existing.adults;
        }
        if (
          (!Array.isArray(planData.itinerary) || !planData.itinerary.length) &&
          Array.isArray(existing.itinerary) &&
          existing.itinerary.length
        ) {
          planData.itinerary = existing.itinerary;
        }
        if (
          (!Array.isArray(planData.flights) || !planData.flights.length) &&
          Array.isArray(existing.flights) &&
          existing.flights.length
        ) {
          planData.flights = existing.flights;
        }
        if (
          (!Array.isArray(planData.hotels) || !planData.hotels.length) &&
          Array.isArray(existing.hotels) &&
          existing.hotels.length
        ) {
          planData.hotels = existing.hotels;
        }
        if (!planData.weather && existing.weather) {
          planData.weather = existing.weather;
        }
        if (
          (!Array.isArray(planData.alerts) || !planData.alerts.length) &&
          Array.isArray(existing.alerts) &&
          existing.alerts.length
        ) {
          planData.alerts = existing.alerts;
        }
      }
    } catch (e) {
      lazy.console.warn("[Tool] generateTravelPlan: pref restore failed:", e);
    }
  }

  // Skeleton-fill: every field is optional. Only requirement is *some*
  // identifying string — destination preferred, otherwise plan name.
  const destination = String(planData.destination || planData.name || "Trip");
  planData.destination = destination;
  planData.name = String(planData.name || `Trip to ${destination}`);
  planData.dates = String(planData.dates || "");
  planData.nights = Number(planData.nights) || 0;
  planData.adults = Number(planData.adults) || 1;
  planData.budget_total = Number(planData.budget_total) || 0;
  planData.budget_estimated = Number(planData.budget_estimated) || 0;
  planData.preferences = Array.isArray(planData.preferences)
    ? planData.preferences
    : [];
  planData.bookings = Array.isArray(planData.bookings) ? planData.bookings : [];
  planData.flights = Array.isArray(planData.flights) ? planData.flights : [];
  planData.hotels = Array.isArray(planData.hotels) ? planData.hotels : [];
  planData.alerts = Array.isArray(planData.alerts) ? planData.alerts : [];
  planData.source_urls = Array.isArray(planData.source_urls)
    ? planData.source_urls
    : [];
  planData.weather =
    planData.weather && typeof planData.weather === "object"
      ? planData.weather
      : null;
  if (!planData.weather || !planData.weather.condition) {
    const live = await fetchDestinationWeather(destination);
    if (live) {
      planData.weather = live;
    }
  }
  planData.packing =
    planData.packing && typeof planData.packing === "object"
      ? planData.packing
      : {};

  // Mock itinerary: 3-6 activities per day with realistic timeslots and
  // destination-aware suggestions. Marked as mock so the LLM can replace
  // them when the user provides specifics.
  if (!Array.isArray(planData.itinerary) || !planData.itinerary.length) {
    const dayCount = Math.max(1, Number(planData.nights) || 3);
    planData.itinerary = mockItinerary(destination, dayCount);
  }

  // Mock flight: a single round-trip-leg flight from a major hub. The user
  // can replace via mutate_trip when they have real booking details.
  if (!planData.flights.length) {
    planData.flights = [mockFlight(destination)];
  }

  // Mock hotel: when the destination is NYC-flavored, default to The Plaza
  // and kick off an OG-image fetch in the background. Other destinations get
  // a generic placeholder; the user can paste a booking URL to update.
  if (!planData.hotels.length) {
    const seedHotel = mockHotel(destination);
    planData.hotels = [seedHotel];
    if (seedHotel.source_url) {
      // Background OG fetch — same pattern as replace_hotel. Best-effort.
      (async () => {
        try {
          const og = await fetchOgMeta(seedHotel.source_url);
          if (!og) {
            return;
          }
          let changed = false;
          if (og.image_url && !seedHotel.image_url) {
            seedHotel.image_url = og.image_url;
            changed = true;
          }
          if (og.site_name && !seedHotel.site_name) {
            seedHotel.site_name = og.site_name;
            changed = true;
          }
          if (changed) {
            Services.prefs.setStringPref(
              "browser.smartwindow.tripPlanData",
              JSON.stringify(planData)
            );
            Services.obs.notifyObservers(null, "trip-plan-data-updated");
          }
        } catch (e) {
          lazy.console.warn("[Tool] mock-hotel OG fetch failed:", e);
        }
      })();
    }
  }

  // Mock budget breakdown using flights + hotel costs computed above.
  if (
    !Array.isArray(planData.bookings) ||
    !planData.bookings.length ||
    !Number(planData.budget_estimated) ||
    !Number(planData.budget_total)
  ) {
    const b = mockBudget(
      destination,
      planData.nights,
      planData.adults,
      planData.flights,
      planData.hotels
    );
    if (!planData.bookings.length) {
      planData.bookings = b.bookings;
    }
    if (!Number(planData.budget_estimated)) {
      planData.budget_estimated = b.estimated;
    }
    if (!Number(planData.budget_total)) {
      planData.budget_total = b.total;
    }
  }

  // Mock packing list keyed by destination + duration.
  if (
    !planData.packing ||
    typeof planData.packing !== "object" ||
    !Object.keys(planData.packing).length
  ) {
    planData.packing = mockPacking(destination, planData.nights);
  }

  planData.is_skeleton = false;

  try {
    Services.prefs.setStringPref(
      "browser.smartwindow.tripPlanData",
      JSON.stringify(planData)
    );
    Services.obs.notifyObservers(null, "trip-plan-data-updated");
  } catch (e) {
    lazy.console.error("[Tool] generateTravelPlan pref error:", e);
  }

  let openedPlanTab = null;
  let aiWindowTab = null;
  let groupedTravelTabs = [];
  try {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (win?.gBrowser) {
      const isAiWindowUrl = url =>
        url === "chrome://browser/content/aiwindow/aiWindow.html";
      const selected = win.gBrowser.selectedTab;
      const selectedUrl = selected.linkedBrowser?.currentURI?.spec || "";
      if (isAiWindowUrl(selectedUrl)) {
        aiWindowTab = selected;
      } else {
        for (const tab of win.gBrowser.tabs) {
          const url = tab.linkedBrowser?.currentURI?.spec || "";
          if (isAiWindowUrl(url)) {
            aiWindowTab = tab;
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
      openedPlanTab = planTab;
      // Open the plan tab front-and-center. No split view — the user sees
      // a single trip plan page with the conversation continuing in the
      // sidebar on the right.
      win.gBrowser.selectedTab = planTab;

      // Tab grouping: collect travel-related tabs by domain match + the plan
      // tab itself. Place them in a single colored group named after the trip.
      try {
        const TRAVEL_HINTS = [
          ...TRAVEL_DOMAIN_ALLOWLIST,
          destination.toLowerCase(),
        ];
        const matchesTravel = url => {
          if (!url) {
            return false;
          }
          const lower = url.toLowerCase();
          return TRAVEL_HINTS.some(h => lower.includes(h));
        };
        const travelTabs = [...win.gBrowser.tabs].filter(
          t =>
            t !== planTab &&
            t !== aiWindowTab &&
            !t.group &&
            !t.splitView &&
            matchesTravel(t.linkedBrowser?.currentURI?.spec)
        );
        const tabsToGroup = [...travelTabs];
        if (!planTab.group) {
          tabsToGroup.push(planTab);
        }
        if (tabsToGroup.length >= 2) {
          win.gBrowser.addTabGroup(tabsToGroup, {
            label: `Trip: ${destination}`,
            color: "blue",
          });
          groupedTravelTabs = travelTabs.map(
            t => t.linkedBrowser?.currentURI?.spec
          );
        }
      } catch (e) {
        lazy.console.error("[Tool] generateTravelPlan tab-group error:", e);
      }

      // Collapse the full-page AI Window into the sidebar so the chat
      // anchors next to the artifact, then CLOSE the now-redundant
      // full-page tab. Otherwise the user sees two chat surfaces
      // (the original full-page tab + the sidebar) and the plan tab feels
      // disconnected.
      try {
        if (aiWindowTab) {
          await lazy.AIWindow.moveConversationToSidebar(win, aiWindowTab);
          // Defer the tab close to next tick so the sidebar has a moment to
          // mount the conversation before the source tab is removed.
          win.setTimeout(() => {
            try {
              if (aiWindowTab.isConnected !== false) {
                win.gBrowser.removeTab(aiWindowTab, {
                  animate: false,
                  skipPermitUnload: true,
                });
              }
            } catch (e) {
              lazy.console.warn(
                "[Tool] generateTravelPlan: could not close full-page tab:",
                e
              );
            }
          }, 300);
        }
      } catch (e) {
        lazy.console.error("[Tool] generateTravelPlan sidebar switch:", e);
      }
    }
  } catch (e) {
    lazy.console.error("[Tool] generateTravelPlan tab open error:", e);
  }

  securityProperties.setPrivateData();
  lazy.console.log("[Tool] generateTravelPlan", {
    destination,
    is_skeleton: planData.is_skeleton,
    grouped: groupedTravelTabs.length,
    planTabOpened: !!openedPlanTab,
  });
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
    tabs: (() => {
      // Defense-in-depth de-dup by URL — even though getOpenTabs / proposeTabScope
      // already de-dup, this guards against future callers passing pre-merged
      // tab arrays.
      const seen = new Set();
      const out = [];
      for (const t of tabs) {
        const key = t.url || t.id;
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push({
          id: key,
          title: t.title,
          url: t.url,
          favicon: t.url ? `page-icon:${t.url}` : null,
        });
        if (out.length >= 10) {
          break;
        }
      }
      return out;
    })(),
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
  // Only enforce the trip_id check when BOTH sides have one. The chrome-page
  // (v0) plan has no trip_id, and the LLM may pass a stale id from prior
  // context — that's a no-op cross-check for a single active trip.
  if (params.trip_id && plan.trip_id && params.trip_id !== plan.trip_id) {
    return { error: "trip_id does not match the active trip." };
  }

  const diff = [];
  let mutatedPath = null;
  const { mutation_type: type, payload = {} } = params;

  switch (type) {
    case "swap_activity": {
      // Mutate BOTH shapes when present: v1 plan.days (in-chat artifact) and
      // v0 plan.itinerary (chrome trip-plan page). Either may be missing
      // depending on which surface created the plan.
      const v1Days = Array.isArray(plan.days) ? plan.days : [];
      const v0It = Array.isArray(plan.itinerary) ? plan.itinerary : [];
      const v1Idx = v1Days.findIndex(d => d.day === payload.day);
      const v0Idx = v0It.findIndex(d => d.day === payload.day);
      if (v1Idx === -1 && v0Idx === -1) {
        return { error: `Day ${payload.day} not found.` };
      }
      const newTitle = payload.new_title || payload.new_text || "";
      const newLocation = payload.new_location ?? "";
      const newNote = payload.new_note ?? "";
      let touched = false;
      if (v1Idx !== -1) {
        const day = v1Days[v1Idx];
        let actIdx = day.activities.findIndex(
          a => a.id === payload.activity_id
        );
        if (actIdx === -1 && payload.activity_index != null) {
          actIdx = payload.activity_index;
        }
        if (actIdx >= 0 && actIdx < day.activities.length) {
          const before = { ...day.activities[actIdx] };
          day.activities[actIdx] = {
            ...before,
            title: newTitle || before.title,
            location: newLocation || before.location,
          };
          diff.push({
            op: "replace",
            path: `days[${v1Idx}].activities[${actIdx}]`,
            value: day.activities[actIdx],
          });
          touched = true;
        }
      }
      if (v0Idx !== -1) {
        const day = v0It[v0Idx];
        let actIdx = -1;
        if (payload.activity_index != null) {
          actIdx = payload.activity_index;
        }
        if (actIdx === -1 && payload.activity_time) {
          actIdx = day.activities.findIndex(
            a =>
              String(a.time).toLowerCase() ===
              String(payload.activity_time).toLowerCase()
          );
        }
        if (actIdx === -1) {
          actIdx = 0;
        }
        if (actIdx >= 0 && actIdx < day.activities.length) {
          const before = { ...day.activities[actIdx] };
          day.activities[actIdx] = {
            ...before,
            text: newTitle || before.text,
            note: newNote || before.note,
          };
          diff.push({
            op: "replace",
            path: `itinerary[${v0Idx}].activities[${actIdx}]`,
            value: day.activities[actIdx],
          });
          touched = true;
        }
      }
      if (!touched) {
        return { error: "Activity not found." };
      }
      mutatedPath = { kind: "activity", day: payload.day };
      break;
    }
    case "replace_day": {
      // Full-day rebrand: replace title and/or all activities for a given day.
      // Used for asks like "swap day 1 to upper west side" or "make day 3 a
      // beach day". Writes to BOTH v0 itinerary and v1 days.
      const targetDay = Number(payload.day);
      if (!Number.isFinite(targetDay)) {
        return { error: "replace_day requires payload.day (integer)." };
      }
      const newTitle = payload.title || payload.theme || "";
      const newActsRaw = Array.isArray(payload.activities)
        ? payload.activities
        : [];
      if (!newTitle && !newActsRaw.length) {
        return { error: "replace_day requires title or activities." };
      }
      const v0Acts = newActsRaw.map(a => ({
        time: a.time || a.slot || "",
        text: a.text || a.title || "",
        note: a.note || "",
      }));
      const v1Acts = newActsRaw.map((a, i) => ({
        id: `d${targetDay}-a${i + 1}`,
        time: a.time || a.slot || "",
        title: a.text || a.title || "",
        location: a.location || "",
      }));
      let touched = false;
      const it = Array.isArray(plan.itinerary) ? plan.itinerary : [];
      const v0Idx = it.findIndex(d => d.day === targetDay);
      if (v0Idx !== -1) {
        if (newTitle) {
          it[v0Idx].title = newTitle;
        }
        if (v0Acts.length) {
          it[v0Idx].activities = v0Acts;
        }
        touched = true;
      }
      const days = Array.isArray(plan.days) ? plan.days : [];
      const v1Idx = days.findIndex(d => d.day === targetDay);
      if (v1Idx !== -1) {
        if (newTitle) {
          days[v1Idx].title = newTitle;
        }
        if (v1Acts.length) {
          days[v1Idx].activities = v1Acts;
        }
        touched = true;
      }
      if (!touched) {
        return { error: `Day ${targetDay} not found.` };
      }
      diff.push({ op: "replace", path: `day_${targetDay}`, value: { title: newTitle, activities: v0Acts } });
      mutatedPath = { kind: "day", day: targetDay };
      break;
    }
    case "replace_hotel": {
      // Apply the mutation IMMEDIATELY with whatever data we have; do NOT
      // block the LLM tool result on the OG fetch. Otherwise the chat
      // appears to hang for 3-6s while we scrape the booking site.
      const initialName = payload.name || "Hotel";
      const initialImage = payload.image_url || "";
      plan.hotel_slot = {
        filled: true,
        name: initialName,
        price: payload.price,
        check_in: payload.check_in,
        check_out: payload.check_out,
        source_url: payload.source_url,
        image_url: initialImage,
        site_name: "",
      };
      plan.hotels = [
        {
          name: initialName,
          check_in: payload.check_in || "",
          check_out: payload.check_out || "",
          address: payload.address || "",
          price_per_night: payload.price_per_night || "",
          total_price: payload.price || "",
          source_url: payload.source_url || "",
          image_url: initialImage,
          site_name: "",
        },
      ];
      diff.push({ op: "replace", path: "hotel_slot", value: plan.hotel_slot });
      diff.push({ op: "replace", path: "hotels", value: plan.hotels });
      mutatedPath = { kind: "hotel" };

      // Background enrichment: fetch OG metadata, then patch the live plan
      // and re-propagate. The chrome page observer picks up the second
      // pref write and re-renders with the image + canonical title.
      if (payload.source_url) {
        (async () => {
          try {
            const og = await fetchOgMeta(payload.source_url);
            if (!og) {
              return;
            }
            let changed = false;
            if (og.image_url && !plan.hotels[0].image_url) {
              plan.hotels[0].image_url = og.image_url;
              plan.hotel_slot.image_url = og.image_url;
              changed = true;
            }
            if (
              og.title &&
              (!payload.name || plan.hotels[0].name === "Hotel")
            ) {
              plan.hotels[0].name = og.title;
              plan.hotel_slot.name = og.title;
              changed = true;
            }
            if (og.site_name) {
              plan.hotels[0].site_name = og.site_name;
              plan.hotel_slot.site_name = og.site_name;
              changed = true;
            }
            if (changed) {
              Services.prefs.setStringPref(
                "browser.smartwindow.tripPlanData",
                JSON.stringify(plan)
              );
              Services.obs.notifyObservers(null, "trip-plan-data-updated");
            }
          } catch (e) {
            lazy.console.warn("[Tool] OG enrichment background failed:", e);
          }
        })();
      }
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
      // v0 chrome page renders from plan.flights[] — mirror the slot.
      plan.flights = [
        {
          carrier: payload.carrier || "",
          flight_no: payload.flight_no || "",
          depart: payload.depart || "",
          arrive: payload.arrive || "",
          price: payload.price || "",
          source_url: payload.source_url || "",
        },
      ];
      diff.push({ op: "replace", path: "flight_slot", value: plan.flight_slot });
      diff.push({ op: "replace", path: "flights", value: plan.flights });
      mutatedPath = { kind: "flight" };
      break;
    }
    case "clear_hotel": {
      plan.hotel_slot = { filled: false, placeholder: "Add a hotel" };
      plan.hotels = [];
      diff.push({ op: "replace", path: "hotel_slot", value: plan.hotel_slot });
      diff.push({ op: "replace", path: "hotels", value: plan.hotels });
      mutatedPath = { kind: "hotel" };
      break;
    }
    case "clear_flight": {
      plan.flight_slot = { filled: false, placeholder: "Pick a flight" };
      plan.flights = [];
      diff.push({ op: "replace", path: "flight_slot", value: plan.flight_slot });
      diff.push({ op: "replace", path: "flights", value: plan.flights });
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
  // Propagate to the chrome-page renderer (tripPlan.html). The page observes
  // "trip-plan-data-updated" and re-renders from the pref. Keeps the in-chat
  // artifact and the open chrome page in sync — single source of truth.
  try {
    Services.prefs.setStringPref(
      "browser.smartwindow.tripPlanData",
      JSON.stringify(plan)
    );
    Services.obs.notifyObservers(null, "trip-plan-data-updated");
  } catch (e) {
    lazy.console.warn("[Tool] mutateTrip propagation failed:", e);
  }
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

/**
 * lookup_lodging_history: search local Places for lodging-domain pages the user
 * viewed in the last N days. Used by the LLM when the user mentions where
 * they're staying. Local-only, no network.
 *
 * @param {object} toolParams
 * @returns {Promise<object>}
 */
export async function lookupLodgingHistory(toolParams) {
  const params = toolParams && typeof toolParams === "object" ? toolParams : {};
  try {
    const result = await lazy.HistoryQuery.lookupLodging({
      keyword: typeof params.keyword === "string" ? params.keyword : "",
      destination:
        typeof params.destination === "string" ? params.destination : "",
      days: Number(params.days) || 30,
      limit: 5,
    });
    return result;
  } catch (e) {
    lazy.console.error("[Tool] lookupLodgingHistory error:", e);
    return {
      matches: [],
      domain_filter: [],
      message: "Lookup failed — share the booking URL?",
    };
  }
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
  lookupLodgingHistory,
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

// Local-edit observer: lets the AI Window content (sidebar) trigger a trip
// mutation without going through the LLM. The content side notifies via
// Services.obs with topic "smartwindow-trip-edit" and an nsISupportsString
// JSON payload of the same shape mutate_trip expects. We hydrate a minimal
// conversation context from the live tripPlanData pref so mutateTrip can
// run in the chrome process.
let _tripEditObserverRegistered = false;
function registerTripEditObserver() {
  if (_tripEditObserverRegistered) {
    return;
  }
  const observer = {
    observe(subject, topic) {
      if (topic !== "smartwindow-trip-edit") {
        return;
      }
      let params;
      try {
        const data = subject.QueryInterface(Ci.nsISupportsString).data;
        params = JSON.parse(data);
      } catch (e) {
        lazy.console.warn("[TripEdit] bad subject:", e);
        return;
      }
      const pref = Services.prefs.getStringPref(
        "browser.smartwindow.tripPlanData",
        ""
      );
      if (!pref) {
        return;
      }
      let plan;
      try {
        plan = JSON.parse(pref);
      } catch {
        return;
      }
      const conv = {
        _tripPlanV1: plan,
        securityProperties: { setPrivateData() {} },
      };
      mutateTrip(params, conv).catch(e =>
        lazy.console.warn("[TripEdit] mutateTrip failed:", e)
      );
    },
  };
  try {
    Services.obs.addObserver(observer, "smartwindow-trip-edit");
    _tripEditObserverRegistered = true;
  } catch (e) {
    lazy.console.warn("[TripEdit] observer registration failed:", e);
  }
}
try {
  registerTripEditObserver();
} catch (_) {}
