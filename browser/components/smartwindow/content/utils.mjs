/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

import { createEngine } from "chrome://global/content/ml/EngineProcess.sys.mjs";
import { SmartAssistEngine } from "moz-src:///browser/components/genai/SmartAssistEngine.sys.mjs";

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
 * @returns {Promise<object>} The configured engine instance
 */
export async function createOpenAIEngine() {
  try {
    const engineInstance = await createEngine({
      apiKey: Services.prefs.getStringPref("browser.smartwindow.key"),
      backend: "openai",
      baseURL: Services.prefs.getStringPref("browser.smartwindow.endpoint"),
      engineId: "smart-openai",
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
const TOOLS = [SEARCH_OPEN_TABS];

const toolsConfig = [
  {
    type: "function",
    function: {
      name: SEARCH_OPEN_TABS,
      description:
        "Searches the user's open tabs for tabs that match the given type",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "the type of tabs I am looking for ie news, sports, etc",
          },
        },
        required: ["type"],
      },
    },
  },
];

const search_open_tabs = ({ type }) => {
  let win = lazy.BrowserWindowTracker.getTopWindow();
  let gBrowser = win.gBrowser;
  let tabs = gBrowser.tabs;
  const tabData = tabs.map(tab => {
    return {
      title: tab.label,
      url: tab.linkedBrowser.currentURI.spec,
    };
  });

  return {
    query: type,
    allTabs: tabData,
  };
};

/**
 * Fetches a response from the OpenAI engine with message history.
 *
 * @param {Array} messages - Array of message objects with role and content
 * @returns {AsyncGenerator<string>} Stream of response chunks this can be a string or a tool call log object
 */

export async function* fetchWithHistory(messages) {
  const engineInstance = await createOpenAIEngine();

  // Normalize roles to lowercase and handle system messages
  let convo = Array.isArray(messages)
    ? messages.map(msg => ({
        ...msg,
        role: msg.role.toLowerCase(), // Convert "System" -> "system"
      }))
    : [];

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

        // Call the appropriate tool by name
        if (toolName === SEARCH_OPEN_TABS) {
          // Setting this pattern so that we can pass additional argument like context
          // into the tool function with the params coming from the model
          result = search_open_tabs(toolParams);
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

/**
 * Generates intelligent quick prompts based on tab context using AI.
 *
 * @param {Array} contextTabs - Array of tab objects with title, url, and content
 * @returns {Promise<Array>} Array of suggestion objects with text and type
 */
export async function generateSmartQuickPrompts(contextTabs = []) {
  try {
    console.log(
      "Generating smart quick prompts with AI...",
      contextTabs,
      Error().stack
    );
    // Build context from tabs
    let tabContext = "";
    if (contextTabs.length === 0) {
      tabContext = "No tabs are selected for context.";
    } else if (contextTabs.length === 1) {
      const tab = contextTabs[0];
      tabContext = `Current tab: "${tab.title}" at ${tab.url}`;
    } else {
      tabContext = `Multiple tabs selected (${contextTabs.length}):\n`;
      contextTabs.forEach((tab, i) => {
        tabContext += `${i + 1}. "${tab.title}" at ${tab.url}\n`;
      });
    }

    const prompt = `Based on the following browser tab context, generate 8 intelligent quick prompts that would be useful to a user. Return ONLY a JSON array with objects containing "text" and "type" fields.

Tab context:
${tabContext}

Generate a mix of:
- 3-4 "chat" prompts: Questions or requests for analysis/explanation about the content (end with ? or ask for summaries, comparisons, explanations)
- 2-3 "search" prompts: Search queries to find related information (specific topics, guides, tutorials)
- 1-2 "navigate" prompts: Useful websites or domains related to the content (just domain names or short URLs)

Make the prompts specific and contextually relevant. For chat prompts, focus on understanding, comparing, or analyzing the content. For search prompts, focus on finding related resources or deeper information. For navigate prompts, suggest relevant websites.

Example format:
[
  {"text": "What are the main concepts in this article?", "type": "chat"},
  {"text": "machine learning tutorials", "type": "search"},
  {"text": "stackoverflow.com", "type": "navigate"}
]

Return only the JSON array, no other text:`;

    const response = await sendPrompt(prompt);

    // Try to parse the JSON response
    try {
      const cleanedResponse = response
        .trim()
        .replace(/^```json\s*/, "")
        .replace(/\s*```$/, "");
      const suggestions = JSON.parse(cleanedResponse);

      // Validate the structure
      if (Array.isArray(suggestions) && suggestions.length) {
        const validSuggestions = suggestions.filter(
          s =>
            s.text &&
            s.type &&
            ["chat", "search", "navigate", "action"].includes(s.type)
        );

        if (validSuggestions.length) {
          return validSuggestions.slice(0, 8); // Limit to 8 suggestions
        }
      }
    } catch (parseError) {
      console.error("Failed to parse AI response as JSON:", parseError);
    }

    // Fallback to static prompts if AI response is invalid
    return generateFallbackPrompts(contextTabs);
  } catch (error) {
    console.error("Error generating smart quick prompts:", error);
    return generateFallbackPrompts(contextTabs);
  }
}

/**
 * Generates fallback prompts when AI is unavailable or fails.
 *
 * @param {Array} contextTabs - Array of tab objects
 * @returns {Array} Array of fallback suggestion objects
 */
function generateFallbackPrompts(contextTabs = []) {
  const suggestions = [];

  if (contextTabs.length > 1) {
    // Multi-tab context prompts
    const tabTitles = contextTabs
      .map(tab => tab.title)
      .filter(title => title && title !== "Untitled");
    const uniqueTitles = [...new Set(tabTitles)].slice(0, 3);

    if (uniqueTitles.length) {
      const topics = uniqueTitles.join(", ");
      suggestions.push(
        { text: `Compare ${topics}`, type: "chat" },
        { text: `What do ${topics} have in common?`, type: "chat" }
      );
    }

    suggestions.push(
      { text: `research across ${contextTabs.length} tabs`, type: "search" },
      { text: `summarize content from selected tabs`, type: "chat" }
    );
  } else {
    // Single tab context
    const tabTitle = contextTabs[0]?.title || "";
    const titleWords = tabTitle
      .split(/\s+/)
      .filter(word => word.length > 2)
      .slice(0, 3);
    const topic = titleWords.join(" ") || "this";

    suggestions.push(
      { text: `What is ${topic} about?`, type: "chat" },
      { text: `How does ${topic} work?`, type: "chat" },
      { text: `${topic} guide`, type: "search" },
      { text: `${topic} tutorial`, type: "search" }
    );
  }

  // Add domain suggestions from context tabs
  const domains = new Set();
  for (const tab of contextTabs) {
    if (tab.url) {
      try {
        const domain = tab.url
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .split("/")[0];
        if (
          domain &&
          domain !== "about:blank" &&
          !domain.startsWith("about:")
        ) {
          domains.add(domain);
        }
      } catch (e) {
        // Skip invalid URLs
      }
    }
  }

  // Add up to 2 unique domains
  const domainArray = Array.from(domains).slice(0, 2);
  domainArray.forEach(domain => {
    suggestions.push({ text: domain, type: "navigate" });
  });

  // Add action prompt
  suggestions.push({ text: "tab next", type: "action" });

  return suggestions;
}
