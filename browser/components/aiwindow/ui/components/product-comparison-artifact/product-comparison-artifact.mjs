/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const RATIONALE_MAX = 140;
const REVIEW_SUMMARY_MAX = 240;

function truncate(s, max) {
  if (typeof s !== "string") {
    return "";
  }
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function formatPrice(price) {
  if (!price || typeof price.amount !== "number") {
    return "—";
  }
  return `$${Math.round(price.amount).toLocaleString()}`;
}

function formatRating(rating) {
  if (!rating || typeof rating.value !== "number") {
    return null;
  }
  return rating;
}

export class ProductComparisonArtifact extends MozLitElement {
  static properties = {
    data: { type: Object, attribute: false },
    state: { type: String, attribute: false },
    expandedId: { type: String, state: true },
  };

  constructor() {
    super();
    this.data = null;
    this.state = "loading";
    this.expandedId = null;
  }

  updated(changed) {
    if (changed.has("data")) {
      if (!this.data) {
        this.state = "loading";
      } else if (this.data.error) {
        this.state = "error";
      } else if (
        !Array.isArray(this.data.products) ||
        this.data.products.length === 0
      ) {
        this.state = "empty";
      } else {
        this.state = "loaded";
      }
    }
  }

  #toggleExpand(id) {
    this.expandedId = this.expandedId === id ? null : id;
  }

  #onCardKeydown(event, id) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.#toggleExpand(id);
    }
    if (event.key === "Escape" && this.expandedId) {
      this.expandedId = null;
    }
  }

  #onRetry() {
    this.dispatchEvent(
      new CustomEvent("AIChatContent:DispatchFollowUp", {
        detail: { text: "Please retry the product comparison." },
        bubbles: true,
        composed: true,
      })
    );
  }

  #onOpenFullComparison() {
    if (!this.data) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("AIChatContent:OpenFullComparison", {
        detail: { data: this.data },
        bubbles: true,
        composed: true,
      })
    );
  }

  #renderLoading() {
    return html`
      <div class="pca-card" aria-busy="true">
        <div class="pca-header">
          <div class="pca-header-title">Comparing products…</div>
        </div>
        <div class="pca-list">
          ${[0, 1, 2].map(
            () => html`
              <div class="pca-product pca-skeleton-row">
                <div class="pca-image-wrap pca-skeleton-image"></div>
                <div class="pca-product-meta">
                  <div class="skeleton-block"></div>
                  <div class="skeleton-block short"></div>
                  <div class="skeleton-block"></div>
                </div>
              </div>
            `
          )}
        </div>
      </div>
    `;
  }

  #renderEmpty() {
    return html`
      <div class="pca-card">
        <div class="pca-empty-state">
          <div class="pca-empty-icon" aria-hidden="true">\u{1F50D}</div>
          <div class="pca-empty-title">No products found</div>
          <div class="pca-empty-subtext">
            Try broadening your search or adding a brand.
          </div>
        </div>
      </div>
    `;
  }

  #renderError() {
    const message =
      (this.data?.error && (this.data.error.message || this.data.error)) ||
      "Something went wrong. Please try again.";
    return html`
      <div class="pca-card">
        <div class="pca-error-state" role="alert" aria-live="assertive">
          <div class="pca-error-icon" aria-hidden="true">!</div>
          <div class="pca-error-label">Error</div>
          <div class="pca-error-title">Couldn't load comparison</div>
          <div class="pca-error-text">${String(message)}</div>
          <button class="pca-retry-btn" @click=${() => this.#onRetry()}>
            Try again
          </button>
        </div>
      </div>
    `;
  }

  #renderRating(rating) {
    const r = formatRating(rating);
    if (!r) {
      return html`<span class="pca-rating pca-rating-missing">—</span>`;
    }
    const stars = Math.round(r.value);
    const filled = "★".repeat(Math.max(0, Math.min(5, stars)));
    const empty = "☆".repeat(Math.max(0, 5 - stars));
    return html`
      <span class="pca-rating" aria-label="${r.value} out of 5 stars">
        <span class="pca-rating-stars" aria-hidden="true">${filled}${empty}</span>
        <span class="pca-rating-value">${r.value.toFixed(1)}</span>
        ${typeof r.count === "number"
          ? html`<span class="pca-rating-count">(${r.count})</span>`
          : nothing}
      </span>
    `;
  }

  #renderImage(product) {
    const fallback = html`
      <div class="pca-image-fallback" aria-hidden="true">
        <span class="pca-image-fallback-glyph">▢</span>
      </div>
    `;
    if (!product.imageUrl) {
      return fallback;
    }
    return html`
      <img
        class="pca-image"
        src=${product.imageUrl}
        alt=${`${product.brand || ""} ${product.name || "product"}`.trim()}
        loading="lazy"
        decoding="async"
        @error=${event => {
          event.target.replaceWith(
            (() => {
              const wrap = document.createElement("div");
              wrap.className = "pca-image-fallback";
              wrap.setAttribute("aria-hidden", "true");
              const glyph = document.createElement("span");
              glyph.className = "pca-image-fallback-glyph";
              glyph.textContent = "▢";
              wrap.appendChild(glyph);
              return wrap;
            })()
          );
        }}
      />
    `;
  }

  #renderSpecStrip(specs) {
    if (!Array.isArray(specs) || !specs.length) {
      return nothing;
    }
    const visible = specs.slice(0, 3);
    return html`
      <div class="pca-spec-strip">
        ${visible.map(
          s =>
            html`<span class="pca-spec-chip" title=${`${s.label}: ${s.value}`}>
              ${s.value}
            </span>`
        )}
      </div>
    `;
  }

  #renderExpanded(product) {
    return html`
      <div
        class="pca-product-expanded"
        id=${`pca-product-${product.id}-expanded`}
      >
        ${product.specs?.length
          ? html`
              <dl class="pca-spec-list">
                ${product.specs.map(
                  s => html`
                    <div class="pca-spec-row">
                      <dt class="pca-spec-label">${s.label}</dt>
                      <dd class="pca-spec-value">${s.value}</dd>
                    </div>
                  `
                )}
              </dl>
            `
          : nothing}
        ${product.reviewSummary
          ? html`
              <p class="pca-review-summary">
                ${truncate(product.reviewSummary, REVIEW_SUMMARY_MAX)}
              </p>
            `
          : nothing}
        ${(product.pros?.length || product.cons?.length)
          ? html`
              <div class="pca-pros-cons">
                ${product.pros?.length
                  ? html`
                      <div class="pca-pros">
                        <div class="pca-pros-cons-label">Pros</div>
                        <ul>
                          ${product.pros.map(p => html`<li>${p}</li>`)}
                        </ul>
                      </div>
                    `
                  : nothing}
                ${product.cons?.length
                  ? html`
                      <div class="pca-cons">
                        <div class="pca-pros-cons-label">Cons</div>
                        <ul>
                          ${product.cons.map(c => html`<li>${c}</li>`)}
                        </ul>
                      </div>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        <div class="pca-actions">
          <a
            class="pca-link"
            href=${product.productUrl}
            target="_blank"
            rel="noopener"
            @click=${event => {
              event.stopPropagation();
              this.dispatchEvent(
                new CustomEvent("AIChatContent:OpenLink", {
                  detail: { url: product.productUrl },
                  bubbles: true,
                  composed: true,
                })
              );
            }}
          >
            View product →
          </a>
        </div>
      </div>
    `;
  }

  #renderProductCard(product, isRecommended, expanded) {
    const expandedId = `pca-product-${product.id}-expanded`;
    return html`
      <article
        class=${`pca-product${
          isRecommended ? " pca-product--recommended" : ""
        }${expanded ? " pca-product--expanded" : ""}${
          product.pinned ? " pca-product--pinned" : ""
        }`}
      >
        ${isRecommended
          ? html`<div class="pca-recommend-strip">
              <span class="pca-recommend-label">Recommended</span>
            </div>`
          : nothing}
        <button
          class="pca-product-main"
          type="button"
          aria-expanded=${expanded ? "true" : "false"}
          aria-controls=${expandedId}
          @click=${() => this.#toggleExpand(product.id)}
          @keydown=${event => this.#onCardKeydown(event, product.id)}
        >
          ${this.#renderImage(product)}
          <div class="pca-product-meta">
            <div class="pca-name">${product.name || "—"}</div>
            <div class="pca-brand-retailer">
              <span class="pca-brand">${product.brand || "—"}</span>
              ${product.retailer
                ? html`<span class="pca-retailer">
                    · ${product.retailer}
                  </span>`
                : nothing}
              ${product.pinned
                ? html`<span class="pca-pinned-chip" title="AI-estimated from URL">
                    From your tab
                  </span>`
                : nothing}
            </div>
            <div class="pca-price-row">
              <span class="pca-price">${formatPrice(product.price)}</span>
              ${this.#renderRating(product.rating)}
            </div>
            ${this.#renderSpecStrip(product.specs)}
          </div>
          <span
            class=${`pca-disclosure${expanded ? " pca-disclosure--open" : ""}`}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
        ${isRecommended && this.data?.recommendationRationale
          ? html`
              <p class="pca-recommend-rationale">
                ${truncate(
                  this.data.recommendationRationale,
                  RATIONALE_MAX
                )}
              </p>
            `
          : nothing}
        ${product.pinned
          ? html`<p class="pca-pinned-caption">
              AI-estimated from URL — verify on the product page.
            </p>`
          : nothing}
        ${expanded ? this.#renderExpanded(product) : nothing}
      </article>
    `;
  }

  #renderLoaded() {
    const products = this.data.products || [];
    const recId = this.data.recommendationId;
    const refining = !!this.data.refining;
    return html`
      <div class="pca-card">
        <div class="pca-header">
          <div class="pca-header-title">
            ${products.length} pick${products.length === 1 ? "" : "s"}
            ${this.data.query
              ? html` for <span class="pca-query">${this.data.query}</span>`
              : nothing}
          </div>
          <div class="pca-header-meta">
            ${products.length} of up to 5
            ${refining
              ? html`<span class="pca-refining-pill" role="status" aria-live="polite">
                  <span class="pca-refining-spinner" aria-hidden="true"></span>
                  Updating…
                </span>`
              : nothing}
          </div>
        </div>
        <div
          class="pca-list"
          ?inert=${refining}
          aria-busy=${refining ? "true" : "false"}
        >
          ${products.map((p, idx) =>
            this.#renderProductCard(
              p,
              p.id === recId || (idx === 0 && !recId),
              this.expandedId === p.id
            )
          )}
        </div>
        <div class="pca-footer">
          <button
            class="pca-full-cta"
            type="button"
            @click=${() => this.#onOpenFullComparison()}
            title="Open the side-by-side comparison table in a new tab"
          >
            View full side-by-side comparison →
          </button>
          ${this.data?.searchSource && this.data.searchSource !== "web"
            ? html`<span class="pca-source-banner" role="note">
                ${this.data.searchSource === "canned-bike-seat"
                  ? "Web search returned no live results — showing curated bike-seat data."
                  : this.data.searchSource === "canned-earbuds"
                  ? "Web search returned no live results — showing curated earbuds data."
                  : "Web search returned no live results — showing AI-estimated picks."}
              </span>`
            : nothing}
        </div>
      </div>
    `;
  }

  render() {
    const cssLink = html`<link
      rel="stylesheet"
      href="chrome://browser/content/aiwindow/components/product-comparison-artifact.css"
    />`;

    if (this.state === "loading") {
      return html`${cssLink}${this.#renderLoading()}`;
    }
    if (this.state === "error") {
      return html`${cssLink}${this.#renderError()}`;
    }
    if (this.state === "empty") {
      return html`${cssLink}${this.#renderEmpty()}`;
    }
    if (!this.data) {
      return nothing;
    }
    return html`${cssLink}${this.#renderLoaded()}`;
  }
}

customElements.define(
  "product-comparison-artifact",
  ProductComparisonArtifact
);
