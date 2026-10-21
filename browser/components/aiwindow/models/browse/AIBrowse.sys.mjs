/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Browsing sessions driven by Smart Window. Each conversation browses in its
 * own tab, which is hidden unless the user asks to see it, and in its own
 * private container, so it shares no cookies or storage with the user or with
 * other conversations.
 *
 * Parent process only.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const CONTEXT_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const IDENTITY_PREFIX = "AI-Task ";
const IDENTITY_STYLE = { color: "purple", icon: "circle" };
const SETTLE_DELAY_MS = 250;
const LOAD_TIMEOUT_MS = 15000;
const MAX_TEXT_LENGTH = 20000;

/**
 * @typedef {object} Session
 * @property {MozTabbrowserTab} tab - The tab the session browses in.
 * @property {object} gBrowser - The tabbrowser of the tab.
 * @property {number} userContextId - The container of the session.
 * @property {?number} snapshotWindowId - The inner window the uids of the
 *   last snapshot belong to.
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

function validateContextId(contextId) {
  if (typeof contextId !== "string" || !CONTEXT_ID_REGEX.test(contextId)) {
    throw new Error(`Invalid AI context id: ${contextId}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => lazy.setTimeout(resolve, ms));
}

function isOpen(session) {
  return !!session?.tab.isConnected && !session.tab.closing;
}

/**
 * Waits until the browser stopped loading, so that actions and snapshots see
 * the page they caused.
 *
 * @param {MozBrowser} browser
 */
async function waitForSettled(browser) {
  await sleep(SETTLE_DELAY_MS);
  const start = Date.now();
  while (
    browser.browsingContext?.webProgress?.isLoadingDocument &&
    Date.now() - start < LOAD_TIMEOUT_MS
  ) {
    await sleep(100);
  }
}

/**
 * @param {MozTabbrowserTab} tab
 * @returns {boolean} Whether the tab browses in the container of a
 *   conversation.
 */
function isAITaskTab(tab) {
  return !!lazy.ContextualIdentityService.getDisplayedIdentityFromId(
    tab.userContextId
  )?.name?.startsWith(IDENTITY_PREFIX);
}

/**
 * Makes a tab the session of a conversation, taking it away from the
 * conversation that had it.
 *
 * @param {string} contextId
 * @param {MozTabbrowserTab} tab
 * @param {object} gBrowser
 * @returns {Session}
 */
function attachTab(contextId, tab, gBrowser) {
  for (const [id, other] of sessions) {
    if (other.tab === tab) {
      sessions.delete(id);
    }
  }
  tab.addEventListener(
    "TabClose",
    () => {
      if (sessions.get(contextId)?.tab === tab) {
        sessions.delete(contextId);
      }
    },
    { once: true }
  );
  const session = {
    tab,
    gBrowser,
    userContextId: tab.userContextId,
    snapshotWindowId: null,
  };
  sessions.set(contextId, session);
  return session;
}

/**
 * The session a conversation acts on: the tab the user is looking at when it
 * is the tab of a conversation, so that the user can point the model at it,
 * or else the conversation's own tab.
 *
 * @param {string} contextId
 * @returns {?Session}
 */
function findSession(contextId) {
  validateContextId(contextId);
  const gBrowser = lazy.BrowserWindowTracker.getTopWindow()?.gBrowser;
  const selectedTab = gBrowser?.selectedTab;
  let session = sessions.get(contextId);

  if (selectedTab && isAITaskTab(selectedTab)) {
    return session?.tab === selectedTab
      ? session
      : attachTab(contextId, selectedTab, gBrowser);
  }

  if (!isOpen(session)) {
    sessions.delete(contextId);
    return null;
  }
  return session;
}

function getSession(contextId) {
  const session = findSession(contextId);
  if (!session) {
    throw new Error("There is no open page, open one with browse_open first.");
  }
  return session;
}

function getActor(session) {
  const windowGlobal =
    session.tab.linkedBrowser.browsingContext?.currentWindowGlobal;
  if (!windowGlobal) {
    throw new Error("The page is not loaded.");
  }
  return windowGlobal.getActor("AIBrowse");
}

/**
 * Makes sure an action targets the page its uids come from.
 *
 * @param {Session} session
 */
function checkSnapshotPage(session) {
  const windowId =
    session.tab.linkedBrowser.browsingContext?.currentWindowGlobal
      ?.innerWindowId;
  if (!session.snapshotWindowId || windowId !== session.snapshotWindowId) {
    throw new Error(
      "The page changed since the last snapshot, take a new one."
    );
  }
}

