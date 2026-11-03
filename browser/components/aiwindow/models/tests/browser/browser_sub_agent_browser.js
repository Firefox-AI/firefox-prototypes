/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { SubAgentBrowser } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/SubAgentBrowser.sys.mjs"
);
const { ChatConversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
);

function createSession(signal) {
  const identity = ContextualIdentityService.createForAI(crypto.randomUUID());
  const conversation = new ChatConversation({});
  conversation.originAttributes = { userContextId: identity.userContextId };
  const browser = new SubAgentBrowser(conversation, signal);
  return {
    browser,
    conversation,
    async cleanup() {
      await browser.destroy();
      for (const tab of gBrowser.tabs.filter(
        candidate => candidate.userContextId === identity.userContextId
      )) {
        await BrowserTestUtils.removeTab(tab);
      }
      ContextualIdentityService.removeAIIdentity(identity.userContextId);
    },
  };
}

function target(state, name) {
  return {
    snapshot_id: state.snapshot_id,
    ref: state.elements.find(element => element.name.includes(name)).ref,
  };
}

add_task(async function test_isolated_browser_interactions() {
  const { url, server } = serveHTML(`<!doctype html>
    <title>Agent test</title>
    <label>Name <input id="name" oninput="document.querySelector('#output').textContent=this.value"></label>
    <p id="output">No input</p>
    <div contenteditable="true" aria-label="Notes">Old notes</div>
    <button onclick="document.querySelector('#result').textContent='Clicked';document.cookie='agent_cookie=isolated;path=/'">Save</button>
    <p id="result"></p>
    <a href="/next.html">Next</a>
    <div style="height:3000px">Scrollable content</div>`);
  let navigationCookie;
  server.registerPathHandler("/next.html", (request, response) => {
    navigationCookie = request.hasHeader("Cookie")
      ? request.getHeader("Cookie")
      : "";
    response.setHeader("Content-Type", "text/html");
    response.write(
      "<!doctype html><title>Next page</title><p>Arrived on the next page.</p>"
    );
  });
  const first = createSession();
  const second = createSession();
  const host = Services.io.newURI(url).host;
  Services.cookies.add(
    host,
    "/",
    "user_session",
    "private",
    false,
    false,
    true,
    Date.now() / 1000 + 3600,
    {},
    Ci.nsICookie.SAMESITE_UNSET,
    Ci.nsICookie.SCHEME_HTTP
  );
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  try {
    let state = await first.browser.execute("browser_navigate", { url });
    Assert.equal(gBrowser.selectedTab, tab, "Agent navigation stays in the background");
    Assert.ok(state.title.includes("Agent test"));
    Assert.deepEqual(
      state.originAttributes,
      first.conversation.originAttributes
    );
    const originalTarget = target(state, "Name");
    const originalValue = state.elements.find(
      element => element.ref === originalTarget.ref
    ).value;
    state = await first.browser.execute("browser_type", {
      ...originalTarget,
      text: "Hello agent",
    });
    Assert.ok(
      state.text.includes("Hello agent"),
      "Typing dispatches input events"
    );
    Assert.ok(
      state.elements
        .find(element => element.name.includes("Name"))
        .value.includes("Hello agent")
    );
    const stale = await first.browser.execute("browser_click", originalTarget);
    Assert.equal(stale.code, "stale_snapshot");
    state = await first.browser.execute("browser_type", {
      ...target(state, "Name"),
      text: " again",
      replace: false,
    });
    Assert.ok(
      state.elements
        .find(element => element.name.includes("Name"))
        .value.includes("Hello agent again")
    );
    state = await first.browser.execute("browser_scroll", {
      direction: "bottom",
    });
    Assert.greater(state.scroll_y, 0, "The isolated page can scroll");
    state = await first.browser.execute("browser_type", {
      ...target(state, "Notes"),
      text: "Updated notes",
    });
    Assert.ok(
      state.text.includes("Updated notes"),
      "Contenteditable fields accept text"
    );
    state = await first.browser.execute("browser_click", target(state, "Save"));
    Assert.ok(
      state.text.includes("Clicked"),
      "The click reaches the target element"
    );
    const other = await second.browser.execute("browser_navigate", { url });
    Assert.equal(
      other.elements.find(element => element.name.includes("Name")).value,
      originalValue,
      "Another agent has a separate document"
    );
    Assert.notEqual(
      other.originAttributes.userContextId,
      state.originAttributes.userContextId
    );
    state = await first.browser.execute("browser_click", target(state, "Next"));
    Assert.ok(
      state.url.endsWith("/next.html"),
      "Click waits for page navigation"
    );
    Assert.ok(state.text.includes("Arrived on the next page."));
    Assert.ok(
      navigationCookie.includes("agent_cookie=isolated"),
      "The cookie jar persists across actions and navigation"
    );
    Assert.ok(
      !navigationCookie.includes("user_session"),
      "The user cookie jar stays separate"
    );
    const userPage = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
      value: content.document.querySelector("input").value,
      scroll: content.scrollY,
      cookies: content.document.cookie,
    }));
    Assert.equal(userPage.value, "", "The user's page was not edited");
    Assert.equal(userPage.scroll, 0, "The user's page was not scrolled");
    Assert.ok(
      !userPage.cookies.includes("agent_cookie"),
      "The agent cookie is absent from the user's page"
    );
    Assert.ok(first.conversation.securityProperties.toJSON().untrustedInput);
    await Assert.rejects(
      first.browser.execute("browser_navigate", { url: "about:config" }),
      /HTTP/
    );
    await Assert.rejects(
      first.browser.execute("browser_navigate", { url: "javascript:alert(1)" }),
      /HTTP/
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    Services.cookies.remove(host, "user_session", "/", {});
    await first.cleanup();
    await second.cleanup();
    await new Promise(resolve => server.stop(resolve));
  }
});

add_task(async function test_cancel_browser_navigation() {
  const controller = new AbortController();
  const session = createSession(controller.signal);
  const { url, server } = serveHTML("unused");
  let pending;
  server.registerPathHandler("/stalled", (_request, response) => {
    pending = response;
    response.processAsync();
  });
  try {
    const operation = session.browser.execute("browser_navigate", {
      url: new URL("/stalled", url).href,
    });
    const rejection = operation.then(
      () => null,
      error => error
    );
    await TestUtils.waitForCondition(
      () => pending,
      "Navigation reaches the server"
    );
    controller.abort();
    Assert.equal((await rejection)?.name, "AbortError");
  } finally {
    await session.cleanup();
    pending?.finish();
    await new Promise(resolve => server.stop(resolve));
  }
});
