/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  allow,
  deny,
} from "chrome://global/content/ml/security/DecisionTypes.sys.mjs";
import { ConditionEvaluator } from "chrome://global/content/ml/security/ConditionEvaluator.sys.mjs";

/**
 * Evaluates JSON-based security policies using "first deny wins" strategy.
 * Delegates condition evaluation to ConditionEvaluator.
 */
export class PolicyEvaluator {
  /**
   * Checks if a policy's match criteria applies to an action.
   * Supports exact matches, OR conditions (pipe separator), and wildcards (*).
   *
   * Match criteria use dot-notation paths and support:
   * - Exact matches: "get_page_content"
   * - OR conditions: "get_page_content|search_history"
   * - Wildcards: "*" (matches anything)
   *
   * All criteria must match for policy to apply.
   *
   * @param {object} matchCriteria - Match object from policy
   * @param {object} action - Action to check against
   * @returns {boolean} True if policy applies to this action
   */
  static checkMatch(matchCriteria, action) {
    console.warn("[PolicyEvaluator] checkMatch criteria:", JSON.stringify(matchCriteria), "action:", JSON.stringify(action));
    if (!matchCriteria || typeof matchCriteria !== "object") {
      return false;
    }

    for (const [path, expectedValue] of Object.entries(matchCriteria)) {
      const actualValue = ConditionEvaluator.resolvePath(path, action, {});

      // Handle OR conditions with pipe separator
      // e.g., "get_page_content|search_history" or "get_page_content|*"
      if (typeof expectedValue === "string" && expectedValue.includes("|")) {
        const options = expectedValue.split("|");

        const matches = options.some(
          option => option === "*" || option === actualValue
        );

        if (!matches) {
          return false;
        }
      } else if (expectedValue === "*") {
        if (actualValue === undefined || actualValue === null) {
          return false;
        }
      } else if (actualValue !== expectedValue) {
        // Exact match required
        return false;
      }
    }

    return true;
  }

  /**
   * Evaluates a single policy against an action.
   * Returns null if policy doesn't apply, otherwise allow/deny decision.
   *
   * Process:
   * 1. Check if policy matches action (match criteria)
   * 2. If not, return null (policy doesn't apply)
   * 3. If matches, evaluate all conditions
   * 4. If any condition fails, return deny decision
   * 5. If all conditions pass, return allow decision
   *
   * @param {object} policy - Policy object from JSON
   * @param {string} policy.id - Unique policy identifier
   * @param {boolean} policy.enabled - Whether policy is active
   * @param {object} policy.match - Match criteria
   * @param {Array} policy.conditions - Conditions to evaluate
   * @param {string} policy.effect - "deny" or "allow"
   * @param {object} policy.onDeny - Denial information
   * @param {object} action - Action being evaluated
   * @param {object} context - Request context
   * @returns {object|null} Decision object or null if policy doesn't apply
   */
  static evaluatePolicy(policy, action, context) {
    if (policy.enabled === false) {
      return null;
    }

    if (!this.checkMatch(policy.match, action)) {
      return null;
    }

    for (const condition of policy.conditions) {
      const result = ConditionEvaluator.evaluate(condition, action, context);

      if (!result) {
        if (policy.effect === "deny") {
          return deny(policy.onDeny.code, policy.onDeny.reason, {
            policyId: policy.id,
            failedCondition: condition.type,
            conditionDescription: condition.description,
          });
        }

        return deny("POLICY_CONDITION_FAILED", "Policy condition not met", {
          policyId: policy.id,
          failedCondition: condition.type,
        });
      }
    }

    if (policy.effect === "deny") {
      return null;
    }

    return allow({
      policyId: policy.id,
      note: "All policy conditions satisfied",
    });
  }

  /**
   * Evaluates all policies for a phase against an action.
   *
   * Strategy: First deny wins (short-circuit evaluation)
   * - Iterate through policies in order
   * - First policy that denies terminates evaluation
   * - If no policies deny, allow
   *
   * @param {Array} policies - Array of policy objects for this phase
   * @param {object} action - Action being evaluated
   * @param {object} context - Request context
   * @returns {object} Decision object (allow or deny)
   */
  static evaluatePhase(policies, action, context) {
    if (!policies || policies.length === 0) {
      console.warn("[PolicyEvaluator] No policies provided for evaluation");
      return allow({ note: "No policies to evaluate" });
    }

    let appliedPolicies = 0;

    for (const policy of policies) {
      const decision = this.evaluatePolicy(policy, action, context);

      if (decision === null) {
        continue;
      }

      appliedPolicies++;

      if (decision.effect === "deny") {
        console.warn(
          `[PolicyEvaluator] Policy ${policy.id} denied action:`,
          decision.reason
        );
        return decision;
      }
    }

    if (appliedPolicies === 0) {
      console.warn(
        "[PolicyEvaluator] No policies applied to action:",
        action.type,
        action.tool || ""
      );
    }

    return allow({
      note: `Evaluated ${appliedPolicies} policies, none denied`,
    });
  }

  /**
   * Validates a policy object structure.
   *
   * Checks for required fields and valid values.
   * Used during policy loading to catch configuration errors.
   *
   * @param {object} policy - Policy object to validate
   * @returns {object} { valid: boolean, errors: string[] }
   */
  static validatePolicy(policy) {
    const errors = [];

    // Required fields
    if (!policy.id) {
      errors.push("Missing required field: id");
    }
    if (!policy.phase) {
      errors.push("Missing required field: phase");
    }
    if (!policy.match) {
      errors.push("Missing required field: match");
    }
    if (!policy.conditions) {
      errors.push("Missing required field: conditions");
    }
    if (!policy.effect) {
      errors.push("Missing required field: effect");
    }

    // Type validation
    if (policy.enabled !== undefined && typeof policy.enabled !== "boolean") {
      errors.push("Field 'enabled' must be boolean");
    }
    if (!Array.isArray(policy.conditions)) {
      errors.push("Field 'conditions' must be an array");
    }
    if (policy.effect !== "deny" && policy.effect !== "allow") {
      errors.push("Field 'effect' must be 'deny' or 'allow'");
    }

    // Conditional requirements
    if (policy.effect === "deny" && !policy.onDeny) {
      errors.push("Field 'onDeny' required when effect is 'deny'");
    }
    if (policy.onDeny && (!policy.onDeny.code || !policy.onDeny.reason)) {
      errors.push("Field 'onDeny' must have 'code' and 'reason'");
    }

    // Condition validation
    if (Array.isArray(policy.conditions)) {
      policy.conditions.forEach((condition, index) => {
        if (!condition.type) {
          errors.push(`Condition ${index}: missing 'type' field`);
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
