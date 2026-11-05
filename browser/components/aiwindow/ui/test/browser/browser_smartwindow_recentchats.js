const { ChatStore, ChatConversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs"
);
const { AssistantSession } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/AssistantSession.sys.mjs"
);

async function addTestConversations(pageUrl) {
  for (let i = 1; i <= 5; i++) {
    const conversation = new ChatConversation({ title: `Chat ${i}` });
    conversation.addUserMessage("message 1", pageUrl);
    await ChatStore.updateConversation(conversation);
  }
}

async function cleanUpAllConversations() {
  let conversations = await ChatStore.findRecentConversations(100);
  while (conversations.length) {
    for (const conv of conversations) {
      await ChatStore.deleteConversationById(conv.id);
    }
    conversations = await ChatStore.findRecentConversations(100);
  }
}

async function openHistoryMenu() {
  const historyMenu = gAiWindow.document.getElementById("historyMenuPopup");
  Assert.ok(!!historyMenu, "History menu popup should be in DOM");

  if (AppConstants.platform === "macosx") {
    // On macOS, the XUL menubar is collapsed because the native macOS menubar
    // is used instead. This means openMenu(true) fails silently — the XUL
    // popup manager cannot show popups for collapsed elements (no layout frames
    // exist). Instead, we populate the menu by calling AIWindow.appMenu()
    // directly with a synthetic event, which mirrors what the native menubar
    // code path does via nsMenuX::OnOpen() -> popupshowing -> browser-menubar.js.
    const event = new gAiWindow.Event("popupshowing", { bubbles: true });
    Object.defineProperty(event, "target", { value: historyMenu });
    await AIWindow.appMenu(event, gAiWindow);
    return historyMenu;
  }

  const historyMenubarItem = gAiWindow.document.getElementById("history-menu");
  const menuShown = BrowserTestUtils.waitForEvent(historyMenu, "popupshown");
  historyMenubarItem.openMenu(true);
  await menuShown;
  await TestUtils.waitForTick();

  return historyMenu;
}

async function closeHistoryMenu(historyMenu) {
  if (AppConstants.platform === "macosx") {
    for (const item of historyMenu.querySelectorAll(".recent-chat-item")) {
      item.remove();
    }

    return;
  }

  const historyMenubarItem = gAiWindow.document.getElementById("history-menu");
  const menuClosed = BrowserTestUtils.waitForEvent(historyMenu, "popuphidden");
  historyMenubarItem.openMenu(false);
  await menuClosed;
}

async function triggerMenuItem(menu, menuItem) {
  const selectedTab = gAiWindow.gBrowser.selectedTab;
  const tabs = [...gAiWindow.gBrowser.tabs];
  const url = selectedTab.linkedBrowser.currentURI.spec;
  const id = menuItem.getAttribute("data-conv-id");

  if (AppConstants.platform === "macosx") {
    menuItem.dispatchEvent(new gAiWindow.Event("command", { bubbles: true }));
  } else {
    const menuHidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
    menu.activateItem(menuItem);
    await menuHidden;
  }
  await TestUtils.waitForCondition(
    () => AssistantSession.conversation.id === id,
    "The menu restores the selected conversation"
  );
  Assert.deepEqual([...gAiWindow.gBrowser.tabs], tabs);
  Assert.strictEqual(gAiWindow.gBrowser.selectedTab, selectedTab);
  Assert.equal(selectedTab.linkedBrowser.currentURI.spec, url);
  return selectedTab;
}

let gAiWindow;

