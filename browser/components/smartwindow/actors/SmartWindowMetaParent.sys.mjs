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

      const { pageUrl, canonical, ogUrl } = metadata;

      const normalizedPageUrl = normalizeUrl(pageUrl);
      if (!normalizedPageUrl.success) {
        result.errors.push({
          url: pageUrl,
          reason: "Page URL normalization failed",
          error: normalizedPageUrl.error,
        });
        return result;
      }

      const urlsToSeed = [normalizedPageUrl.url];
      result.seededUrls.push({
        original: pageUrl,
        normalized: normalizedPageUrl.url,
        source: "page",
      });

      if (canonical) {
        const validated = this.#validateSecondaryUrl(
          canonical,
          normalizedPageUrl.url,
          pageUrl,
          "canonical"
        );

        if (validated.success) {
          urlsToSeed.push(validated.normalizedUrl);
          result.seededUrls.push({
            original: canonical,
            normalized: validated.normalizedUrl,
            source: "canonical",
          });
        } else {
          result.skippedUrls.push({
            original: canonical,
            source: "canonical",
            reason: validated.reason,
          });
        }
      }

      if (ogUrl) {
        const validated = this.#validateSecondaryUrl(
          ogUrl,
          normalizedPageUrl.url,
          pageUrl,
          "og:url"
        );

        if (validated.success) {
          urlsToSeed.push(validated.normalizedUrl);
          result.seededUrls.push({
            original: ogUrl,
            normalized: validated.normalizedUrl,
            source: "og:url",
          });
        } else {
          result.skippedUrls.push({
            original: ogUrl,
            source: "og:url",
            reason: validated.reason,
          });
        }
      }

      sessionLedger.forTab(tabId).seed(urlsToSeed, pageUrl);
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
   * Validates a secondary URL (canonical or og:url) against the page's eTLD+1.
   *
   * @param {string} url - The URL to validate (may be relative)
   * @param {string} normalizedPageUrl - The normalized page URL for eTLD+1 comparison
   * @param {string} baseUrl - The original page URL for resolving relative URLs
   * @param {string} source - Source identifier ("canonical" or "og:url")
   * @returns {object} Validation result with success flag and normalizedUrl or reason
   * @private
   */
  #validateSecondaryUrl(url, normalizedPageUrl, baseUrl, source) {
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
