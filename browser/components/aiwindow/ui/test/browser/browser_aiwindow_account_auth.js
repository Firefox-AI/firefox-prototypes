/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AIWindowAccountAuth } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/AIWindowAccountAuth.sys.mjs"
);

const { SpecialMessageActions } = ChromeUtils.importESModule(
  "resource://messaging-system/lib/SpecialMessageActions.sys.mjs"
);

const { FxAccounts } = ChromeUtils.importESModule(
  "resource://gre/modules/FxAccounts.sys.mjs"
);

const { Spotlight } = ChromeUtils.importESModule(
  "resource:///modules/asrouter/Spotlight.sys.mjs"
);

/**
 * Sets up the sign-in flow so promptSignIn can be driven to any of its
 * outcomes. Resets Glean first so each task reads its own events.
 *
 * @param {object} options
 * @param {boolean} [options.signedIn] What isSignedIn resolves to
 * @param {boolean} [options.canConnect] What canConnectAccount resolves to
 * @param {boolean|Error} [options.flow] What fxaSignInFlow resolves to, or an
 *   Error for it to reject with
 * @returns {object} The sandbox and the fxaSignInFlow stub
 */
function stubSignInFlow({ signedIn = false, canConnect = true, flow = true }) {
  Services.fog.testResetFOG();

  const sb = sinon.createSandbox();
  const isSignedIn = sb
    .stub(AIWindowAccountAuth, "isSignedIn")
    .resolves(signedIn);
  sb.stub(FxAccounts, "canConnectAccount").resolves(canConnect);
  const fxaSignInFlow = sb.stub(SpecialMessageActions, "fxaSignInFlow");
  if (flow instanceof Error) {
    fxaSignInFlow.rejects(flow);
  } else {
    fxaSignInFlow.resolves(flow);
  }

  return { sb, isSignedIn, fxaSignInFlow };
}

function singleEventExtra(metric, name) {
  const events = metric.testGetValue();
  Assert.equal(events?.length, 1, `One ${name} was recorded`);
  return events[0].extra;
}

add_task(async function test_autoClose_false_when_firstrun_not_completed() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.firstrun.hasCompleted", false],
      ["browser.smartwindow.tos.consentTime", 0],
    ],
  });

  const stub = sinon
    .stub(SpecialMessageActions, "fxaSignInFlow")
    .resolves(true);

  try {
    await AIWindowAccountAuth.promptSignIn(gBrowser.selectedBrowser);

    Assert.ok(stub.calledOnce, "fxaSignInFlow should be called once");

    const callArgs = stub.getCall(0).args[0];
    Assert.equal(
      callArgs.autoClose,
      false,
      "autoClose should be false when firstrun has not completed"
    );
  } finally {
    stub.restore();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_autoClose_true_when_firstrun_completed() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.firstrun.hasCompleted", true],
      ["browser.smartwindow.tos.consentTime", 1735689600],
    ],
  });

  const stub = sinon
    .stub(SpecialMessageActions, "fxaSignInFlow")
    .resolves(true);

  try {
    await AIWindowAccountAuth.promptSignIn(gBrowser.selectedBrowser);

    Assert.ok(stub.calledOnce, "fxaSignInFlow should be called once");

    const callArgs = stub.getCall(0).args[0];
    Assert.equal(
      callArgs.autoClose,
      true,
      "autoClose should be true when firstrun has completed"
    );
  } finally {
    stub.restore();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_signin_flow_started_reason() {
  const cases = [
    { consentTime: 0, signedIn: false, reason: "both" },
    { consentTime: 0, signedIn: true, reason: "no_consent" },
    { consentTime: 1735689600, signedIn: false, reason: "signed_out" },
    { consentTime: 1735689600, signedIn: true, reason: "none" },
  ];

  for (const { consentTime, signedIn, reason } of cases) {
    await SpecialPowers.pushPrefEnv({
      set: [["browser.smartwindow.tos.consentTime", consentTime]],
    });
    const { sb } = stubSignInFlow({ signedIn });

    try {
      await AIWindowAccountAuth.promptSignIn(gBrowser.selectedBrowser);

      Assert.equal(
        singleEventExtra(
          Glean.smartWindow.signinFlowStarted,
          "signin_flow_started"
        ).reason,
        reason,
        `reason is ${reason} with consentTime ${consentTime} and signedIn ${signedIn}`
      );
    } finally {
      sb.restore();
      await SpecialPowers.popPrefEnv();
    }
  }
});

