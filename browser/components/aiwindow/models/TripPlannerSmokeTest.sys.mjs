/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Trip Planner v1 — smoke test harness (cycle 3, BUILD-3 fix).
 *
 * Cycle 2's harness tried to reach into the <ai-chat-content> shadow DOM
 * directly from the chrome process. That fails because <ai-chat-content>
 * lives inside the content document of a remote <browser remote="true">
 * inside the <ai-window>'s shadow root — the chrome process can't read
 * `browser.contentDocument` of a remote browser.
 *
 * Cycle 3 routes the dispatch + read-back through the existing AIChatContent
 * JSWindowActor pair. The chrome side locates the <ai-window>'s aichat
 * <browser>, gets the AIChatContent parent actor, and calls
 * `actor.runSmokeTest(opts)` which sendQuery's to the child running inside
 * the remote process. The child does planTrip + dispatch + shadow-DOM
 * read-back + (optional) mutate_trip exercise, and returns a structured
 * summary.
 *
 * Usage from the chrome console (Cmd+Opt+I in a Smart Window-bearing window):
 *
 *   const m = ChromeUtils.importESModule(
 *     "moz-src:///browser/components/aiwindow/models/TripPlannerSmokeTest.sys.mjs"
 *   );
 *   await m.runOneShot();
 *   // -> "[TripPlannerSmokeTest] RESULT: PASS"
 */

const TAG = "[TripPlannerSmokeTest]";

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(TAG, ...args);
}

/**
 * Walk every chrome window looking for an <ai-window> element with a live
 * aichat <browser> we can route a JSWindowActor message into.
 *
 * The <ai-window> custom element lives inside the content document of the
 * #ai-window-browser chrome XUL element. The aichat <browser> ID is
 * "aichat-browser" inside <ai-window>'s shadow root.
 *
 * @returns {browser|null}
 */
function findAichatBrowser() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    const aiWinHost = win.document?.getElementById("ai-window-browser");
    const aiWinDoc = aiWinHost?.contentDocument;
    const aiWindowEl = aiWinDoc?.querySelector("ai-window");
    const aichatBrowser = aiWindowEl?.shadowRoot?.querySelector(
      "#aichat-browser, browser[id='aichat-browser']"
    );
    if (aichatBrowser) {
      return aichatBrowser;
    }
    // Fallback: walk gBrowser.tabs in case about:aichatcontent ever ends up
    // as a real top-level tab (out-of-band test setup).
    const tabs = win.gBrowser?.tabs ?? [];
    for (const tab of tabs) {
      try {
        const browser = tab.linkedBrowser;
        const url = browser?.currentURI?.spec || "";
        if (url.startsWith("about:aichatcontent")) {
          return browser;
        }
      } catch {}
    }
  }
  return null;
}

function getAichatActor(aichatBrowser) {
  const wg = aichatBrowser?.browsingContext?.currentWindowGlobal;
  if (!wg) {
    return null;
  }
  try {
    return wg.getActor("AIChatContent");
  } catch (e) {
    log("getActor failed:", e?.message || e);
    return null;
  }
}

/**
 * Run the smoke test by round-tripping through the JSWindowActor pair.
 *
 * @param {object} [opts]
 * @param {string} [opts.destination="San Francisco"]
 * @param {number} [opts.duration=3]
 * @param {boolean} [opts.exerciseMutation=true]
 * @returns {Promise<object>}
 */
export async function runSmokeTest({
  destination = "San Francisco",
  duration = 3,
  exerciseMutation = true,
} = {}) {
  const aichatBrowser = findAichatBrowser();
  if (!aichatBrowser) {
    const reason =
      "No aichat <browser> found. Open Smart Window first (the <ai-window> shadow root must contain #aichat-browser).";
    log("FAIL:", reason);
    return { pass: false, reason };
  }
  const actor = getAichatActor(aichatBrowser);
  if (!actor) {
    const reason =
      "Could not get AIChatContent actor from aichat browser's browsingContext.";
    log("FAIL:", reason);
    return { pass: false, reason };
  }

  let r;
  try {
    r = await actor.runSmokeTest({ destination, duration, exerciseMutation });
  } catch (e) {
    const reason = `actor.runSmokeTest threw: ${e?.message || e}`;
    log("FAIL:", reason);
    return { pass: false, reason };
  }
  return r;
}

/**
 * One-shot grep-friendly invocation. Logs a single
 * `[TripPlannerSmokeTest] RESULT: PASS|FAIL: <reason>` line that QA grep'd for
 * unchanged from cycle 2.
 *
 * @returns {Promise<string>}
 */
export async function runOneShot(opts) {
  const r = await runSmokeTest(opts);
  const summary = r.pass ? "PASS" : `FAIL: ${r.reason}`;
  // eslint-disable-next-line no-console
  console.log(`[TripPlannerSmokeTest] RESULT: ${summary}`);
  if (r.pass) {
    log(
      "Summary:",
      `dest=${r.plan?.destination} ` +
        `days=${r.plan?.day_count} ` +
        `daysRendered=${r.rendered?.dayCount} ` +
        `chips=${r.rendered?.populated?.tabChipCount ?? 0} ` +
        `flight=${r.rendered?.flightSlotPresent} ` +
        `hotel=${r.rendered?.hotelSlotPresent} ` +
        `slotOrder=${r.rendered?.slotOrderCorrect} ` +
        `mutFlash=${r.mutationChecks?.onlyOneActivityFlashed} ` +
        `hotelFilled=${r.mutationChecks?.hotelTransitionedToFilled}`
    );
  } else {
    log("Plan:", JSON.stringify(r.plan).slice(0, 400));
    log("Rendered:", JSON.stringify(r.rendered));
    log("MutationChecks:", JSON.stringify(r.mutationChecks));
  }
  return summary;
}
