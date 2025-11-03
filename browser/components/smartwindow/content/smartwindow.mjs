/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { detectQueryType, searchBrowserHistory } from "./utils.mjs";
import { attachToElement } from "chrome://browser/content/smartwindow/smartbar.mjs";
import {
  generateLiveSuggestions,
  generateConversationStarters,
  generateFollowupPrompts,
} from "./suggestions.mjs";
import { showChatHistoryOverlay } from "chrome://browser/content/smartwindow/chat-history.mjs";

const { ChatHistory, ChatHistoryConversation } = ChromeUtils.importESModule(
  "resource:///modules/smartwindow/ChatHistory.sys.mjs"
);

const { PageThumbs, PageThumbsStorage } = ChromeUtils.importESModule(
  "resource://gre/modules/PageThumbs.sys.mjs"
);
const { PageWireframes } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/PageWireframes.sys.mjs"
);
const { SessionStore } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/SessionStore.sys.mjs"
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
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
    this.currentPromptsType = "starters"; // Track whether showing "starters" or "followups"
    this.effectiveQueryType = "";

    this.selectedTabContexts = [];
    this.recentTabs = [];
    this.tabContextElements = {};
    this.currentTabPageText = "";
    this.quickActionButtons = {};

    this.#chatHistory = new ChatHistory();

    gBrowser.selectedTab.conversation = new ChatHistoryConversation({
      title: "",
      description: "",
      pageUrl: "",
      pageMeta: "",
    });

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

  async getEffectiveQueryType(query) {
    if (!query.trim()) {
      return "";
    }

    // If query contains @mention use type "chat"
    if (this.smartbar && this.smartbar.hasExistingMentions()) {
      return "chat";
    }

    // Check if we're in an active conversation
    const isFollowup = this.chatBot?.messages?.length > 0;

    // Use the ML detection (with followup context)
    return await detectQueryType(query, isFollowup);
  }

  // Generate conversation starters with caching
  async generateQuickPrompts(tabTitle = "") {
    let contextTabs = this.getAllContextTabs();

    // If no context tabs, use recent tabs (up to 5)
    if (contextTabs.length === 0) {
      await this.getRecentTabs();
      contextTabs = this.recentTabs
        .filter(tab => this.isTabEligibleForContext(tab))
        .slice(0, 5);
    }

    // Return empty array if no context
    if (contextTabs.length === 0) {
      return [];
    }

    // Use caching for conversation starters
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

  // Internal method to generate conversation starters
  async _generatePromptsInternal(contextTabs, tabTitle) {
    try {
      const suggestions = await generateConversationStarters(contextTabs, 6);
      if (suggestions && suggestions.length) {
        return suggestions;
      }
    } catch (error) {
      console.error("Failed to generate conversation starters:", error);
    }
    return [];
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
    // Current tab button - click removes current tab from context
    this.tabContextElements.currentTabButton.addEventListener("click", e => {
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
  }

  updateTabContextUI() {
    const els = this.tabContextElements;
    const active = this.lastTabInfo;

    if (this.isCurrentTabInContext()) {
      els.currentTabButton.style.display = "flex";

      if (active.favicon) {
        els.currentTabFavicon.src = active.favicon;
        els.currentTabFavicon.style.display = "block";
      } else {
        els.currentTabFavicon.style.display = "none";
      }

      if (els.currentTabTitle) {
        let title = active?.title || "Current tab";
        els.currentTabTitle.textContent = title;
        els.currentTabTitle.title = active?.url || "";
      }
    } else {
      els.currentTabButton.style.display = "none";
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
  }

  // Save chat messages to all tabs in current context
  async saveChatMessagesForCurrentContext() {
    // Consolidate the conversation references to the one per tab and trigger re-render
    if (
      this.chatBot.conversation.id !== gBrowser.selectedTab?.conversation?.id &&
      gBrowser.selectedTab?.conversation?.messages?.length
    ) {
      this.chatBot.conversation = gBrowser.selectedTab.conversation;
      this.chatBot.requestUpdate();
    }

    if (
      this.chatBot &&
      this.chatBot.messages &&
      this.chatBot.messages.length &&
      gBrowser.selectedTab?.conversation
    ) {
      // Update the shared conversation title from chatBot
      gBrowser.selectedTab.conversation.title =
        this.chatBot.conversationTitle || "";

      if (
        this.selectedTabContexts.length === 0 &&
        gBrowser.selectedTab?.conversation?.messages?.length
      ) {
        // No tab context (e.g., full page experience on new tab)
        // Save to the current conversation with empty/current URL
        try {
          await this.#chatHistory.updateConversation(
            gBrowser.selectedTab.conversation
          );
        } catch (error) {
          console.error(
            "Error saving the conversation:",
            gBrowser.selectedTab.conversation
          );
        }
      } else {
        gBrowser.tabs.forEach(async tab => {
          if (!tab.conversation || !tab?.conversation?.messages?.length) {
            return;
          }

          try {
            await this.#chatHistory.updateConversation(tab.conversation);
          } catch (error) {
            console.error("Error saving a conversation:", tab.conversation);
            console.error(" error: ", error.toString());
          }
        });
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

    // Skip loading a conversation if there is already one going on
    if (gBrowser.selectedTab.conversation.messages.length) {
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
      this.chatBot.conversationTitle = conversation?.title || "";
      this.chatBot.requestUpdate();
      this.showChatMode();
      // Scroll to bottom after messages are loaded
      setTimeout(() => this.chatBot.scrollToBottom(), 0);
    }

    // Replace an empty conversation with the conversation that was loaded from SQLite
    if (conversation && conversation.messages.length) {
      gBrowser.selectedTab.conversation = conversation;
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
      onUpdate: ({ text, isAutofilled }) =>
        this.handleOnUpdate({ text, isAutofilled }),
      onSuggestionSelect: suggestion =>
        this.handleEnter(suggestion.text, suggestion.type),
      getQueryTypeIcon: type => this.getQueryTypeIcon(type),
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

  async setupSubmitButton() {
    // Find the combined button select component
    await customElements.whenDefined("combined-button-select");
    this.submitButton = document.getElementById("combined-button-select");

    this.submitButton.addEventListener("submit", () => {
      const text = this.smartbar ? this.smartbar.getText() : "";
      if (text.trim()) {
        this.handleEnter(text, this.effectiveQueryType);
      } else if (this.smartbar) {
        // If empty, focus the editor
        this.smartbar.focus();
      }
    });

    this.submitButton.addEventListener("selection-change", e => {
      const { value: forcedQueryType } = e.detail;
      this.effectiveQueryType = forcedQueryType;
      this.submitButton.handleSubmit();
    });

    // Setup model picker (keep existing code)
    this.modelPicker = document.getElementById("model-picker");
    if (this.modelPicker) {
      this.modelPicker.value = Services.prefs.getStringPref(
        "browser.smartwindow.model"
      );
      this.modelPicker.addEventListener("change", () => {
        Services.prefs.setStringPref(
          "browser.smartwindow.model",
          this.modelPicker.value
        );
      });
    }

    // Setup insights toggle
    this.toggleInsights = document.getElementById("toggle-insights");
    if (this.toggleInsights) {
      const PREF = "browser.smartwindow.useInsights";
      this.toggleInsights.checked = Services.prefs.getBoolPref(PREF, true);
      // persist when changed
      this.toggleInsights.addEventListener("change", e => {
        Services.prefs.setBoolPref(PREF, e.target.checked);
      });
    }
  }

  async showQuickPrompts() {
    if (!this.quickPromptsContainer) {
      return;
    }

    // Don't overwrite followup prompts with conversation starters
    if (this.currentPromptsType === "followups") {
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

    this.displayQuickPrompts(prompts, "starters");
    this.userHasEditedQuery = false;
  }

  displayQuickPrompts(prompts, type = "starters") {
    if (!this.quickPromptsContainer) {
      return;
    }

    // Store the type of prompts being displayed
    this.currentPromptsType = type;

    // Show container
    this.quickPromptsContainer.classList.remove("hidden");

    // Clear existing prompts
    this.quickPromptsContainer.innerHTML = "";

    // Add emoji mapping for prompt types
    const getEmoji = emojiType => {
      switch (emojiType) {
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

    if (this.chatBot) {
      this.chatBot.requestUpdate();
    }
  }

  hideQuickPrompts() {
    if (this.quickPromptsContainer) {
      this.quickPromptsContainer.classList.add("hidden");
    }
  }

  async #populateHistoryPreviews(historyItems) {
    if (!Array.isArray(historyItems) || historyItems.length === 0) {
      return historyItems ?? [];
    }

    const enhancedItems = [];
    for (const rawItem of historyItems) {
      if (!rawItem) {
        enhancedItems.push(rawItem);
        continue;
      }

      const item = { ...rawItem };

      if (item.thumbnail && !item.previewType) {
        item.previewType = "thumbnail";
      }

      if (!item.thumbnail && item.url) {
        try {
          if (await PageThumbsStorage.fileExistsForURL(item.url)) {
            item.thumbnail = PageThumbs.getThumbnailURL(item.url);
            item.previewType = "thumbnail";
          }
        } catch (error) {
          console.warn(
            "[SmartWindow] Unable to fetch thumbnail for history item:",
            item.url,
            error
          );
        }
      }

      enhancedItems.push(item);
    }

    const itemsNeedingWireframes = enhancedItems.filter(
      item => item && !item.thumbnail && item.url
    );

    if (!itemsNeedingWireframes.length) {
      return enhancedItems;
    }

    try {
      const wireframeMap = await this.#buildWireframePreviewMap();
      for (const item of itemsNeedingWireframes) {
        const wireframeDataUrl = wireframeMap.get(item.url);
        if (wireframeDataUrl) {
          item.thumbnail = wireframeDataUrl;
          item.previewType = "wireframe";
        }
      }
    } catch (error) {
      console.error(
        "[SmartWindow] Failed to build wireframe previews:",
        error
      );
    }

    return enhancedItems;
  }

  async #buildWireframePreviewMap() {
    if (!Services.appinfo?.fissionAutostart) {
      return new Map();
    }

    const chromeWindow = window.browsingContext?.topChromeWindow;
    if (!chromeWindow) {
      return new Map();
    }

    const previewMap = new Map();
    const doc = chromeWindow.document;
    const serializer = new chromeWindow.XMLSerializer();

    const collectEntries = entries => {
      if (!Array.isArray(entries)) {
        return;
      }

      for (const entry of entries) {
        const url = entry?.url;
        const wireframe = entry?.wireframe;
        if (!url || !wireframe || previewMap.has(url)) {
          continue;
        }

        try {
          const svgElement = PageWireframes.getWireframeElement(
            wireframe,
            doc
          );
          if (!svgElement) {
            continue;
          }
          const serialized = serializer.serializeToString(svgElement);
          const dataUrl =
            "data:image/svg+xml;charset=utf-8," +
            encodeURIComponent(serialized);
          previewMap.set(url, dataUrl);
        } catch (error) {
          console.warn(
            "[SmartWindow] Unable to serialize wireframe for history item:",
            url,
            error
          );
        }
      }
    };

    const gatherFromTab = async tab => {
      try {
        if (TabStateFlusher?.flush) {
          await TabStateFlusher.flush(tab.linkedBrowser);
        }
      } catch (error) {
        console.warn(
          "[SmartWindow] Unable to flush tab state for wireframe capture:",
          error
        );
      }

      try {
        const stateString = SessionStore.getTabState(tab);
        if (!stateString) {
          return;
        }
        const state = JSON.parse(stateString);
        collectEntries(state?.entries);
      } catch (error) {
        console.warn(
          "[SmartWindow] Unable to read tab state for wireframe capture:",
          error
        );
      }
    };

    const chromeBrowser = chromeWindow.gBrowser;
    if (chromeBrowser?.tabs?.length) {
      for (const tab of chromeBrowser.tabs) {
        await gatherFromTab(tab);
      }
    }

    try {
      const closedTabs = SessionStore.getClosedTabData({
        sourceWindow: chromeWindow,
      });
      for (const tabData of closedTabs ?? []) {
        let stateEntries = tabData?.state?.entries;
        if (!stateEntries && typeof tabData?.state === "string") {
          try {
            const parsedState = JSON.parse(tabData.state);
            stateEntries = parsedState?.entries;
          } catch (error) {
            console.warn(
              "[SmartWindow] Unable to parse closed tab state for wireframes:",
              error
            );
          }
        }
        collectEntries(stateEntries);
      }
    } catch (error) {
      console.warn(
        "[SmartWindow] Unable to inspect closed tabs for wireframes:",
        error
      );
    }

    return previewMap;
  }

  async handleSearchHistoryTool(historyItems) {
    console.log(
      "[SmartWindow] handleSearchHistoryTool - historyItems",
      historyItems,
      "Type:",
      typeof historyItems,
      "IsArray:",
      Array.isArray(historyItems)
    );

    // Ensure historyItems is an array
    const items = Array.isArray(historyItems) ? historyItems : [];

    if (items.length === 0) {
      console.log("[SmartWindow] No history items to display");
      return;
    }

    const itemsWithPreviews = await this.#populateHistoryPreviews(items);

    const topWindow = window.browsingContext?.topChromeWindow;
    if (topWindow?.SmartWindow) {
      // this.showViewTab("history");
      // Call the method on the chrome window's SmartWindow object
      topWindow.SmartWindow.showPageHistory(itemsWithPreviews);
    } else {
      console.error("[SmartWindow] SmartWindow not available");
    }
  }

  /**
   * Handle prompt submitted from GenAI (text selection shortcuts, context menus, etc.)
   *
   * @param {object} data - Contains promptText, tabContext, pageText
   */
  async handleGenAIPrompt(data) {
    const { promptText, tabContext, pageText } = data;

    console.log("[SmartWindow] Received GenAI prompt:", {
      promptText: promptText?.substring(0, 100) + "...",
      tabContext,
      hasPageText: !!pageText,
    });

    if (!this.chatBot) {
      console.error("[SmartWindow] chatBot not available");
      return;
    }

    try {
      // Get or create conversation for current tab
      if (!gBrowser.selectedTab.conversation) {
        gBrowser.selectedTab.conversation = new ChatHistoryConversation({
          title: "",
          description: "",
          pageUrl: tabContext[0]?.url || "",
          pageMeta: "",
        });
      }

      // Update tab context UI with the received tab info
      if (tabContext && tabContext.length) {
        this.selectedTabContexts = tabContext;
        this.updateTabContextUI();
      }

      // Store page text if provided
      if (pageText) {
        this.currentTabPageText = pageText;
      }

      // Submit the pre-built prompt to chatBot
      await this.chatBot.submitPrompt(
        gBrowser.selectedTab.conversation,
        { text: promptText },
        tabContext,
        pageText
      );

      // Show chat mode
      this.showChatMode();

      // Save to ChatHistory
      await this.saveChatMessagesForCurrentContext();

      console.log("[SmartWindow] GenAI prompt submitted successfully");
    } catch (error) {
      console.error("[SmartWindow] Failed to handle GenAI prompt:", error);
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
      window.addEventListener("SmartWindowMessage", async e => {
        if (e.detail.type === "TabUpdate") {
          this.updateTabStatus(e.detail.data);
        } else if (e.detail.type === "SubmitPrompt") {
          await this.handleGenAIPrompt(e.detail.data);
        }
      });
    }

    if (this.chatBot) {
      this.chatBot.addEventListener("search-suggested", e => {
        const query = e.detail.query;
        const engineName = e.detail.engineName;
        const clickEvent = e.detail.clickEvent;
        this.performNavigation(query, "search", clickEvent, engineName);
      });

      this.chatBot.addEventListener("tool-call", async e => {
        console.log("[SmartWindow] Tool call event:", e.detail);
        // Update the chat bot's internal log state
        if (this.chatBot.updateLogState) {
          this.chatBot.updateLogState(e.detail);
        }

        // Handle tool call responses
        switch (e.detail.tool) {
          case "search_history":
            try {
              // FIXME: Sanitize JSON
              const parsedData = JSON.parse(e.detail.result);
              await this.handleSearchHistoryTool(parsedData?.results);
            } catch (error) {
              console.error("[SmartWindow] Failed to parse tool data", error);
            }
            break;
          // Do nothing
          default:
            break;
        }
      });

      this.chatBot.addEventListener("title-updated", e => {
        console.log("[SmartWindow] Title updated:", e.detail.title);
        // Save the conversation to ChatHistory when title is edited
        this.saveChatMessagesForCurrentContext();
      });

      this.chatBot.addEventListener("show-page-history", async () => {
        console.log("[SmartWindow] History button clicked");
        try {
          const rawHistory = await searchBrowserHistory({
            search_term: "",
            limit: 12,
          });
          const parsedHistory = JSON.parse(rawHistory);
          await this.handleSearchHistoryTool(parsedHistory?.results);
        } catch (error) {
          console.error(
            "[SmartWindow] Failed to fetch history for overlay",
            error
          );
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
          // Show quick prompts if input is empty
          if (!text.trim()) {
            this.showQuickPrompts().catch(console.error);
          }
        }
      });
    }

    window.addEventListener("SmartWindowVisibilityChanged", event => {
      if (event.detail.visible) {
        this.chatBot.requestUpdate();
      }
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
              if (gBrowser.selectedTab.conversation) {
                gBrowser.selectedTab.conversation.pageUrl = newLocation;
              } else {
                gBrowser.selectedTab.conversation = new ChatHistoryConversation(
                  {
                    title: "",
                    description: "",
                    pageUrl: newLocation,
                    pageMeta: "",
                  }
                );
              }

              this.chatBot.requestUpdate();
              this.initializeTabInfo();
            }
          }
        },
      };

      gBrowser.addTabsProgressListener(tabListener);

      gBrowser.tabContainer.addEventListener("TabSelect", () => {
        this.chatBot.requestUpdate();
      });

      gBrowser.tabContainer.addEventListener("TabOpen", () => {
        this.chatBot.requestUpdate();
      });

      gBrowser.tabContainer.addEventListener("TabAttrModified", event => {
        if (event.target === gBrowser.selectedTab) {
          // This small delay fixes the sidebar to render the correct conversation
          // when switching between tabs. Without the delay, the tab will render the
          // conversation from the previously selected tab even though the chatBot
          // ends up with the correct conversation object after the switch is complete.
          setTimeout(() => {
            if (gBrowser.selectedTab?.conversation) {
              this.chatBot.conversation = gBrowser.selectedTab.conversation;
              this.chatBot.requestUpdate();
            }
          }, 50);
        }
      });
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

  async handleOnUpdate({ text: query, isAutofilled }) {
    // Update submit button based on query
    this.effectiveQueryType = await this.getEffectiveQueryType(query);
    this.submitButton.selectedValue = this.effectiveQueryType;

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

    // Don’t show suggestions mid-conversation
    if (this.chatBot?.messages?.length > 0) {
      return;
    }

    // Prevent re-generation of suggestions when the query update was triggered by autofill
    if (isAutofilled) {
      return;
    }

    // Debounce live suggestions
    this.suggestionDebounceTimer = setTimeout(() => {
      this.generateLiveSuggestions(query);
    }, 50);
  }

  async generateLiveSuggestions(query) {
    const { suggestions, autofillData } = await generateLiveSuggestions(
      query,
      topChromeWindow
    );
    if (this.smartbar) {
      this.smartbar.showSuggestions(suggestions, "Suggestions:", false, query);

      // Apply autofill if available
      if (autofillData) {
        this.smartbar.setAutofill(autofillData);
      }
    }
  }

  async handleEnter(query, suggestionType = null) {
    if (!query.trim()) {
      return;
    }

    const textFromBar = this.smartbar?.getText?.() || "";
    const htmlFromBar = this.smartbar?.getHTML?.() || null;

    document.documentElement.setAttribute("haschat", "true");

    const type = suggestionType || (await this.getEffectiveQueryType(query));

    // Hide suggestions after selection
    if (this.smartbar) {
      this.smartbar.clear();
      this.smartbar.hideSuggestions();
    }

    // Handle chat queries with chatbot component in different modes
    if (type === "chat") {
      // Show chat component and submit the prompt with tab context
      this.showChatMode();

      // Make sure the tab info is updated
      if (gBrowser.selectedTab.conversation.pageUrl === "") {
        await this.initializeTabInfo();
      }

      if (this.chatBot) {
        const contextTabs = this.getAllContextTabs();
        // Pass page text if current tab is in context
        const includePageText = this.isCurrentTabInContext();

        const text = textFromBar || (typeof query === "string" ? query : "");
        const html = htmlFromBar;

        await this.chatBot.submitPrompt(
          gBrowser.selectedTab.conversation,
          { text, html },
          contextTabs,
          includePageText ? this.currentTabPageText : ""
        );

        await this.saveChatMessagesForCurrentContext();

        // Generate followup prompts after assistant responds
        if (!this.smartbar?.getText()?.trim()) {
          try {
            // Use conversation title instead of tab when on the full page chat
            let contextForPrompts;
            const isSmartWindowPage = this.lastTabInfo?.url?.includes(
              "chrome://browser/content/smartwindow/smartwindow.html"
            );

            if (isSmartWindowPage) {
              // Use conversation title for context
              const title =
                this.chatBot?.conversationTitle ||
                gBrowser.selectedTab.conversation?.title ||
                "Chat";
              contextForPrompts = {
                title,
                url: "conversation",
              };
            } else {
              // Use actual tab context
              contextForPrompts =
                this.lastTabInfo || this.getAllContextTabs()[0];
            }

            const followups = await generateFollowupPrompts(
              gBrowser.selectedTab.conversation.messages,
              contextForPrompts,
              6
            );
            if (followups?.length) {
              this.displayQuickPrompts(followups, "followups");
            }
          } catch (error) {
            console.error("Failed to generate followup prompts:", error);
          }
        }
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

    // Reset state
    this.userHasEditedQuery = false;
  }

  async performNavigation(query, type, clickEvent = null, engineName = null) {
    // Save chat messages for current tab before navigating
    if (this.chatBot && this.chatBot.messages && this.chatBot.messages.length) {
      // topChromeWindow.SmartWindow.setChatMessages(
      //   topChromeWindow.gBrowser.selectedTab.linkedPanel,
      //   this.chatBot.messages
      // );
      this.#chatHistory.updateConversation(gBrowser.selectedTab.conversation);
    }

    let url = query;

    if (type === "navigate") {
      // Handle domain/URL navigation
      if (!query.includes("://")) {
        url = query.startsWith("about:") ? query : "https://" + query;
      }
    } else if (type === "search") {
      // Handle search queries with specified engine or default
      if (engineName) {
        try {
          const engine = await Services.search.getEngineByName(engineName);
          if (engine) {
            const submission = engine.getSubmission(query);
            url = submission.uri.spec;
          } else {
            // Fallback to default if engine not found
            url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          }
        } catch (error) {
          console.error(`Failed to get search engine ${engineName}:`, error);
          url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        }
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      }
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

    // Reset prompt type to allow showing conversation starters again
    this.currentPromptsType = "starters";

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

  async loadConversationFromHistory(conversation) {
    if (!this.chatBot || !conversation) {
      return;
    }

    try {
      // Save current chat messages before loading new conversation
      await this.saveChatMessagesForCurrentContext();

      // Load the selected conversation
      gBrowser.selectedTab.conversation = conversation;

      // Update chatBot with conversation messages
      this.chatBot.messages = [...conversation.messages];
      this.chatBot.conversationTitle = conversation.title || "";
      this.chatBot.requestUpdate();

      // Show chat mode
      this.showChatMode();

      // Scroll to bottom after messages are loaded
      setTimeout(() => this.chatBot.scrollToBottom(), 0);

      console.log(
        `[SmartWindow] Loaded conversation from history: ${conversation.id}`
      );
    } catch (error) {
      console.error(
        "[SmartWindow] Failed to load conversation from history:",
        error
      );
    }
  }

  showViewTab(tabId) {
    const viewHandler = topChromeWindow?.FirefoxViewHandler;
    if (viewHandler) {
      viewHandler.openTab(tabId);
    } else {
      console.warn("[SmartWindow] FirefoxViewHandler is not available.");
    }
  }

  setupQuickActionEventListeners() {
    this.quickActionButtons.history?.addEventListener("click", e => {
      e.stopPropagation();
      this.showViewTab("history");
    });

    this.quickActionButtons.insights?.addEventListener("click", e => {
      e.stopPropagation();

      if (this.chatBot) {
        this.chatBot.handleInsightClick();
      }
    });

    this.quickActionButtons.chats?.addEventListener("click", e => {
      e.stopPropagation();

      showChatHistoryOverlay(conversation => {
        this.loadConversationFromHistory(conversation);
      });
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
      chats: document.getElementById("chats-button"),
      developer: document.getElementById("developer-button"),
    };

    this.setupQuickActionEventListeners();
  }
}

new SmartWindowPage();
