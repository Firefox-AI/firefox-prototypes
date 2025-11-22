/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for DecisionTypes.sys.mjs
 *
 * Tests the core type definitions and helpers for the security layer:
 * - SecurityPolicyError class (constructor, toJSON, throw/catch)
 * - Decision helper functions (allow, deny) - correct structure
 * - Type guards (isAllow, isDeny) - control flow correctness
 * - Constants (DenialCodes, ReasonPhrases) - expected values
 */

const {
  SecurityPolicyError,
  DenialCodes,
  ReasonPhrases,
  allow,
  deny,
  isAllow,
  isDeny,
} = ChromeUtils.importESModule(
  "chrome://global/content/ml/security/DecisionTypes.sys.mjs"
);

// ============================================================================
// Test: SecurityPolicyError Class
// ============================================================================

/**
 * Test that SecurityPolicyError constructor creates error with correct properties
 */
add_task(async function test_security_policy_error_constructor() {
  const decision = {
    effect: "deny",
    policyId: "test-policy",
    code: "TEST_CODE",
    reason: "Test reason message",
    details: { foo: "bar" },
  };

  const error = new SecurityPolicyError(decision);

  // Check properties that matter for error handling
  Assert.equal(error.name, "SecurityPolicyError", "Should have correct name");
  Assert.equal(
    error.message,
    "Test reason message",
    "Should have correct message"
  );
  Assert.equal(error.code, "TEST_CODE", "Should have correct code");
  Assert.equal(error.policyId, "test-policy", "Should have correct policyId");
  Assert.deepEqual(
    error.decision,
    decision,
    "Should store the full decision object"
  );
});

/**
 * Test that SecurityPolicyError.toJSON() serializes correctly
 */
add_task(async function test_security_policy_error_toJSON() {
  const decision = {
    effect: "deny",
    policyId: "test-policy",
    code: "TEST_CODE",
    reason: "Test reason",
    details: { url: "https://example.com" },
  };

  const error = new SecurityPolicyError(decision);
  const json = error.toJSON();

  // Check serialized structure has all required fields
  Assert.equal(json.name, "SecurityPolicyError", "JSON should include name");
  Assert.equal(json.code, "TEST_CODE", "JSON should include code");
  Assert.equal(json.policyId, "test-policy", "JSON should include policyId");
  Assert.equal(json.message, "Test reason", "JSON should include message");
  Assert.deepEqual(
    json.decision,
    decision,
    "JSON should include full decision"
  );

  // Verify it's JSON-serializable (critical for logging/telemetry)
  const serialized = JSON.stringify(json);
  const parsed = JSON.parse(serialized);
  Assert.equal(parsed.code, "TEST_CODE", "Should round-trip through JSON");
});

/**
 * Test that error can be thrown and caught (critical for control flow)
 */
add_task(async function test_error_throw_catch() {
  const decision = deny("TEST_CODE", "Test reason");

  try {
    throw new SecurityPolicyError(decision);
  } catch (error) {
    Assert.equal(
      error.name,
      "SecurityPolicyError",
      "Should catch as SecurityPolicyError"
    );
    Assert.equal(error.code, "TEST_CODE", "Should have correct code");
    Assert.equal(error.message, "Test reason", "Should have correct message");
  }
});

// ============================================================================
// Test: allow() Helper Function
// ============================================================================

/**
 * Test that allow() returns correct structure
 */
add_task(async function test_allow_helper() {
  const decision = allow();

  Assert.equal(decision.effect, "allow", "Should have effect 'allow'");
  Assert.equal(
    Object.keys(decision).length,
    1,
    "Should only have 'effect' property"
  );
});

// ============================================================================
// Test: deny() Helper Function
// ============================================================================

/**
 * Test deny() with all parameters
 */
add_task(async function test_deny_helper_full() {
  const decision = deny(
    "TEST_CODE",
    "Test reason",
    { url: "https://example.com" },
    "custom-policy"
  );

  Assert.equal(decision.effect, "deny", "Should have effect 'deny'");
  Assert.equal(decision.code, "TEST_CODE", "Should have correct code");
  Assert.equal(decision.reason, "Test reason", "Should have correct reason");
  Assert.equal(
    decision.policyId,
    "custom-policy",
    "Should have custom policyId"
  );
  Assert.deepEqual(
    decision.details,
    { url: "https://example.com" },
    "Should have correct details"
  );
});

/**
 * Test deny() with default policyId
 */
add_task(async function test_deny_helper_default_policy() {
  const decision = deny("TEST_CODE", "Test reason");

  Assert.equal(
    decision.policyId,
    "block-unseen-links",
    "Should use default policyId"
  );
  Assert.equal(
    decision.details,
    undefined,
    "Details should be undefined when not provided"
  );
});

// ============================================================================
// Test: isAllow() Type Guard
// ============================================================================

/**
 * Test isAllow() returns true for allow decisions
 */
add_task(async function test_isAllow_with_allow_decision() {
  const decision = allow();
  Assert.ok(isAllow(decision), "Should return true for allow decision");
});

/**
 * Test isAllow() returns false for deny decisions
 */
