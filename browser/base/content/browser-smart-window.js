/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var SmartWindow = {
  _initialized: false,
  _viewInitialized: false,
  _smartWindowActive: false,
  _sidebarVisible: false,
  _tabAttrObserver: null,
  SESSION_STORE_KEY: "smart-window-active",

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

    // Check if this window was opened with Smart Window active from parent window
    let shouldActivateSmartWindow = false;

    // Check window.arguments[1] for extraOptions property bag
    if (
      window.arguments &&
      window.arguments.length >= 2 &&
      window.arguments[1]
    ) {
      try {
        const extraOptions = window.arguments[1];
        // Check if it's a property bag with our Smart Window flag
        if (
          extraOptions instanceof Ci.nsIPropertyBag2 &&
          extraOptions.hasKey("smartWindowActive") &&
          extraOptions.getPropertyAsBool("smartWindowActive")
        ) {
          console.log(
            "[Smart Window] New window opened with Smart Window active from parent"
          );
          shouldActivateSmartWindow = true;
        }
      } catch (e) {
        console.log("[Smart Window] Error checking window arguments:", e);
      }
    }

    if (shouldActivateSmartWindow) {
      // Activate Smart Window immediately for proper state
      this._smartWindowActive = true;
      document.documentElement.setAttribute("smart-window", "true");

      console.log("[Smart Window] New window Smart Window activated");
    } else {
      // Otherwise restore Smart Window state from session storage
      this.restoreState();
    }

    console.log("Smart Window initialized");
  },

  saveState() {
    try {
      // Check if window is ready for SessionStore and not closing
      if (!window.__SSi || !SessionStore || window.closed) {
        console.log(
          "[Smart Window] Window not ready or closing, skipping save"
        );
        return;
      }

      // Additional check to ensure window is still in SessionStore's tracking
      try {
        // Try to get a value first to check if window is still valid
        SessionStore.getCustomWindowValue(window, this.SESSION_STORE_KEY);
      } catch (e) {
        console.log(
          "[Smart Window] Window no longer tracked by SessionStore, skipping save"
        );
        return;
      }

      console.log(`[Smart Window] Saving state: ${this._smartWindowActive}`);
      SessionStore.setCustomWindowValue(
        window,
        this.SESSION_STORE_KEY,
        String(this._smartWindowActive)
      );
    } catch (e) {
      console.error("[Smart Window] Failed to save state:", e);
    }
  },

  restoreState() {
    try {
      // Check if SessionStore is ready
      if (!window.__SSi || !SessionStore) {
        console.log("[Smart Window] SessionStore not ready for restore");
        return;
      }

      // Only restore state if the feature is enabled
      if (!gSmartWindowEnabled) {
        console.log(
          "[Smart Window] Feature disabled by pref, skipping restore"
        );
        return;
      }

      console.log("[Smart Window] Attempting to restore state...");

      const savedState = SessionStore.getCustomWindowValue(
        window,
        this.SESSION_STORE_KEY
      );
      console.log(`[Smart Window] Found saved state: "${savedState}"`);

      if (savedState === "true") {
        // Restore Smart Window if it was previously active
        console.log(
          "[Smart Window] Restoring Smart Window from session storage"
        );
        this.toggleSmartWindow(true); // Pass true to skip saving during restore
      } else {
        console.log("[Smart Window] No active state to restore");
      }
    } catch (e) {
      // It's normal for this to fail if there's no saved state
      console.log("[Smart Window] Error during restore:", e.message);
    }
  },

  _ensureViewInitialized() {
    if (this._viewInitialized) {
      return;
    }
    let view = PanelMultiView.getViewNode(document, "smart-window-toggle-view");
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
    const navToggleButton = document.getElementById("smartwindow-button");

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
      `[Smart Window] toggleSmartWindow called, current state: ${this._smartWindowActive}, skipSave: ${skipSave}`
    );

    const root = document.documentElement;

    // Remove any preloaded new tab page browser when switching modes
    // This ensures the next new tab will use the correct type
    if (typeof NewTabPagePreloading !== "undefined") {
      NewTabPagePreloading.removePreloadedBrowser(window);
    }

    if (!this._smartWindowActive) {
      // Activate Smart Window mode
      this._smartWindowActive = true;
      root.setAttribute("smart-window", "true");

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

      // Hide bookmarks toolbar immediately
      updateBookmarkToolbarVisibility();

      // Navigate all new tab pages to the smart window URL
      this.navigateNewTabsToSmartWindow();

      // Dispatch event that smart window pages can listen to
      window.dispatchEvent(
        new CustomEvent("SmartWindowModeChanged", {
          detail: { active: true },
        })
      );

      console.log("Smart Window mode activated");

      // Save the state unless we're restoring
      if (!skipSave) {
        this.saveState();
      }
    } else {
      // Deactivate Smart Window mode AND hide sidebar
      this._smartWindowActive = false;
      root.removeAttribute("smart-window");

      // Hide the sidebar
      this.hideSidebar();

      // Restore bookmarks toolbar visibility based on user preference
      updateBookmarkToolbarVisibility();

      // Dispatch event that smart window pages can listen to
      window.dispatchEvent(
        new CustomEvent("SmartWindowModeChanged", {
          detail: { active: false },
        })
      );

      console.log("Smart Window mode deactivated");

      // Save the state unless we're restoring
      if (!skipSave) {
        this.saveState();
      }
    }
  },

  showSidebar() {
    const smartWindowBox = document.getElementById("smartwindow-box");
    const smartWindowSplitter = document.getElementById("smartwindow-splitter");
    const navToggleButton = document.getElementById("smartwindow-button");

    if (smartWindowBox) {
      smartWindowBox.hidden = false;
      smartWindowBox.style.width = "358px";
    }
    if (smartWindowSplitter) {
      smartWindowSplitter.hidden = false;
    }

    // Update button state
    navToggleButton?.setAttribute("checked", "true");

    this._sidebarVisible = true;
    document.documentElement.setAttribute("smart-window-sidebar", "true");

    console.log("Smart Window sidebar shown");
  },

  hideSidebar() {
    const smartWindowBox = document.getElementById("smartwindow-box");
    const smartWindowSplitter = document.getElementById("smartwindow-splitter");
    const navToggleButton = document.getElementById("smartwindow-button");

    if (smartWindowBox) {
      smartWindowBox.hidden = true;
    }
    if (smartWindowSplitter) {
      smartWindowSplitter.hidden = true;
    }

    // Update button state
    navToggleButton?.removeAttribute("checked");

    this._sidebarVisible = false;
    document.documentElement.removeAttribute("smart-window-sidebar");

    console.log("Smart Window sidebar hidden");
  },

  toggleSidebar() {
    if (this._sidebarVisible) {
      this.hideSidebar();
    } else {
      this.showSidebar();
    }
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
    return this._smartWindowActive;
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
