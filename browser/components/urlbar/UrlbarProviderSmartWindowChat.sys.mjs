/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  UrlbarProvider,
  UrlbarUtils,
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  UrlbarResult: "moz-src:///browser/components/urlbar/UrlbarResult.sys.mjs",
  UrlbarView: "moz-src:///browser/components/urlbar/UrlbarView.sys.mjs",
});

const ENABLED_PREF = "smartWindowChat.enabled";
const SUGGESTED_INDEX_PREF = "smartWindowChat.suggestedIndex";
const SMART_WINDOW_PREF = "browser.smartwindow.enabled";

const DYNAMIC_RESULT_TYPE = "smartWindowChat";
const VIEW_TEMPLATE = {
  attributes: {
    selectable: true,
  },
  children: [
    {
      name: "content",
      tag: "span",
      classList: ["urlbarView-no-wrap"],
      children: [
        {
          name: "icon",
          tag: "img",
          classList: ["urlbarView-favicon"],
          attributes: {
            role: "presentation",
          },
        },
        {
          name: "query",
          tag: "strong",
          attributes: {
            dir: "auto",
          },
        },
        {
          name: "action",
          tag: "span",
        },
      ],
    },
  ],
};

/**
 *
 */
export class UrlbarProviderSmartWindowChat extends UrlbarProvider {
  constructor() {
    super();
    lazy.UrlbarResult.addDynamicResultType(DYNAMIC_RESULT_TYPE);
    lazy.UrlbarView.addDynamicViewTemplate(DYNAMIC_RESULT_TYPE, VIEW_TEMPLATE);
  }

  /**
   * @returns {Values<typeof UrlbarUtils.PROVIDER_TYPE>}
   */
  get type() {
    return UrlbarUtils.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext) {
    if (
      !lazy.UrlbarPrefs.get(ENABLED_PREF) ||
      !Services.prefs.getBoolPref(SMART_WINDOW_PREF, false)
    ) {
      return false;
    }

    if (
      queryContext.restrictSource ||
      queryContext.searchMode ||
      !queryContext.trimmedSearchString
    ) {
      return false;
    }

    return true;
  }

  getPriority() {
    return 0;
  }

  startQuery(queryContext, addCallback) {
    if (!queryContext.searchString) {
      return;
    }

    const result = new lazy.UrlbarResult({
      type: UrlbarUtils.RESULT_TYPE.DYNAMIC,
      source: UrlbarUtils.RESULT_SOURCE.OTHER_LOCAL,
      suggestedIndex: lazy.UrlbarPrefs.get(SUGGESTED_INDEX_PREF),
      payload: {
        dynamicType: DYNAMIC_RESULT_TYPE,
        query: queryContext.searchString,
      },
    });
    addCallback(this, result);
  }

  getViewUpdate(result) {
    return {
      icon: {
        attributes: {
          src: "chrome://browser/skin/smart-window.svg",
        },
      },
      query: {
        textContent: result.payload.query,
      },
      action: {
        l10n: { id: "urlbar-result-action-send-to-smart-window" },
      },
    };
  }

  onEngagement(queryContext, controller, details) {
    let promptText =
      details?.result?.payload?.query ?? queryContext.searchString ?? "";
    if (!promptText) {
      return;
    }

    const browserWindow = controller.browserWindow;
    const smartWindow = browserWindow?.SmartWindow;
    if (!smartWindow) {
      this.logger.warn("SmartWindow controller unavailable");
      return;
    }

    if (!smartWindow.isSmartWindowActive()) {
      smartWindow.toggleSmartWindow();
    }

    smartWindow.showSidebar();

    const smartWindowBrowser = browserWindow.document.getElementById(
      "smartwindow-browser"
    );
    const actor =
      smartWindowBrowser?.browsingContext?.currentWindowGlobal?.getActor(
        "SmartWindow"
      );
    if (!actor) {
      this.logger.warn("SmartWindow actor unavailable");
      return;
    }

    const gBrowser = browserWindow.gBrowser;
    const selectedTab = gBrowser?.selectedTab;
    const selectedBrowser =
      selectedTab?.linkedBrowser || gBrowser?.selectedBrowser;
    const tabContext = selectedTab
      ? [
          {
            title: selectedBrowser?.contentTitle || selectedTab.label || "",
            url: selectedBrowser?.currentURI?.spec || "",
            favicon: selectedTab.image || "",
            tabId: selectedTab.linkedPanel,
          },
        ]
      : [];

    try {
      actor.sendAsyncMessage("SmartWindow:SubmitPrompt", {
        promptText,
        tabContext,
        pageText: "",
      });
    } catch (error) {
      this.logger.error("Failed to send SmartWindow prompt", error);
    }
  }
}
