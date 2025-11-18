/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-disable no-console */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PageThumbs: "resource://gre/modules/PageThumbs.sys.mjs",
  PageThumbsStorage: "resource://gre/modules/PageThumbs.sys.mjs",
  getPlacesSemanticHistoryManager: "resource://gre/modules/PlacesSemanticHistoryManager.sys.mjs",
});

import { createEngine } from "chrome://global/content/ml/EngineProcess.sys.mjs";
import { SmartAssistEngine } from "moz-src:///browser/components/genai/SmartAssistEngine.sys.mjs";

const { ChatHistoryMessage } = ChromeUtils.importESModule(
  "resource:///modules/smartwindow/ChatHistory.sys.mjs"
);

const { PageExtractorParent } = ChromeUtils.importESModule(
  "resource://gre/actors/PageExtractorParent.sys.mjs"
);

/**
 * Detects the type of query based on patterns in the text.
 * Uses navigate heuristics for URLs/domains, then ML model for chat/search classification.
 *
 * @param {string} query - The query string to analyze
 * @param {boolean} isFollowup - Whether this is a followup in an existing conversation
 * @returns {Promise<string>} The detected query type: "navigate", "chat", "action", or "search"
 */
export async function detectQueryType(query, isFollowup = false) {
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

  // If this is a followup in an existing conversation, default to chat
  if (isFollowup) {
    return "chat";
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
const FLAG_ADD_INSIGHT = "flag_add_insight";

const TOOLS = [
  SEARCH_OPEN_TABS,
  GET_PAGE_CONTENT,
  SEARCH_HISTORY,
  FLAG_ADD_INSIGHT
];

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
        "Retrieve text from a specific browser tab. Choose whether to read the current viewport, Reader Mode, or full page content. The content is cleaned for analysis.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "The complete URL of the tab to fetch content from. This must exactly match a URL from the user's open tabs. Use the full URL including protocol (http/https). Example: 'https://www.example.com/article'",
          },
          mode: {
            type: "string",
            enum: ["viewport", "reader", "full"],
            description:
              "Extraction mode to use. Choose viewport for what is visible, reader for distilled content, or full for entire page. Defaults to viewport.",
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
        "Search the user's browser history stored in sqlite-vec using an embedding model. If a search term is provided, performs vector search and ranks by semantic distance with frecency tie-breaks. If no search term is provided, returns the most relevant pages within a time window ranked by recency and frecency. Supports optional time range filtering using ISO 8601 datetime strings. This is to find previously visited pages related to specific keywords or topics. This helps find relevant pages the user has visited before, even if they're not currently open. All datetime must be before the user's current datetime. For parsing time window from dates and holidays, must depend on the user's current datetime, timezone, and locale.",
      parameters: {
        type: "object",
        properties: {
          search_term: {
            type: "string",
            description:
              "A detailed, noun-heavy phrase (~5-12 meaningful tokens) summarizing the user's intent for semantic retrieval. Include the main entity/topic plus 1–3 contextual qualifiers (e.g., library name, purpose, site, or timeframe). Avoid vague or single-word queries.",
          },
          "start_ts": {
            "type": ["string", "null"],
            "description": "Inclusive lower bound of the time window as an ISO 8601 datetime string (e.g., '2025-11-07T09:00:00-05:00'). Use when the user asks for results within a time or range start, such as 'last week', 'since yesterday', or 'last night'. This must be before the user's current datetime.",
            "default": null
          },
          "end_ts": {
            "type": ["string", "null"],
            "description": "Inclusive upper bound of the time window as an ISO 8601 datetime string (e.g., '2025-11-07T21:00:00-05:00'). Use when the user asks for results within a time or range end, such as 'last week', 'between 2025-10-01 and 2025-10-31', or 'before Monday'. This must be before the user's current datetime.",
            "default": null
          }
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: FLAG_ADD_INSIGHT,
      description:
        "Flags that the current user message indicates an insight should be added, but does not add the insight directly.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "The user message that indicates an insight should be added.",
          },
        },
        required: ["message"],
      },
    }
  }
];

