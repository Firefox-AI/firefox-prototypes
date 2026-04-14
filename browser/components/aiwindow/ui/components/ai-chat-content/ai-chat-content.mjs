/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/assistant-message-footer.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/chat-assistant-error.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/chat-assistant-loader.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/website-chip-container.mjs";

const FOLLOW_UP_QTY = 2;

/**
 * A custom element for managing AI Chat Content
 */
export class AIChatContent extends MozLitElement {
  static properties = {
    assistantIsLoading: { type: Boolean },
    conversationState: { type: Array },
    followUpSuggestions: { type: Array },
    errorObj: { type: Object },
    isSearching: { type: Boolean },
    tokens: { type: Object },
    /**
     * Trusted URLs for link validation, pushed from parent via child actor.
     * Passed down to ai-chat-message for synchronous validation during render.
     * Array type for Xray wrapper compatibility.
     */
    trustedUrls: { type: Array, attribute: false },
  };

  #lastScrollReq = null;
  #overflowObserver = null;

  constructor() {
    super();
    this.assistantIsLoading = false;
    this.conversationState = [];
    this.followUpSuggestions = [];
    this.errorObj = null;
    this.isSearching = false;
    this.trustedUrls = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#initEventListeners();

    this.dispatchEvent(
      new CustomEvent("AIChatContent:Ready", { bubbles: true })
    );
    this.#initFooterActionListeners();
    this.#initOverflowObserver();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#overflowObserver?.disconnect();
    this.#overflowObserver = null;
  }

