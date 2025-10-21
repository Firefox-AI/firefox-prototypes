/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarController:
    "moz-src:///browser/components/urlbar/UrlbarController.sys.mjs",
  UrlbarProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarQueryContext:
    "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
});

// const { Ci } = ChromeUtils.importESModule(
//   "resource://gre/modules/Services.sys.mjs"
// );

import { detectQueryType, generateSmartQuickPrompts } from "./utils.mjs";
import { attachToElement } from "chrome://browser/content/smartwindow/smartbar.mjs";

const { ChatHistory, ChatHistoryConversation } = ChromeUtils.importESModule(
  "resource:///modules/smartWindow/ChatHistory.sys.mjs"
);

const { embedderElement, topChromeWindow } = window.browsingContext;
const gBrowser = topChromeWindow.gBrowser;

/**
 *
 */
class SmartWindowPage {
  /**
   * @type {import("../ChatHistory.sys.mjs").ChatHistory}
   */
  #chatHistory;
  /**
   * @type {import("../ChatHistory.sys.mjs").ChatHistory}
   */
  #conversation;
  /**
   * @type {Map<string, ChatHistoryConversation>}
   */
  #tabConversations;

  constructor() {
    this.searchInput = null;
    this.smartbar = null;
    this.resultsContainer = null;
    this.submitButton = null;
    this.quickPromptsContainer = null;
    this.isSidebarMode = false;
    // this.messages = [];
    this.userHasEditedQuery = false;
    this.suggestionDebounceTimer = null;
    this.lastTabInfo = null;
    this.chatBot = null;
    this.modelPicker = null;
    this.queryTypePicker = null;

    this.selectedTabContexts = [];
    this.recentTabs = [];
    this.tabContextElements = {};
    this.currentTabPageText = "";
    this.quickActionButtons = {};

    this.#chatHistory = new ChatHistory();

    this.#conversation = new ChatHistoryConversation({
      title: "",
      description: "",
      pageUrl: "",
      pageMeta: "",
    });
    this.#tabConversations = new Map();

    this.init();
  }

  getQueryTypeIcon(type) {
    switch (type) {
      case "navigate":
        return "🌐";
      case "chat":
        return "💬";
      case "action":
        return "⚡";
      case "search":
        return "🔍";
      default:
        return "🔍";
    }
  }

  getQueryTypeLabel(type) {
    switch (type) {
      case "navigate":
        return "Navigate";
      case "chat":
        return "Ask";
      case "action":
        return "Action";
      case "search":
        return "Search";
      default:
        return "Search";
    }
  }

  async getEffectiveQueryType(query) {
    // Get user's preference for query type override
    const userOverride = Services.prefs.getStringPref(
      "browser.smartwindow.queryType",
      "auto"
    );

    // If user chose a specific type, use that (unless it's "auto")
    if (userOverride !== "auto") {
      return userOverride;
    }

    // If query contains @mention use type "chat" (only when pref is "auto")
    if (this.smartbar && this.smartbar.hasExistingMentions()) {
      return "chat";
    }

    // Otherwise, use the ML detection
    return await detectQueryType(query);
  }

  // AI-powered suggestion generation using tab context with caching
  async generateQuickPrompts(tabTitle = "") {
    let contextTabs = this.getAllContextTabs();

    // If no context tabs, use recent tabs (up to 5)
    if (contextTabs.length === 0) {
      await this.getRecentTabs();
      contextTabs = this.recentTabs
        .filter(tab => this.isTabEligibleForContext(tab))
        .slice(0, 5);
    }

    // Always show some prompts, even without context
    if (contextTabs.length === 0) {
      // Return default prompts when no context is available
      return [
        { text: "Show me similar music on YouTube", type: "search" },
        { text: "Tips for using AI Mode", type: "chat" },
      ];
    }

    const cacheKey =
      topChromeWindow.SmartWindow.getContextCacheKey(contextTabs);
    const cachedPromise =
      topChromeWindow.SmartWindow.getPromptsFromCache(cacheKey);

    if (cachedPromise) {
      return await cachedPromise;
    }

    const promptsPromise = this._generatePromptsInternal(contextTabs, tabTitle);
    topChromeWindow.SmartWindow.setPromptsCache(cacheKey, promptsPromise);

    return await promptsPromise;
  }

  // Internal method to actually generate the prompts
  async _generatePromptsInternal(contextTabs, tabTitle) {
    // Use AI to generate smart prompts
    try {
      const suggestions = await generateSmartQuickPrompts(contextTabs);
      if (suggestions && suggestions.length) {
        return suggestions;
      }
    } catch (error) {
      console.error(
        "Failed to generate AI prompts, falling back to static prompts:",
        error
      );
    }

    // Fallback to static prompts
    return this.generateFallbackPrompts(contextTabs, tabTitle);
  }

  // Fallback prompt generation (simplified version of the original logic)
  generateFallbackPrompts(contextTabs, tabTitle = "") {
    const suggestions = [];

    if (contextTabs.length > 1) {
      // Multi-tab context prompts
      const tabTitles = contextTabs
        .map(tab => tab.title)
        .filter(title => title && title !== "Untitled");
      const uniqueTitles = [...new Set(tabTitles)].slice(0, 3);

      if (uniqueTitles.length) {
        const topics = uniqueTitles.join(", ");
        suggestions.push(
          { text: `Compare ${topics}`, type: "chat" },
          { text: `What do ${topics} have in common?`, type: "chat" }
        );
      }

      // Context-aware search
      suggestions.push(
        { text: `research across ${contextTabs.length} tabs`, type: "search" },
        { text: `summarize content from selected tabs`, type: "chat" }
      );
    } else {
      // Single tab context (original logic)
      const titleWords = (tabTitle || contextTabs[0]?.title || "")
        .split(/\s+/)
        .filter(word => word.length > 2)
        .slice(0, 3);
      const topic = titleWords.join(" ") || "this";

      // 2 chat prompts
      suggestions.push(
        { text: `What is ${topic} about?`, type: "chat" },
        { text: `How does ${topic} work?`, type: "chat" }
      );

      // 2 search queries
      suggestions.push(
        { text: `${topic} guide`, type: "search" },
        { text: `${topic} tutorial`, type: "search" }
      );
    }

    // Add domain suggestions from context tabs
    const domains = new Set();
    for (const tab of contextTabs) {
      if (tab.url) {
        try {
          const domain = tab.url
            .replace(/^https?:\/\//, "")
            .replace(/^www\./, "")
            .split("/")[0];
          if (
            domain &&
            domain !== "about:blank" &&
            !domain.startsWith("about:")
          ) {
            domains.add(domain);
          }
        } catch (e) {}
      }
    }

    // Add up to 2 unique domains
    const domainArray = Array.from(domains).slice(0, 2);
    domainArray.forEach(domain => {
      suggestions.push({ text: domain, type: "navigate" });
    });

    // 1 action
    //suggestions.push({ text: "tab next", type: "action" });

    return suggestions;
  }

  // Tab Context Management Methods
  initializeTabContextUI() {
    this.tabContextElements = {
      bar: document.getElementById("tab-context-bar"),
      currentTabButton: document.getElementById("current-tab-button"),
      currentTabFavicon: document.getElementById("current-tab-favicon"),
      currentTabTitle: document.getElementById("current-tab-title"),
      removeCurrentTab: document.getElementById("remove-current-tab"),
      addTabsButton: document.getElementById("add-tabs-button"),
      addTabsIcon: document.querySelector(".add-tabs-icon"),
      addTabsText: document.querySelector(".add-tabs-text"),
      overlappingFavicons: document.getElementById("overlapping-favicons"),
      tabDropdown: document.getElementById("tab-dropdown"),
      dropdownList: document.getElementById("dropdown-list"),
    };

    this.setupTabContextEventListeners();

    this.updateTabContextUI();
  }

  setupTabContextEventListeners() {
    // Current tab button - click opens dropdown (except for X button)
    this.tabContextElements.currentTabButton.addEventListener("click", e => {
      if (!e.target.classList.contains("remove-tab-button")) {
        e.stopPropagation();
        this.toggleTabDropdown();
      }
    });

    // Remove current tab button
    this.tabContextElements.removeCurrentTab.addEventListener(
      "click",
      async e => {
        e.stopPropagation();
        if (this.lastTabInfo) {
          this.removeTabFromContext(this.lastTabInfo.tabId);
        }
      }
    );

    // Add tabs button
    this.tabContextElements.addTabsButton.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleTabDropdown();
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", e => {
      if (!this.tabContextElements.bar.contains(e.target)) {
        this.closeTabDropdown();
      }
    });
  }

  async getRecentTabs() {
    try {
      const allTabs = Array.from(topChromeWindow.gBrowser.tabs);
      const recentTabs = [];

      for (const tab of allTabs) {
        const browser = topChromeWindow.gBrowser.getBrowserForTab(tab);
        const tabInfo = {
          title: tab.label || "Untitled",
          url: browser.currentURI.spec || "",
          favicon: tab.image || "",
          tabId: tab.linkedPanel,
          tab, // Store reference for later use
        };

        // Only include eligible tabs
        if (this.isTabEligibleForContext(tabInfo)) {
          recentTabs.push(tabInfo);
        }
      }

      // Sort by last accessed time (more recent first)
      recentTabs.sort((a, b) => {
        const aTime = a.tab.lastAccessed || 0;
        const bTime = b.tab.lastAccessed || 0;
        return bTime - aTime;
      });

      this.recentTabs = recentTabs.slice(0, 20);
      return this.recentTabs;
    } catch (error) {
      console.error("Error getting recent tabs:", error);
      return [];
    }
  }

  async addTabToContext(tabInfo) {
    // Check if tab is already in context
    const exists = this.selectedTabContexts.some(
      tab => tab.tabId === tabInfo.tabId
    );
    if (!exists) {
      // Save chat messages for the old context
      await this.saveChatMessagesForCurrentContext();

      this.selectedTabContexts.push(tabInfo);
      this.updateTabContextUI();
      this.updateQuickPromptsWithContext();

      // Load chat messages for the new context
      await this.loadChatMessagesForCurrentContext();
    }
  }

  async removeTabFromContext(tabId) {
    // Save chat messages for the old context
    await this.saveChatMessagesForCurrentContext();

    this.selectedTabContexts = this.selectedTabContexts.filter(
      tab => tab.tabId !== tabId
    );
    this.updateTabContextUI();
    this.updateQuickPromptsWithContext();

    // Load chat messages for the new context
    await this.loadChatMessagesForCurrentContext();
  }

  updateTabContextUI() {
    if (this.isCurrentTabInContext()) {
      this.tabContextElements.currentTabButton.classList.remove("hidden");

      if (this.lastTabInfo.favicon) {
        this.tabContextElements.currentTabFavicon.src =
          this.lastTabInfo.favicon;
        this.tabContextElements.currentTabFavicon.style.display = "block";
      } else {
        this.tabContextElements.currentTabFavicon.style.display = "none";
      }
    } else {
      this.tabContextElements.currentTabButton.classList.add("hidden");
    }

    this.updateAddTabsButtonState();
  }

  updateAddTabsButtonState() {
    // Count non-current tabs for the "add tabs" button display
    const nonCurrentTabs = this.selectedTabContexts.filter(
      tab => !this.lastTabInfo || tab.tabId !== this.lastTabInfo.tabId
    );
    const nonCurrentTabsCount = nonCurrentTabs.length;

    const addTabsIcon = this.tabContextElements.addTabsIcon;
    const addTabsText = this.tabContextElements.addTabsText;
    const overlappingFavicons = this.tabContextElements.overlappingFavicons;

    if (nonCurrentTabsCount === 0) {
      // State 1: No additional tabs
      addTabsIcon.style.display = "inline";
      addTabsText.style.display = "inline";
      addTabsText.textContent = "Add tabs";
      overlappingFavicons.style.display = "none";
    } else {
      // State 2/3: Show overlapping favicons
      addTabsIcon.style.display = "none";
      addTabsText.style.display = "none";
      overlappingFavicons.style.display = "flex";

      const faviconStack = overlappingFavicons.querySelector(".favicon-stack");
      const tabCount = overlappingFavicons.querySelector(".tab-count");

      faviconStack.innerHTML = "";

      // Show up to 3 overlapping favicons from non-current tabs
      const tabsToShow = nonCurrentTabs.slice(0, 3);
      tabsToShow.forEach(tab => {
        const favicon = document.createElement("img");
        favicon.className = "stacked-favicon";
        favicon.src = tab.favicon || "";
        favicon.alt = tab.title || "";
        faviconStack.appendChild(favicon);
      });

      const countText =
        nonCurrentTabsCount === 1 ? "1 tab" : `${nonCurrentTabsCount} tabs`;
      tabCount.textContent = countText;
    }
  }

  async toggleTabDropdown() {
    const dropdown = this.tabContextElements.tabDropdown;

    if (dropdown.style.display === "block") {
      this.closeTabDropdown();
    } else {
      this.openTabDropdown();
    }
  }

  async openTabDropdown() {
    const dropdown = this.tabContextElements.tabDropdown;
    const dropdownList = this.tabContextElements.dropdownList;

    await this.getRecentTabs();

    dropdownList.innerHTML = "";

    // Add current tab if eligible
    if (this.lastTabInfo && this.isTabEligibleForContext(this.lastTabInfo)) {
      const isSelected = this.isCurrentTabInContext();
      const currentTabItem = this.createDropdownItem(
        this.lastTabInfo,
        isSelected
      );
      dropdownList.appendChild(currentTabItem);
    }

    // Add recent tabs (excluding current tab)
    for (const tab of this.recentTabs) {
      if (tab.tabId !== this.lastTabInfo?.tabId) {
        const isSelected = this.selectedTabContexts.some(
          selected => selected.tabId === tab.tabId
        );
        const tabItem = this.createDropdownItem(tab, isSelected);
        dropdownList.appendChild(tabItem);
      }
    }

    dropdown.style.display = "block";
    this.tabContextElements.addTabsButton.classList.add("active");
  }

  closeTabDropdown() {
    this.tabContextElements.tabDropdown.style.display = "none";
    this.tabContextElements.addTabsButton.classList.remove("active");
  }

  createDropdownItem(tabInfo, isSelected) {
    const item = document.createElement("div");
    item.className = "dropdown-item";
    item.dataset.tabId = tabInfo.tabId;

    // Create checkbox
    const checkbox = document.createElement("div");
    checkbox.className = `dropdown-checkbox ${isSelected ? "checked" : ""}`;

    // Create favicon
    const favicon = document.createElement("img");
    favicon.className = "tab-favicon";
    favicon.src = tabInfo.favicon || "";
    favicon.alt = "";

    // Create title
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tabInfo.title || "Untitled";

    // Create URL
    const url = document.createElement("div");
    url.className = "tab-url";
    try {
      const urlObj = new URL(tabInfo.url);
      url.textContent =
        urlObj.hostname + (urlObj.pathname !== "/" ? urlObj.pathname : "");
    } catch (e) {
      url.textContent = tabInfo.url;
    }

    item.appendChild(checkbox);
    item.appendChild(favicon);

    const textContainer = document.createElement("div");
    textContainer.style.flex = "1";
    textContainer.style.minWidth = "0";
    textContainer.appendChild(title);
    textContainer.appendChild(url);
    item.appendChild(textContainer);

    // Add click handler
    item.addEventListener("click", async () => {
      const isCurrentlySelected = checkbox.classList.contains("checked");

      // Treat all tabs the same way
      if (isCurrentlySelected) {
        await this.removeTabFromContext(tabInfo.tabId);
        checkbox.classList.remove("checked");
      } else {
        await this.addTabToContext(tabInfo);
        checkbox.classList.add("checked");
      }
    });

    return item;
  }

  async updateQuickPromptsWithContext() {
    // Only update if user hasn't edited query and suggestions are showing
    const editorText = this.smartbar ? this.smartbar.getText() : "";
    if (
      !this.userHasEditedQuery &&
      this.smartbar &&
      this.smartbar.hasSuggestions() &&
      !editorText.trim()
    ) {
      await this.showQuickPrompts();
    }
  }

  getAllContextTabs() {
    return this.selectedTabContexts;
  }

  // Helper function to check if a tab is eligible for context (filters out internal URLs)
  isTabEligibleForContext(tabInfo) {
    if (!tabInfo || !tabInfo.url) {
      return false;
    }

    const url = tabInfo.url.toLowerCase();

    // Filter out browser internal URLs
    return (
      (!url.startsWith("about:") || url.startsWith("about:reader?")) &&
      !url.startsWith("chrome:") &&
      !url.startsWith("moz-extension:") &&
      !url.startsWith("resource:") &&
      url !== "about:blank"
    );
  }

  // Helper to check if current tab is in context
  isCurrentTabInContext() {
    return (
      this.lastTabInfo &&
      this.selectedTabContexts.some(tab => tab.tabId === this.lastTabInfo.tabId)
    );
  }

  // Reset context to current tab (if eligible)
  async resetContextToCurrentTab() {
    // Save chat messages for the old context before changing
    try {
      await this.saveChatMessagesForCurrentContext();
    } catch (error) {
      console.error(
        `[ERROR] resetContextToCurrentTab(): Could not save chat messages for current context: ${error}`
      );
    }

    if (this.lastTabInfo && this.isTabEligibleForContext(this.lastTabInfo)) {
      this.selectedTabContexts = [this.lastTabInfo];
    } else {
      this.selectedTabContexts = [];
    }
    this.updateTabContextUI();

    // Load chat messages for the new context
    try {
      await this.loadChatMessagesForCurrentContext();
    } catch (error) {
      console.error(
        `[ERROR] resetContextToCurrentTab(): Could not load chat messages for current context: ${error}`
      );
    }
  }

  // Save chat messages to all tabs in current context
  async saveChatMessagesForCurrentContext() {
    if (this.chatBot && this.chatBot.messages && this.chatBot.messages.length) {
      // Save messages to a conversation for each tab's URL
      for (const tab of this.selectedTabContexts) {
        const tabConversation =
          this.#tabConversations.get(tab.url) ??
          new ChatHistoryConversation({
            title: "",
            description: "",
            pageUrl: new URL(tab.url),
            pageMeta: "",
          });

        tabConversation.messages = this.#conversation.messages;

        this.#tabConversations.set(tab.url, tabConversation);

        try {
          await this.#chatHistory.updateConversation(tabConversation);
        } catch (error) {
          console.error("Error saving the conversation:", tabConversation);
        }
      }
    }
  }

  // Helper to get the most recent conversation with messages for a given URL
  async #getMostRecentConversationWithMessages(url) {
    const conversations = await this.#chatHistory.findConversationsByURL(
      new URL(url)
    );

    // Filter to only conversations with messages, then sort by updatedDate
    const conversationsWithMessages = conversations
      .filter(convo => convo.messages && !!convo.messages.length)
      .sort((a, b) => {
        const dateA = a.updatedDate ? new Date(a.updatedDate) : new Date(0);
        const dateB = b.updatedDate ? new Date(b.updatedDate) : new Date(0);
        return dateB - dateA; // Most recent first
      });

    return conversationsWithMessages[0] || null;
  }

  // Load chat messages for the current context (prioritize current tab)
  async loadChatMessagesForCurrentContext() {
    let conversation = null;
    if (!this.chatBot) {
      return;
    }

    let savedMessages = [];

    // Try to load from current tab first
    if (this.lastTabInfo && this.isCurrentTabInContext()) {
      conversation = await this.#getMostRecentConversationWithMessages(
        this.lastTabInfo.url
      );

      if (conversation && conversation.messages) {
        savedMessages.push(...conversation.messages);
      }
    }

    // If no messages from current tab, try other tabs in context
    if (savedMessages.length === 0) {
      for (const tab of this.selectedTabContexts) {
        conversation = await this.#getMostRecentConversationWithMessages(
          tab.url
        );

        if (conversation && conversation.messages) {
          savedMessages.push(...conversation.messages);
          break;
        }
      }
    }

    if (savedMessages.length) {
      // Restore saved messages and show chat mode
      this.chatBot.messages = [...savedMessages];
      this.chatBot.requestUpdate();
      this.showChatMode();
      // Scroll to bottom after messages are loaded
      setTimeout(() => this.chatBot.scrollToBottom(), 0);
    } else {
      // NOTE: This breaks the chat it can't ask if the messages gets blanked
      // console.log("setting blank messages");
      //
      // this.chatBot.messages = [];
      // this.chatBot.requestUpdate();
      // this.hideChatMode();
    }

    // Replace an empty conversation with the conversation that was loaded from SQLite
    if (conversation && conversation.messages.length) {
      this.#conversation = conversation;
      this.#tabConversations.set(this.lastTabInfo.url, this.#conversation);
    }
  }

  async init() {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        async () => await this.onDOMReady()
      );
    } else {
      await this.onDOMReady();
    }
  }

  async onDOMReady() {
    this.isSidebarMode = embedderElement.id == "smartwindow-browser";

    const editorDiv = document.getElementById("tiptap-editor");

    this.smartbar = attachToElement(editorDiv, {
      onKeyDown: event => this.handleKeyDown(event),
      onUpdate: text => this.handleSearch(text),
      onSuggestionSelect: suggestion => this.handleEnter(suggestion.text),
      getQueryTypeIcon: type => this.getQueryTypeIcon(type),
      getQueryTypeLabel: type => this.getQueryTypeLabel(type),
    });

    this.searchInput = editorDiv;

    this.resultsContainer = document.getElementById("results-container");
    this.chatBot = document.getElementById("chat-bot");
    this.quickPromptsContainer = document.getElementById(
      "quick-prompts-container"
    );

    this.setupSubmitButton();

    const isSmartMode =
      topChromeWindow?.document?.documentElement?.hasAttribute("smart-window");

    const isEnabled = this.isSidebarMode || isSmartMode;
    document.documentElement.classList.toggle("smart-window", isEnabled);

    if (this.smartbar && isEnabled) {
      this.focusSearchInputWhenReady();
    }

    if (this.smartbar) {
      if (!isEnabled) {
        this.smartbar.setEditable(false);
        if (this.submitButton) {
          this.submitButton.disabled = true;
        }
      }
    }

    // If in sidebar mode, update UI and behavior
    if (this.isSidebarMode) {
      document.documentElement.classList.add("sidebar-mode");
      this.toggleBottomChatMode(true);
    }

    this.setupKeyUI();
    this.setupEventListeners();

    this.initializeTabContextUI();
    this.initializeQuickActionButtons();

    await this.initializeTabInfo();
    if (isSmartMode) {
      // Don't await to avoid blocking initialization
      this.showQuickPrompts().catch(console.error);
    }
  }

  setupKeyUI() {
    // Setup key input event listeners
    const keyInput = document.getElementById("key-input");
    const keySubmit = document.getElementById("key-submit");
    const keyError = document.getElementById("key-error");

    const handleKeySubmit = async () => {
      const key = keyInput.value.trim();
      if (!key) {
        keyError.textContent = "Please enter your API key";
        keyError.style.display = "block";
        return;
      }

      try {
        Services.prefs.setStringPref("browser.smartwindow.key", key);
        this.focusSearchInputWhenReady();
      } catch (error) {
        console.error("Key setup error:", error);
        keyError.textContent = "Failed to setup key. Please try again.";
        keyError.style.display = "block";
      }
    };

    keySubmit.addEventListener("click", handleKeySubmit);
    keyInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleKeySubmit();
      }
      // Hide error when user starts typing
      if (keyError.style.display !== "none") {
        keyError.style.display = "none";
      }
    });
  }

  focusSearchInputWhenReady() {
    // This can open in preloaded (background) browsers. Check visibility before focusing, and then also refocus
    // when tab is switched to.
    const focusWhenVisible = () => {
      if (document.visibilityState === "visible" && this.smartbar) {
        this.smartbar.focus();
      }
    };
    focusWhenVisible();
    document.addEventListener("visibilitychange", focusWhenVisible);
  }

  async initializeTabInfo() {
    const selectedTab = topChromeWindow.gBrowser.selectedTab;
    const selectedBrowser = topChromeWindow.gBrowser.selectedBrowser;

    this.lastTabInfo = {
      title: selectedTab.label || "Untitled",
      url: selectedBrowser.currentURI.spec || "",
      favicon: selectedTab.image || "",
      tabId: selectedTab.linkedPanel, // Use linkedPanel as unique tab identifier
    };

    // console.log("Set lastTabInfo to:", this.lastTabInfo);

    try {
      await this.resetContextToCurrentTab();
    } catch (error) {
      console.error(
        "[ERROR] initializeTabInfo(): Could not load messages for current tab"
      );
    }

    if (this.isSidebarMode) {
      this.updateTabStatus(this.lastTabInfo);
    }
  }

  #createStatusBar() {
    // Create status bar for current tab info
    const statusBar = document.createElement("div");
    statusBar.id = "status-bar";
    statusBar.className = "status-bar";

    const statusContent = document.createElement("div");
    statusContent.className = "status-content";
    statusContent.innerHTML = `
      <img class="status-favicon" id="status-favicon" src="" alt="">
      <div class="status-text">
        <div class="status-title" id="status-title">Loading...</div>
        <div class="status-url" id="status-url"></div>
        <div class="status-page-text" id="status-page-text"></div>
      </div>
    `;

    statusBar.appendChild(statusContent);

    const searchBox = document.querySelector(".search-box");
    searchBox.before(statusBar);
    this.#fillStatusBar();
    return statusBar;
  }

  #toggleStatusBar() {
    let statusBar = document.getElementById("status-bar");
    let shouldOpen = !statusBar || statusBar.hidden;
    if (shouldOpen) {
      if (!statusBar) {
        statusBar = this.#createStatusBar();
      } else {
        this.#fillStatusBar();
      }
    }
    statusBar.hidden = !shouldOpen;
  }

  #fillStatusBar() {
    let tabInfo = this.lastTabInfo;
    const titleEl = document.getElementById("status-title");
    const urlEl = document.getElementById("status-url");
    const faviconEl = document.getElementById("status-favicon");
    const pageTextEl = document.getElementById("status-page-text");

    if (titleEl) {
      titleEl.textContent = tabInfo.title || "Untitled";
    }
    if (urlEl) {
      // Format URL for display
      let displayUrl = tabInfo.url;
      try {
        const url = new URL(tabInfo.url);
        displayUrl = url.hostname + (url.pathname !== "/" ? url.pathname : "");
      } catch (e) {
        // Keep original for non-standard URLs
      }
      urlEl.textContent = displayUrl;
    }
    if (faviconEl && tabInfo.favicon) {
      faviconEl.src = tabInfo.favicon;
      faviconEl.style.display = "block";
    } else if (faviconEl) {
      faviconEl.style.display = "none";
    }

    if (pageTextEl) {
      let pageText = this.currentTabPageText;
      const preview =
        pageText.length > 30 ? pageText.substring(0, 30) + "…" : pageText;
      pageTextEl.textContent = pageText
        ? `${preview} (${pageText.length})`
        : "No text content";
    }
  }

  setupSubmitButton() {
    // Find the submit button
    this.submitButton = document.getElementById("submit-button");
    this.buttonText = this.submitButton?.querySelector(".button-text");

    if (!this.submitButton) {
      return;
    }

    // Set initial state
    this.updateSubmitButton("");

    // Add click handler
    this.submitButton.addEventListener("click", () => {
      const text = this.smartbar ? this.smartbar.getText() : "";
      if (text.trim()) {
        this.handleEnter(text);
      } else if (this.smartbar) {
        // If empty, focus the editor
        this.smartbar.focus();
      }
    });

    // Setup model picker
    this.modelPicker = document.getElementById("model-picker");
    if (this.modelPicker) {
      // Set initial value from pref
      this.modelPicker.value = Services.prefs.getStringPref(
        "browser.smartwindow.model"
      );

      // Update pref when model changes
      this.modelPicker.addEventListener("change", () => {
        Services.prefs.setStringPref(
          "browser.smartwindow.model",
          this.modelPicker.value
        );
      });
    }

    // Setup query type picker
    this.queryTypePicker = document.getElementById("query-type-picker");
    if (this.queryTypePicker) {
      // Set initial value from pref (default to "auto")
      this.queryTypePicker.value = Services.prefs.getStringPref(
        "browser.smartwindow.queryType",
        "auto"
      );

      // Update pref when query type changes
      this.queryTypePicker.addEventListener("change", () => {
        Services.prefs.setStringPref(
          "browser.smartwindow.queryType",
          this.queryTypePicker.value
        );
        // Update button immediately if there's text
        const text = this.smartbar ? this.smartbar.getText() : "";
        if (text.trim()) {
          this.updateSubmitButton(text);
        }
      });
    }
  }

  async updateSubmitButton(query) {
    if (!this.submitButton || !this.buttonText) {
      return;
    }

    if (query.trim()) {
      // When there's text, show the appropriate action label
      const type = await this.getEffectiveQueryType(query);
      const label = this.getQueryTypeLabel(type);
      this.buttonText.textContent = label;
      this.submitButton.classList.add("has-text");
    } else {
      // When empty, show arrow
      this.buttonText.textContent = "→";
      this.submitButton.classList.remove("has-text");
    }
  }

  async showQuickPrompts() {
    if (!this.quickPromptsContainer) {
      return;
    }

    // Use stored tab info for context
    const tabTitle = this.lastTabInfo?.title || "";

    const prompts = await this.generateQuickPrompts(tabTitle);

    // Don't display anything if no prompts
    if (!prompts || prompts.length === 0) {
      // Still don't hide - keep existing prompts if any
      return;
    }

    this.displayQuickPrompts(prompts);
    this.userHasEditedQuery = false;
  }

  displayQuickPrompts(prompts) {
    if (!this.quickPromptsContainer) {
      return;
    }

    // Show container
    this.quickPromptsContainer.classList.remove("hidden");

    // Clear existing prompts
    this.quickPromptsContainer.innerHTML = "";

    // Add emoji mapping for prompt types
    const getEmoji = type => {
      switch (type) {
        case "chat":
          return "💬";
        case "search":
          return "🔍";
        case "navigate":
          return "🌐";
        case "action":
          return "⚡";
        default:
          return "💡";
      }
    };

    // Create pill buttons for each prompt (limit to top 2)
    prompts.slice(0, 2).forEach(quickPrompt => {
      const pill = document.createElement("button");
      pill.className = "quick-prompt-pill";

      const emoji = document.createElement("span");
      emoji.className = "quick-prompt-emoji";
      emoji.textContent = getEmoji(quickPrompt.type);

      const text = document.createElement("span");
      text.className = "quick-prompt-text";
      text.textContent = quickPrompt.text;

      pill.appendChild(emoji);
      pill.appendChild(text);

      // Add click handler
      pill.addEventListener("click", () => {
        if (this.smartbar) {
          this.smartbar.setContent(quickPrompt.text);
        }
        this.handleEnter(quickPrompt.text);
      });

      this.quickPromptsContainer.appendChild(pill);
    });
  }

  hideQuickPrompts() {
    if (this.quickPromptsContainer) {
      this.quickPromptsContainer.classList.add("hidden");
    }
  }

  setupEventListeners() {
    document.addEventListener("FocusSmartSearchInput", () => {
      this.smartbar.focus();
    });
    document.addEventListener(
      "keypress",
      e => {
        if (
          e.key == "?" &&
          (navigator.platform == "MacIntel" ? e.metaKey : e.ctrlKey)
        ) {
          e.preventDefault();
          this.#toggleStatusBar();
        }
      },
      { capture: true }
    );
    if (this.isSidebarMode) {
      window.addEventListener("SmartWindowMessage", e => {
        if (e.detail.type === "TabUpdate") {
          this.updateTabStatus(e.detail.data);
        }
      });
    }

    if (this.chatBot) {
      this.chatBot.addEventListener("search-suggested", e => {
        const query = e.detail.query;
        const clickEvent = e.detail.clickEvent;
        this.performNavigation(query, "search", clickEvent);
      });

      this.chatBot.addEventListener("tool-call", e => {
        console.log("[SmartWindow] Tool call event:", e.detail);
        // Update the chat bot's internal log state
        if (this.chatBot.updateLogState) {
          this.chatBot.updateLogState(e.detail);
        }
      });
    }

    if (topChromeWindow) {
      document
        .getElementById("open-smart-window")
        .addEventListener("click", () => {
          topChromeWindow.SmartWindow.toggleSmartWindow();
        });
      topChromeWindow.addEventListener("SmartWindowModeChanged", event => {
        const isActive = event.detail.active;

        // If we're in sidebar mode, always keep the editor enabled
        // regardless of the smart window mode state
        if (this.isSidebarMode) {
          console.trace(
            "[SmartWindow] Ignoring mode change event because we're in sidebar mode"
          );
          return;
        }

        document.documentElement.classList.toggle("smart-window", isActive);
        if (!isActive) {
          // Disable editor when switching to classic mode
          console.log(
            "[SmartWindow] Disabling editor (switching to classic mode)"
          );
          this.smartbar?.setEditable(false);
          // Hide suggestions
          this.smartbar?.hideSuggestions();

          if (this.submitButton) {
            this.submitButton.disabled = true;
          }
        } else if (this.smartbar) {
          // Re-enable editor when switching back to smart mode
          console.log(
            "[SmartWindow] Enabling editor (switching to smart mode)"
          );
          this.smartbar.setEditable(true);
          const text = this.smartbar.getText();
          this.updateSubmitButton(text);
          // Show quick prompts if input is empty
          if (!text.trim()) {
            this.showQuickPrompts().catch(console.error);
          }
        }
      });
    }

    window.addEventListener("SmartWindowVisibilityChanged", _event => {
      // TODO: The smart window opened or closed, maybe we need to do some kind of UI update
      // event.detail.visible
    });

    if (gBrowser?.tabContainer) {
      const tabListener = {
        onStateChange: (browser, webProgress, request, stateFlags) => {
          if (
            webProgress.isTopLevel &&
            stateFlags & Ci.nsIWebProgressListener.STATE_STOP &&
            stateFlags & Ci.nsIWebProgressListener.STATE_IS_WINDOW
          ) {
            const newLocation = browser.currentURI.spec;
            if (!this.isTabEligibleForContext(this.lastTabInfo)) {
              this.#conversation.pageUrl = newLocation;

              this.initializeTabInfo().then(() => {
                this.loadChatMessagesForCurrentContext();
              });
            }
          }
        },
      };

      gBrowser.addTabsProgressListener(tabListener);
    }
  }

  handleKeyDown(e) {
    const suggestionsVisible = this.smartbar
      ? this.smartbar.hasSuggestions()
      : false;
    switch (e.key) {
      case "Enter":
        // Only handle Enter without Shift (Shift+Enter creates new line)
        if (!e.shiftKey) {
          e.preventDefault();
          const selectedSuggestion = this.smartbar
            ? this.smartbar.getSelectedSuggestion()
            : null;
          if (selectedSuggestion) {
            // Set the content before submitting when selecting a suggestion
            if (this.smartbar) {
              this.smartbar.setContent(selectedSuggestion.text);
            }
            this.handleEnter(selectedSuggestion.text);
          } else {
            const text = this.smartbar ? this.smartbar.getText() : "";
            this.handleEnter(text);
          }
        }
        // If Shift is pressed, let Tiptap handle it for new line
        break;

      case "ArrowDown":
        if (suggestionsVisible) {
          e.preventDefault();
          if (this.smartbar) {
            this.smartbar.navigateSuggestions("down");
          }
        }
        break;

      case "ArrowUp":
        if (suggestionsVisible) {
          e.preventDefault();
          if (this.smartbar) {
            this.smartbar.navigateSuggestions("up");
          }
        }
        break;

      case "Escape":
        e.preventDefault();
        const currentText = this.smartbar ? this.smartbar.getText() : "";
        if (currentText.trim()) {
          // Clear input and reset to quick prompts
          if (this.smartbar) {
            this.smartbar.clear();
          }
          this.updateSubmitButton("");
          this.userHasEditedQuery = false;
          if (this.smartbar) {
            this.smartbar.hideSuggestions();
          }
        } else if (this.smartbar) {
          // Hide suggestions if input is already empty
          this.smartbar.hideSuggestions();
        }
        break;
    }
  }

  async updateTabStatus(tabInfo) {
    // Close any open tab context dropdown when switching tabs
    this.closeTabDropdown();

    // Hide any existing suggestions immediately to prevent showing stale prompts
    const editorText = this.smartbar ? this.smartbar.getText() : "";
    if (!this.userHasEditedQuery && !editorText.trim()) {
      if (this.smartbar) {
        this.smartbar.hideSuggestions();
      }
    }

    // Store the latest tab info
    this.lastTabInfo = tabInfo;

    // Skip expensive operations for about:blank (happens during tab restore)
    const isAboutBlank = tabInfo.url === "about:blank";

    if (!isAboutBlank) {
      // Reset tab context to current tab when switching (handles chat persistence)
      await this.resetContextToCurrentTab();

      // Update tab context UI with new current tab info
      this.updateTabContextUI();
    }

    // Update quick prompts if user hasn't edited the query (skip for about:blank)
    if (!isAboutBlank && !this.userHasEditedQuery && !editorText.trim()) {
      this.showQuickPrompts().catch(console.error);
    }

    // Get page text and display in status
    // Wait a moment for page to load
    await new Promise(resolve => setTimeout(resolve, 1000));
    const selectedBrowser = topChromeWindow.gBrowser.selectedBrowser;
    try {
      const pageExtractor =
        await selectedBrowser.browsingContext.currentWindowContext.getActor(
          "PageExtractor"
        );
      /** @type {{ text: string, method: string }} */
      let text = await pageExtractor.getReaderModeContent();

      if (!text) {
        text = await pageExtractor.getText();
      }

      if (!text) {
        text = "No page text was present";
      }
      // Store page text for use in chat system prompt
      this.currentTabPageText = text;
    } catch (error) {
      this.currentTabPageText = "Couldn't read page text.";
      console.error("Failed to get page text:", error);
    }

    if (document.getElementById("status-bar")?.hidden === false) {
      this.#fillStatusBar();
    }
  }

  handleSearch(query) {
    // Update submit button based on query
    this.updateSubmitButton(query);

    // Clear any existing debounce timer first
    if (this.suggestionDebounceTimer) {
      clearTimeout(this.suggestionDebounceTimer);
      this.suggestionDebounceTimer = null;
    }

    if (!query.trim()) {
      // Show quick prompts when input is empty
      this.userHasEditedQuery = false;
      if (this.smartbar) {
        this.smartbar.hideSuggestions();
      }
      this.showQuickPrompts().catch(console.error);
      return;
    }

    // Mark that user has manually edited the query
    this.userHasEditedQuery = true;

    // Debounce live suggestions
    this.suggestionDebounceTimer = setTimeout(() => {
      this.generateLiveSuggestions(query);
    }, 50);
  }

  async generateLiveSuggestions(query) {
    try {
      const context = new lazy.UrlbarQueryContext({
        searchString: query.trim(),
        allowAutofill: false,
        isPrivate: false,
        maxResults: 20,
        userContextId: 0,
      });

      const controller = new lazy.UrlbarController({
        input: {
          isPrivate: false,
          onFirstResult() {},
          window: topChromeWindow,
        },
      });

      // Start the query and wait for results
      await lazy.UrlbarProvidersManager.startQuery(context, controller);

      // Process the results similar to api.ts getUrlbarSuggestions
      const suggestions = [];

      // Convert Firefox urlbar results to our suggestion format
      const urlbarSuggestions = [];
      for (const result of context.results) {
        let suggestion = {
          type: "search", // default
          text: "",
          title: "",
          url: "",
          icon: "",
          description: "",
        };

        // Map Firefox result types to our suggestion types (based on api.ts)
        switch (result.type) {
          case 1: // Tab switch
            suggestion.type = "action";
            suggestion.text = `tab switch: ${result.payload.title || result.payload.url || ""}`;
            suggestion.title = result.payload.title || "";
            suggestion.url = result.payload.url || "";
            suggestion.icon = result.payload.icon || "";
            break;

          case 2: // Search suggestion
            suggestion.type = "search";
            suggestion.text =
              result.payload.suggestion || result.payload.query || query;
            suggestion.title = result.payload.suggestion || "";
            suggestion.description = result.payload.description || "";
            suggestion.icon = result.payload.icon || "";
            break;

          case 3: // URL/bookmark
            suggestion.type = "navigate";
            suggestion.text =
              result.payload.displayUrl || result.payload.url || "";
            suggestion.title = result.payload.title || "";
            suggestion.url = result.payload.url || "";
            suggestion.icon = result.payload.icon || "";
            break;

          default:
            continue; // Skip unknown types
        }

        // Only add non-empty suggestions
        if (suggestion.text.trim()) {
          urlbarSuggestions.push(suggestion);
        }
      }

      // Process suggestions similar to extension's generateLiveSuggestions

      // Get search results from urlbar
      const searchResults = urlbarSuggestions.filter(s => s.type === "search");

      if (searchResults.length) {
        // Process search results through detectQueryType to determine final type
        const resultsToProcess = searchResults.slice(0, 6);
        for (const result of resultsToProcess) {
          const detectedType = await this.getEffectiveQueryType(result.text);
          suggestions.push({
            title: result.title,
            text: result.text,
            type: detectedType,
          });
        }
      }

      // Add navigate results as-is
      const navigateResults = urlbarSuggestions.filter(
        s => s.type === "navigate"
      );
      const navigateSuggestions = navigateResults.slice(0, 2).map(s => ({
        title: s.title,
        text: s.text,
        type: s.type,
      }));
      suggestions.push(...navigateSuggestions);

      // Add action results as-is
      const actionResults = urlbarSuggestions.filter(s => s.type === "action");
      const actionSuggestions = actionResults.slice(0, 2).map(s => ({
        title: s.title,
        text: s.text,
        type: s.type,
      }));
      suggestions.push(...actionSuggestions);

      // If we don't have enough suggestions, add some fallbacks
      if (suggestions.length < 4) {
        const queryType = await this.getEffectiveQueryType(query);

        // Add the query itself if not already present
        if (!suggestions.some(s => s.text === query)) {
          suggestions.push({ text: query, type: queryType });
        }

        // Add some generic suggestions if still short
        if (suggestions.length < 6) {
          const fallbacks = [
            //{ text: "tab next", type: "action" },
            { text: "github.com", type: "navigate" },
            { text: query + " guide", type: "search" },
            { text: query + " tutorial", type: "search" },
          ];

          for (const fallback of fallbacks) {
            if (suggestions.length >= 6) {
              break;
            }
            if (!suggestions.some(s => s.text === fallback.text)) {
              suggestions.push(fallback);
            }
          }
        }
      }

      if (this.smartbar) {
        this.smartbar.showSuggestions(
          suggestions.slice(0, 10),
          "Suggestions:",
          false,
          query
        );
      }
    } catch (error) {
      console.error("Error getting live suggestions:", error);

      // Fall back to simple suggestions on error
      const suggestions = [];
      const type = await this.getEffectiveQueryType(query);

      suggestions.push(
        { text: query, type },
        { text: "tab next", type: "action" },
        { text: "github.com", type: "navigate" }
      );

      if (this.smartbar) {
        this.smartbar.showSuggestions(
          suggestions,
          "Suggestions:",
          false,
          query
        );
      }
    }
  }

  async handleEnter(query) {
    if (!query.trim()) {
      return;
    }

    document.documentElement.setAttribute("haschat", "true");

    const type = await this.getEffectiveQueryType(query);

    // Hide suggestions after selection
    if (this.smartbar) {
      this.smartbar.hideSuggestions();
    }

    // Handle chat queries with chatbot component in both modes
    if (type === "chat") {
      // Show chat component and submit the prompt with tab context
      this.showChatMode();

      // Make sure the tab info is updated
      if (this.#conversation.pageUrl === "") {
        await this.initializeTabInfo();
      }

      if (this.chatBot) {
        const contextTabs = this.getAllContextTabs();
        // Pass page text if current tab is in context
        const includePageText = this.isCurrentTabInContext();

        await this.chatBot.submitPrompt(
          this.#conversation,
          query,
          contextTabs,
          includePageText ? this.currentTabPageText : ""
        );

        await this.saveChatMessagesForCurrentContext();
      }
      // For chat on smart window page (not sidebar), don't open sidebar
      // The sidebar logic is handled by performNavigation for search/navigate types
    } else if (type === "action") {
      if (this.isSidebarMode) {
        // NOTE: Can we remove this isSidebarMode? ask @mardak
        // Handle actions in sidebar
        // this.handleAction(query);
      } else {
        // In full page mode, convert actions to search
        this.hideChatMode();
        this.performNavigation(query, type);
      }
    } else {
      // For navigate and search, hide chat mode and show regular messages
      this.hideChatMode();
      if (this.isSidebarMode) {
        // NOTE: does this still exist? ask @mardak
        // this.addMessage(`Navigating: ${query}`, "user");
      }
      this.performNavigation(query, type);

      // Open sidebar for search queries when not in sidebar mode and not on a new tab
      if (type === "search" && !this.isSidebarMode) {
        // Tell the chrome window to show the sidebar
        if (topChromeWindow.SmartWindow) {
          topChromeWindow.SmartWindow.showSidebar();
        }
      }
    }

    // Clear any pending suggestion timer to prevent race condition
    if (this.suggestionDebounceTimer) {
      clearTimeout(this.suggestionDebounceTimer);
      this.suggestionDebounceTimer = null;
    }

    // Clear editor and reset state
    if (this.smartbar) {
      this.smartbar.clear();
    }
    this.updateSubmitButton("");
    this.userHasEditedQuery = false;
    if (this.smartbar) {
      this.smartbar.hideSuggestions();
    }
  }

  performNavigation(query, type, clickEvent = null) {
    // Save chat messages for current tab before navigating
    if (this.chatBot && this.chatBot.messages && this.chatBot.messages.length) {
      // topChromeWindow.SmartWindow.setChatMessages(
      //   topChromeWindow.gBrowser.selectedTab.linkedPanel,
      //   this.chatBot.messages
      // );
      this.#chatHistory.updateConversation(this.#conversation);
    }

    let url = query;

    if (type === "navigate") {
      // Handle domain/URL navigation
      if (!query.includes("://")) {
        url = query.startsWith("about:") ? query : "https://" + query;
      }
    } else if (type === "search") {
      // Handle search queries
      url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    } else if (type === "chat") {
      // For chat queries in full page mode, convert to search
      url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    }

    // Check for cmd/ctrl+click to open in new tab
    const openInNewTab =
      clickEvent && (clickEvent.metaKey || clickEvent.ctrlKey);

    if (openInNewTab) {
      topChromeWindow.gBrowser.addTab(url, {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
        relatedToCurrent: true,
      });
    } else {
      topChromeWindow.gBrowser.selectedBrowser.fixupAndLoadURIString(url, {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
    }
  }

  displayResults(results) {
    this.clearResults();

    results.forEach(result => {
      const item = document.createElement("div");
      item.className = "result-item";
      item.textContent = result.title || result.url;
      item.dataset.url = result.url;

      item.addEventListener("click", () => {
        window.location.href = result.url;
      });

      this.resultsContainer.appendChild(item);
    });
  }

  clearResults() {
    this.resultsContainer.textContent = "";
  }

  toggleBottomChatMode(useBottomMode) {
    document.documentElement?.classList.toggle(
      "chat-mode-bottom",
      useBottomMode
    );
  }

  showChatMode() {
    // Hide any existing messages in results container
    const existingMessages = this.resultsContainer.querySelectorAll(".message");
    existingMessages.forEach(msg => (msg.style.display = "none"));

    // Move input box to bottom for chat mode
    this.toggleBottomChatMode(true);

    // Chat bot component is now always visible (contains the insights button)
    // No need to toggle display

    // Hide suggestions when chat mode is active
    if (this.smartbar) {
      this.smartbar.hideSuggestions();
    }

    // In fullscreen mode, quick prompts are hidden via CSS when chat is active
    // In sidebar mode, they remain visible with reduced opacity
  }

  hideChatMode() {
    if (!this.isSidebarMode) {
      this.toggleBottomChatMode(false);
    }

    // Chat bot component stays visible (for the insights button)
    // No need to toggle display

    // Show any existing messages in results container
    const existingMessages = this.resultsContainer.querySelectorAll(".message");
    existingMessages.forEach(msg => (msg.style.display = "block"));

    // Hide suggestions if input is empty and user hasn't edited query
    const editorText = this.smartbar ? this.smartbar.getText() : "";
    if (!this.userHasEditedQuery && !editorText.trim()) {
      if (this.smartbar) {
        this.smartbar.hideSuggestions();
      }
    }
  }

  setupQuickActionEventListeners() {
    this.quickActionButtons.history?.addEventListener("click", e => {
      e.stopPropagation();

      const viewHandler = topChromeWindow?.FirefoxViewHandler;
      if (viewHandler) {
        viewHandler.openTab("history");
      } else {
        console.warn("[SmartWindow] FirefoxViewHandler is not available.");
      }
    });

    this.quickActionButtons.insights?.addEventListener("click", e => {
      e.stopPropagation();

      document.location.href =
        "chrome://browser/content/smartwindow/insights.html";
    });

    this.quickActionButtons.developer?.addEventListener("click", e => {
      e.stopPropagation();

      // Toggle the developer pref
      const currentValue = Services.prefs.getBoolPref(
        "browser.smartwindow.developer",
        false
      );
      Services.prefs.setBoolPref(
        "browser.smartwindow.developer",
        !currentValue
      );
    });
  }

  initializeQuickActionButtons() {
    this.quickActionButtons = {
      history: document.getElementById("history-button"),
      insights: document.getElementById("insights-button"),
      developer: document.getElementById("developer-button"),
    };

    this.setupQuickActionEventListeners();
  }
}

new SmartWindowPage();
