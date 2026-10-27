/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { BrowseAgent, SESSION_STATE, ENTRY_TYPE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/BrowseAgent.sys.mjs"
);
const { MLTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/MLTestUtils.sys.mjs"
);

const SESSION_TEST_PAGE =
  "https://example.com/browser/browser/components/aiwindow/models/tests/browser/browse_agent_test_page.html";

let gEngine;
let gSandbox;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.browseAgent.enabled", true],
      ["browser.smartwindow.browseAgent.provider", "smartwindow"],
      ["browser.smartwindow.browseAgent.endpoint", ""],
      ["browser.smartwindow.browseAgent.apiKey", ""],
      ["browser.smartwindow.browseAgent.maxSteps", 20],
    ],
  });
  gSandbox = sinon.createSandbox();
  gEngine = new MLTestUtils.MockLLMEngine({});
  gSandbox.stub(openAIEngine, "_createEngine").callsFake(() => gEngine);
  gSandbox.stub(AuthProvider, "getToken").resolves("mock-fxa-token");
  BrowseAgent._resetEngineForTests();
  registerCleanupFunction(() => {
    BrowseAgent.getSession(window)?.stop();
    gEngine.rejectAllRequests();
    gSandbox.restore();
    BrowseAgent._resetEngineForTests();
  });
});

async function nextRequest() {
  await gEngine.waitForRunRequest();
  const [requestId, { request }] = gEngine.getNextRequest();
  return {
    request,
    respond: response => gEngine.respond(requestId, response),
  };
}

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function lastToolMessage(request) {
  return request.args.findLast(message => message.role === "tool");
}

function countImages(request) {
  let count = 0;
  for (const message of request.args) {
    if (Array.isArray(message.content)) {
      count += message.content.filter(part => part.type === "image_url").length;
    }
  }
  return count;
}

function readResult(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.document.getElementById("result").textContent
  );
}

add_task(async function test_session_runs_tools_until_done() {
  await BrowserTestUtils.withNewTab(SESSION_TEST_PAGE, async browser => {
    const session = BrowseAgent.startSession(
      window,
      "Add the chair to the cart"
    );
    Assert.equal(session.state, SESSION_STATE.RUNNING, "session is running");
    Assert.equal(session.tab, gBrowser.selectedTab, "web page tab is reused");
    Assert.equal(BrowseAgent.getSession(window), session, "session is tracked");

    let { request, respond } = await nextRequest();
    Assert.equal(request.token, "mock-fxa-token", "account token is sent");
    Assert.equal(request.args[0].role, "system", "system prompt comes first");
    const task = request.args[1];
    Assert.equal(task.role, "user");
    Assert.ok(
      task.content[0].text.includes("Add the chair to the cart"),
      "task text is sent"
    );
    Assert.ok(
      task.content.some(
        part =>
          part.type === "image_url" &&
          part.image_url.url.startsWith("data:image/jpeg;base64,")
      ),
      "the first screenshot is attached as an image part"
    );
    const toolNames = request.tools.map(tool => tool.function.name);
    for (const name of ["click", "type", "find", "select_option", "done"]) {
      Assert.ok(toolNames.includes(name), `${name} tool is offered`);
    }
    respond({
      finalOutput: "Looking for the button.",
      toolCalls: [toolCall("c1", "list_elements", {})],
    });

    ({ request, respond } = await nextRequest());
    const assistant = request.args.findLast(m => m.role === "assistant");
    Assert.equal(assistant.content, "Looking for the button.");
    Assert.equal(assistant.tool_calls[0].function.name, "list_elements");
    const listing = lastToolMessage(request);
    Assert.equal(listing.tool_call_id, "c1", "tool result references the call");
    const match = /\[\d+\] <button> "Add to cart" @\((\d+),(\d+)\)/.exec(
      listing.content
    );
    Assert.ok(match, "the listing has screenshot coordinates for the button");
    // Every screenshot also numbers the clickable elements; click by number.
    const numbered = /\[(\d+)\] <button> "Add to cart"/.exec(
      task.content[0].text
    );
    Assert.ok(numbered, "the task screenshot lists the button with a number");
    respond({
      finalOutput: "",
      toolCalls: [
        toolCall("c2", "click_element", { index: Number(numbered[1]) }),
      ],
    });

    ({ request, respond } = await nextRequest());
    Assert.equal(
      await readResult(browser),
      "added",
      "the click reached the page"
    );
    Assert.ok(
      lastToolMessage(request).content.includes("Clicked element"),
      "click result is reported"
    );
    const last = request.args.at(-1);
    Assert.equal(last.role, "user", "the screenshot follows the tool result");
    Assert.ok(
      last.content.some(part => part.type === "image_url"),
      "the screenshot is an image part"
    );
    respond({
      finalOutput: "",
      toolCalls: [toolCall("c3", "ask_user", { question: "Which size?" })],
    });

    await TestUtils.waitForCondition(
      () => session.state === SESSION_STATE.WAITING_FOR_USER,
      "session waits for the user"
    );
    Assert.ok(
      session.entries.some(
        e => e.type === ENTRY_TYPE.QUESTION && e.text === "Which size?"
      ),
      "question is logged"
    );
    Assert.ok(session.answer("Large"), "answer is accepted");
    Assert.ok(!session.answer("again"), "a second answer has nowhere to go");

    ({ request, respond } = await nextRequest());
    Assert.equal(session.state, SESSION_STATE.RUNNING, "session resumed");
    Assert.ok(
      lastToolMessage(request).content.includes("User reply: Large"),
      "the reply is passed to the model"
    );
    respond({
      finalOutput: "",
      toolCalls: [
        {
          id: "c4",
          type: "function",
          function: { name: "click", arguments: "{oops" },
        },
      ],
    });

    ({ request, respond } = await nextRequest());
    Assert.ok(
      lastToolMessage(request).content.includes("not valid JSON"),
      "malformed arguments are reported back to the model"
    );
    Assert.ok(
      session.entries.some(e => e.type === ENTRY_TYPE.ACTION && e.failed),
      "the failure is logged"
    );
    respond({
      finalOutput: "",
      toolCalls: [toolCall("c4b", "click", { x: 99999, y: 99999 })],
    });

    ({ request, respond } = await nextRequest());
    Assert.ok(
      lastToolMessage(request).content.includes("outside the screenshot"),
      "clicks outside the screenshot are refused"
    );
    respond({
      finalOutput: "",
      toolCalls: [toolCall("c4c", "click_element", { index: 9999 })],
    });

    ({ request, respond } = await nextRequest());
    Assert.ok(
      lastToolMessage(request).content.includes("no element 9999"),
      "unknown element numbers are refused"
    );
    respond({
      finalOutput: "",
      toolCalls: [
        toolCall("c5", "done", { summary: "Chair added.", success: true }),
      ],
    });

    await TestUtils.waitForCondition(
      () => session.state === SESSION_STATE.DONE,
      "session finishes"
    );
    Assert.deepEqual(session.result, {
      summary: "Chair added.",
      success: true,
    });
    Assert.equal(session.stepCount, 7, "seven model turns were used");
    const types = session.entries.map(e => e.type);
    Assert.ok(types.includes(ENTRY_TYPE.TASK));
    Assert.ok(types.includes(ENTRY_TYPE.ASSISTANT));
    Assert.ok(types.includes(ENTRY_TYPE.ANSWER));
    Assert.equal(
      types.at(-1),
      ENTRY_TYPE.STATE,
      "state change is the last entry"
    );
    Assert.equal(session.entries.at(-2).type, ENTRY_TYPE.DONE);
    Assert.ok(
      session.entries.some(e => e.type === ENTRY_TYPE.ACTION && e.image),
      "actions carry screenshots for the panel"
    );
  });
});

