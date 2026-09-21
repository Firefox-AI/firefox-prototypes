/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { BrowserControl } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/BrowserControl.sys.mjs"
);
const { Chat } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs"
);
const { Conversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Conversation.sys.mjs"
);
const { ChatConversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
);
const { AIWindow: AIWindowModule } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs"
);

const CONTROL_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Browser control fixture</title>
<style>
  body { margin: 0; }
  #controls { padding: 16px; }
  #spacer { height: 1800px; }
  #target-text { padding: 16px; }
</style>
<div id="controls">
<label for="agent-input">Agent input</label>
<input id="agent-input" value="before">
<label for="secret">Secret</label>
<input id="secret" type="password" value="never expose this">
<button id="run-action">Run action</button>
<output id="result">waiting</output>
</div>
<div id="spacer"></div>
<p id="target-text">Want personalized answers from Firefox?</p>
<script>
  document.getElementById("run-action").addEventListener("click", () => {
    document.getElementById("result").textContent =
      document.getElementById("agent-input").value;
  });
</script>`;

function findElement(state, name) {
  return state.elements.find(element => element.name.includes(name));
}

async function readFixture(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    input: content.document.getElementById("agent-input").value,
    result: content.document.getElementById("result").textContent,
  }));
}

async function readPageView(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    scrollY: content.scrollY,
    selection: content.getSelection().toString(),
  }));
}

function getLatestToolResult(options) {
  const message = options.args.findLast(item => item.role === "tool");
  return typeof message.content === "string"
    ? JSON.parse(message.content)
    : message.content;
}

add_task(async function test_direct_browser_read_write_navigation_and_tabs() {
  const { url, server } = serveHTML(CONTROL_PAGE);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url, true);
  const activeStub = sinon
    .stub(AIWindowModule, "isAIWindowActive")
    .returns(true);
  const conversation = new Conversation();
  let openedTab;

  try {
    const state = await BrowserControl.getState(
      {},
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(state.status, "ok", "Page state is readable");
    Assert.ok(state.text.includes("Agent input"), "Page text is read");

    const input = findElement(state, "Agent input");
    const password = findElement(state, "Secret");
    const button = findElement(state, "Run action");
    Assert.ok(input.actions.includes("type"), "Text input is typeable");
    Assert.ok(!password.actions.includes("type"), "Password is not typeable");
    Assert.ok(!("value" in password), "Password value is not exposed");

    const typed = await BrowserControl.type(
      {
        tab_id: state.tab_id,
        snapshot_id: state.snapshot_id,
        ref: input.ref,
        text: "driven by the model",
      },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(typed.status, "ok", "Typing succeeds");
    Assert.equal(typed.characters, 19, "Result reports only text length");

    const stale = await BrowserControl.click(
      {
        tab_id: state.tab_id,
        snapshot_id: state.snapshot_id,
        ref: button.ref,
      },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(stale.code, "stale_snapshot", "Used refs are rejected");

    const freshState = await BrowserControl.getState(
      { tab_id: state.tab_id },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    const freshButton = findElement(freshState, "Run action");
    const clicked = await BrowserControl.click(
      {
        tab_id: freshState.tab_id,
        snapshot_id: freshState.snapshot_id,
        ref: freshButton.ref,
      },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(clicked.status, "ok", "Clicking succeeds");
    Assert.deepEqual(
      await readFixture(tab.linkedBrowser),
      { input: "driven by the model", result: "driven by the model" },
      "The browser page receives both write actions"
    );

    const navigated = await BrowserControl.navigate(
      { tab_id: state.tab_id, url },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(navigated.status, "ok", "The controlled tab navigates");

    const bottom = await BrowserControl.scroll(
      { tab_id: state.tab_id, direction: "bottom" },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(bottom.status, "ok", "Scrolling succeeds");
    Assert.greater(bottom.scroll_y, 0, "The page scrolls down");
    Assert.equal(
      bottom.scroll_y,
      bottom.max_scroll_y,
      "The bottom direction reaches the page boundary"
    );

    const top = await BrowserControl.scroll(
      { tab_id: state.tab_id, direction: "top" },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(top.scroll_y, 0, "The top direction returns to the top");

    const found = await BrowserControl.findText(
      {
        tab_id: state.tab_id,
        text: "want personalized answers",
      },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(found.status, "ok", "Finding page text succeeds");
    Assert.ok(found.found, "The requested text is found");
    Assert.ok(found.highlighted, "The requested text is highlighted");
    const pageView = await readPageView(tab.linkedBrowser);
    Assert.greater(pageView.scrollY, 0, "Finding scrolls the match into view");
    Assert.equal(
      pageView.selection.toLowerCase(),
      "want personalized answers",
      "The browser selection highlights the matched text"
    );

    const opened = await BrowserControl.openTab(
      { url },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(opened.status, "ok", "A new controlled tab opens");
    openedTab = gBrowser.selectedTab;
    const openedState = await BrowserControl.getState(
      { tab_id: opened.tab_id },
      conversation,
      tab.linkedBrowser.browsingContext
    );
    Assert.equal(openedState.status, "ok", "The new tab is readable by ID");
  } finally {
    activeStub.restore();
    if (openedTab) {
      BrowserTestUtils.removeTab(openedTab);
    }
    BrowserTestUtils.removeTab(tab);
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_model_tool_loop_drives_page() {
  const { openAIEngine } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/openAIEngine.sys.mjs"
  );
  const { url, server } = serveHTML(CONTROL_PAGE);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url, true);
  const sandbox = sinon.createSandbox();
  sandbox.stub(AIWindowModule, "isAIWindowActive").returns(true);
  sandbox.stub(openAIEngine, "getFxAccountToken").resolves("test-token");
  let modelCall = 0;
  let controlledTabId;

  const fakeEngine = {
    model: "browser-control-test-model",
    getConfig() {
      return {};
    },
    runWithGenerator(options) {
      modelCall++;
      async function* generate() {
        if (modelCall === 1) {
          const toolNames = options.tools.map(tool => tool.function.name);
          Assert.ok(
            toolNames.includes("browser_state") &&
              toolNames.includes("browser_type") &&
              toolNames.includes("browser_click") &&
              toolNames.includes("browser_scroll") &&
              toolNames.includes("browser_find_text"),
            "The enabled browser-control tools are offered to the model"
          );
          yield {
            toolCalls: [
              {
                id: "state-1",
                function: { name: "browser_state", arguments: "{}" },
              },
            ],
          };
          return;
        }

        const state = getLatestToolResult(options);
        if (modelCall === 2) {
          controlledTabId = state.tab_id;
          const input = findElement(state, "Agent input");
          yield {
            toolCalls: [
              {
                id: "type-1",
                function: {
                  name: "browser_type",
                  arguments: JSON.stringify({
                    tab_id: state.tab_id,
                    snapshot_id: state.snapshot_id,
                    ref: input.ref,
                    text: "model loop wrote this",
                  }),
                },
              },
            ],
          };
          return;
        }
        if (modelCall === 3) {
          yield {
            toolCalls: [
              {
                id: "state-2",
                function: {
                  name: "browser_state",
                  arguments: JSON.stringify({ tab_id: controlledTabId }),
                },
              },
            ],
          };
          return;
        }
        if (modelCall === 4) {
          const button = findElement(state, "Run action");
          yield {
            toolCalls: [
              {
                id: "click-1",
                function: {
                  name: "browser_click",
                  arguments: JSON.stringify({
                    tab_id: state.tab_id,
                    snapshot_id: state.snapshot_id,
                    ref: button.ref,
                  }),
                },
              },
            ],
          };
          return;
        }
        if (modelCall === 5) {
          yield {
            toolCalls: [
              {
                id: "scroll-1",
                function: {
                  name: "browser_scroll",
                  arguments: JSON.stringify({
                    tab_id: controlledTabId,
                    direction: "bottom",
                  }),
                },
              },
            ],
          };
          return;
        }
        if (modelCall === 6) {
          yield {
            toolCalls: [
              {
                id: "find-1",
                function: {
                  name: "browser_find_text",
                  arguments: JSON.stringify({
                    tab_id: controlledTabId,
                    text: "want personalized answers",
                  }),
                },
              },
            ],
          };
          return;
        }
        yield { text: "The page was updated." };
      }
      return generate();
    },
  };

  try {
    const conversation = new ChatConversation({
      title: "browser control",
      description: "browser control test",
      pageUrl: new URL(url),
      pageMeta: {},
    });
    conversation.engine = fakeEngine;
    conversation.addUserMessage(
      "Fill the input, run it, then find and highlight the personalized answers text",
      url,
      0
    );
    conversation.addAssistantMessage("text", "");

    await Chat.fetchWithHistory({
      conversation,
      browsingContext: tab.linkedBrowser.browsingContext,
      mode: "fullpage",
    });

    Assert.equal(modelCall, 7, "The model completed the state/action loop");
    Assert.deepEqual(
      await readFixture(tab.linkedBrowser),
      { input: "model loop wrote this", result: "model loop wrote this" },
      "Model-issued tool calls changed the live page"
    );
    const pageView = await readPageView(tab.linkedBrowser);
    Assert.equal(
      pageView.selection.toLowerCase(),
      "want personalized answers",
      "Model-issued find highlighted the requested text"
    );
  } finally {
    sandbox.restore();
    BrowserTestUtils.removeTab(tab);
    await new Promise(resolve => server.stop(resolve));
  }
});
