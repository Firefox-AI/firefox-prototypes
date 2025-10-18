/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { html, css } from "chrome://global/content/vendor/lit.all.mjs";
import { createOpenAIEngine } from "./utils.mjs";

/**
 * Helper function to get SmartWindow instance
 */
function getSmartWindow() {
  return window.browsingContext?.topChromeWindow?.SmartWindow;
}

/**
 * Helper function to get insights data from SmartWindow storage
 * Returns generated insights if available, otherwise returns empty object
 */
function getInsightsData() {
  const smartWindow = getSmartWindow();
  if (!smartWindow) {
    return {};
  }

  const stored = smartWindow.getInsightsData();
  return stored || {};
}

export const CATEGORIES = [
  "Arts & Entertainment",
  "Autos & Vehicles",
  "Beauty & Fitness",
  "Books & Literature",
  "Business & Industrial",
  "Computers & Electronics",
  "Finance",
  "Food & Drink",
  "Games",
  "Hobbies & Leisure",
  "Home & Garden",
  "Internet & Telecom",
  "Jobs & Education",
  "Law & Government",
  "News",
  "Online Communities",
  "People & Society",
  "Pets & Animals",
  "Real Estate",
  "Reference",
  "Science",
  "Shopping",
  "Sports",
  "Travel & Transportation",
];

export const INTENTS = [
  "Research / Learn",
  "Compare / Evaluate",
  "Plan / Organize",
  "Buy / Acquire",
  "Create / Produce",
  "Communicate / Share",
  "Monitor / Track",
  "Entertain / Relax",
  "Resume / Revisit",
];

/**
 * User insights data organized by category
 * Static data serves as placeholder until user generates insights
 */
const DEFAULT_INSIGHTS_DATA = {
  "Health & Wellness": [
    "mental wellness",
    "Headspace",
    "nutrition tracking",
    "MyFitnessPal",
    "Healthline",
    "pediatric resources",
    "KidsHealth",
    "BabyCenter",
    "holistic health",
    "WebMD",
  ],
  "Food & Cooking": [
    "healthy recipes",
    "family-friendly recipes",
    "EatingWell",
    "Cooking Light",
    "meal planning",
    "savory pies",
    "quick recipes",
    "seasonal cooking",
  ],
  "Shopping & Deals": [
    "deal-seeking behavior",
    "RetailMeNot",
    "CouponCabin",
    "grocery shopping",
    "Walmart",
    "Costco",
    "budget-conscious purchases",
    "comparison shopping",
    "Amazon",
    "eBay",
  ],
  "Parenting & Family": [
    "child development",
    "family activities",
    "pregnancy resources",
    "BabyCenter",
    "WhatToExpect",
    "family-oriented meal planning",
  ],
  "Travel & Outdoor": [
    "SJC",
    "family-friendly trips",
    "hiking trails",
    "AllTrails",
    "REI",
    "Airbnb",
    "road trips",
    "outdoor gear research",
  ],
  "Fashion & Lifestyle": [
    "minimalist fashion",
    "sustainable fashion",
    "white t-shirts",
    "jeans",
    "ASOS",
    "Zara",
    "luxury brands",
    "Chanel",
    "Gucci",
    "affordable clothing",
  ],
  "Entertainment & Media": [
    "pop music playlists",
    "streaming",
    "Netflix",
    "Hulu",
    "Disney+",
    "movie theaters",
    "movie reviews",
    "IMDb",
    "Rotten Tomatoes",
    "anime",
    "news",
    "CNN",
    "BBC",
  ],
  "Productivity & Work": [
    "Google Workspace",
    "Trello",
    "Notion",
    "LinkedIn",
    "networking",
    "workflow optimization",
  ],
  "Academic & Research": [
    "scholarly resources",
    "Google Scholar",
    "JSTOR",
    "Coursera",
    "edX",
    "self-learning",
    "Khan Academy",
    "STEM focus",
    "biology",
    "engineering scholarships",
  ],
  "Home Improvement & DIY": [
    "interior design",
    "Houzz",
    "repairs",
    "Home Depot",
    "Lowe's",
    "organization projects",
  ],
  "Financial & Investment": [
    "market monitoring",
    "Yahoo Finance",
    "Bloomberg",
    "personal finance",
    "investment research",
  ],
  Other: [
    "book reading",
    "Goodreads",
    "local services",
    "Yelp",
    "cafes",
    "restaurants",
    "photography gear",
    "Sony cameras",
    "environmental awareness",
  ],
};

