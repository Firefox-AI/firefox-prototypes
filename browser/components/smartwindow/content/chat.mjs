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

    const stream = fetchWithHistory(this.messages);
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

  async submitPrompt(_prompt, tabContext = []) {
    // If tab context is provided, enhance the prompt with context information
    if (tabContext && tabContext.length) {
      let contextInfo = "\n\nTab Context:";
      tabContext.forEach((tab, index) => {
        contextInfo += `\n${index + 1}. "${tab.title}" - ${tab.url}`;
      });
      this.prompt = _prompt + contextInfo;
    } else {
      this.prompt = _prompt;
    }
    await this.sendPrompt();
  }

  render() {
    return html`
      ${this.messages.length === 0
        ? html`<p class="welcome-message">
            Start the conversation by typing a message.
          </p>`
        : html`
            <div class="chat">
              ${this.messages.map(
                msg => html`
                  <div
                    class="message ${msg.role === "User"
                      ? "user"
                      : "assistant"}"
                  >
                    <div class="message-title">${msg.role}</div>
                    <div>${unsafeHTML(this.marked(msg.content))}</div>
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
                `
              )}
            </div>
          `}

      <div id="bottom-anchor"></div>
    `;
  }
}

customElements.define("chat-bot", ChatBot);
