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

import { generateSmartQuickPrompts } from "./utils.mjs";

const { embedderElement, topChromeWindow } = window.browsingContext;

class SmartWindowPage {
  constructor() {
    this.searchInput = null;
    this.resultsContainer = null;
    this.submitButton = null;
    this.suggestionsContainer = null;
    this.isSidebarMode = false;
    this.messages = [];
    this.currentSuggestions = [];
    this.selectedSuggestionIndex = -1;
    this.userHasEditedQuery = false;
    this.suggestionDebounceTimer = null;
    this.lastTabInfo = null;
    this.chatBot = null;
    this.chatMessagesByTab = new Map(); // Store chat messages by tab ID

    // Tab context management
    this.selectedTabContexts = []; // Array of tab info objects selected for context
    this.recentTabs = []; // Cache of recent tabs
    this.tabContextElements = {};
    this.currentTabPageText = ""; // Store readable text from current tab

    this.init();
  }

  // Query type detection functions (ported from utils.ts)
  detectQueryType(query) {
    const trimmedQuery = query.trim().toLowerCase();

    // URL detection: starts with http/https or contains protocol-like patterns
    if (
      /^(about|https?):/.test(trimmedQuery) ||
      /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(
        trimmedQuery.replace(/^https?:\/\//, "")
      )
    ) {
      return "navigate";
    }

    // Domain detection: no spaces with at least one period (supports subdomains and paths)
    if (
      /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(trimmedQuery) &&
      !trimmedQuery.includes(" ")
    ) {
      return "navigate";
    }

    // Chat detection: starts with question words (with optional punctuation) OR ends with question mark
    if (
      /^(who|what|when|where|why|how|can)\b/i.test(trimmedQuery) ||
      trimmedQuery.endsWith("?")
    ) {
      return "chat";
    }

    // Action detection: starts with "tab" or "find" or "tab switch:"
    if (
      trimmedQuery.startsWith("tab") ||
      trimmedQuery.startsWith("find") ||
      trimmedQuery.startsWith("tab switch:")
    ) {
      return "action";
    }

    // Default to search
    return "search";
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

    // For non-sidebar mode (full page), don't show quick prompts if no context tabs
    if (!this.isSidebarMode && contextTabs.length === 0) {
      return [];
    }

    // Check cache first using shared cache from topChromeWindow
    const cacheKey =
      topChromeWindow.SmartWindow.getContextCacheKey(contextTabs);
    const cachedPromise =
      topChromeWindow.SmartWindow.getPromptsFromCache(cacheKey);

    if (cachedPromise) {
      return await cachedPromise;
    }

    // Create a promise for generating prompts and cache it immediately
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
        } catch (e) {
          // Skip invalid URLs
        }
      }
    }

    // Add up to 2 unique domains
    const domainArray = Array.from(domains).slice(0, 2);
    domainArray.forEach(domain => {
      suggestions.push({ text: domain, type: "navigate" });
    });

    // 1 action
    suggestions.push({ text: "tab next", type: "action" });

    return suggestions;
  }

  // Tab Context Management Methods
  initializeTabContextUI() {
    // Get references to tab context elements
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

    // Set up event listeners for tab context UI
    this.setupTabContextEventListeners();

    // Initialize with current tab in context
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
    this.tabContextElements.removeCurrentTab.addEventListener("click", e => {
      e.stopPropagation();
      if (this.lastTabInfo) {
        this.removeTabFromContext(this.lastTabInfo.tabId);
      }
    });

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

      this.recentTabs = recentTabs.slice(0, 20); // Keep only 20 most recent
      return this.recentTabs;
    } catch (error) {
      console.error("Error getting recent tabs:", error);
      return [];
    }
  }

  addTabToContext(tabInfo) {
    // Check if tab is already in context
    const exists = this.selectedTabContexts.some(
      tab => tab.tabId === tabInfo.tabId
    );
    if (!exists) {
      // Save chat messages for the old context
      this.saveChatMessagesForCurrentContext();

      this.selectedTabContexts.push(tabInfo);
      this.updateTabContextUI();
      this.updateQuickPromptsWithContext();

      // Load chat messages for the new context
      this.loadChatMessagesForCurrentContext();
    }
  }

  removeTabFromContext(tabId) {
    // Save chat messages for the old context
    this.saveChatMessagesForCurrentContext();

    this.selectedTabContexts = this.selectedTabContexts.filter(
      tab => tab.tabId !== tabId
    );
    this.updateTabContextUI();
    this.updateQuickPromptsWithContext();

    // Load chat messages for the new context
    this.loadChatMessagesForCurrentContext();
  }

  updateTabContextUI() {
    // Update current tab button - show only if current tab is in context
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

    // Update add tabs button
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
      addTabsText.textContent = "add tabs";
      overlappingFavicons.style.display = "none";
    } else {
      // State 2/3: Show overlapping favicons
      addTabsIcon.style.display = "none";
      addTabsText.style.display = "none";
      overlappingFavicons.style.display = "flex";

      // Update favicon stack
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

      // Update count text
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

    // Get recent tabs
    await this.getRecentTabs();

    // Clear existing items
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

    // Show dropdown
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
    item.addEventListener("click", () => {
      const isCurrentlySelected = checkbox.classList.contains("checked");

      // Treat all tabs the same way
      if (isCurrentlySelected) {
        this.removeTabFromContext(tabInfo.tabId);
        checkbox.classList.remove("checked");
      } else {
        this.addTabToContext(tabInfo);
        checkbox.classList.add("checked");
      }
    });

    return item;
  }

  async updateQuickPromptsWithContext() {
    // Only update if user hasn't edited query and suggestions are showing
    if (
      !this.userHasEditedQuery &&
      !!this.currentSuggestions.length &&
      !this.searchInput.value.trim()
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
      !url.startsWith("about:") &&
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
  resetContextToCurrentTab() {
    // Save chat messages for the old context before changing
    this.saveChatMessagesForCurrentContext();

    if (this.lastTabInfo && this.isTabEligibleForContext(this.lastTabInfo)) {
      this.selectedTabContexts = [this.lastTabInfo];
    } else {
      this.selectedTabContexts = [];
    }
    this.updateTabContextUI();

    // Load chat messages for the new context
    this.loadChatMessagesForCurrentContext();
  }

  // Save chat messages to all tabs in current context
  saveChatMessagesForCurrentContext() {
    if (this.chatBot && this.chatBot.messages && this.chatBot.messages.length) {
      // Save to all tabs in current context
      for (const tab of this.selectedTabContexts) {
        this.chatMessagesByTab.set(tab.tabId, [...this.chatBot.messages]);
      }
    }
  }

  // Load chat messages for the current context (prioritize current tab)
  loadChatMessagesForCurrentContext() {
    if (this.chatBot) {
      let savedMessages = [];

      // Try to load from current tab first
      if (this.lastTabInfo && this.isCurrentTabInContext()) {
        savedMessages =
          this.chatMessagesByTab.get(this.lastTabInfo.tabId) || [];
      }

      // If no messages from current tab, try other tabs in context
      if (savedMessages.length === 0) {
        for (const tab of this.selectedTabContexts) {
          savedMessages = this.chatMessagesByTab.get(tab.tabId) || [];
          if (savedMessages.length) {
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
        // Clear messages and hide chat mode
        this.chatBot.messages = [];
        this.chatBot.requestUpdate();
        this.hideChatMode();
      }
    }
  }

  init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.onDOMReady());
    } else {
      this.onDOMReady();
    }
  }

  onDOMReady() {
    // Check if we're in sidebar mode by looking at embedder
    this.isSidebarMode = embedderElement.id == "smartwindow-browser";

    this.searchInput = document.getElementById("search-input");
    this.resultsContainer = document.getElementById("results-container");
    this.chatBot = document.getElementById("chat-bot");

    // Create and setup suggestions container
    this.setupSuggestionsUI();

    // Create and setup dynamic submit button
    this.setupSubmitButton();

    // Check if we're in Smart Mode or Classic Mode
    const isSmartMode =
      topChromeWindow?.document?.documentElement?.hasAttribute("smart-window");

    // Auto-focus the search input
    if (this.searchInput && isSmartMode) {
      this.focusSearchInputWhenReady();
    }

    // Update placeholder and state based on mode
    if (this.searchInput) {
      if (!isSmartMode) {
        this.searchInput.disabled = true;
        this.searchInput.placeholder =
          "Smart Window disabled - switch back to Smart Mode to search";
        if (this.submitButton) {
          this.submitButton.disabled = true;
        }
      } else {
        this.searchInput.placeholder = "Ask, search, or type a URL...";
      }
    }

    // If in sidebar mode, update UI and behavior
    if (this.isSidebarMode) {
      document.body.classList.add("sidebar-mode");
      this.setupSidebarUI();
    }

    this.setupEventListeners();

    // Initialize tab context UI
    this.initializeTabContextUI();

    // Initialize tab info and show quick prompts (only if Smart Mode is active)
    this.initializeTabInfo();
    if (isSmartMode) {
      // Don't await to avoid blocking initialization
      this.showQuickPrompts().catch(console.error);
    }

    console.log(
      `Smart Window page initialized (sidebar mode: ${this.isSidebarMode}, smart mode: ${isSmartMode})`
    );
  }

  focusSearchInputWhenReady() {
    // This can open in preloaded (background) browsers. Check visibility before focusing, and then also refocus
    // when tab is switched to.
    const focusWhenVisible = () => {
      console.log("visibilitychange", document.visibilityState);
      if (document.visibilityState === "visible") {
        this.searchInput.focus();
      }
    };
    focusWhenVisible();
    document.addEventListener("visibilitychange", focusWhenVisible);
  }

  initializeTabInfo() {
    // Initialize with current tab data
    const selectedTab = topChromeWindow.gBrowser.selectedTab;
    const selectedBrowser = topChromeWindow.gBrowser.selectedBrowser;

    this.lastTabInfo = {
      title: selectedTab.label || "Untitled",
      url: selectedBrowser.currentURI.spec || "",
      favicon: selectedTab.image || "",
      tabId: selectedTab.linkedPanel, // Use linkedPanel as unique tab identifier
    };

    // Initialize tab context and update status bar if in sidebar mode
    this.resetContextToCurrentTab();
    if (this.isSidebarMode) {
      this.updateTabStatus(this.lastTabInfo);
    }
  }

  setupSidebarUI() {
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

    // Insert before search box
    const searchBox = document.querySelector(".search-box");
    searchBox.parentNode.insertBefore(statusBar, searchBox);
  }

  setupSuggestionsUI() {
    // Create suggestions container
    this.suggestionsContainer = document.createElement("div");
    this.suggestionsContainer.id = "suggestions-container";
    this.suggestionsContainer.className = "suggestions-container";

    // Create suggestions header
    const suggestionsHeader = document.createElement("div");
    suggestionsHeader.className = "suggestions-header";
    suggestionsHeader.innerHTML = `
      <span class="suggestions-title">Quick Prompts:</span>
    `;

    // Create suggestions list
    const suggestionsList = document.createElement("div");
    suggestionsList.className = "suggestions-list";
    suggestionsList.id = "suggestions-list";

    this.suggestionsContainer.appendChild(suggestionsHeader);
    this.suggestionsContainer.appendChild(suggestionsList);

    // Insert after search box
    const searchBox = document.querySelector(".search-box");
    searchBox.parentNode.insertBefore(
      this.suggestionsContainer,
      searchBox.nextSibling
    );
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
      if (this.searchInput.value.trim()) {
        this.handleEnter(this.searchInput.value);
      } else {
        // If empty, focus the input
        this.searchInput.focus();
      }
    });
  }

  updateSubmitButton(query) {
    if (!this.submitButton || !this.buttonText) {
      return;
    }

    if (query.trim()) {
      // When there's text, show the appropriate action label
      const type = this.detectQueryType(query);
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
    // Don't show quick prompts if chat mode is active
    if (this.chatBot && this.chatBot.style.display === "block") {
      return;
    }

    // Use stored tab info for context
    const tabTitle = this.lastTabInfo?.title || "";

    const prompts = await this.generateQuickPrompts(tabTitle);

    // Don't display anything if no prompts
    if (!prompts || prompts.length === 0) {
      this.hideSuggestions();
      return;
    }

    // Update header based on context
    const contextTabs = this.getAllContextTabs();
    let headerText = "Quick Prompts:";
    if (contextTabs.length > 1) {
      headerText = `Context Prompts (${contextTabs.length} tabs):`;
    }

    this.displaySuggestions(prompts, headerText, true); // true = isQuickPrompts
    this.userHasEditedQuery = false;
  }

  displaySuggestions(
    suggestions,
    title = "Suggestions:",
    isQuickPrompts = false
  ) {
    if (!this.suggestionsContainer) {
      return;
    }

    // Manage suggestion visibility classes
    this.suggestionsContainer.classList.remove("hidden"); // Always show when displaying suggestions

    if (isQuickPrompts) {
      this.suggestionsContainer.classList.add("quick-prompts");
      this.suggestionsContainer.classList.remove("user-edited");
    } else {
      this.suggestionsContainer.classList.remove("quick-prompts");
      this.suggestionsContainer.classList.add("user-edited");
    }

    this.currentSuggestions = suggestions;
    this.selectedSuggestionIndex = -1;

    // Update header
    const header =
      this.suggestionsContainer.querySelector(".suggestions-title");
    if (header) {
      header.textContent = title;
    }

    // Clear and populate suggestions list
    const suggestionsList = document.getElementById("suggestions-list");
    suggestionsList.innerHTML = "";

    suggestions.forEach((suggestion, index) => {
      const suggestionButton = this.createSuggestionButton(suggestion, index);
      suggestionsList.appendChild(suggestionButton);
    });
  }

  createSuggestionButton(suggestion, index) {
    const button = document.createElement("button");
    button.className = `suggestion-button suggestion-${suggestion.type}`;
    button.dataset.index = index;

    const icon = document.createElement("span");
    icon.className = "suggestion-icon";
    icon.textContent = this.getQueryTypeIcon(suggestion.type);

    const text = document.createElement("span");
    text.className = "suggestion-text";
    text.textContent = suggestion.text;

    button.appendChild(icon);
    button.appendChild(text);

    // Add event listeners
    button.addEventListener("mouseenter", () => {
      this.selectSuggestion(index);
      this.searchInput.value = suggestion.text;
      this.updateSubmitButton(suggestion.text);
    });

    button.addEventListener("click", e => {
      e.preventDefault();
      this.handleEnter(suggestion.text);
    });

    return button;
  }

  selectSuggestion(index) {
    this.selectedSuggestionIndex = index;
    this.updateSuggestionSelection();
  }

  updateSuggestionSelection() {
    const suggestionButtons = document.querySelectorAll(".suggestion-button");
    suggestionButtons.forEach((button, index) => {
      button.classList.toggle(
        "selected",
        index === this.selectedSuggestionIndex
      );
    });
  }

  hideSuggestions() {
    if (this.suggestionsContainer) {
      // Add hidden class to explicitly hide suggestions
      this.suggestionsContainer.classList.add("hidden");
      this.suggestionsContainer.classList.remove(
        "quick-prompts",
        "user-edited"
      );
    }
    this.currentSuggestions = [];
    this.selectedSuggestionIndex = -1;
  }

  setupEventListeners() {
    this.searchInput.addEventListener("input", e => {
      this.handleSearch(e.target.value);
    });

    this.searchInput.addEventListener("keydown", e => {
      this.handleKeyDown(e);
    });

    // Add mouse leave handler to suggestions container to clear input
    if (this.suggestionsContainer) {
      this.suggestionsContainer.addEventListener("mouseleave", () => {
        if (!this.userHasEditedQuery && this.selectedSuggestionIndex >= 0) {
          this.searchInput.value = "";
          this.updateSubmitButton("");
          this.selectedSuggestionIndex = -1;
          this.updateSuggestionSelection();
        }
      });
    }

    // Listen for messages from the actor
    if (this.isSidebarMode) {
      window.addEventListener("SmartWindowMessage", e => {
        if (e.detail.type === "TabUpdate") {
          this.updateTabStatus(e.detail.data);
        }
      });
    }

    // Listen for search suggestions from chat component
    if (this.chatBot) {
      this.chatBot.addEventListener("search-suggested", e => {
        const query = e.detail.query;
        console.log("Chat suggested search:", query);
        this.performNavigation(query, "search");
      });
    }

    // Listen for Smart Window mode changes from the top chrome window
    if (topChromeWindow) {
      topChromeWindow.addEventListener("SmartWindowModeChanged", event => {
        const isActive = event.detail.active;
        console.log(
          `[SmartWindow] Mode changed to: ${isActive ? "Smart" : "Classic"}`
        );

        if (!isActive) {
          // Disable input when switching to classic mode
          this.searchInput.disabled = true;
          this.searchInput.placeholder =
            "Smart Window disabled - switch back to Smart Mode to search";
          if (this.submitButton) {
            this.submitButton.disabled = true;
          }
          // Hide suggestions
          this.hideSuggestions();
        } else {
          // Re-enable input when switching back to smart mode
          this.searchInput.disabled = false;
          this.searchInput.placeholder = this.isSidebarMode
            ? "Ask, search, or type a URL..."
            : "Ask, search, or type a URL...";
          this.updateSubmitButton(this.searchInput.value);
          // Show quick prompts if input is empty
          if (!this.searchInput.value.trim()) {
            this.showQuickPrompts().catch(console.error);
          }
        }
      });
    }
  }

  handleKeyDown(e) {
    const suggestionsVisible = !!this.currentSuggestions.length;

    switch (e.key) {
      case "Enter":
        e.preventDefault();
        if (this.selectedSuggestionIndex >= 0 && suggestionsVisible) {
          const suggestion =
            this.currentSuggestions[this.selectedSuggestionIndex];
          this.handleEnter(suggestion.text);
        } else {
          this.handleEnter(this.searchInput.value);
        }
        break;

      case "ArrowDown":
        if (suggestionsVisible) {
          e.preventDefault();
          this.selectedSuggestionIndex = Math.min(
            this.selectedSuggestionIndex + 1,
            this.currentSuggestions.length - 1
          );
          if (this.selectedSuggestionIndex >= 0) {
            const suggestion =
              this.currentSuggestions[this.selectedSuggestionIndex];
            this.searchInput.value = suggestion.text;
            this.updateSubmitButton(suggestion.text);
          }
          this.updateSuggestionSelection();
        }
        break;

      case "ArrowUp":
        if (suggestionsVisible) {
          e.preventDefault();
          this.selectedSuggestionIndex = Math.max(
            this.selectedSuggestionIndex - 1,
            -1
          );
          if (this.selectedSuggestionIndex >= 0) {
            const suggestion =
              this.currentSuggestions[this.selectedSuggestionIndex];
            this.searchInput.value = suggestion.text;
            this.updateSubmitButton(suggestion.text);
          } else {
            this.searchInput.value = "";
            this.updateSubmitButton("");
            this.userHasEditedQuery = false;
          }
          this.updateSuggestionSelection();
        }
        break;

      case "Escape":
        e.preventDefault();
        if (this.searchInput.value.trim()) {
          // Clear input and reset to quick prompts
          this.searchInput.value = "";
          this.updateSubmitButton("");
          this.userHasEditedQuery = false;
          this.selectedSuggestionIndex = -1;
          this.showQuickPrompts().catch(console.error);
        } else {
          // Hide suggestions if input is already empty
          this.hideSuggestions();
        }
        break;
    }
  }

  async updateTabStatus(tabInfo) {
    // Close any open tab context dropdown when switching tabs
    this.closeTabDropdown();

    // Hide any existing suggestions immediately to prevent showing stale prompts
    if (!this.userHasEditedQuery && !this.searchInput.value.trim()) {
      this.hideSuggestions();
    }

    // Store the latest tab info
    this.lastTabInfo = tabInfo;

    // Skip expensive operations for about:blank (happens during tab restore)
    const isAboutBlank = tabInfo.url === "about:blank";

    if (!isAboutBlank) {
      // Reset tab context to current tab when switching (handles chat persistence)
      this.resetContextToCurrentTab();

      // Update tab context UI with new current tab info
      this.updateTabContextUI();
    }

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

    // Note: Chat persistence is now handled by context-based system

    // Update quick prompts if user hasn't edited the query (skip for about:blank)
    if (
      !isAboutBlank &&
      !this.userHasEditedQuery &&
      !this.searchInput.value.trim()
    ) {
      this.showQuickPrompts().catch(console.error);
    }

    // Get page text and display in status
    if (pageTextEl) {
      try {
        // Wait a moment for page to load
        await new Promise(resolve => setTimeout(resolve, 1000));
        const selectedBrowser = topChromeWindow.gBrowser.selectedBrowser;
        const readableTextResult =
          await selectedBrowser.browsingContext.currentWindowContext
            .getActor("GenAI")
            .sendQuery("GetReadableText");
        const pageText = readableTextResult.selection || "";

        // Store page text for use in chat system prompt
        this.currentTabPageText = pageText;

        const preview =
          pageText.length > 30 ? pageText.substring(0, 30) + "…" : pageText;
        pageTextEl.textContent = pageText
          ? `${preview} (${pageText.length})`
          : "No text content";
      } catch (error) {
        console.error("Failed to get page text:", error);
        pageTextEl.textContent = "Unable to read page text";
      }
    }
  }

  handleSearch(query) {
    // Update submit button based on query
    this.updateSubmitButton(query);

    if (!query.trim()) {
      // Show quick prompts when input is empty (but not if chat mode is active)
      this.userHasEditedQuery = false;
      if (!(this.chatBot && this.chatBot.style.display === "block")) {
        this.showQuickPrompts().catch(console.error);
      }
      return;
    }

    // Mark that user has manually edited the query
    this.userHasEditedQuery = true;

    // Clear any existing debounce timer
    if (this.suggestionDebounceTimer) {
      clearTimeout(this.suggestionDebounceTimer);
    }

    // Debounce live suggestions
    this.suggestionDebounceTimer = setTimeout(() => {
      this.generateLiveSuggestions(query);
    }, 50);
  }

  async generateLiveSuggestions(query) {
    try {
      console.log(`User is searching for: ${query}`);

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
      console.log("Search results:", context.results);

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
        // First search result - create both search and chat variants
        const firstResult = searchResults[0];

        // Original as search type
        suggestions.push({
          text: firstResult.text,
          type: "search",
        });

        // Same text with "?" as chat type
        suggestions.push({
          text: firstResult.text + "?",
          type: "chat",
        });

        // Next 4 search results - run through detectQueryType to determine final type
        const remainingResults = searchResults.slice(1, 5);
        for (const result of remainingResults) {
          const detectedType = this.detectQueryType(result.text);
          suggestions.push({
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
        text: s.text,
        type: s.type,
      }));
      suggestions.push(...navigateSuggestions);

      // Add action results as-is
      const actionResults = urlbarSuggestions.filter(s => s.type === "action");
      const actionSuggestions = actionResults.slice(0, 2).map(s => ({
        text: s.text,
        type: s.type,
      }));
      suggestions.push(...actionSuggestions);

      // If we don't have enough suggestions, add some fallbacks
      if (suggestions.length < 4) {
        const queryType = this.detectQueryType(query);

        // Add the query itself if not already present
        if (!suggestions.some(s => s.text === query)) {
          suggestions.push({ text: query, type: queryType });
        }

        // Add query variants
        if (
          queryType === "search" &&
          !suggestions.some(s => s.text === query + "?")
        ) {
          suggestions.push({ text: query + "?", type: "chat" });
        }

        // Add some generic suggestions if still short
        if (suggestions.length < 6) {
          const fallbacks = [
            { text: "tab next", type: "action" },
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

      this.displaySuggestions(suggestions.slice(0, 10), "Suggestions:");
    } catch (error) {
      console.error("Error getting live suggestions:", error);

      // Fall back to simple suggestions on error
      const suggestions = [];
      const type = this.detectQueryType(query);

      suggestions.push(
        { text: query, type },
        {
          text: query + (type === "search" ? "?" : ""),
          type: type === "search" ? "chat" : "search",
        },
        { text: "tab next", type: "action" },
        { text: "github.com", type: "navigate" }
      );

      this.displaySuggestions(suggestions, "Suggestions:");
    }
  }

  handleEnter(query) {
    if (!query.trim()) {
      return;
    }

    const type = this.detectQueryType(query);

    // Hide suggestions after selection
    this.hideSuggestions();

    // Handle chat queries with chatbot component in both modes
    if (type === "chat") {
      // Show chat component and submit the prompt with tab context
      this.showChatMode();
      if (this.chatBot) {
        const contextTabs = this.getAllContextTabs();
        // Pass page text if current tab is in context
        const includePageText = this.isCurrentTabInContext();
        this.chatBot.submitPrompt(
          query,
          contextTabs,
          includePageText ? this.currentTabPageText : ""
        );
      }
      // For chat on smart window page (not sidebar), don't open sidebar
      // The sidebar logic is handled by performNavigation for search/navigate types
    } else if (type === "action") {
      if (this.isSidebarMode) {
        // Handle actions in sidebar
        this.handleAction(query);
      } else {
        // In full page mode, convert actions to search
        this.hideChatMode();
        this.performNavigation(query, type);
      }
    } else {
      // For navigate and search, hide chat mode and show regular messages
      this.hideChatMode();
      if (this.isSidebarMode) {
        this.addMessage(`Navigating: ${query}`, "user");
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

    // Clear input and reset state
    this.searchInput.value = "";
    this.updateSubmitButton("");
    this.userHasEditedQuery = false;
    this.showQuickPrompts().catch(console.error);
  }

  performNavigation(query, type) {
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

    topChromeWindow.gBrowser.selectedBrowser.fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }

  handleAction(action) {
    const actionLower = action.toLowerCase();

    // Hide chat mode for actions and show regular messages
    this.hideChatMode();

    if (actionLower.includes("tab next") || actionLower.includes("tab")) {
      // Handle tab switching action
      this.addMessage(`Action: ${action}`, "user");
      this.addMessage(
        "Tab switching is not available in sidebar mode.",
        "assistant"
      );
    } else if (actionLower.startsWith("find ")) {
      // Handle find action
      const searchTerm = action.slice(5).trim();
      this.addMessage(`Searching for: ${searchTerm}`, "user");
      this.addMessage(
        `Find functionality for "${searchTerm}" would be implemented here.`,
        "assistant"
      );
    } else {
      this.addMessage(`Action: ${action}`, "user");
      this.addMessage(`Action "${action}" is not yet supported.`, "assistant");
    }

    this.searchInput.value = "";
    this.updateSubmitButton("");
  }

  addMessage(text, sender) {
    const messageDiv = document.createElement("div");
    messageDiv.className = `message message-${sender}`;
    messageDiv.textContent = text;
    this.resultsContainer.appendChild(messageDiv);

    // Scroll to bottom
    this.resultsContainer.scrollTop = this.resultsContainer.scrollHeight;

    // Store message
    this.messages.push({ text, sender, timestamp: Date.now() });
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

  moveInputToBottom() {
    document
      .querySelector(".smart-window-container")
      ?.classList.add("chat-mode-bottom");
  }

  restoreInputPosition() {
    document
      .querySelector(".smart-window-container")
      ?.classList.remove("chat-mode-bottom");
  }

  showChatMode() {
    // Hide any existing messages in results container
    const existingMessages = this.resultsContainer.querySelectorAll(".message");
    existingMessages.forEach(msg => (msg.style.display = "none"));

    // Move input box to bottom for chat mode
    this.moveInputToBottom();

    // Show chat bot component
    if (this.chatBot) {
      this.chatBot.style.display = "block";
    }

    // Hide suggestions when chat mode is active
    this.hideSuggestions();
  }

  hideChatMode() {
    // Restore input box to original position
    this.restoreInputPosition();

    // Hide chat bot component
    if (this.chatBot) {
      this.chatBot.style.display = "none";
    }

    // Show any existing messages in results container
    const existingMessages = this.resultsContainer.querySelectorAll(".message");
    existingMessages.forEach(msg => (msg.style.display = "block"));

    // Show quick prompts again if input is empty and user hasn't edited query
    if (!this.userHasEditedQuery && !this.searchInput.value.trim()) {
      this.showQuickPrompts().catch(console.error);
    }
  }
}

new SmartWindowPage();
