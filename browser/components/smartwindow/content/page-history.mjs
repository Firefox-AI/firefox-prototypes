/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  LitElement,
  html,
  css,
} from "chrome://global/content/vendor/lit.all.mjs";

/**
 * Page History Overlay Component
 */
export class PageHistoryOverlay extends LitElement {
  static properties = {
    isOpen: { type: Boolean },
    historyItems: { type: Array },
    searchQuery: { type: String },
    isLoading: { type: Boolean },
    error: { type: String }
  };

  constructor() {
    super();
    this.isOpen = false;
    this.historyItems = [];
    this.searchQuery = "";
    this.error = null;
  }

  get filteredItems() {
    // Ensure historyItems is always an array
    const items = Array.isArray(this.historyItems) ? this.historyItems : [];

    console.warn("[PageHistory] filteredItems getter called", {
      historyItemsLength: items.length,
      searchQuery: this.searchQuery,
      historyItemsType: typeof this.historyItems,
      isArray: Array.isArray(this.historyItems)
    });

    if (!this.searchQuery || !this.searchQuery.trim()) {
      return items;
    }

    const lowerQuery = this.searchQuery.toLowerCase();
    const filtered = items.filter(item => {
      return (
        item.title?.toLowerCase().includes(lowerQuery) ||
        item.url?.toLowerCase().includes(lowerQuery)
      );
    });

    console.warn("[PageHistory] Filtered results:", {
      originalCount: items.length,
      filteredCount: filtered.length,
      searchQuery: lowerQuery
    });

    return filtered;
  }

  handleSearch(event) {
    this.searchQuery = event.target.value;
  }

  handleClose() {
    this.dispatchEvent(new CustomEvent("close", {
      bubbles: true,
      composed: true
    }));
  }

  handleItemClick(item) {
    this.dispatchEvent(new CustomEvent("item-selected", {
      detail: item,
      bubbles: true,
      composed: true
    }));
  }

  handleOverlayClick(event) {
    if (event.target === event.currentTarget) {
      this.handleClose();
    }
  }

  renderHistoryItem(item) {
    // Format visit date
    const formatVisitDate = (visitDate) => {
      if (!visitDate) {
        return "";
      };
      const date = typeof visitDate === "string" ? new Date(visitDate) : new Date(visitDate);
      const now = new Date();
      const diff = now - date;
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);

      if (hours < 1) {
        return "just now";
      }
      if (hours < 24) {
        return `${hours}h ago`;
      }
      if (days === 1) {
        return "yesterday";
      }
      if (days < 7) {
        return `${days}d ago`;
      }
      return date.toLocaleDateString();
    };

    return html`
      <div
        class="history-item"
        @click=${() => this.handleItemClick(item)}
        title=${item.url}
      >
        <div class="item-title-container">
          ${item.favicon ? html`
            <img class="favicon" src=${item.favicon} alt="" onerror="this.style.display='none'">
          ` : ''}
          <div class="history-title">${item.title || item.url}</div>
        </div>
        <div class="item-thumbnail">
          ${item.thumbnail ? html`
            <img class="thumbnail-image" src=${item.thumbnail} alt="">
          ` : html`
            <div class="thumbnail-placeholder">→</div>
          `}
        </div>
        ${(item.visitDate || item.visitCount) ? html`
          <div class="item-info">
            ${item.visitDate ? html`
              <span class="visit-date">${formatVisitDate(item.visitDate)}</span>
            ` : ''}
            ${item.visitCount ? html`
              <span class="visit-count">${item.visitCount} ${item.visitCount === 1 ? 'visit' : 'visits'}</span>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }

  renderContent() {
    if (this.error) {
      return html`<div class="error-message">Error: ${this.error}</div>`;
    }

    const filteredItems = this.filteredItems;

    // Safety check to ensure filteredItems is an array
    if (!Array.isArray(filteredItems) || filteredItems.length === 0) {
      return html`
        <div class="empty-state">
          ${this.searchQuery
            ? html`<p>No history items match your search.</p>`
            : html`<p>No history items found.</p>
                <p class="empty-hint">
                  Browse some websites to see your history here.
                </p>`}
        </div>
      `;
    }

    return html`
      <div class="history-grid">
        ${filteredItems.map(item => this.renderHistoryItem(item))}
      </div>
    `;
  }

  render() {
    if (!this.isOpen) {
      return html``;
    }

    return html`
      <div class="history-overlay" @click=${this.handleOverlayClick}>
        <div class="history-modal" @click=${e => e.stopPropagation()}>
          <div class="history-header">
            <h3>Pages from History (${this.historyItems.length})</h3>
            <button class="close-btn" @click=${this.handleClose}>×</button>
          </div>
          <div class="search-container">
            <input
              type="text"
              class="search-input"
              placeholder="Search history..."
              @input=${this.handleSearch}
              .value=${this.searchQuery}
            />
          </div>
          <div class="history-content">
            ${this.renderContent()}
          </div>
        </div>
      </div>
    `;
  }

  static styles = css`
    .history-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .history-modal {
      background: white;
      border-radius: 8px;
      max-width: 920px;
      max-height: 80vh;
      width: 90%;
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
    }

    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid #e0e0e0;
      background: #f8f9fa;
    }

