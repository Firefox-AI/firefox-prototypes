/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for SecurityUtils.sys.mjs
 *
 * Tests URL normalization, eTLD validation, and ledger management:
 * - normalizeUrl() - URL validation and normalization
 * - isSameETLDPlusOne() - eTLD+1 validation
 * - TabLedger - per-tab URL storage with TTL
 * - SessionLedger - multi-tab ledger management
 *
 * Focus: Critical paths and edge cases that affect security
 */

const { normalizeUrl, isSameETLDPlusOne, TabLedger, SessionLedger } =
  ChromeUtils.importESModule(
    "chrome://global/content/ml/security/SecurityUtils.sys.mjs"
  );

const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

// ============================================================================
// Test: normalizeUrl() - Success Cases
// ============================================================================

/**
 * Test that valid HTTP URLs normalize successfully
 */
add_task(async function test_normalizeUrl_valid_http() {
  const result = normalizeUrl("http://example.com/page");

  Assert.ok(result.success, "Should succeed for valid HTTP URL");
  Assert.ok(result.url, "Should return normalized URL");
  Assert.ok(result.url.startsWith("http://"), "Should preserve http scheme");
});

/**
 * Test that valid HTTPS URLs normalize successfully
 */
add_task(async function test_normalizeUrl_valid_https() {
  const result = normalizeUrl("https://example.com/page");

  Assert.ok(result.success, "Should succeed for valid HTTPS URL");
  Assert.ok(result.url, "Should return normalized URL");
  Assert.ok(result.url.startsWith("https://"), "Should preserve https scheme");
});

/**
 * Test that URLs with query parameters normalize successfully
 */
add_task(async function test_normalizeUrl_with_query_params() {
  const result = normalizeUrl("https://example.com/page?foo=bar&baz=qux");

  Assert.ok(result.success, "Should succeed for URL with query params");
  Assert.ok(result.url.includes("?"), "Should preserve query parameters");
});

// ============================================================================
// Test: normalizeUrl() - Failure Cases (Fail-Closed)
// ============================================================================

/**
 * Test that empty string fails
 */
add_task(async function test_normalizeUrl_empty_string() {
  const result = normalizeUrl("");

  Assert.ok(!result.success, "Should fail for empty string");
  Assert.ok(result.error, "Should return error");
});

/**
 * Test that whitespace-only string fails
 */
add_task(async function test_normalizeUrl_whitespace() {
  const result = normalizeUrl("   ");

  Assert.ok(!result.success, "Should fail for whitespace-only string");
  Assert.ok(result.error, "Should return error");
});

/**
 * Test that invalid URL format fails
 */
add_task(async function test_normalizeUrl_invalid_format() {
  const result = normalizeUrl("not-a-valid-url");

  Assert.ok(!result.success, "Should fail for invalid URL format");
  Assert.ok(result.error, "Should return error");
});

/**
 * Test that non-http/https schemes fail
 */
add_task(async function test_normalizeUrl_non_http_scheme() {
  const schemes = ["ftp://example.com", "file:///path", "javascript:alert(1)"];

  for (const url of schemes) {
    const result = normalizeUrl(url);
    Assert.ok(!result.success, `Should fail for scheme: ${url}`);
    Assert.ok(result.error, "Should return error");
  }
});

/**
 * Test that null/undefined fail gracefully
 */
add_task(async function test_normalizeUrl_null_undefined() {
  const resultNull = normalizeUrl(null);
  const resultUndefined = normalizeUrl(undefined);

  Assert.ok(!resultNull.success, "Should fail for null");
  Assert.ok(!resultUndefined.success, "Should fail for undefined");
});

// ============================================================================
// Test: normalizeUrl() - Normalization Behavior
// ============================================================================

/**
 * Test that fragments are removed
 */
add_task(async function test_normalizeUrl_strips_fragments() {
  const result = normalizeUrl("https://example.com/page#section");

  Assert.ok(result.success, "Should succeed");
  Assert.ok(!result.url.includes("#"), "Should strip fragment");
});