// ============================================================================
// History Analysis Functions
// ============================================================================

/**
 * Fetches recent browsing history
 *
 * @param {object} opts - Options for history query
 * @param {number} opts.days - Number of days to look back (default: 60)
 * @param {number} opts.maxResults - Maximum results (default: 500)
 * @returns {Promise<Array>} Array of history items with weights
 */
async function getRecentHistory(opts = {}) {
  const days = opts.days ?? 60;
  const maxResults = opts.maxResults ?? 500;

  try {
    const PlacesQuery = ChromeUtils.importESModule(
      "resource://gre/modules/PlacesQuery.sys.mjs"
    ).PlacesQuery;
    const query = new PlacesQuery();
    const historyMap = await query.getHistory({
      daysOld: days,
      limit: maxResults,
    });

    // Flatten the map structure into an array of items
    const items = [];
    for (const [timestamp, entries] of historyMap.entries()) {
      for (const entry of entries) {
        items.push({
          url: entry.url ?? "",
          title: entry.title ?? "",
          visit_time: entry.date
            ? entry.date.toISOString()
            : new Date(timestamp).toISOString(),
          visit_count: 1, // Each entry represents one visit
        });
      }
    }

    return items;
  } catch (error) {
    console.error("Failed to fetch history:", error);
    return [];
  }
}

/**
 * Applies half-life decay weighting to history items based on recency
 *
 * @param {Array} rows - History items
 * @param {number} halfLifeDays - Half-life in days (default: 14)
 * @returns {Array} History items with weight_score and weighted_visits
 */
function addWeights(rows, halfLifeDays = 14) {
  const now = new Date();
  return rows.map(r => {
    const visitTime = new Date(r.visit_time);
    const ageMs = Math.max(0, now.getTime() - visitTime.getTime());
    const ageDays = ageMs / 86400000;
    const weight_score = Math.pow(0.5, ageDays / halfLifeDays);
    const weighted_visits =
      Math.round(weight_score * (r.visit_count || 1) * 1000) / 1000;
    return { ...r, weight_score, weighted_visits };
  });
}

/**
 * Generates profile summary for LLM input
 * Groups by URL/title and calculates average weighted visits
 *
 * @param rows
 */
function generateProfileInputs(rows) {
  // Group by URL+title
  const acc = new Map();
  for (const r of rows) {
    const key = `${r.url}\u0001${r.title}`;
    const cur = acc.get(key);
    if (cur) {
      cur.sum += r.weighted_visits;
      cur.n += 1;
    } else {
      acc.set(key, {
        url: r.url,
        title: r.title,
        sum: r.weighted_visits,
        n: 1,
      });
    }
  }

  const profile_summarized = Array.from(acc.values())
    .map(v => ({
      url: v.url,
      title: v.title,
      weighted_visits: Math.round((v.sum / v.n) * 1000) / 1000,
    }))
    .sort((a, b) => b.weighted_visits - a.weighted_visits);

  // Extract search texts (titles with "search" in URL)
  const search_texts = {};
  for (const r of rows.filter(r => /search/i.test(r.url))) {
    const key = r.title || "(untitled)";
    if (!search_texts[key]) {
      search_texts[key] = 0;
    }
    search_texts[key] += r.weighted_visits;
  }

  return { profile_summarized, search_texts };
}

// ============================================================================
// Chat Analysis Functions
// ============================================================================

/**
 * Extracts user chat messages from Smart Window storage
 *
 * @param {object} opts - Options
 * @param {number} opts.days - Days to look back (default: 30)
 * @param {number} opts.maxConversations - Max conversations (default: 50)
 * @param {number} opts.halfLifeDays - Half-life for freshness (default: 14)
 * @returns {Promise<Array>} Chat data grouped by URL
 */
