/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { html, css, render } from "chrome://global/content/vendor/lit.all.mjs";
import { createOpenAIEngine } from "./utils.mjs";

const { ChatHistory, ChatHistoryMessage } = ChromeUtils.importESModule(
  "resource:///modules/smartwindow/ChatHistory.sys.mjs"
);

/**
 * CSS styles for insights functionality
 */
export let insightsStyles;

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

// Higher is better: user > chat > search > history
const SOURCE_PRIORITY = {
  user: 4,
  chat: 3,
  conversation: 3, // in case chat rows use "conversation"
  search: 2,
  history: 1,
};

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

/**
 * Fetch recent browsing history from Places (SQL), aggregate by URL,
 * tag "search" vs "history", and filter low-visit URLs.
 *
 * @param {object} opts
 * @param {number} [opts.days=60]          How far back to look
 * @param {number} [opts.maxResults=500]   Max rows to return (after sort)
 * @param {number} [opts.minVisits=2]      Keep URLs with >= this many visits
 * @returns {Promise<Array<{url:string,title:string,domain:string,visit_time:string,visit_count:number,source:'history'|'search'}>>}
 */
async function getRecentHistory(opts = {}) {
  const days = opts.days ?? 60;
  const maxResults = opts.maxResults ?? 500;
  const minVisits = opts.minVisits ?? 3;

  const { PlacesUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PlacesUtils.sys.mjs"
  );

  // Places stores visit_date in microseconds since epoch.
  const cutoffMicros = Math.max(0, (Date.now() - days * 86400000) * 1000);

  const isSearchVisit = urlStr => {
    try {
      const u = new URL(urlStr);
      const h = u.hostname || "";
      const p = u.pathname || "";
      const q = u.search || "";

      const isSE =
        /(^|\.)(google|bing|duckduckgo|search\.brave|yahoo|startpage|ecosia|baidu|yandex)\./i.test(
          h
        );
      const looksLikeSearch =
        /search|results|query/i.test(p) || /[?&](q|query|p)=/i.test(q);

      return isSE || looksLikeSearch;
    } catch {
      return false;
    }
  };

  const getDomain = urlStr => {
    try {
      return new URL(urlStr ?? "").hostname;
    } catch {
      return "";
    }
  };

  // We:
  // 1) pull the last N days of visits,
  // 2) group by place (URL) to get count + last visit time,
  // 3) sort by last visit desc and cap with :maxResults (SQL-side),
  // 4) compute source by URL heuristic (JS-side).
  const SQL = `
    WITH recent AS (
      SELECT
        p.id            AS place_id,
        p.url           AS url,
        p.title         AS title,
        MAX(v.visit_date) AS last_visit,
        COUNT(*)        AS visit_count
      FROM moz_places p
      JOIN moz_historyvisits v ON v.place_id = p.id
      WHERE v.visit_date >= :cutoff
      GROUP BY p.id
      ORDER BY last_visit DESC
      LIMIT :limit
    )
    SELECT
      r.url      AS url,
      r.title    AS title,
      r.last_visit AS last_visit,
      r.visit_count AS visit_count
    FROM recent r
    -- (domain will be parsed in JS for consistency)
  `;

  try {
    const rows = await PlacesUtils.withConnectionWrapper(
      "smartwindow-getRecentHistory",
      async db => {
        const stmt = await db.execute(SQL, {
          cutoff: cutoffMicros,
          limit: maxResults,
        });

        const out = [];
        for (const row of stmt) {
          const url = row.getResultByName("url");
          const title = row.getResultByName("title") || "";
          const lastVisitMicros = row.getResultByName("last_visit") || 0;
          const visitCount = row.getResultByName("visit_count") || 0;

          out.push({
            url,
            title,
            domain: getDomain(url),
            visit_time: new Date(
              Math.floor(lastVisitMicros / 1000)
            ).toISOString(),
            visit_count: visitCount,
            source: isSearchVisit(url) ? "search" : "history",
          });
        }
        return out;
      }
    );

    // console.debug(`rows = ${JSON.stringify(rows)}`);
    // Filter by minVisits (keep URLs visited >= minVisits)
    const filtered = rows.filter(r => r.visit_count >= minVisits);

    // Already sorted by last visit desc from SQL, but ensure:
    filtered.sort((a, b) => (a.visit_time < b.visit_time ? 1 : -1));
    // console.debug(`filtered = ${JSON.stringify(filtered)}`);
    return filtered;
  } catch (error) {
    console.error("Failed to fetch Places history via SQL:", error);
    return [];
  }
}

