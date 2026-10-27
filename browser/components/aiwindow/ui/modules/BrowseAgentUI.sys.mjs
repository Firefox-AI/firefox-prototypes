/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Hosts the Browse Agent panel in the Smart Window sidebar box, next to the
 * chat browser, and routes the /browse smartbar command to it.
 */

import {
  AGENT_COMMANDS,
  parseAgentCommand,
} from "chrome://browser/content/aiwindow/modules/AgentCommands.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  AIWindowUI:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindowUI.sys.mjs",
  BrowseAgent:
    "moz-src:///browser/components/aiwindow/models/agents/BrowseAgent.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const PANEL_URL = "chrome://browser/content/aiwindow/browseAgent.html";
const BROWSER_ID = "browse-agent-browser";
const PINNED_ATTR = "browse-agent-active";
const PANEL_READY_TIMEOUT_MS = 5000;

export const BrowseAgentUI = {
  PANEL_URL,
  BROWSER_ID,

  isEnabled() {
    return lazy.BrowseAgent.enabled;
  },

  /**
   * Whether the agent panel currently owns the sidebar box, in which case the
   * tab state manager must not close it under a running session.
   *
   * @param {ChromeWindow} win
   */
  isPinned(win) {
    return !!win?.document
      .getElementById(lazy.AIWindowUI.BOX_ID)
      ?.hasAttribute(PINNED_ATTR);
  },

  /**
   * Handles "/browse <task>" from the smartbar.
   *
   * @param {object} options
   * @param {string} [options.command] - Command id picked from the palette
   * @param {string} options.value - Raw smartbar input
   * @param {ChromeWindow} options.window
   * @returns {boolean} true when the input was a browse command
   */
  tryHandleCommand({ command, value, window }) {
    if (!this.isEnabled()) {
      return false;
    }
    const parsed = parseAgentCommand(value);
    const id = command ?? parsed?.command;
    if (id !== AGENT_COMMANDS.BROWSE) {
      return false;
    }
    const task = parsed?.prompt ?? "";
    this.open(window, { task, autoStart: !!task });
    return true;
  },

  /**
   * Shows the panel in the sidebar box, optionally starting a task.
   *
   * @param {ChromeWindow} win
   * @param {object} [options]
   * @param {string} [options.task] Task text to prefill.
   * @param {boolean} [options.autoStart] Start the task right away.
   */
  async open(win, { task = "", autoStart = false } = {}) {
    const nodes = lazy.AIWindowUI._getSidebarElements(win);
    if (!nodes) {
      return;
    }
    const { chromeDoc, box, splitter } = nodes;

    // The Smart Window hides the sidebar on its own new tab page, so give the
    // agent a tab where the sidebar can show.
    const currentURI = win.gBrowser.selectedBrowser.currentURI;
    if (lazy.AIWindow.isAIWindowContentPage(currentURI)) {
      win.gBrowser.selectedTab = win.gBrowser.addTrustedTab("about:blank", {
        inBackground: false,
      });
    }

    const browser = ensureBrowser(chromeDoc, box);
    const chatBrowser = chromeDoc.getElementById(lazy.AIWindowUI.BROWSER_ID);
    if (chatBrowser) {
      chatBrowser.hidden = true;
    }
    browser.hidden = false;
    box.toggleAttribute(PINNED_ATTR, true);

    if (!lazy.AIWindowUI.isSidebarOpen(win)) {
      lazy.AIWindowUI._setSidebarCollapsed(win, box, splitter, false, {
        animate: false,
      });
    }
    lazy.AIWindowUI._updateAskButtonChecked(win, true);

    const panel = await getPanel(browser);
    if (!panel) {
      return;
    }
    if (task) {
      panel.task = task;
    }
    if (autoStart && task) {
      panel.startTask(task);
    } else {
      panel.focusInput();
    }
  },

  /**
   * Hands the sidebar back to the chat (or closes it in a classic window).
   *
   * @param {ChromeWindow} win
   */
  showChat(win) {
    if (!this.unpin(win)) {
      return;
    }
    if (lazy.AIWindow.isAIWindowActive(win)) {
      lazy.AIWindowUI.openSidebar(
        win,
        lazy.AIWindow.getActiveConversation(win)
      );
    } else {
      lazy.AIWindowUI.closeSidebar(win);
    }
  },

  /**
   * Gives the sidebar box back to the chat browser without opening or closing
   * the sidebar.
   *
   * @param {ChromeWindow} win
   * @returns {boolean} false when the window has no sidebar box
   */
  unpin(win) {
    const nodes = lazy.AIWindowUI._getSidebarElements(win);
    if (!nodes) {
      return false;
    }
    const { chromeDoc, box } = nodes;
    box.removeAttribute(PINNED_ATTR);
    const browser = chromeDoc.getElementById(BROWSER_ID);
    if (browser) {
      browser.hidden = true;
    }
    const chatBrowser = chromeDoc.getElementById(lazy.AIWindowUI.BROWSER_ID);
    if (chatBrowser) {
      chatBrowser.hidden = false;
    }
    return true;
  },

  toggle(win) {
    const browser = win.document.getElementById(BROWSER_ID);
    if (
      browser &&
      !browser.hidden &&
      lazy.AIWindowUI.isSidebarOpen(win) &&
      this.isPinned(win)
    ) {
      this.showChat(win);
      return;
    }
    this.open(win);
  },
};

function ensureBrowser(chromeDoc, box) {
  let browser = chromeDoc.getElementById(BROWSER_ID);
  if (browser) {
    return browser;
  }
  let stack = box.querySelector(`.${lazy.AIWindowUI.STACK_CLASS}`);
  if (!stack) {
    stack = chromeDoc.createXULElement("stack");
    stack.className = lazy.AIWindowUI.STACK_CLASS;
    stack.setAttribute("flex", "1");
    box.appendChild(stack);
  }
  browser = chromeDoc.createXULElement("browser");
  browser.id = BROWSER_ID;
  browser.setAttribute("transparent", "true");
  browser.setAttribute("flex", "1");
  browser.setAttribute("disablehistory", "true");
  browser.setAttribute("disablefullscreen", "true");
  browser.setAttribute("tooltip", "aHTMLTooltip");
  browser.setAttribute("type", "content");
  browser.setAttribute("src", PANEL_URL);
  stack.appendChild(browser);
  return browser;
}

async function getPanel(browser) {
  const deadline = Date.now() + PANEL_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const doc = browser.contentDocument;
    const panel = doc?.querySelector("browse-agent-panel");
    if (panel && doc.readyState === "complete") {
      await doc.defaultView.customElements.whenDefined("browse-agent-panel");
      await panel.updateComplete;
      return panel;
    }
    await new Promise(resolve => lazy.setTimeout(resolve, 50));
  }
  return null;
}
