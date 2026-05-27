/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Small client for the Tabstack extract API.
 *
 * Fetches page content as markdown via https://api.tabstack.ai. The API key
 * is read from the TABSTACK_KEY environment variable.
 */

const DEFAULT_ENDPOINT = "https://api.tabstack.ai";
const ENDPOINT_PREF = "browser.smartwindow.tabstack.endpointURL";
const TIMEOUT_PREF = "browser.smartwindow.tabstack.timeoutMs";
const DEFAULT_TIMEOUT_MS = 30000;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "TabstackClient",
    maxLogLevelPref: "browser.smartwindow.conversation.logLevel",
  })
);

/**
 * Static client for the Tabstack extract endpoints.
 */
export class TabstackClient {
  /**
   * Extract the contents of a URL as markdown.
   *
   * @param {string} url            The page URL to extract.
   * @param {object} [options]
   * @param {boolean} [options.metadata]  Include page metadata in the response.
   * @param {boolean} [options.nocache]   Bypass the server-side cache.
   * @returns {Promise<object>} The parsed Tabstack response.
   */
  static extractMarkdown(url, { metadata = false, nocache = false } = {}) {
    if (!url) {
      throw new Error("Tabstack extractMarkdown requires a url.");
    }
    return TabstackClient.#post("/v1/extract/markdown", {
      url: String(url),
      metadata,
      nocache,
    });
  }

  static #apiKey() {
    const key = Services.env.get("TABSTACK_KEY");
    if (!key) {
      throw new Error(
        "TABSTACK_KEY is not set; cannot authenticate with Tabstack."
      );
    }
    return key;
  }

  static #endpointBase() {
    return Services.prefs.getStringPref(ENDPOINT_PREF, DEFAULT_ENDPOINT);
  }

  static #timeoutMs() {
    return Services.prefs.getIntPref(TIMEOUT_PREF, DEFAULT_TIMEOUT_MS);
  }

  static async #post(path, body) {
    const url = new URL(path, TabstackClient.#endpointBase());
    const apiKey = TabstackClient.#apiKey();

    const controller = new AbortController();
    const timer = lazy.setTimeout(
      () => controller.abort(),
      TabstackClient.#timeoutMs()
    );

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        signal: controller.signal,
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lazy.console.warn(`Tabstack request to ${path} failed:`, error);
      throw error;
    } finally {
      lazy.clearTimeout(timer);
    }
  }
}