/**
 * Applies half-life decay weighting + source priority.
 *
 * @param {Array<{visit_time:string, visit_count:number, source?:string}>} rows
 * @param {number} [halfLifeDays=14]
 * @returns {Array}
 */
function addWeights(rows, halfLifeDays = 14) {
  const nowMs = Date.now();

  return rows.map(row => {
    const visitMs = new Date(row.visit_time).getTime() || 0;
    const ageDays = Math.max(0, (nowMs - visitMs) / 86400000);

    // Recency via half-life
    const recency_weight = Math.pow(0.5, ageDays / halfLifeDays);

    // Source priority (default history=1)
    const source_weight =
      SOURCE_PRIORITY[(row.source || "").toLowerCase()] ?? 1;

    // Soft visit-count factor: log-scaled and capped
    //  - 1 visit -> ~1.0
    //  - 3 visits -> ~1.4
    //  - 10 visits -> ~1.7
    //  - 100+ visits -> cap at ~2.0
    const rawCount = Math.max(1, Number(row.visit_count) || 1);
    const count_weight = Math.min(2.0, 1 + 0.4 * Math.log1p(rawCount));

    const weight_score = source_weight * recency_weight;
    const weighted_visits = Number((weight_score * count_weight).toFixed(3));

    return {
      ...row,
      recency_weight,
      source_weight,
      count_weight,
      weight_score, // source * recency
      weighted_visits, // final score (for ranking)
    };
  });
}

/**
 * Sort: source tier → weighted_visits → recency → most recent
 *
 * @param {{source?: string, weighted_visits?: number, recency_weight?: number, visit_time?: string}} a
 * @param {{source?: string, weighted_visits?: number, recency_weight?: number, visit_time?: string}} b
 * @returns {number}
 */
function sortBySignal(a, b) {
  const sa = SOURCE_PRIORITY[(a.source || "").toLowerCase()] ?? 1;
  const sb = SOURCE_PRIORITY[(b.source || "").toLowerCase()] ?? 1;

  if (sb !== sa) {
    return sb - sa;
  } // source first
  if (b.weighted_visits !== a.weighted_visits) {
    return b.weighted_visits - a.weighted_visits;
  } // overall score
  if (b.recency_weight !== a.recency_weight) {
    return b.recency_weight - a.recency_weight;
  } // tie-break
  return a.visit_time < b.visit_time ? 1 : -1; // newest last
}

/**
 * Generates profile summary for LLM input.
 * Groups by URL/title and calculates average weighted visits.
 *
 * @param {Array<{
 *   url: string,
 *   title: string,
 *   domain?: string,
 *   visit_time?: string,
 *   visit_count?: number,
 *   source?: string,
 *   recency_weight?: number,
 *   source_weight?: number,
 *   count_weight?: number,
 *   weight_score?: number,
 *   weighted_visits?: number
 * }>} rows
 * @returns {{ profile_summarized: Array<{url:string, title:string, weighted_visits:number}>, search_texts: Record<string, number> }}
 */
