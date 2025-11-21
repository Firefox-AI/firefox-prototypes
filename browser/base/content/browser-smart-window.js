/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var SmartWindow = {
  PAGE_URL: Services.io.newURI(
    "chrome://browser/content/smartwindow/smartwindow.html"
  ),
  FIRST_RUN_URL: Services.io.newURI(
    "chrome://browser/content/smartwindow/firstrun.html"
  ),

  _initialized: false,
  _viewInitialized: false,
  _sidebarVisible: false,
  _tabAttrObserver: null,
  _historyProgressListener: null,
  _historyOverlayContext: null,

  // Shared prompt cache across all smart window instances
  _promptsCache: new Map(),
  _promptsCacheExpiry: 5 * 60 * 1000, // 5 minutes cache

  // Chat message storage by tab ID (no expiration)
  _chatMessagesByTab: new Map(),

  // Insights storage (persists across tabs and sessions via prefs)
  _insightsData: null,
  _isGeneratingInsights: false,
  _insightsGenerationError: null,

  // This gets set by insights.mjs.
  insightsScheduler: null,

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;

    if (!gSmartWindowEnabled) {
      console.log("[Smart Window] Feature disabled by pref");
      return;
    }

    // Load insights from prefs
    this._loadInsightsFromPrefs();

    this.initButtons();
    this.setupTabAttrObserver();
    this.reconcileUIToSmartWindowState();
    this.setupTabEventListeners();
    this._ensureHistoryOverlayProgressListener();

    window
      .matchMedia(`-moz-pref("sidebar.verticalTabs")`)
      .addEventListener("change", () => {
        console.log("Vertical tabs switcheroo");
        this.reconcileUIToSmartWindowState();
      });

    console.log(
      "[Smart Window]",
      this.isSmartWindowActive() ? "Smart" : "Classic",
      "window initialized"
    );
  },

  _isSmartPage(browser) {
    return !!browser?.currentURI?.equalsExceptRef(this.PAGE_URL) || !!browser?.currentURI?.equalsExceptRef(this.FIRST_RUN_URL);
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
          this.toggleSmartWindow();
          break;
        case "smart-window-switch-smart": {
          const requireSignIn = Services.prefs.getBoolPref(
            "browser.smartwindow.requireSignIn",
            false
          );

          if (!requireSignIn) {
            this.toggleSmartWindow();
            break;
          }
          const { UIState } = ChromeUtils.importESModule(
            "resource://services-sync/UIState.sys.mjs"
          );
          const currentState = UIState.get();

          if (currentState.status !== UIState.STATUS_SIGNED_IN) {
            console.warn(
              "[Smart Window] User not authenticated, sign in with FxA"
            );

            try {
              const { SpecialMessageActions } = ChromeUtils.importESModule(
                "resource://messaging-system/lib/SpecialMessageActions.sys.mjs"
              );
              // FXA_SMART_WINDOW_SIGNIN_FLOW handles toggling smart window on success
              // TODO: we should await handleAction and set tos and isfirstrun pref here
              // instead of SpecialMessageActions
              SpecialMessageActions.handleAction(
                {
                  type: "FXA_SMART_WINDOW_SIGNIN_FLOW",
                  data: {
                    entrypoint: "aimode",
                  },
                },
                gBrowser.selectedBrowser
              );
              break;
            } catch (error) {
              console.error(
                "[Smart Window] Error during FxA sign-in:",
                error
              );
            }
          } else {
            this.toggleSmartWindow();
          }
          break;
        }
        case "smart-window-dev-onboarding":
          this.showOnboarding();
          break;
        case "smart-window-open-private":
          OpenBrowserWindow({ private: true });
          break;
      }
    });
    this._viewInitialized = true;
  },

  initButtons() {
    const modeSwitcherButton = document.getElementById("smart-window-toggle");
    const sidebarButton = document.getElementById(
      "smart-window-sidebar-button"
    );

    if (modeSwitcherButton) {
      // Show the button only if the feature is enabled
      if (gSmartWindowEnabled) {
        modeSwitcherButton.hidden = false;

        // Add click event listener to the toggle button
        modeSwitcherButton.addEventListener("command", event => {
          this._ensureViewInitialized();
          PanelUI.showSubView("smart-window-toggle-view", event.target, event);
        });
      }
    }

    // Initialize the nav bar toggle button (assistant button)
    if (sidebarButton) {
      sidebarButton.addEventListener("command", () => {
        this.toggleSidebar();
      });
    }
  },

  // Shows Post login first run onboarding
  async showOnboarding() {
    return new Promise(resolve => {
      window.openTrustedLinkIn(
        Services.urlFormatter.formatURL(
          "chrome://browser/content/smartwindow/firstrun.html"
        ),
        "tab"
      );
      // Resolve after a brief delay to ensure the window is opened
      setTimeout(() => resolve(), 2000);
    });
  },

  toggleSmartWindow() {
    console.log(
      `[Smart Window] toggleSmartWindow called, current state: ${this.isSmartWindowActive()}`
    );

    // Remove any preloaded new tab page browser when switching modes
    // This ensures the next new tab will use the correct type
    if (typeof NewTabPagePreloading !== "undefined") {
      NewTabPagePreloading.removePreloadedBrowser(window);
    }

    // Store this temporarily as it will change once we toggle the attribute.
    // We need it to find "old" new tab URLs, as there is no guarantee their
    // URL is always `about:newtab`.
    let oldNewTabURL = BROWSER_NEW_TAB_URL;

    // Toggle internal state.
    document.documentElement.toggleAttribute("smart-window");
    this.reconcileUIToSmartWindowState(oldNewTabURL);
  },

  /**
   *
   * @param {string} [oldNewTabURL=""]
   *                 Can be omitted if not switching from classic to smart
   *                 window mode.
   */
  async reconcileUIToSmartWindowState(oldNewTabURL = "") {
    if (this.isSmartWindowActive()) {
      // Show the first run onboarding first time user switches to smart window mode
      if (Services.prefs.getBoolPref("browser.smartwindow.isfirstrun", false)) {
        Services.prefs.setBoolPref("browser.smartwindow.isfirstrun", false);
        await this.showOnboarding();
      }

      // Check if we're on a smart window page
      const isSmartWindowPage = this._isSmartPage(gBrowser.selectedBrowser);

      // Only show sidebar if NOT on a smart window page
      if (!isSmartWindowPage) {
        this.showSidebar();
      } else {
        // Hide sidebar when on smart window page
        this.hideSidebar();
      }

      // Navigate all new tab pages to the smart window URL
      this.navigateNewTabsToSmartWindow(oldNewTabURL);
    } else {
      // Hide the sidebar
      this.hideSidebar();

      // Replace any smart window tabs that don't have chat content.
      for (let tab of gBrowser.tabs) {
        let browser = tab.linkedBrowser;
        if (
          this._isSmartPage(browser) &&
          browser.contentDocument && // FIXME: how would we deal with session-restored tabs?
          !browser.contentDocument.documentElement.hasAttribute("haschat")
        ) {
          browser.loadURI(makeURI(BROWSER_NEW_TAB_URL), {
            triggeringPrincipal:
              Services.scriptSecurityManager.getSystemPrincipal(),
          });
        }
      }
    }

    // Update bookmarks toolbar visibility based on user preference
    updateBookmarkToolbarVisibility();

    // Update the hamburger menu item location.
    this.updateHamburgerMenuAndModeSwitch();

    // Dispatch event that smart window pages can listen to
    window.dispatchEvent(
      new CustomEvent("SmartWindowModeChanged", {
        detail: { active: this.isSmartWindowActive() },
      })
    );

    console.log(
      "[SmartWindow] reconciling with mode:",
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
    const sidebarButton = document.getElementById(
      "smart-window-sidebar-button"
    );

    if (smartWindowBox) {
      smartWindowBox.hidden = !this._sidebarVisible;
      if (!this._sidebarVisible) {
        smartWindowBox.style.width = "412px";
      }
    }
    if (smartWindowSplitter) {
      smartWindowSplitter.hidden = !this._sidebarVisible;
    }

    sidebarButton?.toggleAttribute("checked", this._sidebarVisible);
    document.documentElement.toggleAttribute(
      "smart-window-sidebar",
      this._sidebarVisible
    );

    console.log(
      "Smart Window sidebar",
      this._sidebarVisible ? "shown" : "hidden"
    );

    window.dispatchEvent(
      new CustomEvent("SmartWindowVisibilityChanged", {
        detail: { visible: this._sidebarVisible },
      })
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

  updateHamburgerMenuAndModeSwitch() {
    let hamburgerButton = PanelUI.menuButton.parentElement;
    let usingVerticalTabs = Services.prefs.getBoolPref(
      "sidebar.verticalTabs",
      false
    );
    let topToolbar = !usingVerticalTabs
      ? document.getElementById("TabsToolbar")
      : document.getElementById("nav-bar");
    let mainToolbar =
      this.isSmartWindowActive() && !usingVerticalTabs
        ? document.getElementById("TabsToolbar")
        : document.getElementById("nav-bar");
    let titlebarItems = mainToolbar.querySelector(
      ".titlebar-buttonbox-container"
    );
    titlebarItems.before(hamburgerButton);

    let smartWindowToggle = document.getElementById("smart-window-toggle");
    topToolbar
      .querySelector(".titlebar-buttonbox-container")
      .before(smartWindowToggle);
  },

  navigateNewTabsToSmartWindow(oldNewTabURL) {
    console.log("[Smart Window] Navigating new tabs to smart window URL");

    // Iterate through all tabs
    for (let tab of gBrowser.tabs) {
      if (tab.linkedBrowser?.currentURI) {
        const uri = tab.linkedBrowser.currentURI.spec;

        // Check for new tab pages (about:newtab or about:home)
        if (
          uri == oldNewTabURL ||
          uri === "about:newtab" ||
          uri === "about:home"
        ) {
          console.log(
            `[Smart Window] Converting tab from ${uri} to ${this.PAGE_URL.spec}`
          );

          // Navigate to the smart window chrome URL
          tab.linkedBrowser.loadURI(this.PAGE_URL, {
            triggeringPrincipal:
              Services.scriptSecurityManager.getSystemPrincipal(),
          });
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

  // Insights management methods
  _loadInsightsFromPrefs() {
    try {
      const insightsJson = Services.prefs.getStringPref(
        "browser.smartwindow.insights",
        "{}"
      );
      this._insightsData = JSON.parse(insightsJson);
      console.log("[SmartWindow] Loaded insights from prefs");
    } catch (e) {
      console.error("[SmartWindow] Failed to load insights from prefs:", e);
      this._insightsData = {};
    }
  },

  _saveInsightsToPrefs() {
    try {
      const insightsJson = JSON.stringify(this._insightsData);
      Services.prefs.setStringPref(
        "browser.smartwindow.insights",
        insightsJson
      );
      console.log("[SmartWindow] Saved insights to prefs");
    } catch (e) {
      console.error("[SmartWindow] Failed to save insights to prefs:", e);
    }
  },

  getInsightsData() {
    return this._insightsData;
  },

  setInsightsData(data) {
    this._insightsData = data || {};
    this._saveInsightsToPrefs();
  },

  isGeneratingInsights() {
    return this._isGeneratingInsights;
  },

  setGeneratingInsights(value) {
    this._isGeneratingInsights = value;
  },

  getInsightsError() {
    return this._insightsGenerationError;
  },

  setInsightsError(error) {
    this._insightsGenerationError = error;
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

  setupTabEventListeners() {
    if (gBrowser?.tabContainer) {
      // Listen for new tabs being opened
      this._tabOpenListener = () => {
        console.log("[Smart Window] Tab opened");
        this.hidePageHistory();
      };

      // Listen for tab selection changes
      this._tabSelectListener = () => {
        console.log("[Smart Window] Tab selected");
        // Do nothing
      };

      gBrowser.tabContainer.addEventListener("TabOpen", this._tabOpenListener);
      gBrowser.tabContainer.addEventListener(
        "TabSelect",
        this._tabSelectListener
      );

      console.log("[Smart Window] Tab event listeners set up");
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

    // Save insights then clean up insights in-memory storage
    this._saveInsightsToPrefs();
    this._insightsData = null;
    this._isGeneratingInsights = false;
    this._insightsGenerationError = null;

    // Clean up event listeners
    if (gBrowser?.tabContainer && this._tabAttrObserver) {
      gBrowser.tabContainer.removeEventListener(
        "TabAttrModified",
        this._tabAttrObserver
      );
      this._tabAttrObserver = null;
    }

    this._teardownHistoryOverlayProgressListener();

    this.insightsScheduler?.destroy();
    this.insightsScheduler = null;

    console.log("Smart Window shutdown complete");
  },

  async showPageHistory(historyItems) {
    // Dynamically import the component if not already loaded
    if (!customElements.get("page-history-overlay")) {
      try {
        await import("chrome://browser/content/smartwindow/page-history.mjs");
        console.log("[SmartWindow] page-history.mjs loaded");
      } catch (error) {
        console.error("[SmartWindow] Failed to load page-history.mjs:", error);
        return;
      }
    }

    // Create the page-history-overlay element
    const historyOverlay = document.createElement("page-history-overlay");
    historyOverlay.id = "page-history-overlay-instance";
    historyOverlay.historyItems = historyItems;
    historyOverlay.isOpen = true;

    // Listen for close event
    historyOverlay.addEventListener("history-grid-close", () => {
      this.hidePageHistory();
    });

    // Listen for item selection
    historyOverlay.addEventListener("item-selected", event => {
      const selectedItem = event.detail;
      console.log("[SmartWindow] Selected history item:", selectedItem);

      if (selectedItem.url) {
        gBrowser.selectedBrowser.fixupAndLoadURIString(selectedItem.url, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }

      this.hidePageHistory();
    });

    let overlayContainer = null;
    const targetBrowser = gBrowser?.selectedBrowser;
    if (targetBrowser) {
      const browserParent = targetBrowser.parentElement;
      if (browserParent?.classList?.contains("browserStack")) {
        overlayContainer = browserParent;
      }
    }

    if (!overlayContainer) {
      overlayContainer = document.getElementById("tabbrowser-tabbox");
    }

    if (overlayContainer) {
      overlayContainer.appendChild(historyOverlay);
      console.log(
        "[SmartWindow] History overlay added to",
        overlayContainer.classList?.contains("browserStack")
          ? "current browserStack"
          : "tabbrowser-tabbox"
      );
    } else {
      console.error(
        "[SmartWindow] Unable to find container for history overlay"
      );
      return;
    }

    this._setHistoryOverlayContext(targetBrowser);

    // Force a render update
    requestAnimationFrame(() => {
      historyOverlay.requestUpdate?.();
    });
  },

  hidePageHistory() {
    const historyOverlay = document.getElementById(
      "page-history-overlay-instance"
    );
    if (historyOverlay) {
      historyOverlay.isOpen = false;
      // Remove from DOM after animation
      setTimeout(() => {
        historyOverlay.remove();
        console.log("[SmartWindow] History overlay removed");
      }, 300);
    }
    this._clearHistoryOverlayContext();
  },
  _ensureHistoryOverlayProgressListener() {
    if (this._historyProgressListener || !gBrowser) {
      return;
    }

    this._historyProgressListener = {
      onLocationChange: (_browser, _webProgress, _request, location) => {
        this._onHistoryOverlayLocationChange(_browser, location);
      },
    };

    gBrowser.addTabsProgressListener(this._historyProgressListener);
  },

  _onHistoryOverlayLocationChange(browser, location) {
    const context = this._historyOverlayContext;
    if (!context || browser !== context.browser) {
      return;
    }

    const newSpec = location?.spec ?? "";
    if (!newSpec || newSpec === context.url) {
      return;
    }

    console.log(
      "[Smart Window] Navigation detected, hiding history overlay",
      context.url,
      "→",
      newSpec
    );
    this.hidePageHistory();
  },

  _setHistoryOverlayContext(browser) {
    if (!browser) {
      this._historyOverlayContext = null;
      return;
    }

    this._historyOverlayContext = {
      browser,
      url: browser.currentURI?.spec ?? "",
    };
  },

  _clearHistoryOverlayContext() {
    this._historyOverlayContext = null;
  },

  _teardownHistoryOverlayProgressListener() {
    if (this._historyProgressListener && gBrowser) {
      gBrowser.removeTabsProgressListener(this._historyProgressListener);
      this._historyProgressListener = null;
    }
  },
};
