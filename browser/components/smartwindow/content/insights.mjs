/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* eslint-disable no-console */

import { html, css, render } from "chrome://global/content/vendor/lit.all.mjs";
import { createOpenAIEngine } from "./utils.mjs";

const { ChatHistory, ChatHistoryMessage } = ChromeUtils.importESModule(
  "resource:///modules/smartwindow/ChatHistory.sys.mjs"
);
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);

/**
 * CSS styles for insights functionality
 */
export let insightsStyles;

/**
 * Module-level state for prompt editor
 */
let moduleCustomPrompt = null; // null means use default prompt
let moduleShowPromptEditor = false;

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

function normalizeKey(summary = "", intent = "") {
  return `${summary.trim().toLowerCase()}::${intent.trim().toLowerCase()}`;
}

// Ensure insightsData.insightsDataByCategory exists and is { [cat]: Array<RichInsight> }
function ensureRichIndex(insightsData) {
  const idx = (insightsData.insightsDataByCategory =
    insightsData.insightsDataByCategory || {});

  // Migrate any { [cat]: object } entries to arrays, once.
  for (const [cat, val] of Object.entries(idx)) {
    if (val && !Array.isArray(val) && typeof val === "object") {
      idx[cat] = [val];
    }
  }
  return idx;
}

/**
 * Gets the current custom prompt (null means use default)
 *
 * @returns {string|null}
 */
export function getCustomPrompt() {
  return moduleCustomPrompt;
}

/**
 * Sets the custom prompt (null means use default)
 *
 * @param {string|null} prompt
 */
export function setCustomPrompt(prompt) {
  moduleCustomPrompt = prompt;
}

/**
 * Gets prompt editor visibility state
 *
 * @returns {boolean}
 */
export function isPromptEditorVisible() {
  return moduleShowPromptEditor;
}

/**
 * Sets prompt editor visibility state
 *
 * @param {boolean} visible
 */
