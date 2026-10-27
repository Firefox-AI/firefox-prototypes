/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { BrowseAgentUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/BrowseAgentUI.sys.mjs"
);
const { BrowseAgent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/BrowseAgent.sys.mjs"
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.browseAgent.enabled", true]],
  });
});

function agentBrowser() {
  return document.getElementById(BrowseAgentUI.BROWSER_ID);
}

add_task(async function test_open_pin_and_close() {
  await BrowseAgentUI.open(window);
  const browser = agentBrowser();
  Assert.ok(browser, "the agent browser was added to the sidebar box");
  Assert.ok(!browser.hidden, "the agent browser is shown");
  Assert.ok(BrowseAgentUI.isPinned(window), "the sidebar is pinned");
  Assert.ok(AIWindowUI.isSidebarOpen(window), "the sidebar is open");

  const panel = browser.contentDocument.querySelector("browse-agent-panel");
  Assert.ok(panel, "the panel loaded");
  Assert.equal(panel.state, "idle", "no session yet");
  Assert.ok(
    panel.shadowRoot.querySelector(".suggestion"),
    "suggested tasks are offered"
  );
  Assert.ok(
    !panel.shadowRoot.querySelector(".setup"),
    "the account provider does not ask for an API key"
  );

  AIWindowUI.closeSidebar(window);
  Assert.ok(
    AIWindowUI.isSidebarOpen(window),
    "a tab-switch style close keeps the pinned panel"
  );

  AIWindowUI.closeSidebar(window, "toggle");
  Assert.ok(!AIWindowUI.isSidebarOpen(window), "an explicit toggle closes it");
  Assert.ok(!BrowseAgentUI.isPinned(window), "and unpins it");
  Assert.ok(browser.hidden, "the agent browser is hidden again");
});

add_task(async function test_suggestion_fills_the_task() {
  await BrowseAgentUI.open(window);
  const panel =
    agentBrowser().contentDocument.querySelector("browse-agent-panel");
  const suggestion = panel.shadowRoot.querySelector(".suggestion");
  await TestUtils.waitForCondition(
    () => suggestion.textContent.trim(),
    "suggestion is localized"
  );
  suggestion.click();
  Assert.equal(panel.task, suggestion.textContent.trim(), "task prefilled");
  BrowseAgentUI.showChat(window);
  Assert.ok(!AIWindowUI.isSidebarOpen(window), "classic window closes sidebar");
  Assert.ok(!BrowseAgentUI.isPinned(window));
});

add_task(async function test_browse_command_starts_a_session() {
  const sandbox = sinon.createSandbox();
  const fakeSession = {
    state: "idle",
    entries: [],
    subscribe: () => () => {},
    answer: () => true,
    stop() {},
  };
  const startSession = sandbox
    .stub(BrowseAgent, "startSession")
    .returns(fakeSession);
  try {
    Assert.ok(
      !BrowseAgentUI.tryHandleCommand({ value: "/watch something", window }),
      "other commands are left alone"
    );
    Assert.ok(
      BrowseAgentUI.tryHandleCommand({ value: "/browse find a chair", window }),
      "/browse is handled"
    );
    await TestUtils.waitForCondition(
      () => startSession.calledOnce,
      "a session is started once the panel is ready"
    );
    Assert.equal(startSession.firstCall.args[0], window);
    Assert.equal(startSession.firstCall.args[1], "find a chair");
    Assert.ok(BrowseAgentUI.isPinned(window), "the panel took the sidebar");

    Assert.ok(
      BrowseAgentUI.tryHandleCommand({ command: "browse", value: "", window }),
      "the palette command opens the panel without a task"
    );
    Assert.ok(startSession.calledOnce, "an empty task starts nothing");
  } finally {
    sandbox.restore();
    BrowseAgentUI.showChat(window);
  }
});

add_task(async function test_disabled_pref_ignores_the_command() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.browseAgent.enabled", false]],
  });
  Assert.ok(
    !BrowseAgentUI.tryHandleCommand({ value: "/browse find a chair", window }),
    "the command is ignored while the prototype is disabled"
  );
  await SpecialPowers.popPrefEnv();
});
