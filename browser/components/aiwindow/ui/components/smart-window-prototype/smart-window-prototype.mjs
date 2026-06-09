/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://browser/content/aiwindow/components/ai-chat-message.mjs";

const CSS_URL =
  "chrome://browser/content/aiwindow/components/smart-window-prototype.css";
const ASK_ICON = "chrome://browser/content/aiwindow/assets/ask-icon.svg";
const NEW_CHAT_ICON = "chrome://browser/content/aiwindow/assets/new-chat.svg";
const COPY_ICON = "chrome://global/skin/icons/edit-copy.svg";
const LINK_ICON = "chrome://global/skin/icons/link.svg";
const RELOAD_ICON = "chrome://global/skin/icons/reload.svg";
const SEARCH_ICON = "chrome://global/skin/icons/search-glass.svg";
const SETTINGS_ICON = "chrome://global/skin/icons/settings.svg";
const THUMBS_DOWN_ICON = "chrome://global/skin/icons/thumbs-down-20.svg";
const THUMBS_UP_ICON = "chrome://global/skin/icons/thumbs-up-20.svg";

const STAGES = {
  ONBOARDING: "onboarding",
  NEWTAB: "newtab",
  RESULTS: "results",
};

const DEMO_QUERY = "find me the best places to eat in scottsdale az";
const SUGGESTED_PROMPTS = [
  "Craft a professional email",
  "Create a study plan",
  "Help me brainstorm",
  "Outline a presentation",
];

const INTRO_FEATURES = [
  {
    title: "Truly private",
    body: "Designed for browser-native controls, local history, and clear data boundaries.",
  },
  {
    title: "Up to date",
    body: "Uses fresh page and search context in the places where it helps.",
  },
  {
    title: "Bring your own model",
    body: "Switch providers without changing how the assistant feels.",
  },
];

const MOCK_SEARCH_RESULT = {
  summaryMarkdown:
    "For a polished Scottsdale dinner, start with **FnB**, **Cafe Monarch**, and **Fat Ox**. These spots balance local ingredients, date-night service, and reliable reservations for a first-pass shortlist.[1]\n\n## High-End & Date Night\n\n- **Cafe Monarch**: prix fixe, romantic courtyard energy, and one of the strongest special-occasion reputations in Old Town.[2]\n- **Fat Ox**: modern Italian, handmade pasta, and a lively bar for a group dinner.[3]\n- **Maple & Ash**: polished steakhouse service with a high-energy room near the waterfront.[4]\n\n## Casual Favorites\n\n- **FnB**: chef-driven Arizona produce, compact menu, and a wine list that leans local.\n- **The Mission**: Latin-inspired plates, table-side guacamole, and a central Old Town location.\n- **Citizen Public House**: dependable cocktails, shareable plates, and easy access after galleries.",
  organicResults: [
    {
      favicon: "page-icon:https://www.experiencescottsdale.com/",
      source: "Experience Scottsdale",
      title: "Best Restaurants in Scottsdale",
      snippet:
        "A local guide to standout restaurants, patios, chef-led dining, and Old Town favorites.",
      url: "https://www.experiencescottsdale.com/",
    },
  ],
  map: {
    center: { lat: 33.4942, lng: -111.9261 },
    pins: [
      { label: "FnB", lat: 33.4939, lng: -111.9289 },
      { label: "Cafe Monarch", lat: 33.4932, lng: -111.9283 },
      { label: "Fat Ox", lat: 33.5107, lng: -111.9255 },
    ],
  },
  rightRail: {
    discussion: {
      source: "r/Scottsdale",
      title: "Where would you book for one dinner?",
      quote:
        "Cafe Monarch for the splurge, FnB when you want it to feel more local.",
      url: "https://www.reddit.com/",
    },
    images: ["Cafe Monarch patio", "FnB seasonal plates"],
  },
};

function getSuggestions(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const normalized = trimmed.toLowerCase();
  if (normalized.length < 12) {
    return [`${trimmed} near me`, `${trimmed} reviews`, `${trimmed} open now`];
  }

  if (normalized.includes("scottsdale")) {
    return [
      "best restaurants in old town scottsdale",
      "date night restaurants scottsdale az",
      "scottsdale restaurants with patio views",
    ];
  }

  return [`${trimmed} guide`, `${trimmed} recommendations`, `${trimmed} map`];
}

