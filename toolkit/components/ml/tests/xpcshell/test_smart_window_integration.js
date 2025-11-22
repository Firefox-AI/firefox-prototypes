/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for SmartWindowIntegration.sys.mjs
 *
 * Tests the Smart Window security layer integration:
 * - initSecurityLayer() - initialization
 * - getSessionLedger() - retrieval
 * - resetSecurityLayer() - cleanup
 * - handleTabClose() - tab lifecycle
 * - getRequestContext() - context building
 * - getSecurityLayerStats() - stats retrieval
 *
 * Note: seedCurrentTab() and handleNavigation() require browser/actor context
 * and are tested in integration tests (Step 8)
 *
 * Focus: Lifecycle management and context building
 */

const {
  initSecurityLayer,
  getSessionLedger,
  resetSecurityLayer,
  handleTabClose,
  getRequestContext,
  getSecurityLayerStats,
} = ChromeUtils.importESModule(
  "chrome://global/content/ml/security/SmartWindowIntegration.sys.mjs"
);

// ============================================================================
// Test Setup/Teardown
// ============================================================================

/**
 * Reset security layer before each test to ensure clean state
 */
add_setup(function () {
  resetSecurityLayer();
});

// ============================================================================
// Test: initSecurityLayer()
// ============================================================================

/**
 * Test that initSecurityLayer creates a new session
 */
add_task(async function test_initSecurityLayer_creates_session() {
  const session = initSecurityLayer();

  Assert.ok(session, "Should return SessionLedger");
  Assert.ok(session.sessionId, "Should have session ID");
  Assert.equal(session.tabCount(), 0, "Should start with no tabs");
});

/**
 * Test that initSecurityLayer accepts custom session ID
 */
add_task(async function test_initSecurityLayer_custom_id() {
  const customId = "test-session-123";
  const session = initSecurityLayer(customId);

  Assert.equal(session.sessionId, customId, "Should use custom session ID");
});

/**
 * Test that initSecurityLayer auto-generates ID when not provided
 */
add_task(async function test_initSecurityLayer_auto_id() {
  const session = initSecurityLayer();

  Assert.ok(session.sessionId, "Should have auto-generated session ID");
  Assert.ok(
    session.sessionId.startsWith("smart-window-"),
    "Should use smart-window prefix"
  );
});

// ============================================================================
// Test: getSessionLedger()
// ============================================================================

/**
 * Test that getSessionLedger returns initialized session
 */
add_task(async function test_getSessionLedger_returns_session() {
  const session1 = initSecurityLayer("test-session");
  const session2 = getSessionLedger();

  Assert.equal(session1, session2, "Should return same session instance");
});

/**
 * Test that getSessionLedger throws when not initialized
 */
add_task(async function test_getSessionLedger_throws_when_not_initialized() {
  resetSecurityLayer(); // Ensure not initialized

  Assert.throws(
    () => getSessionLedger(),
    /not initialized/,
    "Should throw when not initialized"
  );
});

// ============================================================================
// Test: resetSecurityLayer()
// ============================================================================

/**
 * Test that resetSecurityLayer clears the session
 */
add_task(async function test_resetSecurityLayer_clears_session() {
  initSecurityLayer("test-session");
  const session = getSessionLedger();

  // Add some data
  session.forTab("tab-1").add("https://example.com");
  Assert.equal(session.tabCount(), 1, "Should have tab before reset");

  resetSecurityLayer();

  Assert.throws(
    () => getSessionLedger(),
    /not initialized/,
    "Should throw after reset"
  );
});

/**
 * Test that resetSecurityLayer can be called multiple times safely
 */
add_task(async function test_resetSecurityLayer_idempotent() {
  initSecurityLayer("test-session");

  resetSecurityLayer();
  resetSecurityLayer(); // Should not throw

  Assert.ok(true, "Multiple resets should not throw");
});

/**
 * Test that resetSecurityLayer works when not initialized
 */
add_task(async function test_resetSecurityLayer_when_not_initialized() {
  // Don't initialize, just reset
  resetSecurityLayer();

  Assert.ok(true, "Reset when not initialized should not throw");
});

