/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AssistantSession } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/AssistantSession.sys.mjs"
);
const { AssistantContext } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/AssistantContext.sys.mjs"
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

add_task(async function test_history_restores_context_without_opening_sites() {
  await AssistantSession.clear();
  const mock = new MockEngineManager();
  let win;
  const conversations = [];
  try {
    const opened = await openAIWindowWithSidebar(PAGE_URL);
    win = opened.win;
    const userTab = win.gBrowser.selectedTab;
    const chat =
      opened.sidebarBrowser.contentDocument.querySelector("ai-window");
    const first = AssistantSession.conversation;
    conversations.push(first.id);
    const otherURL = PAGE_URL.replace("example.com", "example.org");
    const firstText = "Read the shared page and keep its browsing context";
    first.addUserMessage(firstText, new URL(otherURL));
    AssistantSession.sharePage(userTab.linkedBrowser);
    const results = await GetPageContent.getPageContent(
      { url_list: [PAGE_URL, otherURL], source: "assistant" },
      first
    );
    Assert.ok(results.every(result => result.ok));
    const firstAttributes = AssistantSession.originAttributes;

    async function openContextAndStore(value) {
      const group = AssistantContext.show(win);
      const tab = group.tabs.find(
        item =>
          item.getAttribute("assistant-context-site") === "https://example.com"
      );
      const browser = tab.linkedBrowser;
      win.gBrowser.selectedTab = tab;
      await TestUtils.waitForCondition(
        () =>
          browser.currentURI.spec === "https://example.com/" &&
          !browser.webProgress.isLoadingDocument,
        "The context page loads before its storage is inspected"
      );
      const storage = await SpecialPowers.spawn(browser, [value], stored => {
        if (stored) {
          content.document.cookie = `chat_context=${stored}; SameSite=Lax`;
          content.localStorage.setItem("chat-context", stored);
        }
        return {
          cookie: content.document.cookie,
          storage: content.localStorage.getItem("chat-context"),
        };
      });
      return { ...storage, group };
    }
    const { group: firstGroup } = await openContextAndStore("first");
    await BrowserTestUtils.removeTab(
      firstGroup.tabs.find(
        tab =>
          tab.getAttribute("assistant-context-site") === "https://example.org"
      )
    );
    await chat.onCreateNewChatClick();
    Assert.ok(
      firstGroup.isConnected,
      "Starting a chat preserves existing context tabs"
    );
    Assert.ok(!userTab.hasAttribute("assistant-page-shared"));
    Assert.deepEqual(AssistantSession.visitedSites, []);
    const second = AssistantSession.conversation;
    conversations.push(second.id);
    const secondText = "Use an independent context in this chat";
    second.addUserMessage(secondText, new URL(PAGE_URL));
    const secondAttributes = AssistantSession.originAttributes;
    Assert.notEqual(
      secondAttributes.userContextId,
      firstAttributes.userContextId
    );
    await GetPageContent.getPageContent(
      { url_list: [PAGE_URL], source: "assistant" },
      second
    );
    const secondStorage = await openContextAndStore("second");
    Assert.ok(secondStorage.cookie.includes("chat_context=second"));
    Assert.notStrictEqual(secondStorage.group, firstGroup);

    await BrowserTestUtils.switchTab(win.gBrowser, userTab);
    await AIWindowUI.openSidebar(win);
    const renderer = await getAichatBrowser(opened.sidebarBrowser);
    const rendererContext = renderer.browsingContext;
    const tabs = [...win.gBrowser.tabs];
    const locations = tabs.map(tab => tab.linkedBrowser.currentURI.spec);
    const groups = win.gBrowser.tabGroups.map(group => [
      group,
      [...group.tabs],
    ]);
    const tabEvents = [];
    const onTabEvent = event => tabEvents.push(event.type);
    for (const type of ["TabOpen", "TabClose", "TabSelect"]) {
      win.gBrowser.tabContainer.addEventListener(type, onTabEvent);
    }
    const sidebarEvents = [];
    const onSidebarEvent = event => sidebarEvents.push(event.detail.isOpen);
    win.addEventListener("ai-window:sidebar-toggle", onSidebarEvent);

    chat.ownerDocument.dispatchEvent(
      new chat.documentGlobal.CustomEvent(
        "smartwindow-history-menu:open-chat",
        {
          detail: { conversationId: first.id },
        }
      )
    );
    await TestUtils.waitForCondition(
      () =>
        AssistantSession.conversation.id === first.id &&
        AssistantSession.conversation !== first,
      "Selecting history restores the saved conversation and context"
    );
    Assert.deepEqual(AssistantSession.originAttributes, firstAttributes);
    Assert.deepEqual(AssistantSession.visitedSites.toSorted(), [
      "https://example.com",
      "https://example.org",
    ]);
    Assert.ok(userTab.hasAttribute("assistant-page-shared"));
    const rendered = await SpecialPowers.spawn(
      renderer,
      [firstText],
      async text => {
        const messages = () =>
          [
            ...content.document
              .querySelector("ai-chat-content")
              .shadowRoot.querySelectorAll("ai-chat-message"),
          ]
            .map(message => message.shadowRoot?.textContent ?? "")
            .join(" ");
        await ContentTaskUtils.waitForCondition(
          () => messages().includes(text),
          "History renders in the existing chat browser"
        );
        return messages();
      }
    );
    Assert.ok(
      !rendered.includes(secondText),
      "The previous conversation is removed from the renderer"
    );
    Assert.strictEqual(
      chat.shadowRoot.querySelector("#aichat-browser"),
      renderer
    );
    Assert.strictEqual(renderer.browsingContext, rendererContext);
    Assert.ok(AIWindowUI.isSidebarOpen(win));
    Assert.deepEqual(
      sidebarEvents,
      [],
      "The sidebar never closes or reopens during history selection"
    );
    Assert.deepEqual(
      tabEvents,
      [],
      "History never opens, closes, or selects tabs"
    );
    Assert.deepEqual([...win.gBrowser.tabs], tabs);
    Assert.deepEqual(
      tabs.map(tab => tab.linkedBrowser.currentURI.spec),
      locations
    );
    Assert.strictEqual(win.gBrowser.selectedTab, userTab);
    for (const [group, groupTabs] of groups) {
      Assert.ok(group.isConnected);
      Assert.deepEqual(
        [...group.tabs],
        groupTabs,
        "Each chat's existing context group stays intact"
      );
    }
    for (const type of ["TabOpen", "TabClose", "TabSelect"]) {
      win.gBrowser.tabContainer.removeEventListener(type, onTabEvent);
    }
    win.removeEventListener("ai-window:sidebar-toggle", onSidebarEvent);
    const firstStorage = await openContextAndStore(null);
    Assert.strictEqual(
      firstStorage.group,
      firstGroup,
      "Viewing context reuses this conversation's group"
    );
    Assert.equal(
      firstGroup.tabs.length,
      2,
      "Explicitly viewing context can restore a missing site tab"
    );
    Assert.ok(firstStorage.cookie.includes("chat_context=first"));
    Assert.equal(
      firstStorage.storage,
      "first",
      "History resumes the chat's actual local storage"
    );

    await ChatStore.deleteConversationById(second.id);
    Assert.equal(
      Services.cookies.getCookiesWithOriginAttributes(
        JSON.stringify(secondAttributes)
      ).length,
      0,
      "Deleting an archived chat removes its retained storage"
    );
    Assert.equal(AssistantSession.conversation.id, first.id);
    Assert.ok(AssistantSession.getPageAccess(userTab.linkedBrowser).shared);
    await ChatStore.deleteConversationById(first.id);
    Assert.ok(!userTab.hasAttribute("assistant-page-shared"));
    Assert.equal(
      Services.cookies.getCookiesWithOriginAttributes(
        JSON.stringify(firstAttributes)
      ).length,
      0
    );
  } finally {
    for (const id of conversations) {
      await ChatStore.deleteConversationById(id);
    }
    await AssistantSession.clear();
    await mock.rejectAllRequests();
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    mock.cleanupMocks();
  }
});

