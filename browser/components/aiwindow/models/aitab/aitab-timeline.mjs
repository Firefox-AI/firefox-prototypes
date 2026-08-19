/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://browser/content/aiwindow/aitab/lit.mjs";
import { AitabElement } from "chrome://browser/content/aiwindow/aitab/aitab-element.mjs";

/**
 *
 */
export class AitabTimeline extends AitabElement {
  static properties = {
    block: { type: Object },
  };

  render() {
    const block = this.block || {};
    return html`
      <section
        class="aitab-block aitab-timeline"
        data-layout=${block.layout || "side-title"}
      >
        <div class="aitab-side">
          ${block.title ? html`<h2>${block.title}</h2>` : nothing}
          ${block.description ? html`<p>${block.description}</p>` : nothing}
        </div>
        <ol class="aitab-timeline-items">
          ${(block.items || []).map(
            item => html`
              <li data-state=${item.state || "upcoming"}>
                <div class="aitab-when">
                  ${item.label
                    ? html`<p class="aitab-label">${item.label}</p>`
                    : nothing}
                  ${item.sublabel
                    ? html`<p class="aitab-sublabel">${item.sublabel}</p>`
                    : nothing}
                </div>
                <div class="aitab-event">
                  ${item.eyebrow
                    ? html`<p class="aitab-eyebrow">${item.eyebrow}</p>`
                    : nothing}
                  <h3>${item.title}</h3>
                  ${item.body ? html`<p>${item.body}</p>` : nothing}
                </div>
              </li>
            `
          )}
        </ol>
      </section>
    `;
  }
}

customElements.define("aitab-timeline", AitabTimeline);