export function setPromptEditorVisible(visible) {
  moduleShowPromptEditor = visible;
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
//   conversation: 3,
//   search: 2,
//   history: 1,

/**
 * User insights data organized by category
 * Static data serves as placeholder until user generates insights
 */
const DEFAULT_INSIGHTS_DATA = {};
const DEFAULT_INSIGHTS_SYSTEM_PROMPT =
  "[ NO INSIGHTS FOUND FOR THIS USER! We could not retrieve any insights for this user ]";

function getInsightsMeta() {
  const sw = getSmartWindow();
  const data = getInsightsData(); // fallback stash
  const fromSW = sw?.getInsightsMeta?.();
  const meta = fromSW ||
    data.__meta || {
      history: { lastMicros: 0, tail: [], deltaRuns: 0 },
      conversations: { lastTs: 0, deltaRuns: 0 },
      agg_cache: null, // { history: {0,1,2,num_sessions}, ... }
    };
  meta.history = meta.history || { lastMicros: 0, tail: [], deltaRuns: 0 };
  meta.conversations = meta.conversations || { lastTs: 0, deltaRuns: 0 };
  return meta;
}

function setInsightsMeta(meta) {
  const sw = getSmartWindow();
  if (sw?.setInsightsMeta) {
    sw.setInsightsMeta(meta);
  } else {
    const insightsData = getInsightsData();
    insightsData.__meta = meta;
    sw?.setInsightsData?.(insightsData);
  }
}

// ---- single-flight generation guard ----
async function withGenerationLock(fn) {
  const sw = getSmartWindow();
  if (sw?.isGeneratingInsights()) {
    throw new Error("Already generating insights");
  }
  try {
    sw?.setGeneratingInsights(true);
    sw?.setInsightsError(null);
    return await fn();
  } catch (e) {
    sw?.setInsightsError(e?.message || String(e));
    throw e;
  } finally {
    sw?.setGeneratingInsights(false);
  }
}

async function runInsights(profile_records, source, opts = {}) {
  const { preview = false, caps = { maxPerCategory: 2, maxPerIntent: 2 } } =
    opts;

  const llm_pipeline = Services.prefs.getStringPref(
    "browser.smartwindow.insightsPipeline",
    "regular"
  );
  let listRaw;
  if (llm_pipeline == "regular") {
    listRaw = await generateInsightsWithLLM(profile_records, source);
  } else {
    listRaw = await generateInsightsWithCoVe(profile_records, source);
  }

  const { validated, rejected } = partitionAndValidate(listRaw);
  if (rejected.length) {
    console.warn(
      `[Insights] Rejected (${source}):`,
      JSON.stringify(rejected, null, 2)
    );
  }
  const list = rankAndDiversify(validated, caps);
  if (!list.length) {
    return { addedCount: 0 };
  }

  if (preview) {
    return { addedCount: 0, list };
  }

  const { addedCount } = addInsightsToData(list);
  console.log(
    `[Insights] Added ${addedCount}/${list.length} insights from ${source}`
  );
  return { addedCount };
}

export function saveInsightPreview(list) {
  const { addedCount } = addInsightsToData(list);

  try {
    window.dispatchEvent(new CustomEvent("insights-updated"));
  } catch {}

  return { saved: addedCount };
}

// ===================== CoVe: Engine Runners =====================

async function runCoVeQuestions({
  engine,
  insight,
  profile_records,
  related_insights,
}) {
  const resp = await engine.run({
    args: [
      {
        role: "system",
        content: "You generate verification questions. Return VALID JSON only.",
      },
      {
        role: "user",
        content: buildVerificationQuestionsPrompt({
          insight,
          profile_records,
          related_insights,
        }),
      },
    ],
    responseFormat: { type: "json_schema", schema: COVE_QUESTIONS_SCHEMA },
  });
  const raw = resp?.finalOutput ?? "{}";
  const obj = extractJSON(raw);
  return obj?.questions ?? [];
}

async function runCoVeAnswers({
  engine,
  insight,
  profile_records,
  related_insights,
  questions,
}) {
  const resp = await engine.run({
    args: [
      {
        role: "system",
        content:
          "You answer verification questions. Be strict, no invention. Return VALID JSON only.",
      },
      {
        role: "user",
        content: buildAnswerQuestionsPrompt({
          insight,
          profile_records,
          related_insights,
          questions,
        }),
      },
    ],
    responseFormat: { type: "json_schema", schema: COVE_ANSWERS_SCHEMA },
  });
  const raw = resp?.finalOutput ?? "{}";
  console.log(`insight ===> ${JSON.stringify(insight)}`);
  console.log(`cove answers ===> ${raw}`);
  return extractJSON(raw);
}

// ===================== CoVe: Integration =====================

function integrateCoVeDecision({
  insight,
  answersObj,
  profile_records,
  related_insights,
}) {
  // Hard, non-LLM guardrails first
  const hasSensitiveText =
    containsSensitive(insight?.insight_summary) ||
    (Array.isArray(insight?.evidence) &&
      insight.evidence.some(e => containsSensitive(e?.value)));

  const evidenceOk = evidenceStringsExistInProfile(insight, profile_records);
  const duplicate = isDuplicateOrSameEntity(insight, related_insights);

  if (!evidenceOk) {
    return { action: "reject", reason: "evidence_mismatch" };
  }
  if (duplicate) {
    return { action: "reject", reason: "duplicate" };
  }
  if (hasSensitiveText) {
    return { action: "reject", reason: "sensitive" };
  }

  // Use model verdict next
  const v = answersObj?.verdict || "reject";
  const suggestedScore =
    typeof answersObj?.suggested_score === "number"
      ? answersObj.suggested_score
      : null;

  if (v === "reject") {
    return { action: "reject", reason: "model_verdict_reject" };
  }

  if (v === "soften") {
    const replacement =
      answersObj?.replacement_summary || softenSummary(insight.insight_summary);
    const adjusted = { ...insight };
    adjusted.insight_summary = replacement;
    if (suggestedScore && Number.isInteger(suggestedScore)) {
      adjusted.score = suggestedScore;
    }
    // Also lower score conservatively if none suggested and current > 3
    if (!suggestedScore && adjusted.score > 3) {
      adjusted.score = 3;
    }
    // Keep category/intent/evidence/why but do NOT add new claims
    return { action: "soften", insight: adjusted };
  }

  // accept
  const accepted = { ...insight };
  if (suggestedScore && Number.isInteger(suggestedScore)) {
    accepted.score = suggestedScore;
  }
  return { action: "accept", insight: accepted };
}

// ===================== CoVe: Batch Runner =====================

/**
 * Runs CoVe over the list of draft insights
 *
 * @param {Array<object>} draftInsights
 * @param {Array<object>} profile_records
 * @param {Array<string>} related_insights
 * @returns {Promise<Array<object>>} filtered/softened final insights
 */
async function runCoVe(draftInsights, profile_records, related_insights) {
  const engine = await createOpenAIEngine();

  // Simple batching to avoid huge prompts; tune as needed
  const MAX_PARALLEL = 6;
  const results = [];

  async function processOne(insight) {
    // sanity: ensure evidence strings exist before spending tokens
    if (!evidenceStringsExistInProfile(insight, profile_records)) {
      return { drop: true, reason: "evidence_not_verbatim_in_profile" };
    }
    if (isDuplicateOrSameEntity(insight, related_insights)) {
      return { drop: true, reason: "duplicate_vs_related" };
    }
    if (
      containsSensitive(insight?.insight_summary) ||
      (insight.evidence || []).some(e => containsSensitive(e?.value))
    ) {
      return { drop: true, reason: "sensitive" };
    }

    const questions = await runCoVeQuestions({
      engine,
      insight,
      profile_records,
      related_insights,
    });
    if (!questions?.length) {
      return { drop: true, reason: "no_questions_generated" };
    }

    const answersObj = await runCoVeAnswers({
      engine,
      insight,
      profile_records,
      related_insights,
      questions,
    });

    const decision = integrateCoVeDecision({
      insight,
      answersObj,
      profile_records,
      related_insights,
    });

    if (decision.action === "accept" || decision.action === "soften") {
      return { keep: true, insight: decision.insight };
    }
    return { drop: true, reason: decision.reason || "model_reject" };
  }

  // Parallel with simple window
  let i = 0;
  while (i < draftInsights.length) {
    const chunk = draftInsights.slice(i, i + MAX_PARALLEL);
    const outs = await Promise.allSettled(chunk.map(processOne));
    for (const r of outs) {
      if (r.status === "fulfilled") {
        if (r.value.keep) {
          results.push(r.value.insight);
        }
      }
      // swallowed rejections are fine; they drop the insight
    }
    i += MAX_PARALLEL;
  }

  return results;
}

/**
 * Fetch recent browsing history from Places (SQL), aggregate by URL,
 * tag "search" vs "history", and filter low-visit URLs.
 *
 * @param {object} opts
 * @param {number} [opts.days=60]          How far back to look
 * @param {number} [opts.maxResults=500]   Max rows to return (after sort)
 * @returns {Promise<Array<{url:string,title:string,domain:string,visit_time:string,visit_count:number,source:'history'|'search'}>>}
 */
async function getRecentHistory(opts = {}) {
  const days = opts.days ?? 60;
  const maxResults = opts.maxResults ?? 500;

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

async function getRecentHistoryDelta({
  sinceMicros,
  overlapMs = 3 * 3600 * 1000,
  maxResults = 500,
}) {
  const nowMs = Date.now();
  const overlapMicros = overlapMs * 1000;
  const cutoffMicros = Math.max(0, (Number(sinceMicros) || 0) - overlapMicros);
  // convert cutoff to "days" for the SQL helper
  const rawDiffInDays = (nowMs - cutoffMicros / 1000) / 86400000;
  return getRecentHistory({ days: rawDiffInDays, maxResults });
}

function pruneAndCarryTail(rows, { tailWindowMs = 3 * 3600 * 1000 }) {
  if (!rows.length) {
    return [];
  }
  const lastMs =
    Math.max(...rows.map(r => Number(r.visitDateMicros) || 0)) / 1000;
  const tailCutoffUs = lastMs * 1000 - tailWindowMs * 1000;
  return rows.filter(r => (r.visitDateMicros || 0) >= tailCutoffUs);
}

function sessionizeIncremental(previousTail, newRows) {
  // Only re-sessionize tail ∪ newRows
  const windowRows = [...(previousTail || []), ...(newRows || [])];
  if (!windowRows.length) {
    return { windowSessionized: [], newTail: [] };
  }

  const windowSessionized = sessionizeVisits(windowRows);
  const newTail = pruneAndCarryTail(windowSessionized, {
    tailWindowMs: 3 * 3600 * 1000,
  });
  return { windowSessionized, newTail };
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
  const normalized = rows
    .map(r => {
      const tMs = Number.isFinite(r.visitDateMicros)
        ? Math.floor(r.visitDateMicros / 1000) // μs → ms
        : NaN;
      return { ...r, visitTimeMs: tMs };
    })
    .filter(r => Number.isFinite(r.visitTimeMs));

  // sort ascending
  normalized.sort((a, b) => a.visitTimeMs - b.visitTimeMs);

  let curStartMs = null;
  let prevMs = null;

  for (const r of normalized) {
    const tMs = r.visitTimeMs;

    const startNew =
      prevMs === null ||
      (tMs - prevMs) / 1000 > gapSec ||
      (tMs - curStartMs) / 1000 > maxSessionSec;

    if (startNew) {
      curStartMs = tMs;
    }

    // STABLE session_id derived from session start time (ms)
    const stableId = curStartMs | 0; // bitwise OR to coerce to 32-bit int (still stable)
    r.session_start_ms = curStartMs;
    r.session_start_iso = new Date(curStartMs).toISOString();
    r.session_id = stableId;

    prevMs = tMs;
  }

  return normalized;
}

function unpackAggTriplet(agg) {
  if (!agg) {
    return [{}, {}, {}];
  }
  if (Array.isArray(agg)) {
    return agg.slice(0, 3);
  }
  // object with numeric keys
  return [
    agg[0] ?? agg["0"] ?? {},
    agg[1] ?? agg["1"] ?? {},
    agg[2] ?? agg["2"] ?? {},
  ];
}

function mergeAggregates(prev, delta) {
  const [pd, pt, ps] = prev || [{}, {}, {}];
  const [dd, dt, ds] = delta;

  const md = { ...pd };
  for (const [k, v] of Object.entries(dd || {})) {
    const cur = md[k] || {
      score: 0,
      last_seen: 0,
      num_sessions: 0,
      session_importance: 0,
    };
    md[k] = {
      score: v.score, // last wins (your logic)
      last_seen: Math.max(cur.last_seen || 0, v.last_seen || 0),
      num_sessions: (cur.num_sessions || 0) + (v.num_sessions || 0), // approximate: we’ll recompute properly below
      session_importance: 0, // recompute later
    };
  }

  const mt = { ...pt };
  for (const [k, v] of Object.entries(dt || {})) {
    const cur = mt[k] || {
      score: 0,
      last_seen: 0,
      num_sessions: 0,
      session_importance: 0,
    };
    mt[k] = {
      score: v.score,
      last_seen: Math.max(cur.last_seen || 0, v.last_seen || 0),
      num_sessions: (cur.num_sessions || 0) + (v.num_sessions || 0),
      session_importance: 0,
    };
  }

  const ms = { ...(ps || {}) };
  for (const [sid, v] of Object.entries(ds || {})) {
    const cur = ms[sid] || {
      search_count: 0,
      search_titles: [],
      last_searched: 0,
    };
    const newTitles = new Set([
      ...(cur.search_titles || []),
      ...(v.search_titles || []),
    ]);
    ms[sid] = {
      search_count: (cur.search_count || 0) + (v.search_count || 0),
      search_titles: [...newTitles],
      last_searched: Math.max(cur.last_searched || 0, v.last_searched || 0),
    };
  }

  return [md, mt, ms];
}

function recomputeSessionImportance(agg_domains, agg_titles, totalSessions) {
  for (const v of Object.values(agg_domains)) {
    const n = v.num_sessions || 0;
    v.session_importance =
      n > 0 ? Math.round((totalSessions / n) * 100) / 100 : 0;
  }
  for (const v of Object.values(agg_titles)) {
    const n = v.num_sessions || 0;
    v.session_importance =
      n > 0 ? Math.round((totalSessions / n) * 100) / 100 : 0;
  }
}

function aggregateDelta(windowSessionized) {
  const prepared = generateProfileInputs(windowSessionized);
  return aggregateSessions(prepared); // returns [agg_domains, agg_titles, agg_searches]
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

// deep "to_native" sanitizer: stringify keys, drop NaN/Infinity -> null
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

// Normalize sec/ms/µs/ns -> seconds (float)
function toSeconds(ts) {
  if (ts == null) {
    return 0;
  }
  let x = Number(ts);
  if (!Number.isFinite(x)) {
    return 0;
  }
  if (x > 1e15) {
    return x / 1e6;
  } // µs
  if (x > 1e12) {
    return x / 1e3;
  } // ms
  return x; // s
}

// Round to 2 decimals
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
        toSeconds(se.last_searched)
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
  const nowSec = now != null ? toSeconds(now) : Date.now() / 1000;
  const lastSec = toSeconds(lastSeenSec);

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
    now = undefined, // optional; seconds or ms, normalized inside withRecency
  } = {}
) {
  const nowRaw = now != null ? now : Date.now() / 1000;

  // --- enrich with rank (for sorting), but don't keep extra fields in output ---

  // domains: [{key, rank, num_sessions, last_seen}]
  const domTmp = Object.entries(agg_domains).map(([d, v]) => {
    const rank = withRecency(v.score, v.session_importance, v.last_seen, {
      now: nowRaw,
    });
    return {
      key: d,
      rank,
      num_sessions: v.num_sessions || 0,
      last_seen: v.last_seen || 0,
    };
  });

  // titles: [{key, rank, num_sessions, last_seen}]
  const titTmp = Object.entries(agg_titles).map(([t, v]) => {
    const rank = withRecency(v.score, v.session_importance, v.last_seen, {
      now: nowRaw,
    });
    return {
      key: t,
      rank,
      num_sessions: v.num_sessions || 0,
      last_seen: v.last_seen || 0,
    };
  });

  // searches: [{sid, cnt, q, ls, rank}]
  const srchTmp = Object.entries(agg_searches).map(([sidRaw, v]) => {
    const sid = Number.isFinite(Number(sidRaw)) ? Number(sidRaw) : sidRaw;
    const cnt = Number(v.search_count || 0);
    const ls = toSeconds(v.last_searched || 0);
    const rank = withRecency(cnt, 1.0, v.last_searched || 0, { now: nowRaw });
    return {
      sid,
      cnt,
      q: Array.isArray(v.search_titles) ? v.search_titles : [],
      ls,
      rank,
    };
  });

  // --- sort with tie-breakers using temp fields only ---
  domTmp.sort(
    (a, b) =>
      b.rank - a.rank ||
      b.num_sessions - a.num_sessions ||
      b.last_seen - a.last_seen
  );
  titTmp.sort(
    (a, b) =>
      b.rank - a.rank ||
      b.num_sessions - a.num_sessions ||
      b.last_seen - a.last_seen
  );
  srchTmp.sort((a, b) => b.rank - a.rank || b.cnt - a.cnt || b.ls - a.ls);

  // --- trim & emit compact structures ---
  const dom_items = domTmp
    .slice(0, k_domains)
    .map(({ key, rank }) => [key, round2(rank)]);
  const tit_items = titTmp
    .slice(0, k_titles)
    .map(({ key, rank }) => [key, round2(rank)]);
  const srch_items = srchTmp
    .slice(0, k_searches)
    .map(({ sid, cnt, q, ls, rank }) => ({
      sid,
      cnt,
      q,
      ls,
      r: round2(rank),
    }));

  // keep your original outer shape: [domains, titles, searches]
  return [dom_items, tit_items, srch_items];
}

function safeLc(s) {
  return String(s || "").toLowerCase();
}

function textOverlapBoost(message, insight) {
  const m = safeLc(message);
  const terms = new Set(
    String(insight?.insight_summary || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(w => w.length >= 4)
  );
  if (!terms.size || !m) {
    return 0;
  }
  let hits = 0;
  for (const t of terms) {
    if (m.includes(t)) {
      hits++;
    }
  }
  // tiny, bounded boost
  return Math.min(0.4, hits * 0.08);
}

// Fallback if the classifier returns nulls
function fallbackCategoryFromMessage(message) {
  const m = safeLc(message);
  const pairs = [
    [/news|headline|article/, "News"],
    [/shop|buy|deal|price|cart/, "Shopping"],
    [/code|api|library|sdk|repo|git/, "Computers & Electronics"],
    [/recipe|restaurant|cook|food/, "Food & Drink"],
    [/travel|flight|hotel|trip|itinerary/, "Travel & Transportation"],
    [/sports?|nba|nfl|soccer|match/, "Sports"],
    [/movie|music|tv|game|stream/, "Arts & Entertainment"],
    [/learn|course|tutorial|class|school/, "Jobs & Education"],
  ];
  for (const [re, cat] of pairs) {
    if (re.test(m)) {
      return cat;
    }
  }
  return null;
}

function fallbackIntentFromMessage(message) {
  const m = safeLc(message);
  if (/compare|vs|which.*better|review/.test(m)) {
    return "Compare / Evaluate";
  }
  if (/plan|organize|schedule|itinerary|outline/.test(m)) {
    return "Plan / Organize";
  }
  if (/buy|purchase|order|deal|price|subscribe/.test(m)) {
    return "Buy / Acquire";
  }
  if (/learn|how to|what is|explain|guide|docs?/.test(m)) {
    return "Research / Learn";
  }
  if (/draft|write|make|build|code|create/.test(m)) {
    return "Create / Produce";
  }
  if (/share|post|tweet|email|message/.test(m)) {
    return "Communicate / Share";
  }
  if (/track|monitor|watch list|alerts?/.test(m)) {
    return "Monitor / Track";
  }
  if (/relax|fun|bored|entertain|watch/.test(m)) {
    return "Entertain / Relax";
  }
  if (/again|revisit|resume|back to|recent/.test(m)) {
    return "Resume / Revisit";
  }
  return null;
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

        let ts = Number(m.createdDate ?? 0);
        if (ts > 0 && ts < 1e12) {
          ts *= 1000;
        }
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
        return { url, messages, freshness_score, lastTs };
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

async function getUserChatsDelta({
  sinceTs,
  halfLifeDays = 14,
  maxConversations = 50,
}) {
  const all = await getUserChats({ days: 30, maxConversations, halfLifeDays });
  if (!sinceTs) {
    return all;
  }
  return all.filter(c => Number(c.lastTs || 0) >= Number(sinceTs));
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
    required: [
      "category",
      "intent",
      "insight_summary",
      "score",
      "why",
      "evidence",
    ],
    properties: {
      category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
      intent: { type: ["string", "null"], enum: [...INTENTS, null] },
      insight_summary: { type: ["string", "null"] },
      score: { type: "integer", minimum: 1, maximum: 5 },

      why: { type: "string", minLength: 12, maxLength: 200 },

      evidence: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          required: ["type", "value"],
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              enum: ["domain", "title", "search", "chat", "user"],
            },
            value: { type: "string" },
            weight: { type: "number", minimum: 0, maximum: 1 },
            session_ids: {
              type: "array",
              items: { type: ["integer", "string"] },
            },
          },
        },
      },
    },
  },
};

