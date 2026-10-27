/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";

export const EDIT_TEXT_EVENT = "aitab-editable:change";

export function editedText(text, edit) {
  return edit && edit.original === text ? edit.text : text;
}

function onKeyDown(event) {
  const element = event.currentTarget;
  if (event.key == "Enter" && !event.shiftKey) {
    event.preventDefault();
    element.blur();
  } else if (event.key == "Escape") {
    element.textContent = element.aitabShown;
    element.blur();
  }
}

function onBlur(event) {
  const element = event.currentTarget;
  const text = element.textContent.replace(/\s+/g, " ").trim();
  if (!text || text == element.aitabShown) {
    element.textContent = element.aitabShown;
    return;
  }
  element.dispatchEvent(
    new CustomEvent(EDIT_TEXT_EVENT, {
      bubbles: true,
      composed: true,
      detail: {
        path: element.aitabPath,
        original: element.aitabOriginal,
        text,
      },
    })
  );
}

export function editableText(text, { edits, path, id }) {
  const shown = editedText(text, edits?.[path]);
  return html`<span
    class="aitab-editable"
    contenteditable="plaintext-only"
    spellcheck="true"
    id=${id ?? nothing}
    .aitabPath=${path}
    .aitabOriginal=${text}
    .aitabShown=${shown}
    .textContent=${shown}
    @keydown=${onKeyDown}
    @blur=${onBlur}
  ></span>`;
}
