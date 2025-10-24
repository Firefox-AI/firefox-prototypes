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

// // Higher is better: user > chat > search > history
//   user: 4,
//   chat: 3,
//   conversation: 3, // in case chat rows use "conversation"
//   search: 2,
//   history: 1,

/**
 * User insights data organized by category
 * Static data serves as placeholder until user generates insights
 */
const DEFAULT_INSIGHTS_DATA = {};

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

      return isSE && looksLikeSearch;
    } catch {
      return false;
    }
  };

  const SQL = `
    WITH visit_info AS (
      SELECT
        p.id                     AS place_id,
        p.url                    AS url,
        o.host                   AS host,
        p.title                  AS title,
        v.visit_date             AS visit_date,
        p.frecency               AS frecency,
        CASE WHEN o.frecency = -1 THEN 1 ELSE o.frecency END AS domain_frecency
      FROM moz_places p
      JOIN moz_historyvisits v ON v.place_id = p.id
      JOIN moz_origins o       ON p.origin_id = o.id
      WHERE v.visit_date >= :cutoff
        AND p.title IS NOT NULL
        AND p.frecency IS NOT NULL
      ORDER BY v.visit_date DESC
      LIMIT :limit
    ),

    /* Collapse to one row per place to compute percentiles (like your groupby/place_id mean) */
    per_place AS (
      SELECT
        place_id,
        MAX(frecency)         AS frecency,         -- frecency is per-place; MAX/AVG are equivalent if stable
        MAX(domain_frecency)  AS domain_frecency
      FROM visit_info
      GROUP BY place_id
    ),

    /* Percentiles using window function CUME_DIST() */
    per_place_with_pct AS (
      SELECT
        place_id,
        ROUND(100.0 * CUME_DIST() OVER (ORDER BY frecency),        2) AS frecency_pct,
        ROUND(100.0 * CUME_DIST() OVER (ORDER BY domain_frecency), 2) AS domain_frecency_pct
      FROM per_place
    )

    /* Final rows: original visits + joined percentiles + source label */
    SELECT
      v.url,
      v.host,
      v.title,
      v.visit_date,
      p.frecency_pct,
      p.domain_frecency_pct
    FROM visit_info v
    JOIN per_place_with_pct p USING (place_id)
    ORDER BY v.visit_date DESC
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
          const host = row.getResultByName("host");
          const title = row.getResultByName("title") || "";
          const visitDateMicros = row.getResultByName("visit_date") || 0;
          const frequencyPct = row.getResultByName("frecency_pct") || 0;
          const domainFrequencyPct =
            row.getResultByName("domain_frecency_pct") || 0;

          out.push({
            url,
            domain: host,
            title,
            visitDateMicros,
            frequencyPct,
            domainFrequencyPct,
            source: isSearchVisit(url) ? "search" : "history",
          });
        }
        return out;
      }
    );
    return rows;
  } catch (error) {
    console.error("Failed to fetch Places history via SQL:", error);
    return [];
  }
}

/**
 * Sessionize visits using a 15-min gap and 2-hour max session length.
 * Mutates and returns a new array with session_id + session_start fields.
 *
 * @param {Array<{visitDateMicros:number}>} rows
 * @param {number} gapSec         - max allowed gap between consecutive visits in a session (default 900s = 15m)
 * @param {number} maxSessionSec  - max session duration from first to current visit (default 7200s = 2h)
 * @returns {Array} new array sorted by time asc with session_id, session_start_ms, session_start_iso
 */
function sessionizeVisits(rows, gapSec = 15 * 60, maxSessionSec = 2 * 60 * 60) {
  // 1) normalize timestamps (μs -> ms), drop invalid
  const normalized = rows
    .map(r => {
      const tMs = Number.isFinite(r.visitDateMicros)
        ? Math.floor(r.visitDateMicros / 1000) // μs -> ms
        : NaN;
      return { ...r, visitTimeMs: tMs };
    })
    .filter(r => Number.isFinite(r.visitTimeMs));

  // 2) sort ascending by time
  normalized.sort((a, b) => a.visitTimeMs - b.visitTimeMs);

  // 3) sessionize
  let sessId = 0;
  let curStartMs = null;
  let prevMs = null;

  for (const r of normalized) {
    const tMs = r.visitTimeMs;

    if (prevMs === null) {
      // first row
      curStartMs = tMs;
      r.session_id = sessId;
      r.session_start_ms = curStartMs;
      r.session_start_iso = new Date(curStartMs).toISOString();
    } else {
      const gapOk = (tMs - prevMs) / 1000 <= gapSec;
      const lenOk = (tMs - curStartMs) / 1000 <= maxSessionSec;

      if (!gapOk || !lenOk) {
        // start a new session
        sessId += 1;
        curStartMs = tMs;
      }
      r.session_id = sessId;
      r.session_start_ms = curStartMs;
      r.session_start_iso = new Date(curStartMs).toISOString();
    }

    prevMs = tMs;
  }

  return normalized;
}

/* ---------- helpers ---------- */
const unique = arr => [...new Set(arr)];
const isFiniteNumber = v => typeof v === "number" && Number.isFinite(v);

// normalize ns/us/ms/s -> seconds (float, 3dp)
function normalizeEpochSeconds(ts) {
  if (ts == null) {
    return null;
  }
  let x = Number(ts);
  if (!Number.isFinite(x)) {
    return null;
  }
  if (x > 1e14) {
    x /= 1e9;
  } // ns
  else if (x > 1e11) {
    x /= 1e6;
  } // us
  else if (x > 1e10) {
    x /= 1e3;
  } // ms
  // else assume seconds
  return Math.round(x * 1000) / 1000;
}

// deep “to_native” sanitizer: stringify keys, drop NaN/Infinity -> null
function toNative(o) {
  if (Array.isArray(o)) {
    return o.map(toNative);
  }
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      out[String(k)] = toNative(v);
    }
    return out;
  }
  if (typeof o === "number") {
    return Number.isFinite(o) ? o : null;
  }
  if (typeof o === "boolean" || typeof o === "string" || o == null) {
    return o;
  }
  try {
    return String(o);
  } catch {
    return null;
  }
}

function _toSeconds(ts) {
  // Normalize sec/ms/µs → seconds (float)
  if (ts == null) {
    return 0.0;
  }
  let x = Number(ts);
  if (!Number.isFinite(x)) {
    return 0.0;
  }
  if (x > 1e15) {
    return x / 1e6;
  } // microseconds
  if (x > 1e12) {
    return x / 1e3;
  } // milliseconds
  return x; // seconds (or small float)
}

function round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

// get or init helper for plain objects holding Set fields
function getOrInit(obj, key, initFn) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    obj[key] = initFn();
  }
  return obj[key];
}

function generateProfileInputs(rows) {
  /* ---------- index by session ---------- */
  const bySession = new Map();
  for (const r of rows) {
    const sid = r.session_id;
    if (!bySession.has(sid)) {
      bySession.set(sid, []);
    }
    bySession.get(sid).push(r);
  }

  /* ---------- 1) title_with_frecency_pct_for_sessions_lkp ---------- */
  // session_id -> { title: frecency_pct }
  const title_with_frecency_pct_for_sessions_lkp = {};
  for (const [sid, items] of bySession) {
    const m = {};
    for (const r of items) {
      const title = r.title ?? "";
      const pct = r.frequencyPct; // already a percentage (float)
      if (title && isFiniteNumber(pct)) {
        m[title] = pct;
      }
    }
    title_with_frecency_pct_for_sessions_lkp[sid] = m;
  }

  /* ---------- 2) domain_with_frecency_pct_for_sessions_lkp ---------- */
  // session_id -> { host: domain_frecency_pct }
  const domain_with_frecency_pct_for_sessions_lkp = {};
  for (const [sid, items] of bySession) {
    const m = {};
    for (const r of items) {
      const host = r.domain ?? r.host ?? "";
      const pct = r.domainFrequencyPct;
      if (host && isFiniteNumber(pct)) {
        m[host] = pct;
      }
    }
    domain_with_frecency_pct_for_sessions_lkp[sid] = m;
  }

  /* ---------- 3) session_search_summary_lkp ---------- */
  // session_id -> { search_count, search_titles (unique), last_searched }
  const session_search_summary_lkp = {};
  for (const [sid, items] of bySession) {
    const searchItems = items.filter(r => r.source === "search");
    if (searchItems.length === 0) {
      session_search_summary_lkp[sid] = {};
      continue;
    }
    const search_titles = unique(searchItems.map(r => r.title).filter(Boolean));
    // choose the same raw timestamp field you use elsewhere (visitDateMicros)
    const last_searched_raw = Math.max(
      ...searchItems.map(r => Number(r.visitDateMicros) || 0)
    );
    session_search_summary_lkp[sid] = {
      session_id: sid,
      search_count: searchItems.length,
      search_titles,
      // keep raw us/ms/etc.
      last_searched: last_searched_raw,
    };
  }

  /* ---------- 4) session_times_lkp ---------- */
  const session_times_lkp = { start_time: {}, end_time: {} };
  for (const [sid, items] of bySession) {
    // you used visit_date (microseconds) in pandas; here use visitDateMicros to match your rows
    const tsList = items
      .map(r => Number(r.visitDateMicros))
      .filter(n => Number.isFinite(n));
    if (tsList.length) {
      session_times_lkp.start_time[sid] = Math.min(...tsList);
      session_times_lkp.end_time[sid] = Math.max(...tsList);
    } else {
      session_times_lkp.start_time[sid] = null;
      session_times_lkp.end_time[sid] = null;
    }
  }

  /* ---------- 5) build prepared_inputs ---------- */
  const prepared_inputs = [];
  for (const sid of bySession.keys()) {
    const rec = {
      session_id: sid,
      title_scores: title_with_frecency_pct_for_sessions_lkp[sid] || {},
      domain_scores: domain_with_frecency_pct_for_sessions_lkp[sid] || {},
      session_start_time: normalizeEpochSeconds(
        session_times_lkp.start_time[sid]
      ),
      session_end_time: normalizeEpochSeconds(session_times_lkp.end_time[sid]),
      search_events: session_search_summary_lkp[sid] || {},
    };
    prepared_inputs.push(toNative(rec));
  }
  return prepared_inputs;
}

function aggregateSessions(prepared_inputs) {
  // Python defaultdict equivalents
  const agg_domains = {}; // domain -> {score, last_seen, sessions:Set}
  const agg_titles = {}; // title  -> {score, last_seen, sessions:Set}
  const agg_searches = {}; // session_id -> {search_count, search_titles:Set, last_searched}

  const nowSec = Date.now() / 1000;
  const num_of_sessions = prepared_inputs.length;

  for (const s of prepared_inputs) {
    const sid = s.session_id;
    const st = s.session_start_time;
    const et = s.session_end_time;
    const last = et || st || nowSec;

    // ---- domains
    const domScores = s.domain_scores || {};
    for (const [d, sc] of Object.entries(domScores)) {
      const x = getOrInit(agg_domains, d, () => ({
        score: 0.0,
        last_seen: 0,
        sessions: new Set(),
      }));
      x.score = Number(sc); // last value wins (matches Python loop)
      x.last_seen = Math.max(x.last_seen, last);
      x.sessions.add(sid);
    }

    // ---- titles
    const titScores = s.title_scores || {};
    for (const [t, sc] of Object.entries(titScores)) {
      const key = t; // if you stem, do it here
      const x = getOrInit(agg_titles, key, () => ({
        score: 0.0,
        last_seen: 0,
        sessions: new Set(),
      }));
      x.score = Number(sc); // last value wins
      x.last_seen = Math.max(x.last_seen, last);
      x.sessions.add(sid);
    }

    // ---- searches (single structure per session_id)
    const se = s.search_events || {};
    if (Object.keys(se).length) {
      const rec = getOrInit(agg_searches, sid, () => ({
        search_count: 0,
        search_titles: new Set(),
        last_searched: 0.0,
      }));
      rec.search_count += Number(se.search_count || 0);
      for (const title of se.search_titles || []) {
        rec.search_titles.add(title);
      }
      rec.last_searched = Math.max(
        rec.last_searched,
        _toSeconds(se.last_searched)
      );
    }
  }

  // convert sets → counts + session_importance
  for (const v of Object.values(agg_domains)) {
    const n = v.sessions.size;
    v.num_sessions = n;
    v.session_importance = n > 0 ? round2(num_of_sessions / n) : 0.0;
    delete v.sessions;
  }
  for (const v of Object.values(agg_titles)) {
    const n = v.sessions.size;
    v.num_sessions = n;
    v.session_importance = n > 0 ? round2(num_of_sessions / n) : 0.0;
    delete v.sessions;
  }

  // finalize searches: set → array
  for (const sid of Object.keys(agg_searches)) {
    const rec = agg_searches[sid];
    rec.search_titles = [...rec.search_titles];
  }

  return [agg_domains, agg_titles, agg_searches];
}

// --- withRecency ---
function withRecency(
  score,
  sessionImportance,
  lastSeenSec,
  {
    halfLifeDays = 14,
    floor = 0.5,
    sessionWeight = 1.0,
    now = undefined, // seconds (if you pass ms, we’ll normalize)
  } = {}
) {
  const nowSec = now != null ? _toSeconds(now) : Date.now() / 1000;
  const lastSec = _toSeconds(lastSeenSec);

  const ageDays = Math.max(0, (nowSec - lastSec) / 86400);
  const decay = Math.pow(0.5, ageDays / halfLifeDays); // half-life decay
  const importanceScore =
    Number(score) * (Number(sessionImportance) * Number(sessionWeight));
  // keep a base weight via `floor` and blend in recency
  return round2(importanceScore * (floor + (1 - floor) * decay));
}

// --- top-k aggregation ---
function topkAggregates(
  agg_domains,
  agg_titles,
  agg_searches,
  {
    k_domains = 30,
    k_titles = 60,
    k_searches = 10,
    now = undefined, // optional; seconds or ms, we normalize
  } = {}
) {
  const nowRaw = now != null ? now : Date.now() / 1000; // we’ll normalize inside withRecency

  // domains → [ [domain, {.., rank_score}], ... ]
  const dom_items = Object.entries(agg_domains).map(([d, v]) => [
    d,
    {
      ...v,
      rank_score: withRecency(v.score, v.session_importance, v.last_seen, {
        now: nowRaw,
      }),
    },
  ]);

  // titles → [ [title, {.., rank_score}], ... ]
  const tit_items = Object.entries(agg_titles).map(([t, v]) => [
    t,
    {
      ...v,
      rank_score: withRecency(v.score, v.session_importance, v.last_seen, {
        now: nowRaw,
      }),
    },
  ]);

  // searches are keyed by session_id; base score is search_count, importance=1.0
  const srch_items = Object.entries(agg_searches).map(([sid, v]) => {
    const base = Number(v.search_count || 0);
    const last = Number(v.last_searched || 0);
    return [
      // keep sid as number if possible
      Number.isFinite(Number(sid)) ? Number(sid) : sid,
      {
        ...v,
        rank_score: withRecency(base, 1.0, last, { now: nowRaw }),
      },
    ];
  });

  // sort: rank_score desc, then tie-breakers like python lambda
  dom_items.sort(
    (a, b) =>
      b[1].rank_score - a[1].rank_score ||
      (b[1].num_sessions || 0) - (a[1].num_sessions || 0) ||
      (b[1].last_seen || 0) - (a[1].last_seen || 0)
  );

  tit_items.sort(
    (a, b) =>
      b[1].rank_score - a[1].rank_score ||
      (b[1].num_sessions || 0) - (a[1].num_sessions || 0) ||
      (b[1].last_seen || 0) - (a[1].last_seen || 0)
  );

  srch_items.sort(
    (a, b) =>
      b[1].rank_score - a[1].rank_score ||
      (b[1].search_count || 0) - (a[1].search_count || 0) ||
      (b[1].last_searched || 0) - (a[1].last_searched || 0)
  );

  return [
    dom_items.slice(0, k_domains),
    tit_items.slice(0, k_titles),
    srch_items.slice(0, k_searches),
  ];
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
  items: {
    type: "object",
    additionalProperties: false,
    required: ["category", "intent", "insight_summary", "score"],
    properties: {
      category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
      intent: { type: ["string", "null"], enum: [...INTENTS, null] },
      insight_summary: { type: ["string", "null"] },
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

Return ONLY a JSON array of objects, no prose, no code fences. Each object must have:
{
  "category": "<one of the categories or null>",
  "intent": "<one of the intents or null>",
  "insight_summary": "<4–10 words, crisp and specific or null>",
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
 * - New: writes to `insightsDataByCategory[category] = { insight_summary, intent, category, score }`
 * - Legacy: also appends `category` under its category array (unchanged behavior)
 *
 * @param {object|object[]} payload Array of insight objects or a single object
 * @returns {{ addedCount: number, upsertedByCategory: number }}
 */
function addInsightsToData(payload) {
  const smartWindow = getSmartWindow();
  const insightsData = getInsightsData();

  const items = Array.isArray(payload) ? payload : [payload];

  // ensure new by-category index exists
  if (
    !insightsData.insightsDataByCategory ||
    typeof insightsData.insightsDataByCategory !== "object"
  ) {
    insightsData.insightsDataByCategory = {};
  }

  let addedCount = 0; // legacy category -> label additions
  let upsertedByCategory = 0; // new by-short upserts

  for (const obj of items) {
    const category = (obj?.category ?? "").trim();
    const summary = (obj?.insight_summary ?? "").trim();
    const intent = (obj?.intent ?? "").trim();
    const score = Number.isFinite(obj?.score) ? Number(obj.score) : null;

    if (category) {
      const prev = insightsData.insightsDataByCategory[category];
      // Upsert if new or summary changed (or we have better metadata)
      if (
        !prev ||
        (summary && summary !== prev.insight_summary) ||
        (intent && intent !== prev.intent) ||
        (Number.isFinite(score) && score !== prev.score)
      ) {
        insightsData.insightsDataByCategory[category] = {
          insight_summary: summary || prev?.insight_summary || "",
          category: category || prev?.category || "",
          intent: intent || prev?.intent || "",
          score: Number.isFinite(score) ? score : (prev?.score ?? null),
        };
        upsertedByCategory += 1;
      }
    }

    // ---- Legacy storage (category -> labels array) ----
    // Falls back to summary if category is missing.
    const label = summary;
    if (category) {
      if (!insightsData[category]) {
        insightsData[category] = [];
      }
      if (!insightsData[category].includes(label)) {
        insightsData[category].push(label);
      }
    }
  }

  smartWindow?.setInsightsData(insightsData);
  return { addedCount, upsertedByCategory };
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
    const sessionized = sessionizeVisits(baseRows);

    const prepared_inputs = generateProfileInputs(sessionized);

    const [agg_domains, agg_titles, agg_searches] =
      aggregateSessions(prepared_inputs);

    const prepared_inputs_topk = topkAggregates(
      agg_domains,
      agg_titles,
      agg_searches,
      { k_domains: 30, k_titles: 60, k_searches: 10 } // options object
    );

    console.log("[Insights] Generating insights with LLM...");
    const list = await generateInsightsWithLLM(prepared_inputs_topk, "history");

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
 * Copies insights to clipboard
 *
 * @returns {void}
 */
export function copyInsightsToClipboard() {
  const insightsData = getInsightsData();
  const hasGeneratedInsights = Object.keys(insightsData)?.length > 0;

  const insightsJson = {
    title: "Smart Window Insights",
    exportDate: new Date().toISOString(),
    hasGeneratedInsights,
    categories: {},
  };

  Object.entries(hasGeneratedInsights ? insightsData : DEFAULT_INSIGHTS_DATA)
    .filter(([_, value]) => Array.isArray(value))
    .forEach(([category, insights]) => {
      if (insights?.length > 0) {
        insightsJson.categories[category] = insights;
      }
    });

  const outputString = JSON.stringify(insightsJson, null, 2);

  // Copy to clipboard
  navigator.clipboard
    .writeText(outputString)
    .then(() => {
      console.info("[Insights] Copied insights to clipboard", outputString);
      alert("Copied insights to clipboard");
    })
    .catch(error => {
      console.error("[Insights] Failed to copy to clipboard:", error);
    });
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
          <button
            class="action-btn secondary"
            @click=${copyInsightsToClipboard}
            title="Copy insights to clipboard"
          >
            📋 Copy Insights
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
            const insights = Object.entries(dataToDisplay)
              .filter(([, value]) => Array.isArray(value))
              .map(([category, insight_summary]) => {
                const usedCount = insight_summary.reduce(
                  (acc, it) => acc + (usedInsights.has(it) ? 1 : 0),
                  0
                );
                return { category, insight_summary, usedCount };
              })
              .filter(({ insight_summary }) => !!insight_summary.length)
              .sort((a, b) => {
                if (a.usedCount !== b.usedCount) {
                  return b.usedCount - a.usedCount;
                }
                return a.category.localeCompare(b.category);
              });

            return insights.map(
              ({ category, insight_summary }) => html`
                <div class="insight-category">
                  <h4>${category}</h4>
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
                                    onDeleteInsight(insight, category);
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
