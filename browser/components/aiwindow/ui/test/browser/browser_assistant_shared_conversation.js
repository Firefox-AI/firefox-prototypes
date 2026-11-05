/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AssistantSession } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/AssistantSession.sys.mjs"
);
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

add_task(async function test_new_tabs_start_closed_and_preserve_conversation() {
  const mock = new MockEngineManager();
  let win;
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.sidebar.openByDefault", true]],
  });
  try {
    const text = "Keep this conversation when opening a new tab";
    const conversation = AssistantSession.conversation;
    conversation.addUserMessage(text);
    win = await openAIWindow({ waitForTabURL: "about:newtab" });
    Assert.equal(win.gBrowser.selectedBrowser.currentURI.spec, "about:newtab");
    Assert.ok(
      !AIWindowUI.isSidebarOpen(win),
      "The initial new tab starts closed"
    );

    async function assertConversationVisible() {
      await waitForSidebarOpen(win);
      const sidebarBrowser = await waitForSidebarReady(win);
      const chat = sidebarBrowser.contentDocument.querySelector("ai-window");
      await TestUtils.waitForCondition(
        () => chat.classList.contains("chat-active"),
        "The sidebar shows the active conversation layout"
      );
      Assert.strictEqual(chat.conversation, conversation);
      Assert.ok(!chat.showStarters, "An ongoing chat does not show starters");
      const renderer = await getAichatBrowser(sidebarBrowser);
      await SpecialPowers.spawn(renderer, [text], async expected => {
        await ContentTaskUtils.waitForCondition(
          () =>
            content.document
              .querySelector("ai-chat-content")
              ?.shadowRoot?.querySelector("ai-chat-message")
              ?.shadowRoot?.textContent.includes(expected),
          "The existing message is rendered without submitting another prompt"
        );
      });
    }

    AIWindowUI.toggleSidebar(win);
    await assertConversationVisible();
    const initialTab = win.gBrowser.selectedTab;
    const opened = BrowserTestUtils.waitForEvent(
      win.gBrowser.tabContainer,
      "TabOpen"
    );
    win.document.getElementById("cmd_newNavigatorTab").doCommand();
    const tab = (await opened).target;
    if (tab.linkedBrowser.currentURI.spec !== "about:newtab") {
      await BrowserTestUtils.browserLoaded(
        tab.linkedBrowser,
        false,
        "about:newtab"
      );
    }
    Assert.equal(tab.linkedBrowser.currentURI.spec, "about:newtab");
    await waitForSidebarClosed(win);
    Assert.ok(
      !AIWindowUI.isSidebarOpen(win),
      "New tabs start closed even when the previous tab's sidebar is open"
    );
    Assert.strictEqual(AssistantSession.conversation, conversation);
    AIWindowUI.toggleSidebar(win);
    await assertConversationVisible();

    await BrowserTestUtils.switchTab(win.gBrowser, initialTab);
    await assertConversationVisible();
    AIWindowUI.closeSidebar(win, "toggle");
    await waitForSidebarClosed(win);
    await BrowserTestUtils.switchTab(win.gBrowser, tab);
    await assertConversationVisible();
    await BrowserTestUtils.switchTab(win.gBrowser, initialTab);
    await waitForSidebarClosed(win);
    Assert.ok(
      !AIWindowUI.isSidebarOpen(win),
      "An explicitly closed sidebar stays closed"
    );
    await BrowserTestUtils.switchTab(win.gBrowser, tab);
    await assertConversationVisible();
    Assert.strictEqual(AssistantSession.conversation, conversation);
  } finally {
    await mock.rejectAllRequests();
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    mock.cleanupMocks();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_chat_boxes_share_conversation_and_reset() {
  const mock = new MockEngineManager();
  let firstWindow;
  let secondWindow;
  try {
    const first = await openAIWindowWithSidebar();
    firstWindow = first.win;
    const firstChat =
      first.sidebarBrowser.contentDocument.querySelector("ai-window");
    const conversation = firstChat.conversation;
    conversation.addUserMessage("This message belongs to the shared assistant");

    const second = await openAIWindowWithSidebar();
    secondWindow = second.win;
    const secondChat =
      second.sidebarBrowser.contentDocument.querySelector("ai-window");
    Assert.strictEqual(firstChat.conversation, secondChat.conversation);
    Assert.strictEqual(secondChat.conversation, conversation);
    for (const chat of [firstChat, secondChat]) {
      Assert.equal(
        chat.shadowRoot.querySelector("#aichat-browser").browsingContext
          .originAttributes.userContextId,
        AssistantSession.chatOriginAttributes.userContextId,
        "Chat renderers use a stable identity separate from browsing contexts"
      );
    }
    const controller = AssistantSession.beginTurn();
    Assert.ok(firstChat.isGenerating);
    Assert.ok(secondChat.isGenerating);
    await secondChat.onCreateNewChatClick();
    Assert.ok(controller.signal.aborted);
    Assert.strictEqual(firstChat.conversation, secondChat.conversation);
    Assert.notStrictEqual(firstChat.conversation, conversation);
    Assert.equal(firstChat.conversationMessageCount, 0);
    Assert.ok(!firstChat.isGenerating && !secondChat.isGenerating);
  } finally {
    await mock.rejectAllRequests();
    if (firstWindow) {
      await BrowserTestUtils.closeWindow(firstWindow);
    }
    if (secondWindow) {
      await BrowserTestUtils.closeWindow(secondWindow);
    }
    mock.cleanupMocks();
  }
});
