/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/jev-trace-strip.mjs";

const BLOCKED_TEXT = {
  jev_blocked: "the agent couldn't find a way forward",
  no_progress: "three actions in a row changed nothing",
  consent_loop: "a consent dialog kept coming back",
  budget: "it ran out of steps",
  seed_failed: "the search page didn't return results",
  bot_challenge: "the site asked for human verification",
};

const CHIP_GLYPH = { pending: "○", ok: "✓", missing: "✗", unknown: "?" };
const CHIP_WORD = {
  pending: "not yet checked",
  ok: "verified on the page",
  missing: "not found on the page",
  unknown: "couldn't be confirmed",
};

const SMART_WINDOW_ICON =
  "chrome://browser/content/aiwindow/assets/smart-window.svg";
const ERROR_ICON = "chrome://global/skin/icons/error.svg";
const GATE_ARM_MS = 500;
const RESULTS_DESCRIBED = "results as described";

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * General-browse artifact for the `browse_and_extract` tool: compiled
 * requirement chips, loading status, confirmation gate, up to five result
 * rows and the trace strip. Mirrors every render to the parent as a
 * `browse-card-snapshot` event (QA oracle).
 *
 * @property {object} data - Tool result body / card properties
 */
export class BrowseResultsCard extends MozLitElement {
  static properties = {
    data: { type: Object },
    stopping: { type: Boolean, state: true },
    gateBusy: { type: String, state: true },
    gateArmed: { type: Boolean, state: true },
  };

  #startedAt = null;
  #countdownId = null;
  #armId = null;
  #armedGateId = null;
  #armedAt = 0;
  #lastSnapshotKey = null;

  constructor() {
    super();
    this.data = null;
    this.stopping = false;
    this.gateBusy = "";
    this.gateArmed = false;
  }