const INSIGHTS_DEDUPE_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["unique_insights"],
    properties: {
      unique_insights: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["main_insight", "duplicates"],
          properties: {
            main_insight: { type: "string" },
            duplicates: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
          },
        },
      },
    },
  },
};

const INSIGHTS_NON_SENSITIVE_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["non_sensitive_insights"],
    properties: {
      non_sensitive_insights: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
      },
    },
  },
};

export const COVE_QUESTIONS_SCHEMA = {
  name: "CoVeQuestions",
  schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            qid: { type: "string" }, // stable id for tracing
            question: { type: "string" },
          },
          required: ["qid", "question"],
          additionalProperties: false,
        },
        minItems: 2,
        maxItems: 8,
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

export const COVE_ANSWERS_SCHEMA = {
  name: "CoVeAnswers",
  schema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            qid: { type: "string" },
            answer: { type: "string" },
            // strict judgments we can aggregate automatically
            support: {
              type: "string",
              enum: [
                "supported",
                "partially_supported",
                "not_supported",
                "inapplicable",
              ],
            },
            // optional flags (model must never invent)
            flags: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "duplicate",
                  "sensitive",
                  "pii",
                  "weak_pattern",
                  "speculative_language",
                ],
              },
            },
            rationale: { type: "string" }, // short, 20-60 words
          },
          required: ["qid", "answer", "support"],
          additionalProperties: false,
        },
        minItems: 2,
      },
      // Final model self-verdict for the insight:
      verdict: { type: "string", enum: ["accept", "soften", "reject"] },
      // If soften: a 4-10 word replacement summary consistent w/ evidence
      replacement_summary: { type: ["string", "null"] },
      // Optional: suggest a lower score if weak
      suggested_score: { type: ["integer", "null"], minimum: 1, maximum: 5 },
    },
    required: ["answers", "verdict"],
    additionalProperties: false,
  },
};

// Predict a single category & intent from a freeform message
const CLASSIFY_MESSAGE_SCHEMA = {
  name: "ClassifyMessage",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["category", "intent"],
    properties: {
      category: { type: ["string", "null"], enum: [...CATEGORIES, null] },
      intent: { type: ["string", "null"], enum: [...INTENTS, null] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      rationale: { type: "string" }, // optional, for debugging
    },
  },
};

// Sensitive keywords (mirror prompt rules) for cove
const SENSITIVE_KEYWORDS = [
  // medical & health keywords
  "pregnancy",
  "pregnant",
  "prenatal",
  "miscarriage",
  "fertility",
  "ivf",
  "abortion",
  "contraception",
  "birth control",
  "menopause",
  "period tracking",
  "cancer",
  "chemotherapy",
  "radiation therapy",
  "arthritis",
  "diabetes",
  "hiv",
  "aids",
  "std",
  "sti",
  "depression",
  "anxiety",
  "bipolar",
  "adhd",
  "ptsd",
  "mental health",
  "therapy",
  "counseling",
  "addiction",
  "substance use",
  "rehab",
  "detox",
  "overdose",
  "disability",
  "chronic pain",
  "terminal illness",
  "treatment",
  "diagnosis",
  "symptoms",
  "lab results",
  "medical record",
  "health condition",
  "pediatrician",
  "pediatric",
  "oncology",
  "psychiatry",
  "psychology",
  "cardiology",
  "gynecology",
  // finance related keywords
  "salary",
  "income",
  "compensation",
  "paystub",
  "w2",
  "t4",
  "tax return",
  "irs",
  "cra",
  "taxes",
  "bank account",
  "routing number",
  "account number",
  "account balance",
  "wire transfer",
  "credit card",
  "debit card",
  "cvc",
  "cvv",
  "credit score",
  "fico",
  "equifax",
  "transunion",
  "loan",
  "mortgage",
  "refinance",
  "foreclosure",
  "repo",
  "collections",
  "bankruptcy",
  "insolvency",
  "investment account",
  "brokerage",
  "401k",
  "rrsp",
  "pension",
  "benefits",

  // legal related keywords
  "lawsuit",
  "settlement",
  "subpoena",
  "warrant",
  "indictment",
  "conviction",
  "arrest",
  "criminal record",
  "divorce",
  "custody",
  "restraining order",
  "nd a",
  "non-disclosure",
  "plea deal",
  "parole",
  "probation",
  "immigration status",
  "visa overstay",
  "asylum",
  "deportation",
  "citizenship interview",
  "green card",
  "work permit",
  // PII
  "social security number",
  "ssn",
  "sin",
  "passport number",
  "driver's license",
  "drivers license",
  "national id",
  "date of birth",
  "dob",
  "mother's maiden name",
  "security question",
  "2fa backup codes",
  "home address",
  "street address",
  "apartment number",
  "phone number",
  "email address",
  "personal email",
  // Demographics
  "race",
  "ethnicity",
  "religion",
  "religious",
  "faith",
  "church",
  "mosque",
  "synagogue",
  "temple",
  "political leaning",
  "political affiliation",
  "republican",
  "democrat",
  "conservative",
  "liberal",
  "socialist",
  "sexual orientation",
  "lgbt",
  "lgbtq",
  "gay",
  "lesbian",
  "bisexual",
  "transgender",
  "nonbinary",
  "gender identity",
];

function containsSensitive(str = "") {
  const s = String(str).toLowerCase();
  return SENSITIVE_KEYWORDS.some(k => s.includes(k.toLowerCase()));
}

// Ensures every evidence.value string appears verbatim in profile_records sources.
function evidenceStringsExistInProfile(insight, profile_records = []) {
  if (!Array.isArray(insight?.evidence)) {
    return false;
  }
  const hay = JSON.stringify(profile_records ?? []);
  return insight.evidence.every(e => {
    if (!e?.value || typeof e.value !== "string") {
      return false;
    }
    return hay.includes(e.value);
  });
}

// Checks duplicate vs related_insights
function isDuplicateOrSameEntity(insight, related_insights = []) {
  if (!insight?.insight_summary) {
    return false;
  }
  const sum = insight.insight_summary.toLowerCase().trim();
  return related_insights.some(x =>
    String(x || "")
      .toLowerCase()
      .includes(sum)
  );
}

