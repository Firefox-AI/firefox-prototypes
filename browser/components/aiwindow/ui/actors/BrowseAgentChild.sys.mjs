/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Content side of the Browse Agent: synthesizes input in the page and reports
 * what is on it. Coordinates are CSS pixels relative to the viewport.
 */

const EVENT_UTILS_URL = "chrome://remote/content/external/EventUtils.js";
const MAX_ELEMENTS = 150;
const MAX_TEXT_CHARS = 20000;
const MAX_LABEL_CHARS = 80;

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=option]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=combobox]",
  "[role=textbox]",
  "[role=searchbox]",
  "[role=slider]",
  "[contenteditable='']",
  "[contenteditable=true]",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "file",
  "image",
  "range",
  "color",
]);

const KEY_NAMES = new Map([
  ["enter", "KEY_Enter"],
  ["return", "KEY_Enter"],
  ["tab", "KEY_Tab"],
  ["escape", "KEY_Escape"],
  ["esc", "KEY_Escape"],
  ["backspace", "KEY_Backspace"],
  ["delete", "KEY_Delete"],
  ["del", "KEY_Delete"],
  ["arrowdown", "KEY_ArrowDown"],
  ["down", "KEY_ArrowDown"],
  ["arrowup", "KEY_ArrowUp"],
  ["up", "KEY_ArrowUp"],
  ["arrowleft", "KEY_ArrowLeft"],
  ["left", "KEY_ArrowLeft"],
  ["arrowright", "KEY_ArrowRight"],
  ["right", "KEY_ArrowRight"],
  ["pagedown", "KEY_PageDown"],
  ["pageup", "KEY_PageUp"],
  ["home", "KEY_Home"],
  ["end", "KEY_End"],
  ["space", " "],
  ["spacebar", " "],
]);

const MODIFIER_FLAGS = new Map([
  ["ctrl", "accelKey"],
  ["control", "accelKey"],
  ["cmd", "accelKey"],
  ["command", "accelKey"],
  ["meta", "accelKey"],
  ["super", "accelKey"],
  ["accel", "accelKey"],
  ["alt", "altKey"],
  ["option", "altKey"],
  ["shift", "shiftKey"],
]);

