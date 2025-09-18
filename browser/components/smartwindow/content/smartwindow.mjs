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

    // Chat detection: starts with question words OR ends with question mark
    if (
      /^(who|what|when|where|why|how)\s/.test(trimmedQuery) ||
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

  // Simple suggestion generation (simplified version of extension's complex system)
  generateQuickPrompts(tabTitle = "", tabUrl = "") {
    const suggestions = [];
    const titleWords = tabTitle
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

    // 1 current domain if available
    if (tabUrl) {
      const domain = tabUrl
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0];
      if (domain && domain !== "about:blank") {
        suggestions.push({ text: domain, type: "navigate" });
      }
    }

    // 1 action
    suggestions.push({ text: "tab next", type: "action" });

    return suggestions;
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
    if (this.searchInput) {
      // Only focus if in Smart Mode
      if (isSmartMode) {
        this.searchInput.focus();
      }

      // Update placeholder and state based on mode
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

    // Initialize tab info and show quick prompts (only if Smart Mode is active)
    this.initializeTabInfo();
    if (isSmartMode) {
      this.showQuickPrompts();
    }

    console.log(
      `Smart Window page initialized (sidebar mode: ${this.isSidebarMode}, smart mode: ${isSmartMode})`
    );
  }

  initializeTabInfo() {
    // Initialize with current tab data
    const selectedTab = topChromeWindow.gBrowser.selectedTab;
    const selectedBrowser = topChromeWindow.gBrowser.selectedBrowser;

    this.lastTabInfo = {
      title: selectedTab.label || "Untitled",
      url: selectedBrowser.currentURI.spec || "",
      favicon: selectedTab.image || "",
    };

    // Update status bar if in sidebar mode
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

    // Initially hidden
    this.suggestionsContainer.style.display = "none";
  }

  setupSubmitButton() {
    // Find or create submit button
    this.submitButton =
      document.querySelector(".search-button") ||
      document.querySelector("button[type='submit']");

    if (!this.submitButton) {
      // Create submit button if it doesn't exist
      this.submitButton = document.createElement("button");
      this.submitButton.className = "search-button submit-button";
      this.submitButton.type = "button";

      // Add to search box
      const searchBox = document.querySelector(".search-box");
      searchBox.appendChild(this.submitButton);
    }

    // Set initial state
    this.updateSubmitButton("");

    // Add click handler
    this.submitButton.addEventListener("click", () => {
      this.handleEnter(this.searchInput.value);
    });
  }

  updateSubmitButton(query) {
    if (!this.submitButton) {
      return;
    }

    const type = query ? this.detectQueryType(query) : "search";
    const icon = this.getQueryTypeIcon(type);
    const label = this.getQueryTypeLabel(type);

    this.submitButton.innerHTML = `${icon} ${label}`;
    this.submitButton.disabled = !query.trim();
  }

  showQuickPrompts() {
    // Use stored tab info for context
    const tabTitle = this.lastTabInfo?.title || "";
    const tabUrl = this.lastTabInfo?.url || "";

    const prompts = this.generateQuickPrompts(tabTitle, tabUrl);
    this.displaySuggestions(prompts, "Quick Prompts:");
    this.userHasEditedQuery = false;
  }

  displaySuggestions(suggestions, title = "Suggestions:") {
    if (!this.suggestionsContainer) {
      return;
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

    // Show container
    this.suggestionsContainer.style.display = "block";
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
      this.suggestionsContainer.style.display = "none";
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
            this.showQuickPrompts();
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
          this.showQuickPrompts();
        } else {
          // Hide suggestions if input is already empty
          this.hideSuggestions();
        }
        break;
    }
  }

  updateTabStatus(tabInfo) {
    // Store the latest tab info
    this.lastTabInfo = tabInfo;

    const titleEl = document.getElementById("status-title");
    const urlEl = document.getElementById("status-url");
    const faviconEl = document.getElementById("status-favicon");

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

    // Update quick prompts if user hasn't edited the query
    if (!this.userHasEditedQuery && !this.searchInput.value.trim()) {
      this.showQuickPrompts();
    }
  }

  handleSearch(query) {
    // Update submit button based on query
    this.updateSubmitButton(query);

    if (!query.trim()) {
      // Show quick prompts when input is empty
      this.userHasEditedQuery = false;
      this.showQuickPrompts();
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

    if (this.isSidebarMode) {
      // In sidebar mode, handle different query types appropriately
      if (type === "chat") {
        // Show chat component and submit the prompt
        this.showChatMode();
        if (this.chatBot) {
          this.chatBot.submitPrompt(query);
        }
      } else if (type === "action") {
        // Handle actions in sidebar
        this.handleAction(query);
      } else {
        // For navigate and search, hide chat mode and show regular messages
        this.hideChatMode();
        this.addMessage(`Navigating: ${query}`, "user");
        this.performNavigation(query, type);
      }
    } else {
      // In full page mode, handle navigation directly
      this.performNavigation(query, type);
    }

    // Clear input and reset state
    this.searchInput.value = "";
    this.updateSubmitButton("");
    this.userHasEditedQuery = false;
    this.showQuickPrompts();
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

  showChatMode() {
    // Hide any existing messages in results container
    const existingMessages = this.resultsContainer.querySelectorAll(".message");
    existingMessages.forEach(msg => (msg.style.display = "none"));

    // Show chat bot component
    if (this.chatBot) {
      this.chatBot.style.display = "block";
    }
  }

  hideChatMode() {
    // Hide chat bot component
    if (this.chatBot) {
      this.chatBot.style.display = "none";
    }

    // Show any existing messages in results container
    const existingMessages = this.resultsContainer.querySelectorAll(".message");
    existingMessages.forEach(msg => (msg.style.display = "block"));
  }
}

new SmartWindowPage();
