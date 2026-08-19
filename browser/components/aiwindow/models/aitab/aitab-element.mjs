/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { LitElement } from "chrome://browser/content/aiwindow/aitab/lit.mjs";

export function ensureSheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) {
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
}

/**
 *
 */
export class AitabElement extends LitElement {
  createRenderRoot() {
    return this;
  }
}