export async function searchBrowserHistory({ search_term = "", start_ts = null, end_ts = null, limit = 10 }) {

  console.warn("[searchBrowserHistory]", "search_term:", search_term, "limit:", limit, "(hard limit for pre coarse search is 100)");
  console.warn("[searchBrowserHistory]", "start_ts ISO:", start_ts, "end_ts ISO:", end_ts);

  let results;

  try {

    const isoToMicroseconds = iso => iso ? new Date(iso).getTime() * 1000 : null;
    start_ts = isoToMicroseconds(start_ts);
    end_ts = isoToMicroseconds(end_ts);

    const distanceThreshold = Services.prefs.getFloatPref(
      "places.semanticHistory.distanceThreshold",
      0.6
    );
    const semanticManager = lazy.getPlacesSemanticHistoryManager({
      rowLimit: 10000,
      samplingAttrib: "frecency",
      changeThresholdCount: 3,
      distanceThreshold,
    });

    const rows = [];
    if (semanticManager.canUseSemanticSearch && (await semanticManager.hasSufficientEntriesForSearching())) {

      await semanticManager.embedder.ensureEngine();

      // handle case without search_term, time range query with no semantic
      if (!search_term || !search_term.trim()) {
        let conn = await semanticManager.getConnection();
        results = await conn.executeCached(
          `
            SELECT id,
                   title,
                   url,
                   NULL AS distance,
                   frecency,
                   last_visit_date,
                   preview_image_url
            FROM moz_places
            WHERE frecency <> 0
            AND (:start_ts IS NULL OR last_visit_date >= :start_ts)
            AND (:end_ts IS NULL OR last_visit_date <= :end_ts)
            ORDER BY last_visit_date DESC, frecency DESC
            LIMIT :limit
          `,
          {
            start_ts: start_ts,
            end_ts: end_ts,
            limit: limit,
          }
        );
      } else {
        let tensor = await semanticManager.embedder.embed(search_term);
        let vec = null;

        // It may be a { metrics, output } object.
        if (tensor.output) {
          if (Array.isArray(tensor.output) && (Array.isArray(tensor.output[0]) || ArrayBuffer.isView(tensor.output[0]))) {
            vec = tensor.output[0];
          } else {
            vec = tensor.output
          }
        } else {
          // It may be a nested array, then we must extract it first.
          if (
            Array.isArray(tensor) &&
            tensor.length === 1 &&
            Array.isArray(tensor[0])
          ) {
            tensor = tensor[0];
          }

          // Then we check if it's an array of arrays or just a single value.
          if (Array.isArray(tensor) && (Array.isArray(tensor[0]) || ArrayBuffer.isView(tensor[0]))) {
            vec = tensor[0];
          } else {
            vec = tensor;
          }
        }

        const vector = lazy.PlacesUtils.tensorToSQLBindable(vec);
        let conn = await semanticManager.getConnection();
        results = await conn.executeCached(
          `
          WITH coarse_matches AS (
            SELECT rowid,
                   embedding
            FROM vec_history
            WHERE embedding_coarse match vec_quantize_binary(:vector)
            ORDER BY distance
            LIMIT 100
          ),
          matches AS (
            SELECT url_hash, vec_distance_cosine(embedding, :vector) AS distance
            FROM vec_history_mapping
            JOIN coarse_matches USING (rowid)
            WHERE distance <= :distanceThreshold
            ORDER BY distance
            LIMIT :limit
          )
          SELECT id,
                 title,
                 url,
                 distance,
                 frecency,
                 last_visit_date,
                 preview_image_url
          FROM moz_places
          JOIN matches USING (url_hash)
          WHERE frecency <> 0
          AND (:start_ts IS NULL OR last_visit_date >= :start_ts)
          AND (:end_ts IS NULL OR last_visit_date <= :end_ts)
          ORDER BY distance
          `,
          {
            vector: vector,
            distanceThreshold: distanceThreshold,
            limit: limit,
            start_ts: start_ts,
            end_ts: end_ts,
          }
        );
      }

      for (let row of results) {
        const title = row.getResultByName("title");
        const url = row.getResultByName("url");
        const lastVisit = row.getResultByName("last_visit_date");
        const relevanceScore = 1 - row.getResultByName("distance");
        const previewImageURL = row.getResultByName("preview_image_url");

        rows.push({
          title: title || url,
          url: url,
          visitDate: new Date(Math.round(lastVisit / 1000)).toISOString(), // ISO timestamp format
          visitCount: 0,
          relevanceScore: relevanceScore || 0, // Use frecency as relevance score
          ...(previewImageURL && { thumbnail: previewImageURL }), // Only include thumbnail if available
        });
      }

      if (rows.length === 0) {
        return JSON.stringify({
          search_term,
          results: [],
          message: `No browser history found for "${search_term}".`,
        });
      }

      // Return as JSON string with metadata
      return JSON.stringify({
        search_term,
        count: rows.length,
        results: rows,
      });

    }

  } catch (error) {
    console.error("Error searching browser history:", error);
    return JSON.stringify({
      search_term,
      error: `Error searching browser history: ${error.message}`,
      results: [],
    });
  } finally {

  }
}

