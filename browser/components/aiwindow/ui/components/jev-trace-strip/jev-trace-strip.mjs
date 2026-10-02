/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const GLYPHS = {
  CLICK: "chrome://global/skin/icons/arrow-right-12.svg",
  TYPE_TEXT: "chrome://global/skin/icons/edit.svg",
  SELECT: "chrome://global/skin/icons/check.svg",
  SCROLL_DOWN: "chrome://global/skin/icons/arrow-down-12.svg",
  SCROLL_UP: "chrome://global/skin/icons/arrow-up-12.svg",
  WAIT: "chrome://global/skin/icons/reload.svg",
  done: "chrome://global/skin/icons/check.svg",
  blocked: "chrome://global/skin/icons/error.svg",
  network: "chrome://global/skin/icons/error.svg",
  timeout: "chrome://global/skin/icons/error.svg",
  cancelled: "chrome://browser/content/aiwindow/assets/stop-generation.svg",
};

const BLOCKED_TEXT = {
  jev_blocked: "the agent couldn't find a way forward",
  no_progress: "three actions in a row changed nothing",
  consent_loop: "a consent dialog kept coming back",
  done_unverified: "it said it was done but no ingredient list was visible",
  budget: "it ran out of steps",
  seed_failed: "the search page didn't return results",
};

const VERB = {
  CLICK: "clicked",
  TYPE_TEXT: "typed into",
  SELECT: "selected",
  SCROLL_DOWN: "scrolled down",
  SCROLL_UP: "scrolled up",
  WAIT: "waited",
};

function fmtSeconds(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s > 0 && s < 0.1) {
    return "0.1s";
  }
  return `${s.toFixed(1)}s`;
}

/**
 * Collapsed trace of executed steps for the Jev browse loop. One chip per
 * executed step plus a terminal chip; rejected and stale decisions are only
 * counted in the summary row.
 *
 * @property {Array} steps - Executed steps ({ operation, target_label, probability, latency_ms })
 * @property {string} status - running | done | empty | blocked | error | cancelled
 * @property {string} reason - Terminal reason code
 * @property {number} elapsedMs - Loop elapsed time
 * @property {number} reobserved - Count of rejected/stale decisions
 * @property {string} errorText - Status text for network failures
 */
export class JevTraceStrip extends MozLitElement {
  static properties = {
    steps: { type: Array },
    status: { type: String },
    reason: { type: String },
    elapsedMs: { type: Number, attribute: "elapsed-ms" },
    reobserved: { type: Number },
    errorText: { type: String, attribute: "error-text" },
    expanded: { type: Boolean, reflect: true },
  };

  constructor() {
    super();
    this.steps = [];
    this.status = "running";
    this.reason = null;
    this.elapsedMs = 0;
    this.reobserved = 0;
    this.errorText = "";
    this.expanded = false;
  }

  willUpdate() {
    this.dataset.stepCount = String(this.steps?.length ?? 0);
    this.dataset.status = this.status ?? "";
  }

  #toggle() {
    this.expanded = !this.expanded;
  }

  get #live() {
    return this.status === "running";
  }

  #terminal() {
    switch (this.status) {
      case "done":
        return { kind: "done", label: "Done: ingredients visible" };
      case "empty":
        return { kind: "done", label: "Done: no ingredient list found" };
      case "blocked":
        return {
          kind: "blocked",
          label: `Blocked: ${BLOCKED_TEXT[this.reason] ?? this.reason ?? "stuck"}`,
        };
      case "cancelled":
        return { kind: "cancelled", label: "Stopped by you" };
      case "error":
        if (this.reason === "timeout") {
          return { kind: "timeout", label: "Timed out" };
        }
        if (this.reason === "network") {
          return {
            kind: "network",
            label: `Couldn't reach Jev (${this.errorText || "connection failed"})`,
          };
        }
        return null;
    }
    return null;
  }

  #summaryText() {
    const n = this.steps?.length ?? 0;
    if (this.#live && n === 0) {
      return "Starting…";
    }
    let text = `${n} ${n === 1 ? "step" : "steps"} · ${(Math.max(0, this.elapsedMs || 0) / 1000).toFixed(1)} s`;
    if (this.#live) {
      text += " so far";
    }
    if (this.reobserved > 0) {
      text += ` · ${this.reobserved} re-observed`;
    }
    return text;
  }

  #renderStep(step, i) {
    const op = step.operation ?? "CLICK";
    const fullLabel =
      op === "SCROLL_DOWN"
        ? "Scrolled down"
        : op === "SCROLL_UP"
          ? "Scrolled up"
          : op === "WAIT"
            ? "Waited"
            : (step.target_label ?? "");
    const label =
      fullLabel.length > 28 ? `${fullLabel.slice(0, 27)}…` : fullLabel;
    const prob =
      typeof step.probability === "number"
        ? `${Math.round(step.probability * 100)}%`
        : "";
    const latency = fmtSeconds(step.latency_ms);
    const aria = `Step ${i + 1}: ${VERB[op] ?? op.toLowerCase()} ${fullLabel}, ${prob ? `${Math.round(step.probability * 100)} percent, ` : ""}${latency.replace("s", " seconds")}`;
    return html`<li
      class="step-chip"
      data-operation=${op}
      data-probability=${step.probability ?? ""}
      data-latency-ms=${step.latency_ms ?? ""}
      aria-label=${aria}
    >
      <img
        class="step-op"
        src=${GLYPHS[op] ?? GLYPHS.CLICK}
        title=${op}
        alt=""
        aria-hidden="true"
      />
      <span class="step-label" title=${fullLabel}>${label}</span>
      <span class="step-prob">${prob}</span>
      <span class="step-latency">${latency}</span>
    </li>`;
  }

  #renderTerminal() {
    const terminal = this.#terminal();
    if (!terminal) {
      return nothing;
    }
    return html`<li
      class=${`step-chip terminal terminal-${terminal.kind}`}
      aria-label=${terminal.label}
    >
      <img
        class="step-op"
        src=${GLYPHS[terminal.kind]}
        title=${terminal.kind}
        alt=""
        aria-hidden="true"
      />
      <span class="step-label" title=${terminal.label}>${terminal.label}</span>
      <span class="step-prob"></span>
      <span class="step-latency">${fmtSeconds(this.elapsedMs)}</span>
    </li>`;
  }

  render() {
    const steps = this.steps ?? [];
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/jev-trace-strip.css"
      />
      <button
        class="trace-summary"
        aria-expanded=${this.expanded ? "true" : "false"}
        aria-controls="trace-steps"
        @click=${this.#toggle}
      >
        <span
          class=${`trace-summary-dot${this.#live ? " live" : ""} dot-${this.status}`}
          aria-hidden="true"
        ></span>
        <span class="trace-summary-text">${this.#summaryText()}</span>
        <span class="trace-chevron" aria-hidden="true"></span>
      </button>
      ${this.expanded
        ? html`<ol id="trace-steps" class="trace-steps">
            ${steps.map((s, i) => this.#renderStep(s, i))}
            ${this.#renderTerminal()}
          </ol>`
        : nothing}
    `;
  }
}

customElements.define("jev-trace-strip", JevTraceStrip);
