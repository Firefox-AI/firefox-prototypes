/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getInsightSummariesForPrompt } from "./insights.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ChatHistory: "resource:///modules/smartwindow/ChatHistory.sys.mjs",
  UrlbarController:
    "moz-src:///browser/components/urlbar/UrlbarController.sys.mjs",
  UrlbarProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarQueryContext:
    "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
});

import { detectQueryType, createOpenAIEngine } from "./utils.mjs";

// Top US websites for prefix matching navigation suggestions
const TOP_US_WEBSITES = [
  "adobe.com",
  "airbnb.co",
  "airbnb.com",
  "airtable.com",
  "alibaba.com",
  "amazon.com",
  "americanexpress.com",
  "apple.com",
  "att.com",
  "bankofamerica.com",
  "bbc.com",
  "bestbuy.com",
  "bing.com",
  "blogspot.com",
  "booking.com",
  "buzzfeed.com",
  "canva.com",
  "capitalone.com",
  "chase.com",
  "chatgpt.com",
  "chewy.com",
  "cnn.com",
  "coinbase.com",
  "costco.com",
  "craigslist.org",
  "delta.com",
  "discord.com",
  "disneyplus.com",
  "dropbox.com",
  "duckduckgo.com",
  "ebay.com",
  "espn.com",
  "etsy.com",
  "expedia.com",
  "facebook.com",
  "fidelity.com",
  "figma.com",
  "flickr.com",
  "forbes.com",
  "ford.com",
  "fox.com",
  "github.com",
  "glassdoor.com",
  "gmail.com",
  "godaddy.com",
  "google.com",
  "hbomax.com",
  "homedepot.com",
  "hotels.com",
  "hulu.com",
  "ibm.com",
  "ikea.com",
  "imdb.com",
  "indeed.com",
  "instagram.com",
  "intel.com",
  "kayak.com",
  "linkedin.com",
  "lowes.com",
  "lyft.com",
  "macys.com",
  "mailchimp.com",
  "mapquest.com",
  "max.com",
  "medium.com",
  "microsoft.com",
  "microsoft365.com",
  "nbc.com",
  "netflix.com",
  "nike.com",
  "nordstrom.com",
  "notion.so",
  "nvidia.com",
  "nytimes.com",
  "office.com",
  "openai.com",
  "oracle.com",
  "paramount.com",
  "paypal.com",
  "pinterest.com",
  "quora.com",
  "reddit.com",
  "roblox.com",
  "salesforce.com",
  "schwab.com",
  "shopify.com",
  "slack.com",
  "snapchat.com",
  "southwest.com",
  "spotify.com",
  "stackoverflow.com",
  "starbucks.com",
  "target.com",
  "telegram.org",
  "threads.net",
  "tiktok.com",
  "trello.com",
  "tripadvisor.com",
  "tumblr.com",
  "twitch.tv",
  "twitter.com",
  "uber.com",
  "united.com",
  "ups.com",
  "usatoday.com",
  "usps.com",
  "verizon.com",
  "walmart.com",
  "washingtonpost.com",
  "wayfair.com",
  "weather.com",
  "webmd.com",
  "wellsfargo.com",
  "whatsapp.com",
  "wikipedia.org",
  "wsj.com",
  "x.com",
  "yahoo.com",
  "yelp.com",
  "youtube.com",
  "zillow.com",
  "zoom.us",
];

/**
 * Generates live suggestions for a search query by querying the urlbar
 * providers and processing the results.
 *
 * @param {string} query - The search query to generate suggestions for
 * @param {Window} topChromeWindow - The top chrome window reference
 * @returns {Promise<{suggestions: Array<{text: string, type: string}>, autofillData: object|null}>} Object containing suggestions array and autofill data
 */
