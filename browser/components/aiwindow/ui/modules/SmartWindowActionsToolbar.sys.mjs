/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Toolbar of things Smart Window can do with the current page.
 *
 * It is built for a Smart Window and also shows in a Classic window when the
 * spike pref is on. Chat actions start a conversation. Command actions run on
 * their own (the tasks panel, an AI Tab for this page) and do not open a chat.
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

/**
 * @import { MozButton } from "chrome://global/content/elements/moz-button.mjs"
 */

const PREF_ENABLED = "browser.smartwindow.actionsToolbar.enabled";
const PREF_MEMORIES_CONVERSATION =
  "browser.smartwindow.memories.generateFromConversation";
const PREF_MEMORIES_HISTORY =
  "browser.smartwindow.memories.generateFromHistory";

const TOOLBAR_ID = "smartwindow-actions-toolbar";
const ACTIONS_ID = "smartwindow-actions";
const ICON_ID = "smartwindow-actions-icon";
const ICON_SRC = "chrome://browser/skin/smart-window-simplified.svg";

const SUGGESTION_COUNT = 3;
const MAX_CONTEXT_TABS = 6;
const MAX_CACHE_KEYS = 8;
const REFRESH_DELAY_MS = 400;

/** @typedef {"chat"|"command"} SmartWindowActionKind */

export const ACTION_KIND = Object.freeze({
  CHAT: "chat",
  COMMAND: "command",
});

/**
 * @typedef {object} SmartWindowAction
 * @property {string} id - Stable id for this render of the row.
 * @property {SmartWindowActionKind} kind - "chat" starts a conversation.
 *   "command" runs without opening one.
 * @property {string} label - Text shown on the toolbar button.
 * @property {string} [prompt] - Message a chat action submits.
 * @property {(win: ChromeWindow) => void} [run] - What a command action does.
 *   Must not open a conversation.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  AIWindowUI:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindowUI.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  generateConversationStartersSidebar:
    "moz-src:///browser/components/aiwindow/models/ConversationSuggestions.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(lazy, "enabled", PREF_ENABLED, true, () =>
  SmartWindowActionsToolbar.onEnabledPrefChanged()
);

/** @type {WeakMap<ChromeWindow, object>} */
const windowStates = new WeakMap();

/**
 * Conversation starters for the current page, same generator the sidebar uses.
 * Each one is a chat action: clicking it starts a conversation.
 *
 * @param {ChromeWindow} win
 * @param {AbortSignal} signal
 * @returns {Promise<SmartWindowAction[]>}
 */
async function conversationSuggestionActions(win, signal) {
  const tabs = contextTabs(win);
  if (!tabs.length) {
    return [];
  }

  const useMemories =
    Services.prefs.getBoolPref(PREF_MEMORIES_CONVERSATION, false) ||
    Services.prefs.getBoolPref(PREF_MEMORIES_HISTORY, false);
  const suggestions = await lazy.generateConversationStartersSidebar(
    tabs,
    SUGGESTION_COUNT,
    useMemories,
    null,
    signal
  );

  return suggestions
    .filter(item => item?.text && item.type === "chat")
    .map((item, index) => ({
      id: `chat-${index}`,
      kind: ACTION_KIND.CHAT,
      label: item.text,
      prompt: item.text,
    }));
}

/**
 * @param {ChromeWindow} win
 * @returns {{title: string, url: string}[]} Current page first, then other
 *   http(s) tabs, capped. Plain data so a closed tab cannot be retained.
 */
function contextTabs(win) {
  const selected = win.gBrowser?.selectedTab;
  if (!selected) {
    return [];
  }

  const describe = tab => {
    const uri = tab.linkedBrowser?.currentURI;
    const url = uri?.spec ?? "";
    if (!url || url == "about:blank") {
      return null;
    }
    return { title: tab.label || url, url };
  };

  const current = describe(selected);
  if (!current) {
    return [];
  }

  const tabs = [current];
  for (const tab of win.gBrowser.tabs) {
    if (tabs.length >= MAX_CONTEXT_TABS) {
      break;
    }
    if (tab == selected) {
      continue;
    }
    const scheme = tab.linkedBrowser?.currentURI?.scheme;
    if (scheme != "http" && scheme != "https") {
      continue;
    }
    const described = describe(tab);
    if (described) {
      tabs.push(described);
    }
  }
  return tabs;
}

