/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const STATES = {
  IDLE: "idle",
  LISTENING: "listening",
  ERROR: "error",
};

const POLL_INTERVAL_MS = 200;
const EMPTY_THRESHOLD = 3;
const STABLE_THRESHOLD = 6;
const ERROR_TOAST_MS = 4000;
const ERROR_RESET_MS = 5000;

const ICONS = {
  idle: "chrome://browser/skin/notification-icons/microphone.svg",
  error: "chrome://browser/skin/notification-icons/microphone-blocked.svg",
};

/**
 * Voice input button for the smartbar. Triggers macOS dictation via the
 * Edit > Start Dictation menu, captures visible text by polling the
 * ProseMirror contenteditable DOM, and auto-submits when speech ends.
 *
 * @property {boolean} disabled
 */
export class VoiceInputButton extends MozLitElement {
  static properties = {
    disabled: { type: Boolean, reflect: true },
    _state: { type: String, state: true },
    _errorMessage: { type: String, state: true },
  };

  constructor() {
    super();
    this.disabled = false;
    this._state = STATES.IDLE;
    this._errorMessage = "";
    this._pollTimer = null;
    this._errorToastTimer = null;
    this._errorResetTimer = null;
    this._boundOnKeydown = this.#onKeydown.bind(this);
    this._dictationActive = false;
    this._lastSeenText = "";
  }

  get state() {
    return this._state;
  }

