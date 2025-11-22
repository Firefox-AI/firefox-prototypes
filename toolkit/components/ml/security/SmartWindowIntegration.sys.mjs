/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SessionLedger } from "chrome://global/content/ml/security/SecurityUtils.sys.mjs";

const logConsole = console.createInstance({
  maxLogLevelPref: "browser.ml.logLevel",
  prefix: "SmartWindowSecurity",
});

/**
 * Smart Window security layer integration.
 *
 * Bridge between Smart Window UI and security layer.
 * Manages SessionLedger lifecycle and request context building.
 */

let gSessionLedger = null;
let gSessionId = null;

/**
 * Initializes the security layer. Call once when Smart Window opens.
 *
 * @param {string} [sessionId] - Optional session identifier (auto-generated if not provided)
 * @returns {SessionLedger} The session ledger instance
 */
export function initSecurityLayer(sessionId = null) {
  if (!sessionId) {
    sessionId = `smart-window-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  gSessionId = sessionId;
  gSessionLedger = new SessionLedger(sessionId);

  logConsole.debug(`Security layer initialized for session: ${sessionId}`);

  return gSessionLedger;
}

/**
 * Gets the current SessionLedger instance.
 *
 * @returns {SessionLedger|null} The session ledger, or null if not initialized
 * @throws {Error} If security layer hasn't been initialized
 */
export function getSessionLedger() {
  if (!gSessionLedger) {
    throw new Error(
      "Security layer not initialized. Call initSecurityLayer() first."
    );
  }
  return gSessionLedger;
}

/** Resets the security layer (clears all ledgers). */
export function resetSecurityLayer() {
  if (gSessionLedger) {
    gSessionLedger.clearAll();
  }
  gSessionLedger = null;
  gSessionId = null;
  logConsole.debug("Security layer reset");
}

/**
 * Seeds the ledger for a tab via SmartWindowMeta actor.
 *
 * @param {Browser} browser - The browser element for the tab
 * @param {string} tabId - The tab identifier (typically linkedPanel)
 * @returns {Promise<object>} Result object with seeded URLs and any errors
 */
export async function seedCurrentTab(browser, tabId) {
  const sessionLedger = getSessionLedger();

  try {
    const actor =
      browser.browsingContext?.currentWindowGlobal?.getActor("SmartWindowMeta");

    if (!actor) {
      logConsole.error(
        "SmartWindowMeta actor not available for browser",
        tabId
      );
      return {
        success: false,
        errors: [
          "SmartWindowMeta actor not available (page may not be loaded yet)",
        ],
      };
    }

    const result = await actor.seedLedgerForTab(sessionLedger, tabId);

    if (result.success) {
      logConsole.debug(
        `Seeded tab ${tabId} with ${result.seededUrls.length} URLs`,
        result.seededUrls.map(u => u.normalized)
      );

      if (result.skippedUrls.length) {
        logConsole.debug(
          `Skipped ${result.skippedUrls.length} URLs for tab ${tabId}`,
          result.skippedUrls
        );
      }
    } else {
      logConsole.error(`Failed to seed tab ${tabId}:`, result.errors);
    }

    return result;
  } catch (error) {
    logConsole.error("Error seeding tab:", error);
    return {
      success: false,
      errors: [{ message: "Exception during seeding", error: String(error) }],
    };
  }
}

/**
 * Handles tab navigation by clearing and re-seeding the ledger.
 *
 * This should be called when the user navigates to a new page in a tab.
 * It clears the old trusted URLs and seeds with the new page context.
 *
 * @param {Browser} browser - The browser element for the tab
 * @param {string} tabId - The tab identifier
 * @param {nsIURI} uri - The new URI (optional, for logging)
 * @returns {Promise<void>}
 */
export async function handleNavigation(browser, tabId, uri = null) {
  const sessionLedger = getSessionLedger();

  sessionLedger.clearTab(tabId);

  logConsole.debug(
    `Cleared ledger for tab ${tabId} after navigation${uri ? ` to ${uri.spec}` : ""}`
  );

  // Re-seed with new page context
  return seedCurrentTab(browser, tabId);
}

/**
 * Handles tab close by removing the tab's ledger.
 *
 * This should be called when a tab closes to clean up memory.
 *
 * @param {string} tabId - The tab identifier
 */
export function handleTabClose(tabId) {
  const sessionLedger = getSessionLedger();
  sessionLedger.removeTab(tabId);
  logConsole.debug(`Removed ledger for closed tab ${tabId}`);
}

/**
 * Builds request-scoped security context for policy evaluation.
 *
 * @param {string} currentTabId - The active/focused tab
 * @param {string[]} [mentionedTabIds=[]] - Tab IDs from @mentions
 * @param {string} [requestId] - Optional request identifier for logging
 * @returns {object} Security context object for policy evaluation
 */
export function getRequestContext(
  currentTabId,
  mentionedTabIds = [],
  requestId = null
) {
  const sessionLedger = getSessionLedger();

  const linkLedger = sessionLedger.buildRequestScope({
    currentTabId,
    mentionedTabIds,
  });

  const actualRequestId =
    requestId || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  return {
    linkLedger,
    sessionId: gSessionId,
    requestId: actualRequestId,
    currentTabId,
    mentionedTabIds,
  };
}

/**
 * Gets statistics about the current security layer state.
 * Useful for debugging and monitoring.
 *
 * @returns {object} Statistics object with tab counts and URL counts
 */
export function getSecurityLayerStats() {
  const sessionLedger = getSessionLedger();

  const tabIds = [];
  const tabStats = [];
  let totalUrls = 0;

  for (const [tabId, ledger] of sessionLedger.tabs.entries()) {
    const urlCount = ledger.size();
    tabIds.push(tabId);
    tabStats.push({ tabId, urlCount });
    totalUrls += urlCount;
  }

  return {
    sessionId: gSessionId,
    tabCount: sessionLedger.tabCount(),
    totalUrls,
    tabIds,
    tabStats,
  };
}
