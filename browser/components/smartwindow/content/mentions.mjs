/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 *
 */
export class MentionDropdown {
  constructor() {
    this.element = null;
    this.items = [];
    this.selectedIndex = 0;
    this.onSelect = null;
  }

  create(items, onSelect) {
    this.items = items;
    this.onSelect = onSelect;
    this.selectedIndex = 0;

    this.element = document.createElement("div");
    this.element.className = "mention-list";
    this.render();
    document.body.appendChild(this.element);
  }

  render() {
    if (!this.element) {
      return;
    }

    this.element.innerHTML = "";

    this.items.forEach((item, index) => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "mention-item";
      if (index === this.selectedIndex) {
        itemDiv.classList.add("is-selected");
      }

      const textDiv = document.createElement("div");
      textDiv.className = "mention-text";

      const titleDiv = document.createElement("div");
      titleDiv.className = "mention-title";
      titleDiv.textContent = item.label;

      textDiv.appendChild(titleDiv);
      itemDiv.appendChild(textDiv);

      itemDiv.addEventListener("click", () => {
        if (this.onSelect) {
          this.onSelect(item);
        }
      });

      this.element.appendChild(itemDiv);
    });
  }

  update(items) {
    this.items = items;
    this.selectedIndex = 0;
    this.render();
  }

  updatePosition(rect) {
    if (!this.element || !rect) {
      return;
    }

    this.element.style.position = "absolute";
    this.element.style.top = `${rect.bottom + window.scrollY}px`;
    this.element.style.left = `${rect.left + window.scrollX}px`;
  }

  handleKeyDown(event) {
    if (event.key === "ArrowDown") {
      this.selectedIndex = Math.min(
        this.selectedIndex + 1,
        this.items.length - 1
      );
      this.render();
      return true;
    }

    if (event.key === "ArrowUp") {
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.render();
      return true;
    }

    if (event.key === "Enter") {
      if (this.onSelect && this.items[this.selectedIndex]) {
        this.onSelect(this.items[this.selectedIndex]);
      }
      return true;
    }

    if (event.key === "Escape") {
      this.destroy();
      return true;
    }

    return false;
  }

  destroy() {
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }
}

export async function getMentionSuggestions(query) {
  const { topChromeWindow } = window.browsingContext;

  if (!topChromeWindow?.gBrowser) {
    return [];
  }

  try {
    const allTabs = Array.from(topChromeWindow.gBrowser.tabs);
    const suggestions = [];

    for (const tab of allTabs) {
      const browser = topChromeWindow.gBrowser.getBrowserForTab(tab);
      const url = browser.currentURI.spec || "";

      // Filter out internal URLs
      if (
        url.startsWith("about:") ||
        url.startsWith("chrome:") ||
        url.startsWith("moz-extension:") ||
        url.startsWith("resource:")
      ) {
        continue;
      }

      const tabInfo = {
        id: tab.linkedPanel,
        label: tab.label || "Untitled",
        url,
        favicon: tab.image || "",
      };

      suggestions.push(tabInfo);
    }

    // Sort by last accessed (most recent first)
    suggestions.sort((a, b) => {
      const aTab = allTabs.find(t => t.linkedPanel === a.id);
      const bTab = allTabs.find(t => t.linkedPanel === b.id);
      const aTime = aTab?.lastAccessed || 0;
      const bTime = bTab?.lastAccessed || 0;
      return bTime - aTime;
    });

    // Filter by query if provided
    if (query) {
      const lowerQuery = query.toLowerCase();
      return suggestions
        .filter(
          item =>
            item.label.toLowerCase().includes(lowerQuery) ||
            item.url.toLowerCase().includes(lowerQuery)
        )
        .slice(0, 10);
    }

    return suggestions.slice(0, 10);
  } catch (error) {
    console.error("Error getting tab suggestions:", error);
    return [];
  }
}
