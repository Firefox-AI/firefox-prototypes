/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Content-process actor for extracting page metadata (page URL, canonical, og:url).
 * The parent actor validates and normalizes these URLs before seeding the security ledger.
 */
export class SmartWindowMetaChild extends JSWindowActorChild {
  /**
   * Receives queries from the parent process.
   *
   * @param {ReceiveMessageArgument} message - The message from parent
   * @returns {Promise<object>} Metadata object with URLs
   */
  receiveMessage(message) {
    switch (message.name) {
      case "SmartWindowMeta:GetMetadata":
        return this.getMetadata();
      default:
        return Promise.reject(new Error(`Unknown message: ${message.name}`));
    }
  }

  /**
   * Extracts metadata from the current page.
   *
   * @returns {object} Metadata with pageUrl, canonical, and ogUrl (raw strings)
   */
  getMetadata() {
    const doc = this.contentWindow?.document;

    if (!doc) {
      return { pageUrl: "", canonical: "", ogUrl: "" };
    }

    const pageUrl = doc.location?.href || "";

    let canonical = "";
    try {
      const canonicalLink = doc.querySelector('link[rel="canonical"]');
      canonical = canonicalLink?.getAttribute("href") || "";
    } catch {
      // querySelector may fail on some documents (e.g., XML)
    }

    let ogUrl = "";
    try {
      const ogUrlMeta = doc.querySelector('meta[property="og:url"]');
      ogUrl = ogUrlMeta?.getAttribute("content") || "";
    } catch {
      // querySelector may fail on some documents
    }

    return { pageUrl, canonical, ogUrl };
  }
}