export async function generateLiveSuggestions(query, topChromeWindow) {
  try {
    const context = new lazy.UrlbarQueryContext({
      searchString: query.trim(),
      allowAutofill: true,
      isPrivate: false,
      maxResults: 20,
      sapName: "smart-window",
      userContextId: 0,
    });

    const controller = new lazy.UrlbarController({
      input: {
        isPrivate: false,
        onFirstResult() {},
        window: topChromeWindow,
      },
    });

    // Start the query and wait for results
    await lazy.UrlbarProvidersManager.startQuery(context, controller);

    // Process the results similar to api.ts getUrlbarSuggestions
    const suggestions = [];

    // Check for autofill data in the context
    let autofillData = null;

    // Convert Firefox urlbar results to our suggestion format
    const urlbarSuggestions = [];
    for (const result of context.results) {
      let suggestion = {
        type: "search", // default
        text: "",
        title: "",
        url: "",
        icon: "",
        description: "",
      };

      if (!autofillData && result.autofill) {
        autofillData = result.autofill;
      }

      // Map Firefox result types to our suggestion types (based on api.ts)
      switch (result.type) {
        case 1: // Tab switch
          suggestion.type = "action";
          suggestion.text = `tab switch: ${result.payload.title || result.payload.url || ""}`;
          suggestion.title = result.payload.title || "";
          suggestion.url = result.payload.url || "";
          suggestion.icon = result.payload.icon || "";
          break;

        case 2: // Search suggestion
          suggestion.type = "search";
          suggestion.text =
            result.payload.suggestion || result.payload.query || query;
          suggestion.title = result.payload.suggestion || "";
          suggestion.description = result.payload.description || "";
          suggestion.icon = result.payload.icon || "";
          break;

        case 3: // URL/bookmark
          suggestion.type = "navigate";
          suggestion.text =
            result.payload.displayUrl || result.payload.url || "";
          suggestion.title = result.payload.title || "";
          suggestion.url = result.payload.url || "";
          suggestion.icon = result.payload.icon || "";
          break;

        default:
          continue; // Skip unknown types
      }

      // Only add non-empty suggestions
      if (suggestion.text.trim()) {
        urlbarSuggestions.push(suggestion);
      }
    }

    // Process suggestions similar to extension's generateLiveSuggestions

    // Get search results from urlbar
    const searchResults = urlbarSuggestions.filter(s => s.type === "search");

    if (searchResults.length) {
      // Get the intent for the original query
      const queryIntentType = await detectQueryType(query);
      const oppositeType = queryIntentType === "search" ? "chat" : "search";

      // Process search results - preserve some as original type to ensure opposites
      const resultsToProcess = searchResults.slice(0, 6);
      const processedSuggestions = [];

      // Keep at least one result as original "search" type to ensure we have opposites
      let preservedSearchCount = 0;
      const maxPreservedSearch = queryIntentType === "chat" ? 2 : 0; // Preserve search suggestions when intent is chat

      for (const result of resultsToProcess) {
        let finalType;

        // If we need search suggestions for opposites, preserve some original search results
        if (
          queryIntentType === "chat" &&
          preservedSearchCount < maxPreservedSearch
        ) {
          finalType = "search";
          preservedSearchCount++;
        } else {
          finalType = await detectQueryType(result.text);
        }

        processedSuggestions.push({
          title: result.title,
          text: result.text,
          icon: result.icon,
          type: finalType,
        });
      }

      // Reorder suggestions: intent type first, opposite type second, then others
      const intentSuggestions = processedSuggestions.filter(
        s => s.type === queryIntentType
      );
      const oppositeSuggestions = processedSuggestions.filter(
        s => s.type === oppositeType
      );
      const otherSuggestions = processedSuggestions.filter(
        s => s.type !== queryIntentType && s.type !== oppositeType
      );

      // Add in desired order: intent first (always the original query for chat/search), then opposite, then others
      // For chat or search intent, always put the original query as the first suggestion
      if (queryIntentType === "chat" || queryIntentType === "search") {
        suggestions.push({
          title: "",
          text: query,
          icon: "",
          type: queryIntentType,
        });
      } else if (intentSuggestions.length) {
        suggestions.push(intentSuggestions[0]); // First suggestion matches intent
      } else if (processedSuggestions.length) {
        // If no intent matches, add the first available suggestion and ensure it has the right type
        const firstSuggestion = {
          ...processedSuggestions[0],
          type: queryIntentType,
        };
        suggestions.push(firstSuggestion);
      } else {
        // Fallback: always add the original query with detected intent type
        suggestions.push({
          title: "",
          text: query,
          icon: "",
          type: queryIntentType,
        });
      }

      // Ensure we always have an opposite type as second suggestion using the original query
      // Always use the original query text for the opposite suggestion to maintain consistency
      suggestions.push({
        title: "",
        text: query,
        icon: "",
        type: oppositeType,
      });

      // Add remaining suggestions (avoid duplicates)
      const addedTexts = new Set(suggestions.map(s => s.text));
      suggestions.push(
        ...intentSuggestions.slice(1).filter(s => !addedTexts.has(s.text))
      );
      suggestions.push(
        ...oppositeSuggestions.slice(1).filter(s => !addedTexts.has(s.text))
      );
      suggestions.push(
        ...otherSuggestions.filter(s => !addedTexts.has(s.text))
      );
    }

    // Add navigate results as-is
    const navigateResults = urlbarSuggestions.filter(
      s => s.type === "navigate"
    );
    const navigateSuggestions = navigateResults.slice(0, 2).map(s => ({
      title: s.title,
      text: s.text,
      icon: s.icon,
      type: s.type,
    }));
    suggestions.push(...navigateSuggestions);

    // Add action results as-is
    const actionResults = urlbarSuggestions.filter(s => s.type === "action");
    const actionSuggestions = actionResults.slice(0, 2).map(s => ({
      title: s.title,
      text: s.text,
      icon: s.icon,
      type: s.type,
    }));
    suggestions.push(...actionSuggestions);

    // If we don't have enough suggestions, add some fallbacks
    if (suggestions.length < 4) {
      const queryType = await detectQueryType(query);
      const oppositeType = queryType === "search" ? "chat" : "search";

      // Add the query itself if not already present
      if (!suggestions.some(s => s.text === query)) {
        // If this is the first suggestion, ensure it follows intent-first pattern
        if (suggestions.length === 0) {
          suggestions.push({ text: query, type: queryType });
        } else if (
          suggestions.length === 1 &&
          suggestions[0].type === queryType
        ) {
          // If first suggestion matches intent, add opposite type as second
          suggestions.push({ text: query, type: oppositeType });
        } else {
          suggestions.push({ text: query, type: queryType });
        }
      }
    }

    // If no autofill data from urlbar, check TOP_US_WEBSITES for prefix match
    if (!autofillData) {
      const lowerQuery = query.toLowerCase().trim();
      const match = TOP_US_WEBSITES.find(site =>
        site.toLowerCase().startsWith(lowerQuery)
      );

      if (match) {
        autofillData = {
          value: match,
          selectionStart: query.length,
          selectionEnd: match.length,
        };
      }
    }

    return {
      suggestions: suggestions.slice(0, 10),
      autofillData,
    };
  } catch (error) {
    console.error("Error getting live suggestions:", error);

    // Fall back to simple suggestions on error
    const suggestions = [];
    const type = await detectQueryType(query);

    suggestions.push(
      { text: query, type },
      { text: "tab next", type: "action" },
      { text: "github.com", type: "navigate" }
    );

    return {
      suggestions,
      autofillData: null,
    };
  }
}