function assistantAnswerFor(message, turnIndex) {
  if (message.toLowerCase().includes("fail")) {
    return {
      error: {
        message:
          "Smart Window could not generate this mock reply. Try again to replay the canned answer.",
      },
    };
  }

  if (!turnIndex) {
    return {
      replyMarkdown:
        "## Scottsdale dining shortlist\n\n- **Best local pick**: FnB is the most Scottsdale-specific choice, with Arizona produce and a smaller seasonal menu.[1]\n- **Best special occasion**: Cafe Monarch is the safest date-night splurge, especially if atmosphere matters.[2]\n- **Best group dinner**: Fat Ox gives you pasta, steak, and enough energy for a celebratory table.[3]\n\nIf you want a balanced plan, book **Cafe Monarch** for the headline meal and keep **FnB** as the local backup.",
      citations: [
        {
          id: 1,
          source: "Experience Scottsdale",
          url: "https://example.com/fnb",
        },
        { id: 2, source: "OpenTable", url: "https://example.com/monarch" },
        { id: 3, source: "Local guide", url: "https://example.com/fat-ox" },
      ],
      modelBadge: "Qwen VL 235B",
    };
  }

  return {
    replyMarkdown:
      "## Refined follow-up\n\n- **Reservation strategy**: book the higher-demand place first, then keep a same-neighborhood backup.\n- **Atmosphere filter**: choose Cafe Monarch for quiet polish, Fat Ox for a louder room, or FnB for a local, ingredient-led dinner.\n- **Practical next step**: if your group is larger than four, prioritize Fat Ox or Maple & Ash for seating flexibility.[1]",
    citations: [
      {
        id: 1,
        source: "Reservation patterns",
        url: "https://example.com/reservations",
      },
    ],
    modelBadge: "Qwen VL 235B",
  };
}

function generateTitle(firstMessage) {
  if (firstMessage.toLowerCase().includes("scottsdale")) {
    return "Scottsdale Arizona Dining Options";
  }
  return "Smart Window Conversation";
}

function splitMarkdown(markdown) {
  return markdown.split(/(\s+)/u).filter(Boolean);
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Three-step mock import and privacy onboarding for the prototype.
 */
export class OnboardingFlow extends MozLitElement {
  static properties = {
    step: { type: Number, reflect: true },
    selectedSource: { type: String, state: true },
    selectedProfiles: { type: Array, state: true },
    prefs: { type: Array, state: true },
  };

  constructor() {
    super();
    this.step = 1;
    this.selectedSource = "";
    this.selectedProfiles = [];
    this.prefs = ["privacy-data", "crash-reports"];
  }

  #finish() {
    this.dispatchEvent(
      new CustomEvent("prototype-complete-onboarding", {
        bubbles: true,
        composed: true,
      })
    );
  }

  #toggleProfile(profile) {
    this.selectedProfiles = this.selectedProfiles.includes(profile)
      ? this.selectedProfiles.filter(item => item !== profile)
      : [...this.selectedProfiles, profile];
  }

  #togglePref(pref) {
    this.prefs = this.prefs.includes(pref)
      ? this.prefs.filter(item => item !== pref)
      : [...this.prefs, pref];
  }

  #renderStepOne() {
    return html`
      <article class="onboarding-card" aria-labelledby="onboarding-title">
        <div class="step-kicker">Step 1 of 3</div>
        <h1 id="onboarding-title">Import settings</h1>
        <p>
          Bring bookmarks, passwords, history, and preferences into Firefox.
        </p>
        <div class="source-grid" role="listbox" aria-label="Import source">
          ${["Firefox", "Chrome", "Safari"].map(
            source => html`
              <button
                class="source-tile ${this.selectedSource === source
                  ? "selected"
                  : ""}"
                aria-selected=${this.selectedSource === source}
                @click=${() => {
                  this.selectedSource = source;
                }}
              >
                <span class="source-mark"></span>
                <span>${source}</span>
              </button>
            `
          )}
        </div>
        <div class="button-row">
          <button class="ghost-button" @click=${this.#finish}>Skip</button>
          <button
            class="primary-button"
            ?disabled=${this.selectedSource !== "Firefox"}
            @click=${() => {
              this.step = 2;
            }}
          >
            Import
          </button>
        </div>
      </article>
    `;
  }

  #renderStepTwo() {
    const profiles = ["Personal", "Work", "Research"];
    return html`
      <article class="onboarding-card" aria-labelledby="profile-title">
        <button
          class="back-button"
          @click=${() => {
            this.step = 1;
          }}
        >
          ← Back
        </button>
        <div class="step-kicker">Step 2 of 3</div>
        <h1 id="profile-title">Select profile to import</h1>
        <div class="profile-list">
          <button
            class="select-all-button"
            @click=${() => {
              this.selectedProfiles = profiles;
            }}
          >
            Select all
          </button>
          ${profiles.map(
            profile => html`
              <label class="profile-row">
                <span class="avatar" aria-hidden="true">${profile[0]}</span>
                <span>${profile}</span>
                <input
                  type="checkbox"
                  .checked=${this.selectedProfiles.includes(profile)}
                  @change=${() => this.#toggleProfile(profile)}
                />
              </label>
            `
          )}
        </div>
        <div class="button-row">
          <button
            class="primary-button"
            ?disabled=${!this.selectedProfiles.length}
            @click=${() => {
              this.step = 3;
            }}
          >
            Import profiles
          </button>
        </div>
      </article>
    `;
  }

  #renderStepThree() {
    const rows = [
      {
        id: "privacy-data",
        label: "Allow Firefox to suggest privacy improvements",
      },
      {
        id: "crash-reports",
        label: "Send technical reports to improve performance",
      },
    ];

    return html`
      <article class="onboarding-card" aria-labelledby="privacy-title">
        <button
          class="back-button"
          @click=${() => {
            this.step = 2;
          }}
        >
          ← Back
        </button>
        <div class="step-kicker">Step 3 of 3</div>
        <h1 id="privacy-title">Help make Firefox better</h1>
        <div class="privacy-list">
          ${rows.map(
            row => html`
              <label class="privacy-row">
                <input
                  type="checkbox"
                  .checked=${this.prefs.includes(row.id)}
                  @change=${() => this.#togglePref(row.id)}
                />
                <span>${row.label}</span>
                <a href="about:preferences#privacy">Learn more</a>
              </label>
            `
          )}
        </div>
        <p class="fine-print">
          You can change these later in
          <a href="about:preferences#privacy">privacy settings</a>.
        </p>
        <div class="button-row">
          <button class="primary-button" @click=${this.#finish}>Finish</button>
        </div>
      </article>
    `;
  }

  render() {
    let stepContent;
    if (this.step === 1) {
      stepContent = this.#renderStepOne();
    } else if (this.step === 2) {
      stepContent = this.#renderStepTwo();
    } else {
      stepContent = this.#renderStepThree();
    }

    return html`
      <link rel="stylesheet" href=${CSS_URL} />
      <section class="onboarding-stage">
        <span class="accent-shape shape-one"></span>
        <span class="accent-shape shape-two"></span>
        <span class="accent-shape shape-three"></span>
        ${stepContent}
      </section>
    `;
  }
}

