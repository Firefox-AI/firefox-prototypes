import {
  html,
  css,
  unsafeHTML,
} from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import { fetchWithHistory } from "chrome://browser/content/smartwindow/utils.mjs";

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
      display: flex;
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
  `;

  static get properties() {
    return {
      prompt: { type: String },
      messages: { type: Array },
      marked: { type: Object },
    };
  }

  constructor() {
    super();
    this.prompt = "";
    this.messages = [];
    this.marked = window.marked.marked; // Use the global marked instance for markdown rendering
    this.currentTabContext = []; // Store current tab context
    this.currentPageText = ""; // Store current page text content
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
    let systemPrompt = `You are a helpful AI assistant integrated into Firefox's Smart Window feature. You have access to the user's current browser tab context.

When responding to user queries, if you determine that a web search would be more helpful than a direct answer, include a search suggestion using this exact format: [[search: your suggested search query]]

Examples of when to suggest searches:
- User asks to find specific services, products, or locations (flights, hotels, restaurants, etc.)
- User wants current information, prices, or availability
- User asks for local information or businesses near a location
- User wants to compare options or find reviews

Examples:
- User: "help me find a flight to Boston" → Include: [[search: flights to boston]]
- User: "Where do the Red Sox play? I want to stay near there" → Include: [[search: hotels near fenway park]]
- User: "I need restaurants near here" (with location context) → Include: [[search: restaurants near [location]]]

Always provide a helpful response first, then include the search suggestion when appropriate.`;

    // Include tab context information
    const contextTabs = this.currentTabContext || tabContext;
    if (contextTabs && contextTabs.length) {
      systemPrompt += `\n\nTab Context:`;
      contextTabs.forEach((tab, index) => {
        systemPrompt += `\n${index + 1}. "${tab.title}" - ${tab.url}`;
      });
    }

    // Include page content if available (when current tab is in context)
    if (this.currentPageText && this.currentPageText.trim()) {
      // Truncate page text to avoid overly long prompts (max 3000 chars)
      const truncatedText =
        this.currentPageText.length > 3000
          ? this.currentPageText.substring(0, 3000) + "..."
          : this.currentPageText;

      systemPrompt += `\n\nCurrent page content:\n${truncatedText}

Use this page content to provide more contextual and relevant search suggestions. For example, if the page mentions dates, locations, or specific topics, incorporate those details into your search suggestions.`;
    }
    console.log("Built system prompt:", systemPrompt);

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

  parseContentWithSearchTokens(content) {
    const searchTokens = this.detectSearchTokens(content);

    if (searchTokens.length === 0) {
      return { cleanContent: content, searchQueries: [] };
    }

    // Remove search tokens from content for display
    let cleanContent = content;
    const searchQueries = [];

    // Process tokens in reverse order to maintain correct indices
    for (let i = searchTokens.length - 1; i >= 0; i--) {
      const token = searchTokens[i];
      searchQueries.unshift(token.query); // Add to beginning to maintain order
      cleanContent =
        cleanContent.slice(0, token.startIndex) +
        cleanContent.slice(token.endIndex);
    }

    return { cleanContent: cleanContent.trim(), searchQueries };
  }

  handleSearchQuery(query) {
    // Dispatch custom event to be handled by smartwindow.mjs
    const event = new CustomEvent("search-suggested", {
      detail: { query },
      bubbles: true,
    });
    this.dispatchEvent(event);
  }

  render() {
    return html`
      ${this.messages.length === 0
        ? html`<p class="welcome-message">
            Start the conversation by typing a message.
          </p>`
        : html`
            <div class="chat">
              ${this.messages.map(msg => {
                const { cleanContent, searchQueries } =
                  msg.role === "Assistant"
                    ? this.parseContentWithSearchTokens(msg.content)
                    : { cleanContent: msg.content, searchQueries: [] };

                return html`
                  <div
                    class="message ${msg.role === "User"
                      ? "user"
                      : "assistant"}"
                  >
                    <div class="message-title">${msg.role}</div>
                    <div>${unsafeHTML(this.marked(cleanContent))}</div>
                    ${searchQueries.length
                      ? html`
                          <div class="search-suggestions">
                            ${searchQueries.map(
                              query => html`
                                <button
                                  class="search-button"
                                  @click=${() => this.handleSearchQuery(query)}
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
          `}

      <div id="bottom-anchor"></div>
    `;
  }
}

customElements.define("chat-bot", ChatBot);
