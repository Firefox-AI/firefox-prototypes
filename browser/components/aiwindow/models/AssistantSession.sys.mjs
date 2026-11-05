/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EventEmitter } from "resource://gre/modules/EventEmitter.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ChatConversation:
    "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs",
  ChatStore:
    "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs",
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
});

const CONVERSATION_PREF = "browser.smartwindow.assistant.conversationId";
const SITES_PREF = "browser.smartwindow.assistant.visitedSites";
const SITES_VERSION = 2;
const IDENTITY_PREFIX = "userContextIdInternal.smartWindow";

export const PAGE_ACCESS_INSTRUCTIONS = `Page access capabilities:
You can fetch relevant web URLs with get_page_content using your own separate
browsing session, even when the user has not shared a site. Use the current page
URL supplied in browser context directly; list open tabs only when you need to
find a URL. Do not claim that unshared pages cannot be fetched.
For ordinary requests to read or summarize a web page, including the current
page, try source=auto first. A page being open in the user's browser does not
require sharing consent for an independent fetch.
Site sharing controls access to the user's live, signed-in tab and its storage
principal. get_page_content source=auto uses an already-shared live tab, otherwise
it fetches independently. source=assistant always fetches independently.
When the user's live or signed-in view is needed, use source=user_tab; the browser
requests sharing consent. Never treat an independent fetch as the user's exact
view. Page fetches remain subject to tool authorization and injection checks.`;

