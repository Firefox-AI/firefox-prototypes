/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Prototype agentic browsing for the Smart Window. A vision model drives one
 * of the user's tabs: it sees the page through screenshots and acts through
 * synthesized clicks, keystrokes, scrolling and navigation, until it calls
 * `done` or needs the user.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "BrowseAgent",
    maxLogLevelPref: "browser.smartwindow.browseAgent.loglevel",
  })
);

const PREF_PREFIX = "browser.smartwindow.browseAgent.";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;
const SETTLE_POLL_MS = 150;
const ACTION_SETTLE_MS = 700;
const LOAD_TIMEOUT_MS = 15000;
const READY_TIMEOUT_MS = 5000;
const MAX_WAIT_SECONDS = 10;
const MAX_REQUEST_ATTEMPTS = 3;
const JPEG_QUALITY = 0.85;

export const SESSION_STATE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  WAITING_FOR_USER: "waiting",
  DONE: "done",
  STOPPED: "stopped",
  ERROR: "error",
});

export const ENTRY_TYPE = Object.freeze({
  TASK: "task",
  ASSISTANT: "assistant",
  THINKING: "thinking",
  ACTION: "action",
  QUESTION: "question",
  ANSWER: "answer",
  DONE: "done",
  ERROR: "error",
  STATE: "state",
});

const SYSTEM_PROMPT = `You are the Firefox Browse Agent. You operate one of the user's real Firefox tabs to complete the task they gave you, with their own cookies and logins. You see the page through screenshots and act with the tools provided.

How to work
- Every action tool (navigate, click, type, key, scroll, wait, go_back) returns a fresh screenshot of the tab taken after the action, so you rarely need the screenshot tool.
- Coordinates are pixels in the most recent screenshot, origin at the top left. list_elements returns exact click targets with coordinates; prefer it over estimating coordinates, especially on dense pages. Use read_page to read long text such as a recipe or a list of search results.
- To search or go to a site, use navigate with a full URL, for example https://duckduckgo.com/?q=brownie+recipe or the site's own URL. After typing into a search box, press Enter with the key tool or use type with submit set to true.
- Verify the outcome in the screenshot before moving on, for example that an item really was added to the cart. If an action did not work, try a different approach instead of repeating it.
- Dismiss cookie banners, popups and dialogs that block the page.
- Choose sensible defaults instead of asking. If the task does not name a store or site, use a well known one that fits the task and say which one you used in your summary. Use ask_user only for choices that are the user's alone (which account, which address, whether to sign in) or when you are stuck.
- Hard limits: never complete a purchase, place an order, submit a payment, or send a message, email or post on the user's behalf. Adding items to a cart is fine; stop before any order confirmation and tell the user the cart is ready for review. Never enter passwords, card numbers or other credentials. If a site requires signing in, use ask_user so the user can sign in themselves, then continue.
- When the task is complete, or cannot be completed, call done with a short summary of what you did and what the user should check.

You are operating autonomously. The user is not watching every step and cannot answer questions mid-task except through ask_user, so proceed without asking for permission on reversible actions that follow from the task. When you have enough information to act, act. Keep your visible messages short: one sentence on what you are doing or found.`;