/**
 * Test that tracking parameters are removed
 */
add_task(async function test_normalizeUrl_strips_tracking() {
  const result = normalizeUrl(
    "https://example.com/page?utm_source=test&foo=bar"
  );

  Assert.ok(result.success, "Should succeed");
  Assert.ok(!result.url.includes("utm_"), "Should strip utm parameters");
  Assert.ok(
    result.url.includes("foo=bar"),
    "Should preserve non-tracking params"
  );
});

/**
 * Test that relative URLs work with baseUrl
 */
add_task(async function test_normalizeUrl_relative_with_base() {
  const result = normalizeUrl("/page", "https://example.com");

  Assert.ok(result.success, "Should succeed with baseUrl");
  Assert.ok(
    result.url.includes("example.com/page"),
    "Should resolve relative URL"
  );
});

// ============================================================================
// Test: isSameETLDPlusOne() - Same eTLD+1
// ============================================================================

/**
 * Test that same domain returns true
 */
add_task(async function test_isSameETLDPlusOne_same_domain() {
  const result = isSameETLDPlusOne(
    "https://example.com",
    "https://example.com"
  );

  Assert.ok(result, "Should return true for same domain");
});

/**
 * Test that subdomain and apex domain return true
 */
add_task(async function test_isSameETLDPlusOne_subdomain() {
  const result = isSameETLDPlusOne(
    "https://www.example.com",
    "https://example.com"
  );

  Assert.ok(result, "Should return true for subdomain vs apex");
});

/**
 * Test that different subdomains of same eTLD+1 return true
 */
add_task(async function test_isSameETLDPlusOne_different_subdomains() {
  const result = isSameETLDPlusOne(
    "https://blog.example.com",
    "https://shop.example.com"
  );

  Assert.ok(result, "Should return true for different subdomains");
});

// ============================================================================
// Test: isSameETLDPlusOne() - Different eTLD+1
// ============================================================================

/**
 * Test that different domains return false
 */
add_task(async function test_isSameETLDPlusOne_different_domains() {
  const result = isSameETLDPlusOne("https://example.com", "https://evil.com");

  Assert.ok(!result, "Should return false for different domains");
});

/**
 * Test that subdomain injection attempt returns false
 */
add_task(async function test_isSameETLDPlusOne_injection_attempt() {
  const result = isSameETLDPlusOne(
    "https://example.com",
    "https://example.com.evil.com"
  );

  Assert.ok(!result, "Should return false for subdomain injection attempt");
});

// ============================================================================
// Test: isSameETLDPlusOne() - Error Handling
// ============================================================================

/**
 * Test that invalid URLs return false (fail-closed)
 */
add_task(async function test_isSameETLDPlusOne_invalid_urls() {
  const result = isSameETLDPlusOne("not-a-url", "https://example.com");

  Assert.ok(!result, "Should return false for invalid URL (fail-closed)");
});

// ============================================================================
// Test: TabLedger - Basic Operations
// ============================================================================

/**
 * Test that TabLedger can be created
 */
add_task(async function test_TabLedger_creation() {
  const ledger = new TabLedger("tab-123");

  Assert.ok(ledger, "Should create ledger");
  Assert.equal(ledger.tabId, "tab-123", "Should store tab ID");
  Assert.equal(ledger.size(), 0, "Should start empty");
});

/**
 * Test that seed() adds URLs to ledger
 */
add_task(async function test_TabLedger_seed() {
  const ledger = new TabLedger("tab-123");
  const urls = ["https://example.com", "https://example.com/page"];

  ledger.seed(urls);

  Assert.ok(ledger.has("https://example.com"), "Should contain first URL");
  Assert.ok(
    ledger.has("https://example.com/page"),
    "Should contain second URL"
  );
  Assert.equal(ledger.size(), 2, "Should have correct size");
});

/**
 * Test that add() adds individual URLs
 */
