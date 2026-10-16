/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/smartwindow-option-select.mjs";

/**
 * Personalization choices and the memories prefs each one enables.
 */
export const MEMORIES_CHOICES = {
  chats: { fromConversation: true, fromHistory: false },
  browsing: { fromConversation: false, fromHistory: true },
  both: { fromConversation: true, fromHistory: true },
  none: { fromConversation: false, fromHistory: false },
};

/**
 * Maps the memories prefs back to a MEMORIES_CHOICES key.
 *
 * @param {boolean} fromConversation
 * @param {boolean} fromHistory
 * @returns {string}
 */
export function getMemoriesChoice(fromConversation, fromHistory) {
  return (
    Object.entries(MEMORIES_CHOICES).find(
      ([, prefs]) =>
        prefs.fromConversation === fromConversation &&
        prefs.fromHistory === fromHistory
    )?.[0] ?? "both"
  );
}

const MEMORIES_OPTIONS = [
  {
    value: "chats",
    l10nId: "aiwindow-firstrun-single-page-personalize-chats",
  },
  {
    value: "browsing",
    l10nId: "aiwindow-firstrun-single-page-personalize-browsing",
  },
  {
    value: "both",
    l10nId: "aiwindow-firstrun-single-page-personalize-both",
  },
  {
    value: "none",
    l10nId: "aiwindow-firstrun-single-page-personalize-none",
  },
];

/**
 * Single page Smart Window first run onboarding. Shows a welcome intro, then
 * the model, personalization and default window choices.
 *
 * @property {import("chrome://browser/content/aiwindow/components/smartwindow-option-select.mjs").OptionItem[]} modelOptions
 *   Model choices to offer, in display order
 * @property {string} modelChoiceId - Selected model choice ID
 * @property {string} memoriesChoice - Selected MEMORIES_CHOICES key
 * @property {boolean} isDefaultWindow - Whether to make Smart Window the default
 * @property {number} introDurationMS - How long to show the welcome intro
 *   before the choices; 0 skips it
 */
export class SmartwindowOnboarding extends MozLitElement {
  static properties = {
    modelOptions: { type: Array },
    modelChoiceId: { type: String },
    memoriesChoice: { type: String },
    isDefaultWindow: { type: Boolean },
    introDurationMS: { type: Number },
    showIntro: { type: Boolean, state: true },
  };

  #introTimer = null;

  constructor() {
    super();
    this.modelOptions = [];
    this.modelChoiceId = "";
    this.memoriesChoice = "both";
    this.isDefaultWindow = true;
    this.introDurationMS = 0;
    this.showIntro = false;
  }

  willUpdate() {
    if (!this.hasUpdated) {
      this.showIntro = this.introDurationMS > 0;
    }
  }

  firstUpdated() {
    if (this.showIntro) {
      this.#dispatchStep("intro");
      this.#introTimer = setTimeout(() => {
        this.showIntro = false;
        this.#dispatchStep("settings");
      }, this.introDurationMS);
    } else {
      this.#dispatchStep("settings");
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#introTimer);
  }

  #dispatchStep(step) {
    this.dispatchEvent(
      new CustomEvent("smartwindow-onboarding:step-shown", {
        detail: { step },
        bubbles: true,
        composed: true,
      })
    );
  }

  #onModelChange(event) {
    this.modelChoiceId = event.detail.value;
    this.dispatchEvent(
      new CustomEvent("smartwindow-onboarding:model-change", {
        detail: { modelChoiceId: this.modelChoiceId },
        bubbles: true,
        composed: true,
      })
    );
  }

  #onMemoriesChange(event) {
    this.memoriesChoice = event.detail.value;
  }

  #onDefaultWindowChange(event) {
    this.isDefaultWindow = event.target.checked;
  }

  #onSave() {
    this.dispatchEvent(
      new CustomEvent("smartwindow-onboarding:save", {
        detail: {
          modelChoiceId: this.modelChoiceId,
          memories: MEMORIES_CHOICES[this.memoriesChoice],
          isDefaultWindow: this.isDefaultWindow,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  #introTemplate() {
    return html`<main class="onboarding intro">
      <h1 class="onboarding-title" data-l10n-id="aiwindow-firstrun-title"></h1>
      <p
        class="onboarding-subtitle"
        data-l10n-id="aiwindow-firstrun-intro-subtitle"
      ></p>
    </main>`;
  }

  #settingsTemplate() {
    return html`
      <main class="onboarding settings">
        <h1
          class="onboarding-title"
          data-l10n-id="aiwindow-firstrun-single-page-title"
        ></h1>
        <p
          class="onboarding-subtitle"
          data-l10n-id="aiwindow-firstrun-single-page-subtitle"
        ></p>
        <section class="settings-card">
          <div class="setting-row" id="model-row">
            <div class="setting-text">
              <h2
                class="setting-label"
                data-l10n-id="aiwindow-firstrun-single-page-model-label"
              ></h2>
              <p
                class="setting-description"
                data-l10n-id="aiwindow-firstrun-single-page-model-description"
              ></p>
            </div>
            <smartwindow-option-select
              id="model-select"
              .options=${this.modelOptions}
              .value=${this.modelChoiceId}
              @smartwindow-option-select:change=${this.#onModelChange}
            ></smartwindow-option-select>
          </div>
          <div class="setting-row" id="personalize-row">
            <div class="setting-text">
              <h2
                class="setting-label"
                data-l10n-id="aiwindow-firstrun-single-page-personalize-label"
              ></h2>
              <p
                class="setting-description"
                data-l10n-id="aiwindow-firstrun-single-page-personalize-description"
              ></p>
            </div>
            <smartwindow-option-select
              id="personalize-select"
              .options=${MEMORIES_OPTIONS}
              .value=${this.memoriesChoice}
              @smartwindow-option-select:change=${this.#onMemoriesChange}
            ></smartwindow-option-select>
          </div>
          <label class="setting-row" id="default-row">
            <div class="setting-text">
              <h2
                class="setting-label"
                data-l10n-id="aiwindow-firstrun-single-page-default-label"
              ></h2>
              <p
                class="setting-description"
                data-l10n-id="aiwindow-firstrun-single-page-default-description"
              ></p>
            </div>
            <input
              id="default-checkbox"
              type="checkbox"
              .checked=${this.isDefaultWindow}
              @change=${this.#onDefaultWindowChange}
            />
          </label>
        </section>
        <moz-button
          id="save-button"
          type="primary"
          data-l10n-id="aiwindow-firstrun-single-page-save-button"
          @click=${this.#onSave}
        ></moz-button>
      </main>
    `;
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/smartwindow-onboarding.css"
      />
      ${this.showIntro ? this.#introTemplate() : nothing}
      ${this.showIntro ? nothing : this.#settingsTemplate()}
    `;
  }
}

customElements.define("smartwindow-onboarding", SmartwindowOnboarding);
