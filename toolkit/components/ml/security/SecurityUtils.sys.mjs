/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Security utilities for Firefox Smart Window security layer.
 *
 * This module provides:
 * - URL normalization for consistent comparison
 * - eTLD+1 (effective top-level domain) validation
 * - TabLedger: Per-tab trusted URL storage
 * - SessionLedger: Container for all tab ledgers in a Smart Window session
 *
 * Security Model:
 * ---------------
 * - Each tab maintains its own ledger of trusted URLs
 * - Request-scoped context merges current tab + @mentioned tabs
 * - URLs are normalized before storage and comparison
 * - Same eTLD+1 validation prevents injection via canonical/og:url
 */

/** TTL for ledger entries (30 minutes) */
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Max URLs per tab (prevents memory exhaustion) */
const MAX_URLS_PER_TAB = 500;

/** Tracking params to strip during normalization */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "mc_eid",
  "_ga",
  // Note: utm_* params are handled via startsWith() pattern below
]);

/**
 * Normalizes a URL for consistent comparison.
 * Lowercases host, strips default ports/fragments/tracking params, sorts query.
 *
 * @param {string} urlString - URL to normalize
 * @param {string} [baseUrl] - Base URL for relative resolution
 * @returns {object} { success, url?, error? }
 */
export function normalizeUrl(urlString, baseUrl = null) {
  if (!urlString || !String(urlString).trim()) {
    return {
      success: false,
      error: "Empty URL",
    };
  }

  try {
    let url;
    try {
      url = baseUrl ? new URL(urlString, baseUrl) : new URL(urlString);
    } catch (parseError) {
      return {
        success: false,
        error: "Invalid URL format",
      };
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        success: false,
        error: `Unsupported scheme: ${url.protocol}`,
      };
    }

    const protocol = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();

    let port = url.port;
    if (
      (protocol === "http:" && port === "80") ||
      (protocol === "https:" && port === "443")
    ) {
      port = "";
    }

    const params = new URLSearchParams(url.searchParams);
    const cleanedParams = new URLSearchParams();

    for (const [key, value] of params) {
      const keyLower = key.toLowerCase();
      if (keyLower.startsWith("utm_") || TRACKING_PARAMS.has(keyLower)) {
        continue;
      }
      cleanedParams.append(key, value);
    }

    cleanedParams.sort();
    const search = cleanedParams.toString();

    let pathname = url.pathname;
    if (!pathname.startsWith("/")) {
      pathname = "/" + pathname;
    }

    let normalizedUrl = `${protocol}//${hostname}`;

    if (port) {
      normalizedUrl += `:${port}`;
    }

    normalizedUrl += pathname;

    if (search) {
      normalizedUrl += `?${search}`;
    }

    return {
      success: true,
      url: normalizedUrl,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

/**
 * Validates that two URLs share the same eTLD+1 (effective top-level domain).
 *
 * @param {string} url1 - First URL (typically page URL)
 * @param {string} url2 - Second URL (typically canonical/og:url)
 * @returns {boolean} True if both URLs share the same eTLD+1
 */
export function isSameETLDPlusOne(url1, url2) {
  try {
    const parsed1 = new URL(url1);
    const parsed2 = new URL(url2);

    if (!Services || !Services.eTLD) {
      console.error("Services.eTLD not available");
      return false;
    }

    const eTLD1 = Services.eTLD.getBaseDomainFromHost(parsed1.hostname);
    const eTLD2 = Services.eTLD.getBaseDomainFromHost(parsed2.hostname);

    return eTLD1 === eTLD2;
  } catch (error) {
    console.error("isSameETLDPlusOne error:", error.message);
    return false;
  }
}

/**
 * Per-tab storage for trusted URLs.
 *
 * Each tab maintains its own ledger of URLs that are authorized for
 * security-sensitive operations. URLs are stored with expiration timestamps
 * and the ledger enforces size limits to prevent memory exhaustion.
 */
export class TabLedger {
  /**
   * Creates a new tab ledger.
   *
   * @param {string} tabId - The tab identifier
   * @param {number} [ttlMs=DEFAULT_TTL_MS] - Time-to-live for entries in milliseconds
   * @param {number} [maxUrls=MAX_URLS_PER_TAB] - Maximum URLs to store
   */
  constructor(tabId, ttlMs = DEFAULT_TTL_MS, maxUrls = MAX_URLS_PER_TAB) {
    this.tabId = tabId;
    this.ttlMs = ttlMs;
    this.maxUrls = maxUrls;

    /** @type {Map<string, number>} URL --> expiration timestamp */
    this.urls = new Map();

    /** @type {number} Last cleanup timestamp */
    this.lastCleanup = Date.now();
  }

  /**
   * Seeds the ledger with initial URLs. Invalid URLs skipped silently.
   *
   * @param {string[]} urls - URLs to seed
   * @param {string} [baseUrl] - Optional base URL for resolving relatives
   */
  seed(urls, baseUrl = null) {
    this.#cleanup();

    const now = Date.now();
    const expiresAt = now + this.ttlMs;

    for (const url of urls) {
      if (this.urls.size >= this.maxUrls) {
        break;
      }

      const normalized = normalizeUrl(url, baseUrl);
      if (normalized.success) {
        this.urls.set(normalized.url, expiresAt);
      }
    }

    this.lastCleanup = now;
  }

  /**
   * Adds a single URL to the ledger.
   *
   * @param {string} url - URL to add
   * @param {string} [baseUrl] - Optional base URL for resolving relatives
   * @returns {boolean} True if added successfully, false if invalid or at capacity
   */
  add(url, baseUrl = null) {
    this.#cleanup();

    if (this.urls.size >= this.maxUrls) {
      return false;
    }

    const normalized = normalizeUrl(url, baseUrl);
    if (!normalized.success) {
      return false;
    }

    const expiresAt = Date.now() + this.ttlMs;
    this.urls.set(normalized.url, expiresAt);

    return true;
  }

  /**
   * Checks if a URL is in the ledger and not expired.
   *
   * @param {string} url - URL to check (will be normalized)
   * @param {string} [baseUrl] - Optional base URL for resolving relatives
   * @returns {boolean} True if URL is in ledger and not expired
   */
  has(url, baseUrl = null) {
    const normalized = normalizeUrl(url, baseUrl);
    if (!normalized.success) {
      return false;
    }

    const expiresAt = this.urls.get(normalized.url);
    if (expiresAt === undefined) {
      return false;
    }

    // Check expiration
    if (Date.now() > expiresAt) {
      this.urls.delete(normalized.url);
      return false;
    }

    return true;
  }

  /**
   * Clears all URLs from the ledger.
   * Typically called on tab navigation or tab close.
   */
  clear() {
    this.urls.clear();
    this.lastCleanup = Date.now();
  }

  /**
   * Returns the number of URLs currently in the ledger (including expired).
   *
   * @returns {number} Number of URLs
   */
  size() {
    return this.urls.size;
  }

  /**
   * Removes expired entries from the ledger.
   * Called automatically during add() and can be called manually.
   *
   * @private
   */
  #cleanup() {
    const now = Date.now();
    for (const [url, expiresAt] of this.urls) {
      if (now > expiresAt) {
        this.urls.delete(url);
      }
    }
    this.lastCleanup = now;
  }

  /**
   * Returns all URLs currently in the ledger (expired entries removed).
   *
   * @returns {string[]} Array of URLs
   */
  getAll() {
    this.#cleanup();

    return Array.from(this.urls.keys());
  }
}

/**
 * Container for all tab ledgers in a Smart Window session.
 *
 * SessionLedger manages the lifecycle of individual TabLedgers and provides
 * methods to build request-scoped contexts by merging tab ledgers.
 */
export class SessionLedger {
  /**
   * Creates a new session ledger.
   *
   * @param {string} sessionId - The Smart Window session identifier
   */
  constructor(sessionId) {
    this.sessionId = sessionId;

    /** @type {Map<string, TabLedger>} Map of tab ID --> TabLedger */
    this.tabs = new Map();
  }

  /**
   * Gets or creates a TabLedger for the specified tab.
   *
   * @param {string} tabId - The tab identifier
   * @returns {TabLedger} The tab's ledger
   */
  forTab(tabId) {
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, new TabLedger(tabId));
    }
    return this.tabs.get(tabId);
  }

  /**
   * Merges ledgers from multiple tabs into a temporary request-scoped ledger.
   *
   * This is used to build context for requests with @mentions, where the user
   * explicitly authorizes access to multiple tabs.
   *
   * IMPORTANT: The returned merged ledger is a temporary view. It should be
   * used for a single request and then discarded. It does NOT support add()
   * operations (read-only for policy evaluation).
   *
   * @param {string[]} tabIds - Tab IDs to merge (typically current + @mentioned)
   * @returns {object} Merged ledger with has() and size() methods
   */
  merge(tabIds) {
    const mergedUrls = new Set();

    for (const tabId of tabIds) {
      const ledger = this.forTab(tabId);
      const now = Date.now();

      for (const [url, expiresAt] of ledger.urls) {
        if (now <= expiresAt) {
          mergedUrls.add(url);
        }
      }
    }

    // Return a temporary read-only ledger
    return {
      /**
       * Checks if URL is in any of the merged ledgers.
       *
       * @param {string} url - URL to check
       * @param {string} [baseUrl] - Optional base URL
       * @returns {boolean} True if URL is in any merged ledger
       */
      has(url, baseUrl = null) {
        const normalized = normalizeUrl(url, baseUrl);
        if (!normalized.success) {
          return false;
        }
        return mergedUrls.has(normalized.url);
      },

      /**
       * Returns number of unique URLs in merged ledger.
       *
       * @returns {number} Number of URLs
       */
      size() {
        return mergedUrls.size;
      },
    };
  }

  /**
   * Convenience method for building request-scoped context.
   *
   * @param {object} options - Request scope options
   * @param {string} options.currentTabId - The active/focused tab (always included)
   * @param {string[]} [options.mentionedTabIds=[]] - Tabs from @mentions (optional)
   * @returns {object} Request-scoped ledger with has() and size() methods
   */
  buildRequestScope({ currentTabId, mentionedTabIds = [] }) {
    return this.merge([currentTabId, ...mentionedTabIds]);
  }

  /**
   * Clears the ledger for a specific tab.
   * Typically called on tab navigation or tab close.
   *
   * @param {string} tabId - The tab identifier
   */
  clearTab(tabId) {
    const ledger = this.tabs.get(tabId);
    if (ledger) {
      ledger.clear();
    }
  }

  /**
   * Removes a tab's ledger completely.
   * Typically called when tab closes.
   *
   * @param {string} tabId - The tab identifier
   */
  removeTab(tabId) {
    this.tabs.delete(tabId);
  }

  /** Clears all tab ledgers. */
  clearAll() {
    for (const ledger of this.tabs.values()) {
      ledger.clear();
    }
    this.tabs.clear();
  }

  /** @returns {number} Number of tabs */
  tabCount() {
    return this.tabs.size;
  }
}