/**
 * Mock omnibox suggestion menu with search and assistant rows.
 */
export class OmniboxSuggestions extends MozLitElement {
  static properties = {
    query: { type: String },
    suggestions: { type: Array },
  };

  constructor() {
    super();
    this.query = "";
    this.suggestions = [];
  }

  #select(kind, value) {
    this.dispatchEvent(
      new CustomEvent("omnibox-suggestion-selected", {
        bubbles: true,
        composed: true,
        detail: { kind, value },
      })
    );
  }

  render() {
    if (!this.query.trim()) {
      return html`<link rel="stylesheet" href=${CSS_URL} />`;
    }

    return html`
      <link rel="stylesheet" href=${CSS_URL} />
      <div class="suggestion-panel" role="listbox">
        <button
          class="suggestion-row search-row"
          role="option"
          @click=${() => this.#select("search", this.query)}
        >
          <span class="row-icon search-icon"></span>
          <span>Search for “${this.query}”</span>
        </button>
        ${this.suggestions.map(
          suggestion => html`
            <button
              class="suggestion-row"
              role="option"
              @click=${() => this.#select("search", suggestion)}
            >
              <span class="row-icon suggestion-icon"></span>
              <span>${suggestion}</span>
            </button>
          `
        )}
        <button
          class="suggestion-row ask-row"
          role="option"
          @click=${() => this.#select("ask", this.query)}
        >
          <img src=${ASK_ICON} alt="" />
          <span>Ask Smart Window</span>
        </button>
      </div>
    `;
  }
}

/**
 * Static map card with labeled mock pins.
 */
export class SearchMapEmbed extends MozLitElement {
  static properties = {
    map: { type: Object },
    status: { type: String },
  };

  constructor() {
    super();
    this.map = null;
    this.status = "loading";
  }

  render() {
    return html`
      <link rel="stylesheet" href=${CSS_URL} />
      <figure class="map-embed ${this.status}">
        ${this.status === "error"
          ? html`<figcaption>Map unavailable</figcaption>`
          : html`
              <div
                class="map-canvas"
                aria-label="Map of Scottsdale restaurants"
              >
                ${(this.map?.pins ?? []).map(
                  (pin, index) => html`
                    <span class="map-pin pin-${index + 1}">
                      <span>${pin.label}</span>
                    </span>
                  `
                )}
              </div>
            `}
      </figure>
    `;
  }
}

/**
 * Streaming inline search answer driven by canned data.
 */
export class SearchAiAnswer extends MozLitElement {
  static properties = {
    query: { type: String },
    streamedMarkdown: { type: String, state: true },
    status: { type: String, reflect: true },
    expanded: { type: Boolean, reflect: true },
  };

  #streamTimer = null;

  constructor() {
    super();
    this.query = "";
    this.streamedMarkdown = "";
    this.status = "loading";
    this.expanded = false;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#start();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#stop();
  }

  updated(changed) {
    if (changed.has("query")) {
      this.#start();
    }
  }

  #stop() {
    if (this.#streamTimer) {
      clearInterval(this.#streamTimer);
      this.#streamTimer = null;
    }
  }

  #start() {
    this.#stop();
    this.streamedMarkdown = "";
    this.status = "loading";

    const chunks = splitMarkdown(MOCK_SEARCH_RESULT.summaryMarkdown);
    if (prefersReducedMotion()) {
      this.streamedMarkdown = MOCK_SEARCH_RESULT.summaryMarkdown;
      this.status = "loaded";
      return;
    }