async function getUserChats(opts = {}) {
  const days = opts.days ?? 30;
  const maxConversations = opts.maxConversations ?? 50;
  const halfLifeDays = opts.halfLifeDays ?? 14;
  const startTime = Date.now() - days * 86400 * 1000;
  const nowMs = Date.now();

  try {
    // Get chat history from browser-smart-window.js
    // Format: Map(tabId -> [{role, content, ts}])
    const chatHistory =
      window.browsingContext?.topChromeWindow?.SmartWindow
        ?._chatMessagesByTab || new Map();

    const agg = new Map();

    for (const [tabId, msgs] of chatHistory.entries()) {
      if (!Array.isArray(msgs)) {
        continue;
      }

      for (const m of msgs) {
        if (m?.role.toLowerCase() !== "user") {
          continue;
        }
        if (typeof m.content !== "string") {
          continue;
        }
        const content = m.content.trim();
        if (!content) {
          continue;
        }

        const ts = Number(m.ts ?? 0);
        if (ts && ts < startTime) {
          continue;
        }

        if (!agg.has(tabId)) {
          agg.set(tabId, { messages: [], lastTs: 0 });
        }
        const bucket = agg.get(tabId);

        if (!bucket.messages.includes(content)) {
          bucket.messages.push(content);
        }
        if (ts > bucket.lastTs) {
          bucket.lastTs = ts;
        }
      }
    }

    // Calculate freshness scores and sort
    const result = Array.from(agg.entries())
      .map(([url, { messages, lastTs }]) => {
        const ageDays = (nowMs - lastTs) / 86400000;
        const freshness_score =
          ageDays <= 0
            ? 1
            : Math.max(
                0,
                Math.min(1, Math.exp(-Math.LN2 * (ageDays / halfLifeDays)))
              );
        return { url, messages, freshness_score };
      })
      .filter(x => !!x.messages.length)
      .sort((a, b) => b.freshness_score - a.freshness_score)
      .slice(0, maxConversations);

    return result;
  } catch (error) {
    console.error("Failed to fetch chat history:", error);
    return [];
  }
}

// ============================================================================
// LLM Prompt & Schema Definitions
// ============================================================================

const LIVE_INSIGHTS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 5,
  items: {
    type: "object",
    additionalProperties: false,
    required: [
      "category",
      "intent",
      "insight_summary",
      "insight_short",
      "score",
    ],
    properties: {
      category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
      intent: { type: ["string", "null"], enum: [...INTENTS, null] },
      insight_summary: { type: ["string", "null"] },
      insight_short: { type: ["string", "null"] },
      score: { type: "integer", minimum: 1, maximum: 5 },
    },
  },
};

/**
 * Extracts JSON from LLM response (handles code blocks)
 *
 * @param text
 */
function extractJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const payload = m ? m[1] : text;
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

/**
 * Builds user prompt for live insights generation (ARRAY of insights)
 *
 * @param {{profile_records: any[], related_insights: string[]}} params
 * @returns {string}
 */
