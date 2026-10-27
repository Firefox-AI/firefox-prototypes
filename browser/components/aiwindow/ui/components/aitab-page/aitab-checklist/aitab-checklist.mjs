/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { editableText } from "chrome://browser/content/aiwindow/components/aitab-editable.mjs";

export const TOGGLE_ITEM_EVENT = "aitab-checklist:toggle";

/**
 * Smart Page block for things to buy, pack, book or do, ticked off on the page.
 */
export class AITabChecklist extends MozLitElement {
  static properties = {
    title: { type: String },
    description: { type: String },
    groups: { type: Array },
    checked: { type: Object, attribute: false },
    edits: { type: Object, attribute: false },
  };

  constructor() {
    super();
    this.title = "";
    this.description = "";
    this.groups = [];
    this.checked = null;
    this.edits = null;
  }

  #itemId(item) {
    return item.id || item.text;
  }

  #onToggle(item, event) {
    this.dispatchEvent(
      new CustomEvent(TOGGLE_ITEM_EVENT, {
        bubbles: true,
        composed: true,
        detail: { id: this.#itemId(item), checked: event.target.checked },
      })
    );
  }

  #renderIntro(checkedCount, total) {
    const edits = this.edits;
    return html`<div class="aitab-checklist-intro">
      ${this.title
        ? html`<h2 class="aitab-heading-3">
            ${editableText(this.title, { edits, path: "title" })}
          </h2>`
        : nothing}
      ${this.description
        ? html`<p class="aitab-deemphasized">
            ${editableText(this.description, { edits, path: "description" })}
          </p>`
        : nothing}
      <span
        class="aitab-checklist-progress aitab-eyebrow"
        data-l10n-id="aitab-checklist-progress"
        data-l10n-args=${JSON.stringify({ checked: checkedCount, total })}
      ></span>
    </div>`;
  }

  #renderGroupHeading(group, groupIndex) {
    if (!group.heading) {
      return nothing;
    }
    const heading = editableText(group.heading, {
      edits: this.edits,
      path: `groups/${groupIndex}/heading`,
    });
    return this.title
      ? html`<h3 class="aitab-checklist-group-heading aitab-heading-4">
          ${heading}
        </h3>`
      : html`<h2 class="aitab-checklist-group-heading aitab-heading-4">
          ${heading}
        </h2>`;
  }

  #renderItem(item, groupIndex, itemIndex) {
    const path = `groups/${groupIndex}/items/${itemIndex}`;
    const textId = `item-${groupIndex}-${itemIndex}`;
    const isChecked = !!this.checked?.[this.#itemId(item)];
    return html`<li class="aitab-checklist-item" ?data-checked=${isChecked}>
      <input
        type="checkbox"
        class="aitab-checklist-checkbox"
        aria-labelledby=${textId}
        .checked=${isChecked}
        @change=${event => this.#onToggle(item, event)}
      />
      <div class="aitab-checklist-item-content">
        <span class="aitab-checklist-item-text">
          ${editableText(item.text, {
            edits: this.edits,
            path: `${path}/text`,
            id: textId,
          })}
        </span>
        ${item.detail
          ? html`<span class="aitab-checklist-item-detail aitab-deemphasized">
              ${editableText(item.detail, {
                edits: this.edits,
                path: `${path}/detail`,
              })}
            </span>`
          : nothing}
      </div>
    </li>`;
  }

  #renderGroup(group, groupIndex) {
    return html`<div class="aitab-checklist-group">
      ${this.#renderGroupHeading(group, groupIndex)}
      <ul class="aitab-checklist-items">
        ${group.items.map((item, itemIndex) =>
          this.#renderItem(item, groupIndex, itemIndex)
        )}
      </ul>
    </div>`;
  }

  render() {
    const groups = (this.groups ?? [])
      .map(group => ({
        ...group,
        items: (group?.items ?? []).filter(item => item?.text),
      }))
      .filter(group => group.items.length);
    if (!groups.length) {
      return nothing;
    }

    const items = groups.flatMap(group => group.items);
    const checkedCount = items.filter(
      item => this.checked?.[this.#itemId(item)]
    ).length;

    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/aitab-base.css"
      />
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/aitab-checklist.css"
      />
      <section class="aitab-checklist">
        ${this.#renderIntro(checkedCount, items.length)}
        <div class="aitab-checklist-groups">
          ${groups.map((group, groupIndex) =>
            this.#renderGroup(group, groupIndex)
          )}
        </div>
      </section>
    `;
  }
}

customElements.define("aitab-checklist", AITabChecklist);