// Conservative language softener for partially supported claims
function softenSummary(summary) {
  if (!summary) {
    return summary;
  }
  const s = summary.trim();
  // Prefix with cautious verbs if not already
  const hedges = ["Likely", "Often", "Appears to", "May", "Tends to"];
  if (/^(likely|often|appears to|may|tends to)/i.test(s)) {
    return s;
  }
  return `${hedges[Math.floor(Math.random() * hedges.length)]} ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
}

// ===================== CoVe: Prompt Builders =====================

function buildVerificationQuestionsPrompt({
  insight,
  profile_records,
  related_insights,
}) {
  return `
    You are verifying a single candidate "insight" about a user. You must NOT invent information.

    Return ONLY JSON per schema. Write 1-2 pointed verification questions that, if answered strictly from the Inputs, can prove or disprove the insight.

    ## Inputs
    - insight object (draft):
    ${JSON.stringify(insight, null, 2)}

    - profile_records (ground truth, ONLY source of domains/titles/searches):
    ${JSON.stringify(profile_records, null, 2)}

    - related_insights (already-known items; avoid duplicates):
    ${JSON.stringify(related_insights, null, 2)}

    ## Rules
    - Questions must be answerable using ONLY Inputs.
    - Target factual cores: pattern strength, duplication, sensitivity.
    - Avoid yes/no; ask for specific checks (e.g., "Does X has any sensitive or pii or medical or financial or legal information... Does X has good score").
    - Avoid duration of time spent on a page question as we are not passing that data.

    Return JSON matching the CoVeQuestions schema. No prose.
  `.trim();
}

function buildAnswerQuestionsPrompt({
  insight,
  profile_records,
  related_insights,
  questions,
}) {
  return `
    You must answer verification questions about the candidate insight STRICTLY from Inputs. Do not infer beyond evidence. If insufficient, mark "not_supported".

    Return ONLY JSON per schema.

    ## Inputs
    - insight (draft):
    ${JSON.stringify(insight, null, 2)}

    - questions:
    ${JSON.stringify(questions, null, 2)}

    - profile_records:
    ${JSON.stringify(profile_records, null, 2)}

    - related_insights:
    ${JSON.stringify(related_insights, null, 2)}

    ## Judging
    - "supported": clear, direct evidence from multiple items or strong recent pattern.
    - "partially_supported": some signals but weak pattern/recency/corroboration.
    - "not_supported": missing, contradictory, or single odd visit.
    - Flag "duplicate" if substantially overlaps with related_insights.
    - Flag "sensitive" / "pii" if violates the policy in Inputs.
    - Flag "weak_pattern" if fewer than 2 corroborating items or only one-off visit.
    - If speculative language ("probably", "maybe"), flag "speculative_language".

    ## Final verdict
    - "accept": mostly "supported", no sensitive/pii, not duplicate.
    - "soften": mixed or weak support; suggest a hedged 4-10 word replacement_summary.
    - "reject": mostly "not_supported" or sensitive/duplicate/pii.

    You may suggest a lower "suggested_score" if weak.

    Return JSON matching CoVeAnswers schema. No prose.
  `.trim();
}

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
  // Render profile_records as CSV tables or JSON objects
  const profileRecordsRendered = [];
  for (const rec of profile_records) {
    // Row is just a domain/title with rank score
    if (
      Array.isArray(rec[0]) &&
      rec[0].length === 2 &&
      typeof rec[0][0] === "string" &&
      isFiniteNumber(rec[0][1])
    ) {
      const rankTable = ["Item,Rank Score"];
      for (const row of rec) {
        rankTable.push(`${row[0].replace("www.", "")},${row[1]}`);
      }
      profileRecordsRendered.push(rankTable.join("\n"));
      // Row is a search record with sid, cnt, q, ls, r
    } else if (rec.hasOwnProperty("sid") && rec.hasOwnProperty("r")) {
      const searchTable = ["Session ID,Queries,Rank Score"];
      for (const row of rec) {
        const sid = row.sid;
        //const cnt = row.cnt;
        const q = Array.isArray(row.q) ? row.q.join(" | ") : "";
        //const ls = row.ls;
        const r = row.r;
        searchTable.push(`${sid},${q},${r}`);
      }
      profileRecordsRendered.push(searchTable.join("\n"));
      // Fallback: row is anything else, just render as JSON
    } else {
      profileRecordsRendered.push(JSON.stringify(rec, null, 2));
    }
  }
  const profileRecordsRenderedStr = profileRecordsRendered.join("\n\n");

  const categoriesList = "- " + CATEGORIES.join("\n- ");
  const intentsList = "- " + INTENTS.join("\n- ");

  return `
# Overview
You are an expert at extracting insights from user browser data. An insight is a short, concise statement about user interests or behaviors (products, brands, behaviors) that can help personalize their experience.

You will receive CSV tables and/or JSON objects of data representing the user's browsing history, search history, and chat history. Use ONLY this data to generate insights. Each table has a header row that defines the schema.

# Instructions
- Extract up as many insights as you can.
- Each insight must be supported by 1-4 pieces of evidence from the user records. ONLY USE VERBATIM STRINGS FROM THE USER RECORDS!
- Insights are user preferences (products, brands, behaviors) useful for future personalization.
- Do not imagine actions without evidence. Prefer "shops for / plans / looked for" over "bought / booked / watched" unless explicit.
- Do not include personal names unless widely public (avoid PII).
- Base insights on patterns, not single instances.

## Exemplars
Below are examples of high quality insights (for reference only; do NOT copy):
- "Prefers LLBean & Nordstrom formalwear collections"
- "Compares white jeans under $80 at Target"
- "Streams new-release movies via Fandango"
- "Cooks Mediterranean seafood from TasteAtlas recipes"
- "Tracks minimalist fashion drops at Uniqlo"

## Category rules
Every insight requires a category. Choose ONLY one from this list; if none fits, use null:
${categoriesList}

## Intent rules
Every insight requires an intent. Choose ONLY one from this list; if none fits, use null:
${intentsList}

# Output Schema

Return ONLY a JSON array of objects, no prose, no code fences. Each object must have:
\`\`\`json
[
  {
    "why": "<12-40 words that briefly explains the rationale, referencing the cited evidence (no new claims or invented entities).>",
    "category": "<one of the categories or null>",
    "intent": "<one of the intents or null>",
    "insight_summary": "<4-10 words, crisp and specific or null>",
    "score": <integer 1-5>,
    "evidence": [
      {
        "type": "<one of ["domain","title","search","chat","user"]>",
        "value": "<a **verbatim** string copied from profile_records (for domain/title/search) or a short user/chat quote>",
        "session_ids": ["<optional array of session ids (if available from inputs)>"],
        "weight": "<optional 0-1 indicating contribution strength>"
      },
      ...
    ]
  }
]
\`\`\`

## Scoring priorities
- Base "score" on *strength + recency*; boost multi-source corroboration.
- Source priority: user (highest) > chat > search > history (lowest).
- Typical caps: recent history ≤1; search up to 2; multi-source 2-3; recent chat 4; explicit user 5.
- Do not assign 5 unless pattern is strong and recent.

# Inputs
Analyze the records below to generate as many unique, non-sensitive, specific user insights as possible. Each set of records is a CSV table with header row that defines the schema or JSON object.

${profileRecordsRenderedStr}

** CREATE ALL POSSIBLE UNIQUE INSIGHTS WITHOUT VIOLATING THE RULES ABOVE **
`.trim();
}

function buildDedupeInsightsPrompt({ insights, existing_insights = [] }) {
  const insightsJSON = JSON.stringify(insights, null, 2);
  const existingInsightsJSON = JSON.stringify(existing_insights, null, 2);

  return `
You are an expert at identifying duplicate statements.

Examine the following list of statements and find the unique ones. If you identify a set of statements that express the same general idea, pick the most general one from the set as the "main insight" and mark the rest as duplicates of it.

There are 2 lists of statements: Existing Statements and New Statements. If you find a duplicate between the 2, **ALWAYS** pick the Existing Statement as the "main insight".

If all statements are unique, simply return them all.

## Existing Statements:
${existingInsightsJSON}

## New Statements:
${insightsJSON}

Return ONLY JSON per the schema below.
\`\`\`json
{
  "unique_insights": [
    {
      "main_insight": "<the main unique insight statement>",
      "duplicates": [
        "<duplicate_statement_1>",
        "<duplicate_statement_2>",
        ...
      ]
    },
    ...
  ]
}
\`\`\`
`.trim();
}

function buildNonSensitiveInsightsPrompt({ insights }) {
  const insightsJSON = JSON.stringify(insights, null, 2);

  return `
You are an expert at identifying sensitive statements and content.

Examine the following list of statements and filter out any that contain sensitive information or content.
Sensitive information includes, but is not limited to:

- Medical/Health: diagnoses, symptoms, treatments, conditions, mental health, pregnancy, fertility, contraception.
- Finance: income/salary/compensation, bank/credit card details, credit score, loans/mortgage, taxes/benefits, debt/collections, investments/brokerage.
- Legal: lawsuits, settlements, subpoenas/warrants, arrests/convictions, immigration status/visas/asylum, divorce/custody, NDAs.
- Politics/Demographics/PII: political leaning/affiliation, religion, race/ethnicity, gender/sexual orientation, addresses/phones/emails/IDs.

Below are exemplars of sensitive statements:
- "Researches treatment about arthritis"
- "Searches about pregnancy tests online"
- "Pediatrician in San Francisco"
- "Political leaning towards a party"
- "Research about ethnicity demographics in a city"
- "Negotiates debt settlement with bank"
- "Prepares documents for divorce hearing"
- "Tracks mortgage refinance rates"
- "Applies for work visa extension"
- "Marie, female from Ohio looking for rental apartments"

If all statements are not sensitive, simply return them all.

Here are the statements to analyze:
${insightsJSON}

Return ONLY JSON per the schema below.
\`\`\`json
{
  "non_sensitive_insights": [
    "<insight_statement_1>",
    "<insight_statement_2>",
    ...
  ]
}
\`\`\`
`.trim();
}

// ============================================================================
// Main Insights Generation Functions
// ============================================================================

/**
 * Calls LLM to generate insights and processes the response
 *
 * @param {object} profile - Profile data to analyze
 * @param {string} source - Source type ('history', 'conversation', or 'custom')
 * @returns {Promise<object>} Parsed JSON response with categories
 */
