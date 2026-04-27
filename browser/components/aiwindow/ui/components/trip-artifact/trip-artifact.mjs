/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const WEATHER_ICONS = {
  sunny: "\u2600\ufe0f",
  cloudy: "\u2601\ufe0f",
  rain: "\ud83c\udf27\ufe0f",
  snow: "\u2744\ufe0f",
  storm: "\u26c8\ufe0f",
  fog: "\ud83c\udf2b\ufe0f",
  "partly-cloudy": "\u26c5",
  wind: "\ud83c\udf2c\ufe0f",
};

function weatherIcon(condition) {
  if (!condition) {
    return "\ud83c\udf24\ufe0f";
  }
  const lower = condition.toLowerCase();
  for (const [key, icon] of Object.entries(WEATHER_ICONS)) {
    if (lower.includes(key)) {
      return icon;
    }
  }
  return "\ud83c\udf24\ufe0f";
}

export class TripArtifact extends MozLitElement {
  static properties = {
    tripData: { type: Object, attribute: false },
    activeTab: { type: String, state: true },
    state: { type: String, attribute: false },
  };

  constructor() {
    super();
    this.tripData = null;
    this.activeTab = "overview";
    this.state = "loading";
  }

  updated(changed) {
    if (changed.has("tripData")) {
      if (this.tripData?.error) {
        this.state = "error";
      } else if (this.tripData) {
        this.state = "loaded";
      }
    }
  }

