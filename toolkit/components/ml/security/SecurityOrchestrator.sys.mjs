/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SessionLedger } from "chrome://global/content/ml/security/SecurityUtils.sys.mjs";
import { SecurityLogger } from "chrome://global/content/ml/security/SecurityLogger.sys.mjs";
import {
  EFFECT_ALLOW,
  allow,
  deny,
} from "chrome://global/content/ml/security/DecisionTypes.sys.mjs";
import { PolicyEvaluator } from "chrome://global/content/ml/security/PolicyEvaluator.sys.mjs";

/** Kill switch pref. When false, all security checks bypassed. Default: true */
const PREF_SECURITY_ENABLED = "browser.smartwindow.security.enabled";

/**
 * Checks if Smart Window security enforcement is enabled.
 *
 * @returns {boolean} True if security is enabled, false otherwise
 */
function isSecurityEnabled() {
  return Services.prefs.getBoolPref(PREF_SECURITY_ENABLED, true);
}

/**
 * Central security orchestrator for Firefox AI features.
 * Each AI Window instance should create its own SecurityOrchestrator.
 */
export class SecurityOrchestrator {
  /**
   * Registry of security policies by phase.
   *
   * @type {Map<string, Array<object>>}
   */
  #policies = new Map();

  /**
   * Session ledger for URL tracking across tabs in this window.
   *
   * @type {SessionLedger | null}
   */
  #sessionLedger = null;

  /**
   * Session identifier for this window.
   *
   * @type {string | null}
   */
  #sessionId = null;

  /**
   * Used by create() to instantiate SecurityOrchestrator instance.
   *
   * @param {string} sessionId - Unique identifier for this session
   */
  constructor(sessionId) {
    this.#sessionId = sessionId;
    this.#sessionLedger = new SessionLedger(sessionId);
  }

  /**
   * Creates and initializes a new SecurityOrchestrator instance.
   *
   * @param {string} sessionId - Unique identifier for this session
   * @returns {Promise<SecurityOrchestrator>} Initialized orchestrator instance
   */
  static async create(sessionId) {
    const instance = new SecurityOrchestrator(sessionId);
    await instance.#loadPolicies();

    console.warn(
      `[Security] Orchestrator initialized for session ${sessionId} with ${Array.from(
        instance.#policies.values()
      ).reduce((sum, policies) => sum + policies.length, 0)} policies`
    );

    return instance;
  }

  /**
   * Loads and validates policies from JSON files.
   *
   * @private
   */
  async #loadPolicies() {
    const policyFiles = ["tool-execution-policies.json"];

    const allPolicies = [];
    let totalLoaded = 0;
    let totalFailed = 0;

    for (const file of policyFiles) {
      try {
        const response = await fetch(
          `chrome://global/content/ml/security/policies/${file}`
        );

        if (!response.ok) {
          console.error(
            `[Security] Failed to fetch policy file ${file}: ${response.status}`
          );
          totalFailed++;
          continue;
        }

        const data = await response.json();

        // Validate policy file structure
        if (!data.policies || !Array.isArray(data.policies)) {
          console.error(
            `[Security] Invalid policy file structure in ${file}: missing 'policies' array`
          );
          totalFailed++;
          continue;
        }

        // Validate each policy
        for (const policy of data.policies) {
          const validation = PolicyEvaluator.validatePolicy(policy);
          if (!validation.valid) {
            console.error(
              `[Security] Invalid policy '${policy.id}' in ${file}:`,
              validation.errors
            );
            totalFailed++;
            continue;
          }

          allPolicies.push(policy);
          totalLoaded++;
        }

        console.warn(
          `[Security] Loaded ${data.policies.length} policies from ${file}`
        );
      } catch (error) {
        console.error(`[Security] Error loading policy file ${file}:`, error);
        totalFailed++;
      }
    }

    // Group policies by phase
    const policyMap = new Map();
    for (const policy of allPolicies) {
      if (!policyMap.has(policy.phase)) {
        policyMap.set(policy.phase, []);
      }
      policyMap.get(policy.phase).push(policy);
    }

    this.#policies = policyMap;

