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
