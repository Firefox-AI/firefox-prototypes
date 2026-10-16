/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

Services.scriptloader.loadSubScript(
  new URL("head_smart_window.js", gTestPath).href,
  this
);

requestLongerTimeout(3);

describe("Smart Window model selection", () => {
  let doc, win;

  beforeEach(async function setup() {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.preferences.aiControls", true],
        ["browser.smartwindow.enabled", true],
        // TODO: Bug 2053495 - Refactor tests upon pref removal
        ["browser.smartwindow.mistralRelease", false],
        ["browser.smartwindow.tos.consentTime", 1770830464],
      ],
    });
  });

  afterEach(async () => {
    BrowserTestUtils.removeTab(gBrowser.selectedTab);

    // Clean up prefs that changed by tests
    Services.prefs.clearUserPref("browser.smartwindow.apiKey");
    Services.prefs.clearUserPref("browser.smartwindow.endpoint");
    Services.prefs.clearUserPref("browser.smartwindow.firstrun.modelChoice");
    Services.prefs.clearUserPref("browser.smartwindow.model");
    Services.prefs.clearUserPref("browser.smartwindow.customEndpoint");

    await SpecialPowers.popPrefEnv();
  });

  it("selects model from onboarding choice", async () => {
    await SpecialPowers.pushPrefEnv({
      set: [["browser.smartwindow.firstrun.modelChoice", "2"]],
    });

    ({ doc, win } = await openSmartWindowPanel());

    const modelSelection = doc.getElementById("modelSelection");
    Assert.equal(
      modelSelection.value,
      "2",
      "Model from onboarding choice is selected"
    );
  });

  it("shows model selection with no model selected, then selects a model", async () => {
    ({ doc, win } = await openSmartWindowPanel());

    const modelSelection = doc.getElementById("modelSelection");
    Assert.ok(modelSelection, "Model selection exists");
    Assert.ok(
      BrowserTestUtils.isVisible(modelSelection),
      "Model selection is visible"
    );
    Assert.equal(
      modelSelection.value,
      null,
      "No radio is selected if user didn't select model choices"
    );

    await assertRadioGroupAccessibleName(modelSelection);

    const fastRadio = doc.querySelector(
      'moz-radio[data-l10n-id="smart-window-model-fast"]'
    );
    fastRadio.click();

    await TestUtils.waitForCondition(
      () =>
        Services.prefs.getStringPref(
          "browser.smartwindow.firstrun.modelChoice",
          ""
        ) === "1",
      "Waiting for model pref to be saved"
    );

    Assert.equal(
      Services.prefs.getStringPref("browser.smartwindow.firstrun.modelChoice"),
      "1",
      "Model pref is saved"
    );

    fastRadio.focus();
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);

    await TestUtils.waitForCondition(
      () =>
        Services.prefs.getStringPref(
          "browser.smartwindow.firstrun.modelChoice",
          ""
        ) === "2",
      "Waiting for model pref to be saved via keyboard"
    );

    Assert.equal(
      Services.prefs.getStringPref("browser.smartwindow.firstrun.modelChoice"),
      "2",
      "Model pref is saved via keyboard"
    );
  });

  it("hides the auto model option when single page onboarding is off", async () => {
    ({ doc, win } = await openSmartWindowPanel());

    Assert.ok(
      !doc.querySelector('moz-radio[data-l10n-id="smart-window-model-auto"]'),
      "Auto model radio is not shown"
    );
  });

  it("shows and saves the auto model option", async () => {
    Services.fog.testResetFOG();
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.smartwindow.firstrun.singlePage", true],
        ["browser.smartwindow.firstrun.modelChoice", "1"],
      ],
    });

    ({ doc, win } = await openSmartWindowPanel());

    const modelSelection = doc.getElementById("modelSelection");
    const autoRadio = doc.querySelector(
      'moz-radio[data-l10n-id="smart-window-model-auto"]'
    );
    Assert.ok(autoRadio, "Auto model radio is shown");
    Assert.equal(
      modelSelection.querySelector("moz-radio"),
      autoRadio,
      "Auto model is the first option"
    );

    autoRadio.click();

    await TestUtils.waitForCondition(
      () =>
        Services.prefs.getStringPref(
          "browser.smartwindow.firstrun.modelChoice",
          ""
        ) === "4",
      "Waiting for auto model pref to be saved"
    );
    Assert.equal(modelSelection.value, "4", "Auto model is selected");

    const [event] = Glean.smartWindow.settingsModel.testGetValue();
    Assert.equal(event.extra.new_model, "auto", "Telemetry reports auto");
  });
});