    .history-header h3 {
      margin: 0;
      color: #333;
      font-size: 1.25rem;
      font-weight: 600;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: #666;
      padding: 0;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      margin: 0;
    }

    .close-btn:hover {
      background: #e0e0e0;
    }

    .search-container {
      padding: 1rem 1.5rem;
      border-bottom: 1px solid #e0e0e0;
      background: white;
    }

    .search-input {
      width: 100%;
      padding: 0.75rem 1rem;
      border: 1px solid #d0d0d0;
      border-radius: 6px;
      font-size: 0.875rem;
      box-sizing: border-box;
    }

    .search-input:focus {
      outline: none;
      border-color: #0066cc;
      box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.1);
    }

    .history-content {
      flex: 1;
      overflow-y: auto;
      padding: 1rem 1.5rem;
      min-height: 300px;
    }

    .loading-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      padding: 3rem 1rem;
      color: #666;
      font-size: 0.875rem;
    }

    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid #e0e0e0;
      border-top-color: #0066cc;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .error-message {
      padding: 1rem;
      background: #fee;
      border-left: 4px solid #c00;
      color: #800;
      font-size: 0.875rem;
      border-radius: 4px;
      margin: 1rem 0;
    }

    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: #666;
    }

    .empty-state p {
      margin: 0.5rem 0;
    }

    .empty-hint {
      font-size: 0.875rem;
      color: #999;
    }

    .history-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.5rem;
    }

    .history-item {
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-width: 0;
      overflow: hidden;
    }

    .history-item:hover {
      transform: translateY(-2px);
    }

    .item-thumbnail {
      width: 100%;
      aspect-ratio: 16 / 9;
      border-radius: 8px;
      background: linear-gradient(45deg, rgba(191, 143, 204, 0.15) 0%, rgba(191, 143, 204, 0.35) 100%), rgb(255, 255, 255);
      overflow: hidden;
      box-shadow: var(--box-shadow-level-1-shadow-1-x, 0) var(--box-shadow-level-1-shadow-1-y, 0) var(--box-shadow-level-1-shadow-1-blur, 1px) var(--box-shadow-level-1-shadow-1-spread, 0) var(--box-shadow-level-1-shadow-1-color, rgba(0, 0, 0, 0.15)), var(--box-shadow-level-1-shadow-2-x, 0) var(--box-shadow-level-1-shadow-2-y, 1px) var(--box-shadow-level-1-shadow-2-blur, 2px) var(--box-shadow-level-1-shadow-2-spread, 0) var(--box-shadow-level-1-shadow-2-color, rgba(0, 0, 0, 0.20));
    }

    .thumbnail-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .thumbnail-placeholder {
      width: 100%;
      height: 100%;
      background: linear-gradient(45deg, rgba(191, 143, 204, 0.15) 0%, rgba(191, 143, 204, 0.35) 100%), rgb(255, 255, 255);
      display: flex;
      align-items: center;
      color: #fff;
      justify-content: center;
      font-size: 2.5rem;
    }

    .item-info {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: #666;
      padding: 0 4px;
    }

    .visit-date {
      color: #666;
    }

    .visit-count {
      color: #999;
    }

    .visit-date::after {
      content: "•";
      margin-left: 0.5rem;
      color: #ccc;
    }

    .visit-count:last-child .visit-date::after {
      display: none;
    }

    .item-title-container {
      display: inline-flex;
      height: 26px;
      padding: 0 8px;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
      border-radius: 18px;
      border: 0.5px solid rgba(243, 238, 226, 0.50);
      background: #FFF;
      box-shadow: var(--box-shadow-level-1-shadow-1-x, 0) var(--box-shadow-level-1-shadow-1-y, 0) var(--box-shadow-level-1-shadow-1-blur, 1px) var(--box-shadow-level-1-shadow-1-spread, 0) var(--box-shadow-level-1-shadow-1-color, rgba(0, 0, 0, 0.15)), var(--box-shadow-level-1-shadow-2-x, 0) var(--box-shadow-level-1-shadow-2-y, 1px) var(--box-shadow-level-1-shadow-2-blur, 2px) var(--box-shadow-level-1-shadow-2-spread, 0) var(--box-shadow-level-1-shadow-2-color, rgba(0, 0, 0, 0.20));
      max-width: 100%;
      min-width: 0;
    }

    .history-title {
      font-weight: 500;
      color: #333;
      font-size: 0.875rem;
      line-height: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .favicon {
      width: 16px;
      height: 16px;
      margin-right: 6px;
      border-radius: 2px;
      flex-shrink: 0;
    }
  `;
}

customElements.define("page-history-overlay", PageHistoryOverlay);
