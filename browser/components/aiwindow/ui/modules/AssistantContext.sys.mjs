/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AssistantSession } from "moz-src:///browser/components/aiwindow/models/AssistantSession.sys.mjs";

const lazy = {};
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["preview/aiWindow.ftl"], true)
);

export const AssistantContext = new (class {
  #windows = new Map();
  #groupIds = new Map();

  constructor() {
    AssistantSession.on("page-access-changed", () => {
      for (const win of this.#windows.keys()) {
        for (const tab of win.gBrowser.tabs) {
          this.#updateTab(tab);
        }
      }
    });
    AssistantSession.on("context-changed", () => this.#syncGroup());
    AssistantSession.on("context-cleared", (_event, { userContextId }) => {
      for (const id of this.#groupIds.keys()) {
        if (
          this.#getGroup(id)?.tabs.some(
            tab => tab.userContextId === userContextId
          )
        ) {
          this.#groupIds.delete(id);
        }
      }
      for (const win of this.#windows.keys()) {
        win.gBrowser.removeTabs(
          win.gBrowser.tabs.filter(tab => tab.userContextId === userContextId),
          {
            animate: false,
            skipPermitUnload: true,
            skipSessionStore: true,
            closeWindowWithLastTab: false,
          }
        );
      }
    });
  }

  init(win) {
    if (this.#windows.has(win) || !win.gBrowser) {
      return;
    }
    win.document.l10n.addResourceIds(["preview/aiWindow.ftl"]);
    const update = browser => {
      const tab = win.gBrowser.getTabForBrowser(browser);
      if (tab) {
        this.#updateTab(tab);
      }
    };
    const progress = {
      onLocationChange: (browser, webProgress) => {
        if (webProgress.isTopLevel) {
          update(browser);
        }
      },
      onStateChange: (browser, webProgress, _request, flags) => {
        if (
          webProgress.isTopLevel &&
          flags & Ci.nsIWebProgressListener.STATE_STOP
        ) {
          update(browser);
        }
      },
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
    };
    const onTab = event => this.#updateTab(event.target);
    win.gBrowser.addTabsProgressListener(progress);
    for (const type of ["TabOpen", "SSTabRestored", "TabRemotenessChange"]) {
      win.gBrowser.tabContainer.addEventListener(type, onTab);
    }
    const modeObserver = new win.MutationObserver(() => {
      for (const tab of win.gBrowser.tabs) {
        this.#updateTab(tab);
      }
    });
    modeObserver.observe(win.document.documentElement, {
      attributes: true,
      attributeFilter: ["ai-window"],
    });
    this.#windows.set(win, progress);
    win.addEventListener(
      "unload",
      () => {
        modeObserver.disconnect();
        win.gBrowser.removeTabsProgressListener(progress);
        for (const type of [
          "TabOpen",
          "SSTabRestored",
          "TabRemotenessChange",
        ]) {
          win.gBrowser.tabContainer.removeEventListener(type, onTab);
        }
        this.#windows.delete(win);
      },
      { once: true }
    );
    for (const tab of win.gBrowser.tabs) {
      this.#updateTab(tab);
    }
  }

  #updateTab(tab) {
    if (tab.hasAttribute("assistant-context-site")) {
      const uri = tab.linkedBrowser.currentURI;
      if (["http", "https"].includes(uri?.scheme)) {
        const origin = new URL(uri.spec).origin;
        if (tab.getAttribute("assistant-context-site") !== origin) {
          tab.setAttribute("assistant-context-site", origin);
          if (this.#getGroup()?.tabs.includes(tab)) {
            this.#syncGroup();
          }
        }
      }
    }
    const shared =
      tab.ownerDocument.documentElement.hasAttribute("ai-window") &&
      !!AssistantSession.getPageAccess(tab.linkedBrowser)?.shared;
    tab.toggleAttribute("assistant-page-shared", shared);
    const badge = tab.querySelector(".assistant-page-shared-icon");
    if (!shared) {
      badge?.remove();
    } else if (!badge) {
      const icon = tab.ownerDocument.createXULElement("image");
      icon.className = "assistant-page-shared-icon";
      icon.setAttribute("role", "img");
      tab.ownerDocument.l10n.setAttributes(
        icon,
        "aiwindow-page-session-tab-shared"
      );
      tab.querySelector(".tab-icon-stack").after(icon);
    }
  }

  #getGroup(conversationId = AssistantSession.conversation.id) {
    const groupId = this.#groupIds.get(conversationId);
    for (const win of this.#windows.keys()) {
      const group = win.gBrowser.tabGroups.find(item => item.id === groupId);
      if (group) {
        group.setAttribute("assistant-context", "");
        group.saveOnWindowClose = false;
        return group;
      }
    }
    return null;
  }

  #addSite(win, origin, group) {
    const tab = win.gBrowser.addTrustedTab(origin, {
      userContextId: AssistantSession.originAttributes.userContextId,
      createLazyBrowser: true,
      skipAnimation: true,
      tabGroup: group,
    });
    tab.setAttribute("assistant-context-site", origin);
    return tab;
  }

  #syncGroup() {
    const group = this.#getGroup();
    if (!group) {
      return;
    }
    const sites = new Map();
    for (const tab of group.tabs) {
      const origin = tab.getAttribute("assistant-context-site");
      const previous = sites.get(origin);
      if (previous?.hasAttribute("pending") && !tab.hasAttribute("pending")) {
        group.documentGlobal.gBrowser.removeTab(previous, {
          skipSessionStore: true,
          animate: false,
        });
      } else if (previous && tab.hasAttribute("pending")) {
        group.documentGlobal.gBrowser.removeTab(tab, {
          skipSessionStore: true,
          animate: false,
        });
        continue;
      }
      sites.set(origin, tab);
    }
    for (const origin of AssistantSession.visitedSites) {
      if (!sites.has(origin)) {
        this.#addSite(group.documentGlobal, origin, group);
      }
    }
  }

  show(win) {
    this.init(win);
    let group = this.#getGroup();
    if (!group) {
      const [first] = AssistantSession.visitedSites;
      if (!first) {
        return null;
      }
      const tab = this.#addSite(win, first);
      group = win.gBrowser.addTabGroup([tab], {
        label: lazy.l10n.formatValueSync("aiwindow-assistant-context-group"),
        color: "purple",
      });
      this.#groupIds.set(AssistantSession.conversation.id, group.id);
      group.setAttribute("assistant-context", "");
      group.saveOnWindowClose = false;
    }
    this.#syncGroup();
    group.collapsed = false;
    const owner = group.documentGlobal;
    owner.gBrowser.selectedTab = group.tabs[0];
    owner.focus();
    return group;
  }
})();
