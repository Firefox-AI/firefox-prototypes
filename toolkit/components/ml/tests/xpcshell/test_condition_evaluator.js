/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for ConditionEvaluator.sys.mjs
 *
 * Note: ConditionEvaluator is an internal module used by PolicyEvaluator.
 * These tests verify it through SecurityOrchestrator (the public API) rather
 * than testing internal implementation details.
 *
 * Focus: Testing condition evaluation behavior through policy execution
 */

const { SecurityOrchestrator } = ChromeUtils.importESModule(
  "chrome://global/content/ml/security/SecurityOrchestrator.sys.mjs"
);

const PREF_SECURITY_ENABLED = "browser.smartwindow.security.enabled";

function setup() {
  Services.prefs.clearUserPref(PREF_SECURITY_ENABLED);
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, true);
  SecurityOrchestrator.reset();
}

function teardown() {
  Services.prefs.clearUserPref(PREF_SECURITY_ENABLED);
  SecurityOrchestrator.reset();
}

// ============================================================================
// Test: allUrlsIn Condition Behavior (via SecurityOrchestrator)
// ============================================================================

add_task(async function test_condition_passes_when_all_urls_in_ledger() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  const tabLedger = ledger.forTab("tab-1");
  tabLedger.add("https://example.com");
  tabLedger.add("https://mozilla.org");

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://example.com", "https://mozilla.org"],
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "Should allow when all URLs in ledger (condition passes)"
  );

  teardown();
});

add_task(async function test_condition_fails_when_url_missing_from_ledger() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  ledger.forTab("tab-1").add("https://example.com");

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://example.com", "https://evil.com"], // evil.com not in ledger
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Should deny when URL not in ledger (condition fails)"
  );
  Assert.equal(decision.code, "UNSEEN_LINK");

  teardown();
});

add_task(async function test_condition_passes_with_empty_urls_array() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  ledger.forTab("tab-1");

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: [], // Empty array
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "Should allow with empty URLs (nothing to check)"
  );

  teardown();
});

add_task(async function test_condition_fails_with_malformed_url() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  ledger.forTab("tab-1");

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["not-a-valid-url"],
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Should deny malformed URL (condition/validation fails)"
  );
  // Malformed URLs are treated as unseen (not in ledger) rather than
  // caught as specifically malformed at this layer
  Assert.equal(decision.code, "UNSEEN_LINK");

  teardown();
});

// ============================================================================
// Test: Ledger Merging (@Mentions)
// ============================================================================

add_task(async function test_condition_checks_current_tab_only() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  ledger.forTab("tab-1").add("https://example.com");

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://example.com"],
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "Should check current tab ledger only"
  );

  teardown();
});

add_task(async function test_condition_merges_mentioned_tabs() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();

  ledger.forTab("tab-1").add("https://example.com");
  ledger.forTab("tab-2").add("https://mozilla.org");

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://mozilla.org"],
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: ["tab-2"],
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "Should merge current tab + @mentioned tabs"
  );

  teardown();
});

// ============================================================================
// Test: URL Normalization
// ============================================================================

add_task(async function test_condition_normalizes_urls() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  ledger.forTab("tab-1").add("https://example.com/page"); // No fragment

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://example.com/page#section"], // Has fragment
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "Should allow after normalizing URLs (fragments stripped)"
  );

  teardown();
});
