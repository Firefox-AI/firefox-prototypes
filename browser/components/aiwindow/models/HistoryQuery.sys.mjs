/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { sanitizeUntrustedContent } from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const LODGING_ALLOWLIST = [
  "airbnb.com",
  "vrbo.com",
  "booking.com",
  "hotels.com",
  "expedia.com",
  "marriott.com",
  "hilton.com",
  "hyatt.com",
  "ihg.com",
  "kayak.com",
];

const BRAND_KEYWORDS = {
  airbnb: ["airbnb.com"],
  vrbo: ["vrbo.com"],
  booking: ["booking.com"],
  hotels: ["hotels.com"],
  expedia: ["expedia.com"],
  marriott: ["marriott.com"],
  hilton: ["hilton.com"],
  hyatt: ["hyatt.com"],
  ihg: ["ihg.com"],
  kayak: ["kayak.com"],
};

/**
 * Resolve the user's keyword to a list of host suffixes to filter by.
 * Generic words ("hotel", "lodging", "stay") fall through to the full allowlist.
 *
 * @param {string|undefined} keyword
 * @returns {string[]}
 */
function deriveDomainFilter(keyword) {
  if (!keyword || typeof keyword !== "string") {
    return LODGING_ALLOWLIST.slice();
  }
  const k = keyword.toLowerCase();
  for (const [token, domains] of Object.entries(BRAND_KEYWORDS)) {
    if (k.includes(token)) {
      return domains;
    }
  }
  return LODGING_ALLOWLIST.slice();
}

function destinationTokens(destination) {
  if (!destination || typeof destination !== "string") {
    return [];
  }
  return destination
    .toLowerCase()
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3);
}

/**
 * Look up lodging-domain pages from the user's recent browsing history.
 * Local-only: queries the Places DB. Never hits the network.
 *
 * @param {object} params
 * @param {string} [params.keyword]      - "airbnb" / "marriott" / "hotel" / etc.
 * @param {string} [params.destination]  - trip destination, used for ranking boost.
 * @param {number} [params.days=30]      - lookback window.
 * @param {number} [params.limit=5]      - max matches to return.
 * @returns {Promise<{matches: Array, domain_filter: string[], message: string}>}
 */
export async function lookupLodging({
  keyword,
  destination,
  days = 30,
  limit = 5,
} = {}) {
  const domains = deriveDomainFilter(keyword);
  const tokens = destinationTokens(destination);
  const cutoffMicros =
    (Date.now() - Math.max(1, Number(days) || 30) * 86400 * 1000) * 1000;

  const placeholders = domains.map(() => "?").join(",");
  const sql = `
    SELECT p.url AS url,
           p.title AS title,
           p.rev_host AS rev_host,
           p.visit_count AS visit_count,
           p.last_visit_date AS last_visit_date
    FROM moz_places p
    WHERE p.last_visit_date >= ?
      AND p.hidden = 0
      AND p.rev_host IN (${placeholders})
    ORDER BY p.last_visit_date DESC
    LIMIT 200
  `;

  const revHosts = domains.map(d =>
    d.split("").reverse().join("") + "."
  );

  const rows = [];
  await lazy.PlacesUtils.withConnectionWrapper(
    "HistoryQuery:lookupLodging",
    async db => {
      const stmt = await db.executeCached(sql, [cutoffMicros, ...revHosts]);
      for (const row of stmt) {
        const url = row.getResultByName("url");
        const title = row.getResultByName("title") || "";
        const visitCount = row.getResultByName("visit_count") || 0;
        const lastMicros = row.getResultByName("last_visit_date");
        const hostnameMatch = url.match(/^https?:\/\/([^/]+)/i);
        const hostname = hostnameMatch ? hostnameMatch[1].replace(/^www\./, "") : "";
        rows.push({
          url,
          title: sanitizeUntrustedContent(title || url),
          hostname,
          visit_count: visitCount,
          last_visit_iso:
            typeof lastMicros === "number"
              ? new Date(Math.round(lastMicros / 1000)).toISOString()
              : null,
        });
      }
    }
  );

  // Rank: recency * log(visit_count + 1), with a destination-token boost when applicable.
  const now = Date.now();
  const scored = rows.map(r => {
    const ts = r.last_visit_iso ? new Date(r.last_visit_iso).getTime() : 0;
    const ageDays = Math.max(1, (now - ts) / 86400000);
    let score = (1 / ageDays) * Math.log(r.visit_count + 1.5);
    if (tokens.length) {
      const hay = (r.title + " " + r.url).toLowerCase();
      if (tokens.some(t => hay.includes(t))) {
        score *= 2.0;
      }
    }
    return { ...r, _score: score };
  });
  scored.sort((a, b) => b._score - a._score);

  const matches = scored.slice(0, Math.max(1, Number(limit) || 5)).map(r => {
    const { _score, ...rest } = r;
    return rest;
  });

  let message;
  if (matches.length === 0) {
    message = `No ${keyword || "lodging"} pages in the last ${days} days. Share the booking URL?`;
  } else {
    message = `${matches.length} match${matches.length === 1 ? "" : "es"} from your recent browsing.`;
  }

  return {
    matches,
    domain_filter: domains,
    message,
  };
}

export const HistoryQuery = {
  lookupLodging,
};
