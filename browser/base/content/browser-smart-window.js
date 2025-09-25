/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var SmartWindow = {
  _initialized: false,
  _viewInitialized: false,
  _sidebarVisible: false,
  _tabAttrObserver: null,

  // Shared prompt cache across all smart window instances
  _promptsCache: new Map(),
  _promptsCacheExpiry: 5 * 60 * 1000, // 5 minutes cache

  // Chat message storage by tab ID (no expiration)
  _chatMessagesByTab: new Map(),

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;

    if (!gSmartWindowEnabled) {
      console.log("[Smart Window] Feature disabled by pref");
      return;
    }

    this.initToggleButton();
    this.initCloseButton();
    this.setupTabAttrObserver();

    console.log(
      "[Smart Window]",
      this.isSmartWindowActive() ? "Smart" : "Classic",
      "window initialized"
    );
  },

  _ensureViewInitialized() {
    let view = PanelMultiView.getViewNode(document, "smart-window-toggle-view");
    document.l10n.setAttributes(
      view.querySelector(".toggle-status-label"),
      this.isSmartWindowActive()
        ? "smart-window-toggleview-status-label-active"
        : "smart-window-toggleview-status-label-inactive"
    );
    view.querySelector("#smart-window-switch-classic").hidden =
      !this.isSmartWindowActive();
    view.querySelector("#smart-window-switch-smart").hidden =
      this.isSmartWindowActive();

    if (this._viewInitialized) {
      return;
    }
    view.addEventListener("command", event => {
      switch (event.target.id) {
        case "smart-window-switch-classic":
        // fall through
        case "smart-window-switch-smart":
          this.toggleSmartWindow();
          break;
        case "smart-window-open-private":
          OpenBrowserWindow({ private: true });
          break;
      }
    });
    this._viewInitialized = true;
  },

  initToggleButton() {
    const toggleButton = document.getElementById("smart-window-toggle");
    const navToggleButton = document.getElementById("smart-window-button");

    if (toggleButton) {
      // Show the button only if the feature is enabled
      if (gSmartWindowEnabled) {
        toggleButton.hidden = false;

        // Add click event listener to the toggle button
        toggleButton.addEventListener("command", event => {
          this._ensureViewInitialized();
          PanelUI.showSubView("smart-window-toggle-view", event.target, event);
        });
      }
    }

    // Initialize the nav bar toggle button (assistant button)
    if (navToggleButton) {
      navToggleButton.addEventListener("command", () => {
        // Just toggle sidebar visibility, not smart window mode
        this.toggleSidebar();
      });
    }
  },

  initCloseButton() {
    const closeButton = document.getElementById("smartwindow-close");

    if (closeButton) {
      closeButton.addEventListener("command", () => {
        // Just hide the sidebar, don't exit smart window mode
        this.hideSidebar();
      });
    }
  },

  toggleSmartWindow(skipSave = false) {
    console.log(
      `[Smart Window] toggleSmartWindow called, current state: ${this.isSmartWindowActive()}, skipSave: ${skipSave}`
    );

    const root = document.documentElement;

    // Remove any preloaded new tab page browser when switching modes
    // This ensures the next new tab will use the correct type
    if (typeof NewTabPagePreloading !== "undefined") {
      NewTabPagePreloading.removePreloadedBrowser(window);
    }

    // Toggle internal state.
    root.toggleAttribute("smart-window");
    if (this.isSmartWindowActive()) {
      // Check if we're on a smart window page
      const currentURI = gBrowser.selectedBrowser?.currentURI?.spec || "";
      const isSmartWindowPage = currentURI.includes(
        "smartwindow/smartwindow.html"
      );

      // Only show sidebar if NOT on a smart window page
      if (!isSmartWindowPage) {
        this.showSidebar();
      } else {
        // Hide sidebar when on smart window page
        this.hideSidebar();
      }

      // Navigate all new tab pages to the smart window URL
      this.navigateNewTabsToSmartWindow();
    } else {
      // Hide the sidebar
      this.hideSidebar();
    }

    // Update bookmarks toolbar visibility based on user preference
    updateBookmarkToolbarVisibility();

    // Update the hamburger menu item location.
    this.updateHamburgerMenu();

    // Dispatch event that smart window pages can listen to
    window.dispatchEvent(
      new CustomEvent("SmartWindowModeChanged", {
        detail: { active: this.isSmartWindowActive() },
      })
    );

    console.log(
      "Smart Window mode",
      this.isSmartWindowActive() ? "activated" : "deactivated"
    );
  },

  showSidebar() {
    this._sidebarVisible = true;
    this._updateSidebarState();
  },

  hideSidebar() {
    this._sidebarVisible = false;
    this._updateSidebarState();
  },

  _updateSidebarState() {
    const smartWindowBox = document.getElementById("smartwindow-box");
    const smartWindowSplitter = document.getElementById("smartwindow-splitter");
    const navToggleButton = document.getElementById("smart-window-button");

    if (smartWindowBox) {
      smartWindowBox.hidden = !this._sidebarVisible;
      if (!this._sidebarVisible) {
        smartWindowBox.style.width = "358px";
      }
    }
    if (smartWindowSplitter) {
      smartWindowSplitter.hidden = !this._sidebarVisible;
    }

    navToggleButton?.toggleAttribute("checked", this._sidebarVisible);
    document.documentElement.toggleAttribute(
      "smart-window-sidebar",
      this._sidebarVisible
    );

    console.log(
      "Smart Window sidebar",
      this._sidebarVisible ? "shown" : "hidden"
    );

    // Focus smartbar when sidebar becomes visible
    if (this._sidebarVisible) {
      this._focusSidebarSmartbar();
    }
  },

  toggleSidebar() {
    this._sidebarVisible = !this._sidebarVisible;
    this._updateSidebarState();
  },

  _focusSidebarSmartbar() {
    const smartWindowBrowser = document.getElementById("smartwindow-browser");
    if (smartWindowBrowser) {
      const actor =
        smartWindowBrowser.browsingContext?.currentWindowGlobal?.getActor(
          "SmartWindow"
        );
      if (actor) {
        actor.sendAsyncMessage("SmartWindow:FocusSmartbar");
      }
    }
  },

  updateHamburgerMenu() {
    let item = PanelUI.menuButton.parentElement;
    let toolbar = this.isSmartWindowActive()
      ? document.getElementById("TabsToolbar")
      : document.getElementById("nav-bar");
    let titlebarItems = toolbar.querySelector(".titlebar-buttonbox-container");
    titlebarItems.before(item);
  },

  navigateNewTabsToSmartWindow() {
    console.log("[Smart Window] Navigating new tabs to smart window URL");

    // Iterate through all tabs
    for (let tab of gBrowser.tabs) {
      if (tab.linkedBrowser && tab.linkedBrowser.currentURI) {
        const uri = tab.linkedBrowser.currentURI.spec;

        // Check for new tab pages (about:newtab or about:home)
        if (uri === "about:newtab" || uri === "about:home") {
          console.log(
            `[Smart Window] Converting tab from ${uri} to chrome://browser/content/smartwindow/smartwindow.html`
          );

          // Navigate to the smart window chrome URL
          tab.linkedBrowser.loadURI(
            Services.io.newURI(
              "chrome://browser/content/smartwindow/smartwindow.html"
            ),
            {
              triggeringPrincipal:
                Services.scriptSecurityManager.getSystemPrincipal(),
            }
          );
        }
      }
    }
  },

  isSmartWindowActive() {
    return document.documentElement.hasAttribute("smart-window");
  },

  exitSmartWindow() {
    if (this.isSmartWindowActive()) {
      this.toggleSmartWindow();
    }
  },

  updateSidebar() {
    // Check if smart window right sidebar is open
    const smartWindowBox = document.getElementById("smartwindow-box");
    const smartWindowBrowser = document.getElementById("smartwindow-browser");

    if (smartWindowBox && !smartWindowBox.hidden && smartWindowBrowser) {
      const currentTab = gBrowser.selectedTab;
      const currentBrowser = gBrowser.selectedBrowser;

      // Send tab info to the right sidebar
      const actor =
        smartWindowBrowser.browsingContext?.currentWindowGlobal?.getActor(
          "SmartWindow"
        );
      if (actor) {
        actor.sendAsyncMessage("SmartWindow:TabUpdate", {
          url: currentBrowser.currentURI.spec,
          title: currentTab.label,
          favicon: currentTab.getAttribute("image") || "",
          tabId: currentTab.linkedPanel,
        });
      }
    }
  },

  // Prompt cache management methods
  getPromptsFromCache(cacheKey) {
    const cached = this._promptsCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < this._promptsCacheExpiry) {
      console.log("[SmartWindow] Using cached prompts for context:", cacheKey);
      // Return the promise if it's still pending, or the resolved result
      return cached.promise;
    }

    return null;
  },

  setPromptsCache(cacheKey, promiseOrResult) {
    const timestamp = Date.now();

    // If it's a promise, store it directly
    if (promiseOrResult && typeof promiseOrResult.then === "function") {
      this._promptsCache.set(cacheKey, {
        promise: promiseOrResult,
        timestamp,
      });

      // When the promise resolves, replace it with the result for future use
      promiseOrResult
        .then(result => {
          // Only update if this cache entry still exists and hasn't been replaced
          const current = this._promptsCache.get(cacheKey);
          if (current && current.timestamp === timestamp) {
            this._promptsCache.set(cacheKey, {
              promise: Promise.resolve(result),
              timestamp,
            });
          }
        })
        .catch(error => {
          // Remove failed promises from cache so they can be retried
          const current = this._promptsCache.get(cacheKey);
          if (current && current.timestamp === timestamp) {
            this._promptsCache.delete(cacheKey);
          }
        });
    } else {
      // If it's already a result, wrap it in a resolved promise
      this._promptsCache.set(cacheKey, {
        promise: Promise.resolve(promiseOrResult),
        timestamp,
      });
    }

    // Clean up old cache entries
    this.cleanupPromptsCache();
  },

  cleanupPromptsCache() {
    const now = Date.now();
    for (const [key, value] of this._promptsCache.entries()) {
      if (now - value.timestamp >= this._promptsCacheExpiry) {
        this._promptsCache.delete(key);
      }
    }
  },

  // Generate a cache key based on context tabs
  getContextCacheKey(contextTabs) {
    return contextTabs
      .map(tab => `${tab.title}|${tab.url}`)
      .sort()
      .join("::");
  },

  // Chat message management methods
  getChatMessages(tabId) {
    return this._chatMessagesByTab.get(tabId) || [];
  },

  setChatMessages(tabId, messages) {
    if (messages && messages.length) {
      this._chatMessagesByTab.set(tabId, [...messages]);
    } else {
      this._chatMessagesByTab.delete(tabId);
    }
  },

  clearChatMessages(tabId) {
    this._chatMessagesByTab.delete(tabId);
  },

  clearAllChatMessages() {
    this._chatMessagesByTab.clear();
  },

  setupTabAttrObserver() {
    if (gBrowser?.tabContainer) {
      this._tabAttrObserver = event => {
        console.log("[Smart Window] TabAttrModified event:", event);
        // Only update if it's a label or image change on the currently selected tab
        if (
          (event.detail.changed.includes("label") ||
            event.detail.changed.includes("image")) &&
          event.target === gBrowser.selectedTab
        ) {
          // Small delay to ensure the attributes have been fully updated
          setTimeout(() => {
            this.updateSidebar();
          }, 50);
        }
      };

      gBrowser.tabContainer.addEventListener(
        "TabAttrModified",
        this._tabAttrObserver
      );
      console.log("[Smart Window] Tab attribute observer set up");
    }
  },

  focusContentSmartbar() {
    if (gBrowser.currentURI.spec.includes("smartwindow/smartwindow.html")) {
      gBrowser.selectedBrowser.contentDocument?.dispatchEvent(
        new CustomEvent("FocusSmartSearchInput")
      );
    }
  },

  shutdown() {
    // Don't save state during shutdown as SessionStore may not be available
    // State is already saved on each toggle

    // Clean up prompt cache
    this._promptsCache.clear();

    // Clean up chat messages
    this._chatMessagesByTab.clear();

    // Clean up event listeners
    if (gBrowser?.tabContainer && this._tabAttrObserver) {
      gBrowser.tabContainer.removeEventListener(
        "TabAttrModified",
        this._tabAttrObserver
      );
      this._tabAttrObserver = null;
    }

    console.log("Smart Window shutdown complete");
  },
};
