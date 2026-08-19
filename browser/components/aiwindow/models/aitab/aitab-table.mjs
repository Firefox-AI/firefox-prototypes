/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://browser/content/aiwindow/aitab/lit.mjs";
import {
  AitabElement,
  ensureSheet,
} from "chrome://browser/content/aiwindow/aitab/aitab-element.mjs";
import {
  fieldsByRole,
  httpUrl,
} from "chrome://browser/content/aiwindow/aitab/aitab-util.mjs";

ensureSheet("chrome://browser/content/aiwindow/aitab/aitab-table.css");

function formatField(field, row) {
  const raw = row?.[field.key];
  if (raw == null || raw === "") {
    return "";
  }
  const prefix = field.prefix || "";
  const suffix = field.suffix || "";
  switch (field.type) {
    case "currency": {
      const amount = Number(raw);
      if (Number.isFinite(amount)) {
        try {
          return `${prefix}${new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: field.currency || "USD",
          }).format(amount)}${suffix}`;
        } catch {
          return `${prefix}${amount}${suffix}`;
        }
      }
      return `${prefix}${raw}${suffix}`;
    }
    case "rating":
      return `${raw} / ${field.max || 5}`;
    case "boolean":
      return raw ? "Yes" : "No";
    case "tags":
      return Array.isArray(raw) ? raw.join(", ") : String(raw);
    default:
      return `${prefix}${raw}${suffix}`;
  }
}

/**
 *
 */
export class AitabTable extends AitabElement {
  static properties = {
    block: { type: Object },
  };

  render() {
    const block = this.block || {};
    if (block.layout == "matrix") {
      return this.#matrix(block);
    }
    return this.#ranked(block);
  }

  #ranked(block) {
    const { title, subtitle, details, action } = fieldsByRole(block.fields);
    const columns = [title, ...details].filter(Boolean);
    const rows = block.data || [];
    return html`
      <section class="aitab-block aitab-table" data-layout="ranked">
        ${block.title || block.description
          ? html`<div class="aitab-block-head">
              ${block.title ? html`<h2>${block.title}</h2>` : nothing}
              ${block.description
                ? html`<p class="aitab-desc">${block.description}</p>`
                : nothing}
            </div>`
          : nothing}
        <div class="aitab-ranked" data-details=${details.length}>
          <div class="aitab-ranked-head">
            ${columns.map(
              field => html`<span>${field.label || field.key || ""}</span>`
            )}
          </div>
          ${rows.map(row => {
            const href = action ? httpUrl(row?.[action.key]) : null;
            const cells = html`
              <span class="aitab-ranked-name">
                ${title
                  ? html`<span class="aitab-ranked-title"
                      >${formatField(title, row)}</span
                    >`
                  : nothing}
                ${subtitle
                  ? html`<span class="aitab-ranked-sub"
                      >${formatField(subtitle, row)}</span
                    >`
                  : nothing}
              </span>
              ${details.map(
                field =>
                  html`<span class="aitab-ranked-cell"
                    >${formatField(field, row)}</span
                  >`
              )}
            `;
            if (href) {
              return html`<a
                class="aitab-ranked-row"
                href=${href}
                target="_blank"
                rel="noopener noreferrer"
                >${cells}</a
              >`;
            }
            return html`<div class="aitab-ranked-row">${cells}</div>`;
          })}
        </div>
      </section>
    `;
  }

  #matrix(block) {
    const columns = block.columns || [];
    const rows = block.rows || [];
    return html`
      <section class="aitab-block aitab-table" data-layout="matrix">
        ${block.title
          ? html`<h2 class="aitab-display-title">${block.title}</h2>`
          : nothing}
        ${block.description
          ? html`<p class="aitab-desc aitab-desc-center">
              ${block.description}
            </p>`
          : nothing}
        <div
          class="aitab-matrix"
          data-cols=${Math.min(Math.max(columns.length, 1), 4)}
        >
          <div></div>
          ${columns.map(
            column => html`
              <div class="aitab-matrix-colhead">
                ${column.label
                  ? html`<span class="aitab-super">${column.label}</span>`
                  : nothing}
                <span class="aitab-matrix-name">${column.name}</span>
              </div>
            `
          )}
          ${rows.map(
            row => html`
              <div class="aitab-matrix-label">${row.label}</div>
              ${(row.cells || []).map(
                cell => html`
                  <div
                    class="aitab-matrix-cell ${cell.winner
                      ? "aitab-winner"
                      : ""}"
                  >
                    <span>${cell.value}</span>
                    ${cell.note
                      ? html`<span class="aitab-note">${cell.note}</span>`
                      : nothing}
                  </div>
                `
              )}
            `
          )}
        </div>
      </section>
    `;
  }
}

customElements.define("aitab-table", AitabTable);