add_task(
  async function test_context_group_is_opt_in_and_uses_assistant_storage() {
    await AssistantSession.clear();
    const mock = new MockEngineManager();
    let win;
    try {
      const opened = await openAIWindowWithSidebar(PAGE_URL);
      win = opened.win;
      const userTab = win.gBrowser.selectedTab;
      const chat =
        opened.sidebarBrowser.contentDocument.querySelector("ai-window");
      await chat.updateComplete;
      const button = chat.shadowRoot.querySelector(".assistant-context-button");
      Assert.ok(button.disabled, "No assistant sites have been visited yet");
      Assert.equal(
        AssistantSession.visitedSites.length,
        0,
        "User browsing is excluded"
      );
      const conversation = AssistantSession.conversation;
      const otherURL = PAGE_URL.replace("example.com", "example.org");
      conversation.addUserMessage(
        `Read ${PAGE_URL} and ${otherURL}`,
        new URL(PAGE_URL)
      );
      const [result] = await GetPageContent.getPageContent(
        { url_list: [PAGE_URL] },
        conversation
      );
      Assert.ok(result.ok, result.content);
      await TestUtils.waitForCondition(
        () => !button.disabled,
        "The context button is enabled"
      );
      Assert.ok(
        !win.gBrowser.tabGroups.some(group =>
          group.hasAttribute("assistant-context")
        ),
        "Fetching never opens context tabs automatically"
      );

      button.click();
      const group = await TestUtils.waitForCondition(
        () =>
          win.gBrowser.tabGroups.find(item =>
            item.hasAttribute("assistant-context")
          ),
        "The button opens a context group"
      );
      Assert.equal(group.label, "Assistant context");
      Assert.equal(group.tabs.length, 1);
      Assert.equal(
        group.tabs[0].userContextId,
        AssistantSession.originAttributes.userContextId
      );
      Assert.notEqual(group.tabs[0].userContextId, userTab.userContextId);
      Assert.equal(
        win.getComputedStyle(group.querySelector(".tab-group-label-container"))
          .borderBlockStartStyle,
        "dotted",
        "Dotted borders distinguish the context group"
      );
      Assert.equal(
        win.getComputedStyle(group.tabs[0]).borderInlineEndStyle,
        "dotted",
        "The last tab closes the dotted outline"
      );
      await BrowserTestUtils.browserLoaded(
        group.tabs[0].linkedBrowser,
        false,
        "https://example.com/"
      );
      Assert.equal(
        group.tabs[0].linkedBrowser.browsingContext.originAttributes
          .userContextId,
        AssistantSession.originAttributes.userContextId,
        "The loaded context page uses the assistant's actual browsing identity"
      );
      const embeddedURL = PAGE_URL.replace("example.com", "example.net");
      const contextBrowser = group.tabs[0].linkedBrowser;
      await SpecialPowers.spawn(
        contextBrowser,
        [embeddedURL, otherURL],
        async (frameURL, fetchURL) => {
          const frame = content.document.createElement("iframe");
          frame.src = frameURL;
          content.document.body.append(frame);
          await content.fetch(fetchURL, { mode: "no-cors" });
        }
      );
      await TestUtils.waitForCondition(
        () =>
          contextBrowser.browsingContext.children.some(
            context =>
              context.currentWindowGlobal?.documentURI.spec === embeddedURL
          ),
        "An embedded document actually loaded in the assistant's browsing identity"
      );
      Assert.deepEqual(
        AssistantSession.visitedSites,
        ["https://example.com"],
        "Embedded pages and background fetches are excluded from page visits"
      );
      Assert.equal(
        group.tabs.length,
        1,
        "Embedded sites never become tabs in an open context group"
      );
      const [other] = await GetPageContent.getPageContent(
        { url_list: [otherURL] },
        conversation
      );
      Assert.ok(other.ok, other.content);
      await TestUtils.waitForCondition(
        () => group.tabs.length === 2,
        "Newly visited sites appear in the open context view"
      );
      Assert.ok(
        group.tabs[1].hasAttribute("pending"),
        "Additional context sites do not fetch until selected"
      );
      Assert.strictEqual(
        AssistantContext.show(win),
        group,
        "Repeated viewing reuses the group"
      );
      Assert.equal(group.tabs.length, 2, "Sites are deduplicated");
      await promiseNavigateAndLoad(group.tabs[0].linkedBrowser, otherURL);
      await TestUtils.waitForCondition(
        () =>
          group.tabs.length === 2 &&
          new Set(
            group.tabs.map(tab => tab.getAttribute("assistant-context-site"))
          ).size === 2,
        "Navigating a context tab retains an entry for every visited site without duplicate placeholders"
      );
      await win.gBrowser.removeTabGroup(group, {
        skipPermitUnload: true,
        skipSessionStore: true,
        animate: false,
      });
      Assert.equal(
        AssistantSession.visitedSites.length,
        2,
        "Closing the view keeps the context"
      );
      const reopened = AssistantContext.show(win);
      Assert.equal(reopened.tabs.length, 2);
      const detached = reopened.tabs[1];
      win.gBrowser.ungroupTab(detached);
      await AssistantSession.clear();
      Assert.ok(!reopened.isConnected);
      Assert.ok(
        !detached.isConnected,
        "Clear also closes context tabs moved outside the group"
      );
      Assert.equal(AssistantSession.visitedSites.length, 0);
      Assert.ok(userTab.isConnected, "Clear preserves the user's tab");
    } finally {
      await AssistantSession.clear();
      await mock.rejectAllRequests();
      if (win) {
        await BrowserTestUtils.closeWindow(win);
      }
      mock.cleanupMocks();
    }
  }
);

