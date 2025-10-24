/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

import { createEngine } from "chrome://global/content/ml/EngineProcess.sys.mjs";
import { SmartAssistEngine } from "moz-src:///browser/components/genai/SmartAssistEngine.sys.mjs";

const { ChatHistoryMessage } = ChromeUtils.importESModule(
  "resource:///modules/smartwindow/ChatHistory.sys.mjs"
);

/**
 * Detects the type of query based on patterns in the text.
 * Uses navigate heuristics for URLs/domains, then ML model for chat/search classification.
 *
 * @param {string} query - The query string to analyze
 * @returns {Promise<string>} The detected query type: "navigate", "chat", "action", or "search"
 */
export async function detectQueryType(query) {
  const trimmedQuery = query.trim().toLowerCase();

  // navigate heuristics (protocols or domain without spaces)
  if (
    (/^(about|https?):/.test(trimmedQuery) ||
      /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(
        trimmedQuery.replace(/^https?:\/\//, "")
      )) &&
    !trimmedQuery.includes(" ")
  ) {
    return "navigate";
  }

  // Use ML model for chat vs search classification
  try {
    return await SmartAssistEngine.getPromptIntent(query);
  } catch (error) {
    console.error("Error using intent detection model:", error);
    return "search";
  }
}

/**
 * Creates an OpenAI engine instance configured with Smart Window preferences.
 *
 * @param engineId
 * @returns {Promise<object>} The configured engine instance
 */
export async function createOpenAIEngine(engineId = "smart-openai") {
  try {
    const engineInstance = await createEngine({
      apiKey: Services.prefs.getStringPref("browser.smartwindow.key"),
      backend: "openai",
      baseURL: Services.prefs.getStringPref("browser.smartwindow.endpoint"),
      engineId,
      modelId: Services.prefs.getStringPref("browser.smartwindow.model"),
      modelRevision: "main",
      taskName: "text-generation",
    });
    return engineInstance;
  } catch (error) {
    console.error("Failed to create OpenAI engine:", error);
    throw error;
  }
}

const SEARCH_OPEN_TABS = "search_open_tabs";
const GET_PAGE_CONTENT = "get_page_content";
const SEARCH_HISTORY = "search_history";

const TOOLS = [SEARCH_OPEN_TABS, GET_PAGE_CONTENT, SEARCH_HISTORY];

const toolsConfig = [
  {
    type: "function",
    function: {
      name: SEARCH_OPEN_TABS,
      description:
        "Search through the user's currently open browser tabs to find tabs related to a specific topic, category, or content type. This is useful when the user wants to find tabs about a particular subject they have open. Returns a list of all open tabs with their titles and URLs, along with the search query for context.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "The category, topic, or type of content to search for in open tabs. Examples: 'news', 'documentation', 'shopping', 'social media', 'work', 'entertainment', 'programming', 'research'. Be specific but broad enough to match relevant tabs.",
          },
        },
        required: ["type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: GET_PAGE_CONTENT,
      description:
        "Retrieve the text content from a specific browser tab by its URL. Use this when you need to read, analyze, or reference the actual content of a webpage that the user has mentioned or that appears in their open tabs. The content is cleaned and structured for easy analysis.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The complete URL of the tab to fetch content from. This must exactly match a URL from the user's open tabs. Use the full URL including protocol (http/https). Example: 'https://www.example.com/article'",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: SEARCH_HISTORY,
      description:
        "Search the user's browser history to find previously visited pages related to specific keywords or topics. This helps find relevant pages the user has visited before, even if they're not currently open. Returns pages ranked by relevance and visit frequency.",
      parameters: {
        type: "object",
        properties: {
          search_term: {
            type: "string",
            description:
              "Keywords or phrases to search for in page titles and URLs from browser history. Use specific terms that are likely to appear in page titles. Examples: 'python tutorial', 'react documentation', 'news climate change', 'github repository'",
          },
        },
        required: ["search_term"],
      },
    },
  },
];

