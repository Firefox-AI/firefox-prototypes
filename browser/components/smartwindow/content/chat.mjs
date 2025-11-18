/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  html,
  css,
  unsafeHTML,
  live,
} from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { fetchWithHistory } from "chrome://browser/content/smartwindow/utils.mjs";
import {
  detectInsightTokens,
  createInsightsOverlay,
  insightsStyles,
  deleteInsight,
  generateInsightsFromDirectChat,
  getRelevantInsights,
} from "chrome://browser/content/smartwindow/insights.mjs";

import { showChatHistoryOverlay } from "chrome://browser/content/smartwindow/chat-history.mjs";

const PROMPT_PREF = "browser.smartwindow.systemPromptOverride";
const { ChatHistory, ChatHistoryConversation, ChatHistoryMessage } =
  ChromeUtils.importESModule(
    "resource:///modules/smartwindow/ChatHistory.sys.mjs"
  );
/**
 * A simple chat bot component that interacts with an Ollama model via streaming.
 */
class ChatBot extends MozLitElement {
  /**
   * @type {null | import("../ChatHistory.sys.mjs").ChatHistoryConversation}
   */
  #conversation;

  #chatHistory = new ChatHistory();

  static styles = css`
    :host {
      display: block;
      font-family: sans-serif;
      padding: 1rem;
      background: #ffffff;
      font-size: 14px;
    }

    .chat {
      display: flex;
      flex-direction: column;
      gap: 2.5rem;
      margin-bottom: 1rem;
      max-height: 700px;
    }

    .conversation-title-container {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 2rem 0 0.5rem 0;
      margin-bottom: 0.5rem;
      border-bottom: 1px solid #e0e0e0;
    }

    .conversation-title {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: #333;
      flex: 1;
    }

    .title-edit-button {
      background: none;
      border: none;
      cursor: pointer;
      padding: 0.25rem;
      border-radius: 4px;
      color: #666;
      display: flex;
      align-items: center;
      justify-content: center;
      transition:
        background-color 0.2s,
        color 0.2s;
      margin: 0;
    }

    .title-edit-button:hover {
      background-color: #f0f0f0;
      color: #333;
    }

    .title-input {
      flex: 1;
      font-size: 1.25rem;
      font-weight: 600;
      padding: 0.5rem;
      border: 1px solid #0066cc;
      border-radius: 4px;
      outline: none;
      margin: 0;
    }

    .title-input:focus {
      border-color: #0052a3;
      box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.1);
    }

    .message {
      display: flex;
      flex-direction: column;
      gap: var(--space-large);
      line-height: 1.4;
      padding: 0.75rem 1rem;
    }

    .message .message-body > *:first-child {
      margin-block-start: 0;
      padding-block-start: 0;
    }

    .message .message-body > *:last-child {
      margin-block-end: 0;
      padding-block-end: 0;
    }

    .message-title {
      font-weight: bold;
    }

    .user {
      align-self: flex-end;
      border-radius: 12px;
      border: 1px solid rgba(189, 137, 213, 0.3);
      background: rgba(255, 255, 255, 0.75);
      box-shadow:
        var(--box-shadow-level-2-shadow-1-x, 0)
          var(--box-shadow-level-2-shadow-1-y, 0.25px)
          var(--box-shadow-level-2-shadow-1-blur, 0.75px)
          var(--box-shadow-level-2-shadow-1-spread, 0)
          var(--box-shadow-level-2-shadow-1-color, rgba(0, 0, 0, 0.05)),
        var(--box-shadow-level-2-shadow-2-x, 0)
          var(--box-shadow-level-2-shadow-2-y, 2px)
          var(--box-shadow-level-2-shadow-2-blur, 6px)
          var(--box-shadow-level-2-shadow-2-spread, 0)
          var(--box-shadow-level-2-shadow-2-color, rgba(0, 0, 0, 0.1));
    }

    .assistant {
      align-self: flex-start;
      border-left: 2px solid #d6b4fd;
      ul {
        display: block;
      }
    }

    .input-container {
      display: flex;
      flex-direction: column;
      margin-top: 1rem;
    }
    input {
      flex-grow: 1;
      padding: 0.5rem;
      font-size: 1rem;
      margin-top: 0.5rem;
      border-radius: 4px;
      border: 1px solid #444;
    }

    button {
      margin-top: 0.5rem;
      background: #303031;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      padding: 0.5rem 1rem;
    }

    .welcome-message {
      font-size: 14px;
      text-decoration: italic;
      color: #666;
    }

    .actions-wrapper {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .search-suggestions {
      margin-top: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .history-overlay-section {
      display: flex;
      flex-direction: column;
      gap: var(--space-small);
    }

    .history-overlay-actions {
      display: flex;
      justify-content: flex-start;
    }

    .history-overlay-label {
      align-items: center;
      color: var(--text-color-deemphasized, rgba(21, 20, 26, 0.69));
      display: inline-flex;
      font-size: 13px;
      font-weight: 600;
      gap: var(--space-small);
    }

    button.history-overlay-button {
      align-items: center;
      background: #ffffff;
      background: rgba(191, 143, 204, 0.1);
      border-radius: 12px;
      border: 1px solid rgba(125, 32, 124, 0.05);
      box-shadow: 0 1px 2px rgba(17, 24, 39, 0.08);
      color: var(--text-color, #15141a);
      cursor: pointer;
      display: inline-flex;
      font-size: 0.85rem;
      font-size: 14px;
      font-weight: 500;
      gap: var(--space-medium);
      justify-content: space-between;
      margin-top: 0;
      min-width: 150px;
      padding: 0.45rem 0.85rem;
    }

    button.history-overlay-button:hover {
      background: rgba(24, 19, 25, 0.2);
      border: 1px solid rgba(125, 32, 124, 0.25);
    }

    .history-overlay-button-content {
      align-items: flex-start;
      display: flex;
      flex-direction: column;
    }

    .history-overlay-button-icons {
      display: inline-flex;
      align-items: center;
      min-width: 0;
    }

    .history-overlay-button-icon {
      background: #fff;
      border-radius: 50%;
      border: 1px solid var(--border-color-overlay, #f0f0f4);
      box-shadow: -1px 1px 4px 0 rgba(132, 106, 65, 0.17);
      height: 16px;
      width: 16px;
      overflow: hidden;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.65rem;
      font-weight: 600;
      color: rgba(21, 20, 26, 0.69);
    }

    .history-overlay-button-icon + .history-overlay-button-icon {
      margin-left: -4px;
    }

    .history-overlay-button-more {
      background: rgba(21, 20, 26, 0.05);
      border-color: rgba(21, 20, 26, 0.15);
    }

    .history-overlay-button-count {
      color: var(--text-color-deemphasized, rgba(21, 20, 26, 0.69));
      gap: var(--space-medium);
      font-weight: 400;
      font-size: 13px;
    }

    .history-overlay-button-term {
    }

    .search-button {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.75rem;
      background: #0066cc;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 0.875rem;
      cursor: pointer;
      transition: background-color 0.2s;
      align-self: flex-start;
    }

    .search-button:hover {
      background: #0052a3;
    }

    .search-button svg {
      flex-shrink: 0;
    }

    .search-more-dropdown {
      position: relative;
      display: inline-block;
    }

    .search-more-button {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.5rem 0.75rem;
      background: #6c757d;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 0.875rem;
      cursor: pointer;
      transition: background-color 0.2s;
    }

    .search-more-button:hover {
      background: #5a6268;
    }

    .search-more-button svg {
      flex-shrink: 0;
    }

    .search-dropdown-menu {
      position: absolute;
      top: 100%;
      left: 0;
      margin-top: 0.25rem;
      background: white;
      border: 1px solid #d8d8d8;
      border-radius: 6px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      min-width: 180px;
      z-index: 1000;
    }

    .search-dropdown-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.75rem;
      background: white;
      color: #333;
      border: none;
      font-size: 0.875rem;
      cursor: pointer;
      width: 100%;
      text-align: left;
      transition: background-color 0.2s;
    }

    .search-dropdown-item:first-child {
      border-radius: 6px 6px 0 0;
    }

    .search-dropdown-item:last-child {
      border-radius: 0 0 6px 6px;
    }

    .search-dropdown-item:hover {
      background: #f0f0f0;
    }

    .chat-controls {
      display: flex;
      gap: 0.5rem;
      max-height: 18px;
      position: fixed;
      left: 0;
      top: 0;
      z-index: 100;

      @media not -moz-pref("browser.smartwindow.developer") {
        display: none;
      }
    }

    .control-button {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.5rem 0.75rem;
      background: #0066cc;
      color: white;
      border: none;
      border-radius: 0;
      font-size: 0.875rem;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      margin: 0;
    }

    .control-button:hover {
      background: #0052a3;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
      transform: translateY(-1px);
    }

    .control-button.active {
      background: #004080;
      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.2);
    }

    .control-button svg {
      flex-shrink: 0;
    }

    .control-label {
      font-weight: 500;
    }

    .control-badge {
      background: rgba(255, 255, 255, 0.25);
      padding: 0.125rem 0.375rem;
      border-radius: 10px;
      font-size: 0.75rem;
      font-weight: 600;
      min-width: 20px;
      text-align: center;
    }

    .tool-log-panel,
    .prompt-panel {
      position: fixed;
      top: 4.5rem;
      right: 1rem;
      max-width: 400px;
      width: 90%;
      background: white;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 99;
      overflow: hidden;
    }

    .log-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1rem;
      background: #f8f9fa;
      border-bottom: 1px solid #e0e0e0;
    }

    .log-title {
      font-weight: 600;
      font-size: 0.875rem;
      color: #333;
    }

    .log-close-btn {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: #666;
      padding: 0;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      margin: 0;
    }

    .log-close-btn:hover {
      background: #e0e0e0;
    }

    .log-entries {
      padding: 0.75rem;
      height: 300px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      resize: vertical;
    }

    .log-empty {
      color: #666;
      font-size: 0.875rem;
      padding: 1rem;
      text-align: center;
    }

    .log-entry {
      background-color: #f5f5f5;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      padding: 0.75rem;
      font-size: 0.875rem;
    }

    .log-field {
      margin-bottom: 0.5rem;
      line-height: 1.4;
      word-break: break-word;
    }

    .log-field:last-child {
      margin-bottom: 0;
    }

    .log-field b {
      color: #333;
      font-weight: 600;
    }

    .prompt-body {
      padding: 0.75rem;
      overflow-y: auto;
      background: #fff;
    }

    .prompt-editor {
      width: 100%;
      min-height: 300px;
      padding: 0.5rem;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12.5px;
      line-height: 1.4;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      box-sizing: border-box;
      background: #fafafa;
    }

    .prompt-actions {
      margin-top: 0.5rem;
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }

    .prompt-actions button {
      margin: 0;
      background: #e9ecef;
      color: #111;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      padding: 0.35rem 0.6rem;
      font-size: 12px;
      cursor: pointer;
    }

    .prompt-actions button:hover {
      background: #dde3e8;
    }

    .save-status {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 12px;
      color: #555;
      padding: 0.15rem 0.4rem;
      border: 1px solid #e0e0e0;
      border-radius: 999px;
      background: #f8f9fa;
    }

    .save-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .save-dot.saving {
      background: #d39e00;
    }

    .save-dot.saved {
      background: #2ea44f;
    }

    .mention {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 185px;
      vertical-align: middle;
      border: 1px solid var(--tab-border-color, rgba(0, 0, 0, 0));
      background: rgba(191, 143, 204, 0.1);
      cursor: pointer;
      transition: background 0.2s ease;
    }

    .mention:hover {
      background: rgba(191, 143, 204, 0.2);
    }

    .mention .mention-icon {
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      display: block;
    }

    .mention .mention-label {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    ${insightsStyles}

    .message-footer {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      position: relative;
    }

    .insights-applied-trigger-chat-popover {
      appearance: none;
      background: transparent;
      border-radius: 8px;
      display: flex;
      padding: 0;
      transition: background 0.2s ease-in-out;

      svg {
        fill: #3b2279;
      }

      &:is(:hover, [aria-expanded="true"]) {
        background: #bf8fcc33;

        .insights-applied-trigger-chat-popover-hover-text {
          margin-left: 6px;
          max-width: 160px;
          opacity: 1;
        }
      }
    }

    .insights-applied-trigger-chat-popover-inner {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 5px 4px;
    }

    .insights-applied-trigger-chat-popover-hover-text {
      color: #3b2279;
      max-width: 0;
      opacity: 0;
      overflow: hidden;
      transition:
        margin-left 0.1s ease,
        max-width 0.3s ease,
        opacity 0.2s ease;
      white-space: nowrap;
    }

    .insights-applied-chat-popover {
      background: #fff;
      border: 1px solid #f0f0f4;
      border-radius: 8px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
      padding: 16px;
      pointer-events: none;
      position: absolute;
      bottom: 32px;
      left: 0;
      opacity: 0;
      overflow: hidden;
      transform: translateY(6px);
      transform-origin: bottom center;
      transition:
        opacity 0.2s ease-out,
        transform 0.2s ease-out;
      width: 280px;
      z-index: 10;

      &.is-open {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
    }

    ul.insights-applied-chat-popover-list {
      display: grid;
      gap: 4px;
      list-style-type: none;
      margin: 0;
      padding: 0;

      li {
        background-color: #f9f9fb;
        border-radius: 8px;
        font-weight: 600;
        padding: 8px;
      }
    }

    .insights-applied-chat-popover-footer {
      button {
        appearance: none;
        background: transparent;
        border-radius: 6px;
        color: #15141a;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px;
        transition: background-color 0.15s ease;
      }

      button:hover {
        background-color: rgba(21, 20, 26, 0.08);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .insights-applied-chat-popover,
      .insights-applied-chat-popover.is-open {
        transition: none;
      }
    }
  `;

