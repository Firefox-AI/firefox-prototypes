/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const WEEKDAYS = [
  "monitor-agents-weekday-sunday",
  "monitor-agents-weekday-monday",
  "monitor-agents-weekday-tuesday",
  "monitor-agents-weekday-wednesday",
  "monitor-agents-weekday-thursday",
  "monitor-agents-weekday-friday",
  "monitor-agents-weekday-saturday",
];

const CADENCES = [
  ["interval", "monitor-agents-cadence-interval"],
  ["daily", "monitor-agents-cadence-daily"],
  ["weekly", "monitor-agents-cadence-weekly"],
];

const INTERVAL_UNITS = [
  ["minute", "monitor-agents-interval-unit-minutes"],
  ["hour", "monitor-agents-interval-unit-hours"],
  ["day", "monitor-agents-interval-unit-days"],
  ["week", "monitor-agents-interval-unit-weeks"],
];

/**
 * Inline monitor agent creation form for Smart Window chat.
 */
export class MonitorAgentCreation extends MozLitElement {
  static properties = {
    prompt: { type: String },
    pageUrl: { type: String },
    pageTitle: { type: String },
    cadence: { type: String, state: true },
    intervalValue: { type: String, state: true },
    intervalUnit: { type: String, state: true },
    time: { type: String, state: true },
    day: { type: Number, state: true },
  };

  constructor() {
    super();
    this.prompt = "";
    this.pageUrl = "";
    this.pageTitle = "";
    this.cadence = "interval";
    this.intervalValue = "15";
    this.intervalUnit = "minute";
    this.time = "09:00";
    this.day = 1;
  }

  get #showInterval() {
    return this.cadence === "interval";
  }

  get #showTime() {
    return this.cadence === "daily" || this.cadence === "weekly";
  }

  get #showDay() {
    return this.cadence === "weekly";
  }

  #onPromptInput(event) {
    this.prompt = event.target.value;
  }

  #onPageUrlInput(event) {
    this.pageUrl = event.target.value;
  }

  #onPageTitleInput(event) {
    this.pageTitle = event.target.value;
  }

  #onCadenceChange(event) {
    this.cadence = event.target.value;
  }

  #onIntervalValueInput(event) {
    this.intervalValue = event.target.value;
  }

  #onIntervalUnitChange(event) {
    this.intervalUnit = event.target.value;
  }

  #onTimeInput(event) {
    this.time = event.target.value;
  }

  #onDayChange(event) {
    this.day = Number(event.target.value);
  }

  #onSaveClick() {
    this.renderRoot.querySelector("form")?.requestSubmit();
  }

  #readSchedule() {
    if (this.cadence === "interval") {
      return {
        type: "interval",
        intervalMs:
          readPositiveInteger(this.intervalValue) *
          intervalUnitMs(this.intervalUnit),
      };
    }

    const { hour, minute } = parseTimeValue(this.time);
    if (this.cadence === "daily") {
      return { type: "daily", hour, minute };
    }
    return {
      type: "weekly",
      day: this.day,
      hour,
      minute,
    };
  }

  #onSubmit(event) {
    event.preventDefault();
    this.dispatchEvent(
      new CustomEvent("monitor-agent-creation:submit", {
        bubbles: true,
        composed: true,
        detail: {
          prompt: this.prompt,
          pageUrl: this.pageUrl,
          pageTitle: this.pageTitle,
          schedule: this.#readSchedule(),
        },
      })
    );
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/monitor-agent-creation.css"
      />
      <form class="monitor-agent-creation" @submit=${this.#onSubmit}>
        <label>
          <span data-l10n-id="monitor-agents-prompt-label"></span>
          <textarea
            rows="3"
            required
            .value=${this.prompt}
            @input=${this.#onPromptInput}
          ></textarea>
        </label>
        <label>
          <span data-l10n-id="monitor-agents-url-label"></span>
          <input
            type="url"
            required
            .value=${this.pageUrl}
            @input=${this.#onPageUrlInput}
          />
        </label>
        <label>
          <span data-l10n-id="monitor-agents-title-label"></span>
          <input
            type="text"
            .value=${this.pageTitle}
            @input=${this.#onPageTitleInput}
          />
        </label>
        <div class="schedule-fields">
          <label>
            <span data-l10n-id="monitor-agents-interval-label"></span>
            <select .value=${this.cadence} @change=${this.#onCadenceChange}>
              ${CADENCES.map(
                ([value, l10nId]) =>
                  html`<option value=${value} data-l10n-id=${l10nId}></option>`
              )}
            </select>
          </label>
          <label ?hidden=${!this.#showInterval}>
            <span data-l10n-id="monitor-agents-interval-every-label"></span>
            <input
              type="number"
              min="1"
              step="1"
              required
              ?disabled=${!this.#showInterval}
              .value=${this.intervalValue}
              @input=${this.#onIntervalValueInput}
            />
          </label>
          <label ?hidden=${!this.#showInterval}>
            <span data-l10n-id="monitor-agents-interval-unit-label"></span>
            <select
              required
              ?disabled=${!this.#showInterval}
              .value=${this.intervalUnit}
              @change=${this.#onIntervalUnitChange}
            >
              ${INTERVAL_UNITS.map(
                ([value, l10nId]) =>
                  html`<option value=${value} data-l10n-id=${l10nId}></option>`
              )}
            </select>
          </label>
          <label ?hidden=${!this.#showTime}>
            <span data-l10n-id="monitor-agents-time-label"></span>
            <input
              type="time"
              required
              ?disabled=${!this.#showTime}
              .value=${this.time}
              @input=${this.#onTimeInput}
            />
          </label>
          <label ?hidden=${!this.#showDay}>
            <span data-l10n-id="monitor-agents-day-label"></span>
            <select
              required
              ?disabled=${!this.#showDay}
              .value=${String(this.day)}
              @change=${this.#onDayChange}
            >
              ${WEEKDAYS.map(
                (l10nId, index) =>
                  html`<option
                    value=${String(index)}
                    data-l10n-id=${l10nId}
                  ></option>`
              )}
            </select>
          </label>
        </div>
        <moz-button
          type="primary"
          data-l10n-id="monitor-agents-save-monitor-button"
          @click=${this.#onSaveClick}
        ></moz-button>
      </form>
    `;
  }
}

customElements.define("monitor-agent-creation", MonitorAgentCreation);

function readPositiveInteger(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

function intervalUnitMs(unit) {
  switch (unit) {
    case "hour":
      return HOUR_MS;
    case "day":
      return DAY_MS;
    case "week":
      return WEEK_MS;
    default:
      return MINUTE_MS;
  }
}

function parseTimeValue(value) {
  const [hour = 9, minute = 0] = String(value || "09:00")
    .split(":")
    .map(Number);
  return { hour, minute };
}
