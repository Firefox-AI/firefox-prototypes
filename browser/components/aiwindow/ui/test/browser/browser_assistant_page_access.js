/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AssistantSession } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/AssistantSession.sys.mjs"
);
const { GetPageContent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const PAGE_URL =
  getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com"
  ) + "test_context_url_page.html";

async function pageAccessStatus(chat, shared) {
  return TestUtils.waitForCondition(
    () =>
      chat.shadowRoot.querySelector(
        `.page-access-status[data-shared="${shared}"]`
      ),
    `Page access indicator is ${shared ? "shared" : "private"}`
  );
}

async function accessRequest(chat) {
  return TestUtils.waitForCondition(
    () => chat.shadowRoot.querySelector(".page-access-request"),
    "The assistant asks before reading a signed-in page"
  );
}

add_task(async function test_read_waits_for_sharing_and_can_be_revoked() {
  await AssistantSession.clear();
  const mock = new MockEngineManager();
  let win;
  let extraction;
  try {
    const opened = await openAIWindowWithSidebar(PAGE_URL);
    win = opened.win;
    const chat =
      opened.sidebarBrowser.contentDocument.querySelector("ai-window");
    const browser = win.gBrowser.selectedBrowser;
    await pageAccessStatus(chat, false);
    const privateText = "A message from the user's signed-in page session";
    await SpecialPowers.spawn(browser, [privateText], text => {
      content.localStorage.setItem("assistant-page-access-test", text);
      const article = content.document.createElement("article");
      article.textContent = content.localStorage.getItem(
        "assistant-page-access-test"
      );
      content.document.body.append(article);
    });
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("PageExtractor");
    extraction = sinon.spy(actor, "getText");
    const conversation = AssistantSession.conversation;
    conversation.addUserMessage("Read the tab I have open", new URL(PAGE_URL));

    const deniedRead = GetPageContent.getPageContent(
      { url_list: [PAGE_URL], source: "user_tab" },
      conversation
    );
    const deniedRequest = await accessRequest(chat);
    Assert.ok(
      extraction.notCalled,
      "Neither implicit context nor a tool call grants page access"
    );
    deniedRequest.querySelector(".page-access-deny").click();
    Assert.ok(!(await deniedRead)[0].ok);
    Assert.ok(extraction.notCalled, "Declining never extracts page data");
    await pageAccessStatus(chat, false);

    const [independent] = await GetPageContent.getPageContent(
      { url_list: [PAGE_URL] },
      conversation
    );
    Assert.ok(independent.ok, independent.content);
    Assert.ok(
      !independent.content.includes(privateText),
      "An unshared URL can be fetched without reading the user's live page"
    );
    Assert.ok(extraction.notCalled);
    Assert.equal(
      AssistantSession.pageAccessRequests.length,
      0,
      "Independent fetches do not request site sharing"
    );

    const controller = AssistantSession.beginTurn();
    const allowedRead = GetPageContent.getPageContent(
      { url_list: [PAGE_URL], source: "user_tab" },
      conversation
    );
    const allowedRequest = await accessRequest(chat);
    Assert.equal(
      allowedRequest.querySelector("code").textContent,
      browser.browsingContext.currentWindowGlobal.documentStoragePrincipal
        .origin,
      "The request names the browser's exact storage principal"
    );
    allowedRequest.querySelector(".page-access-allow").click();
    const [result] = await allowedRead;
    AssistantSession.endTurn(controller);
    Assert.ok(result.ok, result.content);
    Assert.ok(
      result.content.includes(privateText),
      "Approval reads the live signed-in page"
    );
    Assert.equal(extraction.callCount, 1);
    const [shared] = await GetPageContent.getPageContent(
      { url_list: [PAGE_URL] },
      conversation
    );
    Assert.ok(
      shared.ok && shared.content.includes(privateText),
      "After sharing, default reads see the user's live page"
    );
    Assert.equal(extraction.callCount, 2);
    await pageAccessStatus(chat, true);
    Assert.equal(AssistantSession.sharedPages.length, 1);

    const otherURL = PAGE_URL.replace("example.com", "example.org");
    await promiseNavigateAndLoad(browser, otherURL);
    await pageAccessStatus(chat, false);
    Assert.equal(
      AssistantSession.sharedPages.length,
      1,
      "Navigation cannot grant another site access"
    );
    chat.shadowRoot.querySelector(".page-access-sites moz-button").click();
    Assert.equal(
      AssistantSession.sharedPages.length,
      0,
      "Shared principals can be revoked from another page"
    );
  } finally {
    extraction?.restore();
    await AssistantSession.clear();
    await mock.rejectAllRequests();
    if (win) {
      await BrowserTestUtils.closeWindow(win);
    }
    mock.cleanupMocks();
  }
});

add_task(
  async function test_inline_mention_shares_even_with_implicit_current_tab() {
    await AssistantSession.clear();
    const mock = new MockEngineManager();
    let win;
    let submit;
    try {
      const opened = await openAIWindowWithSidebar(PAGE_URL);
      win = opened.win;
      const chat =
        opened.sidebarBrowser.contentDocument.querySelector("ai-window");
      const browser = win.gBrowser.selectedBrowser;
      await pageAccessStatus(chat, false);
      const smartbar = await TestUtils.waitForCondition(
        () => chat.shadowRoot.querySelector("#ai-window-smartbar"),
        "The smartbar is ready"
      );
      const editor = smartbar.inputField;
      await TestUtils.waitForCondition(
        () => editor.view,
        "The editor is ready for a mention"
      );
      editor.value = "Read ";
      editor.insertMention(
        { type: "tab", id: PAGE_URL, label: "Example Domain" },
        5
      );
      Assert.ok(
        !AssistantSession.getPageAccess(browser).shared,
        "An unsent draft does not share access"
      );
      submit = sinon.stub(chat, "submitChatMessage");
      smartbar.ownerDocument.dispatchEvent(
        new smartbar.documentGlobal.CustomEvent("smartbar-commit", {
          detail: {
            value: "Read this page",
            action: "chat",
            contextMentions: smartbar.getResolvedContextWebsites(),
            contextPageUrl: new URL(PAGE_URL),
          },
          bubbles: true,
        })
      );
      Assert.ok(submit.calledOnce);
      Assert.ok(
        AssistantSession.getPageAccess(browser).shared,
        "Sending an explicit @mention shares its principal"
      );
      await pageAccessStatus(chat, true);
      chat.shadowRoot.querySelector(".page-access-toggle").click();
      await pageAccessStatus(chat, false);
      AssistantSession.sharePage(browser);
      await pageAccessStatus(chat, true);
      await chat.onCreateNewChatClick();
      await pageAccessStatus(chat, false);
      Assert.equal(
        AssistantSession.sharedPages.length,
        0,
        "Clearing the assistant revokes all sharing"
      );
    } finally {
      submit?.restore();
      await AssistantSession.clear();
      await mock.rejectAllRequests();
      if (win) {
        await BrowserTestUtils.closeWindow(win);
      }
      mock.cleanupMocks();
    }
  }
);
