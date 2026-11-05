/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Any shared setup for these tests lives here. */

/**
 * @returns {object} A minimal conversation for tool tests.
 */
function makeConversation() {
  const pendingBrowserActionTelemetry = new Map();
  return {
    stashPendingBrowserActionTelemetry(toolCallId, telemetryInfo) {
      pendingBrowserActionTelemetry.set(toolCallId, telemetryInfo);
    },
    takePendingBrowserActionTelemetry(toolCallId) {
      const info = pendingBrowserActionTelemetry.get(toolCallId);
      pendingBrowserActionTelemetry.delete(toolCallId);
      return info;
    },
    serpUrlsForAnonymousFetch: new Set(),
    addSeenUrls() {},
    async addHistoryResults() {},
    getAllMentionURLs() {
      return new Set();
    },
    addSerpUrlsForAnonymousFetch() {},
    getLatestUserMentionCount() {
      return 0;
    },
  };
}
const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

add_task(async function setup_profile() {
  do_get_profile(); // ensure a profile dir (needed by Places)
  // Start from a clean history DB
  await PlacesUtils.history.clear();
});

/**
 * Insert a row into moz_places_metadata for a URL that was already added via
 * PlacesUtils.history.insertMany. Required for tests that exercise getRecentHistory(),
 * which reads page visits from moz_places_metadata (not moz_historyvisits).
 * Search engine URLs are never recorded in moz_places_metadata by the browser,
 * so only call this for non-search pages.
 *
 * @param {string} url - Must already exist in moz_places.
 * @param {number} visitDateMs - Visit timestamp in milliseconds (matches the date
 *        passed to insertMany so cutoff filtering works correctly).
 * @param {number} [totalViewTimeMs=30_000] - Must exceed DEFAULT_PAGE_VIEWTIME (5000ms).
 */
async function insertPlacesMetadata(
  url,
  visitDateMs,
  totalViewTimeMs = 30_000
) {
  await PlacesUtils.withConnectionWrapper("test-insert-metadata", async db => {
    const rows = await db.execute(
      "SELECT id FROM moz_places WHERE url_hash = hash(:url) AND url = :url",
      { url }
    );
    const placeId = rows[0].getResultByName("id");
    await db.execute(
      `INSERT INTO moz_places_metadata
         (place_id, created_at, updated_at, total_view_time,
          typing_time, key_presses, scrolling_time, scrolling_distance, document_type)
       VALUES
         (:place_id, :created_at, :created_at, :total_view_time,
          0, 0, 0, 0, 0)`,
      {
        place_id: placeId,
        created_at: visitDateMs,
        total_view_time: totalViewTimeMs,
      }
    );
  });
}

function createFakeTab(url, title, lastAccessed) {
  return {
    linkedBrowser: {
      currentURI: {
        spec: url,
      },
    },
    label: title,
    lastAccessed,
  };
}

function createFakeWindow(tabs, closed = false, isAIWindow = true) {
  return {
    closed,
    gBrowser: {
      tabs,
    },
    document: {
      documentElement: {
        hasAttribute: attr => attr === "ai-window" && isAIWindow,
      },
    },
  };
}