  get #state() {
    const d = this.data;
    const status = d?.status;
    if (!d || !status || status === "running") {
      return d?.progress?.phase === "awaiting_confirmation" && d?.pending_gate
        ? "awaiting_confirmation"
        : "loading";
    }
    if (status === "done") {
      return "loaded";
    }
    if (status === "empty") {
      return "empty";
    }
    return "error";
  }

  get #reason() {
    const d = this.data ?? {};
    switch (d.status) {
      case "blocked":
        return "blocked";
      case "cancelled":
        return d.reason ?? "cancelled";
      case "error":
        return d.reason ?? "network";
      case "done":
        return d.reason ?? null;
    }
    return null;
  }

  get #host() {
    const d = this.data ?? {};
    return (
      hostOf(d.source_url) ||
      hostOf(d.progress?.current_url) ||
      hostOf(d.start_url) ||
      "the page"
    );
  }

  get #siteName() {
    const d = this.data ?? {};
    if (d.site_resolution === "search") {
      return d.site || d.site_display || "";
    }
    return d.site_display || d.site || hostOf(d.start_url) || "";
  }

  willUpdate() {
    const state = this.#state;
    const reason = this.#reason;
    this.dataset.state = state;
    this.dataset.kind = "browse";
    if (reason) {
      this.dataset.reason = reason;
    } else {
      delete this.dataset.reason;
    }
    if (state !== "loading") {
      this.stopping = false;
    }
    if (state === "awaiting_confirmation") {
      const id = this.data?.pending_gate?.id ?? "";
      if (id !== this.#armedGateId) {
        this.#armedGateId = id;
        this.gateBusy = "";
        this.#arm();
        this.#startCountdown();
      }
    } else {
      this.#armedGateId = null;
      this.gateBusy = "";
      this.gateArmed = false;
      this.#clearTimers();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#clearTimers();
  }

  firstUpdated() {
    this.#snapshot();
  }

  updated() {
    this.#snapshot();
  }

  #clearTimers() {
    if (this.#countdownId) {
      clearInterval(this.#countdownId);
      this.#countdownId = null;
    }
    if (this.#armId) {
      clearTimeout(this.#armId);
      this.#armId = null;
    }
  }

  #arm() {
    this.gateArmed = false;
    if (this.#armId) {
      clearTimeout(this.#armId);
    }
    this.#armedAt = performance.now() + GATE_ARM_MS;
    this.#armId = setTimeout(() => {
      this.#armId = null;
      this.gateArmed = true;
    }, GATE_ARM_MS);
  }

  #deadline() {
    const g = this.data?.pending_gate;
    let requested = Date.now();
    if (typeof g?.requested_at === "number") {
      requested = g.requested_at;
    } else if (typeof g?.requested_at === "string") {
      const t = Date.parse(g.requested_at);
      if (!Number.isNaN(t)) {
        requested = t;
      }
    }
    const timeout = Number(this.data?.gate_timeout_ms) || 60000;
    return requested + timeout;
  }

  #footnoteText() {
    const remaining = Math.max(0, Math.ceil((this.#deadline() - Date.now()) / 1000));
    return remaining > 0
      ? `Stops on its own in ${remaining} s if you don't answer.`
      : "Stopping…";
  }

  #startCountdown() {
    if (this.#countdownId) {
      clearInterval(this.#countdownId);
    }
    // The countdown writes to the node directly; it never re-renders the
    // card, so it produces no snapshots.
    this.#countdownId = setInterval(() => {
      const node = this.renderRoot?.querySelector(".gate-footnote");
      if (node) {
        node.textContent = this.#footnoteText();
      }
    }, 1000);
  }

  #requirements() {
    const d = this.data ?? {};
    if (Array.isArray(d.card_requirements) && d.card_requirements.length) {
      return d.card_requirements;
    }
    return (d.plan?.requirements ?? []).map(r => ({
      id: r.id,
      display: r.display,
      state: "pending",
    }));
  }

  #snapshot() {
    const root = this.shadowRoot;
    if (!root) {
      return;
    }
    const footnote = root.querySelector(".gate-footnote")?.textContent ?? "";
    let text = (root.textContent || "").replace(/\s+/g, " ").trim();
    const heading = root.querySelector(".card-title")?.textContent?.trim() ?? "";
    const reqs = [...root.querySelectorAll("li.req-chip")].map(li => ({
      id: li.dataset.reqId ?? "",
      display: li.dataset.display ?? "",
      state: li.dataset.reqState ?? "",
    }));
    const count = root.querySelectorAll("li.result").length;
    const key = JSON.stringify([
      this.#state,
      this.#reason,
      heading,
      count,
      reqs,
      text.replace(footnote.replace(/\s+/g, " ").trim(), ""),
    ]);
    if (key === this.#lastSnapshotKey) {
      return;
    }
    this.#lastSnapshotKey = key;
    text = text.slice(0, 8000);
    this.dispatchEvent(
      new CustomEvent("browse-card-snapshot", {
        bubbles: true,
        composed: true,
        detail: {
          card_kind: "browse",
          card_state: this.#state,
          card_reason: this.#reason,
          card_heading: heading,
          rendered_result_count: count,
          card_requirements: reqs,
          card_text: text,
        },
      })
    );
  }

  #emit(name, detail = {}) {
    this.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true, detail })
    );
  }

  #cancel() {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.#emit("browse-card-cancel");
  }

  #gateClick(event, approve) {
    const id = this.data?.pending_gate?.id ?? null;
    if (!id || this.gateBusy || !this.gateArmed) {
      return;
    }
    if (event?.timeStamp && event.timeStamp < this.#armedAt) {
      return;
    }
    this.gateBusy = approve ? "approve" : "decline";
    this.#emit(approve ? "browse-card-approve" : "browse-card-decline", {
      gate_id: id,
    });
  }

  #openSource(event) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    event.preventDefault();
    this.#emit("browse-card-open-source", {
      href: this.data?.source_url ?? null,
    });
  }

  #openTab() {
    this.#emit("browse-card-open-source", {
      href: this.data?.source_url ?? null,
    });
  }

  #openResult(event, href) {
    event.preventDefault();
    const { shiftKey, metaKey, ctrlKey, altKey, button } = event;
    const hasModifier =
      shiftKey || metaKey || ctrlKey || altKey || button !== 0;
    this.dispatchEvent(
      new CustomEvent("AIChatContent:OpenLink", {
        bubbles: true,
        composed: true,
        detail: {
          url: href,
          preferSwitchToTab: !hasModifier,
          shiftKey,
          metaKey,
          ctrlKey,
          altKey,
          button,
        },
      })
    );
  }

  #title() {
    const d = this.data ?? {};
    const state = this.#state;
    if (state === "loading") {
      const displays = this.#requirements().map(r => r.display);
      if (d.site_resolution === "search") {
        return `Looking for ${this.#siteName || "your request"}…`;
      }
      const site = this.#siteName || this.#host;
      return displays.length
        ? `Searching ${site}: ${displays.join(", ")}`
        : `Searching ${site}`;
    }
    if (state === "awaiting_confirmation") {
      return "Needs your OK";
    }
    if (state === "loaded") {
      return `Found on ${this.#host}`;
    }
    if (state === "empty") {
      return `Reached ${this.#host} but couldn't read any results.`;
    }
    switch (this.#reason) {
      case "missing_key":
      case "invalid_args":
        return "Can't start the browsing agent";
      case "network":
        return "Couldn't reach Jev";
      case "blocked":
        return `Got stuck on ${this.#host}`;
      case "cancelled":
      case "gate_declined":
      case "confirmation_timeout":
        return "Stopped";
      case "timeout":
        return "That took too long";
    }
    return "Something went wrong";
  }

  #statusLine() {
    const p = this.data?.progress ?? {};
    if (p.phase === "verifying") {
      return "Checking the page against your request…";
    }
    if (p.phase === "extracting") {
      return "Reading the results…";
    }
    if (p.phase === "browsing" && p.step > 0) {
      if (p.last_typed && typeof p.last_typed.value === "string") {
        return `Step ${p.step}: Typed "${p.last_typed.value}" into ${p.last_typed.label}`;
      }
      return `Step ${p.step}: ${p.last_action ?? ""}`;
    }
    if (p.phase === "browsing") {
      return "Starting…";
    }
    return "Opening a tab…";
  }

  #missingText() {
    const d = this.data ?? {};
    const missing = d.verifier?.missing ?? [];
    return missing.length ? missing.join(", ") : RESULTS_DESCRIBED;
  }

  #blockedText() {
    const d = this.data ?? {};
    if (d.reason === "done_unverified") {
      return `it said it was done but ${this.#missingText()} wasn't visible`;
    }
    return BLOCKED_TEXT[d.reason] ?? "it could not continue";
  }

  #errorMessage() {
    const d = this.data ?? {};
    const last = (d.gate_events ?? []).at(-1);
    switch (this.#reason) {
      case "missing_key":
        return "Jev API key isn't configured for this profile. Launch with launch.sh (it reads ~/.firefox-prototype-secrets/jev-api-key) and try again.";
      case "invalid_args":
        if (d.error_text && /^Please write the dates/.test(d.error_text)) {
          return d.error_text;
        }
        return `Couldn't start: ${d.error_text || "the request was invalid"}.`;
      case "network":
        return `Couldn't reach Jev (${d.error_text || "connection failed"}). The tab is yours.`;
      case "blocked":
        return `I got stuck on ${this.#host}: ${this.#blockedText()}. The tab is yours.`;
      case "gate_declined":
        return `Stopped before clicking "${last?.label ?? ""}". The tab is yours.`;
      case "confirmation_timeout": {
        const s = Math.round(
          (last?.waited_ms ?? Number(d.gate_timeout_ms) ?? 60000) / 1000
        );
        return `Stopped: no answer on the confirmation within ${s} s. The tab is yours.`;
      }
      case "cancelled":
        return "Stopped. The tab is yours.";
      case "timeout": {
        const seconds = Math.round((d.timings?.total_elapsed_ms ?? 0) / 1000);
        return `Stopped after ${seconds} seconds without reaching what you asked for. The tab is yours.`;
      }
    }
    return `Something went wrong${d.error_text ? ` (${d.error_text})` : ""}. The tab is yours.`;
  }

  #header(withOpenTab = false) {
    const title = this.#title();
    return html`<div class="card-header">
      <img class="card-icon" src=${SMART_WINDOW_ICON} alt="" />
      <h3 class="card-title" id="card-title" title=${title}>${title}</h3>
      ${withOpenTab
        ? html`<moz-button
            class="open-tab"
            type="ghost"
            size="small"
            @click=${this.#openTab}
            >Open tab</moz-button
          >`
        : nothing}
    </div>`;
  }

  #chips() {
    const reqs = this.#requirements();
    if (!reqs.length) {
      return nothing;
    }
    return html`<ul class="requirements">
      ${reqs.map(r => {
        const state = CHIP_GLYPH[r.state] ? r.state : "pending";
        return html`<li
          class="req-chip"
          data-req-state=${state}
          data-req-id=${r.id ?? ""}
          data-display=${r.display ?? ""}
        >
          <span class="req-glyph" aria-hidden="true">${CHIP_GLYPH[state]}</span>
          <span class="req-text">${r.display}</span>
          <span class="sr-only">: ${CHIP_WORD[state]}</span>
        </li>`;
      })}
    </ul>`;
  }

  #verifierNote() {
    const note = this.data?.verifier_note;
    if (!note) {
      return nothing;
    }
    return html`<p class="verifier-note">Verifier note: ${note}</p>`;
  }

  #sourceRow() {
    const d = this.data ?? {};
    if (!d.source_url) {
      return nothing;
    }
    const label = d.source_title || hostOf(d.source_url) || d.source_url;
    return html`<div class="source-row">
      <img
        class="favicon"
        src=${`page-icon:${d.source_url}`}
        alt=""
        @error=${e => {
          e.target.src = SMART_WINDOW_ICON;
        }}
      />
      <a
        data-source
        href=${d.source_url}
        title=${d.source_url}
        @click=${this.#openSource}
        >${label}</a
      >
      <span class="open-in-new" aria-hidden="true"></span>
    </div>`;
  }

  #trace(live) {
    const d = this.data ?? {};
    const elapsed = live
      ? Math.max(0, Date.now() - (this.#startedAt ?? Date.now()))
      : (d.timings?.loop_elapsed_ms ?? 0);
    const blockedText = d.status === "blocked" ? this.#blockedText() : "";
    return html`<jev-trace-strip
      .steps=${d.trace ?? []}
      .status=${live ? "running" : d.status}
      .reason=${d.reason ?? null}
      .elapsedMs=${elapsed}
      .reobserved=${d.reobserved ?? 0}
      .errorText=${d.error_text ?? ""}
      .gateEvents=${d.gate_events ?? []}
      .doneLabel=${"Done: verified on the page"}
      .blockedText=${blockedText}
    ></jev-trace-strip>`;
  }

  #renderLoading() {
    if (!this.#startedAt) {
      this.#startedAt = Date.now();
    }
    return html`
      ${this.#header()} ${this.#chips()}
      <div class="status-block">
        <div class="status-row">
          <p class="status-line" aria-live="polite">${this.#statusLine()}</p>
          <moz-button
            class="cancel"
            type="ghost"
            size="small"
            ?disabled=${this.stopping}
            @click=${this.#cancel}
            >${this.stopping ? "Stopping…" : "Cancel"}</moz-button
          >
        </div>
        <div class="progress" role="progressbar" aria-label="Browsing">
          <div class="progress-thumb"></div>
        </div>
        <p class="egress-line">
          Sending page details and typed values to Jev (TypeSafe) and your
          Smart Window model.
        </p>
      </div>
      ${this.#trace(true)}
    `;
  }

  #renderGate() {
    if (!this.#startedAt) {
      this.#startedAt = Date.now();
    }
    const g = this.data?.pending_gate ?? {};
    const host = hostOf(g.url) || this.#host;
    const label = g.label ?? "";
    const disabled = Boolean(this.gateBusy) || !this.gateArmed;
    let body;
    if (g.kind === "page") {
      body = label && label !== "button"
        ? html`Jev wants to click <q class="gate-label">${label}</q> on a checkout page at ${host}. Allow this one click?`
        : html`Jev wants to click a button on a checkout page at ${host}. Allow this one click?`;
    } else {
      body = html`Jev wants to click <q class="gate-label">${label}</q> on ${host}. That looks like it could book, reserve, or pay. Allow this one click?`;
    }
    return html`
      ${this.#header()} ${this.#chips()}
      <div class="gate-block" data-gate-id=${g.id ?? ""}>
        <p class="gate-body" role="status">${body}</p>
        <div class="gate-actions">
          <moz-button
            class="approve"
            type="default"
            size="small"
            ?disabled=${disabled}
            @click=${e => this.#gateClick(e, true)}
            >${this.gateBusy === "approve" ? "Allowing…" : "Allow this click"}</moz-button
          >
          <moz-button
            class="decline"
            type="default"
            size="small"
            ?disabled=${disabled}
            @click=${e => this.#gateClick(e, false)}
            >${this.gateBusy === "decline" ? "Stopping…" : "Stop"}</moz-button
          >
        </div>
        <p class="gate-footnote" aria-live="off">${this.#footnoteText()}</p>
      </div>
      ${this.#trace(true)}
    `;
  }

  #results() {
    const rows = (this.data?.results ?? []).slice(0, 5);
    if (!rows.length) {
      return nothing;
    }
    const inner = r => html`<div class="result-main">
        <strong class="result-title">${r.title}</strong>
        <span class="result-price">${r.price}</span>
      </div>
      ${r.subtitle
        ? html`<span class="result-subtitle" title=${r.subtitle}>${r.subtitle}</span>`
        : nothing}`;
    return html`<ol class="results">
      ${rows.map(
        (r, i) => html`<li class="result" data-index=${i}>
          ${r.href
            ? html`<a
                class="result-link"
                href=${r.href}
                @click=${e => this.#openResult(e, r.href)}
                >${inner(r)}</a
              >`
            : inner(r)}
        </li>`
      )}
    </ol>`;
  }

  #renderLoaded() {
    return html`
      ${this.#header(true)} ${this.#chips()} ${this.#verifierNote()}
      ${this.#results()} ${this.#sourceRow()} ${this.#trace(false)}
    `;
  }

  #renderEmpty() {
    return html`
      ${this.#header(true)} ${this.#chips()} ${this.#verifierNote()}
      ${this.#sourceRow()} ${this.#trace(false)}
    `;
  }

  #renderError() {
    const reason = this.#reason;
    const bare = reason === "missing_key" || reason === "invalid_args";
    const glyph = ["blocked", "network", "timeout", "missing_key", "invalid_args"].includes(reason);
    const note = reason === "blocked" ? this.#verifierNote() : nothing;
    return html`
      ${this.#header()} ${bare ? nothing : this.#chips()}
      <p class=${glyph ? "message error" : "message"}>
        ${glyph
          ? html`<img class="message-icon" src=${ERROR_ICON} alt="" aria-hidden="true" />`
          : nothing}
        <span>${this.#errorMessage()}</span>
      </p>
      ${bare ? nothing : html`${note} ${this.#sourceRow()} ${this.#trace(false)}`}
    `;
  }

  render() {
    const state = this.#state;
    let body;
    switch (state) {
      case "loading":
        body = this.#renderLoading();
        break;
      case "awaiting_confirmation":
        body = this.#renderGate();
        break;
      case "loaded":
        body = this.#renderLoaded();
        break;
      case "empty":
        body = this.#renderEmpty();
        break;
      default:
        body = this.#renderError();
    }
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/browse-results-card.css"
      />
      <div
        class="card"
        role="group"
        aria-labelledby="card-title"
        aria-busy=${state === "loading" ? "true" : "false"}
      >
        ${body}
      </div>
    `;
  }
}

customElements.define("browse-results-card", BrowseResultsCard);
