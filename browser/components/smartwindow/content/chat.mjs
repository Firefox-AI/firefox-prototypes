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
  buildInsightsSystemPrompt,
  detectInsightTokens,
  createClickableInsightToken,
  createInsightsOverlay,
  insightsStyles,
  deleteInsight,
} from "chrome://browser/content/smartwindow/insights.mjs";

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
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .conversation-title-container {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 1rem 0 0.5rem 0;
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
      max-width: 70%;
      padding: 0.75rem;
      border-radius: 10px;
      line-height: 1.4;
    }

    .message-title {
      font-weight: bold;
    }

    .user {
      align-self: flex-end;
      background-color: #f0f0f0;
      min-width: 200px;
    }

    .assistant {
      align-self: flex-start;
      border: 1px solid #d8d8d8;
      ul {
        display: block;
      }

      overflow-x: auto;
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
      display: none;
      justify-content: flex-end;
    }

    .search-suggestions {
      margin-top: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
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

    .chat-controls {
      display: flex;
      gap: 0.5rem;
      max-height: 18px;
      position: fixed;
      right: 0;
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
      max-height: 300px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
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
  `;

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
    };
  }

  get messages() {
    return this.#conversation.messages;
  }

  set messages(new_messages) {
    this.#conversation.messages = new_messages;
  }

  constructor() {
    super();
    this.prompt = "";
    // this.messages = [];
    this.marked = window.marked.marked; // Use the global marked instance for markdown rendering
    this.currentTabContext = []; // Store current tab context
    this.currentPageText = ""; // Store current page text content
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

  connectedCallback() {
    super.connectedCallback();
    // Listen for insights-updated events to re-render the overlay
    this._insightsUpdatedHandler = () => {
      this.requestUpdate();
    };
    window.addEventListener("insights-updated", this._insightsUpdatedHandler);
    Services.prefs.addObserver(PROMPT_PREF, this._prefObserver);
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
  }

  async sendPrompt() {
    if (!this.prompt.trim()) {
      return;
    }

    // Conversation holds string-only {role, content}; keep render-only data in _uiMeta so it never reaches the backend.
    const before = this.#conversation.messages.length;
    this.#conversation.addUserMessage(this.prompt);
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
    this.#conversation.addAssistantMessage("");
    this.requestUpdate();

    if (messagesForAPI.length) {
      // Insert system prompt as the first message
      const shouldGenerateTitle = this.conversationTitle === "";
      const systemContent =
        (this.systemPromptDraft && this.systemPromptDraft.trim()) ||
        this.buildSystemPrompt(
          this.currentTabContext || [],
          shouldGenerateTitle
        );

      messagesForAPI.unshift({
        role: "System",
        content: systemContent,
      });
    }

    const stream = fetchWithHistory(messagesForAPI);
    let fullResponse = "";
    try {
      // Append chunks as they arrive
      for await (const chunk of stream) {
        // Specifically handle tool call log messages so it does not end up in the chat bubble
        if (chunk.type === "tool_call_log") {
          this.handleLogToolCall({
            tool: chunk.tool,
            content: chunk.content,
            result: chunk.result || "no result",
          });
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
        this.scrollToBottom();
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
    const bottomAnchor = this.shadowRoot.getElementById("bottom-anchor");
    if (bottomAnchor) {
      bottomAnchor.scrollIntoView({ behavior: "smooth" });
    }
  }

  /**
   * @param {import('../ChatHistory.sys.mjs').ChatHistoryConversation} conversation - The ChatHistoryConversation to submit a prompt for
   * @param {string} _prompt - The new prompt for this conversation
   * @param {TabInfo[]} [tabContext=[]] - Array of TabInfo objects providing tab context
   * @param {string} [currentPageText=""] - Text of the current page in scope
   */
  async submitPrompt(
    conversation,
    _prompt,
    tabContext = [],
    currentPageText = ""
  ) {
    if (!this.#conversation || this.#conversation.id !== conversation.id) {
      this.#conversation = conversation;
    }

    const { text, html: displayHTML } =
      typeof _prompt === "string" ? { text: _prompt } : _prompt;

    // Store tab context and page text for use in system prompt
    this.currentTabContext = tabContext || [];
    this.currentPageText = currentPageText || "";

    // Plain text goes to the model; rich HTML is stashed for UI rendering.
    this.prompt = text ?? "";
    this._lastUserHTML = displayHTML || null;
    await this.sendPrompt();
  }

  buildSystemPrompt(tabContext = [], includeTitleGeneration = false) {
    const useInsights = Services.prefs.getBoolPref(
      "browser.smartwindow.useInsights",
      true
    );
    const currentDate = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    let systemPrompt = `You are a very knowledgeable personal browser assistant, designed to assist the user in navigating the web. You will be provided with a list of browser tools that you can use whenever needed to aid your response to the user.

Your internal knowledge cutoff date is: July, 2024.

# Tool Call Rules

Always follow the following tool calling rules strictly and ignore other tool call rules if exists:
- If a tool call is inferred and needed, only return the most relevant one given the conversation context.
- Ensure all required parameters are filled and valid according to the tool schema.
- Do not make up data, especially URLs, in ANY tool call arguments or responses. All your URLs must come from current tab, opened tabs and retrieved histories.
- Raw output of the tool call is not visible to the user, in order to keep the conversation smooth and reasonable, you should always provide a snippet of the output in your response (for example, show the tool outputs along with your reply to provide contexts to the user whenever makes sense).

Available tools:
- get_page_content: Fetches the actual page content for any of the tabs in the Tab Context. Use this tool when the user's query would benefit from specific page content analysis. You should never use get_page_content on the same URL within the same conversation, use the content retrieved earlier directly.
- search_history: Search through the user's browsing history. Always provide a specific search_term parameter with relevant keywords. The search_term should be a string containing keywords related to what you're looking for. Results will be sorted by relevance to your search term. Each result includes: url, title, lastVisit (ISO timestamp), visitCount, and relevanceScore. Higher relevanceScore indicates better match to your search.

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

${
  useInsights
    ? `# Insights and Personalization Rules
${buildInsightsSystemPrompt()}`
    : ""
}`;

    if (includeTitleGeneration) {
      systemPrompt += `\n\n# Title Generation Rules
At the start of your response, you must create a concise title for the conversation based on the user's message.
The title should be less than 6 words and should reflect the main topic or intent of the user's message.
Do not end with punctuation (no period, question mark, etc.). Do not generate questions as titles.

Format the title as follows: §title: title§`;
    }

    systemPrompt += `\n\n# Real Time & User Information

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
        this.conversationInsights.add(token.insight);
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
   * @param str
   */
  escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  handleSearchQuery(query, clickEvent) {
    // Dispatch custom event to be handled by smartwindow.mjs
    // Todo - render this as a link to default search provider instead of using a button with events.
    const event = new CustomEvent("search-suggested", {
      detail: { query, clickEvent },
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

  closeInsightsOverlay() {
    this.showInsightsOverlay = false;
    this.requestUpdate();
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

                return html`
                  <div
                    class="message ${msg.role === ChatHistory.MESSAGE_ROLE.USER
                      ? "user"
                      : "assistant"}"
                  >
                    <div class="message-title">
                      ${ChatHistoryMessage.getRoleLabel(msg.role)}
                    </div>
                    ${usedInsights.length
                      ? html`
                          <div class="used-insights">
                            <span class="insights-label"
                              >Referenced insights:</span
                            >
                            ${usedInsights.map(insight =>
                              createClickableInsightToken(
                                insight,
                                this.handleInsightClick.bind(this)
                              )
                            )}
                          </div>
                        `
                      : ""}
                    <div class="message-body">${bodyHTML}</div>
                    ${searchQueries.length
                      ? html`
                          <div class="search-suggestions">
                            ${searchQueries.map(
                              query => html`
                                <button
                                  class="search-button"
                                  @click=${e =>
                                    this.handleSearchQuery(query, e)}
                                >
                                  <svg
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
                                  </svg>
                                  Search: ${query}
                                </button>
                              `
                            )}
                          </div>
                        `
                      : ""}
                    ${msg.role === ChatHistory.MESSAGE_ROLE.ASSISTANT
                      ? html`<div class="actions-wrapper">
                          <svg
                            width="24"
                            height="24"
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
}

customElements.define("chat-bot", ChatBot);
