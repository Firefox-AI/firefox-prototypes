/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

function formatKickoff(iso) {
  if (!iso) {
    return "";
  }
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "";
  }
}

function formatKickoffDay(iso) {
  if (!iso) {
    return "";
  }
  try {
    const d = new Date(iso);
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    const sameDate = (a, b) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (sameDate(d, today)) {
      return "Today";
    }
    if (sameDate(d, tomorrow)) {
      return "Tomorrow";
    }
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function teamLabel(team) {
  if (!team) {
    return "";
  }
  return team.name || team.code || "";
}

export class WorldCupMatchCard extends MozLitElement {
  static properties = {
    data: { type: Object, attribute: false },
    scope: { type: String, attribute: false },
    showMockHint: { type: Boolean, attribute: false },
  };

  constructor() {
    super();
    this.data = null;
    this.scope = null;
    this.showMockHint = false;
  }

  #onRetry() {
    this.dispatchEvent(
      new CustomEvent("wc-retry", {
        bubbles: true,
        composed: true,
        detail: { scope: this.scope },
      })
    );
  }

  #renderFlag(team) {
    if (!team) {
      return nothing;
    }
    const flag = team.flag;
    const code = team.code || "";
    if (flag) {
      return html`<span class="wc-card__flag" aria-hidden="true">${flag}</span>
        <span class="visually-hidden">${team.name || code}</span>`;
    }
    return html`<span class="wc-card__flag-fallback" aria-hidden="true"
        >${code}</span
      >
      <span class="visually-hidden">${team.name || code}</span>`;
  }

  #renderTeam(team, side) {
    return html`<div class="wc-card__team wc-card__team--${side}">
      ${this.#renderFlag(team)}
      <div class="wc-card__team-name" title=${teamLabel(team)}>
        ${teamLabel(team)}
      </div>
    </div>`;
  }

  #renderLoading(cssLink) {
    return html`${cssLink}
      <div class="wc-card" data-state="loading" aria-busy="true">
        <div class="wc-card__header">
          <span class="wc-skeleton wc-skeleton--eyebrow"></span>
        </div>
        <div class="wc-card__teams">
          <div class="wc-card__team">
            <span class="wc-skeleton wc-skeleton--flag"></span>
            <span class="wc-skeleton wc-skeleton--name"></span>
            <span class="wc-skeleton wc-skeleton--name"></span>
          </div>
          <div class="wc-card__center">
            <span class="wc-skeleton wc-skeleton--score"></span>
          </div>
          <div class="wc-card__team">
            <span class="wc-skeleton wc-skeleton--flag"></span>
            <span class="wc-skeleton wc-skeleton--name"></span>
            <span class="wc-skeleton wc-skeleton--name"></span>
          </div>
        </div>
      </div>`;
  }

  #renderError(cssLink) {
    return html`${cssLink}
      <div class="wc-card" data-state="error" role="alert">
        <div class="wc-card__header">
          <span class="wc-card__eyebrow">Couldn't load</span>
        </div>
        <div class="wc-card__message">Couldn't load match data.</div>
        <button
          type="button"
          class="wc-card__retry"
          @click=${this.#onRetry}
        >
          Try again
        </button>
      </div>`;
  }

  #renderEmpty(cssLink) {
    const next = this.data?.next;
    return html`${cssLink}
      <div class="wc-card" data-state="empty">
        <div class="wc-card__header">
          <span class="wc-card__eyebrow">No live match</span>
        </div>
        <div class="wc-card__message">No live match right now.</div>
        ${next
          ? html`<hr class="wc-card__divider" />
              <div class="wc-card__footer">
                <div class="wc-card__footer-label">Next up</div>
                <div class="wc-card__next-row">
                  <span class="wc-card__team-code"
                    >${next.homeTeam?.code || ""}</span
                  >
                  <span class="wc-card__next-time">
                    ${formatKickoffDay(next.kickoff)}
                    ${formatKickoff(next.kickoff)}
                  </span>
                  <span class="wc-card__team-code"
                    >${next.awayTeam?.code || ""}</span
                  >
                </div>
              </div>`
          : html`<hr class="wc-card__divider" />
              <div class="wc-card__footer">
                <div class="wc-card__footer-label">Next match TBD</div>
              </div>`}
      </div>`;
  }

  #renderLoaded(cssLink) {
    const data = this.data;
    const status = data.status;
    const isLive = status === "live";
    const isFinal = status === "final";
    const isUpcoming = status === "upcoming";
    let eyebrow = "";
    if (isLive) {
      eyebrow = "Current game";
    } else if (isFinal) {
      eyebrow = "Results";
    } else if (isUpcoming) {
      eyebrow = "Upcoming";
    }

    const home = data.homeTeam || {};
    const away = data.awayTeam || {};

    const livePill = isLive
      ? html`<span class="wc-card__status-pill wc-card__status-pill--live">
          <span class="wc-live-dot" aria-hidden="true"></span>
          <span>LIVE</span>
        </span>`
      : nothing;

    let centerScore;
    let centerMeta;
    if (isUpcoming) {
      centerScore = html`<span class="wc-card__kickoff-time"
        >${formatKickoff(data.kickoff)}</span
      >`;
      centerMeta = formatKickoffDay(data.kickoff);
    } else {
      centerScore = html`<span class="wc-card__score-num"
          >${home.score ?? "—"}</span
        >
        <span class="wc-card__score-sep">:</span>
        <span class="wc-card__score-num"
          >${away.score ?? "—"}</span
        >`;
      if (isLive) {
        centerMeta = `${data.minute ?? 0}'`;
      } else if (isFinal) {
        centerMeta = "FT";
      }
    }

    const ariaLive = isLive
      ? html`<span
          class="visually-hidden"
          role="status"
          aria-live="polite"
          >Score: ${teamLabel(home)} ${home.score ?? 0}, ${teamLabel(away)}
          ${away.score ?? 0}, ${data.minute ?? 0}th minute</span
        >`
      : nothing;

    return html`${cssLink}
      <div class="wc-card" data-state=${status || "loaded"}>
        <div class="wc-card__header">
          <span class="wc-card__eyebrow">${eyebrow}</span>
          ${livePill}
        </div>
        <div class="wc-card__teams">
          ${this.#renderTeam(home, "home")}
          <div class="wc-card__center">
            <div
              class=${`wc-card__score-pill wc-card__score-pill--${
                isUpcoming ? "kickoff" : "score"
              }`}
            >
              ${centerScore}
            </div>
            ${centerMeta
              ? html`<div
                  class=${`wc-card__center-meta wc-card__center-meta--${status}`}
                >
                  ${centerMeta}
                </div>`
              : nothing}
          </div>
          ${this.#renderTeam(away, "away")}
        </div>
        ${ariaLive}
        ${data.isMock && this.showMockHint
          ? html`<div class="wc-card__mock-hint">Sample data</div>`
          : nothing}
      </div>`;
  }

  render() {
    const cssLink = html`<link
      rel="stylesheet"
      href="chrome://browser/content/aiwindow/components/world-cup-match-card.css"
    />`;

    if (!this.data) {
      return this.#renderLoading(cssLink);
    }

    if (this.data.error || this.data.status === "error") {
      return this.#renderError(cssLink);
    }

    if (this.data.status === "empty") {
      return this.#renderEmpty(cssLink);
    }

    return this.#renderLoaded(cssLink);
  }
}
customElements.define("world-cup-match-card", WorldCupMatchCard);
