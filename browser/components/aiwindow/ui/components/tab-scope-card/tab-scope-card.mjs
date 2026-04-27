/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

export class TabScopeCard extends MozLitElement {
  static properties = {
    proposal: { type: Object, attribute: false },
    state: { type: String, state: true },
  };

  constructor() {
    super();
    this.proposal = null;
    this.state = "default";
  }

  #emit(action) {
    const payload = {
      action,
      destination: this.proposal?.destination,
      tab_ids: this.proposal?.matched_tabs?.map(t => t.url) ?? [],
    };
    if (action === "use") {
      this.state = "accepted";
      this.dispatchEvent(
        new CustomEvent("AIChatContent:DispatchFollowUp", {
          bubbles: true,
          composed: true,
          detail: {
            text: `Use these ${payload.tab_ids.length} tabs as research scope and plan the trip.`,
            tabScope: payload,
          },
        })
      );
    } else if (action === "skip") {
      this.state = "skipped";
      this.dispatchEvent(
        new CustomEvent("AIChatContent:DispatchFollowUp", {
          bubbles: true,
          composed: true,
          detail: {
            text: "Skip the tabs and plan the trip from general knowledge.",
            tabScope: { action: "skip" },
          },
        })
      );
    } else if (action === "revoke") {
      this.state = "revoked";
      this.dispatchEvent(
        new CustomEvent("trip:revoke-tab-scope", {
          bubbles: true,
          composed: true,
        })
      );
    }
    this.requestUpdate();
  }

  render() {
    const cssLink = html`<link
      rel="stylesheet"
      href="chrome://browser/content/aiwindow/components/tab-scope-card.css"
    />`;
    if (!this.proposal || this.state === "skipped") {
      return nothing;
    }
    const tabs = this.proposal.matched_tabs || [];
    const dest = this.proposal.destination || "this destination";

    if (this.state === "accepted") {
      return html`${cssLink}
        <div class="tab-scope-summary">
          Using titles from ${tabs.length} ${dest} tab${tabs.length === 1 ? "" : "s"} -
          revoke when you close this trip
          <button
            class="tab-scope-revoke"
            @click=${() => this.#emit("revoke")}
            aria-label="Revoke tab scope"
          >
            ×
          </button>
        </div>`;
    }

    if (this.state === "revoked") {
      return html`${cssLink}
        <div class="tab-scope-summary tab-scope-revoked">
          Tab access ended.
        </div>`;
    }

    return html`
      ${cssLink}
      <div class="tab-scope-card">
        <div class="tab-scope-headline">
          <span class="tab-scope-glyph" aria-hidden="true">🗂</span>
          I see ${tabs.length} tabs about ${dest}. Use these as research scope?
        </div>
        <div class="tab-scope-favicons">
          ${tabs.slice(0, 5).map(
            t => html`<img
              class="tab-scope-favicon"
              src=${t.favicon || `page-icon:${t.url}`}
              alt=${t.title || t.url}
            />`
          )}
          ${tabs.length > 5
            ? html`<span class="tab-scope-more">+${tabs.length - 5} more</span>`
            : nothing}
        </div>
        <div class="tab-scope-explainer">
          Used only for this trip - ends when you close it. Titles and URLs only
          (page contents are not read in v1).
        </div>
        <div class="tab-scope-actions">
          <button
            class="tab-scope-primary"
            @click=${() => this.#emit("use")}
          >
            Use these tabs
          </button>
          <button
            class="tab-scope-ghost"
            @click=${() => this.#emit("skip")}
          >
            Skip
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define("tab-scope-card", TabScopeCard);