// ============================================================================
// Test: handleTabClose()
// ============================================================================

/**
 * Test that handleTabClose removes tab ledger
 */
add_task(async function test_handleTabClose_removes_tab() {
  initSecurityLayer("test-session");
  const session = getSessionLedger();

  // Add two tabs
  session.forTab("tab-1").add("https://example.com");
  session.forTab("tab-2").add("https://example.com");
  Assert.equal(session.tabCount(), 2, "Should have 2 tabs");

  handleTabClose("tab-1");

  Assert.equal(session.tabCount(), 1, "Should have 1 tab after close");
});

/**
 * Test that handleTabClose works for non-existent tab
 */
add_task(async function test_handleTabClose_nonexistent_tab() {
  initSecurityLayer("test-session");

  // Should not throw for non-existent tab
  handleTabClose("non-existent-tab");

  Assert.ok(true, "Closing non-existent tab should not throw");
});

// ============================================================================
// Test: getRequestContext()
// ============================================================================

/**
 * Test that getRequestContext builds context with current tab only
 */
add_task(async function test_getRequestContext_current_tab_only() {
  initSecurityLayer("test-session");
  const session = getSessionLedger();

  const ledger = session.forTab("tab-1");
  ledger.add("https://example.com/current");

  const context = getRequestContext("tab-1");

  Assert.ok(context.linkLedger, "Should have linkLedger");
  Assert.ok(
    context.linkLedger.has("https://example.com/current"),
    "Should have current tab URL"
  );
  Assert.ok(context.sessionId, "Should have sessionId");
  Assert.ok(context.requestId, "Should have requestId");
  Assert.equal(context.currentTabId, "tab-1", "Should have currentTabId");
});

/**
 * Test that getRequestContext includes mentioned tabs
 */
add_task(async function test_getRequestContext_with_mentions() {
  initSecurityLayer("test-session");
  const session = getSessionLedger();

  session.forTab("tab-1").add("https://example.com/current");
  session.forTab("tab-2").add("https://example.com/mentioned1");
  session.forTab("tab-3").add("https://example.com/mentioned2");

  const context = getRequestContext("tab-1", ["tab-2", "tab-3"]);

  Assert.ok(
    context.linkLedger.has("https://example.com/current"),
    "Should have current tab URL"
  );
  Assert.ok(
    context.linkLedger.has("https://example.com/mentioned1"),
    "Should have first mentioned tab URL"
  );
  Assert.ok(
    context.linkLedger.has("https://example.com/mentioned2"),
    "Should have second mentioned tab URL"
  );
  Assert.deepEqual(
    context.mentionedTabIds,
    ["tab-2", "tab-3"],
    "Should include mentionedTabIds"
  );
});

/**
 * Test that getRequestContext auto-generates request ID
 */
add_task(async function test_getRequestContext_auto_request_id() {
  initSecurityLayer("test-session");
  getSessionLedger().forTab("tab-1");

  const context = getRequestContext("tab-1");

  Assert.ok(context.requestId, "Should have auto-generated requestId");
  Assert.ok(context.requestId.startsWith("req-"), "Should use req- prefix");
});

/**
 * Test that getRequestContext accepts custom request ID
 */
add_task(async function test_getRequestContext_custom_request_id() {
  initSecurityLayer("test-session");
  getSessionLedger().forTab("tab-1");

  const customId = "custom-request-123";
  const context = getRequestContext("tab-1", [], customId);

  Assert.equal(context.requestId, customId, "Should use custom requestId");
});

/**
 * Test that getRequestContext handles empty mentioned tabs
 */
add_task(async function test_getRequestContext_empty_mentions() {
  initSecurityLayer("test-session");
  const session = getSessionLedger();

  session.forTab("tab-1").add("https://example.com");

  const context = getRequestContext("tab-1", []);

  Assert.ok(context.linkLedger, "Should have linkLedger");
  Assert.deepEqual(
    context.mentionedTabIds,
    [],
    "Should have empty mentionedTabIds"
  );
});

// ============================================================================
// Test: getSecurityLayerStats()
// ============================================================================

