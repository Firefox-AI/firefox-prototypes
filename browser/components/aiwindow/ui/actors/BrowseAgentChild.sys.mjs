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
const MAX_FIND_MATCHES = 10;
const NEARBY_RADIUS_PX = 160;
const MAX_NEARBY = 5;
const MAX_FIND_TEXT_NODES = 5000;

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

// Real controls, as opposed to focusable containers such as a cookie banner
// with tabindex="0": a click that lands outside these deserves a hint.
const CONTROL_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "label",
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
  "[onclick]",
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
      case "BrowseAgent:Find":
        return this.#find(data);
      case "BrowseAgent:SelectOption":
        return this.#selectOption(data);
      case "BrowseAgent:Hover":
        return this.#hover(data);
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
    const result = { target: this.#describe(target) };
    if (target && !target.closest(CONTROL_SELECTOR)) {
      result.nearby = this.#interactiveNear(x, y);
    }
    return result;
  }

  // Interactive elements within reach of a point, nearest first, for when a
  // click lands on a container between the controls the model was aiming at.
  #interactiveNear(x, y) {
    const doc = this.document;
    const found = [];
    for (const el of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) {
        continue;
      }
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = Math.max(rect.left - x, 0, x - rect.right);
      const dy = Math.max(rect.top - y, 0, y - rect.bottom);
      const distance = Math.hypot(dx, dy);
      if (distance > NEARBY_RADIUS_PX) {
        continue;
      }
      if (
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      ) {
        continue;
      }
      found.push({
        distance,
        tag: el.localName,
        label: this.#labelFor(el),
        x: cx,
        y: cy,
      });
    }
    found.sort((a, b) => a.distance - b.distance);
    return found
      .slice(0, MAX_NEARBY)
      .map(({ tag, label, x: cx, y: cy }) => ({ tag, label, x: cx, y: cy }));
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
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
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

  #hover({ x, y }) {
    const win = this.contentWindow;
    this.#EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousemove" }, win);
    return { target: this.#describe(this.document.elementFromPoint(x, y)) };
  }

  // Finds elements whose label or text contains `text` anywhere on the page,
  // scrolls the first match into view and reports viewport coordinates taken
  // after that scroll.
  #find({ text, limit = MAX_FIND_MATCHES }) {
    const needle = collapseWhitespace(text).toLowerCase();
    if (!needle) {
      throw new Error("find needs some text to look for.");
    }
    const win = this.contentWindow;
    const doc = this.document;
    const matches = [];
    const seen = new Set();
    const consider = (el, label) => {
      if (matches.length >= limit || !el || seen.has(el)) {
        return;
      }
      if (!label.toLowerCase().includes(needle)) {
        return;
      }
      if (
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      ) {
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        return;
      }
      seen.add(el);
      matches.push({ el, label: label.slice(0, MAX_LABEL_CHARS) });
    };

    for (const el of doc.querySelectorAll(INTERACTIVE_SELECTOR)) {
      consider(el, this.#labelFor(el));
    }
    // Plain text too: product names, prices, headings.
    const root = doc.body ?? doc.documentElement;
    const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
    let visited = 0;
    while (matches.length < limit && visited++ < MAX_FIND_TEXT_NODES) {
      const node = walker.nextNode();
      if (!node) {
        break;
      }
      if (node.data.toLowerCase().includes(needle)) {
        const el = node.parentElement;
        consider(
          el?.closest(INTERACTIVE_SELECTOR) ?? el,
          collapseWhitespace(node.data)
        );
      }
    }

    if (matches.length) {
      matches[0].el.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: "instant",
      });
    }
    const maxX = win.innerWidth - 1;
    const maxY = win.innerHeight - 1;
    return {
      matches: matches.map(({ el, label }, index) => {
        const rect = el.getBoundingClientRect();
        return {
          index: index + 1,
          tag: el.localName,
          label,
          x: Math.min(Math.max(rect.left + rect.width / 2, 0), maxX),
          y: Math.min(Math.max(rect.top + rect.height / 2, 0), maxY),
          inViewport:
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < win.innerHeight &&
            rect.left < win.innerWidth,
          href: el.localName === "a" ? el.href.slice(0, 120) : undefined,
        };
      }),
    };
  }

  #selectOption({ x, y, option }) {
    const doc = this.document;
    const win = this.contentWindow;
    const hit = doc.elementFromPoint(x, y);
    const select = hit?.closest("select");
    if (!select) {
      throw new Error(
        `There is no <select> at (${Math.round(x)}, ${Math.round(
          y
        )}); found ${this.#describe(
          hit
        )}. Custom dropdowns are opened by clicking them and then clicking the option.`
      );
    }
    const wanted = collapseWhitespace(option).toLowerCase();
    const options = [...select.options];
    const labelOf = o => collapseWhitespace(o.textContent).toLowerCase();
    const match =
      options.find(
        o => labelOf(o) === wanted || o.value.toLowerCase() === wanted
      ) ?? options.find(o => labelOf(o).includes(wanted));
    if (!match) {
      throw new Error(
        `No option matches "${option}". Options: ${options
          .map(o => collapseWhitespace(o.textContent))
          .slice(0, 40)
          .join(" | ")}`
      );
    }
    select.focus();
    select.value = match.value;
    select.dispatchEvent(
      new win.Event("input", { bubbles: true, composed: true })
    );
    select.dispatchEvent(new win.Event("change", { bubbles: true }));
    return {
      target: this.#describe(select),
      selected: collapseWhitespace(match.textContent),
      value: match.value,
    };
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
