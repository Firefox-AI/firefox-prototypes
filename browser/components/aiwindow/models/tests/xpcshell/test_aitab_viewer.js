/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AITab } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/aitab/AITab.sys.mjs"
);
const { buildViewerURL, getViewerBaseURL } = AITab;

const VIEWER_PREF = "browser.smartwindow.aitab.viewerURL";

registerCleanupFunction(() => Services.prefs.clearUserPref(VIEWER_PREF));

add_task(function test_buildViewerURL_puts_config_in_hash() {
  const page = { header: { type: "header", title: "Hi <b>x</b>" }, blocks: [] };
  const url = buildViewerURL("https://viewer.example/app", page);
  const parsed = new URL(url);

  Assert.equal(parsed.origin, "https://viewer.example", "host is unchanged");
  Assert.equal(parsed.pathname, "/app", "path is unchanged");
  Assert.equal(parsed.search, "", "config is NOT in the query string");
  Assert.deepEqual(
    JSON.parse(decodeURIComponent(parsed.hash.slice(1))),
    page,
    "the page config round-trips through the URL hash fragment"
  );
});

add_task(function test_buildViewerURL_strips_existing_hash() {
  const url = buildViewerURL("https://viewer.example/app#stale", {
    blocks: [],
  });
  Assert.ok(!url.includes("#stale"), "an existing hash on the base is dropped");
});

add_task(function test_buildViewerURL_about_smartwindowtasks() {
  const page = { header: { type: "header", title: "Niijima" }, blocks: [] };
  const url = buildViewerURL("about:smartwindowtasks", page);
  Assert.ok(
    url.startsWith("about:smartwindowtasks#"),
    "the in-tree viewer keeps its about: address"
  );
  Assert.deepEqual(
    JSON.parse(decodeURIComponent(url.slice(url.indexOf("#") + 1))),
    page,
    "the page config still lives in the hash"
  );
});

add_task(function test_getViewerBaseURL_accepts_https_and_about_viewer() {
  const { parseViewerBaseURL } = AITab;

  Assert.equal(parseViewerBaseURL(""), null, "empty pref yields null");
  Assert.equal(
    parseViewerBaseURL("http://insecure.example/app"),
    null,
    "non-https http pref yields null"
  );
  Assert.equal(
    parseViewerBaseURL("not a url"),
    null,
    "unparseable pref yields null"
  );
  Assert.equal(
    parseViewerBaseURL("about:preferences"),
    null,
    "other about: pages are not viewers"
  );
  Assert.equal(
    parseViewerBaseURL("https://viewer.example/app#x"),
    "https://viewer.example/app",
    "an https pref is returned with any hash stripped"
  );
  Assert.equal(
    parseViewerBaseURL("about:smartwindowtasks#stale"),
    "about:smartwindowtasks",
    "the in-tree viewer is accepted with its hash stripped"
  );
});

add_task(function test_getViewerBaseURL_reads_about_viewer_pref() {
  Services.prefs.setStringPref(VIEWER_PREF, "about:smartwindowtasks");
  Assert.equal(
    getViewerBaseURL(),
    "about:smartwindowtasks",
    "the live pref is accepted as the in-tree Lit viewer"
  );
});