add_task(async function test_TabLedger_add() {
  const ledger = new TabLedger("tab-123");

  ledger.add("https://example.com");

  Assert.ok(ledger.has("https://example.com"), "Should contain added URL");
  Assert.equal(ledger.size(), 1, "Should have size 1");
});

/**
 * Test that has() returns false for URLs not in ledger
 */
add_task(async function test_TabLedger_has_missing() {
  const ledger = new TabLedger("tab-123");
  ledger.add("https://example.com");

  Assert.ok(
    !ledger.has("https://evil.com"),
    "Should return false for missing URL"
  );
});

/**
 * Test that clear() empties the ledger
 */
add_task(async function test_TabLedger_clear() {
  const ledger = new TabLedger("tab-123");
  ledger.seed(["https://example.com", "https://example.com/page"]);

  ledger.clear();

  Assert.equal(ledger.size(), 0, "Should be empty after clear");
  Assert.ok(
    !ledger.has("https://example.com"),
    "Should not contain URLs after clear"
  );
});

// ============================================================================
// Test: TabLedger - TTL Expiration
// ============================================================================

/**
 * Test that URLs expire after TTL
 */
add_task(async function test_TabLedger_expiration() {
  const shortTTL = 100; // 100ms
  const ledger = new TabLedger("tab-123", shortTTL);

  ledger.add("https://example.com");
  Assert.ok(ledger.has("https://example.com"), "Should have URL initially");

  // Wait for expiration
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, shortTTL + 50));

  Assert.ok(
    !ledger.has("https://example.com"),
    "Should not have URL after TTL"
  );
});

// ============================================================================
// Test: TabLedger - Size Limits
// ============================================================================

/**
 * Test that ledger enforces size limit
 */
add_task(async function test_TabLedger_size_limit() {
  const maxUrls = 5;
  const ledger = new TabLedger("tab-123", 60000, maxUrls);

  // Try to add more than max
  for (let i = 0; i < maxUrls + 2; i++) {
    ledger.add(`https://example.com/page${i}`);
  }

  Assert.lessOrEqual(ledger.size(), maxUrls, "Should not exceed max size");
});

// ============================================================================
// Test: TabLedger - Invalid URLs
// ============================================================================

/**
 * Test that invalid URLs are rejected gracefully
 */
add_task(async function test_TabLedger_invalid_urls() {
  const ledger = new TabLedger("tab-123");

  ledger.add("not-a-url");
  ledger.add("");
  ledger.add(null);

  Assert.equal(ledger.size(), 0, "Should not add invalid URLs");
});

// ============================================================================
// Test: SessionLedger - Basic Operations
// ============================================================================

/**
 * Test that SessionLedger can be created
 */
add_task(async function test_SessionLedger_creation() {
  const session = new SessionLedger("session-123");

  Assert.ok(session, "Should create session ledger");
  Assert.equal(session.sessionId, "session-123", "Should store session ID");
  Assert.equal(session.tabCount(), 0, "Should start with no tabs");
});

/**
 * Test that forTab() creates and retrieves tab ledgers
 */
add_task(async function test_SessionLedger_forTab() {
  const session = new SessionLedger("session-123");

  const ledger1 = session.forTab("tab-1");
  const ledger2 = session.forTab("tab-1"); // Same tab

  Assert.ok(ledger1, "Should create ledger for tab-1");
  Assert.equal(ledger1, ledger2, "Should return same ledger for same tab");
  Assert.equal(session.tabCount(), 1, "Should have 1 tab");
});

/**
 * Test that different tabs get different ledgers
 */
add_task(async function test_SessionLedger_multiple_tabs() {
  const session = new SessionLedger("session-123");

  const ledger1 = session.forTab("tab-1");
  const ledger2 = session.forTab("tab-2");

  Assert.notEqual(
    ledger1,
    ledger2,
    "Different tabs should have different ledgers"
  );
  Assert.equal(session.tabCount(), 2, "Should have 2 tabs");
});

// ============================================================================
// Test: SessionLedger - Merge Operations
// ============================================================================

/**
 * Test that merge() combines URLs from multiple tabs
 */