add_task(
  async function test_shared_principal_marks_matching_user_tabs_until_clear() {
    await AssistantSession.clear();
    const mock = new MockEngineManager();
    let win;
    let secondWindow;
    try {
      ({ win } = await openAIWindowWithSidebar(PAGE_URL));
      const tab = win.gBrowser.selectedTab;
      Assert.ok(!tab.hasAttribute("assistant-page-shared"));
      AssistantSession.sharePage(tab.linkedBrowser);
      Assert.ok(tab.hasAttribute("assistant-page-shared"));
      const icon = tab.querySelector(".assistant-page-shared-icon");
      Assert.ok(
        BrowserTestUtils.isVisible(icon),
        "A visible assistant badge marks shared tabs"
      );
      await win.document.l10n.translateElements([icon]);
      Assert.ok(icon.getAttribute("aria-label").includes("shared"));
      win.gBrowser.pinTab(tab);
      Assert.equal(
        win.getComputedStyle(icon).position,
        "absolute",
        "Pinned tabs overlay the badge without widening the tab"
      );
      Assert.ok(
        BrowserTestUtils.isVisible(icon),
        "Pinned tabs retain the sharing mark"
      );
      win.gBrowser.unpinTab(tab);
      win.document.documentElement.removeAttribute("ai-window");
      await TestUtils.waitForCondition(
        () => !tab.hasAttribute("assistant-page-shared"),
        "Classic Window tabs are outside live assistant access"
      );
      win.document.documentElement.setAttribute("ai-window", "true");
      await TestUtils.waitForCondition(
        () => tab.hasAttribute("assistant-page-shared"),
        "Returning to Smart Window restores the indicator"
      );
      const sameSite = await BrowserTestUtils.openNewForegroundTab(
        win.gBrowser,
        PAGE_URL
      );
      await TestUtils.waitForCondition(
        () => sameSite.hasAttribute("assistant-page-shared"),
        "New matching tabs are also marked"
      );
      const container = win.gBrowser.addTrustedTab(PAGE_URL, {
        userContextId: 1,
      });
      await BrowserTestUtils.browserLoaded(container.linkedBrowser);
      Assert.ok(
        !container.hasAttribute("assistant-page-shared"),
        "A different container is not shared"
      );

      const second = await openAIWindowWithSidebar(PAGE_URL);
      secondWindow = second.win;
      const secondTab = secondWindow.gBrowser.selectedTab;
      await TestUtils.waitForCondition(
        () => secondTab.hasAttribute("assistant-page-shared"),
        "The grant is indicated in other windows"
      );
      AIWindowUI.closeSidebar(win, "toggle");
      await promiseNavigateAndLoad(
        tab.linkedBrowser,
        PAGE_URL.replace("example.com", "example.org")
      );
      await TestUtils.waitForCondition(
        () => !tab.hasAttribute("assistant-page-shared"),
        "Navigation to an unshared principal removes the mark"
      );
      await promiseNavigateAndLoad(tab.linkedBrowser, PAGE_URL);
      await TestUtils.waitForCondition(
        () => tab.hasAttribute("assistant-page-shared"),
        "Returning to the shared principal restores the mark without an open chat"
      );
      AssistantSession.revokePageAccess(
        AssistantSession.getPageAccess(tab.linkedBrowser).key
      );
      Assert.ok(!sameSite.hasAttribute("assistant-page-shared"));
      Assert.ok(!secondTab.hasAttribute("assistant-page-shared"));
      AssistantSession.sharePage(tab.linkedBrowser);
      await AssistantSession.clear();
      for (const current of [tab, sameSite, secondTab]) {
        Assert.ok(!current.hasAttribute("assistant-page-shared"));
        Assert.ok(
          !current.querySelector(".assistant-page-shared-icon"),
          "Clearing removes every shared-page badge"
        );
        Assert.ok(current.isConnected, "User tabs remain open");
      }
    } finally {
      await AssistantSession.clear();
      await mock.rejectAllRequests();
      if (secondWindow) {
        await BrowserTestUtils.closeWindow(secondWindow);
      }
      if (win) {
        await BrowserTestUtils.closeWindow(win);
      }
      mock.cleanupMocks();
    }
  }
);