  #setTab(tab) {
    this.activeTab = tab;
  }

  #renderTab(id, label) {
    const active = this.activeTab === id;
    return html`<button
      class="tab ${active ? "active" : ""}"
      @click=${() => this.#setTab(id)}
    >
      ${label}
    </button>`;
  }

  #renderLoading() {
    return html`
      <div class="trip-card">
        <div class="loading-state">
          <div class="loading-spinner"></div>
          <div class="loading-text">Building your travel plan...</div>
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
          <div class="error-icon">!</div>
          <div class="error-title">Unable to generate plan</div>
          <div class="error-text">
            ${this.tripData?.error || "Something went wrong. Please try again."}
          </div>
          <button
            class="retry-btn"
            @click=${() =>
              this.dispatchEvent(
                new CustomEvent("AIChatContent:DispatchFollowUp", {
                  detail: { text: "Please try generating the travel plan again." },
                  bubbles: true,
                  composed: true,
                })
              )}
          >
            Try again
          </button>
        </div>
      </div>
    `;
  }

  #renderWeatherWidget() {
    const w = this.tripData.weather;
    if (!w) {
      return nothing;
    }
    return html`
      <div class="weather-widget">
        <span class="weather-icon">${weatherIcon(w.condition)}</span>
        <div class="weather-info">
          <div class="weather-condition">${w.condition || "Fair"}</div>
          <div class="weather-temps">
            ${w.temp_high != null ? html`H: ${w.temp_high}` : nothing}
            ${w.temp_low != null ? html` L: ${w.temp_low}` : nothing}
          </div>
          ${w.season_note
            ? html`<div class="weather-note">${w.season_note}</div>`
            : nothing}
        </div>
      </div>
    `;
  }

  #renderFlightsSection() {
    const flights = this.tripData.flights || [];
    if (!flights.length) {
      return html`
        <div class="empty-section">
          <div class="empty-icon">No flight details found</div>
          <button class="add-btn"
            @click=${() =>
              this.dispatchEvent(
                new CustomEvent("AIChatContent:DispatchFollowUp", {
                  detail: { text: "Add flight details to my travel plan." },
                  bubbles: true,
                  composed: true,
                })
              )}>
            + Add flight details
          </button>
        </div>
      `;
    }
    return html`${flights.map(
      f => html`
        <div class="flight-card">
          <div class="flight-header">
            <span class="flight-airline">${f.airline || "Airline"}</span>
            <span class="flight-number">${f.flight_number || ""}</span>
            <span class="flight-status status-${(f.status || "").toLowerCase()}">${f.status || ""}</span>
          </div>
          <div class="flight-route">
            <div class="flight-endpoint">
              <div class="flight-city">${f.departure || ""}</div>
              <div class="flight-time">${f.departure_time || ""}</div>
            </div>
            <div class="flight-arrow">-></div>
            <div class="flight-endpoint">
              <div class="flight-city">${f.arrival || ""}</div>
              <div class="flight-time">${f.arrival_time || ""}</div>
            </div>
          </div>
          ${f.price ? html`<div class="flight-price">$${f.price}</div>` : nothing}
        </div>
      `
    )}`;
  }

  #renderHotelsSection() {
    const hotels = this.tripData.hotels || [];
    if (!hotels.length) {
      return html`
        <div class="empty-section">
          <div class="empty-icon">No hotel details found</div>
          <button class="add-btn"
            @click=${() =>
              this.dispatchEvent(
                new CustomEvent("AIChatContent:DispatchFollowUp", {
                  detail: { text: "Add hotel details to my travel plan." },
                  bubbles: true,
                  composed: true,
                })
              )}>
            + Add hotel details
          </button>
        </div>
      `;
    }
    return html`${hotels.map(
      h => html`
        <div class="hotel-card">
          <div class="hotel-name">${h.name}</div>
          <div class="hotel-dates">${h.check_in || ""} - ${h.check_out || ""}</div>
          ${h.rating ? html`<div class="hotel-rating">${h.rating}</div>` : nothing}
          ${h.address ? html`<div class="hotel-address">${h.address}</div>` : nothing}
          <div class="hotel-price">
            ${h.price_per_night ? html`$${h.price_per_night}/night` : nothing}
            ${h.total_price ? html` ($${h.total_price} total)` : nothing}
          </div>
        </div>
      `
    )}`;
  }

  #renderOverview() {
    const d = this.tripData;
    const bookings = d.bookings || [];
    return html`
      ${this.#renderWeatherWidget()}
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Destination</div>
          <div class="stat-val">${d.destination}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Duration</div>
          <div class="stat-val">${d.nights} nights</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Travelers</div>
          <div class="stat-val">${d.adults} adults</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Budget</div>
          <div class="stat-val">
            $${(d.budget_estimated || 0).toLocaleString()}
          </div>
          <div class="stat-sub">
            of $${(d.budget_total || 0).toLocaleString()}
          </div>
        </div>
      </div>
      <div class="section-label">Flights</div>
      ${this.#renderFlightsSection()}
      <div class="section-label">Hotels</div>
      ${this.#renderHotelsSection()}
      ${bookings.length
        ? html`
            <div class="section-label">Bookings</div>
            ${bookings.map(
              b => html`
                <div class="booking-row">
                  <div class="booking-info">
                    <div class="booking-name">${b.name}</div>
                    <div class="booking-detail">${b.detail}</div>
                  </div>
                  <div class="booking-price">
                    <div>$${(b.price || 0).toLocaleString()}</div>
                    <div class="booking-status">${b.status}</div>
                  </div>
                </div>
              `
            )}
          `
        : nothing}
    `;
  }

  #renderItinerary() {
    const days = this.tripData.itinerary || [];
    return html`${days.map(
      day => html`
        <div class="day-card">
          <div class="day-header">
            <div>
              <div class="day-label">Day ${day.day}</div>
              <div class="day-title">${day.title}</div>
            </div>
          </div>
          ${(day.activities || []).map(
            a => html`
              <div class="activity-row">
                <span class="activity-time">${a.time}</span>
                <div>
                  <div class="activity-text">${a.text}</div>
                  ${a.note
                    ? html`<div class="activity-note">${a.note}</div>`
                    : nothing}
                </div>
              </div>
            `
          )}
        </div>
      `
    )}`;
  }

  #renderBudget() {
    const d = this.tripData;
    const bookings = d.bookings || [];
    const totalBookings = bookings.reduce((s, b) => s + (b.price || 0), 0);
    const pct =
      d.budget_total > 0
        ? Math.min(
            100,
            Math.round((d.budget_estimated / d.budget_total) * 100)
          )
        : 0;
    return html`
      <div class="budget-bar">
        <div class="budget-fill">
          <div class="budget-fill-inner" style="width:${pct}%"></div>
        </div>
        <span class="budget-label"
          >$${(d.budget_estimated || 0).toLocaleString()} /
          $${(d.budget_total || 0).toLocaleString()}</span
        >
      </div>
      <div class="section-label">Breakdown</div>
      ${bookings.map(
        b => html`
          <div class="budget-row">
            <span>${b.name}</span>
            <span class="budget-val">$${(b.price || 0).toLocaleString()}</span>
          </div>
        `
      )}
      <div class="budget-row">
        <span>Food & Activities (est.)</span>
        <span class="budget-val"
          >$${Math.max(
            0,
            (d.budget_estimated || 0) - totalBookings
          ).toLocaleString()}</span
        >
      </div>
      <div class="budget-row budget-total">
        <span>Total</span>
        <span class="budget-val highlight"
          >$${(d.budget_estimated || 0).toLocaleString()}</span
        >
      </div>
    `;
  }

  #renderPacking() {
    const packing = this.tripData.packing || {};
    return html`${Object.entries(packing).map(
      ([cat, items]) => html`
        <div class="pack-section">
          <div class="section-label">${cat}</div>
          ${(items || []).map(
            item => html`
              <label class="pack-item">
                <input type="checkbox" class="pack-checkbox" />
                <span class="pack-name">${item.name}</span>
                ${item.important
                  ? html`<span class="pack-important">Important</span>`
                  : nothing}
              </label>
            `
          )}
        </div>
      `
    )}`;
  }

  #handleViewPlan() {
    this.dispatchEvent(
      new CustomEvent("AIChatContent:OpenLink", {
        bubbles: true,
        composed: true,
        detail: { url: "chrome://browser/content/aiwindow/tripPlan.html" },
      })
    );
  }

  render() {
    const cssLink = html`<link
      rel="stylesheet"
      href="chrome://browser/content/aiwindow/components/trip-artifact.css"
    />`;

    if (this.state === "loading") {
      return html`${cssLink} ${this.#renderLoading()}`;
    }

    if (this.state === "error") {
      return html`${cssLink} ${this.#renderError()}`;
    }

    if (!this.tripData) {
      return nothing;
    }

    const d = this.tripData;
    const prefs = (d.preferences || []).join(", ");

    return html`
      ${cssLink}
      <div class="trip-card">
        <div class="trip-header">
          <div class="trip-header-text">
            <div class="trip-name">${d.name}</div>
            <div class="trip-meta">
              ${d.destination} · ${d.nights} nights · ${d.adults} adults
              ${prefs ? html` · ${prefs}` : nothing}
            </div>
          </div>
        </div>
        ${(d.alerts || []).length
          ? html`<div class="alerts">
              ${d.alerts.map(
                a => html`<div class="alert alert-${a.type}">${a.text}</div>`
              )}
            </div>`
          : nothing}
        <div class="tab-bar">
          ${this.#renderTab("overview", "Overview")}
          ${this.#renderTab("itinerary", "Itinerary")}
          ${this.#renderTab("budget", "Budget")}
          ${this.#renderTab("packing", "Packing")}
        </div>
        <div class="tab-content">
          ${this.activeTab === "overview" ? this.#renderOverview() : nothing}
          ${this.activeTab === "itinerary" ? this.#renderItinerary() : nothing}
          ${this.activeTab === "budget" ? this.#renderBudget() : nothing}
          ${this.activeTab === "packing" ? this.#renderPacking() : nothing}
        </div>
        <button class="view-plan-btn" @click=${this.#handleViewPlan}>
          View Full Plan
        </button>
      </div>
    `;
  }
}
customElements.define("trip-artifact", TripArtifact);
