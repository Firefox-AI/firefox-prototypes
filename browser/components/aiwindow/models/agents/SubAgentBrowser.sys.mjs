/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { sanitizeUntrustedContent } from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";
import { isAllowedURLProtocol } from "moz-src:///browser/components/aiwindow/models/SecurityProperties.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["browser/aiWindowContent.ftl"], true)
);

const TIMEOUT_MS = 15000;
const GROUP_COLORS = ["purple", "cyan", "green", "orange", "pink", "blue", "yellow", "red"];
export const SUB_AGENT_BROWSER_PROMPT = `Browser tools read and control the live background tab that the user can select. Selecting that tab does not change its cookies or storage. A successful browser_click or browser_type only confirms that the interaction was dispatched; it does not confirm that the website accepted the requested change.

After changing a shopping cart, open the site's cart in this same tab using a link or URL from the browser results, then call browser_state with wait_ms: 1000 and verify the requested item, variant and quantity in the returned cart contents. If the site is still loading, read the state again. Leave the tab showing the cart so the user can inspect it. Do not report that an item is in the cart based only on a button click, product page, previous assistant statement, or get_page_content result. If the cart is empty or the outcome cannot be verified, report that clearly. Do not repeat an add-to-cart action just because its result was delayed, since this can add duplicate items.`;
const ELEMENT_PARAMS = {
  snapshot_id: {
    type: "string",
    description: "The snapshot_id from the most recent browser state.",
  },
  ref: {
    type: "string",
    description: "An element reference returned in that snapshot.",
  },
};

export const subAgentBrowserToolsConfig = [
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description:
        "Navigate the sub-agent's isolated background tab to an HTTP(S) URL. Returns page text, scroll position and interactive elements with references for clicking and typing. The user can inspect this tab, and it stays open after execution ends.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: {
            type: "string",
            description:
              "An absolute HTTP(S) URL or a URL token already provided in the conversation.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_state",
      description:
        "Read the live page in the sub-agent's actual tab and refresh element references. Navigate first. Use wait_ms for delayed website updates, then inspect the returned page to verify the result of an action. Each browser action also returns a fresh state.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          wait_ms: {
            type: "integer",
            minimum: 0,
            maximum: 10000,
            description: "Wait this many milliseconds before reading the page, for example 1000 after an asynchronous cart update. Defaults to 0.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description:
        "Click an element from the latest browser state. Waits for navigation when the click loads a page, and returns a fresh state. This confirms dispatch of the click, not acceptance by the website. Verify the resulting page, using browser_state with wait_ms for delayed updates. References cannot be reused after an action.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: ELEMENT_PARAMS,
        required: ["snapshot_id", "ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description:
        "Type text into an editable element from the latest browser state. Replaces its contents by default. Returns a fresh state. References cannot be reused after an action.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...ELEMENT_PARAMS,
          text: {
            type: "string",
            maxLength: 16000,
            description: "The text to enter into the editable element.",
          },
          replace: {
            type: "boolean",
            description:
              "Replace the current contents (true by default); false appends the text.",
          },
        },
        required: ["snapshot_id", "ref", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_scroll",
      description:
        "Scroll the current page in the sub-agent's isolated browser. Returns a fresh state including the new scroll position and element references.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right", "top", "bottom"],
            description:
              "The direction to scroll, or top/bottom to reach an end of the page.",
          },
          amount: {
            type: "integer",
            minimum: 1,
            maximum: 5000,
            description:
              "Optional distance in CSS pixels; defaults to one viewport.",
          },
        },
        required: ["direction"],
      },
    },
  },
];

export const SUB_AGENT_BROWSER_TOOLS = Object.freeze(
  subAgentBrowserToolsConfig.map(tool => tool.function.name)
);

/**
 *
 */
export class SubAgentBrowser {
  #conversation;
  #signal;
  #window;
  #tab;
  #name;
  #groupColor;
  #closed = new AbortController();
  #released = false;
  #onTabCreated;
  #onTabClosed;

