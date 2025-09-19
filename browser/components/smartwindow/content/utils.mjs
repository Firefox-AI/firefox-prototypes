/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEngine } from "chrome://global/content/ml/EngineProcess.sys.mjs";

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

/**
 * Fetches a response from the OpenAI engine with message history.
 *
 * @param {Array} messages - Array of message objects with role and content
 * @returns {AsyncGenerator<string>} Stream of response chunks
 */
export async function* fetchWithHistory(messages) {
  try {
    const engineInstance = await createOpenAIEngine();

    // Convert messages to OpenAI format
    const openAIMessages = messages.map(msg => ({
      role: msg.role.toLowerCase(),
      content: msg.content,
    }));

    // Use runWithGenerator to get streaming chunks directly
    for await (const chunk of engineInstance.runWithGenerator({
      args: openAIMessages,
    })) {
      if (chunk.text) {
        yield chunk.text;
      }
    }
  } catch (error) {
    console.error("ML Engine error:", error);
    yield `Error: Failed to connect to AI service. Please check browser.smartwindow.* preferences. ${error.message}`;
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
