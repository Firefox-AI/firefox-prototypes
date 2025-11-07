/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { GetPageInfoOptions, GetTextOptions } from './PageExtractor.js'
 * @import { PageExtractorParent } from './PageExtractorParent.sys.mjs'
 */

const READY_DELAY = 500;

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  console: () =>
    console.createInstance({
      prefix: "PageExtractorChild",
      maxLogLevelPref: "browser.ml.logLevel",
    }),
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
  extractTextFromDOM:
    "moz-src:///toolkit/components/pageextractor/DOMExtractor.sys.mjs",
  getPageInfoFromDOM:
    "moz-src:///toolkit/components/pageextractor/DOMExtractor.sys.mjs",
  getSelectionTextFromDOM:
    "moz-src:///toolkit/components/pageextractor/DOMExtractor.sys.mjs",
  isProbablyReaderable: "resource://gre/modules/Readerable.sys.mjs",
});

/**
 * Extract a variety of content from pages for use in a smart window.
 */
export class PageExtractorChild extends JSWindowActorChild {
  /**
   * Used to debounce notifications about a page being ready.
   *
   * @type {number | null}
   */
  #contentLoadedTimeout = null;

  /**
   * Route the messages coming from the parent process.
   *
   * @param {object} message
   * @param {string} message.name
   * @param {any} message.data
   *
   * @returns {Promise<unknown>}
   */
  async receiveMessage({ name, data }) {
    switch (name) {
      case "PageExtractorParent:GetReaderModeContent":
        if (this.isAboutReader()) {
          return this.getAboutReaderContent();
        }
        return this.getReaderModeContent(data);
      case "PageExtractorParent:GetText":
        if (this.isAboutReader()) {
          return this.getAboutReaderContent();
        }
        return this.getText(data);
      case "PageExtractorParent:GetPageInfo":
        return this.getPageInfo(data);
      case "PageExtractorParent:GetSelectionText":
        return this.getSelectionText();
      case "PageExtractorParent:GetFullPageBounds":
        return this.getFullPageBounds();
    }
    return Promise.reject(new Error("Unknown message: " + name));
  }

  /**
   *
   * @see ActorManagerParent.sys.mjs
   *
   * @param {Event} event
   *   The DOM event.
   */
  handleEvent(event) {
    switch (event.type) {
      case "DOMContentLoaded":
        this.#contentLoadedTimeout = lazy.setTimeout(() => {
          this.sendAsyncMessage("PageExtractor:DocumentReady");
        }, READY_DELAY);
        break;
    }
  }

  /**
   * @see PageExtractorParent#getReaderModeContent for docs
   *
   * @param {boolean} force
   * @returns {Promise<string | null>} text from the page
   */
  async getReaderModeContent(force) {
    const window = this.browsingContext?.window;
    const document = window?.document;

    if (!force && (!document || !lazy.isProbablyReaderable(document))) {
      return null;
    }

    if (!document) {
      return "";
    }

    const article = await lazy.ReaderMode.parseDocument(document);
    if (!article) {
      return "";
    }

    let text = (article?.textContent || "")
      .trim()
      // Replace duplicate whitespace with either a single newline or space
      .replace(/(\s*\n\s*)|\s{2,}/g, (_, newline) => (newline ? "\n" : " "));

    if (article.title) {
      text = article.title + "\n\n" + text;
    }
    lazy.console.log("GetReaderModeContent", { force });
    lazy.console.debug(text);

    return text;
  }

  /**
   * @see PageExtractorParent#getText for docs
   *
   * @param {GetTextOptions} options
   * @returns {import('./PageExtractor.d.ts').GetTextResult}
   */
  getText(options) {
    const extractionOptions = options ?? {};

    const window = this.browsingContext?.window;
    const document = window?.document;

    if (!document) {
      return { text: "" };
    }

    if (extractionOptions.removeBoilerplate) {
      throw new Error("Boilerplate removal is not supported yet.");
    }

    const extraction = lazy.extractTextFromDOM(document, extractionOptions);

    lazy.console.log("GetText", extractionOptions);
    lazy.console.debug(extraction);

    if (extraction && typeof extraction === "object") {
      const trimmedText =
        typeof extraction.text === "string" ? extraction.text.trim() : "";
      return {
        ...extraction,
        text: trimmedText,
      };
    }

    const text = typeof extraction === "string" ? extraction.trim() : "";

    return { text };
  }

  /**
   * Special case extracting text from Reader Mode. The original article content is not
   * retained once reader mode is activated. It is rendered out to the page. Rather
   * than cache an additional copy of the article, just extract the text from the
   * actual reader mode DOM.
   *
   * @returns {string | null}
   */
  getAboutReaderContent() {
    lazy.console.log("Using special text extraction strategy for about:reader");
    const document = this.manager.contentWindow.document;

    if (!document) {
      lazy.console.log("No document is available.");
      return null;
    }
    /** @type {HTMLElement?} */
    const titleEl = document.querySelector(".reader-title");
    /** @type {HTMLElement?} */
    const contentEl = document.querySelector(".moz-reader-content");

    const title = titleEl?.innerText;
    const content = contentEl?.innerText;
    if (!title && !content) {
      return null;
    }

    const results = title ? `${title}\n\n${content}`.trim() : content.trim();

    lazy.console.log("about:reader content", results);
    return results;
  }

  /**
   * Checks if about:reader is loaded, which requires special handling.
   *
   * @returns {boolean}
   */
  isAboutReader() {
    // Accessing the documentURIObject in this way does not materialize the
    // `window.location.href` and should be a cheaper check here.
    let url = this.manager.contentWindow.document.documentURIObject;
    return url.schemeIs("about") && url.pathQueryRef.startsWith("reader?");
  }

  /**
   * Returns a page rect for the full size of the page.
   */
  getFullPageBounds() {
    const win = this.manager.contentWindow;
    const { width, height } = win.document.body.getBoundingClientRect();
    return { width, height, devicePixelRatio: win.devicePixelRatio };
  }
  /**
   * Computes pagination information for the current document.
   *
   * @param {GetPageInfoOptions} options
   * @returns {import('./PageExtractor.d.ts').PageInfo | null}
   */
  getPageInfo(options = {}) {
    const window = this.browsingContext?.window;
    const document = window?.document;

    if (!document) {
      return null;
    }

    return lazy.getPageInfoFromDOM(document, options);
  }

  /**
   * Returns the currently selected text within the document.
   *
   * @returns {string}
   */
  getSelectionText() {
    const window = this.browsingContext?.window;
    const document = window?.document;

    if (!document) {
      return "";
    }

    return lazy.getSelectionTextFromDOM(document) || "";
  }

  /**
   * Called when the page is destroyed.
   */
  didDestroy() {
    if (this.#contentLoadedTimeout) {
      lazy.clearTimeout(this.#contentLoadedTimeout);
    }
  }
}
