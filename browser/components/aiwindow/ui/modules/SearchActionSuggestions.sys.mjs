/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Loads a toolbar search in a new tab. The current page stays put, and no
 * conversation opens.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchUIUtils: "moz-src:///browser/components/search/SearchUIUtils.sys.mjs",
});

const MAX_QUERY = 64;

/**
 * Loads the query in the default search engine in a new tab. The current
 * page stays put, and no conversation opens.
 *
 * @param {ChromeWindow} win
 * @param {string} query
 * @returns {Promise<void>}
 */
export async function openSearchQuery(win, query) {
  const searchText = clip(query);
  if (!searchText || win.closed) {
    return;
  }
  await lazy.SearchUIUtils.loadSearch({
    window: win,
    searchText,
    where: "tab",
    usePrivateWindow: lazy.PrivateBrowsingUtils.isWindowPrivate(win),
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    sapSource: "smartwindow_assistant",
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function clip(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY);
}