  constructor(conversation, signal, { window, name, groupColor, onTabCreated, onTabClosed } = {}) {
    this.#conversation = conversation;
    this.#signal = AbortSignal.any([
      this.#closed.signal,
      ...(signal ? [signal] : []),
    ]);
    this.#window = window;
    this.#name = name;
    this.#groupColor = groupColor;
    this.#onTabCreated = onTabCreated;
    this.#onTabClosed = onTabClosed;
  }

  async #bounded(promise) {
    this.#signal?.throwIfAborted();
    let timeout;
    let abort;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Browser operation timed out")),
            TIMEOUT_MS
          );
          abort = () => reject(this.#signal.reason);
          this.#signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      this.#signal?.removeEventListener("abort", abort);
    }
  }

  async #getBrowser() {
    this.#signal.throwIfAborted();
    if (this.#released) {
      throw new Error("Sub-agent browser execution has ended");
    }
    let created = false;
    if (!this.#tab) {
      const window = this.#window ?? lazy.BrowserWindowTracker.getTopWindow();
      if (!window?.gBrowser || window.closed) {
        throw new Error("No browser window is available for the sub-agent");
      }
      this.#window = window;
      const group = window.gBrowser.tabGroups.find(candidate =>
        candidate.getAttribute("ai-sub-agent-group") === this.#conversation.id
      );
      const tab = window.gBrowser.addTab("about:blank", {
        inBackground: true,
        skipAnimation: true,
        tabGroup: group,
        userContextId: this.#conversation.originAttributes.userContextId,
        triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal(
          this.#conversation.originAttributes
        ),
      });
      this.#tab = tab;
      created = true;
      const browser = tab.linkedBrowser;
      tab.setAttribute("ai-sub-agent-id", this.#conversation.id);
      tab.setAttribute("ai-sub-agent-running", "true");
      tab.setAttribute(
        "aria-description",
        lazy.l10n.formatValueSync("sub-agent-tab-working")
      );
      browser.setAttribute("disableglobalhistory", "true");
      const configure = () => {
        browser.browsingContext.useGlobalHistory = false;
        browser.browsingContext.sandboxFlags = 0x2 | 0x800 | 0x10000;
        browser.browsingContext.mediaController?.mute();
      };
      const closed = this.#closed;
      const onTabClosed = this.#onTabClosed;
      const cleanup = () => {
        browser.removeEventListener("DidChangeBrowserRemoteness", configure);
        tab.removeEventListener("TabClose", cleanup);
        window.removeEventListener("unload", cleanup);
        closed.abort(new DOMException("Sub-agent browser tab was closed", "AbortError"));
        onTabClosed?.();
      };
      tab.addEventListener("TabClose", cleanup, { once: true });
      window.addEventListener("unload", cleanup, { once: true });
      browser.addEventListener("DidChangeBrowserRemoteness", configure);
      configure();
    }
    if (!this.hasOpenTab) {
      throw new Error("Sub-agent browser tab was closed");
    }
    const browser = this.#tab.linkedBrowser;
    if (
      browser.browsingContext.originAttributes.userContextId !==
      this.#conversation.originAttributes.userContextId
    ) {
      throw new Error("The browser does not belong to this sub-agent's origin");
    }
    this.ensureTabGroup();
    if (created) {
      this.#onTabCreated?.();
    }
    return browser;
  }

  ensureTabGroup() {
    if (!this.hasOpenTab) {
      return null;
    }
    const { gBrowser } = this.#window;
    const tabs = gBrowser.tabs.filter(
      tab => tab.getAttribute("ai-sub-agent-id") === this.#conversation.id
    );
    let group = gBrowser.tabGroups.find(
      candidate => candidate.getAttribute("ai-sub-agent-group") === this.#conversation.id
    );
    if (!group) {
      const usedColors = new Set(
        gBrowser.tabGroups
          .filter(candidate => candidate.hasAttribute("ai-sub-agent-group"))
          .map(candidate => candidate.color)
      );
      const color = this.#groupColor ?? GROUP_COLORS.find(value => !usedColors.has(value)) ??
        GROUP_COLORS[this.#conversation.originAttributes.userContextId % GROUP_COLORS.length];
      group = gBrowser.addTabGroup(tabs, {
        label: lazy.l10n.formatValueSync("sub-agent-tab-group-label", {
          name: this.#name ?? lazy.l10n.formatValueSync("sub-agent-tab-default-name"),
          id: this.#conversation.originAttributes.userContextId,
        }),
        color,
      });
      group.setAttribute("ai-sub-agent-group", this.#conversation.id);
      group.labelElement.setAttribute(
        "aria-description",
        lazy.l10n.formatValueSync("sub-agent-tab-group-description")
      );
    } else {
      const ungrouped = tabs.filter(tab => tab.group !== group);
      if (ungrouped.length) {
        group.addTabs(ungrouped);
      }
    }
    this.#groupColor = group.color;
    return this.tabGroup;
  }

  #getActor(browser) {
    this.#signal?.throwIfAborted();
    if (!isAllowedURLProtocol(browser.currentURI.spec)) {
      throw new Error(
        "Navigate to an HTTP(S) page before interacting with the browser"
      );
    }
    return browser.browsingContext.currentWindowGlobal.getActor(
      "SubAgentBrowser"
    );
  }

  async #state(browser) {
    const state = await this.#bounded(
      this.#getActor(browser).sendQuery("SubAgentBrowser:State")
    );
    this.#conversation.securityProperties.setPrivateData();
    this.#conversation.securityProperties.setUntrustedInput();
    this.#conversation.addSeenUrls([
      state.url,
      ...state.elements.map(element => element.href).filter(Boolean),
    ]);
    return {
      ...state,
      agent_id: this.#conversation.id,
      browser_context_id: browser.browsingContext.id,
      originAttributes: browser.browsingContext.originAttributes,
      observed_at: new Date().toISOString(),
      tabGroup: this.tabGroup,
      title: sanitizeUntrustedContent(state.title),
      text: sanitizeUntrustedContent(state.text),
      elements: state.elements.map(element => ({
        ...element,
        name: sanitizeUntrustedContent(element.name),
        ...(element.value === undefined
          ? {}
          : { value: sanitizeUntrustedContent(element.value) }),
      })),
    };
  }

  async #perform(browser, operation, expectsNavigation = false) {
    let started = false;
    const loaded = Promise.withResolvers();
    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onStateChange(progress, _request, flags) {
        if (
          !progress.isTopLevel ||
          !(flags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)
        ) {
          return;
        }
        if (flags & Ci.nsIWebProgressListener.STATE_START) {
          started = true;
        }
        if (started && flags & Ci.nsIWebProgressListener.STATE_STOP) {
          loaded.resolve();
        }
      },
      onLocationChange(progress, _request, _location, flags) {
        if (
          progress.isTopLevel &&
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
        ) {
          loaded.resolve();
        }
      },
    };
    browser.addProgressListener(
      listener,
      Ci.nsIWebProgress.NOTIFY_STATE_NETWORK | Ci.nsIWebProgress.NOTIFY_LOCATION
    );
    try {
      let result;
      try {
        result = await operation();
      } catch (error) {
        if (
          !started ||
          !["AbortError", "InvalidStateError"].includes(error.name)
        ) {
          throw error;
        }
      }
      if (result?.error) {
        return result;
      }
      await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
      if (expectsNavigation || started) {
        await this.#bounded(loaded.promise);
      }
      const state = await this.#state(browser);
      return result?.action
        ? { ...state, interaction: { ...result, status: "dispatched", site_effect_verified: false } }
        : state;
    } finally {
      browser.removeProgressListener(listener);
    }
  }

  async execute(name, args) {
    if (!SUB_AGENT_BROWSER_TOOLS.includes(name)) {
      throw new Error(`Unknown sub-agent browser tool: ${name}`);
    }
    const browser = await this.#getBrowser();
    if (name === "browser_navigate") {
      if (!isAllowedURLProtocol(args.url)) {
        throw new Error("Only absolute HTTP(S) URLs can be navigated to");
      }
      return this.#perform(
        browser,
        () =>
          browser.loadURI(Services.io.newURI(args.url), {
            triggeringPrincipal:
              Services.scriptSecurityManager.createNullPrincipal(
                this.#conversation.originAttributes
              ),
          }),
        true
      );
    }
    if (name === "browser_state") {
      const wait = args.wait_ms ?? 0;
      if (!Number.isInteger(wait) || wait < 0 || wait > 10000) {
        throw new Error("wait_ms must be an integer between 0 and 10000");
      }
      if (wait) {
        let timer;
        try {
          await this.#bounded(new Promise(resolve => { timer = setTimeout(resolve, wait); }));
        } finally {
          clearTimeout(timer);
        }
      }
      return this.#state(browser);
    }
    return this.#perform(browser, () =>
      this.#bounded(
        this.#getActor(browser).sendQuery(
          `SubAgentBrowser:${name.slice("browser_".length)}`,
          args
        )
      )
    );
  }

  async destroy() {
    this.#released = true;
    if (this.hasOpenTab) {
      this.#tab.removeAttribute("ai-sub-agent-running");
      this.#tab.setAttribute(
        "aria-description",
        lazy.l10n.formatValueSync("sub-agent-tab-idle")
      );
    }
    if (this.#signal.aborted && this.hasOpenTab) {
      this.#tab.linkedBrowser.stop();
    }
  }

  resume(signal) {
    this.#signal = AbortSignal.any([
      this.#closed.signal,
      ...(signal ? [signal] : []),
    ]);
    this.#released = false;
    if (this.hasOpenTab) {
      this.ensureTabGroup();
      this.#tab.setAttribute("ai-sub-agent-running", "true");
      this.#tab.setAttribute(
        "aria-description",
        lazy.l10n.formatValueSync("sub-agent-tab-working")
      );
    }
  }

  get wasClosed() {
    return this.#closed.signal.aborted;
  }

  get tabGroup() {
    const group = this.#tab?.group;
    return group?.getAttribute("ai-sub-agent-group") === this.#conversation.id
      ? { id: group.id, label: group.label, color: group.color }
      : null;
  }

  get hasOpenTab() {
    return !!this.#tab && !this.#tab.closing && !this.#window.closed;
  }
}
