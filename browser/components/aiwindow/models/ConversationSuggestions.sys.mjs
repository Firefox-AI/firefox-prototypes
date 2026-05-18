/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// conversation starter/followup generation functions

import {
  openAIEngine,
  renderPrompt,
  MODEL_FEATURES,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";

import { MESSAGE_ROLE } from "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs";

import { MemoriesManager } from "moz-src:///browser/components/aiwindow/models/memories/MemoriesManager.sys.mjs";
import { sanitizeUntrustedContent } from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";

// Max number of memories to include in prompts
const MAX_NUM_MEMORIES = 8;

/**
 * Helper to trim conversation history to recent messages, dropping empty messages, tool calls and responses
 *
 * @param {Array} messages - Array of chat messages
 * @param {number} maxMessages - Max number of messages to keep (default 15)
 * @returns {Array} Trimmed array of user/assistant messages
 */
export function trimConversation(messages, maxMessages = 15) {
  const out = [];

  for (const m of messages) {
    if (
      (m.role === MESSAGE_ROLE.USER || m.role === MESSAGE_ROLE.ASSISTANT) &&
      m.content &&
      m.content.trim()
    ) {
      const roleString = m.role === MESSAGE_ROLE.USER ? "user" : "assistant";
      out.push({ role: roleString, content: m.content });
    }
  }

  return out.slice(-maxMessages);
}

/**
 * Helper to add memories to base prompt if applicable
 *
 * @param {string} base - base prompt
 * @param {string} conversationMemoriesPrompt - the memories prompt template
 * @returns {Promise<string>} - prompt with memories added if applicable
 */
export async function addMemoriesToPrompt(base, conversationMemoriesPrompt) {
  let memorySummaries =
    await MemoriesGetterForSuggestionPrompts.getMemorySummariesForPrompt(
      MAX_NUM_MEMORIES
    );
  if (memorySummaries.length) {
    const memoriesBlock = memorySummaries.map(s => `- ${s}`).join("\n");
    const memoryPrompt = renderPrompt(conversationMemoriesPrompt, {
      memories: memoriesBlock,
    });
    return `${base}\n${memoryPrompt}`;
  }
  return base;
}

/**
 * Cleans inference output into array of prompts
 *
 * @param {*} result - Inference output result object
 * @returns {Array<string>} - Cleaned array of prompts
 */
export function cleanInferenceOutput(result) {
  const text = (result.finalOutput || "").trim();
  const lines = text
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean);

  const prompts = lines
    .map(line => line.replace(/^[-*\d.)\[\]]+\s*/, ""))
    .filter(p => p.length)
    .map(p => p.replace(/\.$/, "").replace(/^[^:]*:\s*/, ""));
  return prompts;
}

/**
 * Format object to JSON string safely
 *
 * @param {*} obj - Object to format
 * @returns {string} JSON string or string representation
 */
const formatJson = obj => {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
};

export const NewTabStarterGenerator = {
  writingPrompts: [
    "Write a first draft",
    "Improve writing",
    "Proofread a message",
  ],

  planningPrompts: ["Simplify a topic", "Brainstorm ideas", "Help make a plan"],

  // TODO: discuss with design about updating phrasing to "pages" instead of "tabs"
  browsingPrompts: [
    { text: "Find tabs in history", minTabs: 0, needsHistory: true },
    { text: "Summarize tabs", minTabs: 1, needsHistory: false },
    { text: "Compare tabs", minTabs: 2, needsHistory: false },
  ],

  getRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  },

  /**
   * Generate conversation starter prompts based on number of open tabs and browsing history prefs.
   * "places.history.enabled" covers "Remember browsing and download history" while
   * "browser.privatebrowsing.autostart" covers "Always use private mode" and "Never remember history".
   * We need to check both prefs to cover all cases where history can be disabled.
   *
   * @param {number} tabCount - number of open tabs
   * @returns {Promise<Array>} Array of {text, type} suggestion objects
   */
  async getPrompts(tabCount) {
    const historyEnabled = Services.prefs.getBoolPref("places.history.enabled");
    const privateBrowsing = Services.prefs.getBoolPref(
      "browser.privatebrowsing.autostart"
    );
    const validBrowsingPrompts = this.browsingPrompts.filter(
      p =>
        tabCount >= p.minTabs &&
        (!p.needsHistory || (historyEnabled && !privateBrowsing))
    );

    const writingPrompt = this.getRandom(this.writingPrompts);
    const planningPrompt = this.getRandom(this.planningPrompts);
    const browsingPrompt = validBrowsingPrompts.length
      ? this.getRandom(validBrowsingPrompts)
      : null;

    const prompts = [
      { text: writingPrompt, type: "chat" },
      { text: planningPrompt, type: "chat" },
    ];

    if (browsingPrompt) {
      prompts.push({ text: browsingPrompt.text, type: "chat" });
    }

    return prompts;
  },
};