async function generateInsightsWithLLM(profile, source) {
  let profile_records = [];
  if (source === "history") {
    profile_records = profile?.profile_summarized ?? profile ?? [];
  } else if (source === "custom") {
    profile_records = profile;
  } else if (source === "user") {
    profile_records = profile;
  } else if (Array.isArray(profile)) {
    profile_records = profile;
  }

  // Check for custom prompt in module state
  const customPromptTemplate = getCustomPrompt();

  const insightsData = getInsightsData();
  const related_insights = Object.values(insightsData)
    .filter(Array.isArray)
    .flat()
    .slice(0, 300);

  let promptText;
  if (customPromptTemplate) {
    // Replace placeholders in custom template
    promptText = customPromptTemplate
      .replace("{PROFILE_RECORDS}", JSON.stringify(profile_records, null, 2))
      .replace("{RELATED_INSIGHTS}", JSON.stringify(related_insights, null, 2));
  } else {
    // Use default prompt builder
    promptText = buildLiveInsightPrompt({
      profile_records,
      related_insights,
    });
  }

  // promptText is the full payload
  const total = estimateTokens(promptText);
  console.debug("Approx tokens:", total);
  // console.debug(`promptText = ${JSON.stringify(promptText)}`);

  const engine = await createOpenAIEngine();

  // First pass: generate candidate insights
  const response = await engine.run({
    args: [
      {
        role: "system",
        content:
          "You are a privacy respecting data analyst who tries to generate useful insights about user preferences EXCLUDING personal, medical, health, financial, political, religion, private and any sensitive activities of users. Return ONLY valid JSON.",
      },
      { role: "user", content: promptText },
    ],
    responseFormat: { type: "json_schema", schema: LIVE_INSIGHTS_SCHEMA },
  });

  const rawContent = response?.finalOutput ?? "";
  const parsed = extractJSON(rawContent);
  const list = normalizeInsightList(parsed);
  const intentSummaryList = list.map(insight => {
    return insight.insight_summary;
  });

  console.debug(`Generated ${list.length} raw insights from LLM.`);

  // Second pass: deduplicate
  const dedupeInsightsPrompt = buildDedupeInsightsPrompt({
    insights: intentSummaryList,
    existing_insights: related_insights,
  });
  const dedupeResponse = await engine.run({
    args: [
      {
        role: "system",
        content:
          "You are an expert at identifying duplicate statements. Return ONLY valid JSON.",
      },
      { role: "user", content: dedupeInsightsPrompt },
    ],
    responseFormat: { type: "json_schema", schema: INSIGHTS_DEDUPE_SCHEMA },
  });

  const dedupeRawContent = dedupeResponse?.finalOutput ?? "";
  const dedupeParsed = extractJSON(dedupeRawContent);
  const dedupeList =
    dedupeParsed?.unique_insights.map(insight => {
      return insight.main_insight;
    }) || [];

  console.debug(`Deduped to ${dedupeList.length} unique insights.`);

  // Third pass: filter out sensitive insights
  // Pass the raw list of deduped insights directly to the sensitivity filter
  const nonSensitiveInsightsPrompt = buildNonSensitiveInsightsPrompt({
    insights: dedupeList,
  });
  const nonSensitiveResponse = await engine.run({
    args: [
      {
        role: "system",
        content:
          "You are an expert at identifying sensitive statements and content. Return ONLY valid JSON.",
      },
      { role: "user", content: nonSensitiveInsightsPrompt },
    ],
    responseFormat: {
      type: "json_schema",
      schema: INSIGHTS_NON_SENSITIVE_SCHEMA,
    },
  });

  const nonSensitiveRawContent = nonSensitiveResponse?.finalOutput ?? "";
  const nonSensitiveParsed = extractJSON(nonSensitiveRawContent);
  const nonSensitiveList = nonSensitiveParsed?.non_sensitive_insights || [];

  console.debug(
    `Filtered to ${nonSensitiveList.length} non-sensitive insights.`
  );

  // Put the final list together
  const finalNewInsights = [];
  for (const insight of list) {
    if (
      !related_insights.includes(insight.insight_summary) &&
      nonSensitiveList.includes(insight.insight_summary)
    ) {
      finalNewInsights.push(insight);
    }
  }

  if (!list) {
    // Expected when everything is sensitive or model returns a lone object
    console.warn("No valid insights; returning placeholder.");
    return [placeholderInsight()];
  }

  return finalNewInsights; // array of insights
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

  // NEW: rich index (array per category) + migration
  const richIndex = ensureRichIndex(insightsData);

  let addedCount = 0;
  let upsertedByCategory = 0;

  for (const obj of items) {
    const category = (obj?.category ?? "").trim();
    const summary = (obj?.insight_summary ?? "").trim();
    const intent = (obj?.intent ?? "").trim();
    const score = Number.isFinite(obj?.score) ? Number(obj.score) : null;
    const evidence = Array.isArray(obj?.evidence) ? obj.evidence : [];
    const why = typeof obj?.why === "string" ? obj.why : "";
    const ts = Date.now();

    if (category) {
      // // Ensure array for this category
      const existing = richIndex[category];
      let arr;
      if (Array.isArray(existing)) {
        arr = existing;
      } else if (existing != null) {
        arr = [existing];
      } else {
        arr = [];
      }
      richIndex[category] = arr;
      const key = normalizeKey(summary, intent);

      // Try to upsert by (summary,intent)
      let found = false;
      for (let i = 0; i < richIndex[category].length; i++) {
        const cur = richIndex[category][i];
        const curKey = normalizeKey(cur?.insight_summary, cur?.intent);
        if (curKey === key) {
          // Update-in-place, prefer new fields if provided
          richIndex[category][i] = {
            ...cur,
            insight_summary: summary || cur.insight_summary || "",
            category: category || cur.category || "",
            intent: intent || cur.intent || "",
            score: Number.isFinite(score) ? score : (cur?.score ?? null),
            evidence: evidence.length ? evidence : (cur?.evidence ?? []),
            why: why || cur?.why || "",
            updated_at: ts,
          };
          found = true;
          break;
        }
      }

      if (!found && summary) {
        // Insert newest at the front
        richIndex[category].unshift({
          insight_summary: summary,
          category,
          intent,
          score,
          evidence,
          why,
          updated_at: ts,
        });
      }
      upsertedByCategory += 1;
    }

    // ---- Legacy chips: unchanged ----
    const label = summary;
    if (category) {
      if (!insightsData[category]) {
        insightsData[category] = [];
      }
      if (label && !insightsData[category].includes(label)) {
        insightsData[category].push(label);
        addedCount += 1;
      }
    }
  }

  smartWindow?.setInsightsData(insightsData);
  return { addedCount, upsertedByCategory };
}

function validateInsightGeneric(ins) {
  if (!ins || !ins.insight_summary || !ins.category) {
    return { ok: false, reason: "missing_fields" };
  }

  // evidence presence
  if (!Array.isArray(ins.evidence) || ins.evidence.length < 1) {
    return { ok: false, reason: "no_evidence" };
  }

  return { ok: true };
}

function specificityBonus(insight) {
  // heuristic: favor concrete constraints/entities in the sentence
  const s = (insight.insight_summary || "").toLowerCase();
  let b = 0;
  if (/\b(under|below|\$ ?\d+|\d+-\d+)\b/.test(s)) {
    b += 0.15;
  } // price
  if (/\b(xs|s|m|l|xl|xxl|\d{1,2}(\.\d)?(in|cm|gb|tb))\b/.test(s)) {
    b += 0.1;
  } // size/spec
  if (/\b(gluten[-\s]?free|vegan|keto|dairy[-\s]?free)\b/.test(s)) {
    b += 0.15;
  } // diet
  if (/[A-Z][a-z]+(?:\s&\s[A-Z][a-z]+)?/.test(insight.insight_summary)) {
    b += 0.1;
  } // brand-ish
  return b;
}

function normalizeBrand(str) {
  return (str || "")
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, "")
    .replace(/www\./g, "")
    .replace(/\.(com|ca|org|net|io|ai)\b/g, "")
    .replace(/[^\w\s]/g, " ")
    .trim();
}

function extractBrandsFromEvidence(ev = []) {
  const bag = new Set();
  for (const e of ev || []) {
    const v = normalizeBrand(e?.value);
    if (v) {
      const brandHead = v.split(/\s+/)[0];
      if (brandHead.length > 1) {
        // Make sure a single letter isn't counted as a "brand"
        bag.add(brandHead);
      }
    } // rough head token
  }
  return bag;
}

function synthWhyFromEvidence(ev = []) {
  const bits = (ev || []).slice(0, 3).map(e => {
    const t = e?.type || "signal";
    const v = (e?.value || "").slice(0, 80);
    return `${t}: ${v}`;
  });
  return bits.length
    ? `Supported by ${bits.join("; ")}`
    : "Supported by recent ranked signals";
}

function placeholderInsight() {
  return {
    category: null,
    intent: null,
    insight_summary: null,
    score: 1,
    why: "No safe, specific insight supported by inputs after verification.",
    evidence: [],
  };
}

function sanitizeInsight(x) {
  if (!x || typeof x !== "object") {
    return null;
  }

  // clamp score to [1,5]; treat missing/invalid as 1
  let score = Number.isFinite(x.score) ? Math.round(x.score) : 1;
  if (score < 1) {
    score = 1;
  }
  if (score > 5) {
    score = 5;
  }

  // ensure evidence array shape and cap to 4
  const evidence = Array.isArray(x.evidence)
    ? x.evidence
        .filter(e => e && typeof e.value === "string" && e.value.trim())
        .slice(0, 4)
    : [];

  return {
    category: x.category ?? null,
    intent: x.intent ?? null,
    insight_summary: x.insight_summary ?? null,
    score,
    why:
      typeof x.why === "string" && x.why.trim()
        ? x.why
        : "Suppressed due to sensitive content or insufficient support.",
    evidence,
  };
}

function normalizeInsightList(parsed) {
  let list = parsed;
  // Common wraps: object or { items: [...] }
  if (!Array.isArray(list)) {
    if (list && Array.isArray(list.items)) {
      list = list.items;
    } else if (list && typeof list === "object") {
      // If it looks like a single insight object, wrap it
      const looksLikeInsight =
        "category" in list ||
        "intent" in list ||
        "insight_summary" in list ||
        "evidence" in list;
      if (looksLikeInsight) {
        list = [list];
      }
    }
  }
  if (!Array.isArray(list)) {
    return null;
  }

  const sanitized = list.map(sanitizeInsight).filter(Boolean);
  return sanitized.length ? sanitized : null;
}

function rankAndDiversify(insights, { maxPerCategory = 2 } = {}) {
  // score ↑ with specificity + multi-source corroboration
  for (const x of insights) {
    const base = Math.max(1, Math.min(5, Number(x.score) || 1)) / 5;
    const ev = Array.isArray(x.evidence) ? x.evidence : [];
    const sources = new Set(ev.map(e => e?.type));
    const brandBonus = /[A-Z][a-z]+/.test(x.insight_summary || "") ? 0.05 : 0;
    const multiSrcBonus = Math.min(sources.size - 1, 2) * 0.1; // up to +0.2
    const specBonus = specificityBonus(x); // your existing heuristic
    x.__rank = base + brandBonus + multiSrcBonus + specBonus;
    if (!x.why) {
      x.why = synthWhyFromEvidence(ev);
    }
  }

  // sort by rank
  insights.sort((a, b) => b.__rank - a.__rank);

  // enforce diversity caps
  const byCat = new Map();
  const byIntent = new Map();
  const byBrand = new Map();
  const out = [];

  for (const x of insights) {
    const c = x.category || "null";
    const i = x.intent || "null";

    const brands = extractBrandsFromEvidence(x.evidence);

    if ((byCat.get(c) || 0) >= maxPerCategory) {
      continue;
    }

    out.push(x);
    byCat.set(c, (byCat.get(c) || 0) + 1);
    byIntent.set(i, (byIntent.get(i) || 0) + 1);
    for (const b of brands) {
      byBrand.set(b, (byBrand.get(b) || 0) + 1);
    }
  }

  return out;
}