add_task(async function test_SessionLedger_merge() {
  const session = new SessionLedger("session-123");

  const ledger1 = session.forTab("tab-1");
  const ledger2 = session.forTab("tab-2");

  ledger1.add("https://example.com/page1");
  ledger2.add("https://example.com/page2");

  const merged = session.merge(["tab-1", "tab-2"]);

  Assert.ok(
    merged.has("https://example.com/page1"),
    "Should have URL from tab-1"
  );
  Assert.ok(
    merged.has("https://example.com/page2"),
    "Should have URL from tab-2"
  );
  Assert.equal(merged.size(), 2, "Should have 2 URLs");
});

/**
 * Test that buildRequestScope() works correctly
 */
add_task(async function test_SessionLedger_buildRequestScope() {
  const session = new SessionLedger("session-123");

  const ledger1 = session.forTab("tab-1");
  ledger1.add("https://example.com/current");

  const ledger2 = session.forTab("tab-2");
  ledger2.add("https://example.com/mentioned");

  // Current tab only
  const scopeCurrentOnly = session.buildRequestScope({
    currentTabId: "tab-1",
  });

  Assert.ok(
    scopeCurrentOnly.has("https://example.com/current"),
    "Should have current tab URL"
  );
  Assert.ok(
    !scopeCurrentOnly.has("https://example.com/mentioned"),
    "Should not have mentioned tab URL when not specified"
  );

  // Current + mentioned tabs
  const scopeWithMentions = session.buildRequestScope({
    currentTabId: "tab-1",
    mentionedTabIds: ["tab-2"],
  });

  Assert.ok(
    scopeWithMentions.has("https://example.com/current"),
    "Should have current tab URL"
  );
  Assert.ok(
    scopeWithMentions.has("https://example.com/mentioned"),
    "Should have mentioned tab URL"
  );
});

// ============================================================================
// Test: SessionLedger - Tab Lifecycle
// ============================================================================

/**
 * Test that clearTab() clears a specific tab's ledger
 */
add_task(async function test_SessionLedger_clearTab() {
  const session = new SessionLedger("session-123");

  const ledger1 = session.forTab("tab-1");
  const ledger2 = session.forTab("tab-2");

  ledger1.add("https://example.com/page1");
  ledger2.add("https://example.com/page2");

  session.clearTab("tab-1");

  Assert.equal(ledger1.size(), 0, "tab-1 should be empty");
  Assert.equal(ledger2.size(), 1, "tab-2 should still have URL");
  Assert.equal(session.tabCount(), 2, "Should still track both tabs");
});

/**
 * Test that removeTab() removes a tab's ledger
 */
add_task(async function test_SessionLedger_removeTab() {
  const session = new SessionLedger("session-123");

  session.forTab("tab-1").add("https://example.com");
  session.forTab("tab-2").add("https://example.com");

  session.removeTab("tab-1");

  Assert.equal(session.tabCount(), 1, "Should have 1 tab after removal");

  // Getting the tab again should create a new empty ledger
  const newLedger = session.forTab("tab-1");
  Assert.equal(
    newLedger.size(),
    0,
    "New ledger for removed tab should be empty"
  );
});

/**
 * Test that clearAll() clears all tab ledgers
 */
add_task(async function test_SessionLedger_clearAll() {
  const session = new SessionLedger("session-123");

  session.forTab("tab-1").add("https://example.com");
  session.forTab("tab-2").add("https://example.com");

  session.clearAll();

  Assert.equal(session.tabCount(), 0, "Should have no tabs after clearAll");
});

// ============================================================================
// Test: Edge Cases - URL Normalization in Ledgers
// ============================================================================

/**
 * Test that ledgers normalize URLs consistently
 */
add_task(async function test_ledger_normalizes_urls() {
  const ledger = new TabLedger("tab-123");

  // Add URL with fragment
  ledger.add("https://example.com/page#section");

  // Check without fragment (should still match after normalization)
  Assert.ok(
    ledger.has("https://example.com/page"),
    "Should match normalized URL without fragment"
  );
});