/**
 * Generates conversation starter prompts based on tab context + (optional) user memories
 *
 * @param {Array} contextTabs - Array of tab objects with title, url, favicon
 * @param {number} n - Number of suggestions to generate (default 6)
 * @param {boolean} useMemories - Whether to include user memories in prompt (default false)
 * @param {string | null} flowId - Flow ID for correlating with firefox_ai_runtime telemetry
 * @param {AbortSignal} signal - Signal to cancel the inference request
 * @returns {Promise<Array>} Array of {text, type} suggestion objects
 */
export async function generateConversationStartersSidebar(
  contextTabs = [],
  n = 2,
  useMemories = false,
  flowId = null,
  signal = new AbortController().signal
) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Format current tab (first in context or empty)
    const currentTab = contextTabs.length
      ? formatJson({
          title: sanitizeUntrustedContent(contextTabs[0].title),
          url: contextTabs[0].url,
        })
      : "No current tab";

    // Format opened tabs
    let openedTabs;
    if (contextTabs.length >= 1) {
      openedTabs =
        contextTabs.length === 1
          ? "Only current tab is open"
          : formatJson(
              contextTabs.slice(1).map(t => ({
                title: sanitizeUntrustedContent(t.title),
                url: t.url,
              }))
            );
    } else {
      openedTabs = "No tabs available";
    }
    // Data extracted into currentTab/openedTabs strings; release the
    // caller-allocated array so it cannot prevent the window from being GC'd
    // while awaiting inference.
    contextTabs = null;

    // Build engine and load prompt
    const engineInstance = await openAIEngine.build(
      MODEL_FEATURES.CONVERSATION_SUGGESTIONS_SIDEBAR_STARTER,
      flowId
    );

    const conversationStarterSystemPrompt = await engineInstance.loadPrompt(
      MODEL_FEATURES.CONVERSATION_STARTERS_SIDEBAR_SYSTEM
    );

    const conversationStarterPrompt = await engineInstance.loadPrompt(
      MODEL_FEATURES.CONVERSATION_SUGGESTIONS_SIDEBAR_STARTER
    );

    const assistantLimitations = await engineInstance.loadPrompt(
      MODEL_FEATURES.CONVERSATION_SUGGESTIONS_ASSISTANT_LIMITATIONS
    );

    // Base template
    const base = renderPrompt(conversationStarterPrompt, {
      current_tab: currentTab,
      open_tabs: openedTabs,
      n: String(n),
      date: today,
      assistant_limitations: assistantLimitations,
    });

    let filled = base;
    if (useMemories) {
      const conversationMemoriesPrompt = await engineInstance.loadPrompt(
        MODEL_FEATURES.CONVERSATION_SUGGESTIONS_MEMORIES
      );
      filled = await addMemoriesToPrompt(base, conversationMemoriesPrompt);
    }

    // Get config for inference parameters
    const config = engineInstance.getConfig(engineInstance.feature);
    const inferenceParams = config?.parameters || {};

    const fxAccountToken = await openAIEngine.getFxAccountToken();
    signal.throwIfAborted();

    let runPromise = engineInstance.run({
      args: [
        {
          role: "system",
          content: conversationStarterSystemPrompt,
        },
        { role: "user", content: filled },
      ],
      fxAccountToken,
      ...inferenceParams,
    });
    runPromise = Promise.race([
      runPromise,
      new Promise((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
        } else {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }
      }),
    ]);
    const result = await runPromise;

    const prompts = cleanInferenceOutput(result);

    return prompts.slice(0, n).map(t => ({ text: t, type: "chat" }));
  } catch (e) {
    if (e.name !== "AbortError") {
      console.warn(
        "[ConversationSuggestions][sidebar-conversation-starters] failed:",
        e
      );
    }
    return [];
  }
}