export const AssistantSession = new (class extends EventEmitter {
  #conversation = null;
  #ready = null;
  #controller = null;
  #turnDone = null;
  #clearing = Promise.resolve();
  #lifetime = new AbortController();
  #reads = new Map();
  #sharedPrincipals = new Map();
  #pageAccessRequests = new Map();
  #deniedPrincipals = new Set();
  #visitedSites = null;
  #documentObserver = null;
  #siteNotificationPending = null;
  #userContextId = null;
  #contextWrites = new Set();

  get conversation() {
    return (this.#conversation ??= new lazy.ChatConversation({}));
  }

  get originAttributes() {
    this.#userContextId ??=
      lazy.ContextualIdentityService.getOrCreatePrivateIdentity(
        this.#context.identityName
      ).userContextId;
    this.#trackDocuments();
    return { userContextId: this.#userContextId, privateBrowsingId: 0 };
  }

  get chatOriginAttributes() {
    const { userContextId } =
      lazy.ContextualIdentityService.getOrCreatePrivateIdentity(
        "userContextIdInternal.smartWindowChat"
      );
    return { userContextId, privateBrowsingId: 0 };
  }

  get #context() {
    const conversation = this.conversation;
    if (
      conversation.assistantContext?.version !== 1 ||
      ![IDENTITY_PREFIX, `${IDENTITY_PREFIX}.${conversation.id}`].includes(
        conversation.assistantContext.identityName
      )
    ) {
      const context = {
        version: 1,
        identityName: `${IDENTITY_PREFIX}.${conversation.id}`,
        visitedSites: [],
        sharedPrincipals: [],
      };
      if (
        Services.prefs.getStringPref(CONVERSATION_PREF, "") ===
          conversation.id &&
        Services.prefs.prefHasUserValue(SITES_PREF)
      ) {
        try {
          const saved = JSON.parse(Services.prefs.getStringPref(SITES_PREF));
          if (
            saved?.version === SITES_VERSION &&
            Array.isArray(saved.origins)
          ) {
            context.visitedSites = saved.origins;
          }
          context.identityName = IDENTITY_PREFIX;
        } catch {}
        Services.prefs.clearUserPref(SITES_PREF);
      }
      conversation.assistantContext = context;
    }
    return conversation.assistantContext;
  }

  #persistContext() {
    this.#context.visitedSites = this.visitedSites;
    this.#context.sharedPrincipals = [...this.#sharedPrincipals.values()]
      .filter(({ principal }) => !principal.originAttributes.privateBrowsingId)
      .map(({ principal }) => principal.origin);
    if (!this.conversation.messageCount) {
      return;
    }
    const write = lazy.ChatStore.updateConversation(this.conversation);
    this.#contextWrites.add(write);
    write.catch(console.error).finally(() => this.#contextWrites.delete(write));
  }

  async flushContextWrites() {
    await Promise.all([...this.#contextWrites]);
  }

  get visitedSites() {
    return [...this.#getVisitedSites()];
  }

  #getVisitedSites() {
    if (!this.#visitedSites) {
      this.#visitedSites = new Set();
      const sites = this.#context.visitedSites;
      if (Array.isArray(sites)) {
        for (const site of sites) {
          const url = typeof site === "string" && URL.parse(site);
          if (url && ["http:", "https:"].includes(url.protocol)) {
            this.#visitedSites.add(url.origin);
          }
        }
      }
    }
    return this.#visitedSites;
  }

  #trackDocuments() {
    if (this.#documentObserver) {
      return;
    }
    this.#documentObserver = global => {
      const uri = global.documentURI;
      if (
        global.browsingContext.parent ||
        !["http", "https"].includes(uri?.scheme)
      ) {
        return;
      }
      const attributes = global.documentPrincipal.originAttributes;
      if (
        attributes.userContextId !== this.#userContextId ||
        attributes.privateBrowsingId
      ) {
        return;
      }
      const origin = new URL(uri.spec).origin;
      if (this.#getVisitedSites().has(origin)) {
        return;
      }
      this.#visitedSites.add(origin);
      if (!this.#siteNotificationPending) {
        const conversation = this.conversation;
        this.#siteNotificationPending = conversation;
        Services.tm.dispatchToMainThread(() => {
          if (this.#siteNotificationPending !== conversation) {
            return;
          }
          this.#siteNotificationPending = null;
          this.#persistContext();
          this.emit("context-changed");
        });
      }
    };
    Services.obs.addObserver(this.#documentObserver, "window-global-created");
  }

  get isGenerating() {
    return !!this.#controller;
  }

  getPagePrincipal(browser) {
    const principal =
      browser?.browsingContext?.currentWindowGlobal?.documentStoragePrincipal;
    if (
      !principal?.isContentPrincipal ||
      !["http", "https"].includes(principal.URI?.scheme) ||
      !["http", "https"].includes(browser.currentURI?.scheme)
    ) {
      return null;
    }
    const expected = Services.scriptSecurityManager.createContentPrincipal(
      browser.currentURI,
      principal.originAttributes
    );
    return expected.equals(principal) ? principal : null;
  }

  #describePrincipal(principal) {
    return {
      key: principal.origin,
      origin: principal.originNoSuffix,
      userContextId: principal.originAttributes.userContextId,
      partitionKey: principal.originAttributes.partitionKey,
    };
  }

  getPageAccess(browser) {
    const principal = this.getPagePrincipal(browser);
    return principal
      ? {
          ...this.#describePrincipal(principal),
          shared: this.#sharedPrincipals.has(principal.origin),
        }
      : null;
  }

  get sharedPages() {
    return [...this.#sharedPrincipals.values()].map(({ principal }) =>
      this.#describePrincipal(principal)
    );
  }

  get pageAccessRequests() {
    return [...this.#pageAccessRequests.values()].map(({ principal, id }) => ({
      ...this.#describePrincipal(principal),
      id,
    }));
  }

  getTabsWithURL(url) {
    const tabs = [];
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      if (!lazy.AIWindow.isAIWindowActive(win) || win.closed || !win.gBrowser) {
        continue;
      }
      tabs.push(
        ...win.gBrowser.tabs.filter(
          tab => tab.linkedBrowser?.currentURI?.spec === url
        )
      );
    }
    return tabs;
  }

  sharePage(browser) {
    const principal = this.getPagePrincipal(browser);
    if (!principal) {
      return false;
    }
    if (!this.#sharedPrincipals.has(principal.origin)) {
      this.#sharedPrincipals.set(principal.origin, {
        principal,
        controller: new AbortController(),
      });
    }
    this.#deniedPrincipals.delete(principal.origin);
    this.#pageAccessRequests.get(principal.origin)?.finish(true);
    this.#persistContext();
    this.emit("page-access-changed");
    return true;
  }

  shareMentionedPages(mentions) {
    for (const mention of mentions ?? []) {
      if (!mention.url || mention.type === "currentTab") {
        continue;
      }
      const tabs = this.getTabsWithURL(mention.url).filter(tab =>
        this.getPagePrincipal(tab.linkedBrowser)
      );
      const principals = new Set(
        tabs
          .map(tab => this.getPagePrincipal(tab.linkedBrowser)?.origin)
          .filter(Boolean)
      );
      if (principals.size === 1) {
        this.sharePage(tabs[0].linkedBrowser);
      }
    }
  }

  revokePageAccess(key) {
    this.#sharedPrincipals.get(key)?.controller.abort();
    this.#sharedPrincipals.delete(key);
    this.#deniedPrincipals.add(key);
    this.#persistContext();
    this.emit("page-access-changed");
  }

  async requestPageAccess(browser, signal) {
    signal?.throwIfAborted();
    const principal = this.getPagePrincipal(browser);
    if (!principal || this.#deniedPrincipals.has(principal.origin)) {
      return false;
    }
    if (this.#sharedPrincipals.has(principal.origin)) {
      return true;
    }
    let request = this.#pageAccessRequests.get(principal.origin);
    if (!request) {
      const deferred = Promise.withResolvers();
      request = {
        id: Services.uuid.generateUUID().toString(),
        principal,
        browser,
        promise: deferred.promise,
        finish: allowed => {
          if (this.#pageAccessRequests.get(principal.origin) !== request) {
            return;
          }
          this.#pageAccessRequests.delete(principal.origin);
          deferred.resolve(allowed);
          this.emit("page-access-changed");
        },
      };
      this.#pageAccessRequests.set(principal.origin, request);
      this.emit("page-access-changed");
    }
    const onAbort = () => request.finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    try {
      return await request.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  resolvePageAccessRequest(id, allow) {
    const request = [...this.#pageAccessRequests.values()].find(
      item => item.id === id
    );
    if (!request) {
      return;
    }
    if (
      allow &&
      this.getPagePrincipal(request.browser)?.equals(request.principal)
    ) {
      this.sharePage(request.browser);
    } else {
      this.#deniedPrincipals.add(request.principal.origin);
      request.finish(false);
    }
  }

  async withPageAccess(browser, callback, signal) {
    const principal = this.getPagePrincipal(browser);
    const grant = principal && this.#sharedPrincipals.get(principal.origin);
    if (!grant) {
      throw new Error("This page's storage principal has not been shared");
    }
    const context = browser.browsingContext.currentWindowGlobal;
    const combined = AbortSignal.any([
      grant.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    combined.throwIfAborted();
    const result = await callback(context, combined);
    combined.throwIfAborted();
    if (browser.browsingContext?.currentWindowGlobal !== context) {
      throw new Error("The shared page navigated during the read");
    }
    return result;
  }

  async ready() {
    this.#ready ??= (async () => {
      const id = Services.prefs.getStringPref(CONVERSATION_PREF, "");
      const initial = this.conversation;
      if (id && !initial.messageCount) {
        const restored = await lazy.ChatStore.findConversationById(id);
        if (
          restored &&
          this.#conversation === initial &&
          !initial.messageCount
        ) {
          this.setConversation(restored);
        }
      }
      return this.conversation;
    })();
    await this.#ready;
    await this.#clearing;
    return this.conversation;
  }

  setConversation(conversation, { persistPrevious = true } = {}) {
    if (conversation === this.#conversation) {
      return;
    }
    if (this.#conversation && persistPrevious) {
      this.#persistContext();
    }
    this.cancel();
    this.#lifetime.abort();
    this.#lifetime = new AbortController();
    for (const { controller } of this.#sharedPrincipals.values()) {
      controller.abort();
    }
    this.#sharedPrincipals.clear();
    this.#deniedPrincipals.clear();
    this.#siteNotificationPending = null;
    this.#visitedSites = null;
    this.#userContextId = null;
    this.#conversation = conversation;
    const context = this.#context;
    if (Array.isArray(context.sharedPrincipals)) {
      for (const origin of context.sharedPrincipals) {
        try {
          const principal =
            Services.scriptSecurityManager.createContentPrincipalFromOrigin(
              origin
            );
          if (
            principal.isContentPrincipal &&
            ["http", "https"].includes(principal.URI.scheme) &&
            !principal.originAttributes.privateBrowsingId
          ) {
            this.#sharedPrincipals.set(principal.origin, {
              principal,
              controller: new AbortController(),
            });
          }
        } catch {}
      }
    }
    Services.prefs.setStringPref(CONVERSATION_PREF, conversation.id);
    this.#persistContext();
    this.emit("page-access-changed");
    this.emit("conversation-changed", conversation);
  }

  async startNewConversation() {
    this.setConversation(new lazy.ChatConversation({}));
    await this.flushContextWrites();
  }

  async clearConversationContext(conversation) {
    if (conversation.id === this.conversation.id) {
      await this.clear({ persistContext: false });
      return;
    }
    const identityName = conversation.assistantContext?.identityName;
    if (!identityName?.startsWith(IDENTITY_PREFIX)) {
      return;
    }
    const identity =
      lazy.ContextualIdentityService.getPrivateIdentity(identityName);
    if (identity) {
      const attributes = {
        userContextId: identity.userContextId,
        privateBrowsingId: 0,
      };
      this.emit("context-cleared", attributes);
      await Promise.allSettled(
        [...this.#reads]
          .filter(([, id]) => id === conversation.id)
          .map(([read]) => read)
      );
      await this.#clearStorage(attributes);
    }
  }

  #clearStorage(attributes) {
    return new Promise((resolve, reject) => {
      Services.clearData.deleteDataFromOriginAttributesPattern(
        attributes,
        flags => {
          if (flags) {
            reject(new Error("Could not clear assistant site data"));
          } else {
            resolve();
          }
        }
      );
    });
  }

  beginTurn() {
    if (this.isGenerating) {
      return null;
    }
    this.#controller = new AbortController();
    this.#deniedPrincipals.clear();
    this.#turnDone = Promise.withResolvers();
    Services.prefs.setStringPref(CONVERSATION_PREF, this.conversation.id);
    this.emit("generation-changed", true);
    return this.#controller;
  }

  endTurn(controller) {
    if (this.#controller === controller) {
      this.#controller = null;
      this.#turnDone?.resolve();
      this.#turnDone = null;
      this.emit("generation-changed", false);
    }
  }

  cancel() {
    this.#controller?.abort();
    this.#controller = null;
    this.#turnDone?.resolve();
    this.#turnDone = null;
    for (const request of this.#pageAccessRequests.values()) {
      request.finish(false);
    }
    this.emit("generation-changed", false);
  }

  async waitForIdle() {
    const controller = this.#controller;
    await this.#turnDone?.promise;
    return !controller?.signal.aborted;
  }

  async withRead(callback, signal) {
    const lifetime = this.#lifetime.signal;
    const conversationId = this.conversation.id;
    await this.#clearing;
    const combined = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const read = Promise.resolve().then(() => callback(combined));
    this.#reads.set(read, conversationId);
    try {
      return await read;
    } finally {
      this.#reads.delete(read);
    }
  }

  async clear({ persistContext = true } = {}) {
    this.cancel();
    const attributes = this.originAttributes;
    this.emit("context-cleared", attributes);
    this.#visitedSites = new Set();
    Services.prefs.clearUserPref(SITES_PREF);
    for (const { controller } of this.#sharedPrincipals.values()) {
      controller.abort();
    }
    this.#sharedPrincipals.clear();
    if (persistContext) {
      this.#persistContext();
    }
    this.#deniedPrincipals.clear();
    this.emit("page-access-changed");
    this.#lifetime.abort();
    const reads = [...this.#reads.keys()];
    const previousClear = this.#clearing.catch(() => {});
    this.#clearing = (async () => {
      await previousClear;
      await Promise.allSettled(reads);
      await this.flushContextWrites();
      await this.#clearStorage(attributes);
    })();
    this.#lifetime = new AbortController();
    this.setConversation(new lazy.ChatConversation({}), {
      persistPrevious: false,
    });
    await this.#clearing;
  }
})();