export function buildLiveInsightPrompt({
  profile_records = [],
  related_insights = [],
} = {}) {
  const profile_snip = JSON.stringify(profile_records, null, 2);
  const insights_hint = JSON.stringify(related_insights, null, 2);
  const categoriesList = JSON.stringify(CATEGORIES);
  const intentsList = JSON.stringify(INTENTS);

  return `
You are a JSON generator. Use ONLY the provided user profile records and past insights.

## Inputs
- profile_records: ${profile_snip}
- related_insights: ${insights_hint}

## Category rules
Choose ONLY one from this list; if none fits, use null:
${categoriesList}

## Intent rules
Choose ONLY one from this list; if none fits, use null:
${intentsList}

## Insight rules (write 1 short, specific sentence)
- Style = <who/what + action + constraint>, 4–10 words, no trailing period.
- Must include at least 1 concrete entity (brand/site/product/event) OR a clear constraint (price, time, size, color).
- Vary verbs; avoid repetitive "buys/watches" when not aligned with intent.
- No vague phrasing like "various", "often".
- No duplicate of any item in related_insights (normalize case + remove punctuation before comparing).
- If no safe, specific insight is supported by Inputs, set "insight_summary": null.
- Examples of good form:
    - “Prefers LLBean & Nordstrom formalwear collections”
    - “Compares white jeans under $80 at Target”
    - “Streams new-release movies via Fandango”
    - “Cooks Mediterranean seafood from TasteAtlas recipes”
    - “Tracks minimalist fashion drops at Uniqlo”

## Short badge rules (insight_short)
- Exactly TWO words, Title Case, no punctuation or emojis.
- Summarize the essence of the insight_summary.
- Prefer <Brand + Item> or <Theme + Item> or <Constraint + Item>.
- Examples mapping:
    - “Prefers LLBean & Nordstrom formalwear collections” → “Formalwear Brands”
    - “Compares white jeans under $80 at Target” → “White Jeans”
    - “Streams new-release movies via Fandango” → “Movie Streaming”
    - “Cooks Mediterranean seafood from TasteAtlas recipes” → “Mediterranean Recipes”
    - “Tracks minimalist fashion drops at Uniqlo” → “Minimalist Fashion”

Return ONLY a JSON array (length 1–5) of objects, no prose, no code fences. Each object must have:
{
  "category": "<one of the categories or null>",
  "intent": "<one of the intents or null>",
  "insight_summary": "<4–10 words, crisp and specific or null>",
  "insight_short": "<TwoWords TitleCase or null>",
  "score": <integer 1-5>
}
`.trim();
}

// ============================================================================
// Main Insights Generation Functions
// ============================================================================

/**
 * Calls LLM to generate insights and processes the response
 *
 * @param {object} profile - Profile data to analyze
 * @param {string} source - Source type ('history' or 'conversation')
 * @returns {Promise<object>} Parsed JSON response with categories
 */
async function generateInsightsWithLLM(profile, source) {
  const profile_records =
    source === "history"
      ? (profile?.profile_summarized ?? profile ?? [])
      : Array.isArray(profile)
        ? profile
        : [];

  // TODO: pass your own shortlist if you maintain one
  const prompt = buildLiveInsightPrompt({
    profile_records,
    related_insights: [],
  });

  const engine = await createOpenAIEngine();
  const response = await engine.run({
    args: [
      {
        role: "system",
        content: "You are a precise data analyst. Return ONLY valid JSON.",
      },
      { role: "user", content: prompt },
    ],
    responseFormat: { type: "json_schema", schema: LIVE_INSIGHTS_SCHEMA },
  });

  const rawContent = response?.finalOutput ?? "";
  let list = extractJSON(rawContent);
  if (!Array.isArray(list)) {
    // Sometimes models wrap with an object; try to unwrap common patterns
    if (list && Array.isArray(list.items)) {
      list = list.items;
    }
  }

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("Failed to generate valid insight list");
  }

  return list; // array of insights
}

/**
 * Adds generated insights to storage.
 * - New: writes to `insightsDataByShort[insight_short] = { insight_summary, intent, category, score }`
 * - Legacy: also appends `insight_short` under its category array (unchanged behavior)
 *
 * @param {object|object[]} payload Array of insight objects or a single object
 * @returns {{ addedCount: number, upsertedByShort: number }}
 */
