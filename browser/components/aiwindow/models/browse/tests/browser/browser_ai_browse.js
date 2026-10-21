/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AIBrowse } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/browse/AIBrowse.sys.mjs"
);

const BASE = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);

function findElement(snapshot, label) {
  const element = snapshot.elements.find(e => e.label === label);
  Assert.ok(element, `"${label}" is in the snapshot`);
  return element;
}

add_task(async function test_browse() {
  const id = crypto.randomUUID();
  const selectedTab = gBrowser.selectedTab;

  let snapshot = await AIBrowse.open(id, BASE + "file_form.html");
  Assert.equal(snapshot.title, "Form page");
  Assert.ok(!snapshot.visible);

  const tab = AIBrowse.getTab(id);
  Assert.ok(tab.hidden, "The session tab is hidden");
  Assert.equal(gBrowser.selectedTab, selectedTab, "The selection is kept");

  const userContextId = AIBrowse.userContextIdFor(id);
  Assert.equal(tab.userContextId, userContextId);
  Assert.equal(
    ContextualIdentityService.getUserContextLabel(userContextId),
    `AI-Task ${id}`
  );
  Assert.ok(tab.classList.contains("identity-color-purple"));
  Assert.ok(
    !ContextualIdentityService.getPublicIdentities().some(
      i => i.userContextId === userContextId
    ),
    "The container is not offered to the user"
  );

  Assert.equal(
    Services.cookies.getCookiesFromHost("example.com", { userContextId })
      .length,
    1,
    "The page set its cookie in the container"
  );
  Assert.equal(
    Services.cookies.getCookiesFromHost("example.com", {}).length,
    0,
    "The cookie is not in the default container"
  );

  const far = findElement(snapshot, "Far away");
  Assert.ok(!far.inViewport);

  snapshot = await AIBrowse.type(
    id,
    findElement(snapshot, "Your name").uid,
    "Smart Window"
  );
  Assert.equal(findElement(snapshot, "Your name").value, "Smart Window");

  await AIBrowse.click(id, findElement(snapshot, "Greet").uid);
  Assert.stringContains(await AIBrowse.read(id), "Hello Smart Window");

  snapshot = await AIBrowse.snapshot(id);
  snapshot = await AIBrowse.click(id, findElement(snapshot, "Second page").uid);
  Assert.equal(snapshot.title, "Second page");

  await Assert.rejects(
    AIBrowse.click(id, far.uid),
    /take a new snapshot|take a new one/,
    "Uids of the previous page are rejected"
  );

  snapshot = await AIBrowse.back(id);
  Assert.equal(snapshot.title, "Form page");

  AIBrowse.show(id);
  Assert.ok(!tab.hidden);
  Assert.equal(gBrowser.selectedTab, tab);
  Assert.ok(AIBrowse.isVisible(id));

  AIBrowse.hide(id);
  Assert.ok(tab.hidden);
  Assert.notEqual(gBrowser.selectedTab, tab);

  Assert.ok(AIBrowse.toggle(id));
  Assert.ok(!AIBrowse.toggle(id));

  AIBrowse.forget(id);
  Assert.equal(AIBrowse.getTab(id), null);
  Assert.ok(!ContextualIdentityService.getPrivateIdentity(`AI-Task ${id}`));
  gBrowser.selectedTab = selectedTab;
});

add_task(async function test_act_on_selected_ai_task_tab() {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const selectedTab = gBrowser.selectedTab;

  await AIBrowse.open(first, BASE + "file_form.html");
  const tab = AIBrowse.getTab(first);

  await Assert.rejects(
    AIBrowse.snapshot(second),
    /no open page/,
    "A hidden tab of another conversation is not acted on"
  );

  AIBrowse.show(first);
  const snapshot = await AIBrowse.snapshot(second);
  Assert.equal(snapshot.title, "Form page");
  Assert.equal(AIBrowse.getTab(second), tab, "The selected tab is taken over");
  Assert.equal(AIBrowse.getTab(first), null);

  const link = snapshot.elements.find(e => e.label === "Second page");
  Assert.equal(
    (await AIBrowse.click(second, link.uid)).title,
    "Second page",
    "The click goes to the selected tab"
  );

  gBrowser.selectedTab = selectedTab;
  AIBrowse.forget(first);
  AIBrowse.forget(second);
});

add_task(async function test_url_without_scheme() {
  const id = crypto.randomUUID();
  const snapshot = await AIBrowse.open(
    id,
    BASE.replace("https://", "") + "file_second.html"
  );
  Assert.equal(snapshot.title, "Second page");
  Assert.ok(AIBrowse.getTab(id).linkedBrowser.currentURI.schemeIs("https"));
  AIBrowse.forget(id);
});

add_task(async function test_error_page() {
  const id = crypto.randomUUID();
  const snapshot = await AIBrowse.open(id, "https://nonexistent.example.com/");
  Assert.ok(snapshot.errorPage, "An error page is reported as such");
  Assert.deepEqual(snapshot.elements, []);
  AIBrowse.forget(id);
});

add_task(async function test_only_http() {
  const id = crypto.randomUUID();
  await Assert.rejects(
    AIBrowse.open(id, "about:config"),
    /Only http and https/
  );
  await Assert.rejects(AIBrowse.open(id, "file:///etc/passwd"), /Only http/);
  await Assert.rejects(AIBrowse.snapshot(id), /no open page/);
});
