/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * Unit tests for SecurityOrchestrator (JSON Policy System)
 *
 * Focus: Critical security boundaries and core functionality
 * - Kill switch behavior (security on/off)
 * - Policy execution (allow/deny with real policies)
 * - Envelope validation (security boundary)
 * - Error handling (fail-closed)
 */

const { SecurityOrchestrator } = ChromeUtils.importESModule(
  "chrome://global/content/ml/security/SecurityOrchestrator.sys.mjs"
);

const PREF_SECURITY_ENABLED = "browser.smartwindow.security.enabled";

/** @type {SecurityOrchestrator|null} */
let orchestrator = null;

function setup() {
  Services.prefs.clearUserPref(PREF_SECURITY_ENABLED);
}

function teardown() {
  Services.prefs.clearUserPref(PREF_SECURITY_ENABLED);
  orchestrator?.reset();
  orchestrator = null;
}

// =============================================================================
// Initialization Tests
// =============================================================================

add_task(async function test_initialization_creates_session() {
  setup();

  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();

  Assert.ok(ledger, "Should return session ledger");
  Assert.equal(ledger.tabCount(), 0, "Should start with no tabs");
  Assert.ok(
    orchestrator.getSessionLedger(),
    "Should be able to get session ledger"
  );

  teardown();
});

// =============================================================================
// Kill Switch Tests (CRITICAL SECURITY)
// =============================================================================

add_task(async function test_kill_switch_disabled_allows_everything() {
  setup();
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, false);

  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1"); // Empty ledger

  const decision = await orchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://evil.com"], // Unseen URL
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test-123",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "Kill switch OFF: should allow everything (pass-through)"
  );

  teardown();
});

add_task(async function test_kill_switch_enabled_enforces_policies() {
  setup();
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, true);

  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1");

  const decision = await orchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://evil.com"],
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test-123",
    },
  });

  Assert.equal(decision.effect, "deny", "Kill switch ON: should enforce");
  Assert.equal(decision.code, "UNSEEN_LINK", "Should deny unseen links");

  teardown();
});

add_task(async function test_kill_switch_runtime_change() {
  setup();

  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, true);
  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1");

  const envelope = {
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://evil.com"],
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "req-1",
    },
  };

  // Should deny when enabled
  let decision = await orchestrator.evaluate(envelope);
  Assert.equal(decision.effect, "deny", "Should deny when enabled");

  // Disable at runtime
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, false);

  // Should allow immediately
  decision = await orchestrator.evaluate(envelope);
  Assert.equal(
    decision.effect,
    "allow",
    "Should allow immediately after runtime disable"
  );

  teardown();
});

// =============================================================================
// Envelope Validation Tests (SECURITY BOUNDARY)
// =============================================================================

add_task(async function test_invalid_envelope_fails_closed() {
  setup();
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, true);
  orchestrator = await SecurityOrchestrator.create("test-session");

  const invalidEnvelopes = [
    null,
    { action: { type: "test" }, context: {} }, // missing phase
    { phase: "test", context: {} }, // missing action
    { phase: "test", action: { type: "test" } }, // missing context
  ];

  for (const envelope of invalidEnvelopes) {
    const decision = await orchestrator.evaluate(envelope);
    Assert.equal(
      decision.effect,
      "deny",
      "Invalid envelope should fail closed (deny)"
    );
    Assert.equal(decision.code, "INVALID_REQUEST", "Should have correct code");
  }

  teardown();
});

// =============================================================================
// Policy Execution Tests
// =============================================================================

add_task(async function test_policy_allows_seeded_url() {
  setup();
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, true);
  orchestrator = await SecurityOrchestrator.create("test-session");

  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1").add("https://example.com");

  const decision = await orchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://example.com"], // In ledger
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test-123",
    },
  });

  Assert.equal(decision.effect, "allow", "Should allow seeded URL");

  teardown();
});

add_task(async function test_policy_denies_unseen_url() {
  setup();
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, true);
  orchestrator = await SecurityOrchestrator.create("test-session");

  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1"); // Empty ledger

  const decision = await orchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://evil.com"], // Not in ledger
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test-123",
    },
  });

  Assert.equal(decision.effect, "deny", "Should deny unseen URL");
  Assert.equal(decision.code, "UNSEEN_LINK", "Should have UNSEEN_LINK code");
  Assert.ok(decision.reason, "Should have reason");
  Assert.equal(
    decision.policyId,
    "block-unseen-links",
    "Should identify policy"
  );

  teardown();
});

add_task(async function test_policy_denies_if_any_url_unseen() {
  setup();
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, true);
  orchestrator = await SecurityOrchestrator.create("test-session");

  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1").add("https://example.com");

  const decision = await orchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: [
        "https://example.com", // OK
        "https://evil.com", // NOT OK
      ],
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test-123",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Should deny if ANY URL unseen (all-or-nothing)"
  );

  teardown();
});

// =============================================================================
// Error Handling (FAIL-CLOSED)
// =============================================================================

add_task(async function test_malformed_url_fails_closed() {
  setup();
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, true);
  orchestrator = await SecurityOrchestrator.create("test-session");

  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1");

  const decision = await orchestrator.evaluate({
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
      requestId: "test-123",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Malformed URL should fail closed (deny)"
  );
  // Malformed URLs are treated as unseen (not in ledger) rather than
  // caught as specifically malformed
  Assert.equal(decision.code, "UNSEEN_LINK", "Should have UNSEEN_LINK code");

  teardown();
});
