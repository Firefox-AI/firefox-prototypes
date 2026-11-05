/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ChatStore, ChatConversation, MESSAGE_ROLE } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs"
  );

const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

async function seedConversations(count) {
  const ids = [];
  for (let i = 1; i <= count; i++) {
    const conversation = new ChatConversation({ title: `History chat ${i}` });
    conversation.addUserMessage("message 1", "https://example.com/");
    await ChatStore.updateConversation(conversation);
    ids.push(conversation.id);
  }
  return ids;
}

async function cleanUpConversations() {
  let conversations = await ChatStore.findRecentConversations(100);
  while (conversations.length) {
    for (const conv of conversations) {
      await ChatStore.deleteConversationById(conv.id);
    }
    conversations = await ChatStore.findRecentConversations(100);
  }
}

async function getFullpageAiWindow(win) {
  const aiWindow =
    win.gBrowser.selectedBrowser.contentDocument.querySelector("ai-window");
  await TestUtils.waitForCondition(
    () => aiWindow?.shadowRoot,
    "Fullpage AI Window should be rendered with a shadow root"
  );
  return aiWindow;
}

// The history menu lives in its own <smartwindow-history-menu> component; its
// buttons/panels are in that component's shadow root.
async function getHistoryMenuRoot(aiWindow) {
  await TestUtils.waitForCondition(
    () =>
      aiWindow.shadowRoot.querySelector("smartwindow-history-menu")?.shadowRoot,
    "History menu component should be rendered"
  );
  return aiWindow.shadowRoot.querySelector("smartwindow-history-menu")
    .shadowRoot;
}

async function openMenu(menuRoot, buttonSelector, panelId) {
  const panel = menuRoot.querySelector(`#${panelId}`);
  const shown = BrowserTestUtils.waitForEvent(panel, "shown");
  menuRoot.querySelector(buttonSelector).click();
  await shown;
  return panel;
}

/**
 * The fullpage "Chat history" button opens a dropdown listing recent chats
 * (with a favicon) plus a "View all chats" shortcut.
 */
add_task(async function test_fullpage_chat_history_dropdown() {
  const sb = this.sinon.createSandbox();
  let aiWin;

  try {
    sb.stub(this.openAIEngine, "build");
    await cleanUpConversations();
    await seedConversations(3);

    aiWin = await openAIWindow();
    const aiWindow = await getFullpageAiWindow(aiWin);
    const menuRoot = await getHistoryMenuRoot(aiWindow);

    await openMenu(
      menuRoot,
      "[data-l10n-id='aiwindow-fullpage-chat-history']",
      "fullpage-chats-menu"
    );

    await TestUtils.waitForCondition(
      () => menuRoot.querySelectorAll(".history-menu-chat").length,
      "Recent chats should be listed"
    );
    Assert.equal(
      menuRoot.querySelectorAll(".history-menu-chat").length,
      3,
      "All three recent chats should be listed"
    );
    Assert.ok(
      menuRoot.querySelector(
        "[data-l10n-id='aiwindow-history-menu-view-all-chats']"
      ),
      "Dropdown should have the View all chats shortcut"
    );

    const chatIcon = menuRoot
      .querySelector(".history-menu-chat")
      .style.getPropertyValue("--panel-item-icon-url");
    Assert.ok(
      chatIcon.includes("page-icon:") || chatIcon.includes("view-chats"),
      `Recent chat rows should render a chat/site icon, got: ${chatIcon}`
    );
  } finally {
    if (aiWin) {
      await BrowserTestUtils.closeWindow(aiWin);
    }
    await cleanUpConversations();
    sb.restore();
  }
});

/**
 * "View all chats" opens the Chats section of Firefox View.
 */
add_task(async function test_fullpage_view_all_chats() {
  const sb = this.sinon.createSandbox();
  let aiWin;

  try {
    sb.stub(this.openAIEngine, "build");
    await cleanUpConversations();

    aiWin = await openAIWindow();
    const openTab = sb.stub(aiWin.FirefoxViewHandler, "openTab");
    const aiWindow = await getFullpageAiWindow(aiWin);
    const menuRoot = await getHistoryMenuRoot(aiWindow);

    await openMenu(
      menuRoot,
      "[data-l10n-id='aiwindow-fullpage-chat-history']",
      "fullpage-chats-menu"
    );

    menuRoot
      .querySelector("[data-l10n-id='aiwindow-history-menu-view-all-chats']")
      .click();

    Assert.ok(
      openTab.calledOnceWith("chats"),
      "View all chats should open the Chats section of Firefox View"
    );
  } finally {
    if (aiWin) {
      await BrowserTestUtils.closeWindow(aiWin);
    }
    await cleanUpConversations();
    sb.restore();
  }
});

/**
 * The fullpage "More" button opens a menu with Smart Window settings.
 */