    let index = 0;
    this.#streamTimer = setInterval(() => {
      this.status = "streaming";
      this.streamedMarkdown += chunks[index] ?? "";
      index += 1;
      if (index >= chunks.length) {
        this.#stop();
        this.status = "loaded";
      }
    }, 28);
  }

  #renderLoadedBlocks() {
    const result = MOCK_SEARCH_RESULT.organicResults[0];
    return html`
      <div class="answer-grid">
        <section class="answer-main">
          <button
            class="more-button"
            aria-expanded=${this.expanded}
            @click=${() => {
              this.expanded = !this.expanded;
            }}
          >
            More ⌄
          </button>
          ${this.expanded
            ? html`
                <div class="expanded-copy">
                  <p>
                    Add a reservation reminder and compare drive times before
                    committing. The best single-night pairing is a patio drink
                    near Old Town followed by one fixed dinner reservation.
                  </p>
                </div>
              `
            : nothing}
          <article class="organic-card">
            <img src=${result.favicon} alt="" />
            <div>
              <span>${result.source}</span>
              <a href=${result.url}>${result.title}</a>
              <p>${result.snippet}</p>
            </div>
          </article>
          <search-map-embed .map=${MOCK_SEARCH_RESULT.map} status="loaded">
          </search-map-embed>
        </section>
        <aside class="right-rail" aria-label="Related results">
          <article class="discussion-card">
            <span>${MOCK_SEARCH_RESULT.rightRail.discussion.source}</span>
            <a href=${MOCK_SEARCH_RESULT.rightRail.discussion.url}>
              ${MOCK_SEARCH_RESULT.rightRail.discussion.title}
            </a>
            <blockquote>
              “${MOCK_SEARCH_RESULT.rightRail.discussion.quote}”
            </blockquote>
          </article>
          <div class="thumbnail-grid">
            ${MOCK_SEARCH_RESULT.rightRail.images.map(
              label => html`
                <figure class="image-thumb">
                  <span aria-hidden="true"></span>
                  <figcaption>${label}</figcaption>
                </figure>
              `
            )}
          </div>
        </aside>
      </div>
    `;
  }

  render() {
    return html`
      <link rel="stylesheet" href=${CSS_URL} />
      <section class="search-answer" aria-live="polite">
        <div class="answer-heading">
          <img src=${ASK_ICON} alt="" />
          <div>
            <span>Search AI answer</span>
            <h2>Best places to eat in Scottsdale, AZ</h2>
          </div>
        </div>
        ${this.status === "loading"
          ? html`
              <div class="summary-skeleton">
                <span></span>
                <span></span>
                <span></span>
              </div>
            `
          : html`
              <ai-chat-message
                role="assistant"
                .message=${this.streamedMarkdown}
                .complete=${this.status === "loaded"}
              ></ai-chat-message>
            `}
        ${this.status === "loaded" ? this.#renderLoadedBlocks() : nothing}
      </section>
    `;
  }
}

/**
 * Prototype assistant message with streaming, error, and action states.
 */
export class AssistantMessage extends MozLitElement {
  static properties = {
    role: { type: String, reflect: true },
    message: { type: Object },
    modelMenuOpen: { type: Boolean, state: true },
  };

  constructor() {
    super();
    this.role = "assistant";
    this.message = null;
    this.modelMenuOpen = false;
  }

  #emit(type) {
    this.dispatchEvent(
      new CustomEvent(`assistant-message-${type}`, {
        bubbles: true,
        composed: true,
        detail: { messageId: this.message?.id },
      })
    );
  }

  #renderError() {
    return html`
      <article class="assistant-error" role="alert">
        <p>${this.message.error}</p>
        <button @click=${() => this.#emit("retry")}>Retry</button>
      </article>
    `;
  }

  #renderActions() {
    if (this.message?.status !== "complete") {
      return nothing;
    }

    return html`
      <div class="message-actions">
        <button title="Regenerate" @click=${() => this.#emit("regenerate")}>
          <img src=${RELOAD_ICON} alt="" />
        </button>
        <button title="Copy" @click=${() => this.#emit("copy")}>
          <img src=${COPY_ICON} alt="" />
        </button>
        <button title="Thumbs up" @click=${() => this.#emit("thumbs-up")}>
          <img src=${THUMBS_UP_ICON} alt="" />
        </button>
        <button title="Thumbs down" @click=${() => this.#emit("thumbs-down")}>
          <img src=${THUMBS_DOWN_ICON} alt="" />
        </button>
        <button
          class="model-badge"
          aria-expanded=${this.modelMenuOpen}
          @click=${() => {
            this.modelMenuOpen = !this.modelMenuOpen;
          }}
        >
          ${this.message.modelBadge} ▾
        </button>
        ${this.modelMenuOpen
          ? html`
              <div class="model-menu" role="menu">
                <button role="menuitem">Automatic</button>
                <button role="menuitem">Qwen VL 235B</button>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  render() {
    if (!this.message) {
      return html`<link rel="stylesheet" href=${CSS_URL} />`;
    }

    if (this.message.status === "error") {
      return html`
        <link rel="stylesheet" href=${CSS_URL} />
        ${this.#renderError()}
      `;
    }

    return html`
      <link rel="stylesheet" href=${CSS_URL} />
      <article class="assistant-message ${this.role}">
        ${this.role === "user"
          ? html`<p>${this.message.body}</p>`
          : html`
              <ai-chat-message
                role="assistant"
                .message=${this.message.body}
                .complete=${this.message.status === "complete"}
              ></ai-chat-message>
              ${this.#renderActions()}
            `}
      </article>
    `;
  }
}

