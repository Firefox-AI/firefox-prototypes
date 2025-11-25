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
  static LAZY_LOAD_DELAY = 300;

  static properties = {
    isOpen: { type: Boolean },
    historyItems: { type: Array },
    isLoading: { type: Boolean },
    error: { type: String },
  };

  constructor() {
    super();
    this.isOpen = false;
    this._historyItems = [];
    this.error = null;
    this._pendingTimeouts = new Set();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._observer) {
      this._observer.disconnect();
    }
    this._pendingTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
    this._pendingTimeouts.clear();
  }

  updated(changedProperties) {
    super.updated(changedProperties);

    if (
      changedProperties.has("historyItems") ||
      changedProperties.has("isOpen")
    ) {
      if (this._observer) {
        this._observer.disconnect();
      }

      this._pendingTimeouts.forEach(timeoutId => clearTimeout(timeoutId));
      this._pendingTimeouts.clear();

      if (this.isOpen) {
        this.handleLazyLoad();
      }
    }
  }

  set historyItems(value) {
    const oldValue = this._historyItems;
    this._historyItems = Array.isArray(value) ? [...value] : [];
    this.requestUpdate("historyItems", oldValue);
  }

  get historyItems() {
    return this._historyItems || [];
  }

  handleClose() {
    this.dispatchEvent(
      new CustomEvent("history-grid-close", {
        bubbles: true,
        composed: true,
      })
    );
  }

  handleItemClick(item) {
    this.dispatchEvent(
      new CustomEvent("item-selected", {
        detail: item,
        bubbles: true,
        composed: true,
      })
    );
  }

  handleOverlayClick(event) {
    if (event.target === event.currentTarget) {
      this.handleClose();
    }
  }

  handleThumbnailError(event) {
    event.target.style.display = "none";

    const container = event.target.parentElement;
    const skeleton = container.querySelector(".skeleton-loading-container");
    if (skeleton) {
      skeleton.style.display = "none";
    }

    const placeholder = document.createElement("div");
    placeholder.className = "thumbnail-placeholder loaded";
    placeholder.textContent = "→";
    container.appendChild(placeholder);
  }

  handleLazyLoad() {
    if (!this.isOpen) {
      return;
    }

    const options = {
      root: this.shadowRoot.querySelector(".history-content"),
      rootMargin: "100px",
      threshold: 0.01,
    };

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const thumbnail = entry.target;

          const img = thumbnail.querySelector("img[data-lazy]");
          if (img) {
            const dataSrc = img.getAttribute("data-lazy");
            if (dataSrc) {
              const timeoutId = setTimeout(() => {
                img.src = dataSrc;
                img.removeAttribute("data-lazy");
              }, PageHistoryOverlay.LAZY_LOAD_DELAY);

              this._pendingTimeouts.add(timeoutId);
            }
          }

          const placeholder = thumbnail.querySelector(".thumbnail-placeholder");
          if (placeholder) {
            const timeoutId = setTimeout(() => {
              placeholder.classList.add("loaded");
            }, PageHistoryOverlay.LAZY_LOAD_DELAY);

            this._pendingTimeouts.add(timeoutId);
          }

          observer.unobserve(thumbnail);
        }
      });
    }, options);

    const thumbnails = this.shadowRoot.querySelectorAll(".item-thumbnail");
    thumbnails.forEach(thumb => observer.observe(thumb));

    this._observer = observer;
  }

  renderSkeletonLoader() {
    return html`
      <div class="skeleton-wrapper">
        <div class="skeleton-bg"></div>
        <div class="skeleton-content">
          <div class="skeleton-rect skeleton-rect--1"></div>
          <div class="skeleton-rect skeleton-rect--2"></div>
          <div class="skeleton-rect skeleton-rect--3"></div>
          <div class="skeleton-rect skeleton-rect--4"></div>
          <div class="skeleton-rect skeleton-rect--5"></div>
        </div>
      </div>
    `;
  }

  renderHistoryItem(item) {
    // Format visit date
    const formatVisitDate = visitDate => {
      if (!visitDate) {
        return "";
      }
      const date =
        typeof visitDate === "string"
          ? new Date(visitDate)
          : new Date(visitDate);
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

    const previewType =
      item.previewType || (item.thumbnail ? "thumbnail" : null);

    return html`
      <div
        class="history-item"
        @click=${() => this.handleItemClick(item)}
        title=${item.url}
      >
        <div class="item-title-container">
          ${item.favicon
            ? html`
                <img
                  class="favicon"
                  src=${item.favicon}
                  alt=""
                  onerror="this.style.display='none'"
                />
              `
            : ""}
          <div class="history-title">${item.title || item.url}</div>
        </div>
        <div
          class="item-thumbnail ${previewType === "wireframe"
            ? "is-wireframe"
            : ""}"
        >
          <div class="skeleton-loading-container">
            ${this.renderSkeletonLoader()}
          </div>
          ${item.thumbnail
            ? html`
                <img
                  class="thumbnail-image skeleton-target ${previewType ===
                  "wireframe"
                    ? "wireframe"
                    : ""}"
                  data-lazy=${item.thumbnail}
                  alt=${previewType === "wireframe" ? "Wireframe preview" : ""}
                  decoding="async"
                  @load=${e => e.target.classList.add("loaded")}
                  @error=${e => this.handleThumbnailError(e)}
                />
              `
            : html`<div class="thumbnail-placeholder skeleton-target">→</div>`}
        </div>
        ${item.visitDate || item.visitCount
          ? html`
              <div class="item-info">
                ${item.visitDate
                  ? html`
                      <span class="visit-date"
                        >${formatVisitDate(item.visitDate)}</span
                      >
                    `
                  : ""}
                ${item.visitCount
                  ? html`
                      <span class="visit-count"
                        >${item.visitCount}
                        ${item.visitCount === 1 ? "visit" : "visits"}</span
                      >
                    `
                  : ""}
              </div>
            `
          : ""}
      </div>
    `;
  }

  renderContent() {
    if (this.error) {
      return html`<div class="error-message">Error: ${this.error}</div>`;
    }

    const historyItems = Array.isArray(this.historyItems)
      ? this.historyItems
      : [];

    if (historyItems.length === 0) {
      return html`
        <div class="empty-state">
          <p>No history items found.</p>
          <p class="empty-hint">
            Browse some websites to see your history here.
          </p>
        </div>
      `;
    }

    return html`
      <div class="history-grid">
        ${historyItems.map(item => this.renderHistoryItem(item))}
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
          <div class="history-content">${this.renderContent()}</div>
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
      background: var(--smart-window-gradient);
      border: 1px solid #eab2f7;
      border-radius: 8px 8px 0 0;
      display: flex;
      padding: 5rem 2.5rem 2.5rem;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .history-modal {
      height: 100%;
      width: 100%;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .history-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.5rem;
      position: relative;
    }

    .history-header::before {
      content: "";
      opacity: 0.5;
      background: linear-gradient(
        90deg,
        rgba(0, 0, 0, 0.5) 0%,
        rgba(0, 0, 0, 0) 40%,
        rgba(0, 0, 0, 0) 60%,
        rgba(0, 0, 0, 0.5) 100%
      );
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      height: 1px;
      width: calc(100% - 4rem);
    }

    .history-header h3 {
      margin: 0;
      color: #333;
      font-size: 15px;
      font-weight: 600;
      width: 100%;
      text-align: center;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 2rem;
      cursor: pointer;
      color: #333;
      padding: 0;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      margin: 0;
      position: fixed;
      right: 1.5rem;
      top: 1.5rem;
    }

    .close-btn:hover {
      background: #e0e0e0;
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
      background: #fff;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      box-shadow:
        var(--box-shadow-level-1-shadow-1-x, 0)
          var(--box-shadow-level-1-shadow-1-y, 0)
          var(--box-shadow-level-1-shadow-1-blur, 1px)
          var(--box-shadow-level-1-shadow-1-spread, 0)
          var(--box-shadow-level-1-shadow-1-color, rgba(0, 0, 0, 0.15)),
        var(--box-shadow-level-1-shadow-2-x, 0)
          var(--box-shadow-level-1-shadow-2-y, 1px)
          var(--box-shadow-level-1-shadow-2-blur, 2px)
          var(--box-shadow-level-1-shadow-2-spread, 0)
          var(--box-shadow-level-1-shadow-2-color, rgba(0, 0, 0, 0.2));
    }

    .item-thumbnail.is-wireframe {
      background: #f4f4f5;
    }

    .thumbnail-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .thumbnail-image.wireframe {
      object-fit: contain;
      padding: 0.75rem;
      background: transparent;
    }

    .thumbnail-placeholder {
      width: 100%;
      height: 100%;
      background: #fff;
      display: flex;
      align-items: center;
      color: #666;
      justify-content: center;
      font-size: 2.5rem;
    }

    /* Skeleton structure */
    .skeleton-loading-container {
      inset: 0;
      opacity: 1;
      position: absolute;
      pointer-events: none;
      transition: opacity 0.3s ease;
      z-index: 2;
    }

    .skeleton-target {
      opacity: 0;
      position: absolute;
      inset: 0;
      transition: opacity 0.3s ease;
      z-index: 2;
    }

    .skeleton-target.loaded {
      opacity: 1;
    }

    .item-thumbnail:has(.skeleton-target.loaded) .skeleton-loading-container {
      opacity: 0;
    }

    .skeleton-wrapper {
      border-radius: 8px;
      padding: 10px 10px 15px;
      position: relative;
      overflow: hidden;
      width: 100%;
      height: 100%;
    }

    .skeleton-wrapper .skeleton-bg {
      animation: bgPulse 2.5s ease-in-out infinite;
      background: #f1e7f8;
      inset: 0;
      position: absolute;
    }

    .skeleton-wrapper .skeleton-content {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .skeleton-rect {
      background: #c7b2ff;
      border-radius: 4px;
      min-height: 10px;
      height: 7%;
      opacity: 0.15;
      animation: rectPulse 2.5s ease-in-out infinite;
    }

    .skeleton-rect--1 {
      animation-delay: 0s;
      margin-bottom: 10px;
      width: 95%;
      min-height: 100px;
      height: 40%;
    }

    .skeleton-rect--2 {
      animation-delay: 0.3s;
      width: 59%;
    }

    .skeleton-rect--3 {
      animation-delay: 0.5s;
      width: 68%;
    }

    .skeleton-rect--4 {
      animation-delay: 0.7s;
      width: 53%;
    }

    .skeleton-rect--5 {
      animation-delay: 0.9s;
      width: 59%;
    }

    @keyframes bgPulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.7;
      }
    }

    @keyframes rectPulse {
      0%,
      100% {
        opacity: 0.15;
      }
      50% {
        opacity: 0.45;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .skeleton-loading-container,
      .skeleton-target {
        transition: none;
      }

      .skeleton-bg,
      .skeleton-rect {
        animation: none;
        opacity: 0.25;
      }
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
      border: 0.5px solid rgba(243, 238, 226, 0.5);
      background: #fff;
      box-shadow:
        var(--box-shadow-level-1-shadow-1-x, 0)
          var(--box-shadow-level-1-shadow-1-y, 0)
          var(--box-shadow-level-1-shadow-1-blur, 1px)
          var(--box-shadow-level-1-shadow-1-spread, 0)
          var(--box-shadow-level-1-shadow-1-color, rgba(0, 0, 0, 0.15)),
        var(--box-shadow-level-1-shadow-2-x, 0)
          var(--box-shadow-level-1-shadow-2-y, 1px)
          var(--box-shadow-level-1-shadow-2-blur, 2px)
          var(--box-shadow-level-1-shadow-2-spread, 0)
          var(--box-shadow-level-1-shadow-2-color, rgba(0, 0, 0, 0.2));
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
