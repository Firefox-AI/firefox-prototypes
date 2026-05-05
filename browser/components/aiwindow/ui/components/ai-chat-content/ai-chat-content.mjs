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
    seenUrls: { type: Object },
    conversationId: { type: String },
  };

  #lastScrollReq = null;
  #overflowObserver = null;
  #pendingTripData = null;
  #tripExpected = false;
  #pendingTripPlanV1 = null;
  #tripPlanV1Expected = false;
  #pendingTabScopeProposal = null;
  #tabScopeExpected = false;
  #pendingMutation = null;

  constructor() {
    super();
    this.assistantIsLoading = false;
    this.conversationState = [];
    this.followUpSuggestions = [];
    this.errorObj = null;
    this.isSearching = false;

    /**
     * The set of URLs that have been seen by the conversation. Used for determining
     * if a URL will be unfurled or not.
     *
     * @type {Set<string>}
     */
    this.seenUrls = new Set();

    /**
     * The current conversationId for the seenUrls.
     *
     * @type {null | string}
     */
    this.conversationId = null;
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
      "aiChatContentActor:seen-urls",
      this.#handleSeenUrls.bind(this)
    );

    this.addEventListener(
      "aiChatContentActor:tripData",
      this.#handleTripData.bind(this)
    );

    this.addEventListener(
      "aiChatContentActor:tripPlanV1",
      this.#handleTripPlanV1.bind(this)
    );

    this.addEventListener(
      "aiChatContentActor:tabScopeProposal",
      this.#handleTabScopeProposal.bind(this)
    );

    this.addEventListener(
      "aiChatContentActor:tripMutation",
      this.#handleTripMutation.bind(this)
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

  /**
   * Add new seen URLs to the current conversation.
   *
   * @param {object} event
   * @param {object} event.detail
   * @param {string} event.detail.conversationId
   * @param {Set<string>} event.detail.seenUrls
   */
  #handleSeenUrls({ detail: { conversationId, seenUrls } }) {
    if (this.conversationId == conversationId) {
      this.seenUrls = this.seenUrls.union(seenUrls);
    } else {
      this.conversationId = conversationId;
      this.seenUrls = seenUrls;
    }
  }

  messageEvent(event) {
    const message = event.detail;

    if (message?.content?.isError) {
      this.handleErrorEvent(message?.content);
      return;
    }

    this.errorObj = null;

    switch (message.role) {
      case "loading":
        this.#checkConversationState(message);
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
      case "assistant-message-complete":
        this.#setMessageCompleteAttr(message);
        break;
      // Used to clear the conversation state via side effects ( new conv id )
      case "clear-conversation":
        this.#checkConversationState(message);
    }
  }

  #setMessageCompleteAttr(message) {
    const assistantLastMessage = this.conversationState.findLast(
      msg => msg?.messageId === message.content.id
    );

    if (!assistantLastMessage) {
      return;
    }

    assistantLastMessage.isLastChunk = true;
    this.requestUpdate();
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
      if (convIdChanged) {
        this.shadowRoot
          ?.querySelector(".chat-inner-wrapper")
          ?.style.removeProperty("--content-height");
      }
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
      isPreviousMessage,
    } = event.detail;

    if (typeof content.body !== "string" || !content.body) {
      return;
    }

    // favor web search display over follow ups.
    this.followUpSuggestions = webSearchQueries.length
      ? []
      : followUpSuggestions.slice(0, FOLLOW_UP_QTY);

    // Preserve any artifact data already stashed on this assistant entry
    // from a prior streaming chunk OR from a tool actor message that arrived
    // before this chunk. Without this, a tool result that fires mid-stream
    // (e.g. plan_trip emitting AIChatContent:TripPlanV1 between two chunks
    // of streamed assistant text) is wiped on the next chunk because the
    // entry is replaced wholesale. This was the BUILD-1 root cause in
    // qa-report-1.md: the actor message arrived, set target.tripPlanV1,
    // and was then overwritten by the next streaming chunk before the
    // user could see it.
    const existing = this.conversationState[ordinal];
    let tripData = existing?.tripData ?? null;
    if (this.#tripExpected && this.#pendingTripData) {
      tripData = this.#pendingTripData;
      this.#pendingTripData = null;
      this.#tripExpected = false;
    }

    let tripPlanV1 = existing?.tripPlanV1 ?? null;
    if (this.#tripPlanV1Expected && this.#pendingTripPlanV1) {
      tripPlanV1 = this.#pendingTripPlanV1;
      this.#pendingTripPlanV1 = null;
      this.#tripPlanV1Expected = false;
    }
    // If both v0 tripData and v1 tripPlanV1 are set, prefer v1 (matches the
    // #handleTripPlanV1 policy of clearing v0 on v1 arrival).
    if (tripPlanV1) {
      tripData = null;
    }

    let tabScopeProposal = existing?.tabScopeProposal ?? null;
    if (this.#tabScopeExpected && this.#pendingTabScopeProposal) {
      tabScopeProposal = this.#pendingTabScopeProposal;
      this.#pendingTabScopeProposal = null;
      this.#tabScopeExpected = false;
    }

    this.conversationState[ordinal] = {
      role: "assistant",
      convId,
      messageId,
      body: content.body,
      appliedMemories: memoriesApplied ?? [],
      showCallout: showMemoriesCallout ?? false,
      searchTokens: webSearchQueries ?? [],
      isLastChunk: !!isPreviousMessage,
      tripData,
      tripPlanV1,
      tabScopeProposal,
    };

    this.requestUpdate();
  }

  #handleTripData(event) {
    const data = event.detail;
    const target = this.conversationState.findLast(
      m => m?.role === "assistant"
    );
    if (target) {
      target.tripData = data;
    } else {
      this.#pendingTripData = data;
      this.#tripExpected = true;
    }
    this.requestUpdate();
  }

  #handleTripPlanV1(event) {
    const data = event.detail;
    const target = this.conversationState.findLast(
      m => m?.role === "assistant"
    );
    if (target) {
      target.tripPlanV1 = data;
      // Clear v0 tripData so we don't render two artifacts in the same row.
      target.tripData = null;
    } else {
      this.#pendingTripPlanV1 = data;
      this.#tripPlanV1Expected = true;
    }
    this.requestUpdate();
  }

  #handleTabScopeProposal(event) {
    const data = event.detail;
    const target = this.conversationState.findLast(
      m => m?.role === "assistant"
    );
    if (target) {
      target.tabScopeProposal = data;
    } else {
      this.#pendingTabScopeProposal = data;
      this.#tabScopeExpected = true;
    }
    this.requestUpdate();
  }

  #handleTripMutation(event) {
    const data = event.detail;
    // Update the last trip plan in place; flash the mutated path on the
    // active <trip-itinerary>.
    const target = this.conversationState.findLast(m => m?.tripPlanV1);
    if (target && data?.updated_trip) {
      target.tripPlanV1 = data.updated_trip;
    }
    this.requestUpdate();
    // After re-render, locate the trip-itinerary element and flash the path.
    this.updateComplete.then(() => {
      const node = this.shadowRoot?.querySelector("trip-itinerary");
      if (node && typeof node.flashMutation === "function") {
        node.flashMutation(data?.mutated_path);
      }
    });
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
      requestAnimationFrame(() => {
        if (scrollReq !== this.#lastScrollReq) {
          return;
        }
        let elTop = lastMessage.offsetTop;
        lastMessage.parentNode.style.setProperty(
          "--content-height",
          `calc(${elTop}px + 100% - var(--smart-window-top-spacing-chat))`
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
        ${msg.tabScopeProposal
          ? html`<tab-scope-card
              .proposal=${msg.tabScopeProposal}
            ></tab-scope-card>`
          : nothing}
        ${msg.tripPlanV1
          ? html`<trip-itinerary
              .tripPlan=${msg.tripPlanV1}
            ></trip-itinerary>`
          : msg.tripData
            ? html`<trip-artifact
                .tripData=${msg.tripData}
              ></trip-artifact>`
            : nothing}
        <ai-chat-message
          .message=${msg.body}
          .role=${msg.role}
          .messageId=${msg.messageId}
          .searchTokens=${msg.searchTokens || []}
          .conversationId=${this.conversationId}
          .seenUrls=${this.seenUrls}
        ></ai-chat-message>
        ${msg.role === "assistant" && msg.isLastChunk
          ? html`
              <assistant-message-footer
                .messageId=${msg.messageId}
                .appliedMemories=${msg.appliedMemories}
                .showCallout=${msg.showCallout}
              ></assistant-message-footer>
            `
          : nothing}
      </div>
    `;
  }

  #hasTripArtifact() {
    return this.conversationState.some(m => m?.tripData);
  }

  #shouldShowTravelCTA() {
    if (this.#hasTripArtifact() || this.assistantIsLoading) {
      return false;
    }
    const lastAssistant = this.conversationState.findLast(
      m => m?.role === "assistant"
    );
    if (!lastAssistant?.body) {
      return false;
    }
    const lower = lastAssistant.body.toLowerCase();
    const travelTerms =
      /\b(trip|travel|itinerary|vacation|flight|hotel|destination|day\s*\d|packing)\b/;
    return travelTerms.test(lower);
  }

  #onGenerateTravelPlan() {
    this.dispatchEvent(
      new CustomEvent("AIChatContent:DispatchFollowUp", {
        detail: {
          text: "Generate the travel plan now. Call the generate_travel_plan tool with all the information we discussed. Include weather, flights, hotels, itinerary, budget, and packing list.",
        },
        bubbles: true,
      })
    );
  }

  #renderTravelCTA() {
    if (!this.#shouldShowTravelCTA()) {
      return nothing;
    }
    return html`
      <div class="travel-cta-container">
        <button class="travel-cta-btn" @click=${this.#onGenerateTravelPlan}>
          Generate Travel Plan
        </button>
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
          ${this.#renderMessages()} ${this.#renderTravelCTA()}
          ${this.#renderFollowUpSuggestions()} ${this.#renderLoader()}
          ${this.#renderError()}
        </div>
      </div>
    `;
  }
}

customElements.define("ai-chat-content", AIChatContent);
