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

const PANEL_ID = "smartwindow-group-tabs-panel";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const PANEL_STYLE = `
  #${PANEL_ID} {
    --panel-padding: 0;
    --panel-background: transparent;
    --panel-border-color: transparent;
    --panel-shadow-margin: 0;
  }
  #${PANEL_ID} .swgt-container {
    display: flex;
    flex-direction: column;
    min-width: 340px;
    max-width: 420px;
    padding: 8px;
    background: #16151c;
    color: #fbfbfe;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  #${PANEL_ID} .swgt-header {
    margin: 0;
    padding: 12px 16px;
    font-size: 1.1em;
    font-weight: 700;
    text-align: center;
  }
  #${PANEL_ID} .swgt-body {
    display: flex;
    flex-direction: column;
  }
  #${PANEL_ID} .swgt-row {
    appearance: none;
    border: none;
    background: transparent;
    color: inherit;
    text-align: start;
    padding: 12px 16px;
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  #${PANEL_ID} .swgt-row:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  #${PANEL_ID} .swgt-row-title {
    font-size: 1.05em;
  }
  #${PANEL_ID} .swgt-row-primary .swgt-row-title {
    font-weight: 600;
  }
  #${PANEL_ID} .swgt-row-subtitle {
    font-size: 0.85em;
    opacity: 0.6;
  }
  #${PANEL_ID} .swgt-message {
    padding: 20px 16px;
    opacity: 0.7;
    text-align: center;
  }
  #${PANEL_ID} .swgt-footer {
    padding-top: 8px;
  }
  #${PANEL_ID} .swgt-undo {
    appearance: none;
    width: 100%;
    border: none;
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    padding: 12px;
    border-radius: 8px;
    cursor: pointer;
  }
  #${PANEL_ID} .swgt-undo:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
  }
  #${PANEL_ID} .swgt-undo:disabled {
    opacity: 0.4;
    cursor: default;
  }
`;

