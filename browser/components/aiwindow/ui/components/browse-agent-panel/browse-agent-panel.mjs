/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-textarea.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-input-password.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-message-bar.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowseAgent:
    "moz-src:///browser/components/aiwindow/models/agents/BrowseAgent.sys.mjs",
  BrowseAgentUI:
    "moz-src:///browser/components/aiwindow/ui/modules/BrowseAgentUI.sys.mjs",
  ENTRY_TYPE:
    "moz-src:///browser/components/aiwindow/models/agents/BrowseAgent.sys.mjs",
  SESSION_STATE:
    "moz-src:///browser/components/aiwindow/models/agents/BrowseAgent.sys.mjs",
});

const STATUS_L10N_IDS = {
  idle: "browse-agent-status-idle",
  running: "browse-agent-status-running",
  waiting: "browse-agent-status-waiting",
  done: "browse-agent-status-done",
  stopped: "browse-agent-status-stopped",
  error: "browse-agent-status-error",
};

const SUGGESTION_L10N_IDS = [
  "browse-agent-suggestion-recipe",
  "browse-agent-suggestion-chair",
  "browse-agent-suggestion-flight",
];

const ACTION_ICONS = {
  navigate: "chrome://global/skin/icons/open-in-new.svg",
  go_back: "chrome://browser/skin/back.svg",
  click: "chrome://global/skin/icons/pointer.svg",
  type: "chrome://global/skin/icons/edit.svg",
  key: "chrome://global/skin/icons/edit.svg",
  scroll: "chrome://global/skin/icons/arrow-down.svg",
  screenshot: "chrome://browser/skin/screenshot.svg",
  list_elements: "chrome://global/skin/icons/search-glass.svg",
  read_page: "chrome://global/skin/icons/reader-mode.svg",
  wait: "chrome://global/skin/icons/history.svg",
};

/**
 * Sidebar panel for the Browse Agent prototype: a task box, the live log of
 * what the agent sees and does, and a reply box when it asks something.
 */
export class BrowseAgentPanel extends MozLitElement {
  static properties = {
    task: { type: String },
    answer: { type: String },
    apiKeyDraft: { type: String },
    hasApiKey: { type: Boolean, state: true },
    state: { type: String, state: true },
    entries: { type: Array, state: true },
    showThinking: { type: Boolean, state: true },
  };

  static queries = {
    taskInput: "#task-input",
    answerInput: "#answer-input",
    log: ".log",
  };

  #session = null;
  #unsubscribe = null;

  constructor() {
    super();
    this.task = "";
    this.answer = "";
    this.apiKeyDraft = "";
    this.hasApiKey = false;
    this.state = "idle";
    this.entries = [];
    this.showThinking = false;
  }