/**
 * Helper to trim conversation history to recent messages
 *
 * @param {Array} messages - Array of chat messages
 * @returns {Array} Trimmed array of user/assistant messages
 */
function trimConversation(messages) {
  // Keep only natural user/assistant messages; drop tool calls and tool outputs.
  const out = [];
  const MESSAGE_ROLE = lazy.ChatHistory.MESSAGE_ROLE;

  for (const m of messages) {
    if (
      (m.role === MESSAGE_ROLE.USER || m.role === MESSAGE_ROLE.ASSISTANT) &&
      m.content &&
      m.content.trim()
    ) {
      // skip assistant messages that only carry tool_calls and have empty content
      if (
        m.role === MESSAGE_ROLE.ASSISTANT &&
        (!m.content.trim() || m.content.trim() === "")
      ) {
        continue;
      }
      // Convert numeric role to string for LLM
      const roleString = m.role === MESSAGE_ROLE.USER ? "user" : "assistant";
      out.push({ role: roleString, content: m.content });
    }
  }
  // Limit to last 10-15 messages for focused context
  return out.slice(-15);
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

const CONVERSATION_STARTERS_TEMPLATE = `You are an expert in suggesting conversation starters for a browser assistant.

========
Today's date:
{date}

========
Current Tab:
{current_tab}

========
Opened Tabs:
{opened_tabs}

========
The following tools are available to the browser assistant:
- search_open_tabs(type): search through user's currently open tabs by category/topic
- get_page_content(url): retrieve raw page content for analysis
- search_history(search_term): find previously visited pages by keywords

========
Generate {n} conversation starter suggestions that can help the user begin a chat with the browser assistant.

Rules:
- Be concise but specific, limit to maximum 8 words for each suggestion
- If current tab context is available (not about:blank/newtab), focus suggestions on that context
- Else if opened tabs are available, balance suggestions across those contexts
- Suggestions should be common questions or requests that make logical sense
- Do not suggest actions requiring extra steps (like share, save, etc.)
- Do not suggest opening new pages or requiring additional information

Return ONLY the suggestions, one per line, no numbering, no extra formatting:`;

const FOLLOWUP_PROMPTS_TEMPLATE = `You are an expert suggesting next queries for a browser assistant user during a conversation.

========
Today's date:
{date}

========
Current Tab:
{current_tab}

========
Conversation History (latest last):
{conversation}

========
Generate {n} suggested next queries that the user might ask next.

Rules:
- Keep each under 8 words and conversational
- Stay relevant to the current tab and recent assistant replies
- Do not repeat earlier user queries verbatim
- Provide diverse and helpful directions based on the conversation

Return ONLY the suggestions, one per line, no numbering, no extra formatting:`;

/**
 * Generates conversation starter prompts based on tab context + (optional) user insights
 *
 * @param {Array} contextTabs - Array of tab objects with title, url, favicon
 * @param {number} n - Number of suggestions to generate (default 6)
 * @returns {Promise<Array>} Array of {text, type} suggestion objects
 */
export async function generateConversationStarters(contextTabs = [], n = 6) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Format current tab (first in context or empty)
    const currentTab = contextTabs.length
      ? formatJson({ title: contextTabs[0].title, url: contextTabs[0].url })
      : "No current tab";

    // Format opened tabs
    const openedTabs =
      contextTabs.length > 1
        ? formatJson(
            contextTabs.slice(1).map(t => ({ title: t.title, url: t.url }))
          )
        : contextTabs.length === 1
          ? "Only current tab is open"
          : "No tabs available";

    // Base template
    const base = CONVERSATION_STARTERS_TEMPLATE.replace(
      "{current_tab}",
      currentTab
    )
      .replace("{opened_tabs}", openedTabs)
      .replace("{n}", String(n))
      .replace("{date}", today);

    const topWin = window.browsingContext?.topChromeWindow;
    const conv = topWin?.gBrowser?.selectedTab?.conversation;

    let insightsEnabled = true;
    if (conv?.settings && typeof conv.settings.useInsights === "boolean") {
      insightsEnabled = conv.settings.useInsights;
    }

    let filled = base;

    if (insightsEnabled) {
      const sw = topWin?.SmartWindow || window.SmartWindow;
      const store = sw?.getInsightsData?.() || {};
      const summaries = getInsightSummariesForPrompt(store, 8);

      if (summaries.length) {
        const insightsBlock = summaries.map(s => `- ${s}`).join("\n");
        filled = `${base}

========
User Insights:
${insightsBlock}

Guideline:
- Use insights only when relevant to the current tab or open tabs; otherwise default to general starters.
- Paraphrase insights into actionable starters; do not repeat them verbatim or reveal sensitive details.
- Do not invent new personal attributes or insights; prefer neutral phrasing when unsure.
- Aim for variety; avoid duplicates across suggestions.`;
      }
    }

    const engineInstance = await createOpenAIEngine("smart-start");

    const result = await engineInstance.run({
      args: [
        {
          role: "system",
          content: "Return only the requested suggestions, one per line.",
        },
        { role: "user", content: filled },
      ],
    });

    const text = (result.finalOutput || "").trim();

    // Parse newline-separated responses
    const lines = text
      .split(/\n+/)
      .map(l => l.trim())
      .filter(Boolean);

    // Clean up any numbering or bullet points that might have been added
    const prompts = lines
      .map(line => line.replace(/^[-*\d.)\]]+\s*/, ""))
      .filter(p => p.length);

    return prompts.slice(0, n).map(t => ({ text: t, type: "chat" }));
  } catch (e) {
    console.warn("[suggestions][conversation-starters] failed:", e);
    return [];
  }
}