function addInsightsToData(payload) {
  const smartWindow = getSmartWindow();
  const insightsData = getInsightsData();

  const items = Array.isArray(payload) ? payload : [payload];

  // ensure new by-short index exists
  if (
    !insightsData.insightsDataByShort ||
    typeof insightsData.insightsDataByShort !== "object"
  ) {
    insightsData.insightsDataByShort = {};
  }

  let addedCount = 0; // legacy category -> label additions
  let upsertedByShort = 0; // new by-short upserts

  for (const obj of items) {
    const category = (obj?.category ?? "").trim();
    const short = (obj?.insight_short ?? "").trim();
    const summary = (obj?.insight_summary ?? "").trim();
    const intent = (obj?.intent ?? "").trim();
    const score = Number.isFinite(obj?.score) ? Number(obj.score) : null;

    // ---- New storage (keyed by insight_short) ----
    if (short) {
      const prev = insightsData.insightsDataByShort[short];
      // Upsert if new or summary changed (or we have better metadata)
      if (
        !prev ||
        (summary && summary !== prev.insight_summary) ||
        (category && category !== prev.category) ||
        (intent && intent !== prev.intent) ||
        (Number.isFinite(score) && score !== prev.score)
      ) {
        insightsData.insightsDataByShort[short] = {
          insight_short: short,
          insight_summary: summary || prev?.insight_summary || "",
          category: category || prev?.category || "",
          intent: intent || prev?.intent || "",
          score: Number.isFinite(score) ? score : (prev?.score ?? null),
        };
        upsertedByShort += 1;
      }
    }

    // ---- Legacy storage (category -> labels array) ----
    // Keep existing UI working by storing the short tag under the category.
    // Falls back to summary if short is missing.
    const label = summary;
    if (short) {
      if (!insightsData[short]) {
        insightsData[short] = [];
      }
      if (!insightsData[short].includes(label)) {
        insightsData[short].push(label);
      }
    }
  }

  smartWindow?.setInsightsData(insightsData);
  return { addedCount, upsertedByShort };
}

/**
 * Generates insights from browsing history using LLM
 *
 * @returns {Promise<void>}
 */
export async function generateInsightsFromHistory() {
  const smartWindow = getSmartWindow();

  if (smartWindow?.isGeneratingInsights()) {
    throw new Error("Already generating insights");
  }

  smartWindow?.setGeneratingInsights(true);
  smartWindow?.setInsightsError(null);

  try {
    console.log("[Insights] Fetching browsing history...");
    const baseRows = await getRecentHistory({ days: 60, maxResults: 500 });

    if (baseRows.length === 0) {
      throw new Error("No browsing history found");
    }

    console.log(`[Insights] Found ${baseRows.length} history items`);
    const rows = addWeights(baseRows, 14);
    const profile = generateProfileInputs(rows);

    console.log("[Insights] Generating insights with LLM...");
    const list = await generateInsightsWithLLM(profile, "history");

    const { addedCount } = addInsightsToData(list);
    console.log(
      `[Insights] Added ${addedCount}/${list.length} insights from history`
    );
  } catch (error) {
    console.error("[Insights] Generation failed:", error);
    const errorMsg = error.message || String(error);
    smartWindow?.setInsightsError(errorMsg);
    throw error;
  } finally {
    smartWindow?.setGeneratingInsights(false);
  }
}

/**
 * Generates insights from conversation history using LLM
 *
 * @returns {Promise<void>}
 */
export async function generateInsightsFromConversations() {
  const smartWindow = getSmartWindow();

  if (smartWindow?.isGeneratingInsights()) {
    throw new Error("Already generating insights");
  }

  smartWindow?.setGeneratingInsights(true);
  smartWindow?.setInsightsError(null);

  try {
    console.log("[Insights] Fetching conversation history...");
    const chatHistory = await getUserChats({
      days: 30,
      maxConversations: 50,
      halfLifeDays: 14,
    });

    if (chatHistory.length === 0) {
      throw new Error("No conversation history found");
    }

    console.log(`[Insights] Found ${chatHistory.length} conversations`);
    console.log("[Insights] Generating insights with LLM...");
    const list = await generateInsightsWithLLM(chatHistory, "conversation");
    const { addedCount } = addInsightsToData(list);
    console.log(
      `[Insights] Added ${addedCount}/${list.length} insights from conversations`
    );
  } catch (error) {
    console.error("[Insights] Generation failed:", error);
    const errorMsg = error.message || String(error);
    smartWindow?.setInsightsError(errorMsg);
    throw error;
  } finally {
    smartWindow?.setGeneratingInsights(false);
  }
}

/**
 * Clears all generated insights
 */
export function clearGeneratedInsights() {
  const smartWindow = getSmartWindow();
  smartWindow?.setInsightsData({});
  console.log("[Insights] Cleared generated insights");
}

/**
 * Gets current generation state
 */
