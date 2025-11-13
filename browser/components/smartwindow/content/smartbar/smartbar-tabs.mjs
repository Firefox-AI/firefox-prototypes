/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Finds an existing browser tab whose title or URL matches the provided query and focuses it.
 *
 * @param {{url?:string,title?:string,query?:string}} params
 * @param {Window} [win] - Optional browser window; falls back to the most recent one.
 */
function switchToMatchingTab({ url, title, query } = {}, win = window) {
  const searchTerm = (url || title || query || "").toLowerCase();
  if (!searchTerm) {
    return;
  }

  let browserWindow =
    win && win.gBrowser
      ? win
      : Services.wm.getMostRecentWindow("navigator:browser");
  if (!browserWindow || !browserWindow.gBrowser) {
    return;
  }

  const { gBrowser } = browserWindow;
  const tabs = Array.from(gBrowser.tabs);

  const match = tabs.find(tab => {
    const linkedBrowser = tab.linkedBrowser;
    const titleText = (
      linkedBrowser?.contentTitle ||
      tab.label ||
      ""
    ).toLowerCase();
    const urlText = (linkedBrowser?.currentURI?.spec || "").toLowerCase();

    if (url) {
      return urlText.includes(searchTerm);
    }
    if (title) {
      return titleText.includes(searchTerm);
    }
    return titleText.includes(searchTerm) || urlText.includes(searchTerm);
  });

  if (!match) {
    return;
  }

  browserWindow.focus();
  gBrowser.selectedTab = match;
}

export { switchToMatchingTab };