/**
 * Generates followup prompt suggestions based on conversation history
 *
 * @param {Array} conversationHistory - Array of chat messages
 * @param {object} currentTab - Current tab object with title, url
 * @param {number} n - Number of suggestions to generate (default 6)
 * @returns {Promise<Array>} Array of {text, type} suggestion objects
 */
export async function generateFollowupPrompts(
  conversationHistory,
  currentTab,
  n = 6
) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const convo = trimConversation(conversationHistory);
    const filled = FOLLOWUP_PROMPTS_TEMPLATE.replace(
      "{current_tab}",
      currentTab
        ? formatJson({ title: currentTab.title, url: currentTab.url })
        : "No tab"
    )
      .replace("{conversation}", formatJson(convo))
      .replace("{n}", String(n))
      .replace("{date}", today);

    const engineInstance = await createOpenAIEngine("smart-follow");

    const result = await engineInstance.run({
      args: [
        {
          role: "system",
          content: "Return only the requested suggestions, one per line.",
        },
        { role: "user", content: filled },
      ],
    });

    const text = result.finalOutput.trim() || "";

    // Parse newline-separated responses
    const lines = text
      .split(/\n+/)
      .map(l => l.trim())
      .filter(Boolean);

    // Clean up any numbering or bullet points
    const prompts = lines
      .map(line => {
        const cleaned = line.replace(/^[-*\d.)\]]+\s*/, "");
        return cleaned;
      })
      .filter(p => !!p.length);

    return prompts.slice(0, n).map(text => ({ text, type: "chat" }));
  } catch (e) {
    console.warn("[suggestions][followup-prompts] failed:", e);
    return [];
  }
}