/**
 * Filterable, locally managed conversation history panel.
 */
export class ConversationHistoryList extends MozLitElement {
  static properties = {
    conversations: { type: Array },
    currentId: { type: String },
    filterText: { type: String, state: true },
    showExplainer: { type: Boolean },
    menuConversationId: { type: String, state: true },
  };

  constructor() {
    super();
    this.conversations = [];
    this.currentId = "";
    this.filterText = "";
    this.showExplainer = true;
    this.menuConversationId = "";
  }

  #emit(type, detail = {}) {
    this.dispatchEvent(
      new CustomEvent(`conversation-history-${type}`, {
        bubbles: true,
        composed: true,
        detail,
      })
    );
  }

  #filteredConversations() {
    const filter = this.filterText.trim().toLowerCase();
    if (!filter) {
      return this.conversations;
    }
    return this.conversations.filter(conversation =>
      conversation.title.toLowerCase().includes(filter)
    );
  }

  #renderExplainer() {
    if (!this.showExplainer) {
      return nothing;
    }

    return html`
      <article class="history-explainer">
        <button
          aria-label="Dismiss encrypted storage explainer"
          @click=${() => this.#emit("dismiss-explainer")}
        >
          ×
        </button>
        <h3>Stored encrypted locally</h3>
        <p>
          Conversations are encrypted on this device and available from any tab.
          <a href="about:preferences#privacy">Learn more</a>
        </p>
      </article>
    `;
  }

  #renderMenu(conversation) {
    if (this.menuConversationId !== conversation.id) {
      return nothing;
    }

    return html`
      <div class="history-menu" role="menu">
        <button
          role="menuitem"
          @click=${() => {
            this.menuConversationId = "";
            this.#emit("rename", { id: conversation.id });
          }}
        >
          Rename conversation
        </button>
        <button
          role="menuitem"
          @click=${() => {
            this.menuConversationId = "";
            this.#emit("delete", { id: conversation.id });
          }}
        >
          Delete conversation
        </button>
      </div>
    `;
  }

  #renderRows() {
    const rows = this.#filteredConversations();
    if (!this.conversations.length) {
      return html`<p class="history-empty">No past conversations yet.</p>`;
    }
    if (!rows.length) {
      return html`<p class="history-empty">No conversations match.</p>`;
    }

    return html`
      <div class="history-rows">
        ${rows.map(
          conversation => html`
            <article
              class="history-row ${conversation.id === this.currentId
                ? "current"
                : ""}"
              aria-current=${conversation.id === this.currentId
                ? "true"
                : "false"}
              @contextmenu=${event => {
                event.preventDefault();
                this.menuConversationId = conversation.id;
              }}
            >
              <button
                class="history-title"
                @click=${() => this.#emit("select", { id: conversation.id })}
              >
                ${conversation.title}
              </button>
              <button
                class="history-overflow"
                aria-label="Conversation actions"
                aria-expanded=${this.menuConversationId === conversation.id}
                @click=${() => {
                  this.menuConversationId =
                    this.menuConversationId === conversation.id
                      ? ""
                      : conversation.id;
                }}
              >
                ⋯
              </button>
              ${this.#renderMenu(conversation)}
            </article>
          `
        )}
      </div>
    `;
  }

  render() {
    return html`
      <link rel="stylesheet" href=${CSS_URL} />
      <aside class="history-panel" aria-label="Conversation history">
        <header>
          <h2>History</h2>
          <button
            class="icon-button"
            aria-label="New conversation"
            @click=${() => this.#emit("new")}
          >
            ↗
          </button>
        </header>
        <input
          type="search"
          placeholder="Filter conversations"
          .value=${this.filterText}
          @input=${event => {
            this.filterText = event.target.value;
          }}
        />
        ${this.#renderExplainer()} ${this.#renderRows()}
      </aside>
    `;
  }
}

/**
 * Coordinates the end-to-end Smart Window prototype flow.
 */
export class SmartWindowPrototype extends MozLitElement {
  static properties = {
    stage: { type: String, reflect: true },
    query: { type: String, state: true },
    suggestions: { type: Array, state: true },
    sidebarOpen: { type: Boolean, reflect: true },
    sidebarView: { type: String, state: true },
    composerValue: { type: String, state: true },
    conversations: { type: Array, state: true },
    currentConversationId: { type: String, state: true },
    showHistory: { type: Boolean, state: true },
    showHistoryExplainer: { type: Boolean, state: true },
    searchBannerVisible: { type: Boolean, state: true },
  };