function estimateTokens(str) {
  // Very rough: 1 token ≈ 4 chars
  return Math.ceil((str || "").length / 4);
}

function partitionAndValidate(items) {
  const validated = [];
  const rejected = [];
  for (const x of items) {
    const v = validateInsightGeneric(x); // <- your generic validator
    (v.ok ? validated : rejected).push({
      ins: x,
      reason: v.reason,
      detail: v.detail,
    });
  }
  return { validated: validated.map(r => r.ins), rejected };
}

export async function analyzeHistorySmart() {
  const meta = getInsightsMeta();
  const firstRun =
    !Number.isFinite(meta.history?.lastMicros) ||
    (meta.history?.lastMicros || 0) === 0;

  if (firstRun) {
    const maxResults = Services.prefs.getIntPref(
      "browser.smartwindow.insights.historyMaxResults",
      3000
    );
    return generateInsightsFromHistory({ days: 60, maxResults }); // full run
  }
  return updateInsightsFromHistoryIncremental();
}

export async function analyzeConversationsSmart() {
  const meta = getInsightsMeta();
  const firstRun =
    !Number.isFinite(meta.conversations?.lastTs) ||
    (meta.conversations?.lastTs || 0) === 0;

  if (firstRun) {
    return generateInsightsFromConversations(); // uses your existing 30-day logic
  }
  return updateInsightsFromConversationsIncremental();
}

const INSIGHTS_SCHEDULER_PAGES_THRESHOLD = 5;
const INSIGHTS_SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 mins

/**
 * Runs history-based insight generation after enough visits have accumulated, and on
 * a timer.
 *
 * TODO - This runs once per browser window, and should be consolidated into some
 * kind of singleton. For instance, if you have 5 browser windows open, there will
 * be 5 schedulers running at the same time racing to control the insights.
 */
export class InsightsScheduler {
  /** @type {number} */
  #pagesVisited = 0;
  /** @type {number} */
  #intervalHandle = 0;
  #destroyed = false;

  /**
   * TODO - This should be initialized inside of browser/base/content/browser-smart-window.js
   * but this file can't be loaded as in ESM module from that context because it loads
   * lit which expects a window object to be available.
   */
  static initialize() {
    const sw = getSmartWindow();
    if (sw && !sw.insightsScheduler) {
      sw.insightsScheduler = new InsightsScheduler();
    }
  }

  constructor() {
    this.startInterval();
    PlacesUtils.observers.addListener(["page-visited"], this.#onPageVisited);
    console.log(`[InsightsScheduler] Initialized`);
  }

  startInterval() {
    if (this.#intervalHandle) {
      throw new Error(
        "Attempting to start an interval when one already existed."
      );
    }
    this.#intervalHandle = setInterval(
      this.#onInterval,
      INSIGHTS_SCHEDULER_INTERVAL_MS
    );
  }

  stopInterval() {
    clearInterval(this.#intervalHandle);
    this.#intervalHandle = 0;
  }

  #onPageVisited = () => {
    this.#pagesVisited++;
  };

  #onInterval = async () => {
    if (this.#destroyed) {
      throw new Error(
        "The interval timer ran when the component was already destroyed."
      );
    }
    if (
      this.#pagesVisited < INSIGHTS_SCHEDULER_PAGES_THRESHOLD ||
      getSmartWindow()?.isGeneratingInsights()
    ) {
      console.log(
        `[InsightsScheduler] Analysis not run because ${this.#pagesVisited}/${INSIGHTS_SCHEDULER_PAGES_THRESHOLD} pages were visited.`
      );
      return;
    }

    this.stopInterval();

    try {
      console.log(
        `[InsightsScheduler] Analyzing history with ${this.#pagesVisited} new pages`
      );
      await analyzeHistorySmart();
      this.#pagesVisited = 0;
      window.dispatchEvent(new CustomEvent("insights-updated"));

      console.log(`[InsightsScheduler] Analysis complete.`);
    } catch (error) {
      console.error("[InsightsScheduler] Failed to analyze history", error);
    } finally {
      if (!this.#destroyed) {
        this.startInterval();
      }
    }
  };

  destroy() {
    this.stopInterval();
    PlacesUtils.observers.removeListener(["page-visited"], this.#onPageVisited);
    this.#destroyed = true;
  }
}

InsightsScheduler.initialize();

/**
 * Generates insights from browsing history using an LLM.
 *
 * Fetches recent Places history, sessionizes visits, aggregates signals,
 * calls the LLM to produce insights, and writes results into SmartWindow storage.
 *
 * @param {object} [opts] - Options for the analysis.
 * @param {number} [opts.days=60] - How many days of history to scan.
 * @param {number} [opts.maxResults=1000] - Max history rows to fetch from Places.
 * @returns {Promise<void>} Resolves when insights are generated and stored.
 * @throws {Error} If an analysis is already running, no history is found,
 *   or an internal step fails (history fetch, LLM call, or storage write).
 */
export async function generateInsightsFromHistory(
  opts = { days: 60, maxResults: 1000 }
) {
  return withGenerationLock(async () => {
    const { days = 60, maxResults = 1000 } = opts;

    console.log("[Insights] Fetching browsing history...");
    const baseRows = await getRecentHistory({ days, maxResults });
    if (!baseRows.length) {
      throw new Error("No browsing history found");
    }

    console.log(`[Insights] Found ${baseRows.length} history items`);
    const sessionized = sessionizeVisits(baseRows);
    const prepared = generateProfileInputs(sessionized);
    const [agg_domains, agg_titles, agg_searches] = aggregateSessions(prepared);

    const topk = topkAggregates(agg_domains, agg_titles, agg_searches, {
      k_domains: 100,
      k_titles: 60,
      k_searches: 25,
    });

    console.log(`[Insights] Generating insights with LLM...`);
    await runInsights(topk, "history", {
      preview: false,
      caps: { maxPerCategory: 5, maxPerIntent: 2 },
    });

    // Seed meta for incrementals
    const meta = getInsightsMeta();
    const newestMicros = Math.max(
      0,
      ...baseRows.map(r => Number(r.visitDateMicros) || 0)
    );
    meta.history.lastMicros = newestMicros;
    meta.history.tail = [];
    meta.history.deltaRuns = 0;

    meta.agg_cache = meta.agg_cache || {};
    meta.agg_cache.history = {
      0: agg_domains,
      1: agg_titles,
      2: agg_searches,
      num_sessions: new Set(sessionized.map(x => x.session_id)).size,
    };
    setInsightsMeta(meta);
  });
}

export async function updateInsightsFromHistoryIncremental() {
  return withGenerationLock(async () => {
    const meta = getInsightsMeta();
    const lastMicros = meta.history?.lastMicros || 0;
    const prevTail = meta.history?.tail || [];
    const prevAgg = meta.agg_cache?.history || null; // [d,t,s,num_sessions]
    const overLapHours = 0.5;

    const deltaRows = await getRecentHistoryDelta({
      sinceMicros: lastMicros,
      overlapMs: overLapHours * 3600 * 1000,
      maxResults: 500,
    });
    console.debug(`deltaRows length = ${deltaRows.length}`);
    if (!deltaRows.length && prevTail.length === 0) {
      console.log("[Insights] No new history rows.");
      return;
    }

    const { windowSessionized, newTail } = sessionizeIncremental(
      prevTail,
      deltaRows
    );
    const newestMicros = Math.max(
      lastMicros,
      ...deltaRows.map(r => Number(r.visitDateMicros) || 0)
    );

    // If nothing new beyond tail, just advance meta and exit
    if (!windowSessionized.length && newestMicros <= lastMicros) {
      meta.history.tail = newTail;
      setInsightsMeta(meta);
      return;
    }

    // Build & merge aggregates
    const deltaAgg = aggregateDelta(windowSessionized);
    let mergedAgg, totalSessions;
    if (prevAgg) {
      const prevTriplet = unpackAggTriplet(prevAgg);
      mergedAgg = mergeAggregates(prevTriplet, deltaAgg);
      totalSessions =
        (meta.agg_cache.history?.num_sessions || 0) +
        new Set(windowSessionized.map(x => x.session_id)).size;
    } else {
      mergedAgg = deltaAgg;
      totalSessions = new Set(windowSessionized.map(x => x.session_id)).size;
    }
    recomputeSessionImportance(mergedAgg[0], mergedAgg[1], totalSessions);

    // Top-k on just the delta to keep prompts small
    const deltaTopK = topkAggregates(deltaAgg[0], deltaAgg[1], deltaAgg[2], {
      k_domains: 20,
      k_titles: 30,
      k_searches: 5,
    });
    const deltaMagnitude =
      deltaTopK[0].length + deltaTopK[1].length + deltaTopK[2].length;

    if (deltaMagnitude > 0) {
      await runInsights(deltaTopK, "history", {
        preview: false,
        caps: { maxPerCategory: 3, maxPerIntent: 2 },
      });
    } else {
      console.log("[Insights] Delta too small; skipping LLM.");
    }

    // Persist meta + caches
    meta.history.lastMicros = newestMicros;
    meta.history.tail = newTail.map(r => ({
      url: r.url,
      domain: r.domain,
      title: r.title,
      visitDateMicros: r.visitDateMicros,
      frequencyPct: r.frequencyPct,
      domainFrequencyPct: r.domainFrequencyPct,
      source: r.source,
    }));
    meta.agg_cache = meta.agg_cache || {};
    meta.agg_cache.history = {
      0: mergedAgg[0],
      1: mergedAgg[1],
      2: mergedAgg[2],
      num_sessions: totalSessions,
    };
    setInsightsMeta(meta);
  });
}

// ===================== Public Entry: generateInsightsWithCoVe =====================

/**
 * CoVe-wrapped insights generator:
 * 1) Draft insights
 * 2) CoVe question+answer
 * 3) Integrate verdicts, soften/reject as needed
 *
 * @param {Record<string, any> | Array<Record<string, any>> | {profile_summarized?: Array<Record<string, any>>}} profile -
 *   Profile data to analyze. For "history", pass an object with optional `profile_summarized`;
 *   for "custom", pass the records as-is; arrays are treated directly as records.
 * @param {"history"|"conversation"|"custom"} source - Indicates how to interpret `profile` when generating insights.
 */