export const AIBrowse = {
  /**
   * The container a conversation browses in, created on first use.
   *
   * @param {string} contextId
   * @returns {number}
   */
  userContextIdFor(contextId) {
    validateContextId(contextId);
    return lazy.ContextualIdentityService.getOrCreatePrivateIdentity(
      IDENTITY_PREFIX + contextId,
      IDENTITY_STYLE
    ).userContextId;
  },

  /**
   * @param {string} contextId
   * @returns {?MozTabbrowserTab} The tab of the session of a conversation.
   */
  getTab(contextId) {
    const session = sessions.get(contextId);
    return isOpen(session) ? session.tab : null;
  },

  /**
   * Loads a URL in the session of a conversation, opening a hidden tab for it
   * in the given window when there is none.
   *
   * @param {string} contextId
   * @param {string} url - An http or https URL.
   * @param {object} [options]
   * @param {Window} [options.window] - Defaults to the most recent window.
   */
  async open(contextId, url, { window } = {}) {
    validateContextId(contextId);
    let parsed = URL.parse(url);
    if (!parsed && !/^[a-z][a-z\d+.-]*:/i.test(url)) {
      parsed = URL.parse(`https://${url}`);
    }
    if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") {
      throw new Error(`Only http and https URLs can be opened: ${url}`);
    }

    let session = findSession(contextId);
    if (session) {
      session.tab.linkedBrowser.loadURI(Services.io.newURI(parsed.href), {
        triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal(
          { userContextId: session.userContextId }
        ),
      });
    } else {
      const userContextId = this.userContextIdFor(contextId);
      const triggeringPrincipal =
        Services.scriptSecurityManager.createNullPrincipal({ userContextId });
      const win = window ?? lazy.BrowserWindowTracker.getTopWindow();
      if (!win) {
        throw new Error("There is no browser window to browse in.");
      }
      const { gBrowser } = win;
      const tab = gBrowser.addTab(parsed.href, {
        userContextId,
        triggeringPrincipal,
        skipAnimation: true,
      });
      gBrowser.hideTab(tab);
      session = attachTab(contextId, tab, gBrowser);
    }

    session.snapshotWindowId = null;
    await waitForSettled(session.tab.linkedBrowser);
    return this.snapshot(contextId);
  },

  /**
   * @param {string} contextId
   * @returns {Promise<object>} The URL, title, scroll position and interactive
   *   elements of the page.
   */
  async snapshot(contextId) {
    const session = getSession(contextId);
    const browser = session.tab.linkedBrowser;
    const uri = browser.browsingContext?.currentWindowGlobal?.documentURI;
    if (!uri?.schemeIs("http") && !uri?.schemeIs("https")) {
      // Error pages and other internal pages cannot be acted on.
      session.snapshotWindowId = null;
      return {
        url: uri?.spec ?? "about:blank",
        title: browser.contentTitle,
        errorPage: !!uri?.schemeIs("about"),
        scrollY: 0,
        scrollHeight: 0,
        viewportHeight: 0,
        elements: [],
        visible: this.isVisible(contextId),
      };
    }

    const actor = getActor(session);
    const snapshot = await actor.sendQuery("AIBrowse:Snapshot");
    session.snapshotWindowId = actor.manager.innerWindowId;
    return { ...snapshot, visible: this.isVisible(contextId) };
  },

  async click(contextId, uid) {
    const session = getSession(contextId);
    checkSnapshotPage(session);
    await getActor(session).sendQuery("AIBrowse:Click", { uid });
    await waitForSettled(session.tab.linkedBrowser);
    return this.snapshot(contextId);
  },

  async type(contextId, uid, text, submit = false) {
    const session = getSession(contextId);
    checkSnapshotPage(session);
    await getActor(session).sendQuery("AIBrowse:Type", {
      uid,
      text: String(text),
      submit: !!submit,
    });
    await waitForSettled(session.tab.linkedBrowser);
    return this.snapshot(contextId);
  },

  async scroll(contextId, direction) {
    const session = getSession(contextId);
    await getActor(session).sendQuery("AIBrowse:Scroll", { direction });
    await sleep(SETTLE_DELAY_MS);
    return this.snapshot(contextId);
  },

  async back(contextId) {
    const session = getSession(contextId);
    const browser = session.tab.linkedBrowser;
    if (!browser.canGoBack) {
      throw new Error("There is no previous page.");
    }
    browser.goBack();
    await waitForSettled(browser);
    return this.snapshot(contextId);
  },

  /**
   * @param {string} contextId
   * @returns {Promise<string>} The text of the page.
   */
  async read(contextId) {
    const session = getSession(contextId);
    const windowGlobal =
      session.tab.linkedBrowser.browsingContext?.currentWindowGlobal;
    const result = await windowGlobal?.getActor("PageExtractor").getText();
    return (result?.text ?? "").slice(0, MAX_TEXT_LENGTH);
  },

  isVisible(contextId) {
    const tab = this.getTab(contextId);
    return !!tab && !tab.hidden;
  },

  /**
   * Shows the tab of a session and selects it, so the user can follow and
   * take over the browsing.
   *
   * @param {string} contextId
   */
  show(contextId) {
    const { tab, gBrowser } = getSession(contextId);
    gBrowser.showTab(tab);
    gBrowser.selectedTab = tab;
  },

  /**
   * Hides the tab of a session, selecting another tab first if needed.
   *
   * @param {string} contextId
   */
  hide(contextId) {
    const { tab, gBrowser } = getSession(contextId);
    if (tab.selected) {
      const other = gBrowser.visibleTabs.find(t => t !== tab);
      if (other) {
        gBrowser.selectedTab = other;
      } else {
        gBrowser.selectedTab = gBrowser.addTrustedTab("about:newtab");
      }
    }
    gBrowser.hideTab(tab);
  },

  /**
   * @param {string} contextId
   * @returns {boolean} Whether the tab is visible afterwards.
   */
  toggle(contextId) {
    if (this.isVisible(contextId)) {
      this.hide(contextId);
      return false;
    }
    this.show(contextId);
    return true;
  },

  /**
   * Closes the tab of a session. The container and its data stay, so that a
   * later session of the conversation is still logged in.
   *
   * @param {string} contextId
   */
  close(contextId) {
    validateContextId(contextId);
    const session = sessions.get(contextId);
    sessions.delete(contextId);
    if (isOpen(session)) {
      session.gBrowser.removeTab(session.tab, { skipPermitUnload: true });
    }
  },

  /**
   * Closes the session of a conversation and deletes its container with all
   * its data.
   *
   * @param {string} contextId
   */
  forget(contextId) {
    this.close(contextId);
    const identity = lazy.ContextualIdentityService.getPrivateIdentity(
      IDENTITY_PREFIX + contextId
    );
    if (identity) {
      lazy.ContextualIdentityService.removePrivateIdentity(
        identity.userContextId
      );
    }
  },
};
