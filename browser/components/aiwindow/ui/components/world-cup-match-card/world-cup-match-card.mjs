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

const MATCHES_PER_PAGE = 3;

function formatRowStatus(match) {
  if (!match) {
    return "";
  }
  if (match.status === "final-penalties" && match.penalties) {
    return `P(${match.penalties.home}-${match.penalties.away})`;
  }
  if (match.status === "final") {
    return "Full time";
  }
  if (match.status === "live") {
    return `Min ${match.minute ?? 0}'`;
  }
  if (match.status === "upcoming") {
    return formatKickoff(match.kickoff);
  }
  return "";
}

export class WorldCupMatchCard extends MozLitElement {
  static properties = {
    data: { type: Object, attribute: false },
    scope: { type: String, attribute: false },
    showMockHint: { type: Boolean, attribute: false },
    _pageIndex: { state: true },
  };

  constructor() {
    super();
    this.data = null;
    this.scope = null;
    this.showMockHint = false;
    this._pageIndex = 0;
  }

  willUpdate(changed) {
    if (changed.has("data")) {
      this._pageIndex = 0;
    }
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

  #onPagePrev() {
    if (this._pageIndex > 0) {
      this._pageIndex -= 1;
    }
  }

  #onPageNext() {
    const matches = this.data?.matches || [];
    const total = Math.ceil(matches.length / MATCHES_PER_PAGE);
    if (this._pageIndex < total - 1) {
      this._pageIndex += 1;
    }
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

    const next = data.next;
    const nextHome = next?.homeTeam || {};
    const nextAway = next?.awayTeam || {};
    const nextFooter = next
      ? html`<hr class="wc-card__divider" />
          <div class="wc-card__footer">
            <div class="wc-card__footer-label">Upcoming</div>
            <div class="wc-card__next-row">
              <div class="wc-card__next-team wc-card__next-team--home">
                <span class="wc-card__next-code">${nextHome.code || ""}</span>
                ${nextHome.flag
                  ? html`<span class="wc-card__next-flag" aria-hidden="true"
                      >${nextHome.flag}</span
                    >`
                  : nothing}
              </div>
              <div class="wc-card__next-when">
                <span class="wc-card__next-time"
                  >${formatKickoff(next.kickoff)}</span
                >
                <span class="wc-card__next-date"
                  >${formatKickoffDay(next.kickoff)}</span
                >
              </div>
              <div class="wc-card__next-team wc-card__next-team--away">
                ${nextAway.flag
                  ? html`<span class="wc-card__next-flag" aria-hidden="true"
                      >${nextAway.flag}</span
                    >`
                  : nothing}
                <span class="wc-card__next-code">${nextAway.code || ""}</span>
              </div>
            </div>
          </div>`
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
        ${nextFooter} ${ariaLive}
        ${data.isMock && this.showMockHint
          ? html`<div class="wc-card__mock-hint">Sample data</div>`
          : nothing}
      </div>`;
  }

  #renderMatchRow(match) {
    const home = match.homeTeam || {};
    const away = match.awayTeam || {};
    const homeScore = home.score ?? "—";
    const awayScore = away.score ?? "—";
    const status = formatRowStatus(match);
    return html`<div class="wc-row" data-status=${match.status || "unknown"}>
      <div class="wc-row__team wc-row__team--home">
        <span class="wc-row__code">${home.code || ""}</span>
        ${home.flag
          ? html`<span class="wc-row__flag" aria-hidden="true">${home.flag}</span>`
          : html`<span class="wc-row__flag wc-row__flag--placeholder" aria-hidden="true"></span>`}
      </div>
      <div class="wc-row__center">
        <div class="wc-row__score">
          <span class="wc-row__score-num">${homeScore}</span>
          <span class="wc-row__score-sep">-</span>
          <span class="wc-row__score-num">${awayScore}</span>
        </div>
        ${status
          ? html`<div class="wc-row__status">${status}</div>`
          : nothing}
      </div>
      <div class="wc-row__team wc-row__team--away">
        ${away.flag
          ? html`<span class="wc-row__flag" aria-hidden="true">${away.flag}</span>`
          : html`<span class="wc-row__flag wc-row__flag--placeholder" aria-hidden="true"></span>`}
        <span class="wc-row__code">${away.code || ""}</span>
      </div>
    </div>`;
  }

  #renderPagination(totalPages) {
    if (totalPages <= 1) {
      return nothing;
    }
    const dots = [];
    for (let i = 0; i < totalPages; i++) {
      dots.push(
        html`<span
          class=${`wc-pagination__dot ${
            i === this._pageIndex ? "wc-pagination__dot--active" : ""
          }`}
          aria-hidden="true"
        ></span>`
      );
    }
    const prevDisabled = this._pageIndex === 0;
    const nextDisabled = this._pageIndex === totalPages - 1;
    return html`<div class="wc-pagination" role="group" aria-label="Match results pages">
      <button
        type="button"
        class="wc-pagination__arrow"
        ?disabled=${prevDisabled}
        aria-label="Previous results"
        @click=${this.#onPagePrev}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="wc-pagination__dots">${dots}</div>
      <button
        type="button"
        class="wc-pagination__arrow"
        ?disabled=${nextDisabled}
        aria-label="Next results"
        @click=${this.#onPageNext}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>`;
  }

  #renderResults(cssLink) {
    const matches = this.data?.matches || [];
    const totalPages = Math.ceil(matches.length / MATCHES_PER_PAGE);
    const start = this._pageIndex * MATCHES_PER_PAGE;
    const visible = matches.slice(start, start + MATCHES_PER_PAGE);

    return html`${cssLink}
      <div class="wc-card wc-card--list" data-state="results">
        <div class="wc-card__header">
          <span class="wc-card__eyebrow">Results</span>
        </div>
        <div class="wc-card__rows">
          ${visible.map(m => this.#renderMatchRow(m))}
        </div>
        ${this.#renderPagination(totalPages)}
        ${this.data.isMock && this.showMockHint
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

    if (Array.isArray(this.data.matches) && this.data.matches.length > 0) {
      return this.#renderResults(cssLink);
    }

    return this.#renderLoaded(cssLink);
  }
}
customElements.define("world-cup-match-card", WorldCupMatchCard);
