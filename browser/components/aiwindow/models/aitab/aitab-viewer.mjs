/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unprivileged AITab viewer. Reads the page config from location.hash and
 * renders it with plain LitElement (light DOM) so the same module can later
 * ship in a saved HTML file. Swap lit.mjs to point at a public Lit build
 * when this document is opened outside Firefox.
 */

import {
  LitElement,
  html,
  nothing,
} from "chrome://browser/content/aiwindow/aitab/lit.mjs";

const VIEWER_CSS = "chrome://browser/content/aiwindow/aitab/aitab-viewer.css";

function httpUrl(value) {
  const parsed = URL.parse(String(value ?? "").trim());
  if (parsed?.protocol == "https:" || parsed?.protocol == "http:") {
    return parsed.href;
  }
  return null;
}

function parseHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) {
    return { page: null, error: null };
  }
  try {
    const page = JSON.parse(decodeURIComponent(raw));
    if (!page || typeof page != "object" || !Array.isArray(page.blocks)) {
      return { page: null, error: "The hash is not a page config." };
    }
    return { page, error: null };
  } catch {
    return { page: null, error: "The hash is not valid JSON." };
  }
}

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

function chip(text, href, variant = "secondary") {
  const url = httpUrl(href);
  if (url) {
    return html`
      <a
        class="aitab-chip"
        data-variant=${variant}
        href=${url}
        target="_blank"
        rel="noopener noreferrer"
      >
        ${text}
      </a>
    `;
  }
  return html`<span class="aitab-chip" data-variant=${variant}>${text}</span>`;
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

function renderHeader(header) {
  if (!header) {
    return nothing;
  }
  return html`
    <header class="aitab-header">
      ${header.eyebrow
        ? html`<p class="aitab-eyebrow">${header.eyebrow}</p>`
        : nothing}
      <h1 class="aitab-title">
        ${header.icon
          ? html`<span class="aitab-icon" aria-hidden="true"
              >${header.icon}</span
            >`
          : nothing}${header.title}
      </h1>
      ${header.subhead
        ? html`<p class="aitab-subhead">${header.subhead}</p>`
        : nothing}
    </header>
  `;
}

function renderFooter(footer) {
  if (!footer) {
    return nothing;
  }
  return html`
    <footer class="aitab-footer">
      ${footer.text
        ? html`<p class="aitab-footer-text">${footer.text}</p>`
        : nothing}
      <div class="aitab-chips">
        ${(footer.buttons || []).map(button =>
          chip(button.text, button.href, button.variant)
        )}
      </div>
    </footer>
  `;
}

function renderText(block) {
  const paragraphs = (block.paragraphs || []).map(
    paragraph => html`<p>${paragraph}</p>`
  );
  if (block.layout == "subheads") {
    return html`
      <section class="aitab-block aitab-text" data-layout="subheads">
        ${block.title ? html`<h2>${block.title}</h2>` : nothing}
        ${(block.sections || []).map(
          section => html`
            <section class="aitab-text-section">
              <h3>${section.heading}</h3>
              <p>${section.body}</p>
            </section>
          `
        )}
      </section>
    `;
  }
  if (block.layout == "side-title") {
    return html`
      <section class="aitab-block aitab-text" data-layout="side-title">
        <div class="aitab-side">
          ${block.title ? html`<h2>${block.title}</h2>` : nothing}
          ${block.subtitle ? html`<p>${block.subtitle}</p>` : nothing}
        </div>
        <div class="aitab-side-body">
          ${block.lead
            ? html`<p class="aitab-lead">${block.lead}</p>`
            : nothing}
          ${paragraphs}
        </div>
      </section>
    `;
  }
  return html`
    <section class="aitab-block aitab-text" data-layout="summary">
      ${block.title ? html`<h2>${block.title}</h2>` : nothing}
      ${block.lead ? html`<p class="aitab-lead">${block.lead}</p>` : nothing}
      ${paragraphs}
    </section>
  `;
}

function renderRankedTable(block) {
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
              ${fields.map(field => html`<th>${field.label || field.key}</th>`)}
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

function renderMatrixTable(block) {
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
                      ? html`<span class="aitab-eyebrow">${column.label}</span>`
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

function renderTable(block) {
  if (block.layout == "matrix") {
    return renderMatrixTable(block);
  }
  return renderRankedTable(block);
}

function renderCards(block) {
  return html`
    <section
      class="aitab-block aitab-cards"
      data-layout=${block.layout || "picks"}
    >
      ${block.title ? html`<h2>${block.title}</h2>` : nothing}
      <div class="aitab-card-grid">
        ${(block.items || []).map(item => {
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
          return url
            ? html`<a
                class="aitab-card"
                href=${url}
                target="_blank"
                rel="noopener noreferrer"
                >${body}</a
              >`
            : html`<article class="aitab-card">${body}</article>`;
        })}
      </div>
    </section>
  `;
}

function renderList(block) {
  return html`
    <section
      class="aitab-block aitab-list"
      data-layout=${block.layout || "takeaways"}
    >
      ${block.title ? html`<h2>${block.title}</h2>` : nothing}
      <ol class="aitab-takeaways">
        ${(block.items || []).map(
          (item, index) => html`
            <li>
              <span class="aitab-index"
                >${item.number || String(index + 1).padStart(2, "0")}</span
              >
              <div>
                ${item.title ? html`<h3>${item.title}</h3>` : nothing}
                ${item.body ? html`<p>${item.body}</p>` : nothing}
              </div>
            </li>
          `
        )}
      </ol>
    </section>
  `;
}

function renderTimeline(block) {
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

const BLOCKS = {
  text: renderText,
  table: renderTable,
  cards: renderCards,
  list: renderList,
  timeline: renderTimeline,
};

function renderUnknown(block) {
  return html`
    <section class="aitab-block aitab-unknown">
      <p>Unsupported block: ${block?.type || "unknown"}</p>
    </section>
  `;
}

/**
 *
 */
export class AitabPage extends LitElement {
  static properties = {
    page: { type: Object },
    error: { type: String },
  };

  constructor() {
    super();
    this.page = null;
    this.error = "";
  }

  createRenderRoot() {
    return this;
  }

  updated() {
    const title = this.page?.header?.title;
    if (title) {
      document.title = title;
    }
  }

  render() {
    if (this.error) {
      return html`<p class="aitab-status" role="alert">${this.error}</p>`;
    }
    if (!this.page) {
      return html`<p class="aitab-status">No page config in the URL hash.</p>`;
    }
    return html`
      ${renderHeader(this.page.header)}
      <main class="aitab-main">
        ${(this.page.blocks || []).map(
          block => BLOCKS[block?.type]?.(block) ?? renderUnknown(block)
        )}
      </main>
      ${renderFooter(this.page.footer)}
    `;
  }
}

customElements.define("aitab-page", AitabPage);

function ensureViewerStyles() {
  if (document.querySelector(`link[href="${VIEWER_CSS}"]`)) {
    return;
  }
  for (const link of [...document.querySelectorAll('link[rel="stylesheet"]')]) {
    link.remove();
  }
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = VIEWER_CSS;
  document.head.append(css);
}

function applyHash(host) {
  const { page, error } = parseHash();
  host.page = page;
  host.error = error || "";
}

function startViewer() {
  document.documentElement.dataset.aitabViewer = "";
  ensureViewerStyles();
  let host = document.querySelector("aitab-page");
  if (!host) {
    host = document.createElement("aitab-page");
    document.body.replaceChildren(host);
  }
  applyHash(host);
  window.addEventListener("hashchange", () => applyHash(host));
}

async function startTasks() {
  // eslint-disable-next-line import/no-unassigned-import
  await import("chrome://browser/content/aiwindow/components/ai-tasks.mjs");
  if (!document.querySelector("ai-tasks")) {
    document.body.replaceChildren(document.createElement("ai-tasks"));
  }
}

async function boot() {
  if (location.hash.length > 1) {
    startViewer();
    return;
  }
  await startTasks();
}

if (document.readyState == "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
