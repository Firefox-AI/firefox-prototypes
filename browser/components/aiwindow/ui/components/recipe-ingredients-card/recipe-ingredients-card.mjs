/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/jev-trace-strip.mjs";

const BLOCKED_TEXT = {
  jev_blocked: "the agent couldn't find a way forward",
  no_progress: "three actions in a row changed nothing",
  consent_loop: "a consent dialog kept coming back",
  done_unverified: "it said it was done but no ingredient list was visible",
  budget: "it ran out of steps",
  seed_failed: "the search page didn't return results",
};

const SMART_WINDOW_ICON =
  "chrome://browser/content/aiwindow/assets/smart-window.svg";
const ERROR_ICON = "chrome://global/skin/icons/error.svg";

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function stripSiteSuffix(title) {
  if (!title) {
    return "";
  }
  return title
    .replace(/\s+[-|–—]\s+[^-|–—]+$/u, "")
    .trim();
}

function sentenceCase(text) {
  if (!text) {
    return "";
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Ingredient-list artifact for the `browse_and_extract` tool. Renders from
 * the tool result body (plus `progress` while loading) and mirrors every
 * render to the parent as a `recipe-card-snapshot` event (QA oracle, D13).
 *
 * @property {object} data - Tool result body / card properties
 */
export class RecipeIngredientsCard extends MozLitElement {
  static properties = {
    data: { type: Object },
    stopping: { type: Boolean, state: true },
  };

  constructor() {
    super();
    this.data = null;
    this.stopping = false;
  }

  get #state() {
    const status = this.data?.status;
    if (!this.data || !status || status === "running") {
      return "loading";
    }
    if (status === "done") {
      return "loaded";
    }
    if (status === "empty") {
      return "empty";
    }
    return "error";
  }

  get #reason() {
    const status = this.data?.status;
    if (status === "blocked") {
      return "blocked";
    }
    if (status === "cancelled") {
      return "cancelled";
    }
    if (status === "error") {
      return this.data?.reason ?? "network";
    }
    if (status === "done") {
      return this.data?.reason ?? null;
    }
    return null;
  }

  willUpdate() {
    const state = this.#state;
    const reason = this.#reason;
    this.dataset.state = state;
    if (reason) {
      this.dataset.reason = reason;
    } else {
      delete this.dataset.reason;
    }
    this.dataset.scaled = String(Boolean(this.data?.scaled));
    if (state !== "loading") {
      this.stopping = false;
    }
  }

  firstUpdated() {
    this.#snapshot();
  }

  updated() {
    this.#snapshot();
  }

  #snapshot() {
    const root = this.shadowRoot;
    if (!root) {
      return;
    }
    const text = (root.textContent || "").replace(/\s+/g, " ").trim().slice(0, 8000);
    const heading = root.querySelector(".card-title")?.textContent?.trim() ?? "";
    this.dispatchEvent(
      new CustomEvent("recipe-card-snapshot", {
        bubbles: true,
        composed: true,
        detail: {
          card_state: this.#state,
          card_reason: this.#reason,
          card_scaled: Boolean(this.data?.scaled),
          rendered_ingredient_count: root.querySelectorAll("li[data-ingredient]").length,
          card_text: text,
          card_heading: heading,
        },
      })
    );
  }

  #cancel() {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.dispatchEvent(
      new CustomEvent("recipe-card-cancel", {
        bubbles: true,
        composed: true,
        detail: {},
      })
    );
  }

  #openSource(event) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("recipe-card-open-source", {
        bubbles: true,
        composed: true,
        detail: { href: this.data?.source_url ?? null },
      })
    );
  }

  #title() {
    const d = this.data ?? {};
    switch (this.#state) {
      case "loading":
        return d.seed_query ? `Finding ${d.seed_query}` : "Browsing for your request";
      case "loaded":
        return (
          stripSiteSuffix(d.source_title) || sentenceCase(d.seed_query) || "Ingredients"
        );
      case "empty":
        return "No ingredient list on this page";
    }
    switch (this.#reason) {
      case "missing_key":
      case "invalid_args":
        return "Can't start the browsing agent";
      case "network":
        return "Couldn't reach Jev";
      case "blocked":
        return `Got stuck on ${hostOf(d.source_url) || "the page"}`;
      case "cancelled":
        return "Stopped";
      case "timeout":
        return "That took too long";
    }
    return "Something went wrong";
  }

  #statusLine() {
    const p = this.data?.progress ?? {};
    if (p.phase === "extracting") {
      return "Reading the recipe…";
    }
    if (p.phase === "browsing" && p.step > 0 && p.last_action) {
      return `Step ${p.step} · ${p.last_action}`;
    }
    if (p.phase === "browsing") {
      return "Starting…";
    }
    return "Opening a tab…";
  }

  #errorMessage() {
    const d = this.data ?? {};
    switch (this.#reason) {
      case "missing_key":
        return "Jev API key isn't configured for this profile. Launch with launch.sh (it reads ~/.firefox-prototype-secrets/jev-api-key) and try again.";
      case "invalid_args":
        return `Couldn't start: ${d.error_text || "the request was invalid"}.`;
      case "network":
        return `Couldn't reach Jev (${d.error_text || "connection failed"}). The tab is yours.`;
      case "blocked":
        return `I got stuck on ${hostOf(d.source_url) || "the page"}: ${BLOCKED_TEXT[d.reason] ?? d.reason ?? "it could not continue"}. The tab is yours.`;
      case "cancelled":
        return "Stopped. The tab is yours.";
      case "timeout": {
        const seconds = Math.round((d.timings?.total_elapsed_ms ?? 0) / 1000);
        return `Stopped after ${seconds} seconds without finding an ingredient list. The tab is yours.`;
      }
    }
    return `Something went wrong${d.error_text ? ` (${d.error_text})` : ""}. The tab is yours.`;
  }

  #servingsBlock() {
    const d = this.data ?? {};
    let line;
    if (d.scaled) {
      line = `Scaled from ${d.original_servings} servings to ${d.servings}`;
    } else if (Number.isInteger(d.original_servings) && !d.servings) {
      line = `Serves ${d.original_servings} as written`;
    } else {
      line = "Listed as written for the recipe's own servings";
    }
    return html`<p class="servings-line">${line}</p>
      ${d.servings_note
        ? html`<p class="servings-note">${d.servings_note}</p>`
        : nothing}`;
  }

  #ingredients() {
    const items = this.data?.ingredients ?? [];
    return html`<ol class="ingredients">
      ${items.map(
        i => html`<li
          data-ingredient
          data-corrected=${i.corrected ? "true" : "false"}
        >
          <div class="ingredient-main">
            <strong class="qty">${i.scaled_text}</strong>
            <span class="name">${i.name}</span>
            ${!i.scalable && i.note
              ? html`<span class="note-chip">${i.note}</span>`
              : nothing}
          </div>
          <span data-original>Recipe: ${i.original_text}</span>
        </li>`
      )}
    </ol>`;
  }

  #sourceRow() {
    const d = this.data ?? {};
    if (!d.source_url) {
      return nothing;
    }
    const label = d.source_title || hostOf(d.source_url) || d.source_url;
    return html`<div class="source-row">
      <img
        class="favicon"
        src=${`page-icon:${d.source_url}`}
        alt=""
        @error=${e => {
          e.target.src = SMART_WINDOW_ICON;
        }}
      />
      <a
        data-source
        href=${d.source_url}
        title=${d.source_url}
        @click=${this.#openSource}
        >${label}</a
      >
      <span class="open-in-new" aria-hidden="true"></span>
    </div>`;
  }

  #trace(live) {
    const d = this.data ?? {};
    const steps = d.trace ?? [];
    const elapsed = live
      ? Math.max(0, Date.now() - (this.#startedAt ?? Date.now()))
      : (d.timings?.loop_elapsed_ms ?? 0);
    return html`<jev-trace-strip
      .steps=${steps}
      .status=${live ? "running" : d.status}
      .reason=${d.reason ?? null}
      .elapsedMs=${elapsed}
      .reobserved=${d.reobserved ?? 0}
      .errorText=${d.error_text ?? ""}
    ></jev-trace-strip>`;
  }

  #startedAt = null;

  #renderLoading() {
    if (!this.#startedAt) {
      this.#startedAt = Date.now();
    }
    return html`
      <div class="card-header">
        <img class="card-icon" src=${SMART_WINDOW_ICON} alt="" />
        <h3 class="card-title" id="card-title" title=${this.#title()}>
          ${this.#title()}
        </h3>
        <moz-button
          class="cancel"
          type="ghost"
          size="small"
          ?disabled=${this.stopping}
          @click=${this.#cancel}
          >${this.stopping ? "Stopping…" : "Cancel"}</moz-button
        >
      </div>
      <div class="status-block">
        <p class="status-line" aria-live="polite">${this.#statusLine()}</p>
        <div class="progress" role="progressbar" aria-label="Browsing">
          <div class="progress-thumb"></div>
        </div>
        <p class="egress-line">
          Sending page details to Jev (TypeSafe) to decide each step.
        </p>
      </div>
      ${this.#trace(true)}
    `;
  }

  #renderLoaded() {
    return html`
      <div class="card-header">
        <img class="card-icon" src=${SMART_WINDOW_ICON} alt="" />
        <h3 class="card-title" id="card-title" title=${this.#title()}>
          ${this.#title()}
        </h3>
      </div>
      ${this.#servingsBlock()} ${this.#ingredients()} ${this.#sourceRow()}
      ${this.#trace(false)}
    `;
  }

  #renderEmpty() {
    return html`
      <div class="card-header">
        <img class="card-icon" src=${SMART_WINDOW_ICON} alt="" />
        <h3 class="card-title" id="card-title" title=${this.#title()}>
          ${this.#title()}
        </h3>
      </div>
      <p class="message">
        I opened this page but couldn't find an ingredient list.
      </p>
      ${this.#sourceRow()} ${this.#trace(false)}
    `;
  }

  #renderError() {
    const reason = this.#reason;
    const bare = reason === "missing_key" || reason === "invalid_args";
    return html`
      <div class="card-header">
        <img class="card-icon" src=${SMART_WINDOW_ICON} alt="" />
        <h3 class="card-title" id="card-title" title=${this.#title()}>
          ${this.#title()}
        </h3>
      </div>
      <p class="message error">
        <img class="message-icon" src=${ERROR_ICON} alt="" aria-hidden="true" />
        <span>${this.#errorMessage()}</span>
      </p>
      ${bare ? nothing : html`${this.#sourceRow()} ${this.#trace(false)}`}
    `;
  }

  render() {
    const state = this.#state;
    let body;
    switch (state) {
      case "loading":
        body = this.#renderLoading();
        break;
      case "loaded":
        body = this.#renderLoaded();
        break;
      case "empty":
        body = this.#renderEmpty();
        break;
      default:
        body = this.#renderError();
    }
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/recipe-ingredients-card.css"
      />
      <div
        class="card"
        role="group"
        aria-labelledby="card-title"
        aria-busy=${state === "loading" ? "true" : "false"}
      >
        ${body}
      </div>
    `;
  }
}

customElements.define("recipe-ingredients-card", RecipeIngredientsCard);
