/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var SmartWindow = {
  _initialized: false,
  _smartWindowActive: false,
  SESSION_STORE_KEY: "smart-window-active",

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;

    // Check if the smart window feature is enabled
    if (!gSmartWindowEnabled) {
      console.log("[Smart Window] Feature disabled by pref");
      return;
    }

    // Initialize toggle button
    this.initToggleButton();

    // Set up event listeners
    this.setupEventListeners();

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

      // Update UI elements
      const toggleButton = document.getElementById("smart-window-toggle");
      toggleButton?.setAttribute("checked", "true");

      // Notify all tabs
      this.updateNewTabsSmartWindowState(true);

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

  initToggleButton() {
    const toggleButton = document.getElementById("smart-window-toggle");

    if (toggleButton) {
      // Show the button only if the feature is enabled
      if (gSmartWindowEnabled) {
        toggleButton.hidden = false;

        // Add click event listener to the toggle button
        toggleButton.addEventListener("command", () => {
          this.toggleSmartWindow();
        });
      }
    }
  },

  setupEventListeners() {
    // Toggle button is handled by navigator-toolbox.js command event

    // Listen for new tabs being opened to update their Smart Window state
    if (gBrowser) {
      gBrowser.tabContainer.addEventListener("TabOpen", e => {
        if (this._smartWindowActive) {
          // Give the tab a moment to load, then update its state
          setTimeout(() => {
            const tab = e.target;
            // Check if the browser has the isblankpage attribute set
            if (
              tab.linkedBrowser &&
              tab.linkedBrowser.hasAttribute("isblankpage")
            ) {
              console.log(
                "[Smart Window] New blank page tab opened, updating state"
              );
              this.updateTabSmartWindowState(tab, true);
            }
          }, 100);
        }
      });
    }
  },

  toggleSmartWindow(skipSave = false) {
    console.log(
      `[Smart Window] toggleSmartWindow called, current state: ${this._smartWindowActive}, skipSave: ${skipSave}`
    );

    const root = document.documentElement;
    const toggleButton = document.getElementById("smart-window-toggle");

    if (!this._smartWindowActive) {
      // Activate Smart Window
      this._smartWindowActive = true;
      root.setAttribute("smart-window", "true");
      toggleButton?.setAttribute("checked", "true");

      // Notify all new tabs about Smart Window state change
      this.updateNewTabsSmartWindowState(true);

      console.log("Smart Window activated");

      // Save the state unless we're restoring
      if (!skipSave) {
        this.saveState();
      }
    } else {
      // Deactivate Smart Window
      this._smartWindowActive = false;
      root.removeAttribute("smart-window");
      toggleButton?.removeAttribute("checked");

      // Notify all new tabs about Smart Window state change
      this.updateNewTabsSmartWindowState(false);

      console.log("Smart Window deactivated");

      // Save the state unless we're restoring
      if (!skipSave) {
        this.saveState();
      }
    }
  },

  exitSmartWindow() {
    if (this._smartWindowActive) {
      this.toggleSmartWindow();
    }
  },

  updateTabSmartWindowState(tab, smartWindowActive) {
    try {
      const actor =
        tab.linkedBrowser.browsingContext?.currentWindowGlobal?.getActor(
          "AboutNewTab"
        );
      if (actor) {
        actor.sendAsyncMessage("UpdateSmartWindowState", {
          smartWindowActive,
        });
        console.log(
          "[Smart Window] Sent UpdateSmartWindowState message to tab actor"
        );
      }
    } catch (e) {
      console.log("[Smart Window] Error updating tab:", e);
    }
  },

  updateNewTabsSmartWindowState(smartWindowActive) {
    console.log(
      `[Smart Window] Broadcasting Smart Window state to new tabs: ${smartWindowActive}`
    );

    // Send message through the actor system
    for (let tab of gBrowser.tabs) {
      if (tab.linkedBrowser && tab.linkedBrowser.currentURI) {
        const uri = tab.linkedBrowser.currentURI.spec;

        // Check for new tab pages (might be about:newtab or about:home)
        if (uri.startsWith("about:newtab") || uri.startsWith("about:home")) {
          console.log(`[Smart Window] Found new tab to update: ${uri}`);
          this.updateTabSmartWindowState(tab, smartWindowActive);
        }
      }
    }
  },

  shutdown() {
    // Don't save state during shutdown as SessionStore may not be available
    // State is already saved on each toggle

    // Clean up event listeners
    if (gBrowser) {
      const tabContainer = gBrowser.tabContainer;
      // Remove TabOpen listener
      const tabOpenListeners = tabContainer._getListeners?.("TabOpen") || [];
      tabOpenListeners.forEach(listener => {
        if (listener.toString().includes("SmartWindow")) {
          tabContainer.removeEventListener("TabOpen", listener);
        }
      });
    }

    console.log("Smart Window shutdown complete");
  },
};
