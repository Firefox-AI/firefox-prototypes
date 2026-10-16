/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const MODEL_PREF = "browser.smartwindow.firstrun.modelChoice";
const CONVERSATION_PREF =
  "browser.smartwindow.memories.generateFromConversation";
const HISTORY_PREF = "browser.smartwindow.memories.generateFromHistory";
const DEFAULT_WINDOW_PREF = "browser.smartwindow.isDefaultWindow";
const COMPLETE_PREF = "browser.smartwindow.firstrun.hasCompleted";

function withHomeRegion(region) {
  const originalRegion = Region.home;
  Region._setHomeRegion(region, false);
  registerCleanupFunction(() => {
    if (originalRegion) {
      Region._setHomeRegion(originalRegion, false);
    } else {
      Services.prefs.clearUserPref("browser.search.region");
    }
  });
}

async function setupSinglePage({ introMS = 0, waitForSettings = true } = {}) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.firstrun.singlePage", true],
      ["browser.smartwindow.firstrun.autoAdvanceMS", introMS],
      ["browser.smartwindow.mistralRelease", true],
      ["browser.smartwindow.firstrun.explainerURL", "https://example.com/"],
      [MODEL_PREF, ""],
      [CONVERSATION_PREF, true],
      [HISTORY_PREF, true],
      [DEFAULT_WINDOW_PREF, false],
      [COMPLETE_PREF, false],
    ],
  });

  const calls = [];
  const originalOpenLinkIn = window.openLinkIn;
  window.openLinkIn = (url, where) => {
    calls.push({ url, where });
    return null;
  };
  registerCleanupFunction(() => {
    window.openLinkIn = originalOpenLinkIn;
  });

  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    FIRSTRUN_URL
  );
  if (!waitForSettings) {
    return { tab, calls };
  }
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () =>
        content.document
          .querySelector("smartwindow-onboarding")
          ?.shadowRoot?.querySelector("#model-select"),
      "Single page onboarding renders"
    );
  });
  return { tab, calls };
}

add_task(async function test_single_page_defaults_to_auto_model() {
  Services.fog.testResetFOG();
  withHomeRegion("US");
  const { tab, calls } = await setupSinglePage();

  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const onboarding = content.document.querySelector("smartwindow-onboarding");
    const root = onboarding.shadowRoot;
    Assert.ok(
      !content.document.getElementById("multi-stage-message-root"),
      "about:welcome root is not used"
    );
    Assert.equal(
      root.querySelector("#model-select").value,
      "4",
      "Auto model is preselected"
    );
    Assert.equal(
      root.querySelector("#personalize-select").value,
      "both",
      "Learn from chats and browsing is preselected"
    );
    Assert.ok(
      root.querySelector("#default-checkbox").checked,
      "Default window checkbox is checked"
    );
    root.querySelector("#save-button").click();
  });

  await TestUtils.waitForCondition(
    () => Services.prefs.getBoolPref(COMPLETE_PREF),
    "First run is marked complete"
  );
  Assert.equal(Services.prefs.getStringPref(MODEL_PREF), "4");
  Assert.ok(Services.prefs.getBoolPref(CONVERSATION_PREF));
  Assert.ok(Services.prefs.getBoolPref(HISTORY_PREF));
  Assert.ok(Services.prefs.getBoolPref(DEFAULT_WINDOW_PREF));

  await TestUtils.waitForCondition(() => calls.length, "Explainer opened");
  Assert.equal(calls[0].url, "https://example.com/");
  Assert.equal(calls[0].where, "tab");

  const [complete] = Glean.smartWindow.onboardingComplete.testGetValue();
  Assert.deepEqual(complete.extra, {
    model: "4",
    memory_source: "memories-chats,memories-browsing",
    setdefault_source: "set-default-window",
  });
  const [impression] =
    Glean.smartWindow.onboardingScreenImpression.testGetValue();
  Assert.equal(impression.extra.message_id, "AI_WINDOW_SINGLE_PAGE");

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_single_page_europe_preselects_mistral() {
  withHomeRegion("DE");
  const { tab } = await setupSinglePage();

  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const root = content.document.querySelector(
      "smartwindow-onboarding"
    ).shadowRoot;
    Assert.equal(
      root.querySelector("#model-select").value,
      "3",
      "Mistral is preselected in Europe"
    );
  });
  Assert.equal(
    Services.prefs.getStringPref(MODEL_PREF),
    "",
    "Model pref is not written until save"
  );

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_single_page_saves_changed_choices() {
  Services.fog.testResetFOG();
  withHomeRegion("US");
  const { tab } = await setupSinglePage();

  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const root = content.document.querySelector(
      "smartwindow-onboarding"
    ).shadowRoot;
    const pick = async (selectId, value) => {
      const select = root.querySelector(selectId);
      await select.updateComplete;
      select.shadowRoot
        .querySelector(`.option-item[data-value="${value}"]`)
        .click();
      await select.updateComplete;
    };
    await pick("#model-select", "1");
    await pick("#personalize-select", "chats");
    root.querySelector("#default-checkbox").click();
    root.querySelector("#save-button").click();
  });

  await TestUtils.waitForCondition(
    () => Services.prefs.getBoolPref(COMPLETE_PREF),
    "First run is marked complete"
  );
  Assert.equal(Services.prefs.getStringPref(MODEL_PREF), "1");
  Assert.ok(Services.prefs.getBoolPref(CONVERSATION_PREF));
  Assert.ok(!Services.prefs.getBoolPref(HISTORY_PREF));
  Assert.ok(!Services.prefs.getBoolPref(DEFAULT_WINDOW_PREF));

  const [selected] = Glean.smartWindow.onboardingModelSelected.testGetValue();
  Assert.equal(selected.extra.model, "1");

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_single_page_shows_intro_first() {
  Services.fog.testResetFOG();
  withHomeRegion("US");
  const { tab } = await setupSinglePage({
    introMS: 600000,
    waitForSettings: false,
  });

  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () =>
        content.document
          .querySelector("smartwindow-onboarding")
          ?.shadowRoot?.querySelector(".intro"),
      "Intro renders"
    );
    const root = content.document.querySelector(
      "smartwindow-onboarding"
    ).shadowRoot;
    Assert.equal(
      root.querySelector(".intro .onboarding-title").dataset.l10nId,
      "aiwindow-firstrun-title",
      "Intro shows the welcome title"
    );
    Assert.ok(
      !root.querySelector("#model-select"),
      "Choices are hidden during the intro"
    );
  });

  const [impression] =
    Glean.smartWindow.onboardingScreenImpression.testGetValue();
  Assert.equal(impression.extra.message_id, "AI_WINDOW_INTRO");

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_single_page_advances_from_intro() {
  Services.fog.testResetFOG();
  withHomeRegion("US");
  const { tab } = await setupSinglePage({ introMS: 100 });

  const messageIds = Glean.smartWindow.onboardingScreenImpression
    .testGetValue()
    .map(event => event.extra.message_id);
  Assert.deepEqual(
    messageIds,
    ["AI_WINDOW_INTRO", "AI_WINDOW_SINGLE_PAGE"],
    "Intro then choices impressions are recorded"
  );

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
