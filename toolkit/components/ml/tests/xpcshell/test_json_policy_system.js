/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Integration tests for JSON Policy System
 *
 * Focus: End-to-end flows with real JSON policies
 * - Real policy loading from tool-execution-policies.json
 * - Critical allow/deny flows
 * - Integration with SecurityOrchestrator
 * - @Mentions support
 */

const { SecurityOrchestrator } = ChromeUtils.importESModule(
  "chrome://global/content/ml/security/SecurityOrchestrator.sys.mjs"
);

const PREF_SECURITY_ENABLED = "browser.smartwindow.security.enabled";
const POLICY_JSON_URL =
  "chrome://global/content/ml/security/policies/tool-execution-policies.json";

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
// Test: JSON Policy File (Build-Time Validation)
// ============================================================================

add_task(async function test_json_policy_file_loads_and_validates() {
  const response = await fetch(POLICY_JSON_URL);
  const policyData = await response.json();

  // File exists and parses
  Assert.ok(response.ok, "Policy JSON should be accessible");
  Assert.ok(policyData.policies, "Should have policies array");
  Assert.greater(
    policyData.policies.length,
    0,
    "Should have at least one policy"
  );

  // First policy has required structure
  const policy = policyData.policies[0];
  Assert.ok(policy.id, "Policy should have id");
  Assert.ok(policy.phase, "Policy should have phase");
  Assert.ok(policy.effect, "Policy should have effect");

  teardown();
});

add_task(async function test_orchestrator_initializes_with_policies() {
  setup();

  // If init succeeds, policies loaded correctly
  const ledger = await SecurityOrchestrator.init("test-session");

  Assert.ok(ledger, "Should initialize successfully");
  Assert.ok(
    SecurityOrchestrator.getSessionLedger(),
    "Should have session ledger"
  );

  // Verify policies work by testing actual evaluation
  ledger.forTab("tab-1");
  const decision = await SecurityOrchestrator.evaluate({
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
    "Policies should be loaded and working (denies unseen URL)"
  );
  Assert.equal(
    decision.policyId,
    "block-unseen-links",
    "Should use JSON policy"
  );

  teardown();
});

// ============================================================================
// Test: End-to-End DENY Flow (CRITICAL SECURITY)
// ============================================================================

add_task(async function test_e2e_deny_unseen_link() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  ledger.forTab("tab-1"); // Empty ledger

  const decision = await SecurityOrchestrator.evaluate({
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
      requestId: "test-deny",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "CRITICAL: Should deny unseen URL (real policy from JSON)"
  );
  Assert.equal(
    decision.code,
    "UNSEEN_LINK",
    "Should have UNSEEN_LINK code from JSON policy"
  );
  Assert.equal(
    decision.policyId,
    "block-unseen-links",
    "Should be from block-unseen-links policy"
  );

  teardown();
});

add_task(async function test_e2e_deny_if_any_url_unseen() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  const tabLedger = ledger.forTab("tab-1");
  tabLedger.add("https://example.com");

  const decision = await SecurityOrchestrator.evaluate({
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
      requestId: "test-deny-multiple",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Should deny if ANY URL unseen (all-or-nothing security)"
  );
  Assert.equal(decision.code, "UNSEEN_LINK");

  teardown();
});

add_task(async function test_e2e_deny_malformed_url() {
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
      requestId: "test-malformed",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Should deny malformed URL (fail-closed)"
  );
  // Malformed URLs are treated as unseen (not in ledger) rather than
  // caught as specifically malformed
  Assert.equal(decision.code, "UNSEEN_LINK");

  teardown();
});

// ============================================================================
// Test: End-to-End ALLOW Flow (CRITICAL FUNCTIONALITY)
// ============================================================================

add_task(async function test_e2e_allow_seeded_url() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  const tabLedger = ledger.forTab("tab-1");
  tabLedger.add("https://example.com");

  const decision = await SecurityOrchestrator.evaluate({
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
      requestId: "test-allow",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "CRITICAL: Should allow seeded URL (real policy from JSON)"
  );

  teardown();
});

add_task(async function test_e2e_allow_multiple_seeded_urls() {
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
      requestId: "test-allow-multiple",
    },
  });

  Assert.equal(decision.effect, "allow", "Should allow when all URLs seeded");

  teardown();
});

add_task(async function test_e2e_allow_empty_urls() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  ledger.forTab("tab-1");

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: [], // No URLs to check
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test-empty",
    },
  });

  Assert.equal(decision.effect, "allow", "Should allow when no URLs to check");

  teardown();
});

// ============================================================================
// Test: @Mentions Integration (CRITICAL FEATURE)
// ============================================================================

add_task(async function test_e2e_allow_url_from_mentioned_tab() {
  setup();

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();

  // Current tab
  ledger.forTab("tab-1").add("https://example.com");

  // Mentioned tab (different URL)
  ledger.forTab("tab-2").add("https://mozilla.org");

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://mozilla.org"], // From @mentioned tab
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: ["tab-2"], // @mention tab-2
      requestId: "test-mention-allow",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "Should allow URL from @mentioned tab (merged ledger)"
  );

  teardown();
});

add_task(async function test_e2e_deny_url_not_in_mentioned_tabs() {
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
      urls: ["https://evil.com"], // Not in tab-1 or tab-2
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: ["tab-2"],
      requestId: "test-mention-deny",
    },
  });

  Assert.equal(
    decision.effect,
    "deny",
    "Should deny URL not in current or @mentioned tabs"
  );

  teardown();
});

// ============================================================================
// Test: URL Normalization
// ============================================================================

add_task(async function test_e2e_url_normalization_strips_fragments() {
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
      requestId: "test-normalize",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "Should allow after normalizing (fragments stripped)"
  );

  teardown();
});

// ============================================================================
// Test: Kill Switch Integration
// ============================================================================

add_task(async function test_e2e_kill_switch_bypasses_policies() {
  setup();

  // Disable security
  Services.prefs.setBoolPref(PREF_SECURITY_ENABLED, false);

  await SecurityOrchestrator.init("test-session");
  const ledger = SecurityOrchestrator.getSessionLedger();
  ledger.forTab("tab-1"); // Empty ledger

  const decision = await SecurityOrchestrator.evaluate({
    phase: "tool.execution",
    action: {
      type: "tool.call",
      tool: "get_page_content",
      urls: ["https://evil.com"], // Unseen, but kill switch is off
      tabId: "tab-1",
    },
    context: {
      currentTabId: "tab-1",
      mentionedTabIds: [],
      requestId: "test-killswitch",
    },
  });

  Assert.equal(
    decision.effect,
    "allow",
    "Kill switch OFF: should bypass all policies (allow everything)"
  );

  teardown();
});