/**
 * @param {ChromeWindow} win
 * @returns {?{type: string, url: string, label: string}}
 */
function currentPageMention(win) {
  const tab = win.gBrowser?.selectedTab;
  const url = tab?.linkedBrowser?.currentURI?.spec ?? "";
  if (!url || url == "about:blank") {
    return null;
  }
  return {
    type: "currentTab",
    url,
    label: tab.label || url,
  };
}

/**
 * @param {ChromeWindow} win
 * @returns {string}
 */
function contextKey(win) {
  const memories =
    Services.prefs.getBoolPref(PREF_MEMORIES_CONVERSATION, false) ||
    Services.prefs.getBoolPref(PREF_MEMORIES_HISTORY, false)
      ? "1"
      : "0";
  const url = win.gBrowser?.selectedTab?.linkedBrowser?.currentURI?.spec ?? "";
  return `${memories}\n${url == "about:blank" ? "" : url}`;
}

/**
 * The Smart Window document for the selected tab, when this tab is the
 * full-page assistant rather than a web page.
 *
 * @param {ChromeWindow} win
 * @returns {?Element}
 */
function fullpageAiWindow(win) {
  const browser = win.gBrowser?.selectedBrowser;
  if (!browser) {
    return null;
  }
  let doc = null;
  try {
    doc = browser.contentDocument;
  } catch (e) {
    return null;
  }
  return doc?.querySelector("ai-window") ?? null;
}