export async function generateInsightsWithCoVe(profile, source) {
  // 1) Draft
  const draftList = await generateInsightsWithLLM(profile, source);

  // Prepare Inputs seen by the verifier:
  let profile_records = [];
  if (source === "history") {
    profile_records = profile?.profile_summarized ?? profile ?? [];
  } else if (source === "custom") {
    profile_records = profile ?? [];
  } else if (Array.isArray(profile)) {
    profile_records = profile;
  }

  const related_insights = Object.values(getInsightsData())
    .filter(Array.isArray)
    .flat()
    .slice(0, 300);

  // 2-3) CoVe
  const finalList = await runCoVe(draftList, profile_records, related_insights);

  if (!Array.isArray(finalList) || finalList.length === 0) {
    // If CoVe filtered everything, we return a single null object to match schema expectations
    return [
      {
        category: null,
        intent: null,
        insight_summary: null,
        score: 1,
        why: "No safe, specific insight supported by inputs after verification.",
        evidence: [],
      },
    ];
  }

  return finalList;
}

/**
 * Generates insights from conversation history using LLM
 *
 * @returns {Promise<void>}
 */
export async function generateInsightsFromConversations() {
  return withGenerationLock(async () => {
    console.log("[Insights] Fetching conversation history...");
    const chatHistory = await getUserChats({
      days: 30,
      maxConversations: 50,
      halfLifeDays: 14,
    });
    if (!chatHistory.length) {
      throw new Error("No conversation history found");
    }

    console.log(`[Insights] Found ${chatHistory.length} conversations`);
    await runInsights(chatHistory, "conversation", {
      preview: false,
      caps: {
        maxPerCategory: 2,
        maxPerIntent: 2,
      },
    });

    // Watermark
    const meta = getInsightsMeta();
    meta.conversations.lastTs = Math.max(
      0,
      ...chatHistory.map(c => c.lastTs || 0)
    );
    setInsightsMeta(meta);
  });
}

export async function updateInsightsFromConversationsIncremental() {
  return withGenerationLock(async () => {
    const meta = getInsightsMeta();
    const lastTs = meta.conversations?.lastTs || 0;

    const delta = await getUserChatsDelta({
      sinceTs: lastTs,
      halfLifeDays: 14,
      maxConversations: 50,
    });
    if (!delta.length) {
      console.log("[Insights] No new conversations.");
      return;
    }

    await runInsights(delta, "conversation", {
      preview: false,
      caps: {
        maxPerCategory: 2,
        maxPerIntent: 2,
      },
    });

    const newest = Math.max(lastTs, ...delta.map(d => d.lastTs || 0));
    meta.conversations.lastTs = newest;
    setInsightsMeta(meta);
  });
}

/**
 * Generates insights from custom text input using LLM
 *
 * @param {string} inputText - The text input from user
 * @returns {Promise<void>}
 */
export async function generateInsightsFromCustomText(inputText) {
  return withGenerationLock(async () => {
    const text = (inputText || "").trim();
    if (!text) {
      throw new Error("No input text provided");
    }

    await runInsights(text, "custom", {
      preview: false,
      caps: { maxPerCategory: 2, maxPerIntent: 2 },
    });
  });
}

/**
 * Uses the LLM (and CoVe when enabled) to turn a direct user statement
 * (e.g., "Remember I'm a vegan") into a single safe insight.
 *
 * - Deterministic guardrails first: reject sensitive content.
 * - Calls the same runInsights() path as history/conversation, but with
 *   source="custom" so the LLM sees our structured record verbatim.
 * - The record embeds the raw text so CoVe's evidence check passes.
 *
 * @param {string} inputText
 * @returns {Promise<{addedCount:number}>}
 * @throws {Error} if input is empty or sensitive
 */
