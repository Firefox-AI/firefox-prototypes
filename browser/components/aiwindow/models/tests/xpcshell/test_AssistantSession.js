/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

do_get_profile();
Services.prefs.setIntPref("privacy.bounceTrackingProtection.mode", 0);
registerCleanupFunction(() =>
  Services.prefs.clearUserPref("privacy.bounceTrackingProtection.mode")
);

const { AssistantSession } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/AssistantSession.sys.mjs"
);
const { ChatConversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
);

add_task(
  async function test_old_network_inventory_does_not_become_page_visits() {
    await AssistantSession.clear();
    const conversation = AssistantSession.conversation;
    conversation.addUserMessage(
      "Keep this conversation while the inventory changes"
    );
    const pref = "browser.smartwindow.assistant.visitedSites";
    Services.prefs.setStringPref(
      pref,
      JSON.stringify(["https://tracker.example", "https://example.com"])
    );
    const legacy = new AssistantSession.constructor();
    Services.prefs.setStringPref(
      "browser.smartwindow.assistant.conversationId",
      conversation.id
    );
    legacy.setConversation(new ChatConversation({ id: conversation.id }));
    Assert.deepEqual(
      legacy.visitedSites,
      [],
      "Old network destinations lack page-visit provenance and are ignored"
    );
    Services.prefs.setStringPref(
      pref,
      JSON.stringify({
        version: 2,
        origins: [
          "https://example.com/path",
          "https://example.com/other",
          "https://example.org",
          "about:blank",
          "invalid",
        ],
      })
    );
    const current = new AssistantSession.constructor();
    current.setConversation(new ChatConversation({ id: conversation.id }));
    Assert.deepEqual(
      current.visitedSites,
      ["https://example.com", "https://example.org"],
      "Versioned page visits normalize, deduplicate, and validate origins"
    );
    Assert.strictEqual(
      AssistantSession.conversation,
      conversation,
      "Rebuilding the site list does not reset the chat"
    );
    await AssistantSession.clear();
  }
);

add_task(async function test_shared_session_reset() {
  await AssistantSession.ready();
  const conversation = AssistantSession.conversation;
  conversation.addUserMessage("Remember this conversation");
  Assert.strictEqual(AssistantSession.conversation, conversation);
  const attributes = AssistantSession.originAttributes;
  const chatAttributes = AssistantSession.chatOriginAttributes;
  Assert.notEqual(chatAttributes.userContextId, attributes.userContextId);
  Assert.notEqual(attributes.userContextId, 0);
  Assert.deepEqual(AssistantSession.originAttributes, attributes);

  const controller = AssistantSession.beginTurn();
  Assert.ok(controller);
  Assert.equal(
    AssistantSession.beginTurn(),
    null,
    "Only one view can start a turn at a time"
  );
  const clearing = AssistantSession.clear();
  Assert.ok(
    controller.signal.aborted,
    "Reset immediately cancels the active turn"
  );
  await clearing;
  Assert.notStrictEqual(AssistantSession.conversation, conversation);
  Assert.equal(AssistantSession.conversation.messageCount, 0);
});

add_task(async function test_reset_waits_for_reads_and_notifies_all_views() {
  const views = [];
  const onChange = (_event, conversation) => views.push(conversation);
  AssistantSession.on("conversation-changed", onChange);
  const started = Promise.withResolvers();
  const reading = AssistantSession.withRead(
    signal =>
      new Promise(resolve => {
        signal.addEventListener("abort", () => resolve("canceled"), {
          once: true,
        });
        started.resolve();
      })
  );
  await started.promise;
  await AssistantSession.clear();
  Assert.equal(await reading, "canceled");
  Assert.strictEqual(views.at(-1), AssistantSession.conversation);
  const restored = new ChatConversation({});
  AssistantSession.setConversation(restored);
  Assert.strictEqual(AssistantSession.conversation, restored);
  AssistantSession.off("conversation-changed", onChange);
});

add_task(async function test_reset_cancels_reads_that_have_not_started() {
  let readStarted = false;
  const reading = AssistantSession.withRead(() => {
    readStarted = true;
  });
  const clearing = AssistantSession.clear();
  await Assert.rejects(reading, /abort/i);
  await clearing;
  Assert.ok(
    !readStarted,
    "A read queued before reset cannot use the new session"
  );
});

