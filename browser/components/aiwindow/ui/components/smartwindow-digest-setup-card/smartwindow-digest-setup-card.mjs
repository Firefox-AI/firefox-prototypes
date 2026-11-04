/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-input-text.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-textarea.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-select.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/smartwindow-chip.mjs";

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const hour24 = Math.floor(i / 2);
  const minute = i % 2 ? 30 : 0;
  const timeDate = new Date();
  timeDate.setHours(hour24, minute, 0, 0);
  return {
    value: `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    label: timeDate.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }),
  };
});

const DEFAULT_SETTINGS = Object.freeze({
  frequency: "daily",
  time: "09:00",
  length: "standard",
});

/**
 * Returns the hostname for a typed website, or null if it isn't one.
 *
 * @param {string} input
 * @returns {string|null}
 */
function toSourceDomain(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const url = URL.parse(
    /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  );
  if (!url || !url.hostname.includes(".")) {
    return null;
  }
  return url.hostname.replace(/^www\./, "");
}

/**
 * The "Follow a topic" setup card, opened pre-filled with a curated topic.
 *
 * @property {object} topic - The topic being set up: id, title, cover,
 *   memory, sources, and optionally frequency, time and length from a
 *   previous setup.
 * @fires SmartWindowDigestSetup:follow - detail is the saved topic settings.
 * @fires SmartWindowDigestSetup:cancel
 */
export class SmartWindowDigestSetupCard extends MozLitElement {
  static properties = {
    topic: { type: Object },
    cover: { state: true },
    sources: { state: true },
    pendingSource: { state: true },
    pendingSourceInvalid: { state: true },
    frequency: { state: true },
    time: { state: true },
    length: { state: true },
  };

  static queries = {
    dialog: "dialog",
    coverInput: ".digest-cover-input",
  };

  constructor() {
    super();
    this.topic = null;
    this.cover = "";
    this.sources = [];
    this.pendingSource = "";
    this.pendingSourceInvalid = false;
    this.frequency = DEFAULT_SETTINGS.frequency;
    this.time = DEFAULT_SETTINGS.time;
    this.length = DEFAULT_SETTINGS.length;
  }

  willUpdate(changedProperties) {
    if (changedProperties.has("topic") && this.topic) {
      this.cover = this.topic.cover ?? "";
      this.sources = [...(this.topic.sources ?? [])];
      this.pendingSource = "";
      this.pendingSourceInvalid = false;
      this.frequency = this.topic.frequency ?? DEFAULT_SETTINGS.frequency;
      this.time = this.topic.time ?? DEFAULT_SETTINGS.time;
      this.length = this.topic.length ?? DEFAULT_SETTINGS.length;
    }
  }

  async firstUpdated() {
    this.dialog.showModal();
    await this.updateComplete;
    this.coverInput?.focus();
  }

  #onCancel = () => {
    this.dialog.close();
    this.dispatchEvent(
      new CustomEvent("SmartWindowDigestSetup:cancel", {
        bubbles: true,
        composed: true,
      })
    );
  };

  #onDialogCancel = e => {
    e.preventDefault();
    this.#onCancel();
  };

  #onFollow = () => {
    this.#addPendingSource();
    if (this.pendingSourceInvalid) {
      this.renderRoot.querySelector(".digest-source-input")?.focus();
      return;
    }
    if (!this.cover.trim()) {
      this.coverInput?.focus();
      return;
    }

    const { id, title } = this.topic;
    this.dialog.close();
    this.dispatchEvent(
      new CustomEvent("SmartWindowDigestSetup:follow", {
        detail: {
          id,
          title,
          cover: this.cover.trim(),
          sources: this.sources,
          frequency: this.frequency,
          time: this.time,
          length: this.length,
        },
        bubbles: true,
        composed: true,
      })
    );
  };

  #addPendingSource() {
    if (!this.pendingSource.trim()) {
      return;
    }
    const domain = toSourceDomain(this.pendingSource);
    if (!domain) {
      this.pendingSourceInvalid = true;
      return;
    }
    if (!this.sources.includes(domain)) {
      this.sources = [...this.sources, domain];
    }
    this.pendingSource = "";
    this.pendingSourceInvalid = false;
  }

  #onSourceKeydown = e => {
    if (e.key === "Enter") {
      e.preventDefault();
      this.#addPendingSource();
    }
  };

  #removeSource(domain) {
    this.sources = this.sources.filter(source => source !== domain);
  }

  #renderSources() {
    return html`
      <div class="field">
        <div class="source-input-row">
          <moz-input-text
            class="digest-source-input"
            data-l10n-id="aiwindow-digest-setup-sources"
            data-l10n-attrs="label,placeholder"
            ?invalid=${this.pendingSourceInvalid}
            .value=${this.pendingSource}
            @input=${e => {
              this.pendingSource = e.target.value;
              this.pendingSourceInvalid = false;
            }}
            @keydown=${this.#onSourceKeydown}
          ></moz-input-text>
          <moz-button
            type="icon ghost"
            size="small"
            iconsrc="chrome://global/skin/icons/plus.svg"
            data-l10n-id="aiwindow-digest-setup-add-source"
            data-l10n-attrs="aria-label,tooltiptext"
            @click=${() => this.#addPendingSource()}
          ></moz-button>
        </div>
        ${this.pendingSourceInvalid
          ? html`<div
              class="error-message"
              data-l10n-id="aiwindow-digest-setup-source-invalid"
            ></div>`
          : nothing}
        ${this.sources.length
          ? html`<div class="chip-row">
              ${this.sources.map(
                domain => html`
                  <smartwindow-chip
                    type="source"
                    removable
                    label=${domain}
                    .iconSrc=${`page-icon:https://${domain}/`}
                    @smartwindow-chip:remove=${() => this.#removeSource(domain)}
                  ></smartwindow-chip>
                `
              )}
            </div>`
          : nothing}
      </div>
    `;
  }

  #renderSelect({ l10nId, value, onChange, options }) {
    return html`
      <moz-select
        class="form-select"
        data-l10n-id=${l10nId}
        data-l10n-attrs="label"
        .value=${value}
        @change=${e => onChange(e.target.value)}
      >
        ${options.map(
          opt => html`
            <moz-option
              value=${opt.value}
              label=${opt.label ?? nothing}
              data-l10n-id=${opt.l10nId ?? nothing}
            ></moz-option>
          `
        )}
      </moz-select>
    `;
  }

  render() {
    if (!this.topic) {
      return nothing;
    }

    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/smartwindow-digest-setup-card.css"
      />
      <dialog
        aria-labelledby="digest-setup-heading"
        @cancel=${this.#onDialogCancel}
      >
        <div class="digest-setup-card">
          <h2
            id="digest-setup-heading"
            data-l10n-id="aiwindow-digest-setup-heading"
          ></h2>
          <div class="field title-field">
            <moz-input-text
              class="digest-title-input"
              data-l10n-id="aiwindow-digest-setup-title"
              data-l10n-attrs="label"
              readonly
              required
              .value=${this.topic.title}
            ></moz-input-text>
            <img
              class="title-lock-icon"
              src="chrome://global/skin/icons/security.svg"
              alt=""
            />
          </div>
          <moz-textarea
            class="digest-cover-input"
            data-l10n-id="aiwindow-digest-setup-cover"
            data-l10n-attrs="label"
            required
            .value=${this.cover}
            @input=${e => (this.cover = e.target.value)}
          ></moz-textarea>
          ${this.topic.memory
            ? html`<div class="field">
                <span
                  class="field-label"
                  data-l10n-id="aiwindow-digest-setup-based-on-memory"
                ></span>
                <span class="memory-chip">
                  <img
                    src="chrome://browser/content/aiwindow/assets/memories-on.svg"
                    alt=""
                  />
                  ${this.topic.memory}
                </span>
              </div>`
            : nothing}
          ${this.#renderSources()}
          <hr />
          ${this.#renderSelect({
            l10nId: "aiwindow-digest-setup-frequency",
            value: this.frequency,
            onChange: value => (this.frequency = value),
            options: [
              {
                value: "daily",
                l10nId: "aiwindow-digest-setup-frequency-daily",
              },
              {
                value: "weekly",
                l10nId: "aiwindow-digest-setup-frequency-weekly",
              },
            ],
          })}
          ${this.#renderSelect({
            l10nId: "aiwindow-digest-setup-time",
            value: this.time,
            onChange: value => (this.time = value),
            options: TIME_OPTIONS,
          })}
          ${this.#renderSelect({
            l10nId: "aiwindow-digest-setup-length",
            value: this.length,
            onChange: value => (this.length = value),
            options: [
              { value: "short", l10nId: "aiwindow-digest-setup-length-short" },
              {
                value: "standard",
                l10nId: "aiwindow-digest-setup-length-standard",
              },
              {
                value: "detailed",
                l10nId: "aiwindow-digest-setup-length-detailed",
              },
            ],
          })}
          <span
            class="required-note"
            data-l10n-id="aiwindow-digest-setup-required"
          ></span>
          <div class="actions">
            <moz-button
              type="ghost"
              data-l10n-id="aiwindow-digest-setup-cancel"
              @click=${this.#onCancel}
            ></moz-button>
            <moz-button
              type="primary"
              class="follow-button"
              data-l10n-id="aiwindow-digest-setup-follow"
              ?disabled=${!this.cover.trim()}
              @click=${this.#onFollow}
            ></moz-button>
          </div>
        </div>
      </dialog>
    `;
  }
}

customElements.define(
  "smartwindow-digest-setup-card",
  SmartWindowDigestSetupCard
);