describe("recent chats", () => {
  let historyMenu;

  beforeEach(async () => {
    gAiWindow = await openAIWindow();
  });

  afterEach(async () => {
    await cleanUpAllConversations();
    await BrowserTestUtils.closeWindow(gAiWindow);
    gAiWindow = null;
  });

  describe("clicking history menu with chats in history", () => {
    beforeEach(async () => {
      await addTestConversations();

      historyMenu = await openHistoryMenu();
    });

    afterEach(async () => {
      await closeHistoryMenu(historyMenu);
    });

    it("shows the most recent 4 conversations", async () => {
      await BrowserTestUtils.waitForMutationCondition(
        historyMenu,
        { childList: true },
        () => historyMenu.querySelectorAll(".recent-chat-item").length
      );

      const recentChatItems = historyMenu.querySelectorAll(".recent-chat-item");
      Assert.equal(
        recentChatItems.length,
        4,
        "History menu should contain 4 items"
      );
    });
  });

  describe("clicking history menu with no chats in history", () => {
    beforeEach(async () => {
      historyMenu = await openHistoryMenu();
    });

    afterEach(async () => {
      await closeHistoryMenu(historyMenu);
    });

    it("doesn't have any recent chat item menu options", async () => {
      const recentChatItems = historyMenu.querySelectorAll(".recent-chat-item");
      Assert.equal(
        recentChatItems.length,
        0,
        "History menu should not have any recent chat items"
      );
    });
  });

  describe("recent chats click on full window chat", () => {
    beforeEach(async () => {
      await addTestConversations();
      historyMenu = await openHistoryMenu();
    });

    it("opens a chat in fullwindow mode", async () => {
      // const historyMenu = await openHistoryMenu();

      await BrowserTestUtils.waitForMutationCondition(
        historyMenu,
        { childList: true },
        () => historyMenu.querySelectorAll(".recent-chat-item").length
      );

      const recentChatItem = historyMenu.querySelector(".recent-chat-item");
      Assert.ok(
        !!recentChatItem,
        "History menu should have a recent chat item"
      );

      const expectedConversationId =
        recentChatItem.getAttribute("data-conv-id");

      const currentTab = await triggerMenuItem(historyMenu, recentChatItem);
      await BrowserTestUtils.waitForMutationCondition(
        currentTab.linkedBrowser,
        { attributes: true },
        () =>
          currentTab.linkedBrowser.getAttribute("data-conversation-id") ===
          expectedConversationId
      );

      Assert.equal(
        currentTab.linkedBrowser.getAttribute("data-conversation-id"),
        expectedConversationId,
        "The tab should have the conversation loaded"
      );
    });
  });

  describe("recent chats menu item click on chat that navigated to a url", () => {
    beforeEach(async () => {
      await addTestConversations(new URL("https://www.example.com"));
      await promiseNavigateAndLoad(
        gAiWindow.gBrowser.selectedBrowser,
        "https://example.org/"
      );
      historyMenu = await openHistoryMenu();
    });

    it("it opens the conversation in sidebar", async () => {
      await BrowserTestUtils.waitForMutationCondition(
        historyMenu,
        { childList: true },
        () => historyMenu.querySelectorAll(".recent-chat-item").length
      );

      const recentChatItem = historyMenu.querySelector(".recent-chat-item");
      Assert.ok(
        !!recentChatItem,
        "History menu should have a recent chat item"
      );

      const expectedConversationId =
        recentChatItem.getAttribute("data-conv-id");

      await triggerMenuItem(historyMenu, recentChatItem);

      const sidebarBrowser =
        gAiWindow.document.getElementById("ai-window-browser");
      await TestUtils.waitForCondition(
        () =>
          AIWindowUI.isSidebarOpen(gAiWindow) &&
          sidebarBrowser.getAttribute("data-conversation-id") ===
            expectedConversationId
      );

      Assert.equal(
        sidebarBrowser.getAttribute("data-conversation-id"),
        expectedConversationId,
        "Sidebar should open the selected conversation ID"
      );
    });
  });

  describe("recent chats menu item click on chat that navigated to several urls", () => {
    beforeEach(async () => {
      const conversation = new ChatConversation({
        title: "Chat on several pages",
      });
      conversation.addUserMessage("message 1", new URL("https://example.com/"));
      conversation.addUserMessage("message 2", new URL("https://example.org/"));
      conversation.addUserMessage("message 3", new URL("https://example.com/"));
      await ChatStore.updateConversation(conversation);
      historyMenu = await openHistoryMenu();
    });

    it("restores the chat without opening its previous pages", async () => {
      await BrowserTestUtils.waitForMutationCondition(
        historyMenu,
        { childList: true },
        () => historyMenu.querySelectorAll(".recent-chat-item").length
      );

      const recentChatItem = historyMenu.querySelector(".recent-chat-item");
      const currentTab = await triggerMenuItem(historyMenu, recentChatItem);

      Assert.equal(
        currentTab.linkedBrowser.currentURI.spec,
        AIWINDOW_URL,
        "The current page stays unchanged"
      );
    });
  });
});
