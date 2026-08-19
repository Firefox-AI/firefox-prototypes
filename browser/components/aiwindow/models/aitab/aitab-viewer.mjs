/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unprivileged AITab viewer. Reads the page config from location.hash and
 * renders it with plain LitElement (light DOM) so the same module can later
 * ship in a saved HTML file. Swap lit.mjs to point at a public Lit build
 * when this document is opened outside Firefox.
 *
 * Simple blocks (header / text / footer) are html`` functions. Heavier blocks
 * (table / cards / list / timeline) are light-DOM LitElements.
 */

import {
  LitElement,
  html,
} from "chrome://browser/content/aiwindow/aitab/lit.mjs";
import {
  renderFooter,
  renderHeader,
  renderText,
  renderUnknown,
} from "chrome://browser/content/aiwindow/aitab/aitab-blocks.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/aitab/aitab-table.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/aitab/aitab-cards.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/aitab/aitab-list.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/aitab/aitab-timeline.mjs";

const VIEWER_CSS = "chrome://browser/content/aiwindow/aitab/aitab-viewer.css";

function renderBlock(block) {
  switch (block?.type) {
    case "text":
      return renderText(block);
    case "table":
      return html`<aitab-table .block=${block}></aitab-table>`;
    case "cards":
      return html`<aitab-cards .block=${block}></aitab-cards>`;
    case "list":
      return html`<aitab-list .block=${block}></aitab-list>`;
    case "timeline":
      return html`<aitab-timeline .block=${block}></aitab-timeline>`;
    default:
      return renderUnknown(block);
  }
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
        ${(this.page.blocks || []).map(block => renderBlock(block))}
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
