/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

class SmartWindowPage {
  constructor() {
    this.searchInput = null;
    this.resultsContainer = null;
    this.isSidebarMode = false;
    this.messages = [];
    this.init();
  }

  init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.onDOMReady());
    } else {
      this.onDOMReady();
    }
  }

  onDOMReady() {
    // Check if we're in sidebar mode by looking for sidebar=true in URL
    const urlParams = new URLSearchParams(window.location.search);
    this.isSidebarMode = urlParams.get("sidebar") === "true";

    this.searchInput = document.getElementById("search-input");
    this.resultsContainer = document.getElementById("results-container");

    // Auto-focus the search input
    if (this.searchInput) {
      this.searchInput.focus();
    }

    // If in sidebar mode, update UI and behavior
    if (this.isSidebarMode) {
      document.body.classList.add("sidebar-mode");
      this.searchInput.placeholder = "Type a message...";
      this.setupSidebarUI();
    }

    this.setupEventListeners();
    console.log(
      `Smart Window page initialized (sidebar mode: ${this.isSidebarMode})`
    );
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

  setupEventListeners() {
    this.searchInput.addEventListener("input", e => {
      this.handleSearch(e.target.value);
    });

    this.searchInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        this.handleEnter(e.target.value);
      }
    });

    // Listen for messages from the actor
    if (this.isSidebarMode) {
      window.addEventListener("SmartWindowMessage", e => {
        if (e.detail.type === "TabUpdate") {
          this.updateTabStatus(e.detail.data);
        }
      });
    }
  }

  updateTabStatus(tabInfo) {
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
  }

  handleSearch(query) {
    if (!query) {
      this.clearResults();
      return;
    }

    // Clear results when typing - no search suggestions
    this.clearResults();
  }

  handleEnter(query) {
    if (!query) {
      return;
    }

    if (this.isSidebarMode) {
      // In sidebar mode, add message to chat UI instead of navigating
      this.addMessage(query, "user");
      this.searchInput.value = "";

      // Send message to parent window or handle as needed
      // For now, just echo back with a response
      setTimeout(() => {
        this.addMessage(`You said: "${query}"`, "assistant");
      }, 500);
    } else {
      // Normal navigation behavior - notify parent to handle special navigation
      let url = query;

      if (!query.includes("://")) {
        if (query.includes(".") && !query.includes(" ")) {
          url = "https://" + query;
        } else {
          url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        }
      }

      // Send message to parent actor to handle navigation
      window.windowGlobalChild
        .getActor("SmartWindow")
        .sendAsyncMessage("SmartWindow:Navigate", { url, query });
    }
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
}

new SmartWindowPage();
