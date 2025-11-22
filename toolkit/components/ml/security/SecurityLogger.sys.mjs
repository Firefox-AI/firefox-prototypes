/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const logConsole = console.createInstance({
  maxLogLevelPref: "browser.ml.logLevel",
  prefix: "SecurityLogger",
});

/**
 * Security audit logger (stub implementation).
 *
 * Security audit logger (stub - console only).
 * TODO: Full implementation in separate ticket (NDJSON, Glean, field hashing).
 */
export class SecurityLogger {
  /**
   * Logs a security decision event.
   *
   * @param {object} event - The security event to log
   * @param {string} event.phase - Security phase (tool.execution, etc.)
   * @param {object} event.action - Action that was checked
   * @param {object} event.context - Request context
   * @param {object} event.decision - Policy decision (allow/deny)
   * @param {number} event.durationMs - Evaluation duration in milliseconds
   * @param {Error} [event.error] - Optional error if evaluation failed
   */
  static log(event) {
    const { phase, decision, durationMs, error } = event;

    if (error) {
      logConsole.error(
        `[${phase}] Security evaluation error:`,
        error.message || error
      );
    } else if (decision.effect === "deny") {
      logConsole.warn(
        `[${phase}] DENY: ${decision.code} - ${decision.reason} (${durationMs}ms)`
      );
    } else {
      logConsole.debug(`[${phase}] ALLOW (${durationMs}ms)`);
    }
  }
}