async function flagAddInsight({ message }) {
  console.log("Flagging message as likely insight source:", message);
  return true;
}

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

const MODE_HANDLERS = {
  viewport: async pageExtractor => {
    const result = await pageExtractor.getText({ justViewport: true });
    return { text: result.text };
  },
  reader: async pageExtractor => {
    const text = await pageExtractor.getReaderModeContent();
    return { text: typeof text === "string" ? text : "" };
  },
  full: async pageExtractor => {
    const result = await pageExtractor.getText();
    return { text: result.text };
  },
};

const DEFAULT_MODE = "viewport";

/**
 * @param {object} toolParams
 * @param {string} toolParams.url
 * @param {string} toolParams.mode
 * @param {Set<string>} allowedUrls
 */
const get_page_content = async ({ url, mode }, allowedUrls) => {
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
      // Search through the allowed URLs, and extract content headlessy.
      if (!allowedUrls.has(url)) {
        const availableUrls = tabs
          .slice(0, 3)
          .map(tab => `"${tab.label}" at ${tab.linkedBrowser.currentURI.spec}`)
          .join(", ");
        return `No tab found with URL: ${url}. Available tabs include: ${availableUrls}`;
      }

      // This will load the page headlessly, and then extract the content. It might
      // be a better idea to have the lifetime of the page be tied to the chat while
      // it's open, and with a "keep alive" timeout. For now it's simpler to just
      // load the page fresh every time.
      return PageExtractorParent.getHeadlessExtractor(url, pageExtractor =>
        runExtraction(pageExtractor, mode, url)
      );
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

    return runExtraction(pageExtractor, mode, `"${targetTab.label}" (${url})`);
  } catch (error) {
    return `Error retrieving content from ${url}: ${error.message}. Try refreshing the tab or checking if it's accessible.`;
  }
};

/**
 * @param {PageExtractor} pageExtractor
 * @param {string} mode
 * @param {string} label
 */
async function runExtraction(pageExtractor, mode, label) {
  const selectedMode =
    typeof mode === "string" && MODE_HANDLERS[mode] ? mode : DEFAULT_MODE;
  const handler = MODE_HANDLERS[selectedMode];
  let extraction = null;

  try {
    extraction = await handler(pageExtractor);
  } catch (err) {
    console.warn(
      "[SmartWindow] get_page_content mode failed",
      selectedMode,
      err
    );
  }

  const extractedText =
    typeof extraction === "string"
      ? extraction
      : typeof extraction?.text === "string"
        ? extraction.text
        : "";
  const pageContent = extractedText.trim();

  if (!pageContent) {
    return `get_page_content(${selectedMode}) returned no content for ${label}. Try another mode if you still need information.`;
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

  const modeLabels = {
    viewport: "current viewport",
    reader: "reader mode",
    full: "full page",
  };
  const modeLabel = modeLabels[selectedMode] || "selected mode";

  return `Content (${modeLabel}) from ${label}:

${cleanContent}`;
}

/**
 * Fetches a response from the OpenAI engine with message history.
 *
 * @param {Array} messages - Array of message objects with role and content
 * @param {Set<string>} allowedUrls - URLs that the user has explicitly added to the conversation.
 * @returns {AsyncGenerator<string>} Stream of response chunks this can be a string or a tool call log object
 * @yields {string}
 */
export async function* fetchWithHistory(messages, allowedUrls) {
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
      "suggest me",
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
            result = await get_page_content(toolParams, allowedUrls);
            break;
          case SEARCH_HISTORY:
            result = await searchBrowserHistory(toolParams);
            break;
          case FLAG_ADD_INSIGHT: {
            result = await flagAddInsight(toolParams);
            break;
          }
        }

        // Create special tool call log message to show in the UI log panel
        const assistantToolCallLogMsg = {
          role: "assistant",
          content: `Tool Call: ${toolName} with parameters: ${JSON.stringify(
            toolParams
          )}`,
          type: "tool_call_log",
          tool: toolName,
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

  const stream = fetchWithHistory(messages, new Set());
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