export const AutoTabGrouping = {
  _manager: null,

  /**
   * Groups created via the panel, per window, so "Undo all recent groups" can
   * reverse exactly what this feature created (and nothing the user made by
   * hand).
   *
   * @type {WeakMap<ChromeWindow, object[]>}
   */
  _createdGroups: new WeakMap(),

  /**
   * The panel currently in the DOM for a window, if any.
   *
   * @type {WeakMap<ChromeWindow, XULElement>}
   */
  _panels: new WeakMap(),

  get manager() {
    if (!this._manager) {
      this._manager = new lazy.SmartTabGroupingManager();
    }
    return this._manager;
  },

  /**
   * Toggle the "Group my tabs" panel from the toolbar button.
   *
   * @param {ChromeWindow} win - The Smart Window.
   */
  toggleGroupTabsPanel(win) {
    const existing = this._panels.get(win);
    if (existing) {
      existing.hidePopup();
      return;
    }
    this.showGroupTabsPanel(win).catch(e =>
      lazy.console.warn("showGroupTabsPanel failed", e)
    );
  },

  /**
   * Build the panel, show it, then populate it with suggested groups once the
   * clustering models have run.
   *
   * @param {ChromeWindow} win
   */
  async showGroupTabsPanel(win) {
    if (!win?.gBrowser || win.closed) {
      return;
    }
    const doc = win.document;
    const anchor = doc.getElementById("smartwindow-group-tabs-button");
    const popupSet = doc.getElementById("mainPopupSet");
    if (!anchor || !popupSet) {
      return;
    }

    const panel = this._buildPanelSkeleton(win);
    popupSet.appendChild(panel);
    this._panels.set(win, panel);
    panel.addEventListener(
      "popuphidden",
      () => {
        if (this._panels.get(win) === panel) {
          this._panels.delete(win);
        }
        panel.remove();
      },
      { once: true }
    );

    panel.openPopup(anchor, "after_end", 0, 4, false, false);

    this._setMessage(win, panel._body, "Finding groups…");

    const candidates = this._getCandidateTabs(win);
    let proposals = [];
    if (candidates.length >= lazy.minCandidateTabs) {
      try {
        proposals = await this._buildGroupProposals(win, candidates);
      } catch (e) {
        lazy.console.warn("Building group proposals failed", e);
      }
    }

    // The panel may have been closed (or replaced) while the models ran.
    if (this._panels.get(win) !== panel) {
      return;
    }

    panel._candidateCount = candidates.length;
    panel._remaining = proposals;
    this._renderBody(win, panel);
  },

  /**
   * @param {ChromeWindow} win
   * @returns {XULElement} A detached panel with its body/undo refs attached.
   */
  _buildPanelSkeleton(win) {
    const doc = win.document;

    const panel = doc.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("noautofocus", "true");
    panel.setAttribute("class", "panel-no-padding");

    const style = doc.createElementNS(HTML_NS, "style");
    style.textContent = PANEL_STYLE;
    panel.appendChild(style);

    const container = doc.createElementNS(HTML_NS, "div");
    container.className = "swgt-container";

    const header = doc.createElementNS(HTML_NS, "h1");
    header.className = "swgt-header";
    header.textContent = "Group my tabs";
    container.appendChild(header);

    const body = doc.createElementNS(HTML_NS, "div");
    body.className = "swgt-body";
    container.appendChild(body);

    const footer = doc.createElementNS(HTML_NS, "div");
    footer.className = "swgt-footer";
    const undoBtn = doc.createElementNS(HTML_NS, "button");
    undoBtn.className = "swgt-undo";
    undoBtn.type = "button";
    undoBtn.textContent = "Undo all recent groups";
    undoBtn.addEventListener("click", () => this._undoAll(win, panel));
    footer.appendChild(undoBtn);
    container.appendChild(footer);

    panel.appendChild(container);

    panel._body = body;
    panel._undoBtn = undoBtn;
    this._updateUndoButton(win, panel);
    return panel;
  },

  /**
   * (Re)render the body from panel._remaining. Called after every create/undo.
   *
   * @param {ChromeWindow} win
   * @param {XULElement} panel
   */
  _renderBody(win, panel) {
    const body = panel._body;
    body.textContent = "";

    const remaining = panel._remaining || [];
    if (!remaining.length) {
      let text;
      if (panel._createdAny) {
        text = "Tabs grouped. Undo below to reverse.";
      } else if (panel._candidateCount < lazy.minCandidateTabs) {
        text = "Open a few more tabs to get grouping suggestions.";
      } else {
        text = "No tab groups to suggest right now.";
      }
      this._setMessage(win, body, text);
      this._updateUndoButton(win, panel);
      return;
    }

    const groupAll = this._createRow(win, "Group all tabs", null);
    groupAll.classList.add("swgt-row-primary");
    groupAll.addEventListener("click", () => {
      this._createGroups(win, remaining);
      panel._createdAny = true;
      panel._remaining = [];
      this._renderBody(win, panel);
    });
    body.appendChild(groupAll);

    for (const proposal of remaining) {
      const label = proposal.label || "Untitled";
      const count = proposal.tabs.length;
      const row = this._createRow(
        win,
        `Create group '${label}'`,
        `Moves ${count} tab${count > 1 ? "s" : ""}`
      );
      row.addEventListener("click", () => {
        this._createGroups(win, [proposal]);
        panel._createdAny = true;
        panel._remaining = (panel._remaining || []).filter(p => p !== proposal);
        this._renderBody(win, panel);
      });
      body.appendChild(row);
    }

    this._updateUndoButton(win, panel);
  },

  _createRow(win, title, subtitle) {
    const doc = win.document;
    const row = doc.createElementNS(HTML_NS, "button");
    row.className = "swgt-row";
    row.type = "button";

    const titleEl = doc.createElementNS(HTML_NS, "span");
    titleEl.className = "swgt-row-title";
    titleEl.textContent = title;
    row.appendChild(titleEl);

    if (subtitle) {
      const subtitleEl = doc.createElementNS(HTML_NS, "span");
      subtitleEl.className = "swgt-row-subtitle";
      subtitleEl.textContent = subtitle;
      row.appendChild(subtitleEl);
    }
    return row;
  },

  _setMessage(win, body, text) {
    body.textContent = "";
    const msg = win.document.createElementNS(HTML_NS, "div");
    msg.className = "swgt-message";
    msg.textContent = text;
    body.appendChild(msg);
  },

  _updateUndoButton(win, panel) {
    if (panel._undoBtn) {
      panel._undoBtn.disabled = !this._createdGroups.get(win)?.length;
    }
  },

  /**
   * Ungroup every group this panel created in the window. Tabs stay open.
   *
   * @param {ChromeWindow} win
   * @param {XULElement} panel
   */
  _undoAll(win, panel) {
    const created = this._createdGroups.get(win) || [];
    for (const group of created) {
      if (group.parentNode) {
        group.ungroupTabs();
      }
    }
    this._createdGroups.set(win, []);
    this._updateUndoButton(win, panel);
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
      .sort((a, b) => b.tabs.length - a.tabs.length)
      .slice(0, lazy.maxGroups);
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
    return proposals;
  },

  /**
   * Creates the given proposals as tab groups, tracking them for undo.
   *
   * @param {ChromeWindow} win
   * @param {Array<{label: string, tabs: MozTabbrowserTab[]}>} proposals
   * @returns {object[]} The created group elements.
   */
  _createGroups(win, proposals) {
    const created = [];
    const windowTabs = new Set(win.gBrowser.tabs);
    for (const proposal of proposals) {
      // Tabs may have been closed/moved/grouped since clustering, so only keep
      // ungrouped tabs that still live in this window.
      const tabs = proposal.tabs.filter(
        t => !t.closing && !t.group && windowTabs.has(t)
      );
      if (tabs.length < lazy.minTabsPerGroup) {
        continue;
      }
      const group = win.gBrowser.addTabGroup(tabs, { label: proposal.label });
      if (group) {
        created.push(group);
      }
    }
    if (created.length) {
      const list = this._createdGroups.get(win) || [];
      list.push(...created);
      this._createdGroups.set(win, list);
    }
    return created;
  },
};
