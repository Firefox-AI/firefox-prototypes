import {
  html,
  css,
  unsafeHTML,
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

/**
 * A simple chat bot component that interacts with an Ollama model via streaming.
 */
class ChatBot extends MozLitElement {
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

    .tool-log-panel {
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
    };
  }

  constructor() {
    super();
    this.prompt = "";
    this.messages = [];
    this.marked = window.marked.marked; // Use the global marked instance for markdown rendering
    this.currentTabContext = []; // Store current tab context
    this.currentPageText = ""; // Store current page text content
    this.showInsightsOverlay = false; // Track insights overlay visibility
    this.conversationInsights = new Set(); // Track all insights used in conversation
    this._insightsUpdatedHandler = null; // Event listener reference for cleanup
    this.showLog = false; // Track tool log visibility
    this.logState = []; // Store tool log entries
  }

  connectedCallback() {
    super.connectedCallback();
    // Listen for insights-updated events to re-render the overlay
    this._insightsUpdatedHandler = () => {
      this.requestUpdate();
    };
    window.addEventListener("insights-updated", this._insightsUpdatedHandler);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up event listener
    if (this._insightsUpdatedHandler) {
      window.removeEventListener(
        "insights-updated",
        this._insightsUpdatedHandler
      );
      this._insightsUpdatedHandler = null;
    }
  }

  async sendPrompt() {
    if (!this.prompt.trim()) {
      return;
    }

    // Add the user message
    this.messages.push({ role: "User", content: this.prompt });
    // Prepare an empty assistant message for streaming
    this.messages.push({ role: "Assistant", content: "" });
    this.requestUpdate();

    // Prepare messages with system prompt for the API call
    const messagesForAPI = [...this.messages];
    if (messagesForAPI.length) {
      // Insert system prompt as the first message
      messagesForAPI.unshift({
        role: "System",
        content: this.buildSystemPrompt(this.currentTabContext || []),
      });
    }

    const stream = fetchWithHistory(messagesForAPI);
    try {
      // Append chunks as they arrive
      for await (const chunk of stream) {
        // Specifically handle tool call log messages so it does not end up in the chat bubble
        if (chunk.type === "tool_call_log") {
          this.handleLogToolCall({
            content: chunk.content,
            result: chunk.result || "no result",
          });
          continue;
        }
        const lastIdx = this.messages.length - 1;
        this.messages[lastIdx].content += chunk;
        this.scrollToBottom();
        this.requestUpdate();
      }
    } catch (err) {
      console.error("Streaming error:", err);
      // Optionally show an error in the assistant bubble
      const lastIdx = this.messages.length - 1;
      this.messages[lastIdx].content += "\n[Error streaming response]";
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

  async submitPrompt(_prompt, tabContext = [], currentPageText = "") {
    // Store tab context and page text for use in system prompt
    this.currentTabContext = tabContext || [];
    this.currentPageText = currentPageText || "";

    // Keep the user prompt clean - context will be included in system prompt
    this.prompt = _prompt;
    await this.sendPrompt();
  }

  buildSystemPrompt(tabContext = []) {
    const currentDate = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    let systemPrompt = `You are a helpful AI assistant integrated into Firefox's Smart Window feature. You have access to the user's current browser tab context.

    Current date: ${currentDate}`;

    systemPrompt += buildInsightsSystemPrompt();

    systemPrompt += `

When responding to user queries, if you determine that a web search would be more helpful than a direct answer, include a search suggestion using this exact format: [[search: your suggested search query]]

Examples of when to suggest searches:
- User asks to find specific services, products, or locations (flights, hotels, restaurants, etc.)
- User wants current information, prices, or availability
- User asks for local information or businesses near a location
- User wants to compare options or find reviews

IMPORTANT: When the page content contains dates, times, or temporal information, incorporate these details into your search suggestions to make them more specific and relevant.

Examples:
- User: "help me find a flight to Boston" → Include: [[search: flights sjc to boston]]

Always provide a helpful response first, then include the search suggestion when appropriate.`;

    // Include tab context information with tab IDs
    const contextTabs = this.currentTabContext || tabContext;
    if (contextTabs && contextTabs.length) {
      systemPrompt += `\n\nTab Context (URL to Tab ID mapping):`;
      contextTabs.forEach((tab, index) => {
        systemPrompt += `\n${index + 1}. "${tab.title}" - ${tab.url} (Tab ID: ${tab.id || tab.url})`;
      });
      
      systemPrompt += `\n\nYou have access to a tool called 'get_page_content' that can fetch the actual page content for any of these tabs when needed. Use this tool when the user's query would benefit from specific page content analysis.`;
    }

    console.warn("Built system prompt:", systemPrompt);

    return systemPrompt;
  }

  detectSearchTokens(content) {
    const searchRegex = /\[\[search:\s*([^\]]+)\]\]/gi;
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

  parseContentWithTokens(content) {
    const searchTokens = this.detectSearchTokens(content);
    const insightTokens = detectInsightTokens(content);
    const allTokens = [...searchTokens, ...insightTokens].sort(
      (a, b) => b.startIndex - a.startIndex
    );

    if (allTokens.length === 0) {
      return { cleanContent: content, searchQueries: [], usedInsights: [] };
    }

    // Remove tokens from content for display
    let cleanContent = content;
    const searchQueries = [];
    const usedInsights = [];

    // Process tokens in reverse order to maintain correct indices
    for (const token of allTokens) {
      if (token.query) {
        searchQueries.unshift(token.query); // Add to beginning to maintain order
      } else if (token.insight) {
        usedInsights.unshift(token.insight); // Add to beginning to maintain order
        // Track this insight as used in the conversation
        this.conversationInsights.add(token.insight);
      }
      cleanContent =
        cleanContent.slice(0, token.startIndex) +
        cleanContent.slice(token.endIndex);
    }

    return { cleanContent: cleanContent.trim(), searchQueries, usedInsights };
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

  updateLogState(chatEntry) {
    const entryWithDate = { ...chatEntry, date: new Date().toLocaleString() };
    this.logState = [...this.logState, entryWithDate];
    this.requestUpdate();
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

    return html`
      <div class="chat-controls">
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

      ${this.messages.length
        ? html`
            <div class="chat">
              ${this.messages.map(msg => {
                const { cleanContent, searchQueries, usedInsights } =
                  msg.role === "Assistant"
                    ? this.parseContentWithTokens(msg.content)
                    : {
                        cleanContent: msg.content,
                        searchQueries: [],
                        usedInsights: [],
                      };

                return html`
                  <div
                    class="message ${msg.role === "User"
                      ? "user"
                      : "assistant"}"
                  >
                    <div class="message-title">${msg.role}</div>
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
                    <div>${unsafeHTML(this.marked(cleanContent))}</div>
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
                    ${msg.role === "Assistant"
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
    `;
  }
}

customElements.define("chat-bot", ChatBot);
