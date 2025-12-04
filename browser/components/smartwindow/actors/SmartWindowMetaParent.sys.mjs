/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  normalizeUrl,
  isSameETLDPlusOne,
} from "chrome://global/content/ml/security/SecurityUtils.sys.mjs";

/**
 * Chrome-process actor for validating page metadata and seeding security ledger.
 * Validates canonical/og:url have same eTLD+1 as page URL before seeding.
 */
export class SmartWindowMetaParent extends JSWindowActorParent {
  /**
   * Seeds the security ledger for the given browser/tab.
   *
   * @param {object} sessionLedger - The SessionLedger instance
   * @param {string} tabId - The tab identifier (typically linkedPanel)
   * @returns {Promise<object>} Result with seededUrls, skippedUrls, and errors
   */
  async seedLedgerForTab(sessionLedger, tabId) {
    const result = {
      success: false,
      seededUrls: [],
      skippedUrls: [],
      errors: [],
    };

    try {
      const metadata = await this.sendQuery("SmartWindowMeta:GetMetadata");

      if (!metadata || !metadata.pageUrl) {
        result.errors.push("No page URL available from content process");
        return result;
      }

      // Process all URLs in one place
      const processed = this.#processMetadataUrls(metadata);

      if (processed.error) {
        result.errors.push(processed.error);
        return result;
      }

      result.seededUrls = processed.seededUrls;
      result.skippedUrls = processed.skippedUrls;

      sessionLedger.forTab(tabId).seed(processed.urlsToSeed, metadata.pageUrl);
      result.success = true;
    } catch (error) {
      result.errors.push({
        message: "Actor communication failed",
        error: error.message || String(error),
      });
    }

    return result;
  }

  /**
   * Processes page metadata URLs: normalizes page URL and validates secondary URLs.
   *
   * @param {object} metadata - Raw metadata from content process
   * @param {string} metadata.pageUrl - The page's URL
   * @param {string} [metadata.canonical] - The canonical URL from <link rel="canonical">
   * @param {string} [metadata.ogUrl] - The og:url from <meta property="og:url">
   * @returns {object} Processed result with urlsToSeed, seededUrls, skippedUrls, error
   * @private
   */
  #processMetadataUrls(metadata) {
    const { pageUrl, canonical, ogUrl } = metadata;
    const urlsToSeed = [];
    const seededUrls = [];
    const skippedUrls = [];

    // Normalize page URL first
    const normalizedPageUrl = normalizeUrl(pageUrl);
    if (!normalizedPageUrl.success) {
      return {
        error: {
          url: pageUrl,
          reason: "Page URL normalization failed",
          error: normalizedPageUrl.error,
        },
      };
    }

    urlsToSeed.push(normalizedPageUrl.url);
    seededUrls.push({
      original: pageUrl,
      normalized: normalizedPageUrl.url,
      source: "page",
    });

    // Process secondary URLs (canonical, og:url)
    const secondaryUrls = [
      { url: canonical, source: "canonical" },
      { url: ogUrl, source: "og:url" },
    ];

    for (const { url, source } of secondaryUrls) {
      if (!url) {
        continue;
      }

      const validated = this.#validateSecondaryUrl(
        url,
        normalizedPageUrl.url,
        pageUrl,
      );

      if (validated.success) {
        urlsToSeed.push(validated.normalizedUrl);
        seededUrls.push({
          original: url,
          normalized: validated.normalizedUrl,
          source,
        });
      } else {
        skippedUrls.push({
          original: url,
          source,
          reason: validated.reason,
        });
      }
    }

    return { urlsToSeed, seededUrls, skippedUrls };
  }

  /**
   * Validates a secondary URL (canonical or og:url) against the page's eTLD+1.
   *
   * @param {string} url - The URL to validate (may be relative)
   * @param {string} normalizedPageUrl - The normalized page URL for eTLD+1 comparison
   * @param {string} baseUrl - The original page URL for resolving relative URLs
   * @returns {object} Validation result with success flag and normalizedUrl or reason
   * @private
   */
  #validateSecondaryUrl(url, normalizedPageUrl, baseUrl) {
    const normalized = normalizeUrl(url, baseUrl);

    if (!normalized.success) {
      return {
        success: false,
        reason: "Normalization failed",
        details: normalized.error,
      };
    }

    if (!isSameETLDPlusOne(normalizedPageUrl, normalized.url)) {
      return {
        success: false,
        reason: "Different eTLD+1 from page URL",
        pageUrl: normalizedPageUrl,
        secondaryUrl: normalized.url,
      };
    }

    return { success: true, normalizedUrl: normalized.url };
  }
}