const TOOLS = [
  {
    name: "screenshot",
    description:
      "Take a screenshot of the tab. Action tools already return one, so this is only needed to re-check the page.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description:
      "Load a URL (http or https) in the tab and wait for it to load. Use this to open sites or run a search via a search URL.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "go_back",
    description: "Go back one page in the tab's history.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description:
      "Click at a point in the latest screenshot. Prefer coordinates from list_elements.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: {
          type: "boolean",
          description: "Double-click instead of a single click.",
        },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Type text into the focused element. Click the field first. Set submit to true to press Enter afterwards.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "key",
    description:
      "Press a key or combination: Enter, Tab, Escape, Backspace, Delete, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, PageDown, PageUp, Home, End, Space, or combinations such as ctrl+a or shift+Tab. ctrl maps to the platform accelerator key, so ctrl+a selects all on every platform.",
    input_schema: {
      type: "object",
      properties: {
        keys: { type: "string" },
        repeat: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["keys"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description:
      "Scroll the page, or the scrollable element under (x, y) when given. amount is in screenfuls and defaults to 0.75.",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", minimum: 0.1, maximum: 10 },
        x: { type: "integer" },
        y: { type: "integer" },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "list_elements",
    description:
      "List the visible interactive elements (links, buttons, inputs, menus) with their screenshot coordinates and labels. Cheap and precise; use it to find click targets and form fields.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_page",
    description:
      "Return the visible text of the page (truncated when long), for reading recipes, prices, search results or confirmation messages.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "wait",
    description:
      "Wait a few seconds for the page to change, then take a screenshot.",
    input_schema: {
      type: "object",
      properties: {
        seconds: { type: "number", minimum: 0.5, maximum: MAX_WAIT_SECONDS },
      },
      required: ["seconds"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description:
      "Pause and ask the user a question. Use it for decisions only they can make, to let them sign in, or when you are stuck. Returns their answer.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "done",
    description:
      "Finish the task. Summarize what you did, what the user should check, and anything you could not do.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        success: { type: "boolean" },
      },
      required: ["summary", "success"],
      additionalProperties: false,
    },
  },
];

function getPref(name, fallback) {
  const key = PREF_PREFIX + name;
  switch (typeof fallback) {
    case "boolean":
      return Services.prefs.getBoolPref(key, fallback);
    case "number":
      return Services.prefs.getIntPref(key, fallback);
    default:
      return Services.prefs.getStringPref(key, fallback);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = lazy.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      lazy.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function truncate(text, max) {
  text = String(text ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

/**
 * One request to the Claude Messages API. Optional features (thinking summary
 * display, server-side refusal fallbacks) are dropped and the request retried
 * once when the server rejects them, so the prototype keeps working across
 * models and accounts with different capabilities.
 *
 * @param {object} options
 * @param {object[]} options.messages - Conversation so far, API message shape.
 * @param {AbortSignal} options.signal
 * @param {{thinkingDisplay: boolean, fallbacks: boolean}} options.optionalFeatures
 * @returns {Promise<object>} The Messages API response body.
 */
async function requestCompletion({ messages, signal, optionalFeatures }) {
  const apiKey = BrowseAgent.getApiKey();
  if (!apiKey) {
    const error = new Error(
      "No model API key is configured. Add one in the panel or set the browser.smartwindow.browseAgent.apiKey preference."
    );
    error.code = "no-api-key";
    throw error;
  }

  const headers = new Headers({
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  });
  const betas = [];
  if (apiKey.startsWith("sk-ant-oat")) {
    headers.set("authorization", `Bearer ${apiKey}`);
    betas.push("oauth-2025-04-20");
  } else {
    headers.set("x-api-key", apiKey);
  }

  const body = {
    model: getPref("model", "claude-fable-5-1"),
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
    output_config: { effort: getPref("effort", "medium") },
    cache_control: { type: "ephemeral" },
  };
  if (optionalFeatures.thinkingDisplay) {
    body.thinking = { type: "adaptive", display: "summarized" };
  }
  if (optionalFeatures.fallbacks) {
    body.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }
  if (betas.length) {
    headers.set("anthropic-beta", betas.join(","));
  }

  const endpoint = getPref("endpoint", "https://api.anthropic.com/v1/messages");
  let lastError;
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      lastError = new Error(`Could not reach the model API: ${error.message}`);
      await sleep(1000 * 2 ** attempt, signal);
      continue;
    }

    const json = await response.json().catch(() => null);
    if (response.ok) {
      return json;
    }

    const message = json?.error?.message ?? response.statusText;
    lastError = new Error(`Model API error ${response.status}: ${message}`);
    lastError.status = response.status;
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt,
        signal
      );
      continue;
    }
    break;
  }
  throw lastError;
}

/**
 * One agentic run against one tab of one window.
 */
export class BrowseAgentSession {
  /** @type {ChromeWindow} */
  #win;
  /** @type {AbortController} */
  #abort = new AbortController();
  #listeners = new Set();
  #messages = [];
  #pendingAnswer = null;
  #scale = { x: 1, y: 1 };
  #optionalFeatures = {
    thinkingDisplay: getPref("showThinking", true),
    fallbacks: getPref("fallbacks", true),
  };

  /** The tab the agent is driving. */
  tab = null;
  task = "";
  state = SESSION_STATE.IDLE;
  stepCount = 0;
  result = null;
  /** Chronological log rendered by the panel. */
  entries = [];
  usage = { inputTokens: 0, outputTokens: 0 };

  constructor(win, task) {
    this.#win = win;
    this.task = task.trim();
  }

  get window() {
    return this.#win;
  }

  get browser() {
    return this.tab?.linkedBrowser ?? null;
  }

  get isActive() {
    return (
      this.state === SESSION_STATE.RUNNING ||
      this.state === SESSION_STATE.WAITING_FOR_USER
    );
  }

  /**
   * @param {(entry: object, session: BrowseAgentSession) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(entry) {
    entry.timestamp = Date.now();
    this.entries.push(entry);
    for (const listener of this.#listeners) {
      try {
        listener(entry, this);
      } catch (error) {
        lazy.console.error("listener failed", error);
      }
    }
  }

  #setState(state) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.#emit({ type: ENTRY_TYPE.STATE, state });
  }

  async start() {
    if (this.state !== SESSION_STATE.IDLE) {
      throw new Error("Session already started");
    }
    if (!this.task) {
      throw new Error("Empty task");
    }
    this.#setState(SESSION_STATE.RUNNING);
    this.#emit({ type: ENTRY_TYPE.TASK, text: this.task });

    const signal = this.#abort.signal;
    try {
      this.#pickTab();
      this.#win.gBrowser.tabContainer.addEventListener("TabOpen", this);
      this.#win.gBrowser.tabContainer.addEventListener("TabClose", this);

      await this.#settle();
      const initial = await this.#observe("Starting state of the tab.");
      this.#messages.push({
        role: "user",
        content: [{ type: "text", text: `Task: ${this.task}` }, ...initial],
      });
      await this.#loop(signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        this.#setState(SESSION_STATE.STOPPED);
      } else {
        lazy.console.error("session failed", error);
        this.#emit({
          type: ENTRY_TYPE.ERROR,
          text: error.message,
          code: error.code,
        });
        this.#setState(SESSION_STATE.ERROR);
      }
    } finally {
      this.#win.gBrowser?.tabContainer.removeEventListener("TabOpen", this);
      this.#win.gBrowser?.tabContainer.removeEventListener("TabClose", this);
    }
  }

  stop() {
    if (!this.isActive) {
      return;
    }
    this.#abort.abort();
    this.#pendingAnswer?.reject(new DOMException("Aborted", "AbortError"));
    this.#pendingAnswer = null;
    this.#setState(SESSION_STATE.STOPPED);
  }

  /**
   * Delivers the user's reply to a pending ask_user call.
   *
   * @param {string} text
   */
  answer(text) {
    if (!this.#pendingAnswer) {
      return false;
    }
    const pending = this.#pendingAnswer;
    this.#pendingAnswer = null;
    pending.resolve(text.trim());
    return true;
  }

  handleEvent(event) {
    const gBrowser = this.#win.gBrowser;
    switch (event.type) {
      case "TabOpen": {
        const newTab = event.target;
        if (this.isActive && newTab.openerTab === this.tab) {
          this.tab = newTab;
          gBrowser.selectedTab = newTab;
        }
        break;
      }
      case "TabClose":
        if (event.target === this.tab && this.isActive) {
          this.#emit({
            type: ENTRY_TYPE.ERROR,
            text: "The tab the agent was working in was closed.",
          });
          this.#abort.abort();
          this.#pendingAnswer?.reject(
            new DOMException("Aborted", "AbortError")
          );
          this.#pendingAnswer = null;
          this.#setState(SESSION_STATE.ERROR);
        }
        break;
    }
  }

  // Reuses the selected tab when it already shows a web page or is blank, and
  // opens a fresh tab otherwise (Smart Window new tab page, about:newtab...).
  #pickTab() {
    const gBrowser = this.#win.gBrowser;
    let tab = gBrowser.selectedTab;
    const spec = tab.linkedBrowser?.currentURI?.spec ?? "";
    if (!/^https?:/i.test(spec) && spec !== "about:blank") {
      tab = gBrowser.addTrustedTab("about:blank", { inBackground: false });
    }
    gBrowser.selectedTab = tab;
    this.tab = tab;
  }

  #requireBrowser() {
    const browser = this.browser;
    if (!browser || !this.tab.isConnected) {
      throw new Error("The agent's tab is gone.");
    }
    return browser;
  }

  async #query(name, data = {}) {
    const browser = this.#requireBrowser();
    const send = () =>
      browser.browsingContext.currentWindowGlobal
        .getActor("BrowseAgent")
        .sendQuery(`BrowseAgent:${name}`, data);
    try {
      return await send();
    } catch (error) {
      // The document went away mid-call (navigation); wait and try again.
      lazy.console.debug(`query ${name} failed, retrying`, error);
      await this.#settle();
      return send();
    }
  }

  async #loop(signal) {
    const maxSteps = getPref("maxSteps", 60);
    while (!signal.aborted) {
      if (++this.stepCount > maxSteps) {
        throw new Error(
          `Stopped after ${maxSteps} steps without finishing. Try a narrower task.`
        );
      }

      const response = await this.#request(signal);
      if (response.usage) {
        this.usage.inputTokens +=
          (response.usage.input_tokens ?? 0) +
          (response.usage.cache_read_input_tokens ?? 0) +
          (response.usage.cache_creation_input_tokens ?? 0);
        this.usage.outputTokens += response.usage.output_tokens ?? 0;
      }

      if (response.stop_reason === "refusal") {
        const detail = response.stop_details?.explanation;
        throw new Error(
          `The model declined to continue${detail ? `: ${detail}` : "."}`
        );
      }

      this.#messages.push({ role: "assistant", content: response.content });

      const toolUses = [];
      let lastText = "";
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          lastText = block.text.trim();
          this.#emit({ type: ENTRY_TYPE.ASSISTANT, text: lastText });
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          this.#emit({
            type: ENTRY_TYPE.THINKING,
            text: block.thinking.trim(),
          });
        } else if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }

      if (!toolUses.length) {
        if (response.stop_reason === "max_tokens") {
          this.#messages.push({
            role: "user",
            content: "Your reply was cut off. Continue with the task.",
          });
          continue;
        }
        this.#finish({ summary: lastText, success: true });
        return;
      }

      const results = [];
      let failed = false;
      let finished = null;
      for (const toolUse of toolUses) {
        if (signal.aborted) {
          return;
        }
        if (failed) {
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: "Not executed: an earlier action in this turn failed.",
          });
          continue;
        }
        try {
          const { content, finish } = await this.#runTool(toolUse);
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content,
          });
          if (finish) {
            finished = finish;
            break;
          }
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          failed = true;
          lazy.console.warn(`tool ${toolUse.name} failed`, error);
          this.#emit({
            type: ENTRY_TYPE.ACTION,
            name: toolUse.name,
            input: toolUse.input,
            status: `Failed: ${error.message}`,
            failed: true,
          });
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            is_error: true,
            content: error.message,
          });
        }
      }

      if (finished) {
        this.#finish(finished);
        return;
      }
      this.#messages.push({ role: "user", content: results });
    }
  }

  async #request(signal) {
    try {
      return await requestCompletion({
        messages: this.#messages,
        signal,
        optionalFeatures: this.#optionalFeatures,
      });
    } catch (error) {
      const anyOptional =
        this.#optionalFeatures.thinkingDisplay ||
        this.#optionalFeatures.fallbacks;
      if (error.status === 400 && anyOptional) {
        lazy.console.warn(
          "Retrying without optional request features after",
          error.message
        );
        this.#optionalFeatures = { thinkingDisplay: false, fallbacks: false };
        return requestCompletion({
          messages: this.#messages,
          signal,
          optionalFeatures: this.#optionalFeatures,
        });
      }
      throw error;
    }
  }

  #finish({ summary, success }) {
    this.result = { summary, success };
    this.#emit({ type: ENTRY_TYPE.DONE, text: summary, success });
    this.#setState(SESSION_STATE.DONE);
  }

  async #runTool({ name, input }) {
    switch (name) {
      case "screenshot":
        return this.#actionResult(name, input, "Screenshot taken.");

      case "navigate": {
        const uri = this.#parseNavigableURL(input.url);
        const browser = this.#requireBrowser();
        browser.loadURI(uri, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
        await this.#settle();
        return this.#actionResult(name, input, `Navigated to ${uri.spec}.`);
      }

      case "go_back": {
        const browser = this.#requireBrowser();
        if (!browser.canGoBack) {
          throw new Error("There is no previous page to go back to.");
        }
        browser.goBack();
        await this.#settle();
        return this.#actionResult(name, input, "Went back one page.");
      }

      case "click": {
        const point = this.#toCss(input.x, input.y);
        const result = await this.#query("Click", {
          ...point,
          button: input.button ?? "left",
          double: !!input.double,
        });
        await this.#settle();
        return this.#actionResult(
          name,
          input,
          `${input.double ? "Double-clicked" : "Clicked"} (${input.x}, ${input.y})${
            result.target ? ` on ${result.target}` : ""
          }.`
        );
      }

      case "type": {
        const result = await this.#query("Type", {
          text: String(input.text ?? ""),
          submit: !!input.submit,
        });
        await this.#settle();
        return this.#actionResult(
          name,
          input,
          `Typed "${truncate(input.text, 80)}" into ${result.target}${
            input.submit ? " and pressed Enter" : ""
          }.`
        );
      }

      case "key": {
        await this.#query("Key", {
          keys: String(input.keys ?? ""),
          repeat: input.repeat ?? 1,
        });
        await this.#settle();
        return this.#actionResult(
          name,
          input,
          `Pressed ${input.keys}${input.repeat > 1 ? ` ${input.repeat} times` : ""}.`
        );
      }

      case "scroll": {
        const data = {
          direction: input.direction,
          amount: input.amount ?? 0.75,
        };
        if (Number.isFinite(input.x) && Number.isFinite(input.y)) {
          Object.assign(data, this.#toCss(input.x, input.y));
        }
        const result = await this.#query("Scroll", data);
        await sleep(300, this.#abort.signal);
        return this.#actionResult(
          name,
          input,
          `Scrolled ${input.direction} in ${result.target}. Now at ${Math.round(
            result.scrollY
          )} of ${result.scrollHeight} px${result.atBottom ? " (bottom reached)" : ""}.`
        );
      }

      case "list_elements": {
        const { elements, total } = await this.#query("ListElements");
        const lines = elements.map(el => {
          const { x, y } = this.#toScreenshot(el.x, el.y);
          const extras = [];
          if (el.role) {
            extras.push(el.role);
          }
          if (el.value) {
            extras.push(`value="${el.value}"`);
          }
          if (el.checked != null) {
            extras.push(el.checked ? "checked" : "unchecked");
          }
          if (el.disabled) {
            extras.push("disabled");
          }
          if (el.href) {
            extras.push(el.href);
          }
          return `[${el.index}] <${el.tag}> "${el.label}" @(${x},${y})${
            extras.length ? ` ${extras.join(" ")}` : ""
          }`;
        });
        const text = lines.length
          ? `${lines.length} of ${total} interactive elements visible (coordinates are screenshot pixels):\n${lines.join("\n")}`
          : "No interactive elements are visible in the viewport.";
        this.#emit({
          type: ENTRY_TYPE.ACTION,
          name,
          input,
          status: `Listed ${lines.length} interactive elements.`,
        });
        return { content: [{ type: "text", text }] };
      }

      case "read_page": {
        const { text, truncated, title, url } = await this.#query("ReadPage");
        this.#emit({
          type: ENTRY_TYPE.ACTION,
          name,
          input,
          status: `Read the page text (${text.length} characters).`,
        });
        return {
          content: [
            {
              type: "text",
              text: `Page: ${title} — ${url}${truncated ? " (text truncated)" : ""}\n\n${text}`,
            },
          ],
        };
      }

      case "wait": {
        const seconds = Math.min(
          Math.max(Number(input.seconds) || 1, 0.5),
          MAX_WAIT_SECONDS
        );
        await sleep(seconds * 1000, this.#abort.signal);
        return this.#actionResult(name, input, `Waited ${seconds} seconds.`);
      }

      case "ask_user": {
        const question = String(input.question ?? "").trim();
        this.#emit({ type: ENTRY_TYPE.QUESTION, text: question });
        this.#setState(SESSION_STATE.WAITING_FOR_USER);
        const { promise, resolve, reject } = Promise.withResolvers();
        this.#pendingAnswer = { resolve, reject };
        const answer = await promise;
        this.#setState(SESSION_STATE.RUNNING);
        this.#emit({ type: ENTRY_TYPE.ANSWER, text: answer });
        const observed = await this.#observe(
          "Current state of the tab after the user replied."
        );
        return {
          content: [
            { type: "text", text: `User reply: ${answer || "(empty)"}` },
            ...observed,
          ],
        };
      }

      case "done":
        return {
          content: [{ type: "text", text: "OK" }],
          finish: {
            summary: String(input.summary ?? "").trim(),
            success: input.success !== false,
          },
        };

      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }

  #parseNavigableURL(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      throw new Error("navigate needs a URL.");
    }
    let uri;
    try {
      uri = Services.io.newURI(
        /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
      );
    } catch {
      throw new Error(`"${raw}" is not a valid URL.`);
    }
    if (!["http", "https"].includes(uri.scheme)) {
      throw new Error("Only http and https URLs can be opened.");
    }
    return uri;
  }

  // Emits the action to the panel together with the screenshot taken after it
  // and returns the tool result blocks for the model.
  async #actionResult(name, input, status) {
    const blocks = await this.#observe(status, { name, input });
    return { content: blocks };
  }

  async #observe(status, action = null) {
    const shot = await this.#screenshot();
    const text = [
      status,
      `Page: ${shot.title || "(untitled)"} — ${shot.url}`,
      `Screenshot ${shot.width}x${shot.height} px covering the ${shot.cssWidth}x${shot.cssHeight} CSS px viewport; page scrolled to ${Math.round(shot.scrollY)} of ${shot.scrollHeight} px.`,
    ].join("\n");
    this.#emit({
      type: ENTRY_TYPE.ACTION,
      name: action?.name ?? "screenshot",
      input: action?.input ?? {},
      status,
      url: shot.url,
      title: shot.title,
      image: shot.dataURL,
    });
    return [
      { type: "text", text },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: shot.base64 },
      },
    ];
  }

  async #screenshot() {
    const browser = this.#requireBrowser();
    const viewport = await this.#query("Viewport");
    const windowGlobal = browser.browsingContext?.currentWindowGlobal;
    if (!windowGlobal) {
      throw new Error("The tab has nothing to capture yet.");
    }
    const longEdge = Math.max(viewport.width, viewport.height, 1);
    const scale = Math.min(1, getPref("maxImageEdge", 1568) / longEdge);
    const bitmap = await windowGlobal.drawSnapshot(null, scale, "white");
    const canvas = this.#win.document.createElementNS(HTML_NS, "canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    const dataURL = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    this.#scale = {
      x: canvas.width / Math.max(viewport.width, 1),
      y: canvas.height / Math.max(viewport.height, 1),
    };
    return {
      ...viewport,
      cssWidth: viewport.width,
      cssHeight: viewport.height,
      width: canvas.width,
      height: canvas.height,
      dataURL,
      base64: dataURL.slice(dataURL.indexOf(",") + 1),
    };
  }

  #toCss(x, y) {
    return { x: x / this.#scale.x, y: y / this.#scale.y };
  }

  #toScreenshot(x, y) {
    return {
      x: Math.round(x * this.#scale.x),
      y: Math.round(y * this.#scale.y),
    };
  }

  // Waits for any navigation triggered by the last action to finish, with a
  // short grace period so a click has time to start one.
  async #settle() {
    const signal = this.#abort.signal;
    const browser = this.#requireBrowser();
    await sleep(ACTION_SETTLE_MS, signal);
    const start = Date.now();
    while (
      browser.webProgress?.isLoadingDocument &&
      Date.now() - start < LOAD_TIMEOUT_MS
    ) {
      await sleep(SETTLE_POLL_MS, signal);
    }
    const readyStart = Date.now();
    while (Date.now() - readyStart < READY_TIMEOUT_MS) {
      let viewport = null;
      try {
        viewport = await browser.browsingContext.currentWindowGlobal
          ?.getActor("BrowseAgent")
          .sendQuery("BrowseAgent:Viewport");
      } catch {
        // Document swapped under us; poll again.
      }
      if (viewport?.readyState === "complete") {
        break;
      }
      await sleep(SETTLE_POLL_MS, signal);
    }
  }
}