export function getInsightsState() {
  const smartWindow = getSmartWindow();
  const insightsData = getInsightsData();

  // Count total generated insights across all categories
  let generatedCount = 0;
  for (const category in insightsData) {
    if (Array.isArray(insightsData[category])) {
      generatedCount += insightsData[category].length;
    }
  }

  return {
    isGenerating: smartWindow?.isGeneratingInsights() || false,
    error: smartWindow?.getInsightsError() || null,
    generatedCount,
  };
}

/**
 * Builds the system prompt with insights data
 * Uses generated insights if available, otherwise uses default placeholder data
 */
export function buildInsightsSystemPrompt() {
  const insightsData = getInsightsData();

  // Safe fallback if DEFAULT_INSIGHTS_DATA is commented out
  const defaultFallback =
    typeof DEFAULT_INSIGHTS_DATA !== "undefined" ? DEFAULT_INSIGHTS_DATA : {};

  // Use generated insights if available, otherwise fall back to defaults
  const dataToUse = Object.keys(insightsData).length
    ? insightsData
    : DEFAULT_INSIGHTS_DATA;

  let systemPrompt = `
When responding, if you use any user insights from the list below to personalize your response (even implicitly), you must reference them by including [[insight: specific term]] inline, directly after the phrase or sentence where the insight is applied. Use specific terms from the list rather than broad categories, and include multiple tags if multiple insights are relevant. This enables better personalization features—do not skip tagging if an insight influences your answer. Only tag insights you actually use; avoid tagging irrelevant ones.

User Insights List:`;

  // Build insights list from data
  Object.entries(dataToUse).forEach(([category, insights]) => {
    if (insights.length) {
      const insightString = insights.join(", ");
      systemPrompt += `\n- ${category}: ${insightString}.`;
    }
  });

  systemPrompt += `

Examples of Insight Tagging:
- User asks about flights: Weave in personalization like "Since you often fly from SJC [[insight: SJC]], consider direct options..."
- User asks about meals: "This recipe fits your interest in seasonal cooking [[insight: seasonal cooking]] and healthy recipes [[insight: healthy recipes]]."
- User asks about shoes: "For hiking boots, check REI [[insight: REI]] based on your outdoor gear research [[insight: outdoor gear research]]."`;

  return systemPrompt;
}

/**
 * Deletes an insight from the INSIGHTS_DATA object
 *
 * @param insight
 * @param category
 */
export function deleteInsight(insight, category) {
  const smartWindow = getSmartWindow();
  const insightsData = getInsightsData();

  if (insightsData[category]) {
    const index = insightsData[category].indexOf(insight);
    if (index > -1) {
      insightsData[category].splice(index, 1);
      smartWindow?.setInsightsData(insightsData);
      return true;
    }
  }
  return false;
}

/**
 * Detects insight tokens in content
 *
 * @param content
 */
