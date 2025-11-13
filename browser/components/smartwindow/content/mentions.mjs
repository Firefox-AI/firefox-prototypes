/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { floatingUI } from "chrome://browser/content/smartwindow/tiptap-bundle.js";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NonPrivateTabs: "resource:///modules/OpenTabs.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

/**
 *
 */
export class MentionDropdown {
  constructor() {
    this.element = null;
    this.items = [];
    this.selectedIndex = 0;
    this.onSelectCallback = null;
    this.tabBatchSize = 5;
    this.visibleTabsCount = this.tabBatchSize;
    this.scrollerEl = null;
  }

  create(items, onSelect) {
    this.items = items;
    this.selectedIndex = 0;
    this.onSelectCallback = onSelect;

    this.element = document.createElement("div");
    this.element.className = "mention-list";
    this.render();

    this.element.addEventListener("click", e => {
      const item = e.target.closest(".mention-item");
      if (item) {
        const index = parseInt(item.dataset.index);
        this.selectItem(index);
      }
    });

    document.body.appendChild(this.element);
    return this.element;
  }

  render() {
    if (!this.element) {
      return;
    }

    this.element.innerHTML = "";

    // Group items by type
    const tabs = this.items.filter(item => item.type === "tab");
    const history = this.items.filter(item => item.type === "history");

    let itemIndex = 0;

    // Show empty state
    if (this.items.length === 0) {
      const emptyState = document.createElement("div");
      emptyState.className = "mention-section-header";
      emptyState.textContent = "No tabs or pages found";
      this.element.appendChild(emptyState);
      return;
    }

    // Render tabs section
    if (tabs.length) {
      const tabHeader = document.createElement("div");
      tabHeader.className = "mention-section-header";
      tabHeader.textContent = "Tabs";
      this.element.appendChild(tabHeader);

      if (!this.scrollerEl) {
        this.scrollerEl = document.createElement("div");
        this.scrollerEl.className = "mention-list__scroller";
      }
      const scroller = this.scrollerEl;
      this.element.appendChild(scroller);

      scroller.innerHTML = "";

      const batchSize = this.tabBatchSize;

      const initialEnd = Math.min(tabs.length, this.visibleTabsCount);
      for (let i = 0; i < initialEnd; i++) {
        const row = this.createMentionItem(tabs[i], itemIndex);
        scroller.appendChild(row);
        itemIndex++;
      }

      if (this.visibleTabsCount < tabs.length) {
        const moreRow = document.createElement("button");
        moreRow.type = "button";
        moreRow.className = "mention-item mention-view-more";
        moreRow.setAttribute("aria-label", "View more tabs");
        moreRow.innerHTML = `
        <span class="mention-view-more__icon" aria-hidden="true">
          <svg width="12" height="2" viewBox="0 0 12 2" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 2H0V0H2V2Z" fill="black"/>
            <path d="M7 2H5V0H7V2Z" fill="black"/>
            <path d="M12 0V2H10V0H12Z" fill="black"/>
          </svg>
        </span>
        <span>View more tabs</span>
      `;

        moreRow.addEventListener("click", e => {
          e.preventDefault();
          e.currentTarget.blur();

          const start = this.visibleTabsCount;
          this.visibleTabsCount += batchSize;

          moreRow.remove();

          const end = Math.min(this.visibleTabsCount, tabs.length);
          for (let i = start; i < end; i++) {
            const row = this.createMentionItem(tabs[i], itemIndex);
            scroller.appendChild(row);
            itemIndex++;
          }

          if (this.visibleTabsCount < tabs.length) {
            scroller.appendChild(moreRow);
          }
        });

        scroller.appendChild(moreRow);
      }
    }

    // Render history section
    if (history.length) {
      const historyHeader = document.createElement("div");
      historyHeader.className = "mention-section-header";
      historyHeader.textContent = "History";
      this.element.appendChild(historyHeader);

      history.forEach(item => {
        const div = this.createMentionItem(item, itemIndex);
        this.element.appendChild(div);
        itemIndex++;
      });
    }
  }

  createMentionItem(item, index) {
    const div = document.createElement("div");
    div.className = "mention-item";
    if (index === this.selectedIndex) {
      div.classList.add("is-selected");
    }
    div.dataset.index = index;

    // Create favicon/icon
    const icon = document.createElement("img");
    icon.className = "mention-icon";
    if (item.favicon) {
      icon.src = item.favicon;
    } else {
      icon.src = `page-icon:${item.url}`;
    }
    icon.onerror = () => {
      // Fallback to generic icon if favicon fails
      icon.style.display = "none";
    };

    // Create text container
    const textContainer = document.createElement("div");
    textContainer.className = "mention-text";

    const title = document.createElement("div");
    title.className = "mention-title";
    title.textContent = item.label;

    textContainer.appendChild(title);

    div.appendChild(icon);
    div.appendChild(textContainer);

    return div;
  }

