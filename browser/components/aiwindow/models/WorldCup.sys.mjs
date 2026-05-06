/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const MERINO_BASE = "https://merino.services.allizom.org/api/v1/wcs";

const PREF_FORCE_MOCK = "browser.smartwindow.worldcup.forceMock";
const PREF_DEBUG = "browser.smartwindow.worldcup.debug";

const MOCK_NEXT = Object.freeze({
  id: "mock-next",
  status: "upcoming",
  kickoff: "2026-05-06T19:00:00Z",
  homeTeam: { name: "Argentina", code: "ARG", flag: "\u{1F1E6}\u{1F1F7}" },
  awayTeam: { name: "Germany", code: "GER", flag: "\u{1F1E9}\u{1F1EA}" },
  isMock: true,
});

const MOCK_RESULTS = Object.freeze([
  Object.freeze({
    id: "mock-bra-col",
    status: "final",
    kickoff: "2026-05-04T20:00:00Z",
    homeTeam: { name: "Brazil", code: "BRA", flag: "\u{1F1E7}\u{1F1F7}", score: 3 },
    awayTeam: { name: "Colombia", code: "COL", flag: "\u{1F1E8}\u{1F1F4}", score: 1 },
    isMock: true,
  }),
  Object.freeze({
    id: "mock-arg-alg",
    status: "final",
    kickoff: "2026-05-04T17:00:00Z",
    homeTeam: { name: "Argentina", code: "ARG", flag: "\u{1F1E6}\u{1F1F7}", score: 3 },
    awayTeam: { name: "Algeria", code: "ALG", flag: "\u{1F1E9}\u{1F1FF}", score: 0 },
    isMock: true,
  }),
  Object.freeze({
    id: "mock-mex-aus",
    status: "final",
    kickoff: "2026-05-04T14:00:00Z",
    homeTeam: { name: "Mexico", code: "MEX", flag: "\u{1F1F2}\u{1F1FD}", score: 1 },
    awayTeam: { name: "Australia", code: "AUS", flag: "\u{1F1E6}\u{1F1FA}", score: 2 },
    isMock: true,
  }),
  Object.freeze({
    id: "mock-fra-usa",
    status: "final",
    kickoff: "2026-05-04T11:00:00Z",
    homeTeam: { name: "France", code: "FRA", flag: "\u{1F1EB}\u{1F1F7}", score: 2 },
    awayTeam: { name: "USA", code: "USA", flag: "\u{1F1FA}\u{1F1F8}", score: 1 },
    isMock: true,
  }),
  Object.freeze({
    id: "mock-ger-jpn",
    status: "final-penalties",
    kickoff: "2026-05-04T08:00:00Z",
    homeTeam: { name: "Germany", code: "GER", flag: "\u{1F1E9}\u{1F1EA}", score: 2 },
    awayTeam: { name: "Japan", code: "JPN", flag: "\u{1F1EF}\u{1F1F5}", score: 2 },
    penalties: { home: 4, away: 3 },
    isMock: true,
  }),
  Object.freeze({
    id: "mock-eng-ita",
    status: "final-penalties",
    kickoff: "2026-05-04T05:00:00Z",
    homeTeam: { name: "England", code: "ENG", flag: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", score: 0 },
    awayTeam: { name: "Italy", code: "ITA", flag: "\u{1F1EE}\u{1F1F9}", score: 0 },
    penalties: { home: 3, away: 4 },
    isMock: true,
  }),
]);

const MOCK_YESTERDAY = Object.freeze({
  ...MOCK_RESULTS[0],
  matches: MOCK_RESULTS,
  next: MOCK_NEXT,
});

function dbg(...args) {
  try {
    if (Services.prefs.getBoolPref(PREF_DEBUG, false)) {
      console.log("WorldCup:", ...args);
    }
  } catch {}
}

function forceMockEnabled() {
  try {
    return Services.prefs.getBoolPref(PREF_FORCE_MOCK, false);
  } catch {
    return false;
  }
}

function pickFirst(json) {
  if (!json) {
    return null;
  }
  if (Array.isArray(json)) {
    return json[0] || null;
  }
  if (Array.isArray(json.matches) && json.matches.length) {
    return json.matches[0];
  }
  if (Array.isArray(json.results) && json.results.length) {
    return json.results[0];
  }
  if (json.match) {
    return json.match;
  }
  if (json.id || json.status || json.homeTeam || json.home_team) {
    return json;
  }
  return null;
}

function normalizeTeam(team) {
  if (!team || typeof team !== "object") {
    return null;
  }
  return {
    name: team.name || team.team_name || team.fullName || team.code || "",
    code: team.code || team.team_code || team.abbr || "",
    flag: team.flag || team.flag_emoji || "",
    score: typeof team.score === "number" ? team.score : team.score ?? null,
  };
}

function normalizeMatch(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const home = normalizeTeam(raw.homeTeam || raw.home_team || raw.home);
  const away = normalizeTeam(raw.awayTeam || raw.away_team || raw.away);
  if (!home || !away) {
    return null;
  }
  if (
    typeof raw.home_score === "number" &&
    home.score == null
  ) {
    home.score = raw.home_score;
  }
  if (
    typeof raw.away_score === "number" &&
    away.score == null
  ) {
    away.score = raw.away_score;
  }
  return {
    id: raw.id || raw.match_id || null,
    status: raw.status || (raw.minute != null ? "live" : null),
    minute: typeof raw.minute === "number" ? raw.minute : raw.minute ?? null,
    kickoff: raw.kickoff || raw.start_time || raw.scheduled_at || null,
    homeTeam: home,
    awayTeam: away,
    venue: raw.venue || raw.stadium || null,
    isMock: false,
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await globalThis.fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`Merino ${resp.status}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export const WorldCup = {
  MOCK_YESTERDAY,

  /**
   * Fetch a single match for the given scope. Always returns a payload
   * suitable for the widget render path (mock fallback for "yesterday",
   * structured empty/error sentinels for other scopes).
   *
   * @param {{scope: "live"|"yesterday"|"next", team?: string}} request
   * @returns {Promise<object>} match-or-sentinel
   */
  async fetchMatch({ scope, team }) {
    dbg("fetchMatch", scope, team);

    if (scope === "yesterday" && forceMockEnabled()) {
      dbg("forceMock active; returning mock yesterday");
      return { ...MOCK_YESTERDAY };
    }

    let url;
    if (scope === "live") {
      url = `${MERINO_BASE}/live`;
    } else if (scope === "yesterday") {
      url = `${MERINO_BASE}/matches?day=yesterday`;
    } else if (scope === "next") {
      const t = team ? encodeURIComponent(team) : "";
      url = `${MERINO_BASE}/matches?team=${t}&status=upcoming`;
    } else {
      return { status: "error", scope };
    }

    try {
      const json = await fetchJson(url);
      const raw = pickFirst(json);
      const match = raw ? normalizeMatch(raw) : null;
      if (match) {
        if (!match.status) {
          match.status =
            scope === "live"
              ? "live"
              : scope === "next"
                ? "upcoming"
                : "final";
        }
        return match;
      }
      if (scope === "yesterday") {
        return { ...MOCK_YESTERDAY };
      }
      return { status: "empty", scope };
    } catch (e) {
      dbg("fetch failed", e?.message || e);
      if (scope === "yesterday") {
        return { ...MOCK_YESTERDAY };
      }
      return { status: "error", scope };
    }
  },

  errorPayload(scope) {
    if (scope === "yesterday") {
      return { ...MOCK_YESTERDAY };
    }
    return { status: "error", scope };
  },

  /**
   * Detect a World Cup query intent in user text. Returns null when
   * out of scope.
   *
   * @param {string} text
   * @returns {{scope: string, team: string|null}|null}
   */
  detect(text) {
    if (!text || typeof text !== "string") {
      return null;
    }
    const lower = text.toLowerCase();

    const team = WorldCup.extractTeam(text);

    if (
      /\byesterday\b/.test(lower) &&
      /(won|win|wins|score|result|results|game|match|play(ed)?)/.test(lower)
    ) {
      return { scope: "yesterday", team };
    }

    if (
      /(\blive\b|\bright now\b|\bcurrent(ly)?\b|\bin progress\b|\bhappening\b)/.test(
        lower
      ) &&
      /(match|game|score)/.test(lower)
    ) {
      return { scope: "live", team };
    }

    if (
      (/\bnext\b/.test(lower) ||
        /\bwhen does\b.*\bplay\b/.test(lower) ||
        /\bupcoming\b/.test(lower) ||
        /\btomorrow\b/.test(lower)) &&
      team
    ) {
      return { scope: "next", team };
    }

    return null;
  },

  /**
   * Best-effort team-name extraction against a small demo set.
   *
   * @param {string} text
   * @returns {string|null}
   */
  extractTeam(text) {
    if (!text) {
      return null;
    }
    const TEAMS = [
      "Brazil",
      "Colombia",
      "Argentina",
      "France",
      "Germany",
      "England",
      "Spain",
      "Portugal",
      "Italy",
      "Netherlands",
      "Croatia",
      "Belgium",
      "Mexico",
      "USA",
      "United States",
      "Canada",
      "Japan",
      "Korea",
      "South Korea",
      "Australia",
      "Morocco",
      "Senegal",
      "Uruguay",
      "Switzerland",
      "Denmark",
      "Poland",
      "Ecuador",
      "Saudi Arabia",
      "Iran",
      "Tunisia",
      "Cameroon",
      "Ghana",
    ];
    const lower = text.toLowerCase();
    for (const t of TEAMS) {
      if (lower.includes(t.toLowerCase())) {
        return t;
      }
    }
    return null;
  },

  /**
   * Build the LLM context string injected into userContext.widgetContext.worldCup.
   *
   * @param {{scope: string, match: object}} payload
   * @returns {string|null}
   */
  buildLlmContext({ scope, match }) {
    if (!match) {
      return null;
    }
    const { homeTeam, awayTeam, status, minute, kickoff, isMock } = match;
    if (status === "empty") {
      return [
        `World Cup widget: no ${scope} match available.`,
        "Tell the user there's no live match right now in one short sentence.",
      ].join("\n");
    }
    if (status === "error") {
      return [
        "World Cup widget: data unavailable.",
        "Apologise briefly that you can't fetch the match data right now. One sentence.",
      ].join("\n");
    }

    const home = homeTeam?.name || homeTeam?.code || "Home";
    const away = awayTeam?.name || awayTeam?.code || "Away";
    const homeScore = homeTeam?.score;
    const awayScore = awayTeam?.score;

    const lines = [
      "World Cup widget data follows. Use it verbatim — do not invent scores or teams. Do not perform a web search.",
      "Respond in one short, casual sentence. No bullet points, no bold text, no preamble.",
      "",
      JSON.stringify(
        {
          scope,
          status,
          minute,
          kickoff,
          home: { team: home, score: homeScore },
          away: { team: away, score: awayScore },
          isMock: !!isMock,
        },
        null,
        2
      ),
    ];

    if (status === "final") {
      lines.push(
        "",
        `Phrase the answer like: "${home} beat ${away} ${homeScore}-${awayScore} yesterday." (or "${away} beat ${home}…" if the away team won, or "drew" if scores are equal).`
      );
    } else if (status === "live") {
      lines.push(
        "",
        `Phrase like: "${home} ${homeScore}, ${away} ${awayScore} at the ${minute || 0}th minute."`
      );
    } else if (status === "upcoming") {
      lines.push(
        "",
        `Phrase like: "${home} plays ${away} at {kickoff local time}."`
      );
    }

    return lines.join("\n");
  },
};