const FOCUS_ALIGNMENT_SYSTEM_PROMPT = `You are a focus coach. Evaluate how well the user's current browser tab aligns with their stated mission/goal.

Respond with ONLY a single JSON object — no markdown fences, no commentary, no prose around it — in this exact schema:
{
  "alignment_score": <integer 0-100>,
  "status": "on_task" | "drifting" | "off_track",
  "one_sentence_explanation": "<one short sentence under 140 chars>",
  "recovery_searches": [<2 or 3 short web-search queries that would help the user get back on task>]
}

Scoring guidance:
- 80-100 = on_task (current tab directly supports the goal)
- 50-79  = drifting (tangentially related)
- 0-49   = off_track (unrelated to the goal)

Recovery searches:
- Each query should be 2-6 words, the kind of thing the user would type into a search bar.
- Bridge the current tab back to the goal: if the user is reading X but their goal is about Y, suggest queries that pivot from X to Y (e.g. lessons-learned, comparisons, next-step searches grounded in what they're already looking at).
- Use concrete nouns/entities from the current tab's title or domain when they make the query more useful; otherwise fall back to the goal alone.
- For on_task pages, return an empty array.
- For drifting / off_track pages, return 2 or 3 queries.

If the goal is empty, return alignment_score: 0, status: "off_track", explanation: "No mission set — set a goal to track focus.", recovery_searches: [].`;

const FOCUS_ALIGNMENT_USER_PROMPT_TEMPLATE = `Goal: {goal}

Current tab: {current_tab}

Other open tabs: {open_tabs}

Date: {date}

Respond with JSON only.`;

const FOCUS_VALID_STATUSES = new Set(["on_task", "drifting", "off_track"]);

function parseFocusAlignmentResponse(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    console.warn("[FocusAlignment] invalid JSON response:", e, raw);
    return null;
  }
  let score = Number(parsed?.alignment_score);
  if (!Number.isFinite(score)) {
    return null;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  let status = String(parsed?.status ?? "").toLowerCase();
  if (!FOCUS_VALID_STATUSES.has(status)) {
    if (score >= 80) {
      status = "on_task";
    } else if (score >= 50) {
      status = "drifting";
    } else {
      status = "off_track";
    }
  }
  const explanation = String(parsed?.one_sentence_explanation ?? "").slice(
    0,
    240
  );
  const recoverySearches = Array.isArray(parsed?.recovery_searches)
    ? parsed.recovery_searches
        .map(q => String(q ?? "").trim())
        .filter(q => !!q.length && q.length <= 80)
        .slice(0, 3)
    : [];
  return {
    alignment_score: score,
    status,
    one_sentence_explanation: explanation,
    recovery_searches: recoverySearches,
  };
}

/**
 * Asks the LLM to score how well the current tab aligns with the user's
 * stated mission/goal. Mirrors generateConversationStartersSidebar's
 * scaffolding (engine build, formatJson tab structuring, AbortSignal race)
 * but with an inline prompt and JSON-only output.
 *
 * @param {Array} contextTabs - Array of tab objects with title, url; first entry is the current tab
 * @param {string} goal - User's mission/goal text (may be empty)
 * @param {string | null} flowId - Flow ID for correlating with firefox_ai_runtime telemetry
 * @param {AbortSignal} signal - Signal to cancel the inference request
 * @returns {Promise<{alignment_score: number, status: string, one_sentence_explanation: string}|null>}
 */
export async function generateFocusAlignment(
  contextTabs = [],
  goal = "",
  flowId = null,
  signal = new AbortController().signal
) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const currentTab = contextTabs.length
      ? formatJson({
          title: sanitizeUntrustedContent(contextTabs[0].title),
          url: contextTabs[0].url,
        })
      : "No current tab";

    let openedTabs;
    if (contextTabs.length >= 1) {
      openedTabs =
        contextTabs.length === 1
          ? "Only current tab is open"
          : formatJson(
              contextTabs.slice(1).map(t => ({
                title: sanitizeUntrustedContent(t.title),
                url: t.url,
              }))
            );
    } else {
      openedTabs = "No tabs available";
    }
    contextTabs = null;

    const engine = await openAIEngine.build(MODEL_FEATURES.CHAT, flowId);
    const inferenceParams = engine.getConfig(engine.feature)?.parameters || {};

    const userPrompt = renderPrompt(FOCUS_ALIGNMENT_USER_PROMPT_TEMPLATE, {
      goal: String(goal ?? "").trim() || "(no mission set)",
      current_tab: currentTab,
      open_tabs: openedTabs,
      date: today,
    });

    const fxAccountToken = await openAIEngine.getFxAccountToken();
    signal.throwIfAborted();

    let runPromise = engine.run({
      args: [
        { role: "system", content: FOCUS_ALIGNMENT_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      fxAccountToken,
      ...inferenceParams,
    });
    runPromise = Promise.race([
      runPromise,
      new Promise((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
        } else {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }
      }),
    ]);

    const result = await runPromise;
    return parseFocusAlignmentResponse(result?.finalOutput);
  } catch (e) {
    if (e?.name !== "AbortError") {
      console.warn("[FocusAlignment] generateFocusAlignment failed:", e);
    }
    return null;
  }
}