  get #chromeWindow() {
    return window.browsingContext?.topChromeWindow;
  }

  connectedCallback() {
    super.connectedCallback();
    this.hasApiKey = !lazy.BrowseAgent.needsApiKey();
    const existing = lazy.BrowseAgent.getSession(this.#chromeWindow);
    if (existing) {
      this.#attach(existing);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#detach();
  }

  #attach(session) {
    this.#detach();
    this.#session = session;
    this.state = session.state;
    this.entries = [...session.entries];
    this.#unsubscribe = session.subscribe(entry => this.#onEntry(entry));
  }

  #detach() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#session = null;
  }

  #onEntry(entry) {
    if (entry.type === lazy.ENTRY_TYPE.STATE) {
      this.state = entry.state;
      if (entry.state === lazy.SESSION_STATE.WAITING_FOR_USER) {
        this.updateComplete.then(() => this.answerInput?.focus());
      }
      return;
    }
    this.entries = [...this.entries, entry];
  }

  updated(changed) {
    if (changed.has("entries")) {
      this.#scrollToEnd();
    }
  }

  // Message bars and thumbnails finish laying out after our own update, so
  // scroll again on the next frame.
  #scrollToEnd() {
    const scrollLog = () => {
      if (this.log) {
        this.log.scrollTop = this.log.scrollHeight;
      }
    };
    scrollLog();
    requestAnimationFrame(scrollLog);
  }

  get isActive() {
    return (
      this.state === lazy.SESSION_STATE.RUNNING ||
      this.state === lazy.SESSION_STATE.WAITING_FOR_USER
    );
  }

  /**
   * Starts a run for the given task, replacing any previous one.
   *
   * @param {string} task
   */
  startTask(task = this.task) {
    task = task.trim();
    if (!task || !this.hasApiKey) {
      this.focusInput();
      return;
    }
    this.task = task;
    this.entries = [];
    const session = lazy.BrowseAgent.startSession(this.#chromeWindow, task);
    this.#attach(session);
  }

  focusInput() {
    this.updateComplete.then(() => this.taskInput?.focus());
  }

  #onTaskKeydown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.startTask();
    }
  }

  #onAnswerKeydown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.#sendAnswer();
    }
  }

  #sendAnswer() {
    if (this.#session?.answer(this.answer)) {
      this.answer = "";
    }
  }

  #stop() {
    this.#session?.stop();
  }

  #saveApiKey() {
    const key = this.apiKeyDraft.trim();
    if (!key) {
      return;
    }
    lazy.BrowseAgent.setApiKey(key);
    this.apiKeyDraft = "";
    this.hasApiKey = !lazy.BrowseAgent.needsApiKey();
    this.focusInput();
  }

  #backToChat() {
    lazy.BrowseAgentUI.showChat(this.#chromeWindow);
  }

  #setupTemplate() {
    return html`
      <section class="setup">
        <h2 data-l10n-id="browse-agent-setup-heading"></h2>
        <p data-l10n-id="browse-agent-setup-description"></p>
        <moz-input-password
          data-l10n-id="browse-agent-setup-key-label"
          .value=${this.apiKeyDraft}
          @input=${e => (this.apiKeyDraft = e.target.value)}
          @keydown=${e => e.key === "Enter" && this.#saveApiKey()}
        ></moz-input-password>
        <moz-button
          type="primary"
          size="small"
          data-l10n-id="browse-agent-setup-save"
          ?disabled=${!this.apiKeyDraft.trim()}
          @click=${this.#saveApiKey}
        ></moz-button>
      </section>
    `;
  }

  #entryTemplate(entry) {
    const { ENTRY_TYPE } = lazy;
    switch (entry.type) {
      case ENTRY_TYPE.TASK:
        return html`<div class="entry task">
          <p>${entry.text}</p>
        </div>`;
      case ENTRY_TYPE.ASSISTANT:
        return html`<div class="entry assistant">
          <p>${entry.text}</p>
        </div>`;
      case ENTRY_TYPE.THINKING:
        return this.showThinking
          ? html`<div class="entry thinking">
              <p>${entry.text}</p>
            </div>`
          : nothing;
      case ENTRY_TYPE.ACTION:
        return html`<div class="entry action ${entry.failed ? "failed" : ""}">
          <div class="action-row">
            <img
              class="action-icon"
              src=${ACTION_ICONS[entry.name] ?? ACTION_ICONS.screenshot}
              alt=""
            />
            <span class="action-status">${entry.status}</span>
          </div>
          ${entry.image
            ? html`<img
                class="action-shot"
                src=${entry.image}
                alt=${entry.title ?? ""}
                title=${entry.url ?? ""}
                @load=${this.#scrollToEnd}
              />`
            : nothing}
        </div>`;
      case ENTRY_TYPE.QUESTION:
        return html`<div class="entry question">
          <p>${entry.text}</p>
        </div>`;
      case ENTRY_TYPE.ANSWER:
        return html`<div class="entry answer">
          <p>${entry.text}</p>
        </div>`;
      case ENTRY_TYPE.DONE:
        return html`<moz-message-bar
          class="entry done"
          type=${entry.success ? "success" : "warning"}
          .message=${entry.text}
        ></moz-message-bar>`;
      case ENTRY_TYPE.ERROR:
        return html`<moz-message-bar
          class="entry error"
          type="error"
          .message=${entry.text}
        ></moz-message-bar>`;
      default:
        return nothing;
    }
  }

  #onSuggestionClick(event) {
    this.task = event.currentTarget.textContent.trim();
    this.focusInput();
  }

  #emptyTemplate() {
    return html`
      <div class="empty">
        <p data-l10n-id="browse-agent-empty-hint"></p>
        <p
          class="suggestions-heading"
          data-l10n-id="browse-agent-suggestions-heading"
        ></p>
        ${SUGGESTION_L10N_IDS.map(
          id =>
            html`<button
              class="suggestion"
              data-l10n-id=${id}
              @click=${this.#onSuggestionClick}
            ></button>`
        )}
      </div>
    `;
  }

  #composerTemplate() {
    if (this.state === lazy.SESSION_STATE.WAITING_FOR_USER) {
      return html`
        <div class="composer">
          <moz-textarea
            id="answer-input"
            rows="2"
            data-l10n-id="browse-agent-answer-input"
            .value=${this.answer}
            @input=${e => (this.answer = e.target.value)}
            @keydown=${this.#onAnswerKeydown}
          ></moz-textarea>
          <div class="composer-buttons">
            <moz-button
              size="small"
              data-l10n-id="browse-agent-stop"
              @click=${this.#stop}
            ></moz-button>
            <moz-button
              type="primary"
              size="small"
              data-l10n-id="browse-agent-send"
              @click=${this.#sendAnswer}
            ></moz-button>
          </div>
        </div>
      `;
    }
    return html`
      <div class="composer">
        <moz-textarea
          id="task-input"
          rows="3"
          data-l10n-id="browse-agent-task-input"
          .value=${this.task}
          ?disabled=${this.isActive || !this.hasApiKey}
          @input=${e => (this.task = e.target.value)}
          @keydown=${this.#onTaskKeydown}
        ></moz-textarea>
        <div class="composer-buttons">
          <label class="thinking-toggle">
            <input
              type="checkbox"
              .checked=${this.showThinking}
              @change=${e => (this.showThinking = e.target.checked)}
            />
            <span data-l10n-id="browse-agent-show-thinking"></span>
          </label>
          ${this.isActive
            ? html`<moz-button
                type="destructive"
                size="small"
                data-l10n-id="browse-agent-stop"
                @click=${this.#stop}
              ></moz-button>`
            : html`<moz-button
                type="primary"
                size="small"
                data-l10n-id="browse-agent-run"
                ?disabled=${!this.task.trim() || !this.hasApiKey}
                @click=${() => this.startTask()}
              ></moz-button>`}
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/browse-agent-panel.css"
      />
      <header>
        <moz-button
          type="icon ghost"
          size="small"
          iconsrc="chrome://global/skin/icons/arrow-left.svg"
          data-l10n-id="browse-agent-back-to-chat"
          @click=${this.#backToChat}
        ></moz-button>
        <h1 data-l10n-id="browse-agent-panel-title"></h1>
        <span
          class="status ${this.state}"
          data-l10n-id=${STATUS_L10N_IDS[this.state]}
        ></span>
      </header>
      ${this.hasApiKey ? nothing : this.#setupTemplate()}
      <div class="log" role="log" aria-live="polite">
        ${this.entries.length
          ? this.entries.map(entry => this.#entryTemplate(entry))
          : this.#emptyTemplate()}
      </div>
      <p
        class="model"
        data-l10n-id="browse-agent-model-label"
        data-l10n-args=${JSON.stringify({ model: lazy.BrowseAgent.model })}
      ></p>
      ${this.#composerTemplate()}
    `;
  }
}

customElements.define("browse-agent-panel", BrowseAgentPanel);
