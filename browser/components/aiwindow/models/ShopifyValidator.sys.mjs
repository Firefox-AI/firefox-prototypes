/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { normalizeDomain } from "moz-src:///browser/components/aiwindow/models/CouponFollowClient.sys.mjs";

const HTTP_TIMEOUT_MS = 20000;
const TARGET_CART_VALUE = 60;
const BLOCK_STATUS_CODES = new Set([403, 429, 430, 503]);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const OUTCOME = Object.freeze({
  VALID: "VALID",
  INVALID: "INVALID",
  BLOCKED: "BLOCKED",
  NO_PRODUCT: "NO_PRODUCT",
  UNSUPPORTED: "UNSUPPORTED",
  ERROR: "ERROR",
});

function wait(ms) {
  return ms
    ? new Promise(resolve => lazy.setTimeout(resolve, ms))
    : Promise.resolve();
}

/**
 * Validates coupon codes against a real Shopify cart by reading the price delta.
 *
 * On-page error messages are a deliberate oracle (Shopify returns the same
 * "enter a valid discount code" for invalid and inapplicable codes), so the
 * trustworthy signal is total_discount / total_price from the AJAX Cart API.
 *
 * Note: the AJAX cart is cookie-based. A production build should run these
 * requests in a sandboxed/contained network context (see Tabstack integration)
 * rather than the user's cookie jar.
 */
export class ShopifyValidator {
  #fetch;

  constructor({ fetchImpl = fetch } = {}) {
    this.#fetch = fetchImpl;
  }

  async detectPlatform(domain) {
    const host = normalizeDomain(domain);
    try {
      const data = await this.#json(`https://${host}/products.json?limit=1`);
      if (data && Array.isArray(data.products)) {
        return "shopify";
      }
    } catch {}
    return "unknown";
  }

  /**
   * Pick a buyable variant and a quantity that lands the cart near target value,
   * so codes with a minimum-spend threshold can apply.
   *
   * @param {string} domain
   * @param {number} [target]
   * @returns {Promise<?object>} { variantId, title, price, qty } or null.
   */
  async pickVariant(domain, target = TARGET_CART_VALUE) {
    const host = normalizeDomain(domain);
    let data;
    try {
      data = await this.#json(`https://${host}/products.json?limit=250`);
    } catch {
      return null;
    }
    const available = [];
    for (const product of data?.products || []) {
      for (const variant of product.variants || []) {
        if (variant.available === false) {
          continue;
        }
        const price = parseFloat(variant.price);
        if (!(price > 0)) {
          continue;
        }
        available.push({
          variantId: Number(variant.id),
          title: `${product.title || "?"} / ${variant.title || ""}`.replace(
            / \/ $/,
            ""
          ),
          price,
        });
      }
    }
    if (!available.length) {
      return null;
    }
    const mid = available
      .filter(v => v.price >= target * 0.5 && v.price <= target * 2.5)
      .sort((a, b) => a.price - b.price);
    if (mid.length) {
      return { ...mid[0], qty: 1 };
    }
    const cheapest = available.reduce((a, b) => (a.price <= b.price ? a : b));
    const qty = Math.max(1, Math.min(40, Math.ceil(target / cheapest.price)));
    return { ...cheapest, qty };
  }

  /**
   * Validate coupon codes against a real cart and report which reduce the price.
   *
   * @param {string} domain
   * @param {string[]} codes
   * @param {object} [options]
   * @param {number} [options.maxCodes]
   * @param {number} [options.spacing]
   * @returns {Promise<object>} { domain, platform, product, baselineTotal,
   *   nValid, results: [{ code, outcome, savings, pct, codedTotal, detail }] }
   */
  async validateStore(domain, codes, { maxCodes = 8, spacing = 250 } = {}) {
    const host = normalizeDomain(domain);
    const platform = await this.detectPlatform(host);
    if (platform !== "shopify") {
      return this.#storeResult(host, platform, null, 0, [
        {
          code: codes[0] || "",
          outcome: OUTCOME.UNSUPPORTED,
          detail: `platform=${platform}`,
        },
      ]);
    }
    const variant = await this.pickVariant(host);
    if (!variant) {
      return this.#storeResult(host, platform, null, 0, [
        {
          code: codes[0] || "",
          outcome: OUTCOME.NO_PRODUCT,
          detail: "no buyable variant",
        },
      ]);
    }

    let baselineTotal = variant.price * variant.qty;
    try {
      await this.#post(`https://${host}/cart/add.js`, {
        id: variant.variantId,
        quantity: variant.qty,
      });
      const base = await this.#json(`https://${host}/cart.js`);
      baselineTotal = round2((base?.total_price || 0) / 100) || baselineTotal;
    } catch (error) {
      const outcome = BLOCK_STATUS_CODES.has(error?.status)
        ? OUTCOME.BLOCKED
        : OUTCOME.ERROR;
      return this.#storeResult(host, platform, variant.title, baselineTotal, [
        {
          code: codes[0] || "",
          outcome,
          detail: `cart setup: ${error?.status || error}`,
        },
      ]);
    }

    const results = [];
    const list = codes.slice(0, maxCodes);
    for (let i = 0; i < list.length; i++) {
      if (i) {
        await wait(spacing);
      }
      results.push(
        await this.#validateOne(host, list[i], baselineTotal, variant.title)
      );
    }
    return this.#storeResult(
      host,
      platform,
      variant.title,
      baselineTotal,
      results
    );
  }

  async #validateOne(host, code, baselineTotal, product) {
    try {
      await this.#post(`https://${host}/cart/update.js`, { discount: code });
      const cart = await this.#json(`https://${host}/cart.js`);
      const codedTotal = round2((cart?.total_price || 0) / 100);
      const discount = round2((cart?.total_discount || 0) / 100);
      const delta = round2(baselineTotal - codedTotal);
      // Clear so the next code is evaluated in isolation.
      await this.#post(`https://${host}/cart/update.js`, {
        discount: "",
      }).catch(() => {});

      if (discount > 0.009 || delta > 0.009) {
        const savings = round2(Math.max(discount, delta));
        return {
          code,
          outcome: OUTCOME.VALID,
          savings,
          pct: baselineTotal ? round1((100 * savings) / baselineTotal) : 0,
          codedTotal,
          product,
        };
      }
      return {
        code,
        outcome: OUTCOME.INVALID,
        savings: 0,
        pct: 0,
        codedTotal,
        detail: `total_discount=0; ${codedTotal} vs ${baselineTotal}`,
      };
    } catch (error) {
      return {
        code,
        outcome: BLOCK_STATUS_CODES.has(error?.status)
          ? OUTCOME.BLOCKED
          : OUTCOME.ERROR,
        savings: 0,
        pct: 0,
        detail: `HTTP ${error?.status || error}`,
      };
    }
  }

  #storeResult(domain, platform, product, baselineTotal, results) {
    return {
      domain,
      platform,
      product,
      baselineTotal,
      nValid: results.filter(r => r.outcome === OUTCOME.VALID).length,
      results,
    };
  }

  async #json(url) {
    const data = await this.#request(url, {
      headers: { Accept: "application/json" },
    });
    return data;
  }

  async #post(url, body) {
    return this.#request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async #request(url, init) {
    const controller = new AbortController();
    const timer = lazy.setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      // credentials:"include" so the Shopify cart cookie set by add.js
      // round-trips to the later cart.js/update.js calls in the sequence.
      const response = await this.#fetch(url, {
        ...init,
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`Shopify request failed: ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    } finally {
      lazy.clearTimeout?.(timer);
    }
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
