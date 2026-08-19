/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://browser/content/aiwindow/aitab/lit.mjs";
import {
  AitabElement,
  ensureSheet,
} from "chrome://browser/content/aiwindow/aitab/aitab-element.mjs";

ensureSheet("chrome://browser/content/aiwindow/aitab/aitab-list.css");

/**
 *
 */
export class AitabList extends AitabElement {
  static properties = {
    block: { type: Object },
  };

  render() {
    const block = this.block || {};
    return html`
      <section
        class="aitab-block aitab-list"
        data-layout=${block.layout || "takeaways"}
      >
        ${block.title
          ? html`<h2 class="aitab-display-title">${block.title}</h2>`
          : nothing}
        <ol class="aitab-takeaways">
          ${(block.items || []).map(
            (item, index) => html`
              <li>
                <div class="aitab-takeaway-claim">
                  <span class="aitab-index"
                    >${item.number || String(index + 1).padStart(2, "0")}</span
                  >
                  ${item.title ? html`<h3>${item.title}</h3>` : nothing}
                </div>
                <div class="aitab-takeaway-evidence">
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

customElements.define("aitab-list", AitabList);
