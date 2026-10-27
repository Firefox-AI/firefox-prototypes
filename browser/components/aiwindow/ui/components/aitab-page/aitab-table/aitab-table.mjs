/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { httpUrl } from "chrome://browser/content/aiwindow/modules/AITabUtils.mjs";
import {
  editableText,
  editedText,
} from "chrome://browser/content/aiwindow/components/aitab-editable.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/ai-website-chip.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-select.mjs";

/**
 * A column of the table, as described by the RankedTable `Field` schema in
 * component_schema.json.
 *
 * @typedef {object} Field
 * @property {string} key - Property read from each row object.
 * @property {string} [label] - Column heading; falls back to `key`.
 * @property {"text"|"number"|"currency"|"rating"|"date"} type - How the value
 *   is formatted.
 * @property {"title"|"subtitle"|"detail"} [role] - Where the value renders:
 *   title and subtitle share the first column, detail gets its own column.
 * @property {string} [prefix] - Text put before every value.
 * @property {string} [suffix] - Text put after every value.
 * @property {number} [max] - Denominator for `rating`.
 * @property {string} [currency] - ISO 4217 code for `currency`.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T/;
const NUMERIC_TYPES = new Set(["number", "currency", "rating"]);
const MAX_FILTER_OPTIONS = 8;
const SORT_DIRECTIONS = ["ascending", "descending"];

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const formatters = new Map();

/**
 * @param {string} key
 * @param {Function} create
 * @returns {Intl.NumberFormat|Intl.DateTimeFormat}
 */
function formatter(key, create) {
  let instance = formatters.get(key);
  if (!instance) {
    instance = create();
    formatters.set(key, instance);
  }
  return instance;
}

function numberFormatter() {
  return formatter("number", () => new Intl.NumberFormat());
}

function ratingFormatter() {
  return formatter(
    "rating",
    () => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })
  );
}

function currencyFormatter(currency) {
  return formatter(
    `currency:${currency}`,
    () =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        trailingZeroDisplay: "stripIfInteger",
      })
  );
}

function dateFormatter(timeZone) {
  return formatter(
    `date:${timeZone ?? ""}`,
    () => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone })
  );
}

/**
 * Formats a row's value for one column. Only machine-typed values are
 * formatted: numbers, and dates written as ISO 8601. A value the model already
 * wrote out as text, in whatever language and notation, is shown as it is.
 *
 * @param {Field} field
 * @param {object} row
 * @returns {string|import("lit").TemplateResult}
 */
function formatValue(field, row) {
  const value = row?.[field.key];
  if (value == null || value === "") {
    return "";
  }
  const prefix = field.prefix ?? "";
  const suffix = field.suffix ?? "";
  const isNumber = typeof value == "number" && Number.isFinite(value);
  switch (field.type) {
    case "number": {
      const text = isNumber ? numberFormatter().format(value) : value;
      return `${prefix}${text}${suffix}`;
    }
    case "currency": {
      if (!isNumber) {
        return `${prefix}${value}${suffix}`;
      }
      let text;
      try {
        text = currencyFormatter(field.currency ?? "USD").format(value);
      } catch {
        // The model gave a currency code Intl does not know.
        text = numberFormatter().format(value);
      }
      return `${prefix}${text}${suffix}`;
    }
    case "rating": {
      if (!isNumber) {
        return `${prefix}${value}${suffix}`;
      }
      const args = JSON.stringify({
        value: ratingFormatter().format(value),
        max: numberFormatter().format(field.max ?? 5),
      });
      return html`${prefix}<span
          data-l10n-id="ai-tab-table-rating"
          data-l10n-args=${args}
        ></span
        >${suffix}`;
    }
    case "date": {
      const isoDate =
        typeof value == "string" &&
        (DATE_ONLY.test(value) || ISO_DATE_TIME.test(value));
      const date = isoDate ? new Date(value) : null;
      if (!date || Number.isNaN(date.valueOf())) {
        return `${prefix}${value}${suffix}`;
      }
      const timeZone = DATE_ONLY.test(value) ? "UTC" : undefined;
      return `${prefix}${dateFormatter(timeZone).format(date)}${suffix}`;
    }
    default:
      return `${prefix}${value}${suffix}`;
  }
}

function compareValues(a, b) {
  if (typeof a == "number" && typeof b == "number") {
    return a - b;
  }
  return collator.compare(String(a), String(b));
}

/**
 * Compares a small set of items across a few text attributes: a header row of
 * column labels and one row per item, whose name leads the row and can carry
 * a chip naming the site the item came from.
 *
 * @property {string} heading - Short title above the table.
 * @property {string} description - Optional one-sentence subtitle.
 * @property {Field[]} columns - Column definitions.
 * @property {object[]} rows - One object per item, keyed by the column keys.
 *   An optional `href` is the page the item came from, rendered as a source
 *   chip in the name cell.
 */
