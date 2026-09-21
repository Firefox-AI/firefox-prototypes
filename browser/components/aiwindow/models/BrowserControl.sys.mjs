/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sanitizeUntrustedContent } from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const NAVIGATION_TIMEOUT_MS = 15000;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

function errorResult(code, message) {
  return { status: "error", code, message };
}

function parseWebURL(value) {
  try {
    const url = new URL(value);
    return ALLOWED_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Firefox-native browser control for Smart Window model tools.
 *
 * Tab IDs are scoped to a conversation and DOM element references are scoped
 * to the latest actor snapshot. This gives the model enough capability to
 * navigate and interact without accepting arbitrary DOM selectors or script.
 */
export class BrowserControl {
  static #sessions = new WeakMap();

  static #getSession(conversation) {
    let session = this.#sessions.get(conversation);
    if (!session) {
      session = {
        browsers: new Map(),
        ids: new WeakMap(),
        nextTabId: 1,
      };
      this.#sessions.set(conversation, session);
    }
    return session;
  }

  static #getWindow(browsingContext) {
    const win =
      browsingContext?.topChromeWindow ||
      browsingContext?.embedderElement?.ownerGlobal ||
      null;
    if (!win || win.closed || !win.gBrowser) {
      return null;
    }
    return win;
  }

  static #requireSmartWindow(browsingContext) {
    if (
      !Services.prefs.getBoolPref("browser.smartwindow.enabled", false) ||
      !Services.prefs.getBoolPref(
        "browser.smartwindow.browserControl.enabled",
        false
      )
    ) {
      return errorResult(
        "feature_disabled",
        "Smart Window browser control is not enabled."
      );
    }
    const win = this.#getWindow(browsingContext);
    if (!win) {
      return errorResult(
        "window_unavailable",
        "The Smart Window browser window is unavailable."
      );
    }
    if (!lazy.AIWindow.isAIWindowActive(win)) {
      return errorResult(
        "not_smart_window",
        "Browser control is limited to an active Smart Window."
      );
    }
    return win;
  }

  static #registerBrowser(conversation, browser) {
    const session = this.#getSession(conversation);
    let tabId = session.ids.get(browser);
    if (!tabId) {
      tabId = `tab-${session.nextTabId++}`;
      session.ids.set(browser, tabId);
      session.browsers.set(tabId, browser);
    }
    return tabId;
  }

  static #resolveBrowser({ tabId, conversation, browsingContext }) {
    const win = this.#requireSmartWindow(browsingContext);
    if (win?.status === "error") {
      return win;
    }

    let browser;
    if (tabId) {
      browser = this.#getSession(conversation).browsers.get(tabId);
      if (!browser) {
        return errorResult(
          "unknown_tab",
          "The tab reference is unknown to this conversation. Read browser_state without a tab_id or open a new tab."
        );
      }
    } else {
      browser = win.gBrowser.selectedBrowser;
    }

    const tab = browser && win.gBrowser.getTabForBrowser(browser);
    if (!tab || tab.closing) {
      return errorResult(
        "tab_unavailable",
        "The target tab is no longer available."
      );
    }
    if (!parseWebURL(browser.currentURI?.spec)) {
      return errorResult(
        "unsupported_page",
        "Only loaded HTTP and HTTPS pages can be controlled. Open or navigate a web tab first."
      );
    }

    return { win, tab, browser };
  }

  static #getActor(browser) {
    const windowGlobal = browser.browsingContext?.currentWindowGlobal;
    if (!windowGlobal) {
      return null;
    }
    try {
      return windowGlobal.getActor("SmartWindowBrowser");
    } catch {
      return null;
    }
  }

  static async #moveConversationToSidebarIfNeeded(win, browsingContext) {
    const originalBrowser = browsingContext?.embedderElement;
    const originalTab =
      originalBrowser && win.gBrowser.getTabForBrowser(originalBrowser);
    if (
      originalTab &&
      lazy.AIWindow.isAIWindowContentPage(originalBrowser.currentURI)
    ) {
      await lazy.AIWindow.moveConversationToSidebar(win, originalTab);
    }
  }

  static async #loadURI(browser, url) {
    let cleanup = () => {};
    const navigation = new Promise((resolve, reject) => {
      let navigationStarted = false;
      const listener = {
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
        onStateChange(webProgress, request, stateFlags) {
          if (
            !webProgress.isTopLevel ||
            !(stateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)
          ) {
            return;
          }
          if (
            stateFlags & Ci.nsIWebProgressListener.STATE_START &&
            request instanceof Ci.nsIChannel &&
            request.URI.spec !== "about:blank"
          ) {
            navigationStarted = true;
          }
          if (
            navigationStarted &&
            stateFlags & Ci.nsIWebProgressListener.STATE_STOP
          ) {
            cleanup();
            resolve();
          }
        },
      };
      const timeout = lazy.setTimeout(() => {
        cleanup();
        reject(new Error("Navigation timed out"));
      }, NAVIGATION_TIMEOUT_MS);
      cleanup = () => {
        lazy.clearTimeout(timeout);
        try {
          browser.removeProgressListener(listener);
        } catch {}
      };
      browser.addProgressListener(
        listener,
        Ci.nsIWebProgress.NOTIFY_STATE_NETWORK
      );
    });

    const triggeringPrincipal =
      Services.scriptSecurityManager.createNullPrincipal({});
    try {
      browser.loadURI(Services.io.newURI(url), { triggeringPrincipal });
      await navigation;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  static #markPageDataUntrusted(conversation) {
    conversation.securityProperties.setPrivateData();
    conversation.securityProperties.setUntrustedInput();
  }

  static async getState(toolParams, conversation, browsingContext) {
    const target = this.#resolveBrowser({
      tabId: toolParams?.tab_id,
      conversation,
      browsingContext,
    });
    if (!target.browser) {
      return target;
    }

    const actor = this.#getActor(target.browser);
    if (!actor) {
      return errorResult(
        "actor_unavailable",
        "Browser control is unavailable for this page. Check that the browser-control preference is enabled."
      );
    }

    const state = await actor.sendQuery("SmartWindowBrowser:GetState", {});
    if (state.status !== "ok") {
      return state;
    }

    const tabId = this.#registerBrowser(conversation, target.browser);
    const links = state.elements.map(element => element.href).filter(Boolean);
    conversation.addSeenUrls([state.url, ...links]);
    this.#markPageDataUntrusted(conversation);

    return {
      ...state,
      tab_id: tabId,
      title: sanitizeUntrustedContent(state.title),
      text: sanitizeUntrustedContent(state.text),
      elements: state.elements.map(element => ({
        ...element,
        name: sanitizeUntrustedContent(element.name),
        ...(element.value === undefined
          ? {}
          : { value: sanitizeUntrustedContent(element.value) }),
      })),
    };
  }

  static async findText(
    {
      tab_id: tabId,
      text,
      case_sensitive: caseSensitive = false,
      whole_word: wholeWord = false,
    },
    conversation,
    browsingContext
  ) {
    const target = this.#resolveBrowser({
      tabId,
      conversation,
      browsingContext,
    });
    if (!target.browser) {
      return target;
    }
    const actor = this.#getActor(target.browser);
    if (!actor) {
      return errorResult(
        "actor_unavailable",
        "Browser control is unavailable."
      );
    }

    target.win.gBrowser.selectedTab = target.tab;
    const result = await actor.sendQuery("SmartWindowBrowser:FindText", {
      text,
      case_sensitive: caseSensitive,
      whole_word: wholeWord,
    });
    if (result.status !== "ok") {
      return result;
    }
    conversation.securityProperties.setPrivateData();
    return {
      ...result,
      tab_id: this.#registerBrowser(conversation, target.browser),
    };
  }

  static async openTab({ url }, conversation, browsingContext) {
    const webURL = parseWebURL(url);
    if (!webURL) {
      return errorResult(
        "invalid_url",
        "Only absolute HTTP and HTTPS URLs can be opened."
      );
    }

    const win = this.#requireSmartWindow(browsingContext);
    if (win?.status === "error") {
      return win;
    }

    await this.#moveConversationToSidebarIfNeeded(win, browsingContext);
    const triggeringPrincipal =
      Services.scriptSecurityManager.createNullPrincipal({});
    const tab = win.gBrowser.addTab("about:blank", { triggeringPrincipal });
    win.gBrowser.selectedTab = tab;
    const tabId = this.#registerBrowser(conversation, tab.linkedBrowser);

    try {
      await this.#loadURI(tab.linkedBrowser, webURL);
    } catch (error) {
      return errorResult("navigation_failed", error.message);
    }

    conversation.addSeenUrls([tab.linkedBrowser.currentURI.spec]);
    return {
      status: "ok",
      tab_id: tabId,
      url: tab.linkedBrowser.currentURI.spec,
      message:
        "Tab opened and selected. Read browser_state before interacting.",
    };
  }

  static async navigate({ tab_id: tabId, url }, conversation, browsingContext) {
    const webURL = parseWebURL(url);
    if (!webURL) {
      return errorResult(
        "invalid_url",
        "Only absolute HTTP and HTTPS URLs can be opened."
      );
    }

    const target = this.#resolveBrowser({
      tabId,
      conversation,
      browsingContext,
    });
    if (!target.browser) {
      return target;
    }

    target.win.gBrowser.selectedTab = target.tab;
    try {
      await this.#loadURI(target.browser, webURL);
    } catch (error) {
      return errorResult("navigation_failed", error.message);
    }

    conversation.addSeenUrls([target.browser.currentURI.spec]);
    return {
      status: "ok",
      tab_id: this.#registerBrowser(conversation, target.browser),
      url: target.browser.currentURI.spec,
      message: "Navigation completed. Read browser_state before interacting.",
    };
  }

  static async scroll(
    { tab_id: tabId, direction, amount },
    conversation,
    browsingContext
  ) {
    const target = this.#resolveBrowser({
      tabId,
      conversation,
      browsingContext,
    });
    if (!target.browser) {
      return target;
    }
    const actor = this.#getActor(target.browser);
    if (!actor) {
      return errorResult(
        "actor_unavailable",
        "Browser control is unavailable."
      );
    }

    target.win.gBrowser.selectedTab = target.tab;
    const result = await actor.sendQuery("SmartWindowBrowser:Scroll", {
      direction,
      amount,
    });
    if (result.status !== "ok") {
      return result;
    }
    return {
      ...result,
      tab_id: this.#registerBrowser(conversation, target.browser),
    };
  }

  static async click(
    { tab_id: tabId, snapshot_id: snapshotId, ref },
    conversation,
    browsingContext
  ) {
    const target = this.#resolveBrowser({
      tabId,
      conversation,
      browsingContext,
    });
    if (!target.browser) {
      return target;
    }
    const actor = this.#getActor(target.browser);
    if (!actor) {
      return errorResult(
        "actor_unavailable",
        "Browser control is unavailable."
      );
    }
    return actor.sendQuery("SmartWindowBrowser:Click", {
      snapshot_id: snapshotId,
      ref,
    });
  }

  static async type(
    { tab_id: tabId, snapshot_id: snapshotId, ref, text, replace = true },
    conversation,
    browsingContext
  ) {
    const target = this.#resolveBrowser({
      tabId,
      conversation,
      browsingContext,
    });
    if (!target.browser) {
      return target;
    }
    const actor = this.#getActor(target.browser);
    if (!actor) {
      return errorResult(
        "actor_unavailable",
        "Browser control is unavailable."
      );
    }
    return actor.sendQuery("SmartWindowBrowser:Type", {
      snapshot_id: snapshotId,
      ref,
      text,
      replace,
    });
  }
}
