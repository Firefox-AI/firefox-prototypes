/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

export class SmartWindowParent extends JSWindowActorParent {
  receiveMessage(message) {
    switch (message.name) {
      case "SmartWindow:PageReady":
        this.onPageReady();
        break;

      case "SmartWindow:DoSearch":
        this.handleSearch(message.data.query);
        break;

      case "SmartWindow:DoNavigate":
        this.handleNavigate(message.data.query);
        break;

      case "SmartWindow:Navigate":
        this.handleSmartWindowNavigation(message.data.url);
        break;
    }
  }

  onPageReady() {
    console.log("Smart Window page ready");
  }

  async handleSearch(query) {
    if (!query) {
      this.sendAsyncMessage("SmartWindow:Clear");
      return;
    }

    try {
      const results = await this.getSearchResults(query);
      this.sendAsyncMessage("SmartWindow:UpdateResults", { results });
    } catch (error) {
      console.error("Smart Window search error:", error);
    }
  }

  async getSearchResults(query) {
    const results = [];

    try {
      const historyResults = await lazy.PlacesUtils.history.query({
        searchTerms: query,
        limit: 5,
      });

      for (const result of historyResults) {
        results.push({
          type: "history",
          title: result.title || result.url,
          url: result.url,
        });
      }
    } catch (e) {
      results.push({
        type: "search",
        title: `Search for "${query}"`,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      });
    }

    if (query.length) {
      results.push({
        type: "search",
        title: `Search for "${query}"`,
        url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      });
    }

    return results;
  }

  handleNavigate(query) {
    const browser = this.browsingContext.top.embedderElement;
    if (!browser) {
      return;
    }

    let url = query;

    if (!query.includes("://")) {
      if (query.includes(".") && !query.includes(" ")) {
        url = "https://" + query;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      }
    }

    browser.loadURI(Services.io.newURI(url), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }

  handleSmartWindowNavigation(url) {
    const browser = this.browsingContext.top.embedderElement;
    if (!browser) {
      return;
    }

    const win = browser.ownerGlobal;
    if (!win) {
      return;
    }

    // Load the new URL with REPLACE flag to replace the smart window in history
    browser.loadURI(Services.io.newURI(url), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
    });

    // Smart window is now a right sidebar, not part of the left sidebar system
    // Toggle the smart window right sidebar
    if (win.SmartWindow) {
      if (!win.SmartWindow._smartWindowActive) {
        win.SmartWindow.toggleSmartWindow();
      }
    }
  }
}
