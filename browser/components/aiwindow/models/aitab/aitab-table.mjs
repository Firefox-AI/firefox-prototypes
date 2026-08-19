/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://browser/content/aiwindow/aitab/lit.mjs";
import { AitabElement } from "chrome://browser/content/aiwindow/aitab/aitab-element.mjs";
import { httpUrl } from "chrome://browser/content/aiwindow/aitab/aitab-util.mjs";

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

function fieldCell(field, row) {
  const raw = row?.[field.key];
  if (field.type == "url") {
    const url = httpUrl(raw);
    if (!url) {
      return "";
    }
    return html`<a href=${url} target="_blank" rel="noopener noreferrer"
      >${field.label || "Open"}</a
    >`;
  }
  if (field.type == "image") {
    const url = httpUrl(raw);
    return url ? html`<img class="aitab-thumb" src=${url} alt="" />` : nothing;
  }
  return formatField(field, row);
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
    const fields = block.fields || [];
    const rows = block.data || [];
    return html`
      <section class="aitab-block aitab-table" data-layout="ranked">
        ${block.title ? html`<h2>${block.title}</h2>` : nothing}
        ${block.description
          ? html`<p class="aitab-desc">${block.description}</p>`
          : nothing}
        <div class="aitab-table-wrap">
          <table>
            <thead>
              <tr>
                ${fields.map(
                  field => html`<th>${field.label || field.key}</th>`
                )}
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                row => html`
                  <tr>
                    ${fields.map(
                      field => html`<td>${fieldCell(field, row)}</td>`
                    )}
                  </tr>
                `
              )}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  #matrix(block) {
    const columns = block.columns || [];
    const rows = block.rows || [];
    return html`
      <section class="aitab-block aitab-table" data-layout="matrix">
        ${block.title ? html`<h2>${block.title}</h2>` : nothing}
        ${block.description
          ? html`<p class="aitab-desc">${block.description}</p>`
          : nothing}
        <div class="aitab-table-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                ${columns.map(
                  column => html`
                    <th>
                      ${column.label
                        ? html`<span class="aitab-eyebrow"
                            >${column.label}</span
                          >`
                        : nothing}
                      ${column.name}
                    </th>
                  `
                )}
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                row => html`
                  <tr>
                    <th scope="row">${row.label}</th>
                    ${(row.cells || []).map(
                      cell => html`
                        <td class=${cell.winner ? "aitab-winner" : ""}>
                          ${cell.value}
                          ${cell.note
                            ? html`<span class="aitab-note">${cell.note}</span>`
                            : nothing}
                        </td>
                      `
                    )}
                  </tr>
                `
              )}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }
}

customElements.define("aitab-table", AitabTable);