export async function generateInsightsFromDirectChat(inputText) {
  console.log(`inputText => ${inputText}`);
  return withGenerationLock(async () => {
    const text = (inputText || "").trim();
    if (!text) {
      throw new Error("No input text provided");
    }
    if (containsSensitive(text)) {
      throw new Error("Refusing to store sensitive content as an insight");
    }

    // Minimal but explicit "profile" so the LLM/CoVe can quote it verbatim.
    // Keeping keys human-readable helps the model follow our schema prompt.
    const profile_records = [
      {
        source: "user",
        kind: "explicit_preference",
        message: text, // ← CoVe evidenceStringsExistInProfile will see this
        timestamp_iso: new Date().toISOString(),
      },
    ];

    // Reuse the same pipeline selector (regular vs CoVe) and storage path.
    const { list } = await runInsights(profile_records, "user", {
      preview: true,
      caps: {
        maxPerCategory: 5,
        maxPerIntent: 2,
      },
    });

    return {
      previewCount: list ? list.length : 0,
      list: list || [],
    };
  });
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
 * Deletes an insight from storage
 *
 * @param {string} insight
 * @param {string} category
 * @returns {boolean}
 */
export function deleteInsight(insight, category) {
  const smartWindow = getSmartWindow();
  const insightsData = getInsightsData();

  let changed = false;

  if (insightsData[category]) {
    const i = insightsData[category].indexOf(insight);
    if (i > -1) {
      insightsData[category].splice(i, 1);
      changed = true;
    }
  }

  const richIndex = ensureRichIndex(insightsData);
  if (Array.isArray(richIndex[category])) {
    const before = richIndex[category].length;
    richIndex[category] = richIndex[category].filter(
      r => (r?.insight_summary || "") !== insight
    );
    changed = changed || richIndex[category].length !== before;
  }

  if (changed) {
    smartWindow?.setInsightsData(insightsData);
  }
  return changed;
}

/**
 * Detects §insight: ...§ tokens in content
 *
 * @param {string} content
 * @returns {Array<{fullMatch:string, insight:string, startIndex:number, endIndex:number}>}
 */
export function detectInsightTokens(content) {
  const insightRegex = /§existing_insight:\s*([^§]+)§/gi;
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
 * Classify a freeform message into {category, intent} using the LLM.
 * Falls back to regex heuristics if the model yields nulls.
 *
 * @param {string} message
 *   The user's raw input message to classify.
 */
async function classifyMessage(message) {
  const engine = await createOpenAIEngine();
  const categories = JSON.stringify(CATEGORIES);
  const intents = JSON.stringify(INTENTS);

  const resp = await engine.run({
    args: [
      {
        role: "system",
        content:
          "Classify the user's message into a single high-level Category and Intent. Return ONLY valid JSON per schema.",
      },
      {
        role: "user",
        content: `
          Message:
          ${message}

          Pick exactly ONE Category from:
          ${categories}

          Pick exactly ONE Intent from:
          ${intents}

          Guidance:
          - Choose the most directly implied category/intent.
          - If ambiguous, pick the closest likely choice.
          - Keep it non-sensitive and general; do NOT fabricate specifics.
        `.trim(),
      },
    ],
    responseFormat: { type: "json_schema", schema: CLASSIFY_MESSAGE_SCHEMA },
  });

  const raw = resp?.finalOutput ?? "{}";
  const parsed = extractJSON(raw);

  // Helper: read any of these keys without changing value casing
  const get = (o, keys) => {
    for (const k of keys) {
      if (o && Object.prototype.hasOwnProperty.call(o, k)) {
        return o[k];
      }
    }
    return undefined;
  };

  let category = get(parsed, ["category", "Category"]);
  let intent = get(parsed, ["intent", "Intent"]);
  let confidence = get(parsed, ["confidence", "Confidence"]);

  if (typeof category === "string") {
    category = category.trim();
  }
  if (typeof intent === "string") {
    intent = intent.trim();
  }
  confidence = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;

  // Validate strictly against your enums (case-sensitive)
  if (!CATEGORIES.includes(category)) {
    category = null;
  }
  if (!INTENTS.includes(intent)) {
    intent = null;
  }

  // treat very low confidence as “unsure”
  const CONFIDENCE_MIN = 0.2;
  if (confidence < CONFIDENCE_MIN) {
    if (!category) {
      category = null;
    }
    if (!intent) {
      intent = null;
    }
  }

  // Apply fallbacks only if needed
  if (!category) {
    category = fallbackCategoryFromMessage(message) || null;
  }
  if (!intent) {
    intent = fallbackIntentFromMessage(message) || null;
  }

  // Clamp confidence
  confidence = Math.max(0, Math.min(1, confidence));

  console.log(`parsed = ${JSON.stringify(parsed)}`);
  console.log(`predicted category = ${category}`);
  console.log(`predicted intent = ${intent}`);
  console.log(`predicted confidence = ${confidence}`);

  return { category, intent, confidence };
}

/**
 * Select top insights from the predicted category (and intent if available).
 *
 * @param {string} message
 * @param {object} [opts]
 * @param {number} [opts.limit=5]
 * @returns {Promise<{predicted_category:string|null, predicted_intent:string|null, selected:Array, available_count:number}>}
 */
export async function getRelevantInsights(message, opts = {}) {
  const input = String(message || "").trim();
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || 5));

  if (!input) {
    return {
      predicted_category: null,
      predicted_intent: null,
      selected: [],
      available_count: 0,
      note: "Empty message; nothing to select.",
    };
  }

  // 1) predict category/intent
  const { category, intent } = await classifyMessage(input);

  // 2) pull indexed insights
  const data = getInsightsData();
  const index = ensureRichIndex(data);

  // No category? try a soft sweep: gather from all cats and still rank
  const candidateLists =
    category && index[category] ? index[category] : Object.values(index).flat();

  console.log(`[Insights] candidateLists = ${JSON.stringify(candidateLists)}`);

  if (!Array.isArray(candidateLists) || candidateLists.length === 0) {
    return {
      predicted_category: category || null,
      predicted_intent: intent || null,
      selected: [],
      available_count: 0,
    };
  }

  // 3) score: base(score) + categoryPrior + intentExact + textOverlap
  const CATEGORY_MATCH_BOOST = 0.75; // exact category hit
  const CATEGORY_MISMATCH_PENALTY = -0.25; // gentle nudge down for others during soft sweep

  const ranked = candidateLists
    .map(obj => {
      const base = Math.max(1, Math.min(5, Number(obj?.score) || 1)) / 5; // 0.2..1.0

      const iBoost =
        intent && obj?.intent && safeLc(obj.intent) === safeLc(intent)
          ? 0.15
          : 0;

      const tBoost = textOverlapBoost(input, obj);

      let cBoost = 0;
      if (category) {
        cBoost =
          safeLc(obj?.category) === safeLc(category)
            ? CATEGORY_MATCH_BOOST
            : CATEGORY_MISMATCH_PENALTY;
      }

      // Keep composite non-negative (defensive)
      const composite = Math.max(0, base + cBoost + iBoost + tBoost);

      return { obj, composite };
    })
    .sort((a, b) => b.composite - a.composite)
    .slice(0, limit)
    .map(({ obj, composite }) => ({
      category: obj?.category || category || null,
      intent: obj?.intent ?? null,
      insight_summary: obj?.insight_summary ?? "",
      score: obj?.score ?? null,
      updated_at: obj?.updated_at ?? null,
      evidence: Array.isArray(obj?.evidence) ? obj.evidence.slice(0, 3) : [],
      why: obj?.why || "",
      composite,
    }));

  console.log(`[Insights] ranked = ${JSON.stringify(ranked)}`);

  if (ranked) {
    return {
      available: true,
      insights: ranked,
    };
  }
  return {
    available: false,
    insights: ranked,
  };
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

function getRichInsights(category) {
  const data = getInsightsData();
  const val = data?.insightsDataByCategory?.[category];
  if (!val) {
    return [];
  }
  return Array.isArray(val) ? val : [val]; // compat with any pre-migration state
}

// Back-compat: first item, if callers still use singular
function getRichInsight(category) {
  const list = getRichInsights(category);
  return list[0] || null;
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

  // Helper to get default prompt with placeholders
  const getDefaultPrompt = () =>
    buildLiveInsightPrompt({
      profile_records: "{PROFILE_RECORDS}",
      related_insights: "{RELATED_INSIGHTS}",
    })
      .replace('"{PROFILE_RECORDS}"', "{PROFILE_RECORDS}")
      .replace('"{RELATED_INSIGHTS}"', "{RELATED_INSIGHTS}");

  const handleGenerateHistory = async () => {
    try {
      await analyzeHistorySmart();
    } catch (e) {
      console.error("Failed to generate insights from history:", e);
    }
    window.dispatchEvent(new CustomEvent("insights-updated"));
  };

  const handleGenerateConversations = async () => {
    try {
      await analyzeConversationsSmart();
    } catch (e) {
      console.error("Failed to generate insights from conversations:", e);
    }
    window.dispatchEvent(new CustomEvent("insights-updated"));
  };

  // Dynamic labels based on whether we have any watermark yet:
  const handleClearGenerated = () => {
    clearGeneratedInsights();
    window.dispatchEvent(new CustomEvent("insights-updated"));
  };

  const handleGenerateCustom = async event => {
    // Get the input element from the event target's parent
    const input = event.target.parentElement.querySelector(
      "#llm-insights-input"
    );
    const text = input?.value?.trim();

    if (!text) {
      console.warn("No text provided for LLM insights generation");
      return;
    }

    try {
      await generateInsightsFromCustomText(text);
      // Clear the input after successful generation
      if (input) {
        input.value = "";
      }
    } catch (error) {
      console.error("Failed to generate insights with LLM:", error);
    }
    window.dispatchEvent(new CustomEvent("insights-updated"));
  };

  const handleTogglePromptEditor = () => {
    setPromptEditorVisible(!isPromptEditorVisible());
    window.dispatchEvent(new CustomEvent("insights-updated"));
  };

  const handlePromptChange = event => {
    setCustomPrompt(event.target.value);
  };

  const handleResetPrompt = () => {
    setCustomPrompt(null);
    setPromptEditorVisible(false);
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
            class="action-btn secondary ${isPromptEditorVisible()
              ? "active"
              : ""}"
            @click=${handleTogglePromptEditor}
            title="Edit prompt template"
          >
            ${isPromptEditorVisible() ? "Hide Prompt" : "Edit Prompt"}
          </button>
          <button
            class="action-btn secondary"
            @click=${copyInsightsToClipboard}
            title="Copy signals to clipboard"
          >
            📋 Copy Signals
          </button>
        </div>

        ${isPromptEditorVisible()
          ? html`
              <div class="prompt-editor-section">
                <div class="prompt-editor-header">
                  <span class="prompt-editor-label">Prompt Template</span>
                  <span class="prompt-editor-help"
                    >Use {PROFILE_RECORDS} and {RELATED_INSIGHTS} as
                    placeholders</span
                  >
                </div>
                <textarea
                  id="prompt-editor-textarea"
                  class="prompt-editor-textarea"
                  @input=${handlePromptChange}
                  .value=${getCustomPrompt() || getDefaultPrompt()}
                ></textarea>
                <div class="prompt-editor-actions">
                  <button
                    class="action-btn secondary"
                    @click=${handleResetPrompt}
                  >
                    Reset to Default
                  </button>
                </div>
              </div>
            `
          : ""}

        <div class="llm-insights-section">
          <input
            id="llm-insights-input"
            placeholder="Enter text to generate and add signal"
            class="key-input"
            @keydown=${e => {
              if (e.key === "Enter" && !state.isGenerating) {
                handleGenerateCustom(e);
              }
            }}
          />
          <button
            id="llm-insights-submit"
            class="key-submit-button"
            @click=${handleGenerateCustom}
            ?disabled=${state.isGenerating}
          >
            ${state.isGenerating ? "Generating..." : "Generate Signal with LLM"}
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

            return insights.map(({ category, insight_summary }) => {
              const rich = getRichInsight(category);
              const whyText = rich?.why || "";
              const ev = (rich?.evidence || [])
                .slice(0, 2)
                .map(e => `${e.type}: ${e.value}`);

              return html`
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
                    ${rich
                      ? html`
                          <span class="insight-item info">
                            <span class="insight-text">ℹ︎</span>
                            <span class="insight-popover">
                              <strong>Why:</strong> ${whyText || "—"}<br />
                              <strong>Evidence:</strong>
                              <ul>
                                ${ev.map(x => html`<li>${x}</li>`)}
                              </ul>
                            </span>
                          </span>
                        `
                      : ""}
                  </div>
                </div>
              `;
            });
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
    display: flex;
    flex-direction: column;
  }

  .insights-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    background: #f8f9fa;
    flex-shrink: 0;
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
    flex: 1;
    overflow-y: auto;
    min-height: 0;
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
    flex-shrink: 0;
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
    flex-shrink: 0;
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
    flex-shrink: 0;
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

  .llm-insights-section {
    display: flex;
    gap: 0.75rem;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    background: #f8f9fa;
    align-items: center;
    flex-shrink: 0;
  }

  .llm-insights-section .key-input {
    flex: 1;
    padding: 0.75rem 1rem;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    font-size: 0.875rem;
    background: white;
    transition: all 0.2s;
  }

  .llm-insights-section .key-input:focus {
    outline: none;
    border-color: #0066cc;
    box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1);
  }

  .llm-insights-section .key-input::placeholder {
    color: #999;
  }

  .llm-insights-section .key-submit-button {
    padding: 0.75rem 1.5rem;
    background: #0066cc;
    color: white;
    border: 1px solid #0052a3;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .llm-insights-section .key-submit-button:hover:not(:disabled) {
    background: #0052a3;
    transform: translateY(-1px);
    box-shadow: 0 2px 4px rgba(0, 102, 204, 0.2);
  }

  .llm-insights-section .key-submit-button:active {
    transform: translateY(0);
    box-shadow: 0 1px 2px rgba(0, 102, 204, 0.2);
  }

  .llm-insights-section .key-submit-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  .insight-item.info {
    position: relative;
    background: #fffbe6;
    border-color: #ffe58f;
  }
  .insight-item.info .insight-popover {
    display: none;
    position: absolute;
    z-index: 2;
    top: 120%;
    left: 0;
    background: #fff;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    width: 280px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  }
  .insight-item.info:hover .insight-popover {
    display: block;
  }
  .insight-item.info ul {
    margin: 0.25rem 0 0;
    padding-left: 1rem;
  }

  .action-btn.secondary.active {
    background: #e8f4fd;
    color: #0066cc;
    border-color: #b3d7f2;
    font-weight: 600;
  }

  .prompt-editor-section {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    background: #f8f9fa;
    flex-shrink: 0;
  }

  .prompt-editor-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .prompt-editor-label {
    font-weight: 600;
    color: #333;
    font-size: 0.875rem;
  }

  .prompt-editor-help {
    font-size: 0.75rem;
    color: #666;
    font-style: italic;
  }

  .prompt-editor-textarea {
    width: 100%;
    min-height: 300px;
    max-height: 400px;
    padding: 0.75rem;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    font-family: "Monaco", "Menlo", "Courier New", monospace;
    font-size: 0.75rem;
    line-height: 1.5;
    background: white;
    resize: vertical;
    box-sizing: border-box;
  }

  .prompt-editor-textarea:focus {
    outline: none;
    border-color: #0066cc;
    box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1);
  }

  .prompt-editor-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
    justify-content: flex-end;
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

/**
 * Flatten the insights store into [{ category, summary }].
 *
 * @param {{insightsDataByCategory?: Record<string, unknown|unknown[]>}} store
 * @returns {Array<{category: string, summary: string}>}
 */
export function enumerateInsightSummaries(store) {
  const insightsByCategory = store?.insightsDataByCategory ?? {};
  const results = [];

  const asArray = value => {
    if (Array.isArray(value)) {
      return value;
    }
    if (value != null) {
      return [value];
    }
    return [];
  };

  const extractSummary = entry => {
    if (typeof entry === "string") {
      return entry.trim();
    }
    if (entry && typeof entry === "object" && entry.insight_summary) {
      return String(entry.insight_summary).trim();
    }
    return "";
  };

  for (const [category, categoryEntries] of Object.entries(
    insightsByCategory
  )) {
    for (const entry of asArray(categoryEntries)) {
      const summary = extractSummary(entry);
      if (summary) {
        results.push({ category, summary });
      }
    }
  }

  return results;
}

/**
 * Return up to `limit` concise insight summaries for prompt seeding.
 * Wraps enumerateInsightSummaries and adds dedupe + limit.
 *
 * @param {object} store
 * @param {number} [limit=8]
 * @returns {string[]}
 */
export function getInsightSummariesForPrompt(store, limit = 8) {
  const insightEntries = enumerateInsightSummaries(store);
  const summaries = [];
  const seenNormalizedSummaries = new Set();

  for (const { summary } of insightEntries) {
    const summaryText = String(summary ?? "").trim();
    if (!summaryText) {
      continue;
    }

    const normalized = summaryText.toLowerCase();
    if (seenNormalizedSummaries.has(normalized)) {
      continue;
    }

    seenNormalizedSummaries.add(normalized);
    summaries.push(summaryText);

    if (summaries.length >= limit) {
      break;
    }
  }

  return summaries;
}
