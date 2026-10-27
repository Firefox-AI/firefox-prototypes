/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { editableText } from "chrome://browser/content/aiwindow/components/aitab-editable.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/ai-website-chip.mjs";

/** @typedef {{ favicon?: string, title?: string, href: string }} SourceLink */

/**
 * @property {string} heading - A heading for the text block section
 * @property {Array} paragraphs - Array of one or two paragraphs to be set
 * on the right side of this component
 * @property {SourceLink[]} references - Pages this report was built from.
 */
export class AITextBlock extends MozLitElement {
  static properties = {
    heading: { type: String },
    paragraphs: { type: Array },
    references: { type: Array },
    edits: { type: Object, attribute: false },
  };

  constructor() {
    super();
    this.heading = "";
    this.paragraphs = [];
    this.references = [];
    this.edits = null;
  }

  #renderReferences() {
    if (!this.references.length) {
      return nothing;
    }

    return html` <div class="aitab-text-block-references">
      ${this.references.map(
        chip =>
          html`<ai-website-chip
            class="aitab-text-block-chip"
            .href=${chip.href}
            .label=${chip.title || chip.href}
            .iconSrc=${chip.favicon ?? ""}
            type="context-chip"
            size="small"
            openLinkEvent="AITab:OpenLink"
          ></ai-website-chip>`
      )}
    </div>`;
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/aitab-base.css"
      />
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/aitab-text-block.css"
      />
      <section class="aitab-text-block">
        <h2 class="aitab-text-block-heading aitab-heading-3">
          ${editableText(this.heading, { edits: this.edits, path: "heading" })}
        </h2>
        <div class="aitab-text-block-content">
          ${this.paragraphs.map(
            (p, index) =>
              html`<p class="aitab-text-block-p">
                ${editableText(p, {
                  edits: this.edits,
                  path: `paragraphs/${index}`,
                })}
              </p>`
          )}
          ${this.#renderReferences()}
        </div>
      </section>
    `;
  }
}

customElements.define("aitab-text-block", AITextBlock);