export const SmartWindowActionsToolbar = {
  /**
   * Sources for the row, in order. Chat providers return conversation
   * starters. Command providers return actions that run without a chat.
   *
   * @type {Array<(
   *   win: ChromeWindow,
   *   signal: AbortSignal
   * ) => Promise<SmartWindowAction[]>>}
   */
  actionProviders: [conversationSuggestionActions],

  /**
   * @param {ChromeWindow} win
   */
  init(win) {
    if (!win.gBrowser || windowStates.has(win)) {
      this._scheduleRefresh(win);
      return;
    }

    const state = {
      abortController: null,
      actions: [],
      cache: new Map(),
      cacheKey: null,
      pendingKey: null,
      refreshTimer: 0,
      starting: false,
    };
    windowStates.set(win, state);

    state.onTabSelect = () => this._scheduleRefresh(win);
    win.gBrowser.tabContainer.addEventListener("TabSelect", state.onTabSelect);

    state.progressListener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onLocationChange(webProgress, _request, _location, flags) {
        if (
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT &&
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_HASHCHANGE
        ) {
          return;
        }
        if (!webProgress.isTopLevel) {
          return;
        }
        SmartWindowActionsToolbar._scheduleRefresh(win);
      },
      onStateChange() {},
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };
    win.gBrowser.addProgressListener(
      state.progressListener,
      Ci.nsIWebProgress.NOTIFY_LOCATION
    );

    this._scheduleRefresh(win);
  },

  /**
   * @param {ChromeWindow} win
   */
  uninit(win) {
    const state = windowStates.get(win);
    if (!state) {
      return;
    }
    win.clearTimeout(state.refreshTimer);
    state.abortController?.abort();
    win.gBrowser?.tabContainer.removeEventListener(
      "TabSelect",
      state.onTabSelect
    );
    if (state.progressListener) {
      win.gBrowser?.removeProgressListener(state.progressListener);
    }
    win.document.getElementById(TOOLBAR_ID)?.remove();
    windowStates.delete(win);
  },

  onEnabledPrefChanged() {
    this.onFeatureChanged();
  },

  onFeatureChanged() {
    for (const win of ChromeUtils.nondeterministicGetWeakMapKeys(
      windowStates
    )) {
      if (!win || win.closed) {
        continue;
      }
      if (this._shouldShow(win)) {
        this._scheduleRefresh(win);
      } else {
        this._hide(win);
      }
    }
  },

  /**
   * @param {ChromeWindow} win
   * @returns {boolean}
   */
  _shouldShow(win) {
    if (!lazy.enabled || !lazy.AIWindow.isAIWindowEnabled()) {
      return false;
    }
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return false;
    }
    const hidden = win.document.documentElement.getAttribute("chromehidden");
    return !hidden?.includes("toolbar");
  },

  /**
   * @param {ChromeWindow} win
   */
  _scheduleRefresh(win) {
    const state = windowStates.get(win);
    if (!state) {
      return;
    }
    win.clearTimeout(state.refreshTimer);
    if (!this._shouldShow(win)) {
      this._hide(win);
      return;
    }
    state.refreshTimer = win.setTimeout(
      () => this._refresh(win),
      REFRESH_DELAY_MS
    );
  },

  /**
   * @param {ChromeWindow} win
   */
  _hide(win) {
    const state = windowStates.get(win);
    if (!state) {
      return;
    }
    win.clearTimeout(state.refreshTimer);
    state.abortController?.abort();
    state.abortController = null;
    state.pendingKey = null;
    state.cacheKey = null;
    state.actions = [];
    win.document.getElementById(TOOLBAR_ID)?.remove();
  },

  /**
   * @param {ChromeWindow} win
   */
  async _refresh(win) {
    const state = windowStates.get(win);
    if (!state || win.closed || !this._shouldShow(win)) {
      return;
    }

    const key = contextKey(win);
    if (key == state.cacheKey || key == state.pendingKey) {
      return;
    }

    const cached = state.cache.get(key);
    if (cached) {
      state.cache.delete(key);
      state.cache.set(key, cached);
      state.cacheKey = key;
      state.pendingKey = null;
      this._render(win, cached);
      return;
    }

    state.abortController?.abort();
    const controller = new AbortController();
    state.abortController = controller;
    state.pendingKey = key;
    this._render(win, [], { loading: true });

    /** @type {SmartWindowAction[]} */
    const actions = [];
    for (const provider of this.actionProviders) {
      try {
        const provided = await provider(win, controller.signal);
        if (controller.signal.aborted || win.closed) {
          return;
        }
        if (provided?.length) {
          actions.push(...provided);
        }
      } catch (error) {
        if (error?.name == "AbortError" || controller.signal.aborted) {
          return;
        }
        console.error("Smart Window actions toolbar provider failed:", error);
      }
    }

    if (controller.signal.aborted || win.closed) {
      return;
    }
    // The page changed while suggestions were generating. The listener for
    // that navigation schedules its own refresh; don't cache this result.
    if (contextKey(win) != key) {
      if (state.pendingKey == key) {
        state.pendingKey = null;
      }
      return;
    }

    state.pendingKey = null;
    state.cacheKey = key;
    state.cache.delete(key);
    state.cache.set(key, actions);
    while (state.cache.size > MAX_CACHE_KEYS) {
      const oldest = state.cache.keys().next().value;
      state.cache.delete(oldest);
    }
    this._render(win, actions);
  },

  /**
   * @param {ChromeWindow} win
   * @returns {XULElement}
   */
  _ensureToolbar(win) {
    const doc = win.document;
    const existing = doc.getElementById(TOOLBAR_ID);
    if (existing) {
      return existing;
    }

    const toolbar = doc.createXULElement("toolbar");
    toolbar.id = TOOLBAR_ID;
    toolbar.className = "browser-toolbar";
    toolbar.setAttribute("mode", "text");
    toolbar.setAttribute("fullscreentoolbar", "true");
    toolbar.setAttribute("customizable", "false");
    toolbar.collapsed = true;
    doc.l10n.setAttributes(toolbar, "smartwindow-actions-toolbar");

    const icon = doc.createXULElement("image");
    icon.id = ICON_ID;
    icon.setAttribute("src", ICON_SRC);
    icon.setAttribute("role", "presentation");

    const actions = doc.createXULElement("hbox");
    actions.id = ACTIONS_ID;
    actions.setAttribute("flex", "1");
    toolbar.append(icon, actions);

    const navBar = doc.getElementById("nav-bar");
    if (navBar) {
      navBar.after(toolbar);
    } else {
      doc.getElementById("navigator-toolbox")?.appendChild(toolbar);
    }
    return toolbar;
  },

  /**
   * @param {ChromeWindow} win
   * @param {SmartWindowAction[]} actions
   * @param {object} [options]
   * @param {boolean} [options.loading]
   */
  _render(win, actions, { loading = false } = {}) {
    const state = windowStates.get(win);
    const toolbar = this._ensureToolbar(win);
    const box = toolbar.querySelector(`#${ACTIONS_ID}`);
    const doc = win.document;
    box.replaceChildren();
    state.actions = loading ? [] : actions;

    if (loading) {
      const button = this._createButton(doc);
      button.disabled = true;
      doc.l10n.setAttributes(button, "smartwindow-actions-loading");
      box.appendChild(button);
      toolbar.collapsed = false;
      return;
    }

    if (!actions.length) {
      toolbar.collapsed = true;
      return;
    }

    for (const action of actions) {
      const button = this._createButton(doc);
      button.label = action.label;
      button.title = action.label;
      button.setAttribute("data-action-id", action.id);
      button.addEventListener("click", event => {
        this._run(win, event.currentTarget.getAttribute("data-action-id"));
      });
      box.appendChild(button);
    }
    toolbar.collapsed = false;
  },

  /**
   * @param {Document} doc
   * @returns {MozButton}
   */
  _createButton(doc) {
    const button = doc.createElement("moz-button");
    button.size = "small";
    return button;
  },

  /**
   * @param {ChromeWindow} win
   * @param {string} actionId
   */
  _run(win, actionId) {
    const action = windowStates
      .get(win)
      ?.actions.find(item => item.id == actionId);
    if (!action) {
      return;
    }
    if (action.kind == ACTION_KIND.COMMAND) {
      action.run?.(win);
      return;
    }
    if (action.kind == ACTION_KIND.CHAT) {
      this._startChat(win, action).catch(error => {
        console.error("Failed to start a Smart Window action:", error);
      });
    }
  },

  /**
   * Opens a new conversation with the action's prompt and the current page.
   * A full-page Smart Window tab receives it there. Anywhere else, the sidebar
   * opens beside the page. Command actions never come through here.
   *
   * @param {ChromeWindow} win
   * @param {SmartWindowAction} action
   */
  async _startChat(win, action) {
    const state = windowStates.get(win);
    const prompt = action.prompt?.trim();
    if (!state || state.starting || !prompt) {
      return;
    }
    state.starting = true;
    try {
      const fullpage = fullpageAiWindow(win);
      let aiWindow = fullpage;
      if (aiWindow) {
        aiWindow.onCreateNewChatClick();
      } else {
        await lazy.AIWindowUI.openSidebar(win);
        const browser = win.document.getElementById(lazy.AIWindowUI.BROWSER_ID);
        aiWindow = browser
          ? await lazy.AIWindowUI.getAiWindowElement(win, browser)
          : null;
      }
      if (!aiWindow || win.closed) {
        return;
      }

      const mention = currentPageMention(win);
      aiWindow.submitChatMessage({
        text: prompt,
        submitType: "starter",
        contextMentions: mention ? [mention] : [],
        contextPageUrl: mention ? URL.parse(mention.url) : null,
      });
    } finally {
      state.starting = false;
    }
  },
};