const search_browser_history = async ({ search_term, limit = 10 }) => {
  let root;
  let openedRoot = false;

  try {
    const currentHistory = lazy.PlacesUtils.history;
    const query = currentHistory.getNewQuery();
    const opts = currentHistory.getNewQueryOptions();

    // Use Places' built-in text filtering
    query.searchTerms = search_term;

    // Simple URI results, ranked by frecency
    opts.resultType = Ci.nsINavHistoryQueryOptions.RESULTS_AS_URI;
    opts.sortingMode = Ci.nsINavHistoryQueryOptions.SORT_BY_FRECENCY_DESCENDING;
    opts.maxResults = limit;
    opts.excludeQueries = false;
    opts.queryType = Ci.nsINavHistoryQueryOptions.QUERY_TYPE_HISTORY;

    const result = currentHistory.executeQuery(query, opts);
    root = result.root;

    if (!root.containerOpen) {
      root.containerOpen = true;
      openedRoot = true;
    }

    const rows = [];
    for (let i = 0; i < root.childCount && rows.length < limit; i++) {
      const node = root.getChild(i);
      const lastVisit = lazy.PlacesUtils.toDate(node.time);
      const visitDate = lastVisit.toLocaleDateString();
      rows.push({
        title: node.title || node.uri,
        url: node.uri,
        visitDate,
        visitCount: node.accessCount || 0,
      });
    }

    if (rows.length === 0) {
      return `No browser history found for "${search_term}".`;
    }

    const historyList = rows
      .map(
        (item, index) =>
          `${index + 1}. "${item.title}" at ${item.url} (visited ${item.visitCount} times, last on ${item.visitDate})`
      )
      .join("\n");

    return `Found ${rows.length} history entries for "${search_term}":

${historyList}`;
  } catch (error) {
    console.error("Error searching browser history:", error);
    return `Error searching browser history for "${search_term}": ${error.message}`;
  } finally {
    if (root && openedRoot) {
      root.containerOpen = false;
    }
  }
};

const search_open_tabs = ({ type }) => {
  console.log("Searching open tabs for type:", type);
  let win = lazy.BrowserWindowTracker.getTopWindow();
  let gBrowser = win.gBrowser;
  let tabs = gBrowser.tabs;

  if (tabs.length === 0) {
    return `No open tabs found.`;
  }

  const tabList = tabs
    .map(
      (tab, index) =>
        `${index + 1}. "${tab.label}" at ${tab.linkedBrowser.currentURI.spec}`
    )
    .join("\n");

  return `Found ${tabs.length} open tabs (searching for ${type}):

${tabList}`;
};

const get_page_content = async ({ url }) => {
  try {
    let win = lazy.BrowserWindowTracker.getTopWindow();
    let gBrowser = win.gBrowser;
    let tabs = gBrowser.tabs;

    // Find the tab with the matching URL (try exact match first, then flexible matching)
    let targetTab = tabs.find(tab => {
      const tabUrl = tab.linkedBrowser.currentURI.spec;
      return tabUrl === url;
    });

    // If no exact match, try more flexible matching
    if (!targetTab) {
      targetTab = tabs.find(tab => {
        const tabUrl = tab.linkedBrowser.currentURI.spec;
        // Remove trailing slashes and compare
        const normalizedTabUrl = tabUrl.replace(/\/$/, "");
        const normalizedInputUrl = url.replace(/\/$/, "");
        return normalizedTabUrl === normalizedInputUrl;
      });
    }

    // If still no match, try hostname matching for cases where protocols differ
    if (!targetTab) {
      try {
        const inputHostname = new URL(url).hostname;
        targetTab = tabs.find(tab => {
          try {
            const tabUrl = tab.linkedBrowser.currentURI.spec;
            const tabHostname = new URL(tabUrl).hostname;
            return tabHostname === inputHostname;
          } catch {
            return false;
          }
        });
      } catch {
        // Invalid URL, continue with original logic
      }
    }

    if (!targetTab) {
      const availableUrls = tabs
        .slice(0, 3)
        .map(tab => `"${tab.label}" at ${tab.linkedBrowser.currentURI.spec}`)
        .join(", ");
      return `No tab found with URL: ${url}. Available tabs include: ${availableUrls}`;
    }

    // Get the browser for the target tab
    const selectedBrowser = targetTab.linkedBrowser;

    // Check if browsing context is available
    if (!selectedBrowser.browsingContext?.currentWindowContext) {
      return `Cannot access content from "${targetTab.label}" at ${url}. The tab may still be loading or is not accessible.`;
    }

    // Extract page content using PageExtractor
    const pageExtractor =
      await selectedBrowser.browsingContext.currentWindowContext.getActor(
        "PageExtractor"
      );

    // Try reader mode content first, then fall back to text content
    let pageContent = await pageExtractor.getReaderModeContent();
    if (!pageContent) {
      pageContent = await pageExtractor.getText();
    }

    if (!pageContent) {
      return `No readable content found on "${targetTab.label}" at ${url}. The page may be empty or contain mostly media content.`;
    }

    // Clean and truncate content for better LLM consumption
    let cleanContent = pageContent
      .replace(/\s+/g, " ") // Normalize whitespace
      .replace(/\n\s*\n/g, "\n") // Clean up line breaks
      .trim();

    // Limit content length but be more generous for LLM processing
    if (cleanContent.length > 2000) {
      // Try to cut at a sentence boundary
      const truncatePoint = cleanContent.lastIndexOf(".", 2000);
      if (truncatePoint > 1500) {
        cleanContent = cleanContent.substring(0, truncatePoint + 1);
      } else {
        cleanContent = cleanContent.substring(0, 2000) + "...";
      }
    }

    return `Content from "${targetTab.label}" (${url}):

${cleanContent}`;
  } catch (error) {
    return `Error retrieving content from ${url}: ${error.message}. Try refreshing the tab or checking if it's accessible.`;
  }
};