/**
 * Test that getSecurityLayerStats returns correct structure
 */
add_task(async function test_getSecurityLayerStats_structure() {
  initSecurityLayer("test-session-stats");
  const session = getSessionLedger();

  session.forTab("tab-1").add("https://example.com/page1");
  session.forTab("tab-2").add("https://example.com/page2");
  session.forTab("tab-2").add("https://example.com/page3");

  const stats = getSecurityLayerStats();

  Assert.equal(
    stats.sessionId,
    "test-session-stats",
    "Should have correct sessionId"
  );
  Assert.equal(stats.tabCount, 2, "Should have correct tabCount");
  Assert.equal(stats.totalUrls, 3, "Should have correct totalUrls");
  Assert.ok(Array.isArray(stats.tabIds), "Should have tabIds array");
  Assert.ok(Array.isArray(stats.tabStats), "Should have tabStats array");
  Assert.equal(stats.tabIds.length, 2, "Should have 2 tab IDs");
  Assert.equal(stats.tabStats.length, 2, "Should have 2 tab stats");
});

/**
 * Test that getSecurityLayerStats includes per-tab breakdown
 */
add_task(async function test_getSecurityLayerStats_per_tab() {
  initSecurityLayer("test-session");
  const session = getSessionLedger();

  session.forTab("tab-1").add("https://example.com/page1");
  session.forTab("tab-2").add("https://example.com/page2");
  session.forTab("tab-2").add("https://example.com/page3");

  const stats = getSecurityLayerStats();

  // Find stats for each tab
  const tab1Stats = stats.tabStats.find(s => s.tabId === "tab-1");
  const tab2Stats = stats.tabStats.find(s => s.tabId === "tab-2");

  Assert.ok(tab1Stats, "Should have stats for tab-1");
  Assert.ok(tab2Stats, "Should have stats for tab-2");
  Assert.equal(tab1Stats.urlCount, 1, "tab-1 should have 1 URL");
  Assert.equal(tab2Stats.urlCount, 2, "tab-2 should have 2 URLs");
});

/**
 * Test that getSecurityLayerStats works with empty session
 */
add_task(async function test_getSecurityLayerStats_empty_session() {
  initSecurityLayer("test-session");

  const stats = getSecurityLayerStats();

  Assert.equal(stats.tabCount, 0, "Should have 0 tabs");
  Assert.equal(stats.totalUrls, 0, "Should have 0 URLs");
  Assert.equal(stats.tabIds.length, 0, "Should have empty tabIds array");
  Assert.equal(stats.tabStats.length, 0, "Should have empty tabStats array");
});

// ============================================================================
// Test: Integration - Full Lifecycle
// ============================================================================

/**
 * Test complete lifecycle: init -> use -> reset
 */
add_task(async function test_full_lifecycle() {
  // Initialize
  const session = initSecurityLayer("lifecycle-test");
  Assert.ok(session, "Should initialize");

  // Add some data
  session.forTab("tab-1").add("https://example.com");
  const context = getRequestContext("tab-1");
  Assert.ok(context.linkLedger.has("https://example.com"), "Should have URL");

  // Get stats
  const stats = getSecurityLayerStats();
  Assert.equal(stats.tabCount, 1, "Should have 1 tab");

  // Close tab
  handleTabClose("tab-1");
  const statsAfterClose = getSecurityLayerStats();
  Assert.equal(statsAfterClose.tabCount, 0, "Should have 0 tabs after close");

  // Reset
  resetSecurityLayer();
  Assert.throws(
    () => getSessionLedger(),
    /not initialized/,
    "Should be uninitialized after reset"
  );
});

/**
 * Test that multiple init calls replace the session
 */
add_task(async function test_multiple_init_calls() {
  const session1 = initSecurityLayer("session-1");
  session1.forTab("tab-1").add("https://example.com");

  const session2 = initSecurityLayer("session-2");

  Assert.equal(session2.sessionId, "session-2", "Should have new session ID");
  Assert.equal(session2.tabCount(), 0, "New session should be empty");

  const currentSession = getSessionLedger();
  Assert.equal(currentSession, session2, "Should return newest session");
});