export class AITabTable extends MozLitElement {
  static properties = {
    heading: { type: String },
    description: { type: String },
    columns: { type: Array, attribute: false },
    rows: { type: Array, attribute: false },
    edits: { type: Object, attribute: false },
    sortKey: { type: String, state: true },
    sortDirection: { type: String, state: true },
    filters: { type: Object, state: true },
  };

  constructor() {
    super();
    this.heading = "";
    this.description = "";
    this.columns = [];
    this.rows = [];
    this.edits = null;
    this.sortKey = null;
    this.sortDirection = null;
    this.filters = {};
  }

  /**
   * Splits the columns by where they render. The first column that is not a
   * subtitle stands in as the title when no column claims that role.
   *
   * @returns {{title: ?Field, subtitles: Field[], details: Field[]}}
   */
  get #columnsByRole() {
    const title =
      this.columns.find(field => field.role == "title") ??
      this.columns.find(field => field.role != "subtitle");
    const subtitles = this.columns.filter(field => field.role == "subtitle");
    const details = this.columns.filter(
      field => field !== title && field.role != "subtitle"
    );
    return { title, subtitles, details };
  }

  #label(field) {
    return field.label || field.key;
  }

  #cellPath(rowIndex, field) {
    return `rows/${rowIndex}/${field.key}`;
  }

  #cellContent(field, row, rowIndex) {
    const formatted = formatValue(field, row);
    if (typeof formatted != "string" || !formatted) {
      return formatted;
    }
    return editableText(formatted, {
      edits: this.edits,
      path: this.#cellPath(rowIndex, field),
    });
  }

  #cellText(field, row, rowIndex) {
    const formatted = formatValue(field, row);
    if (typeof formatted == "string") {
      return editedText(
        formatted,
        this.edits?.[this.#cellPath(rowIndex, field)]
      );
    }
    return String(row?.[field.key] ?? "");
  }

  #sortValue(field, row, rowIndex) {
    const value = row?.[field.key];
    const text = this.#cellText(field, row, rowIndex);
    if (!NUMERIC_TYPES.has(field.type)) {
      return text;
    }
    const corrected = this.edits?.[this.#cellPath(rowIndex, field)];
    if (typeof value == "number" && Number.isFinite(value) && !corrected) {
      return value;
    }
    const number = parseFloat(text.replace(/[^\d.-]/g, ""));
    return Number.isFinite(number) ? number : text;
  }

  #filterOptions(field) {
    const options = new Map();
    this.rows.forEach((row, rowIndex) => {
      const text = this.#cellText(field, row, rowIndex);
      if (text && !options.has(text)) {
        options.set(text, this.#sortValue(field, row, rowIndex));
      }
    });
    if (
      options.size < 2 ||
      options.size > MAX_FILTER_OPTIONS ||
      options.size >= this.rows.length
    ) {
      return null;
    }
    return [...options]
      .sort(([, a], [, b]) => compareValues(a, b))
      .map(([text]) => text);
  }

  #activeFilters(filterable) {
    return filterable.filter(({ field, options }) =>
      options.includes(this.filters[field.key])
    );
  }

  #visibleRows(columns, activeFilters) {
    let entries = this.rows.map((row, rowIndex) => ({ row, rowIndex }));
    for (const { field } of activeFilters) {
      const wanted = this.filters[field.key];
      entries = entries.filter(
        ({ row, rowIndex }) => this.#cellText(field, row, rowIndex) == wanted
      );
    }

    const sortField = columns.find(field => field.key == this.sortKey);
    if (!sortField || !this.sortDirection) {
      return entries;
    }
    const direction = this.sortDirection == "descending" ? -1 : 1;
    const keyed = entries.map(entry => ({
      ...entry,
      key: this.#sortValue(sortField, entry.row, entry.rowIndex),
    }));
    return keyed.sort((a, b) => {
      if (a.key === "" || b.key === "") {
        return (a.key === "") - (b.key === "");
      }
      return direction * compareValues(a.key, b.key);
    });
  }

  #toggleSort(field) {
    if (this.sortKey != field.key) {
      this.sortKey = field.key;
      this.sortDirection = SORT_DIRECTIONS[0];
      return;
    }
    const next = SORT_DIRECTIONS.indexOf(this.sortDirection) + 1;
    this.sortDirection = SORT_DIRECTIONS[next] ?? null;
    if (!this.sortDirection) {
      this.sortKey = null;
    }
  }

  #setFilter(field, value) {
    const filters = { ...this.filters };
    if (value) {
      filters[field.key] = value;
    } else {
      delete filters[field.key];
    }
    this.filters = filters;
  }

  #renderColumnHeading(field) {
    const sorted = this.sortKey == field.key ? this.sortDirection : null;
    return html`<th scope="col" aria-sort=${sorted ?? nothing}>
      <button
        class="aitab-table-sort"
        data-sort=${sorted ?? nothing}
        @click=${() => this.#toggleSort(field)}
      >
        ${this.#label(field)}
      </button>
    </th>`;
  }

  #renderFilters(filterable, activeFilters) {
    if (!filterable.length) {
      return nothing;
    }
    return html`<div class="aitab-table-filters">
      ${filterable.map(
        ({ field, options }) =>
          html`<moz-select
            class="aitab-table-filter"
            .label=${this.#label(field)}
            .value=${this.filters[field.key] ?? ""}
            @change=${event => this.#setFilter(field, event.target.value)}
          >
            <moz-option
              value=""
              data-l10n-id="aitab-table-filter-all"
            ></moz-option>
            ${options.map(
              option =>
                html`<moz-option
                  .value=${option}
                  .label=${option}
                ></moz-option>`
            )}
          </moz-select>`
      )}
      ${activeFilters.length
        ? html`<moz-button
            class="aitab-table-filter-clear"
            type="ghost"
            data-l10n-id="aitab-table-filter-clear"
            @click=${() => {
              this.filters = {};
            }}
          ></moz-button>`
        : nothing}
    </div>`;
  }

  #renderSourceChip(row) {
    const url = httpUrl(row?.href);
    if (!url) {
      return nothing;
    }
    return html`<ai-website-chip
      class="aitab-table-source"
      type="context-chip"
      size="small"
      .label=${url.hostname}
      .href=${url.href}
      .iconSrc=${`page-icon:${url.href}`}
      openLinkEvent="AITab:OpenLink"
    ></ai-website-chip>`;
  }

  #renderRow(row, rowIndex, { title, subtitles, details }) {
    const subtitleFields = subtitles.filter(field => formatValue(field, row));
    return html`<tr>
      <th scope="row">
        <div class="aitab-table-name-cell">
          <span class="aitab-table-name"
            >${this.#cellContent(title, row, rowIndex)}</span
          >
          ${subtitleFields.map(
            field =>
              html`<span class="aitab-table-subtitle"
                >${this.#cellContent(field, row, rowIndex)}</span
              >`
          )}
          ${this.#renderSourceChip(row)}
        </div>
      </th>
      ${details.map(
        field => html`<td>${this.#cellContent(field, row, rowIndex)}</td>`
      )}
    </tr>`;
  }

  #renderRows(entries, columnCount, roles) {
    if (!this.rows.length) {
      return nothing;
    }
    if (!entries.length) {
      return html`<tr>
        <td
          class="aitab-table-empty"
          colspan=${columnCount}
          data-l10n-id="aitab-table-filter-empty"
        ></td>
      </tr>`;
    }
    return entries.map(({ row, rowIndex }) =>
      this.#renderRow(row, rowIndex, roles)
    );
  }

  render() {
    const { title, subtitles, details } = this.#columnsByRole;
    if (!title) {
      return nothing;
    }
    const columns = [title, ...details];
    const filterable = columns
      .map(field => ({ field, options: this.#filterOptions(field) }))
      .filter(({ options }) => options);
    const activeFilters = this.#activeFilters(filterable);
    const entries = this.#visibleRows(columns, activeFilters);
    const heading = editableText(this.heading, {
      edits: this.edits,
      path: "heading",
    });
    const description = editableText(this.description, {
      edits: this.edits,
      path: "description",
    });
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/aitab-base.css"
      />
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/aitab-table.css"
      />
      <section class="aitab-table">
        ${this.heading
          ? html`<h2 id="heading" class="aitab-heading-3">${heading}</h2>`
          : nothing}
        ${this.description
          ? html`<p class="aitab-table-description">${description}</p>`
          : nothing}
        ${this.#renderFilters(filterable, activeFilters)}
        <table
          aria-labelledby=${this.heading ? "heading" : nothing}
          data-details=${details.length}
        >
          <colgroup>
            <col class="aitab-table-name-col" />
          </colgroup>
          <thead>
            <tr>
              ${columns.map(field => this.#renderColumnHeading(field))}
            </tr>
          </thead>
          <tbody>
            ${this.#renderRows(entries, columns.length, {
              title,
              subtitles,
              details,
            })}
          </tbody>
        </table>
      </section>
    `;
  }
}

customElements.define("aitab-table", AITabTable);