  showChatHistoryOverlay = showChatHistoryOverlay;

  static get properties() {
    return {
      prompt: { type: String },
      messages: { type: Array },
      marked: { type: Object },
      showInsightsOverlay: { type: Boolean },
      showLog: { type: Boolean },
      logState: { type: Array },
      showPrompt: { type: Boolean },
      systemPromptDraft: { type: String },
      saveStatus: { type: String },
      conversationTitle: { type: String },
      editingTitle: { type: Boolean },
      searchEngines: { type: Array },
      openDropdownQuery: { type: String },
      useInsights: { type: Boolean, reflect: true },
      openChatInsights: { type: Boolean },
    };
  }

  get messages() {
    return this.#conversation.messages;
  }

  set messages(new_messages) {
    this.#conversation.messages = new_messages;
    this.requestUpdate();
  }

  constructor() {
    super();
    this.prompt = "";
    // this.messages = [];
    this.marked = window.marked.marked; // Use the global marked instance for markdown rendering
    this.currentTabContext = []; // Store current tab context
    this.currentPageText = ""; // Store current page text content
    this.currentPageInfo = null; // Store pagination metadata
    this.currentSelectionText = ""; // Store selected text content
    this.mentions = [];
    this.showInsightsOverlay = false; // Track insights overlay visibility
    this.conversationInsights = new Set(); // Track all insights used in conversation
    this._insightsUpdatedHandler = null; // Event listener reference for cleanup
    this.showLog = false; // Track tool log visibility
    this.logState = []; // Store tool log entries
    this.showPrompt = false;
    this.saveStatus = "idle";
    this._saveTimer = null;
    this._lastSavedAt = null;
    this._lastUserHTML = null;
    this._uiMeta = new Map();
    this.conversationTitle = "";
    this.editingTitle = false;
    this.searchEngines = [];
    this.openDropdownQuery = null;
    this._lastSentPageInfoSignature = null;
    this._lastSelectionSignature = null;
    this.openChatInsights = false;
    this._forceAmnesiaNextTurn = false;

    // TODO: Figure out what/where to get this info from, if necessary
    this.#conversation = new ChatHistoryConversation({
      title: "",
      description: "",
      pageUrl: "",
      pageMeta: "",
    });

    let saved = "";
    try {
      saved = Services.prefs.getStringPref(PROMPT_PREF, "");
    } catch (e) {}

    this.systemPromptDraft = saved !== "" ? saved : null;

    this._prefObserver = {
      observe: (_subject, topic, data) => {
        if (topic !== "nsPref:changed" || data !== PROMPT_PREF) {
          return;
        }
        let val = "";
        try {
          val = Services.prefs.getStringPref(PROMPT_PREF, "");
        } catch {}
        this.systemPromptDraft = val !== "" ? val : null;
        this.saveStatus = "saved";
        this._lastSavedAt = new Date();
        this.requestUpdate();
      },
    };
  }

  clearUIMeta() {
    this._uiMeta.clear();
    this._lastUserHTML = null;
  }

  // Read useInsights from conversation when present; default ON if unset
  #hydrateUseInsightsFromConversation() {
    const saved = this.conversation?.settings?.useInsights;
    if (typeof saved === "boolean") {
      if (this.useInsights !== saved) {
        this.useInsights = saved;
      }
      return;
    }

    if (typeof this.useInsights !== "boolean") {
      this.useInsights = true;
    }
  }

  #rebuildConversationInsights(conversation) {
    this.conversationInsights = new Set();
    const messages = conversation?.messages ?? [];
    for (const msg of messages) {
      if (
        msg?.role === ChatHistory.MESSAGE_ROLE.ASSISTANT &&
        typeof msg.content === "string" &&
        msg.content
      ) {
        const tokens = detectInsightTokens(msg.content);
        for (const token of tokens) {
          if (token.insight) {
            this.conversationInsights.add(token.insight);
          }
        }
      }
    }
  }

  async connectedCallback() {
    super.connectedCallback();
    // Listen for insights-updated events to re-render the overlay
    this._insightsUpdatedHandler = () => {
      this.requestUpdate();
    };
    window.addEventListener("insights-updated", this._insightsUpdatedHandler);
    Services.prefs.addObserver(PROMPT_PREF, this._prefObserver);

    this._closeChatInsights = e => {
      const path = e.composedPath();
      const popover = this.renderRoot?.querySelector(
        ".insights-applied-chat-popover.is-open"
      );
      const trigger = this.renderRoot?.querySelector(
        '.insights-applied-trigger-chat-popover[aria-expanded="true"]'
      );

      if (
        (popover && path.includes(popover)) ||
        (trigger && path.includes(trigger))
      ) {
        return;
      }

      if (path.includes(this)) {
        this.openChatInsights = null;
        this.requestUpdate();
        return;
      }

      this.openChatInsights = null;
      this.requestUpdate();
    };
    document.addEventListener("click", this._closeChatInsights);

    // Mention click handling is now done in updated() method

    // Load search engines with their icons
    await this.loadSearchEngines();

    this.#hydrateUseInsightsFromConversation();
  }

  async loadSearchEngines() {
    try {
      const engines = await Services.search.getEngines();
      const engineData = await Promise.all(
        engines.map(async engine => {
          try {
            const iconURL = await engine.getIconURL();
            return { name: engine.name, iconURL };
          } catch (err) {
            console.warn(`Failed to get icon for ${engine.name}:`, err);
            return { name: engine.name, iconURL: null };
          }
        })
      );
      this.searchEngines = engineData;
      this.requestUpdate();
    } catch (err) {
      console.error("Failed to load search engines:", err);
      this.searchEngines = [];
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.clearUIMeta();
    // Clean up event listener
    if (this._insightsUpdatedHandler) {
      window.removeEventListener(
        "insights-updated",
        this._insightsUpdatedHandler
      );
      this._insightsUpdatedHandler = null;
    }
    try {
      Services.prefs.removeObserver(PROMPT_PREF, this._prefObserver);
    } catch {}
    if (this._closeChatInsights) {
      document.removeEventListener("click", this._closeChatInsights);
      this._closeChatInsights = null;
    }
    // Mention click handlers are removed automatically when DOM is updated
  }

  /**
   * Open a tab from a mention click
   *
   * @param {HTMLElement} mentionElement - The mention element that was clicked
   */
  openTabFromMention(mentionElement) {
    console.log("openTabFromMention called with:", mentionElement);
    console.log("Mention attributes:", mentionElement.attributes);
    console.log("Mention dataset:", mentionElement.dataset);

    const url =
      mentionElement.dataset.id || mentionElement.getAttribute("data-id");
    console.log("Extracted URL:", url);

    if (!url) {
      console.warn("No URL found in mention data-id attribute");
      return;
    }

    // Get access to the browser window
    const { topChromeWindow } = window.browsingContext;
    if (!topChromeWindow?.gBrowser) {
      console.error("Cannot access browser window");
      return;
    }

    const gBrowser = topChromeWindow.gBrowser;

    // Look for an existing tab with this URL
    const existingTab = Array.from(gBrowser.tabs).find(tab => {
      const browser = gBrowser.getBrowserForTab(tab);
      return browser.currentURI.spec === url;
    });

    if (existingTab) {
      // Switch to existing tab
      gBrowser.selectedTab = existingTab;
    } else {
      // Create new tab
      gBrowser.addTab(url, {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
        relatedToCurrent: true,
      });
    }
  }

  #createPageInfoMessageIfNeeded() {
    const info = this.currentPageInfo;
    const count = info?.count;
    const viewportHeight = info?.viewportHeight;
    const currentPage = info?.currentPage;

    const signature =
      info === null ? "null" : `${count}|${viewportHeight}|${currentPage}`;
    if (signature === this._lastSentPageInfoSignature) {
      return null;
    }
    const previousSignature = this._lastSentPageInfoSignature;
    this._lastSentPageInfoSignature = signature;

    if (!info) {
      if (previousSignature === null) {
        return null;
      }
      return {
        role: ChatHistory.MESSAGE_ROLE.SYSTEM,
        content: "Page Info Update: Page information is currently unavailable.",
      };
    }

    const humanPage = currentPage + 1;
    const totalPages = count || humanPage;

    return {
      role: ChatHistory.MESSAGE_ROLE.SYSTEM,
      content: `Page Info Update:
- Current page: ${humanPage} of ${totalPages}
- Viewport height: ${viewportHeight}px`,
    };
  }

  #createSelectionMessageIfNeeded() {
    let text = (this.currentSelectionText || "").trim();
    if (!text) {
      this._lastSelectionSignature = "";
      return null;
    }
    const MAX_SELECTION_LENGTH = 1000;
    let truncated = false;
    if (text.length > MAX_SELECTION_LENGTH) {
      text = text.slice(0, MAX_SELECTION_LENGTH);
      truncated = true;
    }
    if (text === this._lastSelectionSignature) {
      return null;
    }
    this._lastSelectionSignature = text;
    return {
      role: ChatHistory.MESSAGE_ROLE.SYSTEM,
      content: `Selected Text${truncated ? " (truncated)" : ""}:\n${text}`,
    };
  }

  getCurrentTabUrl(aUrl) {
    // Get access to the browser window
    const gBrowser = window?.browsingContext?.topChromeWindow?.gBrowser;
    if (!gBrowser) {
      return "";
    }

    const url = aUrl || gBrowser?.selectedBrowser?.currentURI?.spec;
    try {
      return new URL(url);
    } catch (e) {
      return "";
    }
  }

  async sendPrompt() {
    if (!this.prompt.trim()) {
      return;
    }

    if (this.#conversation.messages.length === 0) {
      this.conversationTitle = "";
    }

    const currentMessages = this.#conversation?.messages || [];
    const turn_index =
      currentMessages.reduce((turn, msg) => {
        if (!isNaN(msg.turn_index) && msg.turn_index > turn) {
          return msg.turn_index;
        }

        return turn;
      }, -1) + 1;

    const currentUrl = this.getCurrentTabUrl();

    // Conversation holds string-only {role, content}; keep render-only data in _uiMeta so it never reaches the backend.
    const before = this.#conversation.messages.length;
    this.#conversation.addUserMessage(this.prompt, currentUrl, turn_index);
    const msgsAfter = this.#conversation.messages;
    const userMsg = msgsAfter[before];
    const userKey = (userMsg && (userMsg.id ?? userMsg.messageId)) ?? before;

    // Stash the rich HTML for rendering only
    if (this._lastUserHTML) {
      const meta = { displayHTML: this._lastUserHTML };
      this._uiMeta.set(userKey, meta);
      this._uiMeta.set(before, meta);
      this._lastUserHTML = null;
    }

    // Prepare messages with system prompt for the API call
    const messagesForAPI = this.#conversation.messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // Prepare an empty assistant message for streaming
    this.#conversation.addAssistantMessage("", turn_index);
    this.requestUpdate();

    const pageInfoMessage = this.#createPageInfoMessageIfNeeded();
    const selectionMessage = this.#createSelectionMessageIfNeeded();

    if (messagesForAPI.length) {
      // Insert system prompt as the first message
      const shouldGenerateTitle = this.conversationTitle === "";
      const systemContent =
        (this.systemPromptDraft && this.systemPromptDraft.trim()) ||
        this.buildSystemPrompt(
          this.currentTabContext || [],
          shouldGenerateTitle
        );

      const prefixMessages = [
        {
          role: ChatHistory.MESSAGE_ROLE.SYSTEM,
          content: systemContent,
        },
      ];
      if (pageInfoMessage) {
        prefixMessages.push(pageInfoMessage);
      }
      if (selectionMessage) {
        prefixMessages.push(selectionMessage);
      }

      if (this._forceAmnesiaNextTurn === true) {
        prefixMessages.push({
          role: ChatHistory.MESSAGE_ROLE.SYSTEM,
          content:
            "For this single response, ignore prior conversation and any insights about the user. Do not reference earlier assistant messages or answers. Rely only on the current user message and these system instructions.",
        });
        this._forceAmnesiaNextTurn = false;
      }

      messagesForAPI.unshift(...prefixMessages);
    }

    // Inject insights relevant to the current user prompt ONLY immediately before the user prompt
    const out = await getRelevantInsights(this.prompt.trim());
    let relevant_insights_list = [];
    for (const entry of out.insights || []) {
      if (entry.insight_summary) {
        relevant_insights_list.push(`- ${entry.insight_summary}`);
      }
    }
    const relevant_insights_for_prompt = relevant_insights_list.join("\n");
    if (out && out.insights && out.insights.length > 0) {
      messagesForAPI.splice(
        messagesForAPI.length - 1, 0,
        {
          role: ChatHistory.MESSAGE_ROLE.SYSTEM,
          content: `
Below is a list of insights relevant to this conversation. TAG ALL INSIGHTS FROM THIS LIST YOU USE IN YOUR RESPONSE WITH §insight: insight text§ !

${relevant_insights_for_prompt}

DO NOT TAG INSIGHTS THAT ARE NOT IN THE LIST ABOVE! ONLY TAG INSIGHTS YOU ACTUALLY USE TO RESPOND TO THE USER! DO NOT MAKE UP INSIGHTS! DO NOT USE THE TAG NEW INSIGHTS!
`
        }
      );
    }

    const allowedRemoteUrls = new Set(
      this.mentions
        .filter(mention => mention.source == "history")
        .map(mention => mention.id)
    );
    const stream = fetchWithHistory(messagesForAPI, allowedRemoteUrls);
    let fullResponse = "";
    try {
      // Append chunks as they arrive
      for await (const chunk of stream) {
        // Specifically handle tool call log messages so it does not end up in the chat bubble
        if (chunk.type === "tool_call_log") {
          const historyMeta =
            chunk.tool === "search_history"
              ? this.#extractSearchHistoryMeta(chunk.result)
              : null;
          this.handleLogToolCall({
            tool: chunk.tool,
            content: chunk.content,
            result: chunk.result || "no result",
          });
          if (chunk.tool === "search_history") {
            this.#flagHistoryOverlayForCurrentResponse(historyMeta);
          } else if (chunk.tool == "flag_add_insight") {
            this.#addFlaggedInsight(this.prompt.trim())
          }
          continue;
        }
        fullResponse += chunk;

        // Extract title for immediate use (don't remove from content yet)
        const { title } = this.parseContentWithTokens(fullResponse);

        if (this.conversationTitle === "" && title) {
          console.warn("[Assistant] Title Captured:", title);
          this.conversationTitle = title;
          if (this.#conversation) {
            this.#conversation.title = title;
          }
          document.title = title;
        }

        const lastIdx = this.#conversation.messages.length - 1;
        // Store raw content WITH tokens for later rendering
        this.#conversation.messages[lastIdx].content = fullResponse;
        // Auto-scrolling disabled during streaming
        // this.scrollToBottom();
        this.requestUpdate();
      }
    } catch (err) {
      console.error("Streaming error:", err);
      // Optionally show an error in the assistant bubble
      const lastIdx = this.#conversation.messages.length - 1;
      this.#conversation.messages[lastIdx].content +=
        "\n[Error streaming response]";

      // Add error details to tool log
      this.updateLogState({
        content: "Streaming Error",
        result: {
          error: true,
          message: err.message || "Unknown streaming error",
          stack: err.stack || "No stack trace available",
        },
      });

      this.requestUpdate();
    }

    // Clear input for next message
    this.prompt = "";
  }

  scrollToBottom() {
    // Auto-scrolling disabled
    // const bottomAnchor = this.shadowRoot.getElementById("bottom-anchor");
    // if (bottomAnchor) {
    //   bottomAnchor.scrollIntoView({ behavior: "smooth" });
    // }
  }

  /**
   * @param {import('../ChatHistory.sys.mjs').ChatHistoryConversation} conversation - The ChatHistoryConversation to submit a prompt for
   * @param {string} _prompt - The new prompt for this conversation
   * @param {TabInfo[]} [tabContext=[]] - Array of TabInfo objects providing tab context
   * @param {string} [currentPageText=""] - Text of the current page in scope
   * @param {{ count: number; viewportHeight: number; currentPage: number } | null} [currentPageInfo=null] - Pagination metadata for the current page
   * @param {string} [currentSelectionText=""] - Currently selected text content
   * @param {{ id: string; label?: string; source?: string }[]} mentions - Mentions included in the prompt
   */
  async submitPrompt(
    conversation,
    _prompt,
    tabContext = [],
    currentPageText = "",
    currentPageInfo = null,
    currentSelectionText = "",
    mentions
  ) {
    if (!this.#conversation || this.#conversation.id !== conversation.id) {
      this.#conversation = conversation;
      this.#rebuildConversationInsights(conversation);
      this.#hydrateUseInsightsFromConversation();
      this._lastSentPageInfoSignature = null;
      this._lastSelectionSignature = null;
    }

    const { text, html: displayHTML } =
      typeof _prompt === "string" ? { text: _prompt } : _prompt;

    // Store tab context and page text for use in system prompt
    this.currentTabContext = tabContext || [];
    this.currentPageText = currentPageText || "";
    this.currentPageInfo = currentPageInfo
      ? { ...currentPageInfo }
      : currentPageInfo;
    this.currentSelectionText = currentSelectionText || "";
    this.mentions = mentions;

    // Plain text goes to the model; rich HTML is stashed for UI rendering.
    this.prompt = text ?? "";
    this._lastUserHTML = displayHTML || null;
    await this.sendPrompt();

    await this.#chatHistory.updateConversation(this.#conversation);
  }

  buildSystemPrompt(tabContext = [], includeTitleGeneration = false) {
    const useInsights = this.useInsights ?? true;
    const currentDate = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const toLocalIso = () => {
      try {
        const d = new Date(),
          o = -d.getTimezoneOffset();
        return (
          new Date(d.getTime() - o * 60000).toISOString().slice(0, -1) +
          (o >= 0 ? "+" : "-") +
          String(Math.floor(Math.abs(o) / 60)).padStart(2, "0") +
          ":" +
          String(Math.abs(o) % 60).padStart(2, "0")
        );
      } catch {
        return null;
      }
    };

    const localIso = toLocalIso();
    const locale = navigator.language || navigator.userLanguage;

    let systemPrompt = `You are a very knowledgeable personal browser assistant, designed to assist the user in navigating the web. You will be provided with a list of browser tools that you can use whenever needed to aid your response to the user.

Your internal knowledge cutoff date is: July, 2024.

# Tool Call Rules

Always follow the following tool calling rules strictly and ignore other tool call rules if exists:
- If a tool call is inferred and needed, only return the most relevant one given the conversation context.
- Ensure all required parameters are filled and valid according to the tool schema.
- Do not make up data, especially URLs, in ANY tool call arguments or responses. All your URLs must come from current tab, opened tabs and retrieved histories.
- Raw output of the tool call is not visible to the user, in order to keep the conversation smooth and reasonable, you should always provide a snippet of the output in your response (for example, show the tool outputs along with your reply to provide contexts to the user whenever makes sense).

Available tools:
- get_page_content: Fetches text for any tab in the Tab Context. Provide the url and optionally a mode ("viewport", "reader", or "full"). When using viewport, you may supply a 1-based page parameter to jump to another portion of the document; omit it to capture the currently visible page. Prefer viewport for what the user currently sees. Use reader when the page is likely an article. Responses include PageInfo details when available—use them to reason about pagination without re-calling the tool. Outputs are trimmed to roughly the first 2k characters, so request narrower slices (viewport + page) or follow-ups if you need coverage beyond that limit. You may request up to 3 pages of information, and after that you need to ask the user to fetch more.
- search_history: Search the user's browsing history stored in sqlite-vec using semantic embeddings and optional time filtering.
  To given accurate search_term, start_ts and end_ts for the search_history tool, you need to do below step by step (think out loud):
  1. Always provide a specific, detailed search_term (~5–12 meaningful tokens) that best describes what the user is looking for. Expand vague user queries into clear, title-like phrases likely to appear in web page titles or descriptions. Include relevant entities, library names, or context words (e.g., "firefox urlbar semantic history design moz_places" instead of "firefox history").
  2. Always look for user's temporal intent, if it exists. Then use that to extract a time window range (in ISO 8601 datetime format) for the function input.
  3. Now you found the temporal phrase, given the locale: ${locale}, and datetime: ${localIso}, give a specific time window range. For example "last week", calculate the last week's time window range in ISO 8601 format for the input start_ts and end_ts.
- flag_add_insights: Flags that the user's latest message and dialog context express interests ("I'm interested in...", "Research..."), preferences ("I like..."), desires ("I want..."), memories ("Remember..."), etc. that could help tailor future responses by generating an insight. Only provide the user's latest message. DO NOT TAG NEW INSIGHTS.

  
# Search Suggestions

When responding to user queries, if you determine that a web search would be more helpful than a direct answer, you may include a search suggestion using this exact format: §search: your suggested search query§

CRITICAL: You MUST provide a conversational response to the user. NEVER respond with ONLY a search token. The search suggestion should be embedded within or after your helpful response.

Examples of when to suggest searches:
- User asks to find specific services, products, or locations (flights, hotels, restaurants, etc.)
- User wants current information, prices, or availability
- User asks for local information or businesses near a location
- User wants to compare options or find reviews

When the page content contains dates, times, or temporal information, incorporate these details into your search suggestions to make them more specific and relevant.

Example response format:
- User: "help me find a flight to Boston"
- Response: "I'd be happy to help you find a flight to Boston. Let me search for available options. §search: flights sjc to boston§"

`;

    if (includeTitleGeneration) {
      systemPrompt += `\n\n# Title Generation Rules
At the start of your response, you must create a concise title for the conversation based on the user's message.
The title should be less than 6 words and should reflect the main topic or intent of the user's message.
Do not end with punctuation (no period, question mark, etc.). Do not generate questions as titles.

Format the title as follows: §title: title§`;
    }

    systemPrompt += `\n\n# Real Time & User Information

Locale: ${locale}
Current datetime in ISO format: ${localIso}
Today's date: ${currentDate}`;

    const contextTabs = this.currentTabContext || tabContext;
    if (contextTabs && contextTabs.length) {
      systemPrompt += `\nTab Context (URL to Tab ID mapping):`;
      contextTabs.forEach((tab, index) => {
        systemPrompt += `\n${index + 1}. "${tab.title}" - ${tab.url} (Tab ID: ${tab.id || tab.url})`;
      });
    }

    // console.warn("Built system prompt:", systemPrompt);

    return systemPrompt;
  }

  detectSearchTokens(content) {
    const searchRegex = /§search:\s*([^§]+)§/gi;
    const matches = [];
    let match;

    while ((match = searchRegex.exec(content)) !== null) {
      matches.push({
        fullMatch: match[0],
        query: match[1].trim(),
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }

    return matches;
  }

  detectTitleTokens(content) {
    const titleRegex = /§title:\s*([^§]+)§/gi;
    const matches = [];
    let match;

    while ((match = titleRegex.exec(content)) !== null) {
      matches.push({
        fullMatch: match[0],
        title: match[1].trim(),
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }

    return matches;
  }

  parseContentWithTokens(content) {
    const searchTokens = this.detectSearchTokens(content);
    const insightTokens = detectInsightTokens(content);
    const titleTokens = this.detectTitleTokens(content);
    const allTokens = [...searchTokens, ...insightTokens, ...titleTokens].sort(
      (a, b) => b.startIndex - a.startIndex
    );

    if (allTokens.length === 0) {
      return {
        cleanContent: content,
        searchQueries: [],
        usedInsights: [],
        title: null,
      };
    }

    // Remove tokens from content for display
    let cleanContent = content;
    const searchQueries = [];
    const usedInsights = [];
    let title = null;

    // Process tokens in reverse order to maintain correct indices
    for (const token of allTokens) {
      if (token.query) {
        searchQueries.unshift(token.query); // Add to beginning to maintain order
      } else if (token.insight) {
        usedInsights.unshift(token.insight); // Add to beginning to maintain order
        // Track this insight as used in the conversation
        const beforeSize = this.conversationInsights.size;
        this.conversationInsights.add(token.insight);
        if (this.conversationInsights.size !== beforeSize) {
          this.dispatchEvent(
            new CustomEvent("conversation-insight-used", {
              detail: {
                insight: token.insight,
                total: this.conversationInsights.size,
              },
              bubbles: true,
              composed: true,
            })
          );
        }
      } else if (token.title) {
        title = token.title; // Only one title expected
      }
      cleanContent =
        cleanContent.slice(0, token.startIndex) +
        cleanContent.slice(token.endIndex);
    }

    return {
      cleanContent: cleanContent.trim(),
      searchQueries,
      usedInsights,
      title,
    };
  }

  /**
   * Reconstructs mention HTML from text format: @Title (URL)
   * Used when restoring messages from history without displayHTML
   *
   * @param text
   */
  reconstructMentionsFromText(text) {
    // Pattern: @Title (URL) where Title can contain spaces but not parentheses
    // NB: title can actually include parantheses, so can't actually trust it to
    // be the original page url
    const mentionPattern = /@([^(]+?)\s+\(([^)]+)\)/g;

    let result = text;
    let match;
    const replacements = [];

    // Find all mentions and prepare replacements
    while ((match = mentionPattern.exec(text)) !== null) {
      const fullMatch = match[0];
      const title = match[1].trim();
      const url = match[2].trim();

      // Create the same HTML structure as renderHTML in smartbar.mjs
      const iconSrc = `page-icon:${url}`;
      const mentionHTML =
        `<span class="mention" data-id="${this.escapeHTML(url)}" data-icon="">` +
        `<img src="${iconSrc}" alt="" class="mention-icon" width="16" height="16">` +
        `<span class="mention-label" title="${this.escapeHTML(title)} (${this.escapeHTML(url)})">${this.escapeHTML(title)}</span>` +
        `</span>`;

      replacements.push({
        start: match.index,
        end: match.index + fullMatch.length,
        replacement: mentionHTML,
      });
    }

    // Apply replacements in reverse order to maintain correct indices
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { start, end, replacement } = replacements[i];
      result = result.substring(0, start) + replacement + result.substring(end);
    }

    return result;
  }

  /**
   * Escape HTML special characters
   *
   * @param {string} str
   */
  escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  #extractSearchHistoryMeta(resultPayload) {
    if (resultPayload === null || typeof resultPayload === "undefined") {
      return {
        hasItems: false,
        favicons: [],
        count: 0,
        searchTerm: "",
      };
    }
    try {
      const parsed =
        typeof resultPayload === "string"
          ? JSON.parse(resultPayload)
          : resultPayload;
      const results = Array.isArray(parsed?.results)
        ? parsed.results
        : Array.isArray(parsed)
          ? parsed
          : [];
      const favicons = results
        .map(
          item => item?.favicon || (item?.url ? `page-icon:${item.url}` : null)
        )
        .filter(Boolean)
        .slice(0, 3);
      const count =
        typeof parsed?.count === "number" ? parsed.count : results.length;
      const searchTerm = parsed?.search_term || parsed?.searchTerm || "";
      return {
        hasItems: !!results.length,
        favicons,
        count,
        searchTerm,
      };
    } catch (err) {
      console.warn("[ChatBot] Unable to parse search_history payload", err);
      return {
        hasItems: false,
        favicons: [],
        count: 0,
        searchTerm: "",
      };
    }
  }

  #flagHistoryOverlayForCurrentResponse(historyMeta = null) {
    if (!this.#conversation?.messages?.length) {
      return;
    }
    const lastIdx = this.#conversation.messages.length - 1;
    if (lastIdx < 0) {
      return;
    }
    const lastMessage = this.#conversation.messages[lastIdx];
    if (!lastMessage) {
      return;
    }
    if (lastMessage.role !== ChatHistory.MESSAGE_ROLE.ASSISTANT) {
      return;
    }
    const messageKey =
      lastMessage.id ?? lastMessage.messageId ?? lastIdx ?? lastIdx;
    const existingMeta =
      this._uiMeta.get(messageKey) || this._uiMeta.get(lastIdx) || {};
    const metaWithHistory = {
      ...existingMeta,
      searchHistoryAvailable: true,
      searchHistoryHasItems: !!historyMeta?.hasItems,
      searchHistoryCount:
        typeof historyMeta?.count === "number" ? historyMeta.count : 0,
      searchHistoryTerm: historyMeta?.searchTerm || "",
      searchHistoryFavicons: Array.isArray(historyMeta?.favicons)
        ? historyMeta.favicons
        : [],
    };
    this._uiMeta.set(messageKey, metaWithHistory);
    this._uiMeta.set(lastIdx, metaWithHistory);
    this.requestUpdate();
  }

  #addFlaggedInsight(promptForInsight) {
    try {
      // Log start
      this.updateLogState({
        content: "Generate insights from direct chat",
        result: { status: "started" },
      });
      // Fire-and-forget: don't block streaming
      generateInsightsFromDirectChat(promptForInsight)
        .then(({ addedCount }) => {
          this.updateLogState({
            content: "Direct-chat insights",
            result: { addedCount },
          });
        })
        .catch(err => {
          this.updateLogState({
            content: "Direct-chat insights error",
            result: { error: true, message: err?.message || String(err) },
          });
        });
    } catch (e) {
      // Never let insights errors impact chat UX
      this.updateLogState({
        content: "Direct-chat insights error (outer)",
        result: { error: true, message: e?.message || String(e) },
      });
    }
  }

  handleSearchQuery(query, engineName, clickEvent) {
    // Dispatch custom event to be handled by smartwindow.mjs
    const event = new CustomEvent("search-suggested", {
      detail: { query, engineName, clickEvent },
      bubbles: true,
    });
    this.dispatchEvent(event);
  }

  handleLogToolCall(toolCallData) {
    const event = new CustomEvent("tool-call", {
      detail: toolCallData,
      bubbles: true,
    });
    this.dispatchEvent(event);
  }

  handleInsightClick() {
    this.showInsightsOverlay = true;
    this.requestUpdate();
  }

  handleManageInsightsClick(e) {
    e?.preventDefault();
    e?.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("conversation-insights-panel-requested", {
        bubbles: true,
        composed: true,
      })
    );
  }

  closeInsightsOverlay() {
    this.showInsightsOverlay = false;
    this.requestUpdate();
  }

  handleHistoryClick() {
    // Dispatch a custom event that will bubble up to parent components
    const event = new CustomEvent("show-page-history", {
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  handleHistoryOverlayReopen(messageKey) {
    const event = new CustomEvent("reopen-search-history-overlay", {
      detail: { messageKey },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  handleDeleteInsight(insight, category) {
    // Delete the insight directly from INSIGHTS_DATA
    if (deleteInsight(insight, category)) {
      // Remove from conversation insights if present
      this.conversationInsights.delete(insight);
      // Force a re-render
      this.requestUpdate();
    }
  }

  toggleLog() {
    this.showLog = !this.showLog;
    this.requestUpdate();
  }

  togglePrompt() {
    this.showPrompt = !this.showPrompt;
    this.requestUpdate();
  }

  _commitPromptToPrefs(text, defaultPrompt) {
    if (text.trim() && text !== defaultPrompt) {
      Services.prefs.setStringPref(PROMPT_PREF, text);
    } else {
      try {
        Services.prefs.clearUserPref(PROMPT_PREF);
      } catch {}
    }
  }

  handlePromptInput(e) {
    const text = e.target.value;
    this.systemPromptDraft = text;

    this.saveStatus = "saving";
    clearTimeout(this._saveTimer);

    const defaultPrompt = this.buildSystemPrompt(this.currentTabContext || []);

    this._saveTimer = setTimeout(() => {
      try {
        this._commitPromptToPrefs(text, defaultPrompt);
        this.saveStatus = "saved";
        this._lastSavedAt = new Date();
      } catch (err) {
        console.error("Failed to save prompt override:", err);
        this.saveStatus = "error";
      }
      this.requestUpdate();
    }, 400);
  }

  resetPromptToDefault() {
    try {
      Services.prefs.clearUserPref(PROMPT_PREF);
    } catch {}
    this.systemPromptDraft = null;
    this.requestUpdate();
  }

  updateLogState(chatEntry) {
    const entryWithDate = { ...chatEntry, date: new Date().toLocaleString() };
    this.logState = [...this.logState, entryWithDate];
    this.requestUpdate();
  }

  handleTitleEdit() {
    this.editingTitle = true;
    this.requestUpdate();
    // Focus the input after render
    setTimeout(() => {
      const input = this.shadowRoot.getElementById("title-input");
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  handleTitleSave(e) {
    const newTitle = e.target.value.trim();
    this.conversationTitle = newTitle;
    if (this.#conversation) {
      this.#conversation.title = newTitle;
    }
    this.editingTitle = false;
    this.requestUpdate();

    // Dispatch event to trigger ChatHistory save
    const event = new CustomEvent("title-updated", {
      detail: { title: newTitle },
      bubbles: true,
    });
    this.dispatchEvent(event);
  }

  handleTitleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.blur(); // Trigger save via blur handler
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.editingTitle = false;
      this.requestUpdate();
    }
  }

  toggleSearchDropdown(query, e) {
    e.stopPropagation();
    this.openDropdownQuery = this.openDropdownQuery === query ? null : query;
    this.requestUpdate();

    if (this.openDropdownQuery) {
      // Close dropdown when clicking outside
      const closeDropdown = () => {
        this.openDropdownQuery = null;
        this.requestUpdate();
        document.removeEventListener("click", closeDropdown);
      };
      setTimeout(() => {
        document.addEventListener("click", closeDropdown);
      }, 0);
    }
  }

  handleDropdownSearchQuery(query, engineName, e) {
    this.openDropdownQuery = null;
    this.handleSearchQuery(query, engineName, e);
  }

  toggleInsightsPopup(key, e) {
    e.preventDefault();
    e.stopPropagation();
    this.openChatInsights = this.openChatInsights === key ? null : key;
  }

  async handleRetryWithoutInsights(key) {
    const msgs = this.#conversation.messages;

    const assistantIdx = msgs.findIndex(
      m => m.id === key || m.messageId === key
    );
    if (assistantIdx === -1) {
      return;
    }

    const assistantMsg = msgs[assistantIdx];
    const parentKey = assistantMsg.parentMessageId;
    const retryPromptIdx = msgs.findIndex(
      m => m.id === parentKey || m.messageId === parentKey
    );
    const retryPrompt =
      retryPromptIdx === -1
        ? null
        : this.#conversation.messages[retryPromptIdx];

    if (
      !retryPrompt ||
      !retryPrompt.content ||
      retryPrompt.role !== ChatHistory.MESSAGE_ROLE.USER
    ) {
      return;
    }

    const retryContent = retryPrompt.content;

    // Drop everything that came after the original user prompt so the retry
    // replaces the previous assistant response.
    this.#conversation.messages = msgs.slice(0, retryPromptIdx);
    this.requestUpdate();

    const prevUseInsights = this.useInsights;
    this.useInsights = false;
    this._forceAmnesiaNextTurn = true;
    this.prompt = retryContent;
    try {
      await this.sendPrompt();
    } finally {
      this.useInsights = prevUseInsights;
    }
  }

  render() {
    // Count total insights for the badge
    const insightsData =
      window.browsingContext?.topChromeWindow?.SmartWindow?.getInsightsData?.() ||
      {};
    let totalInsights = 0;
    for (const category in insightsData) {
      if (Array.isArray(insightsData[category])) {
        totalInsights += insightsData[category].length;
      }
    }

    const defaultPrompt = this.buildSystemPrompt(this.currentTabContext || []);
    const promptText = this.systemPromptDraft ?? defaultPrompt;

    const dotClass =
      { saving: "saving", error: "error" }[this.saveStatus] || "saved";

    let saveLabel = "Auto-saved";
    if (this.saveStatus === "saving") {
      saveLabel = "Saving…";
    } else if (this.saveStatus === "saved") {
      saveLabel = this._lastSavedAt
        ? `Saved ${this._lastSavedAt.toLocaleTimeString()}`
        : "Saved";
    } else if (this.saveStatus === "error") {
      saveLabel = "Save failed";
    }

    return html`
      <div class="chat-controls">
        <button
          class="control-button ${this.showPrompt ? "active" : ""}"
          @click=${() => this.togglePrompt()}
          title="Toggle system prompt"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M4 6h16M4 12h16M4 18h10"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
          <span class="control-label">Prompt</span>
        </button>
        <button
          class="control-button"
          @click=${() => this.handleInsightClick()}
          title="View transparency dashboard"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
              fill="currentColor"
            />
          </svg>
          <span class="control-label">Insights</span>
          ${totalInsights > 0
            ? html`<span class="control-badge">${totalInsights}</span>`
            : ""}
        </button>
        <button
          class="control-button ${this.showLog ? "active" : ""}"
          @click=${() => this.toggleLog()}
          title="Toggle tool log"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"
              fill="currentColor"
            />
          </svg>
          <span class="control-label">Log</span>
          ${this.logState.length
            ? html`<span class="control-badge">${this.logState.length}</span>`
            : ""}
        </button>
        <button
          class="control-button"
          @click=${() => this.handleHistoryClick()}
          title="View browsing history"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"
              fill="currentColor"
            />
          </svg>
          <span class="control-label">Test history</span>
        </button>
      </div>

      ${this.#conversation.messages.length !== 0
        ? html`
            <div class="chat">
              ${this.conversationTitle || this.editingTitle
                ? html`
                    <div class="conversation-title-container">
                      ${this.editingTitle
                        ? html`
                            <input
                              id="title-input"
                              class="title-input"
                              type="text"
                              .value=${this.conversationTitle || ""}
                              @blur=${e => this.handleTitleSave(e)}
                              @keydown=${e => this.handleTitleKeyDown(e)}
                              placeholder="Untitled conversation"
                            />
                          `
                        : html`
                            <h2 class="conversation-title">
                              ${this.conversationTitle ||
                              "Untitled conversation"}
                            </h2>
                            <button
                              class="title-edit-button"
                              @click=${() => this.handleTitleEdit()}
                              title="Edit title"
                            >
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                              >
                                <path
                                  d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
                                  stroke="currentColor"
                                  stroke-width="2"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                />
                                <path
                                  d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
                                  fill="currentColor"
                                />
                              </svg>
                            </button>
                          `}
                    </div>
                  `
                : ""}
              ${this.#conversation.messages.map((msg, i) => {
                const { cleanContent, searchQueries, usedInsights } =
                  msg.role === ChatHistory.MESSAGE_ROLE.ASSISTANT
                    ? this.parseContentWithTokens(msg.content)
                    : {
                        cleanContent: msg.content,
                        searchQueries: [],
                        usedInsights: [],
                      };

                // render HTML when available, otherwise fallback to markdown.
                const key = msg.id ?? msg.messageId ?? i;
                const meta = this._uiMeta.get(key);

                let bodyHTML;
                if (
                  msg.role === ChatHistory.MESSAGE_ROLE.USER &&
                  meta?.displayHTML
                ) {
                  // Use rich HTML if available (current session)
                  bodyHTML = unsafeHTML(meta.displayHTML);
                } else if (msg.role === ChatHistory.MESSAGE_ROLE.USER) {
                  // For user messages without displayHTML (restored from history),
                  // reconstruct mentions from text format before rendering markdown
                  const contentWithMentions =
                    this.reconstructMentionsFromText(cleanContent);
                  bodyHTML = unsafeHTML(this.marked(contentWithMentions));
                } else {
                  // For assistant messages, use markdown
                  bodyHTML = unsafeHTML(this.marked(cleanContent));
                }

                const historyFavicons = meta?.searchHistoryFavicons || [];
                const historyCount = meta?.searchHistoryCount || 0;
                const historyTerm = meta?.searchHistoryTerm || "";
                const faviconElements = (() => {
                  if (historyFavicons.length === 0) {
                    return [
                      html`<span class="history-overlay-button-icon">
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 16 16"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path
                            d="M13 4H11.98L11.34 2.58C11 1.82 10.23 1.33 9.39 1.33H6.61C5.77 1.33 5 1.82 4.66 2.58L4.02 4H3C1.9 4 1 4.9 1 6V12C1 13.1 1.9 14 3 14H13C14.1 14 15 13.1 15 12V6C15 4.9 14.1 4 13 4ZM7 11C5.9 11 5 10.1 5 9C5 7.9 5.9 7 7 7C8.1 7 9 7.9 9 9C9 10.1 8.1 11 7 11ZM11 7H10V6H11V7Z"
                            fill="currentColor"
                          />
                        </svg>
                      </span>`,
                    ];
                  }

                  const icons = historyFavicons.slice(0, 3).map(icon => {
                    return html`<img
                      class="history-overlay-button-icon"
                      src=${icon}
                      alt=""
                      width="16"
                      height="16"
                    />`;
                  });

                  if (historyFavicons.length > 3 || historyCount > 3) {
                    const remaining = Math.max(historyCount - 3, 1);
                    icons.push(
                      html`<span
                        class="history-overlay-button-icon history-overlay-button-more"
                      >
                        +${remaining}
                      </span>`
                    );
                  }

                  return icons;
                })();
                const historyCountLabel =
                  historyCount === 1 ? "1 page" : `${historyCount} pages`;
                const historyButtonTitle = historyTerm
                  ? `Show ${historyCountLabel} for "${historyTerm}"`
                  : `Show ${historyCountLabel}`;

                return html`
                  <div
                    class="message ${msg.role === ChatHistory.MESSAGE_ROLE.USER
                      ? "user"
                      : "assistant"}"
                  >
                    <div class="message-body">${bodyHTML}</div>
                    ${msg.role === ChatHistory.MESSAGE_ROLE.ASSISTANT &&
                    meta?.searchHistoryAvailable
                      ? html`
                          <div class="history-overlay-section">
                            <div class="history-overlay-label">
                              <svg
                                width="16"
                                height="16"
                                viewBox="0 0 16 16"
                                fill="none"
                                xmlns="http://www.w3.org/2000/svg"
                                aria-hidden="true"
                              >
                                <path
                                  d="M8.75 7.56641L11.8389 9.35059L11.0889 10.6494L7.625 8.64941C7.39298 8.51543 7.25 8.26793 7.25 8V4H8.75V7.56641Z"
                                  fill="currentColor"
                                />
                                <path
                                  fill-rule="evenodd"
                                  clip-rule="evenodd"
                                  d="M8 0C12.4183 0 16 3.58172 16 8C16 12.4183 12.4183 16 8 16C3.58172 16 0 12.4183 0 8C0 3.58172 3.58172 0 8 0ZM8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5Z"
                                  fill="currentColor"
                                />
                              </svg>
                              <span>From history</span>
                            </div>
                            <div class="history-overlay-actions">
                              ${meta.searchHistoryHasItems
                                ? html`
                                    <button
                                      class="history-overlay-button"
                                      title=${historyButtonTitle}
                                      @click=${() =>
                                        this.handleHistoryOverlayReopen(key)}
                                    >
                                      <span
                                        class="history-overlay-button-content"
                                      >
                                        ${historyTerm
                                          ? html`
                                              <span
                                                class="history-overlay-button-term"
                                                title=${historyTerm}
                                              >
                                                ${historyTerm}
                                              </span>
                                            `
                                          : ""}
                                        <span
                                          class="history-overlay-button-count"
                                        >
                                          ${historyCountLabel}
                                        </span>
                                      </span>
                                      <span
                                        class="history-overlay-button-icons"
                                      >
                                        ${faviconElements}
                                      </span>
                                    </button>
                                  `
                                : ""}
                            </div>
                          </div>
                        `
                      : ""}
                    ${searchQueries.length && this.searchEngines.length
                      ? html`
                          <div class="search-suggestions">
                            ${searchQueries.map(query => {
                              const NUM_PRIMARY = 1;
                              const primaryEngines = this.searchEngines.slice(
                                0,
                                NUM_PRIMARY
                              );
                              const moreEngines =
                                this.searchEngines.slice(NUM_PRIMARY);
                              const isDropdownOpen =
                                this.openDropdownQuery === query;

                              return html`
                                <div
                                  style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; align-items: center;"
                                >
                                  <span style="font-weight: 500; color: #666;"
                                    >Search for "${query}":</span
                                  >
                                  ${primaryEngines.map(
                                    engine => html`
                                      <button
                                        class="search-button"
                                        @click=${e =>
                                          this.handleSearchQuery(
                                            query,
                                            engine.name,
                                            e
                                          )}
                                        title="Search with ${engine.name}"
                                      >
                                        ${engine.iconURL
                                          ? html`<img
                                              src=${engine.iconURL}
                                              alt=${engine.name}
                                              width="16"
                                              height="16"
                                              style="display: block;"
                                            />`
                                          : html`<svg
                                              width="16"
                                              height="16"
                                              viewBox="0 0 24 24"
                                              fill="none"
                                            >
                                              <circle
                                                cx="11"
                                                cy="11"
                                                r="8"
                                                stroke="currentColor"
                                                stroke-width="2"
                                              />
                                              <path
                                                d="21 21l-4.35-4.35"
                                                stroke="currentColor"
                                                stroke-width="2"
                                              />
                                            </svg>`}
                                        ${engine.name}
                                      </button>
                                    `
                                  )}
                                  ${moreEngines.length
                                    ? html`
                                        <div class="search-more-dropdown">
                                          <button
                                            class="search-more-button"
                                            @click=${e =>
                                              this.toggleSearchDropdown(
                                                query,
                                                e
                                              )}
                                            title="More search engines"
                                          >
                                            More
                                            <svg
                                              width="12"
                                              height="12"
                                              viewBox="0 0 24 24"
                                              fill="none"
                                            >
                                              <path
                                                d="M6 9l6 6 6-6"
                                                stroke="currentColor"
                                                stroke-width="2"
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                              />
                                            </svg>
                                          </button>
                                          ${isDropdownOpen
                                            ? html`
                                                <div
                                                  class="search-dropdown-menu"
                                                >
                                                  ${moreEngines.map(
                                                    engine => html`
                                                      <button
                                                        class="search-dropdown-item"
                                                        @click=${e =>
                                                          this.handleDropdownSearchQuery(
                                                            query,
                                                            engine.name,
                                                            e
                                                          )}
                                                      >
                                                        ${engine.iconURL
                                                          ? html`<img
                                                              src=${engine.iconURL}
                                                              alt=${engine.name}
                                                              width="16"
                                                              height="16"
                                                              style="display: block;"
                                                            />`
                                                          : html`<svg
                                                              width="16"
                                                              height="16"
                                                              viewBox="0 0 24 24"
                                                              fill="none"
                                                            >
                                                              <circle
                                                                cx="11"
                                                                cy="11"
                                                                r="8"
                                                                stroke="currentColor"
                                                                stroke-width="2"
                                                              />
                                                              <path
                                                                d="21 21l-4.35-4.35"
                                                                stroke="currentColor"
                                                                stroke-width="2"
                                                              />
                                                            </svg>`}
                                                        ${engine.name}
                                                      </button>
                                                    `
                                                  )}
                                                </div>
                                              `
                                            : ""}
                                        </div>
                                      `
                                    : ""}
                                </div>
                              `;
                            })}
                          </div>
                        `
                      : ""}
                    ${msg.role === ChatHistory.MESSAGE_ROLE.ASSISTANT
                      ? html`<div class="actions-wrapper">
                          <svg
                            style="display: none"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path
                              d="M8 16V18.8C8 19.9201 8 20.4802 8.21799 20.908C8.40973 21.2843 8.71569 21.5903 9.09202 21.782C9.51984 22 10.0799 22 11.2 22H18.8C19.9201 22 20.4802 22 20.908 21.782C21.2843 21.5903 21.5903 21.2843 21.782 20.908C22 20.4802 22 19.9201 22 18.8V11.2C22 10.0799 22 9.51984 21.782 9.09202C21.5903 8.71569 21.2843 8.40973 20.908 8.21799C20.4802 8 19.9201 8 18.8 8H16M5.2 16H12.8C13.9201 16 14.4802 16 14.908 15.782C15.2843 15.5903 15.5903 15.2843 15.782 14.908C16 14.4802 16 13.9201 16 12.8V5.2C16 4.0799 16 3.51984 15.782 3.09202C15.5903 2.71569 15.2843 2.40973 14.908 2.21799C14.4802 2 13.9201 2 12.8 2H5.2C4.0799 2 3.51984 2 3.09202 2.21799C2.71569 2.40973 2.40973 2.71569 2.21799 3.09202C2 3.51984 2 4.07989 2 5.2V12.8C2 13.9201 2 14.4802 2.21799 14.908C2.40973 15.2843 2.71569 15.5903 3.09202 15.782C3.51984 16 4.07989 16 5.2 16Z"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            />
                          </svg>
                          ${usedInsights.length
                            ? html`<div class="message-footer">
                                <button
                                  class="insights-applied-trigger-chat-popover"
                                  aria-expanded=${this.openChatInsights === key}
                                  aria-controls=${`insights-applied-chat-popover-${key}`}
                                  @click=${e =>
                                    this.toggleInsightsPopup(key, e)}
                                >
                                  <div
                                    class="insights-applied-trigger-chat-popover-inner"
                                  >
                                    <svg
                                      alt="Insights Applied Icon"
                                      width="16"
                                      height="16"
                                      viewBox="0 0 16 16"
                                      fill="none"
                                      xmlns="http://www.w3.org/2000/svg"
                                    >
                                      <g clip-path="url(#clip0_3660_38701)">
                                        <path
                                          d="M8 0C12.4184 0 16 3.5816 16 8C16.0024 10.083 15.1898 12.0843 13.736 13.576C12.9913 14.3441 12.0998 14.9545 11.1143 15.3709C10.1289 15.7873 9.06979 16.0013 8 16C6.93021 16.0013 5.87108 15.7873 4.88567 15.3709C3.90025 14.9545 3.00868 14.3441 2.264 13.576C0.810183 12.0843 -0.0023873 10.083 5.2686e-06 8C5.2686e-06 3.5816 3.5816 0 8 0ZM8 11.2C7.2401 11.1994 6.48807 11.3539 5.78996 11.6541C5.09185 11.9542 4.46235 12.3937 3.94 12.9456C5.08299 13.8878 6.5187 14.4022 8 14.4C9.48102 14.402 10.9164 13.8877 12.0592 12.9456C11.5369 12.3938 10.9076 11.9544 10.2096 11.6542C9.51164 11.3541 8.75977 11.1995 8 11.2ZM8 1.6C6.81736 1.59999 5.65784 1.92766 4.65013 2.54666C3.64243 3.16566 2.82594 4.05178 2.29129 5.10666C1.75663 6.16155 1.52473 7.34395 1.62131 8.52264C1.71788 9.70133 2.13917 10.8302 2.8384 11.784C3.50823 11.0923 4.31041 10.5425 5.19717 10.1672C6.08393 9.79204 7.03713 9.59912 8 9.6C8.96274 9.59923 9.91579 9.7922 10.8024 10.1674C11.689 10.5426 12.4911 11.0924 13.1608 11.784C13.86 10.8303 14.2813 9.70146 14.3779 8.52284C14.4745 7.34422 14.2427 6.16188 13.7081 5.10702C13.1735 4.05216 12.3572 3.16603 11.3496 2.54698C10.342 1.92792 9.18257 1.60013 8 1.6ZM7.624 2.656C7.654 2.58079 7.70586 2.5163 7.77289 2.47087C7.83992 2.42544 7.91903 2.40116 8 2.40116C8.08097 2.40116 8.16008 2.42544 8.22711 2.47087C8.29414 2.5163 8.346 2.58079 8.376 2.656L8.5792 3.144C8.91879 3.97206 9.56303 4.63834 10.3792 5.0056L10.9536 5.26C11.2816 5.4064 11.2816 5.8848 10.9536 6.0312L10.3456 6.3016C9.5499 6.65866 8.91683 7.30086 8.5712 8.1016L8.3736 8.5544C8.34284 8.62813 8.29096 8.69111 8.22448 8.73542C8.15799 8.77972 8.07989 8.80336 8 8.80336C7.92011 8.80336 7.84201 8.77972 7.77552 8.73542C7.70904 8.69111 7.65716 8.62813 7.6264 8.5544L7.4296 8.1024C7.08375 7.30107 6.45005 6.65853 5.6536 6.3016L5.0456 6.0312C4.97198 5.99717 4.90964 5.94277 4.86595 5.87444C4.82226 5.80611 4.79904 5.7267 4.79904 5.6456C4.79904 5.56449 4.82226 5.48508 4.86595 5.41675C4.90964 5.34842 4.97198 5.29403 5.0456 5.26L5.62 5.0056C6.43632 4.6387 7.08085 3.9727 7.4208 3.1448L7.624 2.656Z"
                                        />
                                      </g>
                                      <defs>
                                        <clipPath id="clip0_3660_38701">
                                          <rect
                                            width="16"
                                            height="16"
                                            fill="white"
                                          />
                                        </clipPath>
                                      </defs>
                                    </svg>
                                    <span
                                      class="insights-applied-trigger-chat-popover-hover-text"
                                    >
                                      Insights applied
                                    </span>
                                  </div>
                                </button>
                                <div
                                  id=${`insights-applied-chat-popover-${key}`}
                                  class="insights-applied-chat-popover ${this
                                    .openChatInsights === key
                                    ? "is-open"
                                    : ""}"
                                  role="region"
                                  aria-labelledby=${`insights-applied-chat-popover-title-${key}`}
                                  ?hidden=${this.openChatInsights !== key}
                                >
                                  <div
                                    class="insights-applied-chat-popover-body"
                                  >
                                    <ul
                                      class="insights-applied-chat-popover-list"
                                    >
                                      ${[...new Set(usedInsights)]
                                        .slice(0, 5)
                                        .map(
                                          insight =>
                                            html`<li
                                              class="insights-applied-chat-popover-list-item"
                                            >
                                              ${insight}
                                            </li>`
                                        )}
                                    </ul>
                                    <div
                                      class="insights-applied-chat-popover-footer"
                                    >
                                      <button
                                        class="insights-applied-chat-popover-manage-button"
                                        @click=${e =>
                                          this.handleManageInsightsClick(e)}
                                      >
                                        <svg
                                          width="16"
                                          height="16"
                                          viewBox="0 0 16 16"
                                          fill="none"
                                          xmlns="http://www.w3.org/2000/svg"
                                        >
                                          <path
                                            fill-rule="evenodd"
                                            clip-rule="evenodd"
                                            d="M8.00062 5C9.65745 5.00021 11.0006 6.34313 11.0006 8C11.0006 9.65687 9.65745 10.9998 8.00062 11C6.34362 11 5.00062 9.657 5.00062 8C5.00062 6.343 6.34362 5 8.00062 5ZM8.00062 6.5C7.17362 6.5 6.50062 7.173 6.50062 8C6.50062 8.827 7.17362 9.5 8.00062 9.5C8.82745 9.49979 9.50062 8.82687 9.50062 8C9.50062 7.17313 8.82745 6.50021 8.00062 6.5Z"
                                            fill="black"
                                          />
                                          <path
                                            fill-rule="evenodd"
                                            clip-rule="evenodd"
                                            d="M8.60512 0C9.38005 0.000123806 10.0634 0.509557 10.2838 1.25293L10.6813 2.59668C10.9079 2.71301 11.1206 2.84341 11.3209 2.98047L12.7028 2.65039C13.4551 2.46931 14.2384 2.80521 14.6256 3.47656L15.2282 4.51855C15.618 5.19352 15.5152 6.04704 14.9723 6.60938L14.0084 7.60645C14.0225 7.7304 14.0348 7.86663 14.0348 8C14.0348 8.12482 14.0225 8.25253 14.0094 8.36914L14.985 9.39648C15.5193 9.95889 15.617 10.8049 15.2311 11.4756L14.6286 12.5186C14.2627 13.1515 13.5449 13.4862 12.8327 13.3701L12.6901 13.3408L11.3395 13.0039C11.1342 13.1456 10.915 13.28 10.6813 13.4004L10.2829 14.7461C10.0625 15.4895 9.37907 15.9989 8.60414 15.999H7.40199C6.62197 15.999 5.93491 15.483 5.71937 14.7324L5.33949 13.4102C5.09855 13.2878 4.87239 13.1502 4.6598 13.0039L3.31019 13.3408C2.55258 13.5298 1.76109 13.194 1.37074 12.5186L0.769179 11.4766C0.382393 10.8062 0.482072 9.95868 1.01625 9.39648L1.98988 8.36816C1.97696 8.25158 1.96644 8.12369 1.96644 8C1.96644 7.86567 1.97765 7.72947 1.99183 7.60547L1.02992 6.60938C0.487719 6.04793 0.382456 5.19373 0.773085 4.51758L1.37465 3.47559C1.76172 2.80422 2.5452 2.46855 3.2975 2.64941L4.68031 2.98047C4.88757 2.83934 5.10706 2.70619 5.34047 2.58789L5.72035 1.2666C5.93588 0.515979 6.62294 0 7.40297 0H8.60512ZM7.40297 1.5C7.29129 1.5 7.19348 1.57374 7.16273 1.68066L6.68812 3.33105C6.62531 3.54968 6.46631 3.72859 6.25648 3.81641C5.92137 3.95657 5.60457 4.1514 5.28969 4.38867C5.11097 4.52335 4.88134 4.57159 4.66371 4.51953L2.94887 4.1084H2.94691C2.84046 4.08274 2.72921 4.13057 2.67445 4.22559L2.67348 4.22656L2.07191 5.26855C2.01674 5.36436 2.0313 5.48691 2.10902 5.56738L3.32289 6.82422C3.48107 6.98813 3.55613 7.21548 3.52699 7.44141C3.49253 7.70841 3.46644 7.83997 3.46644 8C3.46644 8.15506 3.49162 8.26729 3.52406 8.53711C3.55069 8.75871 3.47743 8.98159 3.32387 9.14355L2.10316 10.4287C2.02755 10.5084 2.01319 10.6301 2.06801 10.7256L2.66957 11.7676C2.72526 11.8639 2.83872 11.9126 2.94691 11.8857L4.63637 11.4639L4.71937 11.4482C4.91415 11.4226 5.11289 11.4745 5.27113 11.5947C5.51276 11.7785 5.75452 11.9376 6.00355 12.0654L6.25551 12.1826L6.33168 12.2197C6.50369 12.3156 6.63214 12.4765 6.68715 12.668L7.16176 14.3184L7.19594 14.3916C7.24157 14.4575 7.31816 14.499 7.40199 14.499H8.60414C8.71498 14.4989 8.81282 14.4258 8.84437 14.3193L9.33851 12.6533L9.36683 12.5752C9.4422 12.3969 9.58412 12.2533 9.7643 12.1768C10.0952 12.0364 10.4101 11.8368 10.7291 11.5947L10.7995 11.5469C10.9682 11.4467 11.1713 11.4159 11.3639 11.4639L13.0534 11.8857C13.1614 11.9124 13.2741 11.8638 13.3297 11.7676L13.9313 10.7266C13.987 10.6295 13.9724 10.5092 13.8971 10.4297L13.8961 10.4287L12.6764 9.14355C12.5219 8.98072 12.4484 8.75689 12.4762 8.53418C12.5094 8.2688 12.5348 8.15278 12.5348 8C12.5348 7.83788 12.508 7.70904 12.4743 7.4375C12.4463 7.21255 12.5219 6.98727 12.6793 6.82422L13.8932 5.56738C13.9699 5.48788 13.985 5.36635 13.9293 5.26953L13.3268 4.22754C13.2721 4.13246 13.1598 4.08375 13.0534 4.10938L11.3366 4.51953C11.119 4.57144 10.8892 4.52332 10.7106 4.38867C10.3992 4.15379 10.0901 3.96049 9.76527 3.82324C9.55858 3.73586 9.40221 3.5599 9.33851 3.34473L8.84535 1.67871C8.81365 1.57252 8.71579 1.50012 8.60512 1.5H7.40297Z"
                                            fill="black"
                                          />
                                        </svg>

                                        Manage Insights
                                      </button>
                                      <button
                                        class="insights-applied-chat-popover-retry-button"
                                        @click=${() =>
                                          this.handleRetryWithoutInsights(key)}
                                      >
                                        <svg
                                          width="16"
                                          height="15"
                                          viewBox="0 0 16 15"
                                          fill="none"
                                          xmlns="http://www.w3.org/2000/svg"
                                        >
                                          <path
                                            d="M7.5 0C10.0599 0 12.3193 1.29042 13.6709 3.25391L14.8037 2.12109C15.1007 1.82409 15.6094 2.0341 15.6094 2.4541V6.0293C15.6092 6.28916 15.3976 6.5 15.1377 6.5H11.5635C11.1435 6.5 10.9335 5.99229 11.2305 5.69629L12.5889 4.33594C11.5304 2.63507 9.6472 1.5 7.5 1.5C4.191 1.5 1.5 4.191 1.5 7.5C1.5 10.809 4.191 13.5 7.5 13.5C10.468 13.5 12.9322 11.333 13.4102 8.5H14.9248C14.4338 12.163 11.296 15 7.5 15C3.364 15 0 11.636 0 7.5C0 3.364 3.364 0 7.5 0Z"
                                            fill="black"
                                          />
                                        </svg>
                                        Retry without insights
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              </div>`
                            : ""}
                        </div>`
                      : ""}
                  </div>
                `;
              })}
            </div>
          `
        : ""}

      <div id="bottom-anchor"></div>

      ${this.showInsightsOverlay
        ? createInsightsOverlay(
            this.closeInsightsOverlay.bind(this),
            this.conversationInsights,
            this.handleDeleteInsight.bind(this)
          )
        : ""}
      ${this.showLog
        ? html`
            <div class="tool-log-panel">
              <div class="log-header">
                <span class="log-title">Tool Log</span>
                <button class="log-close-btn" @click=${() => this.toggleLog()}>
                  ×
                </button>
              </div>
              <div class="log-entries">
                ${this.logState.length === 0
                  ? html`<div class="log-empty">No log entries yet</div>`
                  : this.logState.map(
                      data => html`
                        <div class="log-entry">
                          <div class="log-field">
                            <b>Message:</b> ${data.content}
                          </div>
                          <div class="log-field"><b>Date:</b> ${data.date}</div>
                          <div class="log-field">
                            <b>Tool Response:</b> ${JSON.stringify(data.result)}
                          </div>
                        </div>
                      `
                    )}
              </div>
            </div>
          `
        : ""}
      ${this.showPrompt
        ? html`
            <div class="prompt-panel">
              <div class="log-header">
                <span class="log-title">System Prompt</span>
                <button
                  class="log-close-btn"
                  @click=${() => this.togglePrompt()}
                >
                  ×
                </button>
              </div>
              <div class="prompt-body">
                <textarea
                  class="prompt-editor"
                  .value=${live(promptText)}
                  @input=${e => this.handlePromptInput(e)}
                  aria-label="System prompt editor"
                ></textarea>

                <div class="prompt-actions">
                  <span class="save-status" aria-live="polite">
                    <span class="save-dot ${dotClass}"></span>
                    ${saveLabel}
                  </span>
                  <button
                    @click=${() => this.resetPromptToDefault()}
                    title="Rebuild from default"
                  >
                    Restore default
                  </button>
                </div>
              </div>
            </div>
          `
        : ""}
    `;
  }

  updated(changedProperties) {
    super.updated(changedProperties);

    // Create a single click handler function if it doesn't exist
    if (!this._mentionClickHandler) {
      this._mentionClickHandler = e => {
        console.log("Mention clicked directly:", e.currentTarget);
        e.preventDefault();
        e.stopPropagation();
        this.openTabFromMention(e.currentTarget);
      };
    }

    // Attach click handlers to mentions after content is rendered
    const mentions = this.renderRoot.querySelectorAll(".mention");
    console.log("Found mentions in updated():", mentions.length);

    mentions.forEach(mention => {
      // Check if handler is already attached
      if (!mention.hasAttribute("data-click-attached")) {
        mention.addEventListener("click", this._mentionClickHandler);
        mention.setAttribute("data-click-attached", "true");
      }
    });
  }

  set conversation(conversation) {
    this.#conversation = conversation;
    this.conversationTitle = conversation.title;
    this.#rebuildConversationInsights(conversation);
    this.#hydrateUseInsightsFromConversation();

    this.dispatchEvent(
      new CustomEvent("chatbot-conversation-updated", {
        detail: { conversation },
        bubbles: true,
      })
    );

    this.requestUpdate();
  }

  get conversation() {
    return this.#conversation;
  }
}

customElements.define("chat-bot", ChatBot);
