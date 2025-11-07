/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { HiddenFrame } from "resource://gre/modules/HiddenFrame.sys.mjs"
 * @import {
 *   GetPageInfoOptions,
 *   GetSelectionTextOptions,
 *   GetTextOptions,
 * } from './PageExtractor.d.ts'
 * @import { PageExtractorChild } from './PageExtractorChild.sys.mjs'
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  HiddenBrowserManager: "resource://gre/modules/HiddenFrame.sys.mjs",
  console: () =>
    console.createInstance({
      prefix: "PageExtractorChild",
      maxLogLevelPref: "browser.ml.logLevel",
    }),
});

/**
 * Extract a variety of content from pages for use in a smart window.
 */
export class PageExtractorParent extends JSWindowActorParent {
  /** @type {WeakMap<MozBrowser, (actor: PageExtractorParent) => void>} */
  static headlessBrowsers = new WeakMap();
  /**
   * Returns ReaderMode content when the page passes the `isProbablyReaderable` check.
   * The check can be bypassed to force page content to be retrieved by setting `force`
   * to true.
   *
   * @see PageExtractorChild#getReaderModeContent
   *
   * @param {boolean} force - Bypass the `isProbablyReaderable` check.
   * @returns {Promise<string | null>}
   */
  getReaderModeContent(force = false) {
    if (this.#isPDF()) {
      return Promise.resolve(null);
    }
    return this.sendQuery("PageExtractorParent:GetReaderModeContent", force);
  }

  /**
   * Gets the visible text from the page. This function is a bit smarter than just
   * document.body.innerText. See GetTextOptions
   *
   * @see PageExtractorChild#getText
   *
   * @param {Partial<GetTextOptions>} options
   * @returns {Promise<import('./PageExtractor.d.ts').GetTextResult | null>}
   */
  getText(options = {}) {
    if (this.#isPDF()) {
      lazy.console.log("Getting content from pdf");
      return this.browsingContext.currentWindowGlobal
        .getActor("Pdfjs")
        .getTextContent()
        .then(text => ({
          text: typeof text === "string" ? text.trim() : "",
        }));
    }
    return this.sendQuery("PageExtractorParent:GetText", options);
  }

  /**
   * Computes pagination information for the current page.
   *
   * @param {GetPageInfoOptions} options
   * @returns {Promise<import('./PageExtractor.d.ts').PageInfo | null>}
   */
  getPageInfo(options = {}) {
    if (this.#isPDF()) {
      return Promise.resolve(null);
    }
    return this.sendQuery("PageExtractorParent:GetPageInfo", options);
  }

  /**
   * Returns the currently selected text on the page.
   *
   * @param {GetSelectionTextOptions} [options]
   * @returns {Promise<string>}
   */
  getSelectionText(options = {}) {
    if (this.#isPDF()) {
      return Promise.resolve("");
    }
    return this.sendQuery("PageExtractorParent:GetSelectionText", options);
  }

  #isPDF() {
    return (
      this.browsingContext.currentWindowGlobal.documentPrincipal
        .originNoSuffix == "resource://pdf.js"
    );
  }

  /**
   * Called when the content process signals that a page is ready for page extraction.
   *
   * @param {PageExtractorParent} actor
   */
  static async backgroundPageLoaded(actor) {
    let browser = actor.browsingContext?.embedderElement;

    if (!browser) {
      return;
    }

    let resolve = PageExtractorParent.headlessBrowsers.get(browser);
    if (resolve) {
      resolve(actor);
    }
  }

  /**
   * Called when a message is received from the content process.
   *
   * @param {any} msg
   */
  receiveMessage(msg) {
    switch (msg.name) {
      case "PageExtractor:DocumentReady":
        PageExtractorParent.backgroundPageLoaded(this);
        break;
    }
  }

  /**
   * Get a Headless extractor. Resolve the callback when done with the extractor and
   * the window will be cleaned up.
   *
   * @see PageExtractorChild#getText
   *
   * @template T
   *
   * @param {string} url
   * @param {(actor: PageExtractorParent) => Promise<T>} callback
   * @returns {Promise<T>}
   */
  static async getHeadlessExtractor(url, callback) {
    return lazy.HiddenBrowserManager.withHiddenBrowser(async browser => {
      try {
        browser.setAttribute("messagemanagergroup", "headless-browser");
        let { promise: actorPromise, resolve } = Promise.withResolvers();
        PageExtractorParent.headlessBrowsers.set(browser, resolve);

        let principal = Services.scriptSecurityManager.getSystemPrincipal();
        let loadURIOptions = {
          triggeringPrincipal: principal,
        };

        lazy.console.log("Loading a headless extraction", url);
        browser.fixupAndLoadURIString(url, loadURIOptions);
        const actor = await actorPromise;

        return callback(actor);
      } finally {
        PageExtractorParent.headlessBrowsers.delete(browser);
      }
    });
  }
}
