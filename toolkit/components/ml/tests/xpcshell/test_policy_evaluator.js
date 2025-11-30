/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for PolicyEvaluator.sys.mjs
 *
 * Note: PolicyEvaluator is used internally by SecurityOrchestrator.
 * These tests verify policy evaluation behavior through the public API
 * rather than testing internal implementation details.
 *
 * Focus: Policy matching, deny/allow effects, multiple conditions
 */

const { SecurityOrchestrator } = ChromeUtils.importESModule(
  "chrome://global/content/ml/security/SecurityOrchestrator.sys.mjs"
);

const PREF_SECURITY_ENABLED = "browser.smartwindow.security.enabled";

/** @type {SecurityOrchestrator|null} */
let orchestrator = null;

function setup() {
  Services.prefs.clearUserPref(PREF_SECURITY_ENABLED);
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, true);
}

function teardown() {
  Services.prefs.clearUserPref(PREF_SECURITY_ENABLED);
  orchestrator?.reset();
  orchestrator = null;
}

// ============================================================================
// Test: Policy Matching Behavior
// ============================================================================

add_task(async function test_policy_matches_correct_phase() {
  setup();

  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1");

  // tool.execution phase should match our policies
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
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Policy should match tool.execution phase"
  );
  Assert.equal(decision.policyId, "block-unseen-links");

  teardown();
});

add_task(async function test_policy_ignores_unknown_phase() {
  setup();

  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1");

  // Unknown phase should not match any policies
  const decision = await orchestrator.evaluate({
    phase: "unknown.phase",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://evil.com"],
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
    "Unknown phase should not match policies (allow by default)"
  );

  teardown();
});

// ============================================================================
// Test: Deny Effect (Core Security Logic)
// ============================================================================

add_task(async function test_deny_policy_denies_when_condition_fails() {
  setup();

  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1").add("https://example.com");

  // URL not in ledger = condition fails = deny
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
      requestId: "test",
    },
  });

  Assert.equal(decision.effect, "deny", "Should deny when condition fails");
  Assert.equal(decision.code, "UNSEEN_LINK");
  Assert.ok(decision.reason, "Should have reason");
  Assert.equal(decision.policyId, "block-unseen-links");
  Assert.ok(decision.details, "Should include failure details");

  teardown();
});

add_task(
  async function test_deny_policy_passes_through_when_condition_passes() {
    setup();

    orchestrator = await SecurityOrchestrator.create("test-session");
    const ledger = orchestrator.getSessionLedger();
    ledger.forTab("tab-1").add("https://example.com");

    // URL in ledger = condition passes = policy doesn't apply (allow)
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
        requestId: "test",
      },
    });

    Assert.equal(
      decision.effect,
      "allow",
      "Should allow when deny policy condition passes (policy doesn't apply)"
    );

    teardown();
  }
);

// ============================================================================
// Test: Multiple URLs (All-or-Nothing)
// ============================================================================

add_task(async function test_policy_checks_all_urls() {
  setup();

  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1").add("https://example.com");
  // Not adding evil.com

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
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Should deny if ANY URL fails condition (all-or-nothing)"
  );

  teardown();
});

add_task(async function test_policy_allows_when_all_urls_valid() {
  setup();

  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();
  const tabLedger = ledger.forTab("tab-1");
  tabLedger.add("https://example.com");
  tabLedger.add("https://mozilla.org");

  const decision = await orchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://example.com", "https://mozilla.org"], // Both OK
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
    "Should allow when all URLs pass condition"
  );

  teardown();
});

// ============================================================================
// Test: Tool Matching (Wildcard Support)
// ============================================================================

add_task(async function test_policy_applies_to_get_page_content() {
  setup();

  orchestrator = await SecurityOrchestrator.create("test-session");
  const ledger = orchestrator.getSessionLedger();
  ledger.forTab("tab-1");

  // Verify policy applies to get_page_content (the main URL-fetching tool)
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
      requestId: "test",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Policy should apply to get_page_content"
  );

  teardown();
});

// ============================================================================
// Test: Policy Information in Response
// ============================================================================

add_task(async function test_deny_decision_includes_policy_info() {
  setup();

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
      requestId: "test",
    },
  });

  // Verify decision structure
  Assert.equal(decision.effect, "deny", "Should have effect");
  Assert.equal(decision.code, "UNSEEN_LINK", "Should have code");
  Assert.ok(decision.reason, "Should have reason");
  Assert.equal(
    decision.policyId,
    "block-unseen-links",
    "Should identify policy"
  );
  Assert.ok(decision.details, "Should have details");
  Assert.ok(
    decision.details.failedCondition,
    "Should identify failed condition"
  );

  teardown();
});