  get #smartbarInput() {
    const smartbar = this.closest("moz-smartbar");
    return smartbar?.inputField;
  }

  // Read visible text directly from ProseMirror's contenteditable DOM.
  // This includes composition/dictation text that hasn't been committed
  // to ProseMirror's state model yet.
  #getVisibleText() {
    const editor = this.#smartbarInput;
    if (!editor?.shadowRoot) {
      return "";
    }
    const mount = editor.shadowRoot.querySelector(".multiline-editor");
    return mount?.textContent?.trim() || "";
  }

  #setState(newState) {
    this._state = newState;
    this.setAttribute("state", newState);
    this.dispatchEvent(
      new CustomEvent("voice-input:state-change", {
        bubbles: true,
        composed: true,
        detail: { state: newState },
      })
    );
  }

  #onClick() {
    if (this.disabled) {
      return;
    }
    if (this._state === STATES.LISTENING) {
      this.#stopListening({ clearText: true });
    } else if (this._state === STATES.IDLE) {
      this.#startListening();
    }
  }

  async #startListening() {
    const input = this.#smartbarInput;
    if (!input) {
      return;
    }

    this.#setState(STATES.LISTENING);
    this._lastSeenText = "";
    input.focus();

    this.ownerDocument.addEventListener("keydown", this._boundOnKeydown);

    await new Promise(r =>
      this.ownerDocument.defaultView.setTimeout(r, 200)
    );
    if (this._state !== STATES.LISTENING) {
      return;
    }

    try {
      await this.#triggerDictation();
      this._dictationActive = true;

      // Refocus smartbar after the Edit menu interaction shifts focus
      await new Promise(r =>
        this.ownerDocument.defaultView.setTimeout(r, 500)
      );
      if (this._state === STATES.LISTENING) {
        input.focus();
      }

      this.#startPolling();
    } catch (e) {
      console.error("Voice input: Failed to trigger dictation:", e);
      this.#showError(`Voice input failed: ${e.message || e}`);
    }
  }

  #startPolling() {
    let emptyCount = 0;
    let stableCount = 0;
    let prevText = "";

    this._pollTimer = this.ownerDocument.defaultView.setInterval(() => {
      if (this._state !== STATES.LISTENING) {
        this.#stopPolling();
        return;
      }

      const smartbar = this.closest("moz-smartbar");
      const committedVal = smartbar?.untrimmedValue?.trim();
      const visibleText = this.#getVisibleText();
      const currentText = committedVal || visibleText;

      if (currentText) {
        this._lastSeenText = currentText;
        emptyCount = 0;

        if (currentText === prevText) {
          stableCount++;
          // Text stable for STABLE_THRESHOLD polls — dictation paused, submit
          if (stableCount >= STABLE_THRESHOLD) {
            this.#stopPolling();
            this.#submitText();
            return;
          }
        } else {
          stableCount = 0;
        }
        prevText = currentText;
      } else if (this._lastSeenText) {
        // Text was visible but now gone — ProseMirror lost it after
        // dictation ended. Wait a few polls to confirm, then submit.
        emptyCount++;
        if (emptyCount >= EMPTY_THRESHOLD) {
          this.#stopPolling();
          this.#submitText();
          return;
        }
      }
    }, POLL_INTERVAL_MS);
  }

  #stopPolling() {
    if (this._pollTimer) {
      this.ownerDocument.defaultView.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  #stopListening({ clearText = false } = {}) {
    this.#stopPolling();

    if (this._dictationActive) {
      this._dictationActive = false;
      this.#runOsascript(
        'tell application "System Events" to key code 53'
      ).catch(() => {});
    }

    this.ownerDocument.removeEventListener("keydown", this._boundOnKeydown);

    if (clearText) {
      this._lastSeenText = "";
      const smartbar = this.closest("moz-smartbar");
      if (smartbar) {
        smartbar.value = "";
      }
    }

    this.#setState(STATES.IDLE);
  }

  #submitText() {
    const smartbar = this.closest("moz-smartbar");
    const committed = smartbar?.untrimmedValue?.trim();
    const value = committed || this._lastSeenText;

    if (!value) {
      this.#stopListening();
      return;
    }

    this.#stopPolling();
    this.ownerDocument.removeEventListener("keydown", this._boundOnKeydown);
    this._dictationActive = false;

    // Ensure the smartbar has the text before committing
    if (!committed) {
      smartbar.value = value;
    }

    smartbar.dispatchEvent(
      new CustomEvent("smartbar-commit", {
        bubbles: true,
        composed: true,
        detail: {
          value,
          action: "chat",
        },
      })
    );

    smartbar.value = "";
    this._lastSeenText = "";
    this.#setState(STATES.IDLE);
  }

  #onKeydown(event) {
    if (event.key === "Escape" && this._state === STATES.LISTENING) {
      event.preventDefault();
      event.stopPropagation();
      this.#stopListening({ clearText: true });
    }
  }

  #showError(message) {
    this._errorMessage = message;
    this.#setState(STATES.ERROR);

    this._errorToastTimer = setTimeout(() => {
      this._errorMessage = "";
      this.requestUpdate();
    }, ERROR_TOAST_MS);

    this._errorResetTimer = setTimeout(() => {
      this.#setState(STATES.IDLE);
    }, ERROR_RESET_MS);
  }

  async #triggerDictation() {
    const script = [
      'tell application "System Events"',
      "  tell (first process whose frontmost is true)",
      "    tell menu bar 1",
      '      tell menu "Edit"',
      '        click (first menu item whose name contains "Dictation")',
      "      end tell",
      "    end tell",
      "  end tell",
      "end tell",
    ].join("\n");
    await this.#runOsascript(script);
  }

  #runOsascript(script) {
    return new Promise((resolve, reject) => {
      try {
        const file = Cc["@mozilla.org/file/local;1"].createInstance(
          Ci.nsIFile
        );
        file.initWithPath("/usr/bin/osascript");
        const process = Cc["@mozilla.org/process/util;1"].createInstance(
          Ci.nsIProcess
        );
        process.init(file);
        process.runAsync(["-e", script], 2, {
          observe(_subject, topic) {
            if (topic === "process-finished") {
              resolve();
            } else {
              reject(new Error(`osascript failed (${topic})`));
            }
          },
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  #clearTimers() {
    this.#stopPolling();
    if (this._errorToastTimer) {
      clearTimeout(this._errorToastTimer);
      this._errorToastTimer = null;
    }
    if (this._errorResetTimer) {
      clearTimeout(this._errorResetTimer);
      this._errorResetTimer = null;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#clearTimers();
    this.ownerDocument.removeEventListener("keydown", this._boundOnKeydown);
  }

  get #iconSrc() {
    return this._state === STATES.ERROR ? ICONS.error : ICONS.idle;
  }

  render() {
    const errorToast =
      this._state === STATES.ERROR && this._errorMessage
        ? html`<div class="voice-error-toast">${this._errorMessage}</div>`
        : nothing;

    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/voice-input-button.css"
      />
      <moz-button
        ?disabled=${this.disabled}
        type="ghost"
        class="voice-input-button"
        iconsrc=${this.#iconSrc}
        tooltiptext=${this._state === STATES.LISTENING
          ? "Stop voice input"
          : "Start voice input"}
        aria-label=${this._state === STATES.LISTENING
          ? "Stop voice input"
          : "Start voice input"}
        @click=${() => this.#onClick()}
      ></moz-button>
      ${errorToast}
    `;
  }
}

customElements.define("voice-input-button", VoiceInputButton);