    console.warn(
      `[Security] Policy loading complete: ${totalLoaded} loaded, ${totalFailed} failed, ${policyMap.size} phases`
    );
  }

  /**
   * Resets the security orchestrator state.
   * Call this when the AI Window closes.
   */
  reset() {
    this.#sessionLedger = null;
    this.#sessionId = null;
    this.#policies.clear();
  }

  /**
   * Gets the session ledger for this orchestrator.
   *
   * @returns {SessionLedger | null} The session ledger
   * @throws {Error} If orchestrator not initialized AND security is enabled
   */
  getSessionLedger() {
    if (!this.#sessionLedger) {
      if (!isSecurityEnabled()) {
        return null;
      }

      throw new Error("Security orchestrator not initialized.");
    }
    return this.#sessionLedger;
  }

  /**
   * Main entry point for all security checks.
   *
   * @param {object} envelope - Security check request
   * @param {string} envelope.phase - Security phase ("tool.execution", etc.)
   * @param {object} envelope.action - Action being checked (type, tool, urls, etc.)
   * @param {object} envelope.context - Request context (tabId, requestId, etc.)
   * @returns {Promise<object>} Decision object with effect (allow/deny), code, reason
   */
  async evaluate(envelope) {
    const startTime = Date.now();

    try {
      if (!envelope || typeof envelope !== "object") {
        return deny("INVALID_REQUEST", "Security envelope is null or invalid");
      }

      const { phase, action, context } = envelope;
      if (!phase || !action || !context) {
        return deny(
          "INVALID_REQUEST",
          "Security envelope missing required fields (phase, action, or context)"
        );
      }

      if (!isSecurityEnabled()) {
        SecurityLogger.log({
          phase,
          action,
          context,
          decision: {
            effect: EFFECT_ALLOW,
            reason: "Security disabled via kill switch",
          },
          durationMs: Date.now() - startTime,
          killSwitchBypass: true,
        });
        return { effect: EFFECT_ALLOW };
      }

      const policies = this.#policies.get(phase);
      if (!policies || policies.length === 0) {
        console.warn(`[Security] No policies registered for phase: ${phase}`);
        return allow({ note: "No policies for phase" });
      }

      const fullContext = {
        ...context,
        sessionLedger: this.#sessionLedger,
        sessionId: this.#sessionId,
        timestamp: Date.now(),
      };

      const { currentTabId, mentionedTabIds = [] } = context;
      const tabsToCheck = [currentTabId, ...mentionedTabIds].filter(Boolean);
      const linkLedger = this.#sessionLedger.merge(tabsToCheck);
      fullContext.linkLedger = linkLedger;

      const decision = PolicyEvaluator.evaluatePhase(
        policies,
        action,
        fullContext
      );

      SecurityLogger.log({
        phase,
        action,
        context: fullContext,
        decision,
        durationMs: Date.now() - startTime,
      });

      return decision;
    } catch (error) {
      const errorDecision = deny(
        "EVALUATION_ERROR",
        "Security evaluation failed with unexpected error",
        { error: error.message || String(error) }
      );

      SecurityLogger.log({
        phase: envelope.phase || "unknown",
        action: envelope.action || {},
        context: envelope.context || {},
        decision: errorDecision,
        durationMs: Date.now() - startTime,
        error,
      });

      return errorDecision;
    }
  }

  /**
   * Removes all policies for a phase.
   *
   * @param {string} phase - Phase identifier to remove
   * @returns {boolean} True if policies were removed, false if not found
   */
  removePolicy(phase) {
    return this.#policies.delete(phase);
  }

  /**
   * Gets statistics about the orchestrator state.
   *
   * @returns {object} Stats object with registered policies, session info, etc.
   */
  getStats() {
    const totalPolicies = Array.from(this.#policies.values()).reduce(
      (sum, policies) => sum + policies.length,
      0
    );

    const policyBreakdown = {};
    for (const [phase, policies] of this.#policies.entries()) {
      policyBreakdown[phase] = {
        count: policies.length,
        policies: policies.map(p => ({
          id: p.id,
          enabled: p.enabled !== false,
        })),
      };
    }

    return {
      sessionId: this.#sessionId,
      initialized: this.#sessionLedger !== null,
      registeredPhases: Array.from(this.#policies.keys()),
      totalPolicies,
      policyBreakdown,
      sessionLedgerStats: this.#sessionLedger
        ? {
            tabCount: this.#sessionLedger.tabCount(),
            totalUrls: Array.from(this.#sessionLedger.tabs.values()).reduce(
              (sum, ledger) => sum + ledger.size(),
              0
            ),
          }
        : null,
    };
  }
}
