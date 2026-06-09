/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const SITE_URL = "https://couponfollow.com/site/";
const POPUP_URL = "https://couponfollow.com/portalapi/coupon/popup";
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

// CouponFollow renders only a masked 3-char tail in the page HTML; the full
// code is served by this internal JSON endpoint on "show code", with no auth.
const CARD_RE =
  /<article[^>]*data-cid="(\d+)"[^>]*?data-has-code="True"[^>]*?data-type="(\w+)"/gi;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

function wait(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise(resolve => lazy.setTimeout(resolve, ms));
}

function isTransientError(error) {
  return (
    TRANSIENT_STATUS_CODES.has(error?.status) || error?.name === "TypeError"
  );
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// CouponFollow's portalapi gates on Origin + Referer, which the Fetch spec
// forbids setting. A mozSystem XHR (privileged) can set them and bypasses CORS,
// so the reveal POST succeeds the same way it does from a real browser tab.
function systemFetch(url, { method = "GET", headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    let xhr;
    try {
      xhr = new XMLHttpRequest({ mozSystem: true });
    } catch (error) {
      reject(error);
      return;
    }
    xhr.open(method, url, true);
    xhr.responseType = "text";
    for (const [name, value] of Object.entries(headers)) {
      try {
        xhr.setRequestHeader(name, value);
      } catch {}
    }
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.onload = () =>
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: async () => xhr.responseText,
        json: async () => JSON.parse(xhr.responseText),
      });
    xhr.onerror = () => reject(new TypeError("Network request failed"));
    xhr.send(body ?? null);
  });
}

/**
 * Recovers full coupon code strings for a store from CouponFollow's public
 * popup JSON API. Stateless POSTs, so no cookie/session handling is needed.
 */
export class CouponFollowClient {
  #fetch;
  #maxRetries;
  #retryDelayMs;

  constructor({
    fetchImpl = systemFetch,
    maxRetries = 2,
    retryDelayMs = 600,
  } = {}) {
    this.#fetch = fetchImpl;
    this.#maxRetries = maxRetries;
    this.#retryDelayMs = retryDelayMs;
  }

  /**
   * @param {string} domain Bare store domain, e.g. "glossier.com".
   * @param {object} [options]
   * @param {number} [options.limit] Max cards to resolve.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<Array<{code: string, discount: string, source: string}>>}
   */
  async recoverCodes(domain, { limit = 16, signal } = {}) {
    const normalized = normalizeDomain(domain);
    if (!normalized) {
      return [];
    }

    let html;
    try {
      html = await this.#fetchText(`${SITE_URL}${normalized}`, signal);
    } catch {
      return [];
    }

    const cards = [...html.matchAll(CARD_RE)]
      .map(match => ({ cid: match[1], type: match[2].toLowerCase() }))
      .sort(
        (a, b) => (a.type === "coupon" ? 0 : 1) - (b.type === "coupon" ? 0 : 1)
      )
      .slice(0, limit);

    // Reveal popups are independent stateless POSTs, so resolve them in
    // parallel. Results are merged in card order with case-insensitive dedupe.
    const resolved = await Promise.all(
      cards.map(card =>
        this.#popup(card.cid, normalized, signal)
          .then(data => ({ card, data }))
          .catch(() => null)
      )
    );

    const seen = new Set();
    const codes = [];
    for (const entry of resolved) {
      if (!entry) {
        continue;
      }
      const code = String(entry.data?.code || entry.data?.Code || "").trim();
      if (!code || seen.has(code.toUpperCase())) {
        continue;
      }
      seen.add(code.toUpperCase());
      codes.push({
        code,
        discount: String(entry.data?.title || entry.data?.desc || "").slice(
          0,
          80
        ),
        source: `couponfollow:${entry.card.cid}`,
      });
    }
    return codes;
  }

  async #fetchText(url, signal) {
    const response = await this.#fetch(url, {
      headers: { Accept: "text/html", "User-Agent": UA },
      signal,
    });
    if (!response.ok) {
      const error = new Error(`CouponFollow fetch failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.text();
  }

  async #popup(cid, domain, signal) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        const response = await this.#fetch(POPUP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": UA,
            Origin: "https://couponfollow.com",
            Referer: `${SITE_URL}${domain}`,
          },
          body: JSON.stringify({ id: Number(cid), domainName: domain }),
          signal,
        });
        if (!response.ok) {
          const error = new Error(`popup ${cid} failed: ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return await response.json();
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

export function normalizeDomain(value = "") {
  return String(value)
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}