function generateProfileInputs(rows) {
  // Group by URL+title
  const acc = new Map();
  for (const row of rows) {
    const key = `${row.url}\u0001${row.title}`;
    const cur = acc.get(key);
    if (cur) {
      cur.sum += row.weighted_visits;
      cur.n += 1;
    } else {
      acc.set(key, {
        url: row.url,
        title: row.title,
        sum: row.weighted_visits,
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
  for (const searchRow of rows.filter(x => /search/i.test(x.url))) {
    const key = searchRow.title || "(untitled)";
    if (!search_texts[key]) {
      search_texts[key] = 0;
    }
    search_texts[key] += searchRow.weighted_visits;
  }

  return { profile_summarized, search_texts };
}

// ============================================================================
// Chat Analysis Functions
// ============================================================================

async function getChatHistoryAsMap(days) {
  const chatHistory = new ChatHistory();
  const endDate = Date.now();
  const timeWindowInMs = days * 24 * 60 * 60 * 1000;
  const startDate = endDate - timeWindowInMs;

  const conversations = await chatHistory.findConversationsByDate(
    startDate,
    endDate
  );

  return conversations.reduce((mapping, conversation) => {
    mapping.set(conversation.pageUrl, conversation.messages);

    return mapping;
  }, new Map());
}

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
    // Get chat history from ChatHistory.sys.mjs as Map
    // from getChatHistoryAsMap(days)
    //
    // Format: Map(pageUrl -> [ChatHistoryMessage]) (browser/components/smartwindow/ChatHistory.sys.mjs)
    //

    const messagesMap = await getChatHistoryAsMap(days);

    const agg = new Map();

    for (const [pageUrl, msgs] of messagesMap.entries()) {
      if (!Array.isArray(msgs)) {
        continue;
      }

      for (const m of msgs) {
        const msgRole = ChatHistoryMessage.getRoleLabel(m?.role ?? "");
        if (msgRole.toLowerCase() !== "user") {
          continue;
        }

        if (typeof m.content !== "string") {
          continue;
        }

        const content = m.content.trim();
        if (!content) {
          continue;
        }

        const ts = Number(m.createdDate ?? 0);
        if (ts && ts < startTime) {
          continue;
        }

        if (!agg.has(pageUrl)) {
          agg.set(pageUrl, { messages: [], lastTs: 0 });
        }
        const bucket = agg.get(pageUrl);

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
 * @param {string} text
 * @returns {any}
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
- Dont include person name unless they are popular to avoid any PII.
- Dont generate insight from just odd one visit.
- The insights are generated based on a pattern of visits.
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

## Scoring priorities (important)
- Base "score" on both *strength* and *recency* of evidence.
- Boost if evidence comes from higher-priority sources:
  user (highest) > chat/conversation > search > history (lowest).
- Penalize insights supported only by stale, low-frequency history.
- A recent history signal can reach 1; consistent multi-source evidence can be 1-2.
- A recent search signal can reach 2; consistent multi-source evidence can be 2-3.
- A single recent chat signal can reach 4; 
- A single recent user signal can reach 5;
- Do not assign 5 unless the pattern is strong and recent.

Return ONLY a JSON array (length 1–10) of objects, no prose, no code fences. Each object must have:
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
  // const profile_records =
  //   source === "history"
  //     ? (profile?.profile_summarized ?? profile ?? [])
  //     : Array.isArray(profile)
  //       ? profile
  //       : [];
  let profile_records = [];
  if (source === "history") {
    profile_records = profile?.profile_summarized ?? profile ?? [];
  } else if (Array.isArray(profile)) {
    profile_records = profile;
  }

  const promptText = buildLiveInsightPrompt({
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
      { role: "user", content: promptText },
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
    const rows = addWeights(baseRows, 14).sort(sortBySignal);
    // console.debug(`rows after sortBySignal = ${JSON.stringify(rows)}`);

    const profile = generateProfileInputs(rows);

    // console.debug(`profile = ${JSON.stringify(profile)}`);
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

    // console.debug(`chatHistory = ${JSON.stringify(chatHistory)}`);
    console.log(`[Insights] Found ${chatHistory.length} conversations`);
    console.log("[Insights] Generating insights with LLM...");
    const list = await generateInsightsWithLLM(chatHistory, "conversation");
    // console.debug(`list = ${JSON.stringify(list)}`);
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
 * Deletes an insight from storage
 *
 * @param {string} insight
 * @param {string} category
 * @returns {boolean}
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
 * Detects [[insight: ...]] tokens in content
 *
 * @param {string} content
 * @returns {Array<{fullMatch:string, insight:string, startIndex:number, endIndex:number}>}
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
 * @param {string} insight
 * @param {(insight:string)=>void} onInsightClick
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
 * @param {() => void} onClose
 * @param {Set<string>} usedInsights
 * @param {(insight:string, category:string) => void|null} onDeleteInsight
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
    <style>
      ${insightsStyles?.cssText ?? ""}
    </style>
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

// Define insightsStyles
insightsStyles = css`
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

/**
 * Auto-render overlay when loaded as about:insights.
 * Renders into a #overlay-root element (creates it if missing).
 */
function autoRenderOverlayForAboutInsights() {
  // Only activate when the document is about:insights
  const isAboutInsights =
    (document.documentURI || "").startsWith("about:insights") ||
    (document.documentURI || "").endsWith("insights.html");
  if (!isAboutInsights) {
    return;
  }

  const ensureOverlayRoot = () => {
    let root = document.getElementById("overlay-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "overlay-root";
      document.body.appendChild(root);
    }
    return root;
  };

  const root = ensureOverlayRoot();
  const onClose = () => render(null, root);
  render(createInsightsOverlay(onClose), root);
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    autoRenderOverlayForAboutInsights,
    { once: true }
  );
} else {
  autoRenderOverlayForAboutInsights();
}
