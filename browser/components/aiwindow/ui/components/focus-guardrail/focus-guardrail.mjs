/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const GOAL_INPUT_DEBOUNCE_MS = 400;

const STATUS_LABELS = {
  idle: "Awaiting evaluation",
  on_task: "On Task",
  drifting: "Drifting",
  off_track: "Off Track",
};

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
    pending: { type: Boolean, reflect: true },
  };

  #debounceTimer = null;

  constructor() {
    super();
    this.goal = "";
    this.status = "idle";
    this.score = 0;
    this.explanation = "";
    this.pending = false;
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
    return html`<p class="explanation">${this.explanation}</p>`;
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
        <span class="status-label"
          >${showScore ? html`${clamped}% ` : nothing}${label}</span
        >
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