function collapseWhitespace(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Runs in the agent's tab and executes one request per message: synthesize a
 * click or keys, scroll, or describe what is visible.
 */
export class BrowseAgentChild extends JSWindowActorChild {
  #eventUtils = null;

  // EventUtils expects a window-like scope; follow BrowserTestUtilsChild and
  // pass the content window explicitly to every call instead.
  get #EventUtils() {
    if (!this.#eventUtils) {
      const win = this.contentWindow;
      const scope = {
        get KeyboardEvent() {
          return win.KeyboardEvent;
        },
        get navigator() {
          return win.navigator;
        },
      };
      scope.window = {};
      scope.parent = scope.window;
      scope._EU_Ci = Ci;
      scope._EU_Cc = Cc;
      Services.scriptloader.loadSubScript(EVENT_UTILS_URL, scope);
      this.#eventUtils = scope;
    }
    return this.#eventUtils;
  }

  receiveMessage({ name, data }) {
    switch (name) {
      case "BrowseAgent:Viewport":
        return this.#viewport();
      case "BrowseAgent:Click":
        return this.#click(data);
      case "BrowseAgent:Type":
        return this.#type(data);
      case "BrowseAgent:Key":
        return this.#key(data);
      case "BrowseAgent:Scroll":
        return this.#scroll(data);
      case "BrowseAgent:ListElements":
        return this.#listElements();
      case "BrowseAgent:ReadPage":
        return this.#readPage();
    }
    return undefined;
  }

  #viewport() {
    const win = this.contentWindow;
    const doc = this.document;
    return {
      width: win.innerWidth,
      height: win.innerHeight,
      url: doc.location?.href ?? "",
      title: doc.title ?? "",
      readyState: doc.readyState,
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      scrollHeight: doc.documentElement?.scrollHeight ?? 0,
    };
  }

  #click({ x, y, button, double }) {
    const win = this.contentWindow;
    const utils = this.#EventUtils;
    const target = this.document.elementFromPoint(x, y);
    const buttonNumber = { left: 0, middle: 1, right: 2 }[button] ?? 0;
    utils.synthesizeMouseAtPoint(x, y, { type: "mousemove" }, win);
    utils.synthesizeMouseAtPoint(x, y, { button: buttonNumber }, win);
    if (double) {
      utils.synthesizeMouseAtPoint(
        x,
        y,
        { button: buttonNumber, clickCount: 2 },
        win
      );
    }
    return { target: this.#describe(target) };
  }

  #type({ text, submit }) {
    const win = this.contentWindow;
    const utils = this.#EventUtils;
    const active = this.#deepActiveElement();
    if (!this.#acceptsTyping(active)) {
      throw new Error(
        `Nothing that accepts text is focused (focus is on ${this.#describe(
          active
        )}). Click the field first.`
      );
    }
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (line) {
        utils.sendString(line, win);
      }
      if (index < lines.length - 1) {
        utils.synthesizeKey("KEY_Enter", {}, win);
      }
    });
    if (submit) {
      utils.synthesizeKey("KEY_Enter", {}, win);
    }
    return { target: this.#describe(active) };
  }

  #key({ keys, repeat }) {
    const win = this.contentWindow;
    const utils = this.#EventUtils;
    const { key, modifiers } = this.#parseKeys(keys);
    const times = Math.min(Math.max(repeat | 0, 1), 20);
    for (let i = 0; i < times; i++) {
      utils.synthesizeKey(key, modifiers, win);
    }
    return { key, modifiers };
  }

  #parseKeys(keys) {
    const raw = String(keys ?? "").trim();
    if (!raw) {
      throw new Error("key needs a key name.");
    }
    const tokens = raw === "+" ? ["+"] : raw.split("+").filter(Boolean);
    const modifiers = {};
    const last = tokens.pop();
    for (const token of tokens) {
      const flag = MODIFIER_FLAGS.get(token.toLowerCase());
      if (!flag) {
        throw new Error(`Unknown modifier "${token}" in "${raw}".`);
      }
      modifiers[flag] = true;
    }
    let key;
    const lower = last.toLowerCase();
    if (KEY_NAMES.has(lower)) {
      key = KEY_NAMES.get(lower);
    } else if (last.length === 1) {
      key = last;
    } else if (/^f\d{1,2}$/i.test(last)) {
      key = `KEY_F${last.slice(1)}`;
    } else {
      key = `KEY_${last[0].toUpperCase()}${last.slice(1)}`;
    }
    return { key, modifiers };
  }

  #scroll({ direction, amount, x, y }) {
    const win = this.contentWindow;
    const doc = this.document;
    let target = doc.scrollingElement ?? doc.documentElement;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      let el = doc.elementFromPoint(x, y);
      while (el && el !== doc.documentElement && el !== doc.body) {
        if (this.#isScrollable(el, direction)) {
          target = el;
          break;
        }
        el = el.parentElement;
      }
    }
    const horizontal = direction === "left" || direction === "right";
    const sign = direction === "down" || direction === "right" ? 1 : -1;
    const size = horizontal
      ? target.clientWidth || win.innerWidth
      : target.clientHeight || win.innerHeight;
    const delta = sign * amount * size;
    target.scrollBy({
      left: horizontal ? delta : 0,
      top: horizontal ? 0 : delta,
      behavior: "instant",
    });
    return {
      target: this.#describe(target),
      scrollX: target.scrollLeft,
      scrollY: target.scrollTop,
      scrollHeight: target.scrollHeight,
      atBottom:
        target.scrollTop + target.clientHeight >= target.scrollHeight - 2,
    };
  }

  #isScrollable(el, direction) {
    const style = this.contentWindow.getComputedStyle(el);
    const horizontal = direction === "left" || direction === "right";
    const overflow = horizontal ? style.overflowX : style.overflowY;
    if (overflow !== "auto" && overflow !== "scroll") {
      return false;
    }
    return horizontal
      ? el.scrollWidth > el.clientWidth + 1
      : el.scrollHeight > el.clientHeight + 1;
  }

  #listElements() {
    const win = this.contentWindow;
    const doc = this.document;
    const candidates = doc.querySelectorAll(INTERACTIVE_SELECTOR);
    const elements = [];
    const seen = new Set();
    const maxX = win.innerWidth - 1;
    const maxY = win.innerHeight - 1;

    for (const el of candidates) {
      if (elements.length >= MAX_ELEMENTS) {
        break;
      }
      if (
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      ) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        continue;
      }
      if (
        rect.bottom < 0 ||
        rect.right < 0 ||
        rect.top > maxY ||
        rect.left > maxX
      ) {
        continue;
      }
      const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), maxX);
      const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), maxY);
      const hit = doc.elementFromPoint(cx, cy);
      if (!hit || !(el.contains(hit) || hit.contains(el))) {
        continue;
      }
      const label = this.#labelFor(el);
      const key = `${Math.round(cx)},${Math.round(cy)},${label}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const entry = {
        index: elements.length + 1,
        tag: el.localName,
        role:
          el.getAttribute("role") || (el.localName === "input" ? el.type : ""),
        label,
        x: cx,
        y: cy,
      };
      if (
        typeof el.value === "string" &&
        el.value &&
        el.localName !== "button" &&
        !NON_TEXT_INPUT_TYPES.has(el.type)
      ) {
        entry.value = el.value.slice(0, 40);
      }
      if (el.localName === "a" && el.href) {
        entry.href = el.href.slice(0, 120);
      }
      if (
        typeof el.checked === "boolean" &&
        ["checkbox", "radio"].includes(el.type)
      ) {
        entry.checked = el.checked;
      }
      if (el.disabled || el.getAttribute("aria-disabled") === "true") {
        entry.disabled = true;
      }
      elements.push(entry);
    }
    return { elements, total: candidates.length };
  }

  #readPage() {
    const doc = this.document;
    const text = (doc.body?.innerText ?? "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      text: text.slice(0, MAX_TEXT_CHARS),
      truncated: text.length > MAX_TEXT_CHARS,
      title: doc.title ?? "",
      url: doc.location?.href ?? "",
    };
  }

  #deepActiveElement() {
    let active = this.document.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  #acceptsTyping(el) {
    if (!el) {
      return false;
    }
    const win = this.contentWindow;
    if (el.isContentEditable) {
      return true;
    }
    if (win.HTMLInputElement.isInstance(el)) {
      return !NON_TEXT_INPUT_TYPES.has(el.type);
    }
    return (
      win.HTMLTextAreaElement.isInstance(el) ||
      win.HTMLSelectElement.isInstance(el) ||
      win.HTMLIFrameElement.isInstance(el)
    );
  }

  #labelFor(el) {
    const doc = this.document;
    const labelledBy = el.getAttribute("aria-labelledby");
    const candidates = [
      el.getAttribute("aria-label"),
      labelledBy
        ? labelledBy
            .split(/\s+/)
            .map(id => doc.getElementById(id)?.textContent)
            .join(" ")
        : "",
      el.labels?.length ? [...el.labels].map(l => l.textContent).join(" ") : "",
      el.innerText,
      el.localName === "input" && NON_TEXT_INPUT_TYPES.has(el.type)
        ? el.value
        : "",
      el.getAttribute("placeholder"),
      el.getAttribute("title"),
      el.querySelector?.("img[alt]")?.getAttribute("alt"),
      el.getAttribute("name"),
      el.id,
    ];
    for (const candidate of candidates) {
      const text = collapseWhitespace(candidate);
      if (text) {
        return text.slice(0, MAX_LABEL_CHARS);
      }
    }
    return "";
  }

  #describe(el) {
    if (!el) {
      return "nothing";
    }
    const label = this.#labelFor(el).slice(0, 40);
    const role = el.getAttribute?.("role");
    return `<${el.localName}${el.id ? `#${el.id}` : ""}${
      role ? ` role=${role}` : ""
    }${label ? ` "${label}"` : ""}>`;
  }
}