export function detectInsightTokens(content) {
  const insightRegex = /\[\[insight:\s*([^\]]+)\]\]/gi;
  const matches = [];
  let match;

  while ((match = insightRegex.exec(content)) !== null) {
    matches.push({
      fullMatch: match[0],
      insight: match[1].trim(),
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  return matches;
}

/**
 * Creates a clickable insight token element
 *
 * @param insight
 * @param onInsightClick
 */
export function createClickableInsightToken(insight, onInsightClick) {
  return html`
    <span
      class="insight-tag clickable"
      @click=${() => onInsightClick(insight)}
      title="Click to view all insights"
    >
      ${insight}
    </span>
  `;
}

/**
 * Creates the insights overlay component
 *
 * @param onClose
 * @param usedInsights
 * @param onDeleteInsight
 */
export function createInsightsOverlay(
  onClose,
  usedInsights = new Set(),
  onDeleteInsight = null
) {
  const state = getInsightsState();
  const insightsData = getInsightsData();

  // Use generated insights if available, otherwise show defaults for UI
  const dataToDisplay = Object.keys(insightsData).length
    ? insightsData
    : DEFAULT_INSIGHTS_DATA;

  const handleGenerateHistory = async () => {
    try {
      await generateInsightsFromHistory();
      // Force re-render by triggering a state change
      window.dispatchEvent(new CustomEvent("insights-updated"));
    } catch (error) {
      console.error("Failed to generate insights from history:", error);
    }
  };

  const handleGenerateConversations = async () => {
    try {
      await generateInsightsFromConversations();
      window.dispatchEvent(new CustomEvent("insights-updated"));
    } catch (error) {
      console.error("Failed to generate insights from conversations:", error);
    }
  };

  const handleClearGenerated = () => {
    clearGeneratedInsights();
    window.dispatchEvent(new CustomEvent("insights-updated"));
  };

  return html`
    <div class="insights-overlay" @click=${onClose}>
      <div class="insights-modal" @click=${e => e.stopPropagation()}>
        <div class="insights-header">
          <h3>
            Transparency dashboard
            ${usedInsights.size > 0
              ? html`<span class="used-count">${usedInsights.size} used</span>`
              : ""}
          </h3>
          <button class="close-btn" @click=${onClose}>×</button>
        </div>

        <div class="insights-actions">
          <button
            class="action-btn primary"
            @click=${handleGenerateHistory}
            ?disabled=${state.isGenerating}
          >
            ${state.isGenerating ? "Analyzing..." : "Analyze History"}
          </button>
          <button
            class="action-btn primary"
            @click=${handleGenerateConversations}
            ?disabled=${state.isGenerating}
          >
            ${state.isGenerating ? "Analyzing..." : "Analyze Conversations"}
          </button>
          <button
            class="action-btn secondary"
            @click=${handleClearGenerated}
            ?disabled=${state.isGenerating || state.generatedCount === 0}
          >
            Clear Generated
          </button>
        </div>

        ${state.isGenerating
          ? html`<div class="loading-indicator">
              <div class="spinner"></div>
              <span>Generating insights...</span>
            </div>`
          : ""}
        ${state.error
          ? html`<div class="error-message">Error: ${state.error}</div>`
          : ""}

        <div class="insights-content">
          ${(() => {
            // Only keep keys whose value is an ARRAY (i.e., categories).
            // we switched from categories to insights as below
            // categories -> insights
            // category -> insight_short
            // insights -> insight_summary
            const insights = Object.entries(dataToDisplay)
              .filter(([, value]) => Array.isArray(value))
              .map(([insight_short, insight_summary]) => {
                const usedCount = insight_summary.reduce(
                  (acc, it) => acc + (usedInsights.has(it) ? 1 : 0),
                  0
                );
                return { insight_short, insight_summary, usedCount };
              })
              .filter(({ insight_summary }) => !!insight_summary.length)
              .sort((a, b) => {
                if (a.usedCount !== b.usedCount) {
                  return b.usedCount - a.usedCount;
                }
                return a.insight_short.localeCompare(b.insight_short);
              });

            return insights.map(
              ({ insight_short, insight_summary }) => html`
                <div class="insight-category">
                  <h4>${insight_short}</h4>
                  <div class="insight-items">
                    ${insight_summary.map(insight => {
                      const isUsed = usedInsights.has(insight);
                      return html`
                        <span
                          class="insight-item ${isUsed ? "used" : ""}"
                          title=${isUsed ? "Used in this conversation" : ""}
                        >
                          <span class="insight-text">${insight}</span>
                          ${onDeleteInsight
                            ? html`
                                <button
                                  class="delete-insight-btn"
                                  @click=${e => {
                                    e.stopPropagation();
                                    onDeleteInsight(insight, insight_short);
                                  }}
                                  title="Delete this insight"
                                >
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                  >
                                    <path
                                      d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"
                                      stroke="currentColor"
                                      stroke-width="2"
                                      stroke-linecap="round"
                                      stroke-linejoin="round"
                                    />
                                    <line
                                      x1="10"
                                      y1="11"
                                      x2="10"
                                      y2="17"
                                      stroke="currentColor"
                                      stroke-width="2"
                                      stroke-linecap="round"
                                    />
                                    <line
                                      x1="14"
                                      y1="11"
                                      x2="14"
                                      y2="17"
                                      stroke="currentColor"
                                      stroke-width="2"
                                      stroke-linecap="round"
                                    />
                                  </svg>
                                </button>
                              `
                            : ""}
                        </span>
                      `;
                    })}
                  </div>
                </div>
              `
            );
          })()}
        </div>
      </div>
    </div>
  `;
}

/**
 * CSS styles for insights functionality
 */
export const insightsStyles = css`
  .insight-tag {
    font-size: 0.75rem;
    background: #e8f4fd;
    color: #0066cc;
    padding: 0.25rem 0.5rem;
    border-radius: 12px;
    border: 1px solid #b3d7f2;
  }

  .insight-tag.clickable {
    cursor: pointer;
    transition: all 0.2s;
  }

  .insight-tag.clickable:hover {
    background: #d4edfc;
    border-color: #8cc8ea;
    transform: translateY(-1px);
  }

  .insights-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .insights-modal {
    background: white;
    border-radius: 8px;
    max-width: 800px;
    max-height: 80vh;
    width: 90%;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
  }

  .insights-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    background: #f8f9fa;
  }

  .insights-header h3 {
    margin: 0;
    color: #333;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .used-count {
    font-size: 0.75rem;
    font-weight: 500;
    background: #e8f4fd;
    color: #0066cc;
    padding: 0.25rem 0.5rem;
    border-radius: 12px;
    border: 1px solid #b3d7f2;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #666;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
  }

  .close-btn:hover {
    background: #e0e0e0;
  }

  .insights-content {
    padding: 1.5rem;
    max-height: 60vh;
    overflow-y: auto;
  }

  .insight-category {
    margin-bottom: 1.5rem;
  }

  .insight-category:last-child {
    margin-bottom: 0;
  }

  .insight-category h4 {
    margin: 0 0 0.75rem 0;
    color: #0066cc;
    font-weight: 600;
    border-bottom: 2px solid #e8f4fd;
    padding-bottom: 0.25rem;
  }

  .insight-items {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .insight-item {
    font-size: 0.75rem;
    background: #f0f0f0;
    color: #333;
    padding: 0.25rem 0.5rem;
    border-radius: 8px;
    border: 1px solid #d0d0d0;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    position: relative;
  }

  .insight-item:hover {
    background: #e8e8e8;
  }

  .insight-item.used {
    background: #e8f4fd;
    color: #0066cc;
    border-color: #b3d7f2;
    font-weight: 600;
    box-shadow: 0 2px 4px rgba(0, 102, 204, 0.1);
  }

  .insight-item.used:hover {
    background: #d4edfc;
  }

  .insight-text {
    flex: 1;
  }

  .insights-actions {
    display: flex;
    gap: 0.5rem;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    background: #fafbfc;
  }

  .action-btn {
    padding: 0.5rem 1rem;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 0.2s;
    font-weight: 500;
  }

  .action-btn.primary {
    background: #0066cc;
    color: white;
    border-color: #0052a3;
  }

  .action-btn.primary:hover:not(:disabled) {
    background: #0052a3;
  }

  .action-btn.secondary {
    background: white;
    color: #666;
  }

  .action-btn.secondary:hover:not(:disabled) {
    background: #f5f5f5;
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .loading-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 1rem;
    background: #f8f9fa;
    border-bottom: 1px solid #e0e0e0;
    color: #666;
    font-size: 0.875rem;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid #e0e0e0;
    border-top-color: #0066cc;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-message {
    padding: 0.75rem 1rem;
    background: #fee;
    border-left: 4px solid #c00;
    color: #800;
    font-size: 0.875rem;
    margin: 0 1.5rem 1rem;
    border-radius: 4px;
  }

  .delete-insight-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: #666;
    padding: 0.25rem;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: all 0.2s;
    margin: 0;
  }

  .insight-item:hover .delete-insight-btn {
    opacity: 1;
  }

  .delete-insight-btn:hover {
    background: #ff4444;
    color: white;
  }

  .used-insights {
    margin-top: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .insights-label {
    font-size: 0.75rem;
    color: #666;
    font-weight: 500;
  }
`;