/**
 * Tracks the session of each window and the prototype's configuration.
 */
export const BrowseAgent = {
  /** @type {WeakMap<ChromeWindow, BrowseAgentSession>} */
  _sessions: new WeakMap(),

  get enabled() {
    return getPref("enabled", false);
  },

  get model() {
    return getPref("model", "claude-fable-5-1");
  },

  getApiKey() {
    return (
      getPref("apiKey", "") ||
      Services.env.get("ANTHROPIC_API_KEY") ||
      Services.env.get("ANTHROPIC_AUTH_TOKEN") ||
      ""
    );
  },

  setApiKey(key) {
    Services.prefs.setStringPref(PREF_PREFIX + "apiKey", key.trim());
  },

  hasApiKey() {
    return !!this.getApiKey();
  },

  getSession(win) {
    return this._sessions.get(win) ?? null;
  },

  /**
   * Starts a new session for the window's selected tab, stopping any active
   * one first.
   *
   * @param {ChromeWindow} win
   * @param {string} task
   * @returns {BrowseAgentSession}
   */
  startSession(win, task) {
    this.getSession(win)?.stop();
    const session = new BrowseAgentSession(win, task);
    this._sessions.set(win, session);
    session.start().catch(error => lazy.console.error(error));
    return session;
  },

  isSmartWindow(win) {
    return lazy.AIWindow.isAIWindowActive(win);
  },
};
