/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing, svg } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const GOAL_INPUT_DEBOUNCE_MS = 400;
const SPARKLINE_W = 56;
const SPARKLINE_H = 14;
const TREND_DELTA = 10;

const STATUS_LABELS = {
  idle: "Awaiting evaluation",
  on_task: "On Task",
  drifting: "Drifting",
  off_track: "Off Track",
};

const TREND_GLYPH = { up: "↑", down: "↓", flat: "→" };

/**
 * Always-visible focus alignment panel for the AI Sidebar. Renders the user's
 * current mission, a status orb, a 0-100 slider, and a one-sentence
 * explanation. Purely informational; no actions.
 *
 * - Emits `focus-guardrail:goal-changed` (bubbling, composed) when the user
 *   edits the goal text. The parent ai-window listens and re-runs the
 *   alignment query.
 */
export class FocusGuardrail extends MozLitElement {
  static properties = {
    goal: { type: String },
    status: { type: String, reflect: true },
    score: { type: Number },
    explanation: { type: String },
    recoverySearches: { type: Array },
    sparkline: { type: Array },
    pending: { type: Boolean, reflect: true },
  };

  #debounceTimer = null;

  constructor() {
    super();
    this.goal = "";
    this.status = "idle";
    this.score = 0;
    this.explanation = "";
    this.recoverySearches = [];
    this.sparkline = [];
    this.pending = false;
  }

  #computeTrend() {
    const pts = (this.sparkline ?? []).filter(Number.isFinite);
    if (pts.length < 2) {
      return null;
    }
    const delta = pts.at(-1) - pts.at(-2);
    if (delta >= TREND_DELTA) {
      return "up";
    }
    if (delta <= -TREND_DELTA) {
      return "down";
    }
    return "flat";
  }

  #renderSparkline() {
    const pts = (this.sparkline ?? []).filter(Number.isFinite);
    if (pts.length < 2) {
      return nothing;
    }
    const n = pts.length;
    const points = pts
      .map((v, i) => {
        const x = (i / (n - 1)) * SPARKLINE_W;
        const clamped = Math.max(0, Math.min(100, v));
        const y = SPARKLINE_H - (clamped / 100) * SPARKLINE_H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return svg`<svg
        class="sparkline"
        viewBox="0 0 ${SPARKLINE_W} ${SPARKLINE_H}"
        width=${SPARKLINE_W}
        height=${SPARKLINE_H}
        aria-hidden="true"
      ><polyline points=${points} /></svg>`;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
  }

  #onGoalInput = event => {
    const value = event.target.value;
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.dispatchEvent(
        new CustomEvent("focus-guardrail:goal-changed", {
          bubbles: true,
          composed: true,
          detail: { goal: value },
        })
      );
    }, GOAL_INPUT_DEBOUNCE_MS);
  };

  #renderBody() {
    const hasResult = this.status !== "idle" && this.explanation;
    if (this.pending && !hasResult) {
      return html`<div class="analyzing" aria-live="polite">Analyzing…</div>`;
    }
    if (!hasResult) {
      return html`<p class="explanation placeholder">
        Set a mission above to track how this tab aligns with your goal.
      </p>`;
    }
    const showRecovery =
      (this.status === "drifting" || this.status === "off_track") &&
      Array.isArray(this.recoverySearches) &&
      !!this.recoverySearches.length;
    return html`
      <p class="explanation">${this.explanation}</p>
      ${showRecovery
        ? html`<div
            class="recovery-searches"
            role="group"
            aria-label="Suggested searches to get back on task"
          >
            ${this.recoverySearches.map(
              q =>
                html`<button
                  type="button"
                  class="recovery-search"
                  @click=${() => this.#onSearchClicked(q)}
                >
                  ${q}
                </button>`
            )}
          </div>`
        : nothing}
    `;
  }

  #onSearchClicked(query) {
    this.dispatchEvent(
      new CustomEvent("focus-guardrail:search-clicked", {
        bubbles: true,
        composed: true,
        detail: { query },
      })
    );
  }

  render() {
    const clamped = Math.max(0, Math.min(100, this.score));
    const label = STATUS_LABELS[this.status] ?? STATUS_LABELS.idle;
    const showScore = this.status !== "idle";
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/focus-guardrail.css"
      />
      <div class="header">
        <span class="orb" data-status=${this.status} aria-hidden="true"></span>
        <span class="status-label">
          ${showScore ? html`${clamped}% ` : nothing}${label}
          ${(() => {
            const trend = this.#computeTrend();
            return trend
              ? html`<span class="trend" data-trend=${trend} aria-hidden="true"
                  >${TREND_GLYPH[trend]}</span
                >`
              : nothing;
          })()}
        </span>
        ${this.#renderSparkline()}
      </div>
      <input
        class="goal-input"
        type="text"
        .value=${this.goal}
        placeholder="Set your current mission or goal…"
        aria-label="Current mission or goal"
        @input=${this.#onGoalInput}
      />
      <div
        class="track"
        role="progressbar"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow=${clamped}
      >
        <div class="thumb" data-pos="${clamped}%"></div>
      </div>
      ${this.#renderBody()}
    `;
  }
}

customElements.define("focus-guardrail", FocusGuardrail);
