/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

function definedEntries(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  );
}

function wait(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise(resolve => lazy.setTimeout(resolve, ms));
}

function isTransientError(error) {
  return (
    TRANSIENT_STATUS_CODES.has(error?.status) ||
    error?.name === "TypeError" ||
    /(?:408|429|500|502|503|504) status code/i.test(error?.message || "")
  );
}

function createRequestError(status, message) {
  const error = new Error(`Exa request failed (${status}): ${message}`);
  error.status = status;
  return error;
}

export class ExaClient {
  #apiKey;
  #fetch;
  #maxRetries;
  #retryDelayMs;

  constructor({
    apiKey = Services.env.get("EXA_KEY"),
    fetchImpl = fetch,
    maxRetries = 2,
    retryDelayMs = 750,
  } = {}) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#maxRetries = maxRetries;
    this.#retryDelayMs = retryDelayMs;
  }

  async search(
    {
      query,
      type = "auto",
      numResults = 10,
      contents = {
        highlights: true,
      },
      includeDomains,
      excludeDomains,
      startPublishedDate,
      endPublishedDate,
    },
    signal
  ) {
    if (!query?.trim()) {
      throw new Error("Exa search requires a non-empty query.");
    }

    return this.#request(
      EXA_SEARCH_URL,
      definedEntries({
        query: query.trim(),
        type,
        numResults,
        contents,
        includeDomains,
        excludeDomains,
        startPublishedDate,
        endPublishedDate,
      }),
      signal
    );
  }

  async contents(
    {
      urls,
      text = {
        maxCharacters: 8000,
      },
      highlights,
      summary,
    },
    signal
  ) {
    if (!Array.isArray(urls) || !urls.length) {
      throw new Error("Exa contents requires at least one URL.");
    }

    return this.#request(
      EXA_CONTENTS_URL,
      definedEntries({
        urls,
        text,
        highlights,
        summary,
      }),
      signal
    );
  }

  async #request(url, body, signal) {
    if (!this.#apiKey) {
      throw new Error("EXA_KEY is not set in the Firefox environment.");
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        const response = await this.#fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.#apiKey,
          },
          body: JSON.stringify(body),
          signal,
        });

        const text = await response.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = { raw: text };
          }
        }

        if (response.ok) {
          return data ?? {};
        }

        const message =
          data?.error || data?.message || data?.raw || text || "no body";
        throw createRequestError(response.status, message);
      } catch (error) {
        lastError = error;
        if (!isTransientError(error) || attempt === this.#maxRetries) {
          throw error;
        }
        await wait(this.#retryDelayMs * (attempt + 1));
      }
    }

    throw lastError;
  }
}
