/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://browser/content/aiwindow/aitab/lit.mjs";
import { AitabElement } from "chrome://browser/content/aiwindow/aitab/aitab-element.mjs";
import { httpUrl } from "chrome://browser/content/aiwindow/aitab/aitab-util.mjs";

/**
 *
 */
export class AitabCards extends AitabElement {
  static properties = {
    block: { type: Object },
  };

  render() {
    const block = this.block || {};
    return html`
      <section
        class="aitab-block aitab-cards"
        data-layout=${block.layout || "picks"}
      >
        ${block.title ? html`<h2>${block.title}</h2>` : nothing}
        <div class="aitab-card-grid">
          ${(block.items || []).map(item => this.#card(item))}
        </div>
      </section>
    `;
  }

  #card(item) {
    const url = httpUrl(item.href);
    const image = httpUrl(item.image);
    const favicon = httpUrl(item.favicon);
    const body = html`
      ${image
        ? html`<img class="aitab-card-image" src=${image} alt="" />`
        : nothing}
      ${item.eyebrow
        ? html`<p class="aitab-eyebrow">${item.eyebrow}</p>`
        : nothing}
      ${item.value
        ? html`<p class="aitab-card-value">${item.value}</p>`
        : nothing}
      ${item.title ? html`<h3>${item.title}</h3>` : nothing}
      ${item.subtitle
        ? html`<p class="aitab-card-sub">
            ${favicon
              ? html`<img class="aitab-favicon" src=${favicon} alt="" />`
              : nothing}${item.subtitle}
          </p>`
        : nothing}
    `;
    if (url) {
      return html`
        <a
          class="aitab-card"
          href=${url}
          target="_blank"
          rel="noopener noreferrer"
          >${body}</a
        >
      `;
    }
    return html`<article class="aitab-card">${body}</article>`;
  }
}

customElements.define("aitab-cards", AitabCards);