add_task(async function test_persisted_session_is_restored_after_restart() {
  const { ChatStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs"
  );
  const conversation = new ChatConversation({
    title: "Shared session",
    description: "",
    pageMeta: {},
  });
  conversation.addUserMessage("Keep this across restarts");
  AssistantSession.setConversation(conversation);
  await ChatStore.updateConversation(conversation);
  const restarted = new AssistantSession.constructor();
  const restored = await restarted.ready();
  Assert.equal(restored.id, conversation.id);
  Assert.equal(
    restored.messages.at(-1).content.body,
    "Keep this across restarts"
  );
  Assert.deepEqual(
    restarted.originAttributes,
    AssistantSession.originAttributes
  );
  await AssistantSession.clear();
});

function pageBrowser(url = "https://example.com/page", attributes = {}) {
  const uri = Services.io.newURI(url);
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    uri,
    attributes
  );
  return {
    currentURI: uri,
    browsingContext: {
      currentWindowGlobal: { documentStoragePrincipal: principal },
    },
  };
}

add_task(async function test_history_restores_exact_grants_and_revocation() {
  const { ChatStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs"
  );
  await AssistantSession.clear();
  const first = AssistantSession.conversation;
  first.addUserMessage("Share this specific storage principal");
  const page = pageBrowser(undefined, {
    userContextId: 2,
    partitionKey: "(https,example.org)",
  });
  AssistantSession.sharePage(page);
  const attributes = AssistantSession.originAttributes;
  const chatAttributes = AssistantSession.chatOriginAttributes;
  const started = Promise.withResolvers();
  const reading = AssistantSession.withRead(signal => {
    started.resolve();
    return new Promise(resolve =>
      signal.addEventListener("abort", () => resolve("canceled"), {
        once: true,
      })
    );
  });
  await started.promise;
  await AssistantSession.startNewConversation();
  Assert.equal(
    await reading,
    "canceled",
    "Switching cancels the previous chat's reads"
  );
  Assert.ok(!AssistantSession.getPageAccess(page).shared);
  Assert.notEqual(
    AssistantSession.originAttributes.userContextId,
    attributes.userContextId
  );
  Assert.deepEqual(
    AssistantSession.chatOriginAttributes,
    chatAttributes,
    "The chat renderer keeps a stable identity while browsing identities switch"
  );
  const restored = await ChatStore.findConversationById(first.id);
  AssistantSession.setConversation(restored);
  Assert.deepEqual(AssistantSession.originAttributes, attributes);
  Assert.ok(AssistantSession.getPageAccess(page).shared);
  Assert.ok(!AssistantSession.getPageAccess(pageBrowser()).shared);
  Assert.ok(
    !AssistantSession.getPageAccess(
      pageBrowser(undefined, { userContextId: 2 })
    ).shared
  );
  AssistantSession.revokePageAccess(AssistantSession.getPageAccess(page).key);
  await AssistantSession.startNewConversation();
  AssistantSession.setConversation(
    await ChatStore.findConversationById(first.id)
  );
  Assert.ok(
    !AssistantSession.getPageAccess(page).shared,
    "Revocations survive history restoration"
  );
  await ChatStore.deleteConversationById(first.id);
});

add_task(async function test_page_access_is_scoped_to_the_storage_principal() {
  const session = new AssistantSession.constructor();
  const page = pageBrowser();
  const sameSite = pageBrowser("https://example.com/other");
  const otherSite = pageBrowser("https://example.org/page");
  const container = pageBrowser(undefined, { userContextId: 2 });
  const partition = pageBrowser(undefined, {
    partitionKey: "(https,example.org)",
  });
  Assert.ok(!session.getPageAccess(page).shared, "Page access starts private");
  session.sharePage(page);
  Assert.ok(session.getPageAccess(sameSite).shared);
  for (const other of [otherSite, container, partition]) {
    Assert.ok(
      !session.getPageAccess(other).shared,
      "Other storage principals remain private"
    );
  }
  Assert.equal(session.sharedPages.length, 1);
  Assert.ok(
    !new AssistantSession.constructor().getPageAccess(page).shared,
    "A new conversation does not inherit sharing grants"
  );
  session.revokePageAccess(session.getPageAccess(page).key);
  Assert.ok(!session.getPageAccess(sameSite).shared);
  Assert.equal(session.getPagePrincipal(pageBrowser("about:blank")), null);
  const mismatched = pageBrowser();
  mismatched.currentURI = Services.io.newURI("https://example.org/");
  Assert.equal(
    session.getPagePrincipal(mismatched),
    null,
    "A stale window global cannot identify the current page's principal"
  );
});