/**
 * Fetches a response from the OpenAI engine with message history.
 *
 * @param {Array} messages - Array of message objects with role and content
 * @returns {AsyncGenerator<string>} Stream of response chunks this can be a string or a tool call log object
 * @yields {string}
 */

export async function* fetchWithHistory(messages) {
  const engineInstance = await createOpenAIEngine();

  // Normalize roles to lowercase and handle system messages
  let convo = Array.isArray(messages)
    ? messages.map(msg => ({
        ...msg,
        role: ChatHistoryMessage.getRoleLabel(msg.role).toLowerCase(), // Convert "System" -> "system"
      }))
    : [];

  // Determine if we should require tool usage based on the user's query
  function shouldRequireTools(messages) {
    const lastUserMessage = messages.filter(m => m.role === "user").pop();
    if (!lastUserMessage) {
      return false;
    }

    const content = lastUserMessage.content.toLowerCase();

    // Keywords that strongly suggest tool usage is needed
    const toolKeywords = [
      "browser history",
      "history about",
      "visited",
      "browsing history",
      "open tab",
      "current tab",
      "tabs open",
      "what tabs",
      "page content",
      "what does",
      "content of",
      "read the",
      "search my",
      "find in my",
      "check my",
      "look at my",
    ];

    return toolKeywords.some(keyword => content.includes(keyword));
  }

  const shouldUseTools = shouldRequireTools(convo);
  console.warn(
    "[Tool Detection]",
    shouldUseTools ? "SHOULD use tools" : "auto",
    "for query:",
    convo[convo.length - 1]?.content?.substring(0, 100)
  );

  // Helper to run the model once (streaming) on current convo
  const streamModelResponse = () =>
    engineInstance.runWithGenerator({
      streamOptions: { enabled: true },
      tool_choice: "auto",
      tools: toolsConfig,
      args: convo,
    });

  // Keep calling until the model finishes without requesting tools
  while (true) {
    let pendingToolCalls = null;

    // 1) First pass: stream tokens; capture any toolCalls
    for await (const chunk of streamModelResponse()) {
      // Stream assistant text to the UI
      if (chunk?.text) {
        yield chunk.text;
      }

      // Capture tool calls (do not echo raw tool plumbing to the user)
      if (chunk?.toolCalls?.length) {
        pendingToolCalls = chunk.toolCalls;
      }
    }

    // 2) Watch for tool calls; if none, we are done
    if (!pendingToolCalls || pendingToolCalls.length === 0) {
      return;
    }

    // 3) Build the assistant tool_calls message exactly as expected by the API
    const assistantToolMsg = {
      role: "assistant",
      tool_calls: pendingToolCalls.map(toolCall => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      })),
    };

    // 4) Execute each tool locally and create a tool message with the result
    const toolResultMessages = [];
    for (const toolCall of pendingToolCalls) {
      const { id, function: functionSpec } = toolCall;
      const toolName = functionSpec?.name || "";
      let toolParams = {};

      try {
        toolParams = functionSpec?.arguments
          ? JSON.parse(functionSpec.arguments)
          : {};
      } catch {
        toolResultMessages.push({
          role: "tool",
          tool_call_id: id,
          content: JSON.stringify({ error: "Invalid JSON arguments" }),
        });
        continue;
      }

      let result;
      try {
        if (!TOOLS.includes(toolName)) {
          result = { error: `There is no tool called : ${String(toolName)}` };
        }

        switch (toolName) {
          case SEARCH_OPEN_TABS:
            result = search_open_tabs(toolParams);
            break;
          case GET_PAGE_CONTENT:
            result = await get_page_content(toolParams);
            break;
          case SEARCH_HISTORY:
            result = await search_browser_history(toolParams);
            break;
        }

        // Create special tool call log message to show in the UI log panel
        const assistantToolCallLogMsg = {
          role: "assistant",
          content: `Tool Call: ${toolName} with parameters: ${JSON.stringify(
            toolParams
          )}`,
          type: "tool_call_log",
          result,
        };
        yield assistantToolCallLogMsg;
      } catch (e) {
        result = { error: `Tool execution failed: ${String(e)}` };
      }

      toolResultMessages.push({
        role: "tool",
        tool_call_id: id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }

    convo = [...convo, assistantToolMsg, ...toolResultMessages];
  }
}

/**
 * Sends a single prompt to the OpenAI engine and returns the response.
 *
 * @param {string} content - The user prompt
 * @param {Array} previousMessages - Optional previous conversation messages
 * @returns {Promise<string>} The AI response
 */
export async function sendPrompt(content, previousMessages = []) {
  const messages = [...previousMessages, { role: "user", content }];

  const stream = fetchWithHistory(messages);
  let response = "";

  try {
    for await (const chunk of stream) {
      response += chunk;
    }
    return response;
  } catch (error) {
    console.error("Error sending prompt:", error);
    return "Error: Failed to get response from AI service.";
  }
}
