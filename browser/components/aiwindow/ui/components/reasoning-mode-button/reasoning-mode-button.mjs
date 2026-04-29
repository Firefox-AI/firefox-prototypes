/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/panel-list.mjs";

export const REASONING_MODES = Object.freeze({
  AUTO: "auto",
  THINK: "think",
  QUICK: "quick",
});

const VALID_REASONING_MODES = Object.values(REASONING_MODES);
const REASONING_MODE_ICONS = Object.freeze({
  [REASONING_MODES.AUTO]: "chrome://global/skin/icons/highlights.svg",
  [REASONING_MODES.THINK]: "chrome://global/skin/icons/lightbulb.svg",
  [REASONING_MODES.QUICK]: "chrome://global/skin/icons/performance.svg",
});

/**
 * Smartbar menu button for choosing how much model reasoning to request.
 */
export class ReasoningModeButton extends MozLitElement {
  static properties = {
    mode: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
  };

  constructor() {
    super();
    this.mode = REASONING_MODES.AUTO;
    this.disabled = false;
    this._menuId = `reasoning-mode-menu-${crypto.randomUUID()}`;
  }

  #setMode(mode) {
    if (!VALID_REASONING_MODES.includes(mode)) {
      return;
    }

    this.mode = mode;
    this.dispatchEvent(
      new CustomEvent("aiwindow-reasoning-mode:on-change", {
        detail: { mode },
        bubbles: true,
        composed: true,
      })
    );
  }

  #setMenuOpen(isOpen) {
    this.toggleAttribute("menuopen", isOpen);
  }

  willUpdate(changedProps) {
    if (
      changedProps.has("mode") &&
      !VALID_REASONING_MODES.includes(this.mode)
    ) {
      this.mode = REASONING_MODES.AUTO;
    }
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/reasoning-mode-button.css"
      />
      <moz-button
        type="ghost"
        class="reasoning-mode-button"
        iconsrc=${REASONING_MODE_ICONS[this.mode]}
        .menuId=${this._menuId}
        ?disabled=${this.disabled}
        data-l10n-id=${`aiwindow-reasoning-mode-button-${this.mode}`}
        data-l10n-attrs="label,tooltiptext,aria-label"
      ></moz-button>
      <panel-list
        id=${this._menuId}
        @showing=${() => this.#setMenuOpen(true)}
        @hidden=${() => this.#setMenuOpen(false)}
      >
        ${repeat(
          VALID_REASONING_MODES,
          mode => mode,
          mode => html`
            <panel-item
              @click=${() => this.#setMode(mode)}
              data-l10n-id=${`aiwindow-reasoning-mode-menu-${mode}`}
              type="checkbox"
              ?checked=${this.mode === mode}
            ></panel-item>
          `
        )}
      </panel-list>
    `;
  }
}

customElements.define("reasoning-mode-button", ReasoningModeButton);