add_task(async function test_only_explicit_mentions_share_page_access() {
  const session = new AssistantSession.constructor();
  const browser = pageBrowser();
  const tab = { linkedBrowser: browser };
  session.getTabsWithURL = () => [tab];
  session.shareMentionedPages([
    { type: "currentTab", url: browser.currentURI.spec },
  ]);
  Assert.ok(
    !session.getPageAccess(browser).shared,
    "Implicit context does not grant access"
  );
  session.shareMentionedPages([{ type: "tab", url: browser.currentURI.spec }]);
  Assert.ok(
    session.getPageAccess(browser).shared,
    "An explicit mention grants access"
  );

  const ambiguous = new AssistantSession.constructor();
  const container = {
    linkedBrowser: pageBrowser(undefined, { userContextId: 3 }),
  };
  ambiguous.getTabsWithURL = () => [tab, container];
  ambiguous.shareMentionedPages([{ url: browser.currentURI.spec }]);
  Assert.equal(
    ambiguous.sharedPages.length,
    0,
    "Ambiguous mentions cannot share a different container"
  );
});

add_task(async function test_page_access_requests_require_a_decision() {
  const session = new AssistantSession.constructor();
  const browser = pageBrowser();
  const first = session.requestPageAccess(browser);
  const second = session.requestPageAccess(browser);
  Assert.equal(
    session.pageAccessRequests.length,
    1,
    "Requests for one principal are coalesced"
  );
  Assert.ok(!session.getPageAccess(browser).shared);
  session.resolvePageAccessRequest(session.pageAccessRequests[0].id, false);
  Assert.ok(!(await first) && !(await second));
  Assert.ok(
    !(await session.requestPageAccess(browser)),
    "A denied request is not repeated in the same turn"
  );

  const controller = session.beginTurn();
  const approved = session.requestPageAccess(browser);
  session.resolvePageAccessRequest(session.pageAccessRequests[0].id, true);
  Assert.ok(await approved);
  Assert.ok(session.getPageAccess(browser).shared);
  session.endTurn(controller);
  await session.clear();
  Assert.ok(!session.getPageAccess(browser).shared);
});

add_task(async function test_cancellation_and_navigation_cannot_grant_access() {
  const session = new AssistantSession.constructor();
  const browser = pageBrowser();
  const controller = new AbortController();
  const canceled = session.requestPageAccess(browser, controller.signal);
  const staleId = session.pageAccessRequests[0].id;
  controller.abort();
  Assert.ok(!(await canceled));
  session.resolvePageAccessRequest(staleId, true);
  Assert.ok(!session.getPageAccess(browser).shared);

  const moved = session.requestPageAccess(browser);
  const movedId = session.pageAccessRequests[0].id;
  Object.assign(browser, pageBrowser("https://example.org/"));
  session.resolvePageAccessRequest(movedId, true);
  Assert.ok(!(await moved));
  Assert.equal(session.sharedPages.length, 0);

  const pending = session.requestPageAccess(browser);
  await session.clear();
  Assert.ok(!(await pending));
  Assert.equal(session.pageAccessRequests.length, 0);
});

add_task(async function test_revoking_access_cancels_in_flight_reads() {
  const session = new AssistantSession.constructor();
  const browser = pageBrowser();
  session.sharePage(browser);
  const pending = Promise.withResolvers();
  const reading = session.withPageAccess(browser, async () => {
    await pending.promise;
    return "private page content";
  });
  session.revokePageAccess(session.getPageAccess(browser).key);
  pending.resolve();
  await Assert.rejects(reading, /abort/i);

  session.sharePage(browser);
  const navigation = Promise.withResolvers();
  const navigatedRead = session.withPageAccess(browser, async () => {
    await navigation.promise;
  });
  Object.assign(browser, pageBrowser("https://example.com/other"));
  navigation.resolve();
  await Assert.rejects(navigatedRead, /navigated/i);
});
