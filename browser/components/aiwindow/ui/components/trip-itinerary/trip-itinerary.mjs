/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const WEATHER_ICONS = {
  sunny: "☀️",
  cloudy: "☁️",
  rain: "🌧️",
  snow: "❄️",
  storm: "⛈️",
  fog: "🌫️",
  "partly-cloudy": "⛅",
  wind: "🌬️",
};

function weatherIcon(condition) {
  if (!condition) {
    return "🌤️";
  }
  const lower = String(condition).toLowerCase();
  for (const [key, icon] of Object.entries(WEATHER_ICONS)) {
    if (lower.includes(key)) {
      return icon;
    }
  }
  return "🌤️";
}

function shortDay(idx) {
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][idx % 7];
}

function inlineMapSvg(plan) {
  // Hand-authored stylized map placeholder. SVG is data: URI compatible with
  // strict CSP. Pins overlay at deterministic positions per activity index so
  // the demo has visible markers without doing real lat/lng -> pixel math.
  const pinCount = (plan.days || [])
    .flatMap(d => d.activities || [])
    .filter(a => a.lat && a.lng).length;
  const pins = Array.from({ length: Math.min(pinCount, 9) }, (_, i) => {
    const x = 60 + ((i * 47) % 280);
    const y = 40 + ((i * 31) % 110);
    return `<circle cx="${x}" cy="${y}" r="6" fill="var(--smartwindow-brand-accent, #7d4cdb)" stroke="white" stroke-width="2"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 200" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#e6ecf5"/>
        <stop offset="100%" stop-color="#cdd5e0"/>
      </linearGradient>
    </defs>
    <rect width="360" height="200" fill="url(#bg)"/>
    <path d="M0 140 Q 80 110 160 130 T 360 120" stroke="#9aa6b5" stroke-width="2" fill="none"/>
    <path d="M0 90 Q 100 70 200 80 T 360 70" stroke="#b6bdc7" stroke-width="1.5" fill="none"/>
    <path d="M30 30 L 60 60 L 90 30 L 110 50 L 140 25" stroke="#7d8896" stroke-width="1.5" fill="none"/>
    ${pins}
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export class TripItinerary extends MozLitElement {
  static properties = {
    tripPlan: { type: Object, attribute: false },
    state: { type: String, state: true },
    mutatedPath: { type: Object, state: true },
  };

  constructor() {
    super();
    this.tripPlan = null;
    this.state = "loading";
    this.mutatedPath = null;
    this._mutationTimer = null;
  }

  willUpdate(changed) {
    if (changed.has("tripPlan")) {
      if (!this.tripPlan) {
        this.state = "loading";
      } else if (this.tripPlan.error) {
        this.state = "error";
      } else {
        this.state = "loaded";
      }
    }
  }

  /**
   * Apply a mutation_path flash. Called from ai-chat-content when the
   * tripMutation actor event arrives. Sets data-mutated for 1.6s.
   */
  flashMutation(mutatedPath) {
    if (this._mutationTimer) {
      clearTimeout(this._mutationTimer);
    }
    this.mutatedPath = mutatedPath;
    this.requestUpdate();
    this._mutationTimer = setTimeout(() => {
      this.mutatedPath = null;
      this._mutationTimer = null;
      this.requestUpdate();
    }, 1600);
  }

  #emitOpenSearch(slotType) {
    this.dispatchEvent(
      new CustomEvent("AIChatContent:DispatchFollowUp", {
        bubbles: true,
        composed: true,
        detail: {
          text:
            slotType === "hotel"
              ? "Find me hotels for this trip."
              : "Find me flights for this trip.",
        },
      })
    );
  }

  #emitClearSlot(slotType) {
    this.dispatchEvent(
      new CustomEvent("AIChatContent:DispatchFollowUp", {
        bubbles: true,
        composed: true,
        detail: {
          text:
            slotType === "hotel"
              ? "Clear the hotel from my trip."
              : "Clear the flight from my trip.",
        },
      })
    );
  }

  #renderLoading() {
    return html`
      <div class="trip-card" aria-busy="true">
        <div class="loading-state">
          <div class="loading-spinner"></div>
          <div class="loading-text">Planning your trip...</div>
          <div class="skeleton-block"></div>
          <div class="skeleton-block short"></div>
          <div class="skeleton-block"></div>
        </div>
      </div>
    `;
  }

  #renderError() {
    return html`
      <div class="trip-card">
        <div class="error-state">
          <div class="error-title">Couldn't build a plan from that.</div>
          <div class="error-text">
            ${this.tripPlan?.error || "Try again with a destination and dates."}
          </div>
        </div>
      </div>
    `;
  }

  #renderHeader() {
    const p = this.tripPlan;
    const dates =
      p.date_range?.start && p.date_range?.end
        ? `${p.date_range.start} - ${p.date_range.end}`
        : "";
    const grounding = p.grounding || {};
    const isTabs = grounding.source === "tabs" && grounding.tab_count > 0;
    const groundingCopy = isTabs
      ? `Using titles from ${grounding.tab_count} ${p.destination} tab${
          grounding.tab_count === 1 ? "" : "s"
        } - ends with this task`
      : "Grounded in general knowledge";

    return html`
      <div class="trip-header">
        <div class="trip-header-text">
          <div class="trip-name">${p.destination} - ${p.day_count} days</div>
          <div class="trip-meta">${dates}</div>
          <div class="grounding-badge" data-source=${grounding.source ?? "general"}>
            ${groundingCopy}
          </div>
        </div>
        ${isTabs && p.tabs?.length
          ? html`<div class="tab-chips" role="list" aria-label="Trip tabs">
              ${p.tabs.slice(0, 5).map(
                t => html`
                  <ai-website-chip
                    type="context-chip"
                    role="listitem"
                    .label=${t.title || t.url}
                    .iconSrc=${t.favicon || `page-icon:${t.url}`}
                    .href=${t.url}
                  ></ai-website-chip>
                `
              )}
              ${p.tabs.length > 5
                ? html`<span class="tab-chip-more">+${p.tabs.length - 5} more</span>`
                : nothing}
            </div>`
          : nothing}
      </div>
    `;
  }

  #renderFlightSlot() {
    const slot = this.tripPlan.flight_slot || {};
    const flashing = this.mutatedPath?.kind === "flight";
    if (!slot.filled) {
      return html`
        <button
          class="slot-card slot-empty flight-slot"
          data-state="empty"
          data-mutated=${flashing ? "true" : nothing}
          @click=${() => this.#emitOpenSearch("flight")}
          aria-label="Click to find a flight"
        >
          <span class="slot-glyph" aria-hidden="true">✈</span>
          <span class="slot-cta">Click to find a flight</span>
        </button>
      `;
    }
    return html`
      <div
        class="slot-card slot-filled flight-slot"
        data-state="filled"
        data-mutated=${flashing ? "true" : nothing}
      >
        <div class="slot-row">
          <span class="slot-glyph" aria-hidden="true">✈</span>
          <span class="slot-name">${slot.carrier} ${slot.flight_no}</span>
          <span class="slot-price">${slot.price}</span>
        </div>
        <div class="slot-sub">
          ${slot.depart} -> ${slot.arrive}
          ${slot.source_url
            ? html` ·
                <a
                  class="slot-source"
                  href=${slot.source_url}
                  target="_blank"
                  rel="noopener"
                  >source</a
                >`
            : nothing}
          <button class="slot-replace" @click=${() => this.#emitClearSlot("flight")}>
            Clear
          </button>
        </div>
      </div>
    `;
  }

  #renderHotelSlot() {
    const slot = this.tripPlan.hotel_slot || {};
    const flashing = this.mutatedPath?.kind === "hotel";
    if (!slot.filled) {
      return html`
        <button
          class="slot-card slot-empty hotel-slot"
          data-state="empty"
          data-mutated=${flashing ? "true" : nothing}
          @click=${() => this.#emitOpenSearch("hotel")}
          aria-label="Click to find a hotel"
        >
          <span class="slot-glyph" aria-hidden="true">🌆</span>
          <span class="slot-cta">Click to find a hotel</span>
        </button>
      `;
    }
    return html`
      <div
        class="slot-card slot-filled hotel-slot"
        data-state="filled"
        data-mutated=${flashing ? "true" : nothing}
      >
        <div class="slot-row">
          <span class="slot-glyph" aria-hidden="true">🌆</span>
          <span class="slot-name">${slot.name}</span>
          <span class="slot-price">${slot.price}/nt</span>
        </div>
        <div class="slot-sub">
          ${slot.check_in} - ${slot.check_out}
          ${slot.source_url
            ? html` ·
                <a
                  class="slot-source"
                  href=${slot.source_url}
                  target="_blank"
                  rel="noopener"
                  >source</a
                >`
            : nothing}
          <button class="slot-replace" @click=${() => this.#emitClearSlot("hotel")}>
            Clear
          </button>
        </div>
      </div>
    `;
  }

  #renderWeatherStrip() {
    const weather = this.tripPlan.weather || [];
    if (!weather.length) {
      return nothing;
    }
    return html`
      <div class="weather-strip" role="list" aria-label="Daily weather">
        ${weather.map(
          (w, i) => html`
            <div class="weather-cell" role="listitem">
              <div class="weather-day">${shortDay(i)}</div>
              <div class="weather-icon" aria-hidden="true">
                ${weatherIcon(w.condition)}
              </div>
              <div class="weather-temps">
                <span class="weather-high">${w.high_f}°</span>
                <span class="weather-low">${w.low_f}°</span>
              </div>
            </div>
          `
        )}
      </div>
    `;
  }

  #renderDayList() {
    const days = this.tripPlan.days || [];
    return html`${days.map(
      day => html`
        <div class="day-card">
          <div class="day-header">
            <div class="day-label">Day ${day.day}</div>
            <div class="day-title">${day.title}</div>
          </div>
          ${(day.activities || []).length
            ? day.activities.map(a => {
                const flashing =
                  this.mutatedPath?.kind === "activity" &&
                  this.mutatedPath?.activity_id === a.id;
                return html`
                  <div
                    class="activity-row"
                    data-mutated=${flashing ? "true" : nothing}
                  >
                    <span class="activity-time">${a.time || ""}</span>
                    <div class="activity-body">
                      <div class="activity-text">${a.title}</div>
                      ${a.location
                        ? html`<div class="activity-note">${a.location}</div>`
                        : nothing}
                    </div>
                  </div>
                `;
              })
            : html`<div class="activity-row activity-empty">
                <span class="activity-time"></span>
                <div class="activity-body activity-empty-cta">
                  Plan this day
                </div>
              </div>`}
        </div>
      `
    )}`;
  }

  #renderMap() {
    const hasCoords = (this.tripPlan.days || [])
      .flatMap(d => d.activities || [])
      .some(a => a.lat && a.lng);
    if (!hasCoords) {
      return nothing;
    }
    return html`<img
      class="trip-map"
      src=${inlineMapSvg(this.tripPlan)}
      alt="Stylized map of ${this.tripPlan.destination} showing activity locations"
    />`;
  }

  render() {
    const cssLink = html`<link
      rel="stylesheet"
      href="chrome://browser/content/aiwindow/components/trip-itinerary.css"
    />`;

    if (this.state === "loading") {
      return html`${cssLink} ${this.#renderLoading()}`;
    }
    if (this.state === "error") {
      return html`${cssLink} ${this.#renderError()}`;
    }
    if (!this.tripPlan) {
      return nothing;
    }

    return html`
      ${cssLink}
      <div class="trip-card" data-trip-id=${this.tripPlan.trip_id || ""}>
        ${this.#renderHeader()}
        <div class="trip-body">
          ${this.#renderFlightSlot()}
          ${this.#renderHotelSlot()}
          ${this.#renderWeatherStrip()}
          <div class="day-list">${this.#renderDayList()}</div>
          ${this.#renderMap()}
        </div>
      </div>
    `;
  }
}

customElements.define("trip-itinerary", TripItinerary);