add_task(async function test_signin_flow_completed_outcome() {
  for (const [flow, outcome] of [
    [true, "completed"],
    [false, "abandoned"],
  ]) {
    const { sb } = stubSignInFlow({ flow });

    try {
      const didSignIn = await AIWindowAccountAuth.promptSignIn(
        gBrowser.selectedBrowser
      );

      Assert.equal(didSignIn, flow, "promptSignIn returns the flow result");
      Assert.equal(
        singleEventExtra(
          Glean.smartWindow.signinFlowCompleted,
          "signin_flow_completed"
        ).outcome,
        outcome,
        `outcome is ${outcome} when fxaSignInFlow resolves ${flow}`
      );
    } finally {
      sb.restore();
    }
  }
});

add_task(
  async function test_ensureAIWindowAccess_records_nothing_when_allowed() {
    await SpecialPowers.pushPrefEnv({
      set: [["browser.smartwindow.tos.consentTime", 1735689600]],
    });
    const { sb, fxaSignInFlow } = stubSignInFlow({ signedIn: true });

    try {
      Assert.ok(
        await AIWindowAccountAuth.ensureAIWindowAccess(
          gBrowser.selectedBrowser
        ),
        "Access is allowed"
      );
      Assert.ok(fxaSignInFlow.notCalled, "No sign-in flow is started");
      Assert.equal(
        Glean.smartWindow.signinFlowStarted.testGetValue(),
        null,
        "No signin_flow_started is recorded"
      );
    } finally {
      sb.restore();
      await SpecialPowers.popPrefEnv();
    }
  }
);

/**
 * Runs ensureAIWindowAccess as a signed-out guest with the Spotlight dialog
 * stubbed out.
 *
 * @param {object} options
 * @param {boolean} options.accept Whether the stubbed modal accepts the ToU
 * @returns {object} The access result and the Spotlight and sign-in stubs
 */
async function runGuestAccess({ accept }) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.guest.enabled", true],
      ["browser.smartwindow.tos.consentTime", 0],
    ],
  });
  const { sb, fxaSignInFlow } = stubSignInFlow({ signedIn: false });
  const showSpotlightDialog = sb
    .stub(Spotlight, "showSpotlightDialog")
    .callsFake(async () => {
      if (accept) {
        Services.prefs.setIntPref(
          "browser.smartwindow.tos.consentTime",
          1735689600
        );
      }
      return true;
    });

  try {
    const allowed = await AIWindowAccountAuth.ensureAIWindowAccess(
      gBrowser.selectedBrowser
    );
    return {
      allowed,
      hasToSConsent: AIWindowAccountAuth.hasToSConsent,
      showSpotlightDialog,
      fxaSignInFlow,
    };
  } finally {
    sb.restore();
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_guest_accepts_terms_of_use() {
  const { allowed, hasToSConsent, showSpotlightDialog, fxaSignInFlow } =
    await runGuestAccess({ accept: true });

  Assert.ok(allowed, "Guest is allowed in after accepting");
  Assert.ok(hasToSConsent, "Smart Window consent is recorded");
  Assert.ok(showSpotlightDialog.calledOnce, "The ToU modal is shown");
  Assert.equal(
    showSpotlightDialog.firstCall.args[1].id,
    "AI_WINDOW_TOU_GUEST_MODAL",
    "The guest ToU modal is shown"
  );
  Assert.ok(fxaSignInFlow.notCalled, "No sign-in flow is started");
});

add_task(async function test_guest_declines_terms_of_use() {
  const { allowed, hasToSConsent, showSpotlightDialog, fxaSignInFlow } =
    await runGuestAccess({ accept: false });

  Assert.ok(!allowed, "Guest is not allowed in after going back");
  Assert.ok(!hasToSConsent, "No Smart Window consent is recorded");
  Assert.ok(showSpotlightDialog.calledOnce, "The ToU modal is shown");
  Assert.ok(fxaSignInFlow.notCalled, "No sign-in flow is started");
});

add_task(async function test_signed_in_user_ignores_guest_mode() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.guest.enabled", true],
      ["browser.smartwindow.tos.consentTime", 0],
    ],
  });
  const { sb, fxaSignInFlow } = stubSignInFlow({ signedIn: true });
  const showSpotlightDialog = sb.stub(Spotlight, "showSpotlightDialog");

  try {
    await AIWindowAccountAuth.ensureAIWindowAccess(gBrowser.selectedBrowser);
    Assert.ok(fxaSignInFlow.calledOnce, "The account flow is used");
    Assert.ok(showSpotlightDialog.notCalled, "The guest modal is not shown");
  } finally {
    sb.restore();
    await SpecialPowers.popPrefEnv();
  }
});