add_task(async function test_fullpage_more_settings() {
  const sb = this.sinon.createSandbox();
  let aiWin;

  try {
    sb.stub(this.openAIEngine, "build");
    await cleanUpConversations();

    aiWin = await openAIWindow();
    const openPreferences = sb.stub(aiWin, "openPreferences");
    const aiWindow = await getFullpageAiWindow(aiWin);
    const menuRoot = await getHistoryMenuRoot(aiWindow);

    await openMenu(
      menuRoot,
      "[data-l10n-id='aiwindow-fullpage-more']",
      "fullpage-more-menu"
    );

    menuRoot
      .querySelector("[data-l10n-id='aiwindow-history-menu-settings']")
      .click();

    Assert.ok(
      openPreferences.calledOnceWith("personalizeSmartWindow"),
      "More > Settings should open the Smart Window preferences"
    );
  } finally {
    if (aiWin) {
      await BrowserTestUtils.closeWindow(aiWin);
    }
    await cleanUpConversations();
    sb.restore();
  }
});

/**
 * Selecting a recent chat restores it in the current fullpage view.
 */
add_task(async function test_fullpage_open_recent_chat() {
  const sb = this.sinon.createSandbox();
  let aiWin;

  try {
    sb.stub(this.openAIEngine, "build");
    await cleanUpConversations();
    const [conversationId] = await seedConversations(1);

    aiWin = await openAIWindow();
    const selectedTab = aiWin.gBrowser.selectedTab;
    const tabs = [...aiWin.gBrowser.tabs];
    const aiWindow = await getFullpageAiWindow(aiWin);
    const menuRoot = await getHistoryMenuRoot(aiWindow);

    await openMenu(
      menuRoot,
      "[data-l10n-id='aiwindow-fullpage-chat-history']",
      "fullpage-chats-menu"
    );

    await TestUtils.waitForCondition(
      () => menuRoot.querySelector(".history-menu-chat"),
      "Recent chat item should be rendered"
    );
    menuRoot.querySelector(".history-menu-chat").click();

    await TestUtils.waitForCondition(
      () => aiWindow.conversationId === conversationId,
      "The current view restores the selected recent chat"
    );
    Assert.equal(
      aiWin.gBrowser.selectedTab,
      selectedTab,
      "The selected tab stays unchanged"
    );
    Assert.deepEqual([...aiWin.gBrowser.tabs], tabs);
  } finally {
    if (aiWin) {
      await BrowserTestUtils.closeWindow(aiWin);
    }
    await cleanUpConversations();
    sb.restore();
  }
});

/**
 * A chat started on a website restores in the current view without reopening it.
 */
add_task(async function test_restore_sidebar_chat_in_current_view() {
  const restoreSignIn = skipSignIn();
  const mockEngineManager = new MockEngineManager();
  const pageUrl = "https://example.com/";
  let aiWin;

  try {
    await cleanUpConversations();
    aiWin = await openAIWindow();

    const pageTab = aiWin.gBrowser.selectedTab;
    const { sidebarBrowser } = await openAIWindowSidebar(aiWin, pageUrl);
    await typeInSmartbar(sidebarBrowser, "What is this page about?");
    await submitSmartbar(sidebarBrowser);
    await mockEngineManager.respondTo({ purpose: "chat", response: "Hello" });

    const convId = AIWindow.getActiveConversation(aiWin).id;
    let saved;
    await TestUtils.waitForCondition(async () => {
      saved = await ChatStore.findConversationById(convId);
      return saved?.messages.some(m => m.role == MESSAGE_ROLE.USER);
    }, "The chat should be saved with its user message");
    Assert.equal(
      saved.getMostRecentPageVisited()?.href,
      pageUrl,
      "The saved chat should remember the page the prompt was sent from"
    );

    await BrowserTestUtils.openNewForegroundTab(aiWin.gBrowser, AIWINDOW_URL);
    BrowserTestUtils.removeTab(pageTab);
    const aiWindow = await getFullpageAiWindow(aiWin);
    await aiWindow.onCreateNewChatClick();
    const menuRoot = await getHistoryMenuRoot(aiWindow);

    await openMenu(
      menuRoot,
      "[data-l10n-id='aiwindow-fullpage-chat-history']",
      "fullpage-chats-menu"
    );
    await TestUtils.waitForCondition(
      () => menuRoot.querySelector(".history-menu-chat"),
      "Recent chat item should be rendered"
    );

    const selectedTab = aiWin.gBrowser.selectedTab;
    const tabs = [...aiWin.gBrowser.tabs];
    menuRoot.querySelector(".history-menu-chat").click();
    await TestUtils.waitForCondition(
      () => aiWindow.conversationId === convId,
      "The saved chat returns in the existing view"
    );

    Assert.equal(
      selectedTab.linkedBrowser.currentURI.spec,
      AIWINDOW_URL,
      "History keeps the current page"
    );
    Assert.strictEqual(aiWin.gBrowser.selectedTab, selectedTab);
    Assert.deepEqual([...aiWin.gBrowser.tabs], tabs);
    Assert.ok(!AIWindowUI.isSidebarOpen(aiWin));
    await TestUtils.waitForCondition(async () => {
      const messages = await getSidebarChatMessages(selectedTab.linkedBrowser);
      return messages.some(
        m => m.role == "user" && m.message == "What is this page about?"
      );
    }, "The saved prompt renders in the existing fullpage chat");
  } finally {
    if (aiWin) {
      await BrowserTestUtils.closeWindow(aiWin);
    }
    await cleanUpConversations();
    mockEngineManager.cleanupMocks();
    restoreSignIn();
  }
});
