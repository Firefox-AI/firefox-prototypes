/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

/* eslint-disable-next-line mozilla/reject-import-system-module-from-non-system */
import { createEngine } from "chrome://global/content/ml/EngineProcess.sys.mjs";

const toolsConfig = [
  {
    type: "function",
    function: {
      name: "search_open_tabs",
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

/**
 * Searches the user's open tabs for tabs that match the given type
 *
 * @param {object}  args.type - type of tabs to search for
 * @returns
 */

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
 * Adding a chat whitelist for short greetings and chat starters
 */

const FORCED_CHAT_PHRASES = [
  "amuse me",
  "are we alone",
  "are you alive",
  "are you gpt",
  "are you human",
  "are you real",
  "bark like dog",
  "cheer me up",
  "comfort me",
  "count numbers",
  "curse me",
  "do aliens exist",
  "do we matter",
  "do you dream",
  "do you think",
  "does fate exist",
  "dream meaning",
  "drop wisdom",
  "encourage me",
  "entertain me",
  "explain yourself",
  "flip coin",
  "give blessing",
  "give wisdom",
  "good morning",
  "good night",
  "guess number",
  "hallo",
  "hello",
  "hey",
  "hi",
  "hola",
  "how are you",
  "inspire me",
  "invent a word",
  "invent holiday",
  "invent joke",
  "is god real",
  "life advice",
  "life purpose",
  "list animals",
  "list capitals",
  "list colors",
  "list countries",
  "list elements",
  "list fruits",
  "list metals",
  "list oceans",
  "list planets",
  "list shapes",
  "meaning of life",
  "meow like cat",
  "motivate me",
  "now you are",
  "play a game",
  "pretend alien",
  "pretend child",
  "pretend detective",
  "pretend ghost",
  "pretend pirate",
  "pretend robot",
  "pretend superhero",
  "pretend teacher",
  "pretend wizard",
  "random fact",
  "random number",
  "roll dice",
  "goodbye",
  "simulate chat",
  "simulate future",
  "simulate past",
  "sing like robot",
  "sing lullaby",
  "sing rap",
  "sup",
  "surprise me",
  "teach me",
  "tell bedtime story",
  "tell fortune",
  "tell joke",
  "tell prophecy",
  "tell riddle",
  "tell story",
  "what is art",
  "what is beauty",
  "what is death",
  "what is freedom",
  "what is justice",
  "what is love",
  "what is mind",
  "what is reality",
  "what is right",
  "what is self",
  "what is soul",
  "what is time",
  "what is truth",
  "what is wrong",
  "what model are you",
  "what version",
  "what’s up",
  "which model are you",
  "who am i",
  "who are you",
  "who made you",
  "why are we",
  "write a poem",
  "write a song",
  "write haiku",
  "write quote",
  "your model is"
]

// ------------------------
// Normalization & tokenization (Unicode-aware) for chat whitelist
// ------------------------
export function normalizeTextForWhitelist(s) {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

// Split on non-word chars; letters/numbers/_ are "word" characters
export function tokenize(s) {
  return normalizeTextForWhitelist(s)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

// ------------------------
// Build phrase sets by token length (exact token sequence match)
// ------------------------
export function buildPhraseSets(phrases) {
  const byLen = new Map(); // len -> Set("tok tok ...")
  for (const p of phrases) {
    const key = tokenize(p).join(" ");
    if (!key) continue;
    const k = key.split(" ").length;
    if (!byLen.has(k)) byLen.set(k, new Set());
    byLen.get(k).add(key);
  }
  return byLen;
}

// Factory: returns a fast checker for “does query contain any isolated phrase?”
export function makeIsolatedPhraseChecker(phrases) {
  const byLen = buildPhraseSets(phrases);
  const cache = new Map();

  return function containsIsolatedPhrase(query) {
    const qNorm = normalizeTextForWhitelist(query);
    if (cache.has(qNorm)) return cache.get(qNorm);

    const toks = qNorm.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    for (const [k, set] of byLen) {
      for (let i = 0; i + k <= toks.length; i++) {
        if (set.has(toks.slice(i, i + k).join(" "))) {
          cache.set(qNorm, true);
          return true;
        }
      }
    }
    cache.set(qNorm, false);
    return false;
  };
}

export const _isForcedChatIsolated = makeIsolatedPhraseChecker(FORCED_CHAT_PHRASES);

/**
 * Smart Assist Engine
 */
export const SmartAssistEngine = {
  toolMap: {
    search_open_tabs,
  },

  /**
   * Exposing createEngine for testing purposes.
   */

  _createEngine: createEngine,

  /**
   * Creates an OpenAI engine instance configured with Smart Assists preferences.
   *
   * @returns {Promise<object>} The configured engine instance
   */
  async createOpenAIEngine() {
    try {
      const engineInstance = await this._createEngine({
        apiKey: Services.prefs.getStringPref("browser.ml.smartAssist.apiKey"),
        backend: "openai",
        baseURL: Services.prefs.getStringPref(
          "browser.ml.smartAssist.endpoint"
        ),
        modelId: Services.prefs.getStringPref("browser.ml.smartAssist.model"),
        modelRevision: "main",
        taskName: "text-generation",
      });
      return engineInstance;
    } catch (error) {
      console.error("Failed to create OpenAI engine:", error);
      throw error;
    }
  },

  /**
   * Stream assistant output with tool-call support.
   * Yields assistant text chunks as they arrive. If the model issues tool calls,
   * we execute them locally, append results to the conversation, and continue
   * streaming the model’s follow-up answer. Repeats until no more tool calls.
   *
   * @param {Array<{role:string, content?:string, tool_call_id?:string, tool_calls?:any}>} messages
   * @yields {string} Assistant text chunks
   */
  async *fetchWithHistory(messages) {
    const engineInstance = await this.createOpenAIEngine();

    // We'll mutate a local copy of the thread as we loop
    let convo = Array.isArray(messages) ? [...messages] : [];

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
        const name = functionSpec?.name || "";
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
          // Call the appropriate tool by name
          const toolFunc = this.toolMap[name];
          if (typeof toolFunc !== "function") {
            throw new Error(`No such tool: ${name}`);
          }

          result = await toolFunc(toolParams);

          // Create special tool call log message to show in the UI log panel
          const assistantToolCallLogMsg = {
            role: "assistant",
            content: `Tool Call: ${name} with parameters: ${JSON.stringify(
              toolParams
            )}`,
            type: "tool_call_log",
            result,
          };
          convo.push(assistantToolCallLogMsg);
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
  },

  /**
   * Gets the intent of the prompt using a text classification model.
   *
   * @param {string} prompt
   * @returns {string} "search" | "chat"
   */

  async getPromptIntent(query) {
    try {
      const cleanedQuery = this._preprocessQuery(query);
      if (_isForcedChatIsolated(cleanedQuery)) {
        return "chat";
      }
      const engine = await this._createEngine({
        featureId: "smart-intent",
        modelId: "mozilla/mobilebert-query-intent-detection",
        modelRevision: "v0.2.0",
        taskName: "text-classification",
      });
      const threshold = 0.6;
      const resp = await engine.run({ args: [[cleanedQuery]] });
      // resp example: [{ label: "chat", score: 0.95 }, { label: "search", score: 0.04 }]
      if (
        resp[0].label.toLowerCase() === "chat" &&
        resp[0].score >= threshold
      ) {
        return "chat";
      }
      return "search";
    } catch (error) {
      console.error("Error using intent detection model:", error);
      throw error;
    }
  },

  // Helper function for preprocessing text input
  _preprocessQuery(query) {
    if (typeof query !== "string") {
      throw new TypeError(
        `Expected a string for query preprocessing, but received ${typeof query}`
      );
    }
    return query.replace(/\?/g, "").trim();
  },

};