  update(items) {
    this.items = items;
    this.selectedIndex = Math.min(this.selectedIndex, items.length - 1);
    this.render();
  }

  updatePosition(rect) {
    if (!this.element) {
      return;
    }

    const virtualEl = {
      getBoundingClientRect: () => rect,
    };

    floatingUI
      .computePosition(virtualEl, this.element, {
        placement: "bottom-start",
        middleware: [
          floatingUI.flip({
            fallbackPlacements: ["top-start", "bottom-end", "top-end"],
          }),
          floatingUI.shift({
            padding: 4,
            crossAxis: false,
          }),
          floatingUI.size({
            apply({ availableWidth, availableHeight, elements }) {
              Object.assign(elements.floating.style, {
                maxWidth: `${Math.min(400, availableWidth)}px`,
                maxHeight: `${Math.min(320, availableHeight)}px`,
                overflowY:
                  availableHeight < elements.floating.scrollHeight
                    ? "auto"
                    : "visible",
              });
            },
          }),
        ],
      })
      .then(({ x, y }) => {
        Object.assign(this.element.style, {
          position: "absolute",
          left: `${x}px`,
          top: `${y}px`,
        });
      });
  }

  selectNext() {
    this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
    this.render();
    this.scrollToSelected();
  }

  selectPrevious() {
    this.selectedIndex =
      (this.selectedIndex - 1 + this.items.length) % this.items.length;
    this.render();
    this.scrollToSelected();
  }

  selectItem(index = this.selectedIndex) {
    if (index >= 0 && index < this.items.length) {
      this.onSelectCallback?.(this.items[index]);
      return true;
    }
    return false;
  }

  scrollToSelected() {
    const selected = this.element?.querySelector(".is-selected");
    if (selected) {
      selected.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }

  handleKeyDown(event) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.selectPrevious();
      return true;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.selectNext();
      return true;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      return this.selectItem();
    }

    return false;
  }

  destroy() {
    this.element?.remove();
    this.element = null;
  }
}

// Helper function to filter out internal URLs
function isValidUrl(url) {
  return (
    url &&
    !url.startsWith("about:") &&
    !url.startsWith("chrome:") &&
    !url.startsWith("moz-extension:") &&
    !url.startsWith("resource:") &&
    url !== "about:blank"
  );
}

// Get mention suggestions from tabs and history
export async function getMentionSuggestions(query) {
  const suggestions = [];
  const lowerQuery = query.toLowerCase();

  // Get open tabs
  try {
    const allTabs = lazy.NonPrivateTabs.getRecentTabs();
    for (const tab of allTabs) {
      const browser = tab.linkedBrowser;
      const url = browser?.currentURI?.spec || "";
      const title = tab.label || "";

      if (!isValidUrl(url)) {
        continue;
      }

      // Match query
      if (
        !query ||
        title.toLowerCase().includes(lowerQuery) ||
        url.toLowerCase().includes(lowerQuery)
      ) {
        suggestions.push({
          id: url,
          label: title || url,
          type: "tab",
          url,
          favicon: tab.image || `page-icon:${url}`,
        });
      }
    }
  } catch (ex) {
    console.error("Error getting tabs:", ex);
  }

  // If we don't have enough suggestions, add from history
  if (suggestions.length < 5 && query) {
    try {
      const db = await lazy.PlacesUtils.promiseLargeCacheDBConnection();
      const sql = `SELECT h.url, h.title, h.guid
        FROM moz_places h
        JOIN moz_historyvisits v ON v.place_id = h.id
        WHERE (h.url LIKE :query OR h.title LIKE :query)
        AND h.hidden = 0
        GROUP BY h.url
        ORDER BY MAX(v.visit_date) DESC
        LIMIT :limit`;

      const rows = await db.executeCached(sql, {
        query: `%${query}%`,
        limit: 5 - suggestions.length,
      });

      for (const row of rows) {
        const url = row.getResultByName("url");
        const title = row.getResultByName("title");
        if (isValidUrl(url)) {
          suggestions.push({
            id: url,
            label: title || url,
            type: "history",
            url,
          });
        }
      }
    } catch (ex) {
      console.error("Error searching history:", ex);
    }
  }

  return suggestions;
}
