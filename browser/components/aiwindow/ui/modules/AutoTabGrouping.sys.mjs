/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SmartTabGroupingManager:
    "moz-src:///browser/components/tabbrowser/SmartTabGrouping.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "AutoTabGrouping",
    maxLogLevelPref: "browser.smartwindow.autoTabGrouping.loglevel",
  })
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "enabled",
  "browser.smartwindow.autoTabGrouping.enabled",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "mode",
  "browser.smartwindow.autoTabGrouping.mode",
  "suggest"
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "maxGroups",
  "browser.smartwindow.autoTabGrouping.maxGroups",
  3
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "minTabsPerGroup",
  "browser.smartwindow.autoTabGrouping.minTabsPerGroup",
  2
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "minCandidateTabs",
  "browser.smartwindow.autoTabGrouping.minCandidateTabs",
  4
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "triggerOnOpen",
  "browser.smartwindow.autoTabGrouping.triggerOnOpen",
  true
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "triggerOnSwitch",
  "browser.smartwindow.autoTabGrouping.triggerOnSwitch",
  true
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "reviewBeforeGrouping",
  "browser.smartwindow.autoTabGrouping.reviewBeforeGrouping",
  false
);

const NOTIFICATION_VALUE = "smartwindow-auto-tab-grouping";

export const AutoTabGrouping = {
  /**
   * Windows we've already offered grouping for in their current lifetime, so a
   * trigger doesn't repeatedly nag the user.
   *
   * @type {WeakSet<ChromeWindow>}
   */
  _offeredWindows: new WeakSet(),
  _manager: null,

  get manager() {
    if (!this._manager) {
      this._manager = new lazy.SmartTabGroupingManager();
    }
    return this._manager;
  },

  /**
   * Entry point called from the AI Window lifecycle.
   *
   * @param {ChromeWindow} win - The Smart Window.
   * @param {"open"|"switch"} trigger - What caused this call.
   */
  async maybeAutoGroup(win, trigger) {
    try {
      if (!lazy.enabled) {
        return;
      }
      if (trigger == "open" && !lazy.triggerOnOpen) {
        return;
      }
      if (trigger == "switch" && !lazy.triggerOnSwitch) {
        return;
      }
      if (!win?.gBrowser || win.closed) {
        return;
      }
      if (this._offeredWindows.has(win)) {
        lazy.console.debug(
          "Already offered grouping for this window; skipping"
        );
        return;
      }
      this._offeredWindows.add(win);

      await this._run(win, trigger);
    } catch (e) {
      lazy.console.warn("maybeAutoGroup failed", e);
    }
  },

  /**
   * Clusters the candidate tabs and proposes/creates up to maxGroups groups.
   *
   * @param {ChromeWindow} win
   * @param {string} trigger
   */
  async _run(win, trigger) {
    const candidates = this._getCandidateTabs(win);
    if (candidates.length < lazy.minCandidateTabs) {
      lazy.console.debug(
        `Only ${candidates.length} candidate tabs (< ${lazy.minCandidateTabs}); skipping`
      );
      return;
    }

    const groups = await this._buildGroupProposals(win, candidates);
    if (!groups.length) {
      lazy.console.debug("No clusters met the threshold; skipping");
      return;
    }

    lazy.console.debug(
      `Proposing ${groups.length} group(s) on ${trigger}`,
      groups.map(g => `${g.label} (${g.tabs.length})`)
    );

    if (lazy.mode == "create") {
      this._createGroups(win, groups);
    } else if (lazy.reviewBeforeGrouping) {
      this._showReviewPanel(win, groups);
    } else {
      this._showSuggestionBar(win, groups);
    }
  },

  /**
   * Ungrouped, non-pinned, web-content tabs eligible for clustering.
   *
   * @param {ChromeWindow} win
   * @returns {MozTabbrowserTab[]}
   */
  _getCandidateTabs(win) {
    return win.gBrowser.tabs.filter(tab => {
      if (tab.pinned || tab.closing || tab.group || tab.hidden) {
        return false;
      }
      const uri = tab.linkedBrowser?.currentURI;
      // Only cluster real web content; skip about:, chrome:, the Smart Window
      // new tab / chat pages, etc.
      return uri && (uri.schemeIs("http") || uri.schemeIs("https"));
    });
  },

  /**
   * Runs clustering + labeling and returns the top proposals.
   *
   * @param {ChromeWindow} win
   * @param {MozTabbrowserTab[]} candidates
   * @returns {Promise<Array<{label: string, tabs: MozTabbrowserTab[]}>>}
   */
  async _buildGroupProposals(win, candidates) {
    const result = await this.manager.generateClusters(candidates, null, 0);
    if (!result?.clusterRepresentations?.length) {
      return [];
    }

    let clusters = result.clusterRepresentations
      .filter(c => c.tabs && c.tabs.length >= lazy.minTabsPerGroup)
      .sort((a, b) => b.tabs.length - a.tabs.length);

    const moreAvailable = clusters.length > lazy.maxGroups;
    clusters = clusters.slice(0, lazy.maxGroups);
    if (!clusters.length) {
      return [];
    }

    const groupedTabs = new Set(clusters.flatMap(c => c.tabs));
    const otherTabs = candidates.filter(t => !groupedTabs.has(t));

    const proposals = [];
    for (const cluster of clusters) {
      let label = "";
      try {
        label = await this.manager.getPredictedLabelForGroup(
          cluster.tabs,
          otherTabs
        );
      } catch (e) {
        lazy.console.warn("Label generation failed", e);
      }
      proposals.push({ label: label || "", tabs: cluster.tabs });
    }
    this._moreAvailable = moreAvailable;
    return proposals;
  },

  /**
   * Creates the proposed groups and shows an undo bar.
   *
   * @param {ChromeWindow} win
   * @param {Array<{label: string, tabs: MozTabbrowserTab[]}>} proposals
   * @returns {object[]} The created group elements.
   */
  _createGroups(win, proposals) {
    const created = [];
    const windowTabs = new Set(win.gBrowser.tabs);
    for (const proposal of proposals) {
      // Tabs may have been closed/moved/grouped while models ran, so only keep
      // ungrouped tabs that still live in this window.
      const tabs = proposal.tabs.filter(
        t => !t.closing && !t.group && windowTabs.has(t)
      );
      if (tabs.length < lazy.minTabsPerGroup) {
        continue;
      }
      const group = win.gBrowser.addTabGroup(tabs, {
        label: proposal.label,
        telemetryUserCreateSource: "smartwindow-auto",
      });
      if (group) {
        created.push(group);
      }
    }
    if (created.length) {
      this._showUndoBar(win, created);
    }
    return created;
  },

  /**
   * Suggest mode: offer the groups; only create them when the user accepts.
   *
   * @param {ChromeWindow} win
   * @param {Array<{label: string, tabs: MozTabbrowserTab[]}>} proposals
   */
  _showSuggestionBar(win, proposals) {
    const box = win.gNotificationBox;
    if (!box) {
      return;
    }
    const names = proposals
      .map(p => p.label || "Untitled")
      .filter(Boolean)
      .join(", ");
    const tabCount = proposals.reduce((n, p) => n + p.tabs.length, 0);

    box.appendNotification(
      NOTIFICATION_VALUE,
      {
        label: `Group ${tabCount} tabs into ${proposals.length} group${
          proposals.length > 1 ? "s" : ""
        }: ${names}?`,
        priority: box.PRIORITY_INFO_MEDIUM,
      },
      [
        {
          label: "Group them",
          callback: () => {
            this._createGroups(win, proposals);
            return false;
          },
        },
        {
          label: "Not now",
          callback: () => false,
        },
      ]
    );
  },

  /**
   * Suggest mode + review pref: show an interactive panel where the user can
   * rename each proposed group and uncheck individual member tabs before
   * creating. Confirm routes through _createGroups (which re-validates tabs and
   * shows the undo bar, keeping "Group more" working). Cancel creates nothing.
   *
   * @param {ChromeWindow} win
   * @param {Array<{label: string, tabs: MozTabbrowserTab[]}>} proposals
   */
  _showReviewPanel(win, proposals) {
    const doc = win.document;
    const popupSet = doc.getElementById("mainPopupSet");
    const anchor =
      doc.getElementById("alltabs-button") ||
      doc.getElementById("tabbrowser-tabs");
    if (!popupSet || !anchor) {
      // Fall back to the simple bar if the chrome we anchor to is missing.
      this._showSuggestionBar(win, proposals);
      return;
    }

    const HTML_NS = "http://www.w3.org/1999/xhtml";

    const panel = doc.createXULElement("panel");
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("orient", "vertical");
    panel.setAttribute("class", "panel-no-padding");
    panel.id = "smartwindow-auto-tab-grouping-review-panel";

    const body = doc.createElementNS(HTML_NS, "div");
    body.className = "panel-subview-body";

    const title = doc.createElementNS(HTML_NS, "h1");
    title.className = "panel-header";
    doc.l10n.setAttributes(title, "tab-group-editor-title-suggest");
    body.appendChild(title);

    // Per-proposal mutable state: the name field plus the still-selected tabs.
    const groupState = [];

    for (const proposal of proposals) {
      const state = { labelInput: null, selected: new Set(proposal.tabs) };

      const nameWrap = doc.createElementNS(HTML_NS, "div");
      nameWrap.className = "tab-group-editor-name";
      const nameLabel = doc.createElementNS(HTML_NS, "label");
      doc.l10n.setAttributes(nameLabel, "tab-group-editor-name-label");
      const nameInput = doc.createElementNS(HTML_NS, "input");
      nameInput.type = "text";
      nameInput.value = proposal.label || "";
      doc.l10n.setAttributes(nameInput, "tab-group-editor-name-field");
      state.labelInput = nameInput;
      nameWrap.append(nameLabel, nameInput);
      body.appendChild(nameWrap);

      // One checkbox per member tab (favicon + title), checked by default.
      // Mirrors tabgroup-menu.js #createRow.
      for (const tab of proposal.tabs) {
        const checkbox = doc.createElement("moz-checkbox");
        checkbox.label = tab.label;
        checkbox.iconSrc = tab.image;
        checkbox.checked = true;
        checkbox.classList.add(
          "tab-group-suggestion-checkbox",
          "text-truncated-ellipsis"
        );
        checkbox.addEventListener("change", e => {
          if (e.target.checked) {
            state.selected.add(tab);
          } else {
            state.selected.delete(tab);
          }
        });
        body.appendChild(checkbox);
      }

      groupState.push(state);
    }

    const footer = doc.createElement("moz-button-group");
    footer.className = "panel-footer";
    const cancelBtn = doc.createElement("moz-button");
    doc.l10n.setAttributes(cancelBtn, "tab-group-editor-cancel");
    const confirmBtn = doc.createElement("moz-button");
    confirmBtn.setAttribute("type", "primary");
    doc.l10n.setAttributes(confirmBtn, "tab-group-editor-done");
    footer.append(cancelBtn, confirmBtn);
    body.appendChild(footer);

    panel.appendChild(body);
    popupSet.appendChild(panel);

    cancelBtn.addEventListener("command", () => panel.hidePopup());
    confirmBtn.addEventListener("command", () => {
      const confirmed = [];
      for (const state of groupState) {
        const tabs = [...state.selected];
        if (tabs.length < lazy.minTabsPerGroup) {
          continue;
        }
        confirmed.push({ label: state.labelInput.value.trim(), tabs });
      }
      panel.hidePopup();
      if (confirmed.length) {
        this._createGroups(win, confirmed);
      }
    });

    panel.addEventListener("popuphidden", () => panel.remove(), { once: true });

    panel.openPopup(anchor, { position: "bottomright topright" });
  },

  /**
   * Create mode (and post-accept): show a one-click undo, plus "Group more"
   * when additional clusterable tabs remain.
   *
   * @param {ChromeWindow} win
   * @param {object[]} createdGroups
   */
  _showUndoBar(win, createdGroups) {
    const box = win.gNotificationBox;
    if (!box) {
      return;
    }
    const tabCount = createdGroups.reduce((n, g) => n + g.tabs.length, 0);

    const buttons = [
      {
        label: "Undo",
        callback: () => {
          for (const group of createdGroups) {
            if (group.parentNode) {
              group.ungroupTabs();
            }
          }
          return false;
        },
      },
    ];

    if (this._moreAvailable) {
      buttons.push({
        label: "Group more",
        callback: () => {
          // Re-run on whatever is still ungrouped.
          this._offeredWindows.delete(win);
          this.maybeAutoGroup(win, "switch");
          return false;
        },
      });
    }

    box.appendNotification(
      NOTIFICATION_VALUE,
      {
        label: `Grouped ${tabCount} tabs into ${createdGroups.length} group${
          createdGroups.length > 1 ? "s" : ""
        }.`,
        priority: box.PRIORITY_INFO_MEDIUM,
      },
      buttons
    );
  },
};
