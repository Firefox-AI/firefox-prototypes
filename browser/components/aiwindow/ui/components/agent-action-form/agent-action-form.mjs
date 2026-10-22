/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-input-text.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-input-url.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-textarea.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-select.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/ai-website-chip.mjs";

const MAX_PAGES = 5;

const WEEKDAYS = [
  { value: "0", ftlId: "ai-tasks-alert-weekday-sunday" },
  { value: "1", ftlId: "ai-tasks-alert-weekday-monday" },
  { value: "2", ftlId: "ai-tasks-alert-weekday-tuesday" },
  { value: "3", ftlId: "ai-tasks-alert-weekday-wednesday" },
  { value: "4", ftlId: "ai-tasks-alert-weekday-thursday" },
  { value: "5", ftlId: "ai-tasks-alert-weekday-friday" },
  { value: "6", ftlId: "ai-tasks-alert-weekday-saturday" },
];

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

function nextTimeOption() {
  const now = new Date();
  const minutes = now.getMinutes() < 30 ? 30 : 0;
  if (minutes === 0) {
    now.setHours(now.getHours() + 1);
  }
  now.setMinutes(minutes, 0, 0);
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * A panel body built from the blocks on a PanelAction. The host decides what
 * submitting does. This element only collects the values.
 *
 * Dispatches:
 *  - agent-action-form:submit  detail: { id, handler, values }
 *  - agent-action-form:cancel
 *
 * @property {object} action - A PanelAction with kind "form".
 * @property {object} agent - { url } of the page the panel was opened on.
 */
export class AgentActionForm extends MozLitElement {
  static properties = {
    action: { type: Object },
    agent: { type: Object },
    values: { type: Object, state: true },
    pages: { type: Array, state: true },
    pendingUrl: { type: String, state: true },
    errors: { type: Object, state: true },
  };

  constructor() {
    super();
    this.action = null;
    this.agent = null;
    this.values = {};
    this.pages = [];
    this.pendingUrl = "";
    this.errors = {};
  }

  willUpdate(changed) {
    const actionChanged = changed.has("action") && this.action;
    const agentArrived =
      changed.has("agent") && this.action && !this.pages.length;
    if (actionChanged || agentArrived) {
      this.#seed();
    }
  }

  async focusFirst() {
    const field = this.shadowRoot?.querySelector(
      "moz-input-text, moz-textarea, moz-select"
    );
    await field?.updateComplete;
    field?.focus();
  }

  #seed() {
    const url = this.agent?.url ?? "";
    this.pages = url ? [url] : [];
    this.pendingUrl = "";
    this.errors = {};
    const params = this.action?.params ?? {};
    this.values = {
      frequency: params.frequency === "weekly" ? "weekly" : "daily",
      time: params.time || nextTimeOption(),
      weekday: "1",
    };
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value) {
        this.values[key] = value;
      }
    }
  }

  #setValue(id, value) {
    this.values = { ...this.values, [id]: value };
    if (this.errors[id]) {
      this.errors = { ...this.errors, [id]: null };
    }
  }

  #normalizeUrl(url) {
    const value = url.trim();
    if (!value) {
      return "";
    }
    const candidate = value.includes("://") ? value : `https://${value}`;
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname
      ) {
        return parsed.href;
      }
    } catch {
      // Not a URL.
    }
    return "";
  }

  #addPage() {
    const url = this.#normalizeUrl(this.pendingUrl);
    if (!this.pendingUrl.trim()) {
      return;
    }
    if (!url) {
      this.errors = {
        ...this.errors,
        pages: "ai-tasks-alert-error-invalid-url",
      };
      return;
    }
    if (this.pages.includes(url)) {
      this.errors = {
        ...this.errors,
        pages: "ai-tasks-alert-error-duplicate-url",
      };
      return;
    }
    if (this.pages.length >= MAX_PAGES) {
      return;
    }
    this.pages = [...this.pages, url];
    this.pendingUrl = "";
    this.errors = { ...this.errors, pages: null };
  }

  #validate() {
    const errors = {};
    for (const block of this.action?.blocks ?? []) {
      if (!block.required) {
        continue;
      }
      if (block.type === "pages") {
        this.#validatePages(errors);
      } else if (!String(this.values[block.id] ?? "").trim()) {
        errors[block.id] = this.#requiredErrorId(block);
      }
    }
    this.errors = errors;
    return !Object.values(errors).some(Boolean);
  }

  #requiredErrorId(block) {
    if (block.errorL10nId) {
      return block.errorL10nId;
    }
    if (block.type === "text") {
      return "ai-tasks-alert-error-name-required";
    }
    return "ai-tasks-alert-error-condition-required";
  }

  #validatePages(errors) {
    if (!this.pages.length && !this.pendingUrl.trim()) {
      errors.pages = "ai-tasks-alert-error-no-pages";
      return;
    }
    this.#addPage();
    if (!this.pages.length) {
      errors.pages = this.errors.pages || "ai-tasks-alert-error-no-pages";
    }
  }

  #onFormKeydown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }
    // A newline, adding a page, and activating a button already have a key.
    const skip = new Set([
      "textarea",
      "moz-textarea",
      "moz-input-url",
      "button",
      "moz-button",
    ]);
    if (event.composedPath().some(node => skip.has(node.localName))) {
      return;
    }
    event.preventDefault();
    this.#onSubmit();
  }

  #onSubmit() {
    if (!this.#validate()) {
      return;
    }
    const values = { ...this.values, pages: [...this.pages] };
    this.dispatchEvent(
      new CustomEvent("agent-action-form:submit", {
        detail: {
          id: this.action.id,
          handler: this.action.handler,
          values,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  #onCancel() {
    this.dispatchEvent(
      new CustomEvent("agent-action-form:cancel", {
        bubbles: true,
        composed: true,
      })
    );
  }

  #renderError(id) {
    const errorId = this.errors[id];
    if (!errorId) {
      return nothing;
    }
    return html`<div class="action-error" data-l10n-id=${errorId}></div>`;
  }

  #renderText(block) {
    const input = block.label
      ? html`<moz-input-text
          label=${block.label}
          placeholder=${block.placeholder ?? ""}
          .value=${this.values[block.id] ?? ""}
          @input=${event => this.#setValue(block.id, event.target.value)}
        ></moz-input-text>`
      : html`<moz-input-text
          data-l10n-id=${block.l10nId}
          data-l10n-attrs=${block.l10nAttrs ?? "label"}
          .value=${this.values[block.id] ?? ""}
          @input=${event => this.#setValue(block.id, event.target.value)}
        ></moz-input-text>`;
    return html`<div class="action-field">
      ${input}${this.#renderError(block.id)}
    </div>`;
  }

  #renderLongText(block) {
    const input = block.label
      ? html`<moz-textarea
          label=${block.label}
          placeholder=${block.placeholder ?? ""}
          .value=${this.values[block.id] ?? ""}
          @input=${event => this.#setValue(block.id, event.target.value)}
        ></moz-textarea>`
      : html`<moz-textarea
          data-l10n-id=${block.l10nId}
          data-l10n-attrs="label,placeholder"
          .value=${this.values[block.id] ?? ""}
          @input=${event => this.#setValue(block.id, event.target.value)}
        ></moz-textarea>`;
    return html`<div class="action-field">
      ${input}${this.#renderError(block.id)}
    </div>`;
  }

  #renderPages(block) {
    const urlInput = block.label
      ? html`<moz-input-url
          label=${block.label}
          placeholder=${block.placeholder ?? ""}
          .value=${this.pendingUrl}
          @input=${event => {
            this.pendingUrl = event.target.value;
          }}
          @keydown=${event => this.#onPageKeydown(event)}
        ></moz-input-url>`
      : html`<moz-input-url
          data-l10n-id=${block.l10nId}
          data-l10n-attrs="placeholder,label"
          data-l10n-args=${JSON.stringify({ maxPages: MAX_PAGES })}
          .value=${this.pendingUrl}
          @input=${event => {
            this.pendingUrl = event.target.value;
          }}
          @keydown=${event => this.#onPageKeydown(event)}
        ></moz-input-url>`;
    return html`<div class="action-field">
      <div class="action-page-row">
        ${urlInput}
        <moz-button
          size="small"
          type="icon ghost"
          iconsrc="chrome://global/skin/icons/plus.svg"
          data-l10n-id="ai-tasks-alert-add-url"
          data-l10n-attrs="aria-label"
          @click=${() => this.#addPage()}
        ></moz-button>
      </div>
      ${this.#renderError("pages")}
      ${this.pages.length
        ? html`<div class="action-pages">
            ${this.pages.map(
              url =>
                html`<ai-website-chip
                  type="context-chip"
                  size="small"
                  removable
                  label=${new URL(url).hostname}
                  title=${url}
                  .iconSrc=${`page-icon:${url}`}
                  @ai-website-chip:remove=${() => {
                    this.pages = this.pages.filter(item => item !== url);
                  }}
                ></ai-website-chip>`
            )}
          </div>`
        : nothing}
    </div>`;
  }

  #onPageKeydown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.#addPage();
    }
  }

  #renderFrequency() {
    return html`<div class="action-field">
      <label
        class="action-label"
        data-l10n-id="ai-tasks-alert-check-label"
      ></label>
      <moz-select
        .value=${this.values.frequency}
        @change=${event => this.#setValue("frequency", event.target.value)}
      >
        <moz-option
          value="daily"
          data-l10n-id="ai-tasks-alert-schedule-daily"
        ></moz-option>
        <moz-option
          value="weekly"
          data-l10n-id="ai-tasks-alert-schedule-weekly"
        ></moz-option>
      </moz-select>
      ${this.values.frequency === "weekly"
        ? html`<label
              class="action-label"
              data-l10n-id="ai-tasks-alert-day-label"
            ></label>
            <moz-select
              .value=${this.values.weekday}
              @change=${event => this.#setValue("weekday", event.target.value)}
            >
              ${WEEKDAYS.map(
                day =>
                  html`<moz-option
                    value=${day.value}
                    data-l10n-id=${day.ftlId}
                  ></moz-option>`
              )}
            </moz-select>`
        : nothing}
    </div>`;
  }

  #renderTime() {
    return html`<div class="action-field">
      <label
        class="action-label"
        data-l10n-id="ai-tasks-alert-time-label"
      ></label>
      <moz-select
        .value=${this.values.time}
        @change=${event => this.#setValue("time", event.target.value)}
      >
        ${TIME_OPTIONS.map(
          opt =>
            html`<moz-option
              value=${opt.value}
              label=${opt.label}
            ></moz-option>`
        )}
      </moz-select>
    </div>`;
  }

  #renderBlock(block) {
    switch (block.type) {
      case "text":
        return this.#renderText(block);
      case "longtext":
        return this.#renderLongText(block);
      case "pages":
        return this.#renderPages(block);
      case "frequency":
        return this.#renderFrequency();
      case "time":
        return this.#renderTime();
      default:
        return nothing;
    }
  }

  #renderSubmit() {
    const { submitLabel, submitL10nId, menuLabel } = this.action ?? {};
    // label is a Fluent attribute on moz-button, so a raw string set there is
    // cleared. The default slot is what the button shows.
    const label = submitLabel || (submitL10nId ? "" : menuLabel);
    if (label) {
      return html`<moz-button type="primary" @click=${() => this.#onSubmit()}
        >${label}</moz-button
      >`;
    }
    return html`<moz-button
      type="primary"
      data-l10n-id=${submitL10nId}
      data-l10n-attrs="label"
      @click=${() => this.#onSubmit()}
    ></moz-button>`;
  }

  render() {
    if (!this.action) {
      return nothing;
    }
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/agent-action-form.css"
      />
      <div class="action-form" @keydown=${event => this.#onFormKeydown(event)}>
        ${(this.action.blocks ?? []).map(block => this.#renderBlock(block))}
        <div class="action-actions">
          <span class="action-spacer"></span>
          <moz-button
            type="default"
            data-l10n-id="ai-tasks-alert-cancel-button"
            data-l10n-attrs="label"
            @click=${() => this.#onCancel()}
          ></moz-button>
          ${this.#renderSubmit()}
        </div>
      </div>
    `;
  }
}

customElements.define("agent-action-form", AgentActionForm);