  #streamTimer = null;

  constructor() {
    super();
    this.stage = STAGES.ONBOARDING;
    this.query = "";
    this.suggestions = [];
    this.sidebarOpen = false;
    this.sidebarView = "intro";
    this.composerValue = "";
    this.conversations = [];
    this.currentConversationId = "";
    this.showHistory = false;
    this.showHistoryExplainer = true;
    this.searchBannerVisible = true;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#clearStream();
  }

  #clearStream() {
    if (this.#streamTimer) {
      clearInterval(this.#streamTimer);
      this.#streamTimer = null;
    }
  }

  #setQuery(query) {
    this.query = query;
    this.suggestions = getSuggestions(query);
  }

  #submitSearch(query = this.query) {
    this.#setQuery(query || DEMO_QUERY);
    this.searchBannerVisible = true;
    this.stage = STAGES.RESULTS;
  }

  #openSidebar(seed = "") {
    this.sidebarOpen = true;
    this.sidebarView = seed ? "chat" : this.sidebarView;
    this.composerValue = seed;
    if (seed && !this.currentConversationId) {
      this.#ensureConversation();
    }
  }

  #ensureConversation() {
    if (this.currentConversationId) {
      return this.#currentConversation();
    }
    const conversation = {
      id: crypto.randomUUID(),
      title: "New conversation",
      messages: [],
    };
    this.conversations = [conversation, ...this.conversations];
    this.currentConversationId = conversation.id;
    return conversation;
  }

  #currentConversation() {
    return this.conversations.find(
      conversation => conversation.id === this.currentConversationId
    );
  }

  #updateConversation(nextConversation) {
    this.conversations = this.conversations.map(conversation =>
      conversation.id === nextConversation.id ? nextConversation : conversation
    );
  }

  #newConversation() {
    this.#clearStream();
    const conversation = {
      id: crypto.randomUUID(),
      title: "New conversation",
      messages: [],
    };
    this.conversations = [conversation, ...this.conversations];
    this.currentConversationId = conversation.id;
    this.sidebarView = "chat";
    this.composerValue = "";
    this.sidebarOpen = true;
  }

  #sendMessage() {
    const text = this.composerValue.trim();
    if (!text) {
      return;
    }

    const conversation = this.#ensureConversation();
    const turnIndex = conversation.messages.filter(
      message => message.role === "assistant"
    ).length;
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      body: text,
      status: "complete",
    };
    const assistantMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      body: "",
      status: "streaming",
      modelBadge: "Qwen VL 235B",
    };
    this.#updateConversation({
      ...conversation,
      messages: [...conversation.messages, userMessage, assistantMessage],
    });
    this.composerValue = "";
    this.sidebarView = "chat";
    this.#streamAssistantReply(assistantMessage.id, text, turnIndex);
  }

  #streamAssistantReply(messageId, userText, turnIndex) {
    this.#clearStream();
    const response = assistantAnswerFor(userText, turnIndex);
    if (response.error) {
      this.#replaceMessage(messageId, {
        body: "",
        status: "error",
        error: response.error.message,
        sourcePrompt: userText,
      });
      return;
    }

    const chunks = splitMarkdown(response.replyMarkdown);
    if (prefersReducedMotion()) {
      this.#replaceMessage(messageId, {
        body: response.replyMarkdown,
        status: "complete",
        citations: response.citations,
        modelBadge: response.modelBadge,
      });
      this.#maybeTitleConversation(userText);
      return;
    }

    let index = 0;
    this.#streamTimer = setInterval(() => {
      const conversation = this.#currentConversation();
      const message = conversation?.messages.find(
        item => item.id === messageId
      );
      if (!message) {
        this.#clearStream();
        return;
      }

      const nextBody = message.body + (chunks[index] ?? "");
      index += 1;
      this.#replaceMessage(messageId, {
        body: nextBody,
        status: index >= chunks.length ? "complete" : "streaming",
        citations: response.citations,
        modelBadge: response.modelBadge,
      });
      if (index >= chunks.length) {
        this.#clearStream();
        this.#maybeTitleConversation(userText);
      }
    }, 32);
  }

  #replaceMessage(messageId, patch) {
    const conversation = this.#currentConversation();
    if (!conversation) {
      return;
    }
    this.#updateConversation({
      ...conversation,
      messages: conversation.messages.map(message =>
        message.id === messageId ? { ...message, ...patch } : message
      ),
    });
  }

  #maybeTitleConversation(firstMessage) {
    const conversation = this.#currentConversation();
    if (!conversation || conversation.title !== "New conversation") {
      return;
    }
    this.#updateConversation({
      ...conversation,
      title: generateTitle(firstMessage),
    });
  }

  async #copyMessage(messageId) {
    const conversation = this.#currentConversation();
    const message = conversation?.messages.find(item => item.id === messageId);
    if (!message?.body) {
      return;
    }
    await navigator.clipboard?.writeText(message.body).catch(() => {});
  }

  #retryMessage(messageId) {
    const conversation = this.#currentConversation();
    const message = conversation?.messages.find(item => item.id === messageId);
    const sourcePrompt =
      message?.sourcePrompt ||
      conversation?.messages.findLast(item => item.role === "user")?.body ||
      DEMO_QUERY;
    this.#replaceMessage(messageId, {
      body: "",
      error: "",
      status: "streaming",
      sourcePrompt,
    });
    this.#streamAssistantReply(messageId, sourcePrompt, 0);
  }

  #renameConversation(id) {
    const conversation = this.conversations.find(item => item.id === id);
    if (!conversation) {
      return;
    }
    const title = window.prompt("Rename conversation", conversation.title);
    if (!title?.trim()) {
      return;
    }
    this.conversations = this.conversations.map(item =>
      item.id === id ? { ...item, title: title.trim() } : item
    );
  }

  #deleteConversation(id) {
    this.conversations = this.conversations.filter(item => item.id !== id);
    if (this.currentConversationId === id) {
      this.currentConversationId = this.conversations[0]?.id ?? "";
    }
  }

  #renderNewTab() {
    return html`
      <section class="newtab-stage">
        <div class="newtab-center">
          <img class="assistant-mark" src=${ASK_ICON} alt="" />
          <label class="newtab-omnibox">
            <img src=${ASK_ICON} alt="" />
            <input
              type="search"
              placeholder="Ask anything, find anything…"
              .value=${this.query}
              @input=${event => this.#setQuery(event.target.value)}
              @keydown=${event => {
                if (event.key === "Enter") {
                  this.#submitSearch(this.query);
                }
              }}
            />
          </label>
          <omnibox-suggestions
            .query=${this.query}
            .suggestions=${this.suggestions}
            @omnibox-suggestion-selected=${event => {
              const { kind, value } = event.detail;
              if (kind === "ask") {
                this.#openSidebar(value);
              } else {
                this.#submitSearch(value);
              }
            }}
          ></omnibox-suggestions>
        </div>
        <div class="stat-card-row">
          ${[
            ["Trackers blocked", "12,408"],
            ["Bandwidth saved", "1.8 GB"],
            ["Time saved", "42 min"],
            ["Today in tech", "3 stories"],
            ["Mozilla VPN", "Protect this network"],
          ].map(
            ([label, value]) => html`
              <article class="stat-card">
                <span>${label}</span>
                <strong>${value}</strong>
              </article>
            `
          )}
        </div>
      </section>
    `;
  }

  #renderResultsPage() {
    return html`
      <section class="results-stage">
        <header class="results-chrome">
          <img src=${ASK_ICON} alt="Smart Window" />
          <label class="results-omnibox">
            <input
              .value=${this.query}
              @input=${event => this.#setQuery(event.target.value)}
            />
            <button
              aria-label="Clear search"
              @click=${() => this.#setQuery("")}
            >
              ×
            </button>
            <button aria-label="Search" @click=${() => this.#submitSearch()}>
              <img src=${SEARCH_ICON} alt="" />
            </button>
            <button aria-label="Voice search">Voice</button>
          </label>
          <button
            class="smart-button"
            @click=${() => this.#openSidebar(this.query)}
          >
            Ask follow-up
          </button>
        </header>
        ${this.searchBannerVisible
          ? html`
              <div class="improve-banner">
                <span
                  >Improve search with private, browser-native context.</span
                >
                <button
                  aria-label="Dismiss improve search banner"
                  @click=${() => {
                    this.searchBannerVisible = false;
                  }}
                >
                  ×
                </button>
              </div>
            `
          : nothing}
        <nav class="filter-tabs" aria-label="Search filters">
          ${["Ask", "All", "Images", "News", "Videos"].map(
            label =>
              html`<button class=${label === "Ask" ? "active" : ""}>
                ${label}
              </button>`
          )}
          <button aria-label="Filters">
            <img src=${SETTINGS_ICON} alt="" />
          </button>
        </nav>
        <button class="location-chip">
          Showing results for Scottsdale, AZ <span>×</span>
        </button>
        <search-ai-answer .query=${this.query}></search-ai-answer>
      </section>
    `;
  }

  #renderIntroState() {
    return html`
      <section class="sidebar-intro">
        <h2>Meet Smart Window, your AI right in the browser</h2>
        <div class="intro-cards">
          ${INTRO_FEATURES.map(
            feature => html`
              <article>
                <h3>${feature.title}</h3>
                <p>${feature.body}</p>
              </article>
            `
          )}
        </div>
        <button
          class="primary-button"
          @click=${() => {
            this.sidebarView = "chat";
            this.#newConversation();
          }}
        >
          Start a chat
        </button>
      </section>
    `;
  }

  #renderChatState() {
    const conversation = this.#currentConversation();
    const messages = conversation?.messages ?? [];
    return html`
      <section class="chat-state">
        <header class="chat-state-header">
          <h2>Chat</h2>
          <button class="model-select">Automatic ▾</button>
        </header>
        ${messages.length
          ? html`
              <div class="message-list">
                ${messages.map(
                  message => html`
                    <assistant-message
                      .role=${message.role}
                      .message=${message}
                      @assistant-message-copy=${event =>
                        this.#copyMessage(event.detail.messageId)}
                      @assistant-message-retry=${event =>
                        this.#retryMessage(event.detail.messageId)}
                      @assistant-message-regenerate=${event =>
                        this.#retryMessage(event.detail.messageId)}
                    ></assistant-message>
                  `
                )}
              </div>
            `
          : html`
              <div class="prompt-list">
                ${SUGGESTED_PROMPTS.map(
                  suggestedPrompt => html`
                    <button
                      @click=${() => {
                        this.composerValue = suggestedPrompt;
                      }}
                    >
                      <img src=${NEW_CHAT_ICON} alt="" />
                      <span>${suggestedPrompt}</span>
                    </button>
                  `
                )}
              </div>
            `}
      </section>
    `;
  }

  #renderComposer() {
    const active = !!this.#currentConversation()?.messages.length;
    return html`
      <form
        class="composer"
        @submit=${event => {
          event.preventDefault();
          this.#sendMessage();
        }}
      >
        <textarea
          rows="2"
          placeholder=${active ? "Ask follow up" : "Ask anything"}
          .value=${this.composerValue}
          @input=${event => {
            this.composerValue = event.target.value;
          }}
        ></textarea>
        <div class="composer-actions">
          <button type="button" aria-label="Add screenshot">Shot</button>
          <button type="button" aria-label="Attach file">
            <img src=${LINK_ICON} alt="" />
          </button>
          <button type="button">Automatic ▾</button>
          <button
            class="send-button"
            type="submit"
            ?disabled=${!this.composerValue.trim()}
            aria-label="Send message"
          >
            ↑
          </button>
        </div>
      </form>
    `;
  }

  #renderSidebar() {
    if (!this.sidebarOpen) {
      return nothing;
    }

    const conversation = this.#currentConversation();
    let sidebarBody;
    if (this.showHistory) {
      sidebarBody = html`
        <conversation-history-list
          .conversations=${this.conversations}
          .currentId=${this.currentConversationId}
          .showExplainer=${this.showHistoryExplainer}
          @conversation-history-new=${() => this.#newConversation()}
          @conversation-history-select=${event => {
            this.currentConversationId = event.detail.id;
            this.sidebarView = "chat";
          }}
          @conversation-history-rename=${event =>
            this.#renameConversation(event.detail.id)}
          @conversation-history-delete=${event =>
            this.#deleteConversation(event.detail.id)}
          @conversation-history-dismiss-explainer=${() => {
            this.showHistoryExplainer = false;
          }}
        ></conversation-history-list>
      `;
    } else if (this.sidebarView === "intro") {
      sidebarBody = this.#renderIntroState();
    } else {
      sidebarBody = this.#renderChatState();
    }

    return html`
      <aside class="assistant-sidebar" aria-label="Smart Window sidebar">
        <header class="sidebar-header">
          <button
            class="icon-button"
            aria-label="Toggle sidebar"
            @click=${() => {
              this.sidebarOpen = false;
            }}
          >
            ◧
          </button>
          <strong>Smart Window</strong>
          <button class="icon-button" aria-label="Open in new">↗</button>
          <span class="conversation-title">
            ${conversation?.title && conversation.title !== "New conversation"
              ? conversation.title
              : ""}
          </span>
          <button
            class="icon-button"
            aria-label="Conversation history"
            @click=${() => {
              this.showHistory = !this.showHistory;
            }}
          >
            ⋯
          </button>
        </header>
        <div class="sidebar-body">${sidebarBody}</div>
        ${this.showHistory ? nothing : this.#renderComposer()}
      </aside>
    `;
  }

  render() {
    let stageContent;
    if (this.stage === STAGES.ONBOARDING) {
      stageContent = html`
        <onboarding-flow
          @prototype-complete-onboarding=${() => {
            this.stage = STAGES.NEWTAB;
          }}
        ></onboarding-flow>
      `;
    } else if (this.stage === STAGES.RESULTS) {
      stageContent = this.#renderResultsPage();
    } else {
      stageContent = this.#renderNewTab();
    }

    return html`
      <link rel="stylesheet" href=${CSS_URL} />
      <main class="prototype-shell">
        ${stageContent} ${this.#renderSidebar()}
      </main>
    `;
  }
}

customElements.define("onboarding-flow", OnboardingFlow);
customElements.define("omnibox-suggestions", OmniboxSuggestions);
customElements.define("search-map-embed", SearchMapEmbed);
customElements.define("search-ai-answer", SearchAiAnswer);
customElements.define("assistant-message", AssistantMessage);
customElements.define("conversation-history-list", ConversationHistoryList);
customElements.define("smart-window-prototype", SmartWindowPrototype);