/**
 * Generates followup prompt suggestions based on conversation history
 *
 * @param {Array} conversationHistory - Array of chat messages
 * @param {object} currentTab - Current tab object with title, url
 * @param {number} n - Number of suggestions to generate (default 6)
 * @param {boolean} useMemories - Whether to include user memories in prompt (default false)
 * @param {string | null} flowId - Flow ID for correlating with firefox_ai_runtime telemetry
 * @returns {Promise<Array>} Array of {text, type} suggestion objects
 */
export async function generateFollowupPrompts(
  conversationHistory,
  currentTab,
  n = 2,
  useMemories = false,
  flowId = null
) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const convo = trimConversation(conversationHistory);
    const currentTabStr =
      currentTab && Object.keys(currentTab).length
        ? formatJson({
            title: sanitizeUntrustedContent(currentTab.title),
            url: currentTab.url,
          })
        : "No tab";

    // Build engine and load prompt
    const engineInstance = await openAIEngine.build(
      MODEL_FEATURES.CONVERSATION_SUGGESTIONS_FOLLOWUP,
      flowId
    );

    const conversationFollowupPrompt = await engineInstance.loadPrompt(
      MODEL_FEATURES.CONVERSATION_SUGGESTIONS_FOLLOWUP
    );

    const assistantLimitationsFollowup = await engineInstance.loadPrompt(
      MODEL_FEATURES.CONVERSATION_SUGGESTIONS_ASSISTANT_LIMITATIONS
    );

    const base = renderPrompt(conversationFollowupPrompt, {
      current_tab: currentTabStr,
      conversation: formatJson(convo),
      n: String(n),
      date: today,
      assistant_limitations: assistantLimitationsFollowup,
    });

    let filled = base;
    if (useMemories) {
      const conversationMemoriesPrompt = await engineInstance.loadPrompt(
        MODEL_FEATURES.CONVERSATION_SUGGESTIONS_MEMORIES
      );
      filled = await addMemoriesToPrompt(base, conversationMemoriesPrompt);
    }

    // Get config for inference parameters
    const config = engineInstance.getConfig(
      MODEL_FEATURES.CONVERSATION_SUGGESTIONS_FOLLOWUP
    );
    const inferenceParams = config?.parameters || {};

    const result = await engineInstance.run({
      messages: [
        {
          role: "system",
          content: "Return only the requested suggestions, one per line.",
        },
        { role: "user", content: filled },
      ],
      ...inferenceParams,
    });

    const prompts = cleanInferenceOutput(result);

    return prompts.slice(0, n).map(t => ({ text: t, type: "chat" }));
  } catch (e) {
    console.warn("[ConversationSuggestions][followup-prompts] failed:", e);
    return [];
  }
}

export const MemoriesGetterForSuggestionPrompts = {
  /**
   * Gets the requested number of unique memory summaries for prompt inclusion
   *
   * @param {number} maxMemories - Max number of memories to return (default MAX_NUM_MEMORIES)
   * @returns {Promise<Array>} Array of string memory summaries
   */

  async getMemorySummariesForPrompt(maxMemories) {
    const memorySummaries = [];
    const memoryEntries = (await MemoriesManager.getAllMemories()) || {};
    const seenSummaries = new Set();

    for (const { memory_summary } of memoryEntries) {
      const summaryText = String(memory_summary ?? "").trim();
      if (!summaryText) {
        continue;
      }
      const lower = summaryText.toLowerCase();
      if (seenSummaries.has(lower)) {
        continue;
      }
      seenSummaries.add(lower);
      memorySummaries.push(summaryText);
      if (memorySummaries.length >= maxMemories) {
        break;
      }
    }

    return memorySummaries;
  },
};