  #dispatchAction(action, detail) {
    this.dispatchEvent(
      new CustomEvent("AIChatContent:DispatchAction", {
        bubbles: true,
        composed: true,
        detail: {
          action,
          ...(detail ?? {}),
        },
      })
    );
  }

  /**
   * Initialize event listeners for AI chat content events
   */

  #initEventListeners() {
    this.addEventListener(
      "aiChatContentActor:message",
      this.messageEvent.bind(this)
    );

    this.addEventListener(
      "aiChatContentActor:truncate",
      this.truncateEvent.bind(this)
    );

    this.addEventListener(
      "aiChatContentActor:remove-applied-memory",
      this.removeAppliedMemoryEvent.bind(this)
    );

    this.addEventListener(
      "aiChatContentActor:trustedUrlsUpdated",
      this.#handleTrustedUrlsUpdated.bind(this)
    );

    this.addEventListener(
      "aiChatError:retry-message",
      this.retryUserMessageAfterError.bind(this)
    );

    this.addEventListener(
      "SmartWindowPrompt:prompt-selected",
      this.#onFollowUpSelected.bind(this)
    );

    this.addEventListener(
      "aiChatError:new-chat",
      this.openNewChatAfterError.bind(this)
    );

    this.addEventListener(
      "aiChatError:sign-in",
      this.openAccountSignInAfterError.bind(this)
    );

    this.addEventListener("voice-playback-start", e => {
      this.#handleVoicePlaybackStart(e);
    });
    this.addEventListener("voice-playback-end", e => {
      this.#clearWordHighlights(e.detail?.messageId);
    });
    this.addEventListener("voice-playback-boundary", e => {
      this.#applyWordHighlight(e.detail);
    });
  }

  #handleVoicePlaybackStart(event) {
    const { messageId } = event.detail ?? {};
    const buttons = this.shadowRoot.querySelectorAll("voice-playback-button");
    for (const btn of buttons) {
      if (btn.messageId !== messageId) {
        btn.dispatchEvent(
          new CustomEvent("voice-playback-cancel", { detail: { messageId } })
        );
      }
    }
    this.#clearAllWordHighlights();
  }

  #applyWordHighlight({ messageId, charIndex, charLength }) {
    this.#clearAllWordHighlights();
    const messages = this.shadowRoot.querySelectorAll("ai-chat-message");
    for (const msg of messages) {
      if (msg.messageId !== messageId) {
        continue;
      }
      const article = msg.shadowRoot?.querySelector("article");
      if (!article) {
        break;
      }
      const root = article.querySelector(".message-assistant") || article;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let offset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const len = node.textContent.length;
        if (offset + len > charIndex) {
          const start = charIndex - offset;
          const end = Math.min(start + (charLength || 1), len);
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          const mark = document.createElement("mark");
          mark.className = "voice-highlight";
          range.surroundContents(mark);
          break;
        }
        offset += len;
      }
      break;
    }
  }

  #clearWordHighlights(messageId) {
    const messages = this.shadowRoot.querySelectorAll("ai-chat-message");
    for (const msg of messages) {
      if (messageId && msg.messageId !== messageId) {
        continue;
      }
      const marks = msg.shadowRoot?.querySelectorAll("mark.voice-highlight");
      if (marks) {
        for (const mark of marks) {
          const parent = mark.parentNode;
          while (mark.firstChild) {
            parent.insertBefore(mark.firstChild, mark);
          }
          parent.removeChild(mark);
          parent.normalize();
        }
      }
    }
  }

  #clearAllWordHighlights() {
    this.#clearWordHighlights(null);
  }

  /**
   * Initialize event listeners for footer actions (retry, copy, etc.)
   * emitted by child components.
   */

  #initFooterActionListeners() {
    this.addEventListener("copy-message", event => {
      const { messageId } = event.detail ?? {};
      const text = this.#getAssistantMessageBody(messageId);
      this.#dispatchAction("copy", { messageId, text });
    });

    this.addEventListener("retry-message", event => {
      this.#dispatchAction("retry", event.detail);
    });

    this.addEventListener("retry-without-memories", event => {
      this.#dispatchAction("retry-without-memories", event.detail);
    });

    this.addEventListener("remove-applied-memory", event => {
      this.#dispatchAction("remove-applied-memory", event.detail);
    });

    this.addEventListener("toggle-applied-memories", event => {
      this.#dispatchAction("toggle-applied-memories", event.detail);
    });

    this.addEventListener("manage-memories", event => {
      this.#dispatchAction("manage-memories", event.detail);
    });

    this.addEventListener("open-memories-learn-more", event => {
      this.#dispatchAction("open-memories-learn-more", event.detail);
    });
  }

  #initOverflowObserver() {
    this.#overflowObserver = new ResizeObserver(() => {
      const wrapper = this.shadowRoot.querySelector(".chat-content-wrapper");
      wrapper?.toggleAttribute(
        "overflowing",
        wrapper.scrollHeight > wrapper.clientHeight
      );
    });
    this.updateComplete.then(() => {
      this.#overflowObserver.observe(
        this.shadowRoot.querySelector(".chat-inner-wrapper")
      );
    });
  }

  #getAssistantMessageBody(messageId) {
    if (!messageId) {
      return "";
    }

    const msg = this.conversationState.find(m => {
      return m?.role === "assistant" && m?.messageId === messageId;
    });

    return msg?.body ?? "";
  }

  #onFollowUpSelected(event) {
    event.stopPropagation();
    this.followUpSuggestions = [];
    this.dispatchEvent(
      new CustomEvent("AIChatContent:DispatchFollowUp", {
        detail: { text: event.detail.text },
        bubbles: true,
      })
    );
  }

  #handleTrustedUrlsUpdated(event) {
    const { trustedUrls } = event.detail;
    this.trustedUrls = Array.isArray(trustedUrls) ? [...trustedUrls] : [];
  }

  messageEvent(event) {
    const message = event.detail;

    if (message?.content?.isError) {
      this.handleErrorEvent(message?.content);
      return;
    }

    this.errorObj = null;
    this.#checkConversationState(message);

    switch (message.role) {
      case "loading":
        this.handleLoadingEvent(event);
        break;
      case "assistant":
        this.#checkConversationState(message);
        this.handleAIResponseEvent(event);
        break;
      case "user":
        this.#checkConversationState(message);
        this.handleUserPromptEvent(event);
        break;
      // Used to clear the conversation state via side effects ( new conv id )
      case "clear-conversation":
        this.#checkConversationState(message);
    }
  }

  /**
   * Check if conversationState needs to be cleared
   *
   * @param {ChatMessage} message
   */
  #checkConversationState(message) {
    // Use find/findLast instead of at(0)/at(-1) because
    // conversationState is a sparse array indexed by ordinal and
    // at() can land on a hole (undefined) after truncation.
    const lastMessage = this.conversationState.findLast(m => m);
    const firstMessage = this.conversationState.find(m => m);
    const isReloadingSameConvo =
      firstMessage &&
      firstMessage.convId === message.convId &&
      firstMessage.ordinal === message.ordinal;
    const convIdChanged = message.convId !== lastMessage?.convId;

    // If the conversation ID has changed, reset the conversation state
    if (convIdChanged || isReloadingSameConvo) {
      this.conversationState = [];
      this.followUpSuggestions = [];
      this.shadowRoot
        ?.querySelector(".chat-inner-wrapper")
        ?.style.removeProperty("--content-height");
      this.requestUpdate();
    }
  }

  handleLoadingEvent(event) {
    const { isSearching } = event.detail;
    this.isSearching = !!isSearching;
    this.assistantIsLoading = true;
    this.requestUpdate();
  }

  handleErrorEvent(error) {
    this.assistantIsLoading = false;
    this.isSearching = false;
    this.errorObj = error;
    this.requestUpdate();
  }

  /**
   *  Handle user prompt events
   *
   * @param {CustomEvent} event - The custom event containing the user prompt
   */

  handleUserPromptEvent(event) {
    this.followUpSuggestions = [];
    const { convId, content, ordinal, isPreviousMessage } = event.detail;
    if (!isPreviousMessage) {
      this.assistantIsLoading = true;
    }
    this.conversationState[ordinal] = {
      role: "user",
      body: content.body,
      contextMentions: content.contextMentions,
      pageUrl: content.contextPageUrl ?? null,
      convId,
      ordinal,
    };
    this.requestUpdate();
    if (!isPreviousMessage) {
      this.#scrollUserMessageIntoView();
    }
  }

  retryUserMessageAfterError() {
    const lastMessage = this.conversationState.findLast(m => m);

    if (!lastMessage) {
      return;
    }

    this.#dispatchAction("retry-after-error", {
      ...lastMessage,
      content: {
        type: "text",
        body: lastMessage.body,
        contextMentions: lastMessage.contextMentions,
      },
    });
  }

  /**
   * Handle AI response events
   *
   * @param {CustomEvent} event - The custom event containing the response
   */

  handleAIResponseEvent(event) {
    this.isSearching = false;
    this.assistantIsLoading = false;

    const {
      convId,
      ordinal,
      id: messageId,
      content,
      memoriesApplied,
      showMemoriesCallout,
      webSearchQueries,
      followUpSuggestions = [],
    } = event.detail;

    if (typeof content.body !== "string" || !content.body) {
      return;
    }

    // favor web search display over follow ups.
    this.followUpSuggestions = webSearchQueries.length
      ? []
      : followUpSuggestions.slice(0, FOLLOW_UP_QTY);

    this.conversationState[ordinal] = {
      role: "assistant",
      convId,
      messageId,
      body: content.body,
      appliedMemories: memoriesApplied ?? [],
      showCallout: showMemoriesCallout ?? false,
      searchTokens: webSearchQueries ?? [],
    };

    this.requestUpdate();
  }

  #scrollUserMessageIntoView() {
    let scrollReq = {};
    this.#lastScrollReq = scrollReq;
    this.updateComplete.then(() => {
      const msgs = this.shadowRoot?.querySelectorAll(".chat-bubble-user");
      if (!msgs?.length) {
        return;
      }
      let lastMessage = msgs[msgs.length - 1];
      let haveMultipleMessages = msgs.length > 1;
      requestAnimationFrame(() => {
        if (scrollReq !== this.#lastScrollReq) {
          return;
        }
        let elTop = lastMessage.offsetTop;
        let spacer = haveMultipleMessages ? "small" : "large";
        lastMessage.parentNode.style.setProperty(
          "--content-height",
          `calc(${elTop}px + 100% - var(--space-${spacer}) - var(--space-xsmall))`
        );

        requestAnimationFrame(() => {
          if (scrollReq == this.#lastScrollReq) {
            lastMessage.scrollIntoView({ block: "start" });
          }
        });
      });
    });
  }

  truncateEvent(event) {
    const { messageId } = event.detail ?? {};
    if (!messageId) {
      return;
    }

    const idx = this.conversationState.findIndex(m => {
      return m?.role === "assistant" && m?.messageId === messageId;
    });

    if (idx === -1) {
      return;
    }

    this.conversationState = this.conversationState.slice(0, idx);
    this.requestUpdate();
  }

  removeAppliedMemoryEvent(event) {
    const { messageId, memoryId } = event.detail ?? {};
    const msg = this.conversationState.find(m => {
      return m?.role === "assistant" && m?.messageId === messageId;
    });

    msg.appliedMemories = msg.appliedMemories.filter(
      memory => memory?.id !== memoryId
    );
    this.requestUpdate();
  }

  openNewChatAfterError() {
    const event = new CustomEvent("AIChatContent:DispatchNewChat", {
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  /**
   * Returns the chips to display for a message, suppressing the current-tab
   * chip when the page context hasn't changed since the previous user message.
   *
   * @param {object} msg - A conversationState entry.
   * @param {string|null} lastContextPageUrl - The page URL of the preceding
   * user message, or undefined if there is none.
   * @returns {ContextWebsite[]}
   */
  #getVisibleChips(msg, lastContextPageUrl) {
    // If this message is on the same page as the previous message,
    // hide the page URL chip to avoid showing duplicate page context
    if (!msg || msg.role !== "user" || !msg.contextMentions?.length) {
      return [];
    }
    const currentPageUrl = msg.pageUrl;
    const shouldHideDuplicatePageChip =
      currentPageUrl && currentPageUrl === lastContextPageUrl;
    if (shouldHideDuplicatePageChip) {
      return msg.contextMentions.filter(
        chip => URL.parse(chip.url)?.href !== currentPageUrl
      );
    }
    return msg.contextMentions;
  }

  openAccountSignInAfterError() {
    const event = new CustomEvent("AIChatContent:AccountSignIn", {
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  #renderMessage(msg, chips) {
    if (!msg) {
      return nothing;
    }
    return html`
      <div class=${`chat-bubble chat-bubble-${msg.role}`}>
        ${chips?.length
          ? html`<website-chip-container
              .websites=${chips}
            ></website-chip-container>`
          : nothing}
        <ai-chat-message
          .message=${msg.body}
          .role=${msg.role}
          .messageId=${msg.messageId}
          .searchTokens=${msg.searchTokens || []}
          .trustedUrls=${this.trustedUrls}
        ></ai-chat-message>
        ${msg.role === "assistant"
          ? html`
              <assistant-message-footer
                .messageId=${msg.messageId}
                .messageText=${msg.body}
                .appliedMemories=${msg.appliedMemories}
                .showCallout=${msg.showCallout}
              ></assistant-message-footer>
            `
          : nothing}
      </div>
    `;
  }

  #renderFollowUpSuggestions() {
    if (!this.followUpSuggestions?.length) {
      return nothing;
    }
    return html`<smartwindow-prompts
      .prompts=${this.followUpSuggestions.map(text => ({
        text,
        type: "followup",
      }))}
      mode="followup"
    ></smartwindow-prompts>`;
  }

  #renderLoader() {
    if (!this.assistantIsLoading) {
      return nothing;
    }
    return html`<chat-assistant-loader
      .isSearch=${this.isSearching}
    ></chat-assistant-loader>`;
  }

  #renderError() {
    if (!this.errorObj) {
      return nothing;
    }
    return html`<chat-assistant-error
      .error=${this.errorObj}
    ></chat-assistant-error>`;
  }

  #renderMessages() {
    let lastContextPageUrl;
    return this.conversationState.map(msg => {
      const chips = this.#getVisibleChips(msg, lastContextPageUrl);
      if (msg?.role === "user") {
        lastContextPageUrl = msg.pageUrl;
      }
      return this.#renderMessage(msg, chips);
    });
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/ai-chat-content.css"
      />
      <div class="chat-content-wrapper">
        <div class="chat-inner-wrapper">
          ${this.#renderMessages()} ${this.#renderFollowUpSuggestions()}
          ${this.#renderLoader()} ${this.#renderError()}
        </div>
      </div>
    `;
  }
}

customElements.define("ai-chat-content", AIChatContent);
