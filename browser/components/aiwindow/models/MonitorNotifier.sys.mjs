/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * In-browser notification for monitor agents.
 *
 * When a monitor's scheduled check determines its watched condition is met,
 * MonitorAgent calls notifyConditionMet(). This shows a window-global infobar
 * in an AI Window with "Visit page" and "Modify monitor" actions (plus the
 * infobar's built-in dismiss). If no AI Window is available the notification is
 * queued and flushed once one becomes available.
 */

import {
  ChatConversation,
  ChatStore,
} from "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs";
import { AssistantRoleOpts } from "moz-src:///browser/components/aiwindow/ui/modules/ChatMessage.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  AIWindowUI:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindowUI.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "MonitorNotifier",
    maxLogLevelPref: "browser.smartwindow.conversation.logLevel",
  })
);
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["preview/aiWindow.ftl"])
);

export const MonitorNotifier = {
  /** @type {Array<{ monitor: object, result: object }>} */
  _queue: [],
  _observing: false,

  /**
   * Show (or queue) a notification for a monitor whose condition was met.
   *
   * @param {object} monitor  A cloned monitor record.
   * @param {{ explanation: string, conditionMet: boolean }} result
   */
  notifyConditionMet(monitor, result) {
    if (!monitor?.id) {
      return;
    }

    const win = this._findAIWindow();
    if (win) {
      this._showNotification(win, monitor, result);
      return;
    }

    // No AI Window yet. Queue it, deduping by monitor so repeated deferred
    // checks for the same monitor don't stack stale infobars.
    this._queue = this._queue.filter(entry => entry.monitor.id !== monitor.id);
    this._queue.push({ monitor, result });
    this._ensureObserver();
  },

  /**
   * @returns {Window | null} An open, enabled AI Window, or null.
   */
  _findAIWindow() {
    const top = lazy.BrowserWindowTracker.getTopWindow({
      allowFromInactiveWorkspace: true,
    });
    if (top && !top.closed && lazy.AIWindow.isAIWindowActiveAndEnabled(top)) {
      return top;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!win.closed && lazy.AIWindow.isAIWindowActiveAndEnabled(win)) {
        return win;
      }
    }
    return null;
  },

  _ensureObserver() {
    if (this._observing) {
      return;
    }
    // "ai-window-state-changed"/"smart" fires when a window toggles to an AI
    // Window. "browser-delayed-startup-finished" covers windows that open
    // directly as AI Windows (e.g. session restore), where no toggle fires.
    Services.obs.addObserver(this, "ai-window-state-changed");
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    this._observing = true;
  },

  _teardownObserver() {
    if (!this._observing) {
      return;
    }
    Services.obs.removeObserver(this, "ai-window-state-changed");
    Services.obs.removeObserver(this, "browser-delayed-startup-finished");
    this._observing = false;
  },

  observe(subject, topic, data) {
    let win = null;
    if (topic === "ai-window-state-changed" && data === "smart") {
      win = subject;
    } else if (topic === "browser-delayed-startup-finished") {
      win = subject;
      if (!win || !lazy.AIWindow.isAIWindowActiveAndEnabled(win)) {
        return;
      }
    } else {
      return;
    }
    this._flushQueue(win);
  },

  _flushQueue(win) {
    if (!win || win.closed || !win.gNotificationBox || !this._queue.length) {
      return;
    }
    const pending = this._queue;
    this._queue = [];
    this._teardownObserver();
    for (const { monitor, result } of pending) {
      this._showNotification(win, monitor, result);
    }
  },

  async _showNotification(win, monitor, result) {
    if (!win || win.closed || !win.gNotificationBox) {
      // Window vanished before we could show. Re-queue and keep waiting.
      this._queue = this._queue.filter(
        entry => entry.monitor.id !== monitor.id
      );
      this._queue.push({ monitor, result });
      this._ensureObserver();
      return;
    }

    const title = monitor.pageTitle || monitor.pageUrl || "";
    const [label, visitLabel, modifyLabel] = await lazy.l10n.formatValues([
      { id: "monitor-notification-label", args: { title } },
      { id: "monitor-notification-visit-button" },
      { id: "monitor-notification-modify-button" },
    ]);

    if (win.closed || !win.gNotificationBox) {
      return;
    }

    const buttons = [
      {
        label: visitLabel,
        callback: () => {
          this._onVisitPage(win, monitor, result).catch(error =>
            lazy.console.error("Monitor notification visit failed:", error)
          );
        },
      },
      {
        label: modifyLabel,
        callback: () => {
          this._onModifyMonitor(win, monitor);
        },
      },
    ];

    win.gNotificationBox.appendNotification(
      `smartwindow-monitor-${monitor.id}`,
      { label, priority: win.gNotificationBox.PRIORITY_INFO_HIGH },
      buttons,
      false,
      true
    );
  },

  /**
   * Navigate to the monitored page and open the sidebar seeded with the
   * monitor's prompt and the model's explanation.
   */
  async _onVisitPage(win, monitor, result) {
    const url = URL.parse(monitor.pageUrl);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      lazy.console.warn(
        "Refusing to visit non-web monitor URL:",
        monitor.pageUrl
      );
      return;
    }

    // The conversation must be persisted with messages before openSidebar, or
    // openConversation treats it as empty and clears the chat.
    const conversation = new ChatConversation({
      pageUrl: url,
      pageMeta: { title: monitor.pageTitle || "" },
    });
    conversation.addUserMessage(monitor.prompt, url);
    const assistantMessage = conversation.addAssistantMessage(
      "text",
      result.explanation,
      new AssistantRoleOpts()
    );
    // Tag the message with its monitor so the sidebar chat can render
    // delete/update controls. Stored in content so it survives persistence.
    if (assistantMessage) {
      assistantMessage.content.monitorId = monitor.id;
    }
    await ChatStore.updateConversation(conversation);

    if (win.closed) {
      return;
    }
    win.gBrowser.selectedBrowser.loadURI(Services.io.newURI(monitor.pageUrl), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    await lazy.AIWindowUI.openSidebar(win, conversation);
  },

  _onModifyMonitor(win, monitor) {
    if (win.closed) {
      return;
    }
    lazy.AIWindow.openMonitorAgentsPage(win, { monitorId: monitor.id });
  },
};
