/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const DEFAULT_QUESTIONS = [
  "What dates work?",
  "Solo or group?",
  "Food, outdoors, or museums?",
];

export class TripFallback extends MozLitElement {
  static properties = {
    suggestedQuestions: { type: Array, attribute: false },
    errorKind: { type: String, attribute: false },
  };

  constructor() {
    super();
    this.suggestedQuestions = DEFAULT_QUESTIONS;
    this.errorKind = "ambiguous";
  }

  #emitFollowUp(text) {
    this.dispatchEvent(
      new CustomEvent("AIChatContent:DispatchFollowUp", {
        bubbles: true,
        composed: true,
        detail: { text },
      })
    );
  }

  render() {
    const cssLink = html`<link
      rel="stylesheet"
      href="chrome://browser/content/aiwindow/components/trip-fallback.css"
    />`;
    const questions = this.suggestedQuestions?.length
      ? this.suggestedQuestions
      : DEFAULT_QUESTIONS;
    return html`
      ${cssLink}
      <div class="trip-fallback-card" role="region" aria-label="Trip planner needs more info">
        <div class="fallback-heading">Let's narrow this down</div>
        <div class="fallback-subtitle">
          I couldn't lock in a plan from that - pick one to start.
        </div>
        ${questions.map(
          q => html`<button
            class="question-button"
            @click=${() => this.#emitFollowUp(q)}
          >
            ${q}
          </button>`
        )}
      </div>
      ${nothing}
    `;
  }
}

customElements.define("trip-fallback", TripFallback);
