/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { html } from "chrome://global/content/vendor/lit.all.mjs";

const STATE_IDLE = "idle";
const STATE_PLAYING = "playing";
const STATE_PAUSED = "paused";
const STATE_UNAVAILABLE = "unavailable";

const SAY_SERVER = "http://127.0.0.1:8744";
const SAY_RATE = 175;
const POLL_INTERVAL_MS = 80;

async function sayFetch(path, method = "GET", body = null) {
  const opts = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${SAY_SERVER}${path}`, opts);
  return res.json();
}

export class VoicePlaybackButton extends MozLitElement {
  static properties = {
    messageId: { type: String, attribute: "message-id" },
    messageText: { type: String, attribute: false },
    _state: { state: true },
  };

  #pollTimer = null;

  constructor() {
    super();
    this.messageId = null;
    this.messageText = "";
    this._state = STATE_IDLE;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener(
      "voice-playback-cancel",
      this.#handleCancelEvent.bind(this)
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#stop();
  }

  #handleCancelEvent(event) {
    if (event.detail?.messageId !== this.messageId) {
      this.#stop();
    }
  }

  async #stop() {
    this.#stopPoll();
    if (this._state === STATE_PLAYING || this._state === STATE_PAUSED) {
      try {
        await sayFetch("/say/stop", "POST");
      } catch {
        // server may be unreachable
      }
      this._state = STATE_IDLE;
      this.#dispatchEnd();
    }
  }

  #stopPoll() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  #startPoll() {
    this.#stopPoll();
    this.#pollTimer = setInterval(async () => {
      try {
        const data = await sayFetch("/say/word");
        if (!data) {
          return;
        }
        const { index, status } = data;
        if (status === "idle") {
          this.#stopPoll();
          this._state = STATE_IDLE;
          this.#dispatchEnd();
          return;
        }
      } catch {
        // server unreachable during poll
      }
    }, POLL_INTERVAL_MS);
  }

  #dispatchStart() {
    this.dispatchEvent(
      new CustomEvent("voice-playback-start", {
        bubbles: true,
        composed: true,
        detail: { messageId: this.messageId },
      })
    );
  }

  #dispatchEnd() {
    this.dispatchEvent(
      new CustomEvent("voice-playback-end", {
        bubbles: true,
        composed: true,
        detail: { messageId: this.messageId },
      })
    );
  }

  #dispatchBoundary(charIndex, charLength) {
    this.dispatchEvent(
      new CustomEvent("voice-playback-boundary", {
        bubbles: true,
        composed: true,
        detail: { messageId: this.messageId, charIndex, charLength },
      })
    );
  }

  #handleClick() {
    if (this._state === STATE_UNAVAILABLE) {
      return;
    }
    switch (this._state) {
      case STATE_IDLE:
        this.#startPlayback();
        break;
      case STATE_PLAYING:
        this.#pause();
        break;
      case STATE_PAUSED:
        this.#resume();
        break;
    }
  }

  async #startPlayback() {
    if (!this.messageText) {
      return;
    }
    this.#dispatchStart();
    try {
      const res = await sayFetch("/say", "POST", {
        text: this.messageText,
        rate: SAY_RATE,
      });
      if (!res?.ok && res?.status !== "ok") {
        this._state = STATE_UNAVAILABLE;
        return;
      }
      this._state = STATE_PLAYING;
      this.#startPoll();
    } catch {
      this._state = STATE_UNAVAILABLE;
      this.#dispatchEnd();
    }
  }

  async #pause() {
    try {
      await sayFetch("/say/pause", "POST");
    } catch {
      // ignore
    }
    this.#stopPoll();
    this._state = STATE_PAUSED;
  }

  async #resume() {
    try {
      await sayFetch("/say/resume", "POST");
    } catch {
      // ignore
    }
    this._state = STATE_PLAYING;
    this.#startPoll();
  }

  get #ariaLabel() {
    switch (this._state) {
      case STATE_PLAYING:
        return "Pause reading";
      case STATE_PAUSED:
        return "Resume reading";
      case STATE_UNAVAILABLE:
        return "Speech not available";
      default:
        return "Read aloud";
    }
  }

  get #tooltipText() {
    switch (this._state) {
      case STATE_PLAYING:
        return "Pause reading";
      case STATE_PAUSED:
        return "Resume reading";
      case STATE_UNAVAILABLE:
        return "Speech server not running";
      default:
        return "Read aloud";
    }
  }

  #renderSpeakerIcon() {
    return html`<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="context-fill" fill-opacity="context-fill-opacity">
      <path d="M8.587 1.187a.75.75 0 0 1 .413.67v12.286a.75.75 0 0 1-1.212.59L3.972 11.5H1.75A1.75 1.75 0 0 1 0 9.75v-3.5C0 5.231.784 4.5 1.75 4.5h2.222l3.816-3.233a.75.75 0 0 1 .799-.08ZM7.5 3.498 4.412 6.113a.75.75 0 0 1-.484.177H1.75a.25.25 0 0 0-.25.25v2.92c0 .138.112.25.25.25h2.178a.75.75 0 0 1 .484.177L7.5 12.502V3.498ZM13.02 2.27a.75.75 0 0 1 1.06 0 8.452 8.452 0 0 1 0 11.96.75.75 0 1 1-1.06-1.06 6.952 6.952 0 0 0 0-9.84.75.75 0 0 1 0-1.06Zm-1.768 2.829a.75.75 0 0 1 1.06 0 5.077 5.077 0 0 1 0 6.302.75.75 0 1 1-1.06-1.06 3.577 3.577 0 0 0 0-4.182.75.75 0 0 1 0-1.06Z"/>
    </svg>`;
  }

  #renderPauseIcon() {
    return html`<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="context-fill" fill-opacity="context-fill-opacity">
      <rect x="3" y="2" width="3.5" height="12" rx="1"/>
      <rect x="9.5" y="2" width="3.5" height="12" rx="1"/>
    </svg>`;
  }

  #renderPlayIcon() {
    return html`<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="context-fill" fill-opacity="context-fill-opacity">
      <path d="M4.25 2.647a1 1 0 0 1 1.518-.855l7.5 4.353a1 1 0 0 1 0 1.71l-7.5 4.353a1 1 0 0 1-1.518-.855V2.647Z"/>
    </svg>`;
  }

  #renderIcon() {
    switch (this._state) {
      case STATE_PLAYING:
        return this.#renderPauseIcon();
      case STATE_PAUSED:
        return this.#renderPlayIcon();
      default:
        return this.#renderSpeakerIcon();
    }
  }

  render() {
    const buttonClass = `voice-button ${this._state}`;
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/voice-playback-button.css"
      />
      <button
        class=${buttonClass}
        title=${this.#tooltipText}
        aria-label=${this.#ariaLabel}
        ?disabled=${this._state === STATE_UNAVAILABLE}
        @click=${this.#handleClick}
      >
        ${this.#renderIcon()}
      </button>
    `;
  }
}

customElements.define("voice-playback-button", VoicePlaybackButton);