add_task(async function test_isAllow_with_deny_decision() {
  const decision = deny("CODE", "reason");
  Assert.ok(!isAllow(decision), "Should return false for deny decision");
});

/**
 * Test isAllow() handles null/undefined/invalid gracefully
 */
add_task(async function test_isAllow_with_invalid() {
  Assert.ok(!isAllow(null), "Should return false for null");
  Assert.ok(!isAllow(undefined), "Should return false for undefined");
  Assert.ok(!isAllow({}), "Should return false for empty object");
  Assert.ok(
    !isAllow({ effect: "maybe" }),
    "Should return false for invalid effect"
  );
});

// ============================================================================
// Test: isDeny() Type Guard
// ============================================================================

/**
 * Test isDeny() returns true for deny decisions
 */
add_task(async function test_isDeny_with_deny_decision() {
  const decision = deny("CODE", "reason");
  Assert.ok(isDeny(decision), "Should return true for deny decision");
});

/**
 * Test isDeny() returns false for allow decisions
 */
add_task(async function test_isDeny_with_allow_decision() {
  const decision = allow();
  Assert.ok(!isDeny(decision), "Should return false for allow decision");
});

/**
 * Test isDeny() handles null/undefined/invalid gracefully
 */
add_task(async function test_isDeny_with_invalid() {
  Assert.ok(!isDeny(null), "Should return false for null");
  Assert.ok(!isDeny(undefined), "Should return false for undefined");
  Assert.ok(!isDeny({}), "Should return false for empty object");
  Assert.ok(
    !isDeny({ effect: "maybe" }),
    "Should return false for invalid effect"
  );
});

// ============================================================================
// Test: DenialCodes Constants
// ============================================================================

/**
 * Test that DenialCodes has expected values
 */
add_task(async function test_denial_codes_values() {
  Assert.equal(
    DenialCodes.UNSEEN_LINK,
    "UNSEEN_LINK",
    "Should have UNSEEN_LINK code"
  );
  Assert.equal(
    DenialCodes.MALFORMED_URL,
    "MALFORMED_URL",
    "Should have MALFORMED_URL code"
  );
  Assert.equal(
    DenialCodes.MISSING_CONTEXT,
    "MISSING_CONTEXT",
    "Should have MISSING_CONTEXT code"
  );
  Assert.equal(
    DenialCodes.POLICY_DISABLED,
    "POLICY_DISABLED",
    "Should have POLICY_DISABLED code"
  );
});

// ============================================================================
// Test: ReasonPhrases Constants
// ============================================================================

/**
 * Test that ReasonPhrases has expected values
 */
add_task(async function test_reason_phrases_values() {
  Assert.equal(
    ReasonPhrases.UNSEEN_LINK,
    "URL not in selected request context",
    "Should have UNSEEN_LINK phrase"
  );
  Assert.equal(
    ReasonPhrases.MALFORMED_URL,
    "Failed to parse or normalize URL",
    "Should have MALFORMED_URL phrase"
  );
  Assert.equal(
    ReasonPhrases.MISSING_CONTEXT,
    "Missing required evaluation context",
    "Should have MISSING_CONTEXT phrase"
  );
  Assert.equal(
    ReasonPhrases.POLICY_DISABLED,
    "Policy enforcement disabled",
    "Should have POLICY_DISABLED phrase"
  );
});

// ============================================================================
// Test: Integration Scenarios
// ============================================================================

/**
 * Test complete flow: deny() -> SecurityPolicyError -> toJSON()
 * This validates the full error handling pipeline used in production
 */
add_task(async function test_deny_to_error_to_json() {
  const decision = deny(DenialCodes.UNSEEN_LINK, ReasonPhrases.UNSEEN_LINK, {
    url: "https://evil.com",
  });

  const error = new SecurityPolicyError(decision);
  const json = error.toJSON();

  Assert.equal(json.code, "UNSEEN_LINK", "Should preserve code through chain");
  Assert.equal(
    json.message,
    "URL not in selected request context",
    "Should preserve reason through chain"
  );
  Assert.equal(
    json.policyId,
    "block-unseen-links",
    "Should have default policyId"
  );
  Assert.deepEqual(
    json.decision.details,
    { url: "https://evil.com" },
    "Should preserve details through chain"
  );
});

/**
 * Test that allow/deny decisions work in control flow
 * This validates the pattern used throughout the codebase
 */
add_task(async function test_decision_control_flow() {
  const allowDecision = allow();
  const denyDecision = deny("CODE", "reason");

  // Simulate policy evaluation control flow
  function processDecision(decision) {
    if (isAllow(decision)) {
      return "allowed";
    } else if (isDeny(decision)) {
      return "denied";
    }
    return "unknown";
  }

  Assert.equal(
    processDecision(allowDecision),
    "allowed",
    "Should handle allow decision"
  );
  Assert.equal(
    processDecision(denyDecision),
    "denied",
    "Should handle deny decision"
  );
  Assert.equal(
    processDecision(null),
    "unknown",
    "Should handle invalid decision gracefully"
  );
});