add_task(async function test_only_recent_screenshots_stay_in_context() {
  await BrowserTestUtils.withNewTab(SESSION_TEST_PAGE, async () => {
    const session = BrowseAgent.startSession(window, "Look around");
    let { request, respond } = await nextRequest();
    Assert.equal(countImages(request), 1, "the task screenshot is in context");
    for (let i = 0; i < 5; i++) {
      respond({
        finalOutput: "",
        toolCalls: [toolCall(`s${i}`, "screenshot", {})],
      });
      ({ request, respond } = await nextRequest());
    }
    Assert.equal(countImages(request), 3, "older screenshots are dropped");
    Assert.ok(
      lastToolMessage(request).content.includes("times in a row"),
      "identical repeated actions are called out to the model"
    );
    Assert.ok(
      request.args.some(
        m => m.role === "tool" && m.content.includes("omitted from context")
      ),
      "dropped screenshots are mentioned in the tool result"
    );
    respond({ finalOutput: "All done.", toolCalls: [] });
    await TestUtils.waitForCondition(
      () => session.state === SESSION_STATE.DONE
    );
    Assert.equal(
      session.result.summary,
      "All done.",
      "a plain reply ends the session"
    );
  });
});

add_task(async function test_stop_aborts_the_session() {
  await BrowserTestUtils.withNewTab(SESSION_TEST_PAGE, async () => {
    const session = BrowseAgent.startSession(window, "Something long");
    const { respond } = await nextRequest();
    session.stop();
    Assert.equal(session.state, SESSION_STATE.STOPPED);
    Assert.ok(!session.isActive);
    respond({
      finalOutput: "",
      toolCalls: [toolCall("late", "screenshot", {})],
    });
    await TestUtils.waitForTick();
    Assert.equal(gEngine.runRequests.size, 0, "no further request is made");
    Assert.equal(session.state, SESSION_STATE.STOPPED, "stays stopped");
  });
});

add_task(async function test_tab_close_fails_the_session() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    SESSION_TEST_PAGE
  );
  const session = BrowseAgent.startSession(window, "Something");
  const { respond } = await nextRequest();
  BrowserTestUtils.removeTab(tab);
  Assert.equal(session.state, SESSION_STATE.ERROR, "closing the tab fails it");
  Assert.ok(
    session.entries.some(
      e => e.type === ENTRY_TYPE.ERROR && e.text.includes("closed")
    ),
    "the error is logged"
  );
  respond({ finalOutput: "", toolCalls: [] });
  await TestUtils.waitForTick();
  Assert.equal(gEngine.runRequests.size, 0, "no further request is made");
});

add_task(async function test_provider_configuration() {
  Assert.equal(BrowseAgent.provider, "smartwindow");
  Assert.ok(!BrowseAgent.needsApiKey(), "the account provider needs no key");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.browseAgent.provider", "anthropic"],
      ["browser.smartwindow.browseAgent.apiKey", ""],
    ],
  });
  Assert.equal(BrowseAgent.provider, "anthropic");
  Assert.ok(BrowseAgent.needsApiKey(), "the Anthropic provider needs a key");
  BrowseAgent.setApiKey("  sk-test  ");
  Assert.equal(BrowseAgent.getApiKey(), "sk-test", "keys are trimmed");
  Assert.ok(!BrowseAgent.needsApiKey());
  await SpecialPowers.popPrefEnv();
  Assert.equal(BrowseAgent.provider, "smartwindow", "pref change is live");
});
