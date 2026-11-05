/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AssistantSession } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/AssistantSession.sys.mjs"
);
const { AssistantGuards } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/AssistantGuards.sys.mjs"
);
const { GetPageContent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);
const { ChatStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs"
);
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const PAGE_URL =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com"
  ) + "test_context_url_page.html";

async function waitForGuardRows(renderer, expected, expectedTexts = []) {
  return TestUtils.waitForCondition(
    async () => {
      const state = await SpecialPowers.spawn(renderer, [], async () => {
        const chat = content.document.querySelector("ai-chat-content");
        await chat.updateComplete;
        const card = chat.shadowRoot.querySelector("ai-action-result");
        if (!card) {
          return { labels: [], texts: [] };
        }
        const log = card.wrappedJSObject || card;
        log.isExpanded = true;
        await log.updateComplete;
        await content.document.l10n.translateFragment(log.shadowRoot);
        return {
          labels: log.rows.map(row => row.labelL10nId),
          texts: [
            ...log.shadowRoot.querySelectorAll(
              ".action-result-expanded-row-label"
            ),
          ].map(label =>
            label.textContent.replace(/[\u2066-\u2069]/gu, "").trim()
          ),
        };
      });
      return (
        JSON.stringify(state.labels) === JSON.stringify(expected) &&
        state.texts.length === expected.length &&
        state.texts.every(text => text.includes("model")) &&
        expectedTexts.every(text =>
          state.texts.some(label => label.includes(text))
        )
      );
    },
    `The action log shows ${expected.join(", ")}`
  );
}

add_task(async function test_guard_calls_render_pending_results_and_restore() {
  await AssistantSession.clear();
  const mock = new MockEngineManager();
  let win;
  try {
    const conversation = AssistantSession.conversation;
    conversation.addUserMessage("Read this page", new URL(PAGE_URL));
    const opened = await openAIWindowWithSidebar(PAGE_URL);
    win = opened.win;
    const chat =
      opened.sidebarBrowser.contentDocument.querySelector("ai-window");
    const renderer = await getAichatBrowser(opened.sidebarBrowser);
    for (const name of ["checkToolCall", "isPageContentSafe"]) {
      const stub = AssistantGuards[name];
      stub.restore();
      mock.mocks = mock.mocks.filter(item => item !== stub);
    }
    const guard = Promise.withResolvers();
    const injection = Promise.withResolvers();
    const run = sinon.stub();
    run.onCall(0).returns(guard.promise);
    run.onCall(1).returns(injection.promise);
    run.onCall(2).returns(new Promise(() => {}));
    run.onCall(3).resolves({ finalOutput: "ALLOW" });
    run.onCall(4).resolves({ finalOutput: "INJECTION" });
    run.onCall(5).resolves({ finalOutput: "ALLOW" });
    run.onCall(6).rejects(new Error("Classifier unavailable"));
    conversation.engine = { run };
    const turn = AssistantSession.beginTurn();
    const reading = GetPageContent.getPageContent(
      { url_list: [PAGE_URL] },
      conversation
    );
    await waitForGuardRows(
      renderer,
      ["action-log-tool-guard-checking-action"],
      ["whether reading page content is needed"]
    );
    guard.resolve({ finalOutput: "ALLOW" });
    await waitForGuardRows(renderer, [
      "action-log-tool-guard-allowed-action",
      "action-log-prompt-injection-checking",
    ]);
    injection.resolve({ finalOutput: "CLEAN" });
    Assert.ok((await reading)[0].ok);
    const completed = [
      "action-log-tool-guard-allowed-action",
      "action-log-prompt-injection-passed",
    ];
    await waitForGuardRows(renderer, completed, [
      "allowed reading page content",
      "check passed",
    ]);
    await SpecialPowers.spawn(renderer, [], () => {
      const card = content.document
        .querySelector("ai-chat-content")
        .shadowRoot.querySelector("ai-action-result");
      const log = card.wrappedJSObject || card;
      Assert.equal(
        log.labelL10nId,
        "action-log-prompt-injection-passed",
        "The current summary shows the verdict instead of saying the check is still running"
      );
    });

    const controller = new AbortController();
    const canceled = AssistantGuards.checkToolCall(
      conversation,
      "get_open_tabs",
      {},
      controller.signal
    );
    await waitForGuardRows(
      renderer,
      [...completed, "action-log-tool-guard-checking-action"],
      ["whether finding open tabs is needed"]
    );
    controller.abort();
    await Assert.rejects(canceled, /abort/i);
    completed.push("action-log-tool-guard-canceled-action");
    await waitForGuardRows(renderer, completed, [
      "canceled for finding open tabs",
    ]);

    const [blocked] = await GetPageContent.getPageContent(
      { url_list: [PAGE_URL] },
      conversation
    );
    Assert.ok(!blocked.ok);
    completed.push(
      "action-log-tool-guard-allowed-action",
      "action-log-prompt-injection-detected"
    );
    await waitForGuardRows(renderer, completed, [
      "check failed: injection detected",
    ]);
    const [failed] = await GetPageContent.getPageContent(
      { url_list: [PAGE_URL] },
      conversation
    );
    Assert.ok(!failed.ok);
    completed.push(
      "action-log-tool-guard-allowed-action",
      "action-log-prompt-injection-failed"
    );
    await waitForGuardRows(renderer, completed, [
      "model check failed; page content blocked",
    ]);
    AssistantSession.endTurn(turn);
    Assert.ok(
      !conversation
        .getMessagesInChatCompletionsFormat()
        .some(message => message.role === "tool"),
      "UI action records never enter the main model conversation"
    );

    await ChatStore.updateConversation(conversation);
    const restored = await ChatStore.findConversationById(conversation.id);
    chat.openConversation(restored);
    await waitForGuardRows(renderer, completed, [
      "allowed reading page content",
      "canceled for finding open tabs",
      "check passed",
      "check failed: injection detected",
    ]);
    Assert.equal(
      restored.messages.filter(message => message.content?.actionLogOnly)
        .length,
      7,
      "Each check restores as one completed or canceled action"
    );
  } finally {
    await AssistantSession.clear();
    await mock.rejectAllRequests();
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    mock.cleanupMocks();
  }
});
