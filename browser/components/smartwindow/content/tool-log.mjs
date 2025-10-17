/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { html, css } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

/**
 * A tool log viewer component that displays a list of tool responses, including message content, date, and result.
 */
class ToolLog extends MozLitElement {
  static styles = css`
    :root {
      width: 100%;
    }

    .wrapper {
      max-width: 400px;
      width: 100%;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0px 8px;
    }

    .title {
      font-size: 14px;
    }

    .log-entries {
      padding: 8px;
      max-height: 200px;
      overflow-y: auto;
      border: 1px solid #a9a9a9;
      margin: 8px;
      border-radius: 4px;
      font-size: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .log-entry {
      background-color: #eae8e5;
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      padding: 8px;
    }
  `;

  static properties = {
    showLog: { type: Boolean },
    logState: { type: Array },
  };

  constructor() {
    super();
    this.showLog = false;
    this.logState = [];
  }

  get iconSrc() {
    return this.showLog
      ? "chrome://global/skin/icons/arrow-up.svg"
      : "chrome://global/skin/icons/arrow-down.svg";
  }

  updatelogState = chatEntry => {
    const entryWithDate = { ...chatEntry, date: new Date().toLocaleString() };
    this.logState = [...this.logState, entryWithDate];
  };

  render() {
    return html`
      <div class="wrapper">
        <div class="header">
          <span class="title">Log</span>
          <moz-button
            type="ghost"
            iconSrc=${this.iconSrc}
            @click=${() => {
              this.showLog = !this.showLog;
            }}
          ></moz-button>
        </div>
        ${this.showLog
          ? html`
              <div class="log-entries">
                ${this.logState.length === 0
                  ? html`<div>No log entries yet</div>`
                  : html``}
                ${this.logState.map(
                  data => html`
                    <div class="log-entry">
                      <div><b>Message</b> : ${data.content}</div>
                      <div><b>Date</b> : ${data.date}</div>
                      <div>
                        <b>Tool Response</b> : ${JSON.stringify(data.result)}
                      </div>
                    </div>
                  `
                )}
              </div>
            `
          : html``}
      </div>
    `;
  }
}

customElements.define("tool-log", ToolLog);
