/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { GuestAuthProviderImpl } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/auth/GuestAuthProviderImpl.sys.mjs"
);

const PREF_TOKEN = "browser.smartwindow.auth.guest.token";
const PREF_FIRSTRUN_COMPLETED = "browser.smartwindow.firstrun.hasCompleted";
const SUCCESS_PATH = "/verify/v1/guest/success";

/**
 * Runs a task against a mock MLPA server set as the Smart Window endpoint.
 *
 * @param {Function} onVerify Called with the state and origin of each
 *   /verify/v1/guest request. Returns the URL to redirect to, or null to serve
 *   a plain page.
 * @param {Function} task Called with the origin of the mock server.
 */
async function withMockMLPA(onVerify, task) {
  const server = new HttpServer();
  server.registerPathHandler("/verify/v1/guest", (request, response) => {
    const state = new URLSearchParams(request.queryString).get("state");
    const location = onVerify(state, origin);
    if (location) {
      response.setStatusLine(request.httpVersion, 302, "Found");
      response.setHeader("Location", location, false);
      return;
    }
    response.setHeader("Content-Type", "text/html", false);
    response.write("<!doctype html><title>verify</title>");
  });
  server.registerPathHandler(SUCCESS_PATH, (_request, response) => {
    response.setHeader("Content-Type", "text/html", false);
    response.write("<!doctype html><title>success</title>");
  });
  server.start(-1);

  // eslint-disable-next-line sdl/no-insecure-url
  const origin = `http://localhost:${server.identity.primaryPort}`;
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.endpoint", `${origin}/v1`]],
  });

  try {
    await task(origin);
  } finally {
    Services.prefs.clearUserPref(PREF_TOKEN);
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => server.stop(resolve));
  }
}

function successURL(origin, params) {
  return `${origin}${SUCCESS_PATH}#${new URLSearchParams(params)}`;
}

function waitForSuccessTab(origin) {
  return BrowserTestUtils.waitForNewTab(
    gBrowser,
    url => url.startsWith(`${origin}${SUCCESS_PATH}`),
    true
  );
}

add_task(async function test_signIn_stores_token_and_closes_tab() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF_FIRSTRUN_COMPLETED, true]] });

  await withMockMLPA(
    (state, origin) =>
      successURL(origin, { state, access_token: "guest-token" }),
    async () => {
      const impl = new GuestAuthProviderImpl();
      const tabCount = gBrowser.tabs.length;

      Assert.ok(!(await impl.isSignedIn()), "Not signed in before signIn");

      const didSignIn = await impl.signIn(gBrowser.selectedBrowser);

      Assert.ok(didSignIn, "signIn resolves to true");
      Assert.equal(
        Services.prefs.getStringPref(PREF_TOKEN, ""),
        "guest-token",
        "The access token is cached in the pref"
      );
      Assert.equal(await impl.getToken(), "guest-token", "getToken");
      Assert.ok(await impl.isSignedIn(), "Signed in after signIn");
      Assert.equal(gBrowser.tabs.length, tabCount, "The guest tab is closed");
    }
  );

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_signIn_keeps_tab_during_firstrun() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF_FIRSTRUN_COMPLETED, false]] });

  await withMockMLPA(
    (state, origin) =>
      successURL(origin, { state, access_token: "guest-token" }),
    async origin => {
      const impl = new GuestAuthProviderImpl();
      const tabPromise = waitForSuccessTab(origin);

      const didSignIn = await impl.signIn(gBrowser.selectedBrowser);
      const tab = await tabPromise;

      Assert.ok(didSignIn, "signIn resolves to true");
      Assert.ok(tab.isConnected, "The guest tab stays open during first run");
      BrowserTestUtils.removeTab(tab);
    }
  );

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_signIn_ignores_mismatched_state() {
  await withMockMLPA(
    (_state, origin) =>
      successURL(origin, { state: "not-our-state", access_token: "evil" }),
    async origin => {
      const impl = new GuestAuthProviderImpl();
      const tabPromise = waitForSuccessTab(origin);

      const signInPromise = impl.signIn(gBrowser.selectedBrowser);
      const tab = await tabPromise;
      BrowserTestUtils.removeTab(tab);

      Assert.ok(!(await signInPromise), "signIn resolves to false");
      Assert.equal(await impl.getToken(), null, "No token is cached");
    }
  );
});

add_task(async function test_signIn_ignores_other_origins() {
  let verifyState = null;

  await withMockMLPA(
    state => {
      verifyState = state;
      return null;
    },
    async origin => {
      const impl = new GuestAuthProviderImpl();
      const tabPromise = BrowserTestUtils.waitForNewTab(
        gBrowser,
        url => url.startsWith(origin),
        true
      );

      const signInPromise = impl.signIn(gBrowser.selectedBrowser);
      const tab = await tabPromise;
      Assert.ok(verifyState, "The verify page received a state");

      const otherURL = successURL("https://example.com", {
        state: verifyState,
        access_token: "evil",
      });
      const loaded = BrowserTestUtils.browserLoaded(
        tab.linkedBrowser,
        false,
        otherURL
      );
      BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, otherURL);
      await loaded;
      BrowserTestUtils.removeTab(tab);

      Assert.ok(!(await signInPromise), "signIn resolves to false");
      Assert.equal(await impl.getToken(), null, "No token is cached");
    }
  );
});

add_task(async function test_signIn_tab_closed() {
  await withMockMLPA(
    () => null,
    async origin => {
      const impl = new GuestAuthProviderImpl();
      const tabPromise = BrowserTestUtils.waitForNewTab(
        gBrowser,
        url => url.startsWith(origin),
        true
      );

      const signInPromise = impl.signIn(gBrowser.selectedBrowser);
      BrowserTestUtils.removeTab(await tabPromise);

      Assert.ok(!(await signInPromise), "signIn resolves to false");
      Assert.ok(!(await impl.isSignedIn()), "Not signed in");
    }
  );
});

add_task(async function test_invalidateToken() {
  const impl = new GuestAuthProviderImpl();
  Services.prefs.setStringPref(PREF_TOKEN, "guest-token");

  await impl.invalidateToken("other-token");
  Assert.equal(
    await impl.getToken(),
    "guest-token",
    "A different token does not clear the cached one"
  );

  await impl.invalidateToken("guest-token");
  Assert.equal(await impl.getToken(), null, "The cached token is cleared");
  Assert.ok(!(await impl.isSignedIn()), "Not signed in after invalidation");

  Services.prefs.clearUserPref(PREF_TOKEN);
});
