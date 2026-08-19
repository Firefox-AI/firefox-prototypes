/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://browser/content/aiwindow/aitab/lit.mjs";
import { ensureSheet } from "chrome://browser/content/aiwindow/aitab/aitab-element.mjs";
import { httpUrl } from "chrome://browser/content/aiwindow/aitab/aitab-util.mjs";

ensureSheet("chrome://browser/content/aiwindow/aitab/aitab-blocks.css");

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

export function renderHeader(header) {
  if (!header) {
    return nothing;
  }
  return html`
    <header class="aitab-header">
      ${header.eyebrow
        ? html`<p class="aitab-kicker">${header.eyebrow}</p>`
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

export function renderFooter(footer) {
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

export function renderText(block) {
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
          ${block.title
            ? html`<h2 class="aitab-side-title">${block.title}</h2>`
            : nothing}
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

export function renderUnknown(block) {
  return html`
    <section class="aitab-block aitab-unknown">
      <p>Unsupported block: ${block?.type || "unknown"}</p>
    </section>
  `;
}
