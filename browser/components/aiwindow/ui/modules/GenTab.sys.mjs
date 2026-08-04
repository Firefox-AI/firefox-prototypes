/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * GenTab menu entry — companion AITab from open tab(s) / tab group.
 *
 * Menus still call GenTab.createFromBrowser(s) / createFromTabGroup.
 * Generation uses the AITab page schema + remote viewer (hash JSON).
 * Opens the viewer immediately with status:"generating", then replaces
 * the hash when the real page config is ready.
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  URILoadingHelper: "resource:///modules/URILoadingHelper.sys.mjs",
  buildErrorPage:
    "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs",
  buildGeneratingPage:
    "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs",
  buildViewerURL:
    "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs",
  companionFocusForSources:
    "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs",
  generateAITabFromOpenTabs:
    "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs",
  getViewerBaseURL:
    "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs",
  loadAITabViewerURL:
    "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "gentabEnabled",
  "browser.smartwindow.gentab.enabled",
  false
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "aitabEnabled",
  "browser.smartwindow.aitab.enabled",
  false
);

const MAX_SOURCE_TABS = 8;

function getBrowserWindow(browser) {
  return (
    browser?.documentGlobal ||
    browser?.ownerGlobal ||
    browser?.browsingContext?.topChromeWindow ||
    null
  );
}

function getMostRecentBrowserWindow() {
  return Services.wm.getMostRecentWindow("navigator:browser");
}

/**
 * @param {string} query
 * @returns {string}
 */
export function googleSearchUrl(query) {
  const q = String(query || "")
    .trim()
    .slice(0, 200);
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

export const GenTab = {
  /**
   * Menu feature on, AITab enabled, and a https viewer URL configured.
   *
   * @returns {boolean}
   */
  isEnabled() {
    return lazy.gentabEnabled && lazy.aitabEnabled && !!lazy.getViewerBaseURL();
  },

  /**
   * Open a Google search for the given query in a new tab.
   *
   * @param {string} query
   * @param {Window} [chromeWindow]
   * @returns {boolean}
   */
  openWebSearch(query, chromeWindow) {
    const q = String(query || "")
      .trim()
      .slice(0, 200);
    if (!q) {
      return false;
    }
    const win = chromeWindow || getMostRecentBrowserWindow();
    if (!win) {
      console.error("GenTab: no browser window for web search");
      return false;
    }
    lazy.URILoadingHelper.openTrustedLinkIn(win, googleSearchUrl(q), "tab");
    return true;
  },

  googleSearchUrl,

  /**
   * @param {MozBrowser} browser
   * @returns {boolean}
   */
  canCreateFromBrowser(browser) {
    if (!this.isEnabled() || !browser?.currentURI) {
      return false;
    }
    const { scheme } = browser.currentURI;
    return scheme === "http" || scheme === "https";
  },

  /**
   * @param {MozBrowser[]} browsers
   * @returns {boolean}
   */
  canCreateFromBrowsers(browsers) {
    if (!this.isEnabled() || !Array.isArray(browsers) || !browsers.length) {
      return false;
    }
    return browsers.some(browser => this.canCreateFromBrowser(browser));
  },

  /**
   * @param {{ tabs?: Array<{ linkedBrowser?: MozBrowser }> }} group
   * @returns {boolean}
   */
  canCreateFromTabGroup(group) {
    const browsers = (group?.tabs || [])
      .map(tab => tab.linkedBrowser)
      .filter(Boolean);
    return this.canCreateFromBrowsers(browsers);
  },

  /**
   * @param {MozBrowser} browser
   * @returns {Promise<string | null>} viewer URL, or null on failure
   */
  async createFromBrowser(browser) {
    return this.createFromBrowsers([browser]);
  },

  /**
   * Open the viewer immediately with a generating hash, then replace the hash
   * when the real page config is ready.
   *
   * @param {MozBrowser[]} browsers
   * @param {{ groupLabel?: string }} [options]
   * @returns {Promise<string | null>} final viewer URL, or null on failure
   */
  async createFromBrowsers(browsers, options = {}) {
    const eligible = (browsers || [])
      .filter(browser => this.canCreateFromBrowser(browser))
      .slice(0, MAX_SOURCE_TABS);
    if (!eligible.length) {
      return null;
    }

    const win = getBrowserWindow(eligible[0]);
    if (!win) {
      console.error("GenTab: could not resolve chrome window for browser");
      return null;
    }

    const viewerBase = lazy.getViewerBaseURL();
    if (!viewerBase) {
      console.error("GenTab: AITab viewer URL is not configured");
      return null;
    }

    const url_list = eligible.map(browser => browser.currentURI.spec);
    const groupLabel =
      typeof options.groupLabel === "string" ? options.groupLabel.trim() : "";
    const focus = lazy.companionFocusForSources({
      groupLabel,
      sourceCount: url_list.length,
    });

    // 1) Open viewer right away with a special generating state in the hash.
    const pendingPage = lazy.buildGeneratingPage({
      sourceCount: url_list.length,
      groupLabel,
    });
    const pendingUrl = lazy.buildViewerURL(viewerBase, pendingPage);

    let targetBrowser;
    try {
      const tab = win.gBrowser.addTrustedTab(pendingUrl);
      win.gBrowser.selectedTab = tab;
      targetBrowser = tab.linkedBrowser;
    } catch (error) {
      console.error("GenTab: failed to open pending viewer tab", error);
      // Fallback: open without keeping a browser handle (cannot replace hash).
      lazy.URILoadingHelper.openTrustedLinkIn(win, pendingUrl, "tab");
      targetBrowser = null;
    }

    // 2) Generate in the background; replace the same tab's hash when done.
    let result;
    try {
      result = await lazy.generateAITabFromOpenTabs({
        url_list,
        focus,
        groupLabel,
      });
    } catch (error) {
      console.error("GenTab: AITab generation failed", error);
      if (targetBrowser) {
        const errUrl = lazy.buildViewerURL(
          viewerBase,
          lazy.buildErrorPage({
            message: error?.message || "Generation failed.",
          })
        );
        lazy.loadAITabViewerURL(targetBrowser, errUrl);
      }
      return null;
    }

    if (result.error || !result.url) {
      console.error("GenTab: AITab generation error:", result.error);
      if (targetBrowser) {
        const errUrl = lazy.buildViewerURL(
          viewerBase,
          lazy.buildErrorPage({
            message: result.error || "Generation failed.",
          })
        );
        lazy.loadAITabViewerURL(targetBrowser, errUrl);
      }
      return null;
    }

    if (targetBrowser) {
      lazy.loadAITabViewerURL(targetBrowser, result.url);
    } else {
      lazy.URILoadingHelper.openTrustedLinkIn(win, result.url, "tab");
    }
    return result.url;
  },

  /**
   * @param {{ tabs?: Array<{ linkedBrowser?: MozBrowser }>, label?: string }} group
   * @returns {Promise<string | null>}
   */
  async createFromTabGroup(group) {
    const browsers = (group?.tabs || [])
      .map(tab => tab.linkedBrowser)
      .filter(Boolean);
    return this.createFromBrowsers(browsers, {
      groupLabel: group?.label || undefined,
    });
  },
};
