/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const { CouponFollowClient, normalizeDomain } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/CouponFollowClient.sys.mjs"
);
const { ShopifyValidator, OUTCOME } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ShopifyValidator.sys.mjs"
);

function jsonResponse(obj) {
  const body = JSON.stringify(obj);
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => obj,
  };
}

function htmlResponse(text) {
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

add_task(function test_normalizeDomain_strips_scheme_and_path() {
  Assert.equal(
    normalizeDomain("https://www.Glossier.com/products"),
    "glossier.com"
  );
  Assert.equal(normalizeDomain("ALLBIRDS.COM"), "allbirds.com");
});

add_task(async function test_couponfollow_recovers_codes_via_popup_api() {
  const html = `
    <article data-cid="100" data-has-code="True" data-type="coupon"></article>
    <article data-cid="200" data-has-code="True" data-type="deal"></article>
  `;
  const codeById = { 100: "SAVE15", 200: "FREESHIP" };
  let popupCalls = 0;

  const client = new CouponFollowClient({
    fetchImpl: async (url, options = {}) => {
      if (url.startsWith("https://couponfollow.com/site/")) {
        return htmlResponse(html);
      }
      if (url === "https://couponfollow.com/portalapi/coupon/popup") {
        popupCalls++;
        const { id } = JSON.parse(options.body);
        return jsonResponse({ code: codeById[id], title: "15% off" });
      }
      return { ok: false, status: 404, text: async () => "" };
    },
  });

  const codes = await client.recoverCodes("https://www.allbirds.com/");

  Assert.equal(popupCalls, 2, "Resolves both cards");
  Assert.deepEqual(
    codes.map(c => c.code),
    ["SAVE15", "FREESHIP"],
    "Recovers full code strings, coupon-type first"
  );
});

add_task(async function test_couponfollow_dedupes_codes() {
  const html = `
    <article data-cid="1" data-has-code="True" data-type="coupon"></article>
    <article data-cid="2" data-has-code="True" data-type="coupon"></article>
  `;
  const client = new CouponFollowClient({
    fetchImpl: async url => {
      if (url.startsWith("https://couponfollow.com/site/")) {
        return htmlResponse(html);
      }
      return jsonResponse({ code: "DUPE", title: "" });
    },
  });

  const codes = await client.recoverCodes("example.com");
  Assert.equal(codes.length, 1, "Deduplicates identical codes");
});

function makeShopifyFetch() {
  let appliedDiscount = "";
  return async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === "/products.json") {
      return jsonResponse({
        products: [
          {
            title: "Tee",
            variants: [
              { id: 111, price: "40.00", available: true, title: "M" },
            ],
          },
        ],
      });
    }
    if (path === "/cart/add.js") {
      return jsonResponse({});
    }
    if (path === "/cart/update.js") {
      appliedDiscount = JSON.parse(options.body).discount || "";
      return jsonResponse({});
    }
    if (path === "/cart.js") {
      return appliedDiscount === "GOOD"
        ? jsonResponse({ total_price: 3400, total_discount: 600 })
        : jsonResponse({ total_price: 4000, total_discount: 0 });
    }
    return { ok: false, status: 404, text: async () => "" };
  };
}

add_task(async function test_shopify_validates_by_price_delta() {
  const validator = new ShopifyValidator({ fetchImpl: makeShopifyFetch() });
  const report = await validator.validateStore(
    "teestore.com",
    ["GOOD", "BAD"],
    {
      spacing: 0,
    }
  );

  Assert.equal(report.platform, "shopify");
  Assert.equal(report.baselineTotal, 40);
  Assert.equal(report.nValid, 1, "Only the working code validates");

  const good = report.results.find(r => r.code === "GOOD");
  Assert.equal(good.outcome, OUTCOME.VALID);
  Assert.equal(good.savings, 6, "Reads the $6 discount from total_discount");
  Assert.equal(good.pct, 15);

  const bad = report.results.find(r => r.code === "BAD");
  Assert.equal(bad.outcome, OUTCOME.INVALID, "Zero delta is invalid");
});

add_task(async function test_shopify_reports_unsupported_for_non_shopify() {
  const validator = new ShopifyValidator({
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
  });
  const report = await validator.validateStore("notshopify.com", ["X"], {
    spacing: 0,
  });
  Assert.equal(report.platform, "unknown");
  Assert.equal(report.results[0].outcome, OUTCOME.UNSUPPORTED);
});
