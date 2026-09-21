/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const MAX_ELEMENTS = 100;
const MAX_PAGE_TEXT = 12000;
const MAX_ELEMENT_TEXT = 300;
const MAX_FIND_TEXT = 500;
const MAX_SCROLL_AMOUNT = 5000;
const SCROLL_DIRECTIONS = new Set([
  "up",
  "down",
  "left",
  "right",
  "top",
  "bottom",
]);

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='tab']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function cleanText(value, limit = MAX_ELEMENT_TEXT) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function isVisible(element) {
  const style = element.documentGlobal.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function getRole(element) {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) {
    return explicitRole;
  }

  switch (element.localName) {
    case "a":
      return "link";
    case "button":
      return "button";
    case "textarea":
      return "textbox";
    case "select":
      return "combobox";
    case "input": {
      const type = element.type?.toLowerCase();
      if (type === "checkbox") {
        return "checkbox";
      }
      if (type === "radio") {
        return "radio";
      }
      if (["button", "submit", "reset"].includes(type)) {
        return "button";
      }
      return "textbox";
    }
    default:
      return element.isContentEditable ? "textbox" : "generic";
  }
}

function getName(element) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map(id => element.ownerDocument.getElementById(id)?.textContent)
      .filter(Boolean)
      .join(" ");
    if (label) {
      return cleanText(label);
    }
  }

  const labels = element.labels
    ? Array.from(element.labels, label => label.textContent).join(" ")
    : "";
  return cleanText(
    element.getAttribute("aria-label") ||
      labels ||
      element.getAttribute("alt") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      element.textContent ||
      element.getAttribute("name") ||
      element.localName
  );
}

function canType(element) {
  if (element.disabled || element.readOnly) {
    return false;
  }
  if (element.localName === "textarea" || element.isContentEditable) {
    return true;
  }
  if (element.localName !== "input") {
    return false;
  }
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "password",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(element.type?.toLowerCase());
}

/**
 * Child endpoint for Smart Window browser control.
 *
 * A state query creates opaque element references. References are valid only
 * for the newest snapshot in this document and are invalidated after every
 * action. This deliberately provides no arbitrary selector or JavaScript API.
 */
export class SmartWindowBrowserChild extends JSWindowActorChild {
  #elements = new Map();
  #latestSnapshotId = null;
  #snapshotCounter = 0;

  receiveMessage({ name, data }) {
    switch (name) {
      case "SmartWindowBrowser:GetState":
        return this.#getState();
      case "SmartWindowBrowser:FindText":
        return this.#findText(data);
      case "SmartWindowBrowser:Scroll":
        return this.#scroll(data);
      case "SmartWindowBrowser:Click":
        return this.#click(data);
      case "SmartWindowBrowser:Type":
        return this.#type(data);
      default:
        return this.#error("unknown_operation", `Unknown operation: ${name}`);
    }
  }

  #error(code, message) {
    return { status: "error", code, message };
  }

  #invalidateSnapshot() {
    this.#latestSnapshotId = null;
    this.#elements.clear();
  }

  #getScrollState() {
    const { document, contentWindow } = this;
    const scroller = document.scrollingElement;
    return {
      scroll_x: Math.round(contentWindow.scrollX),
      scroll_y: Math.round(contentWindow.scrollY),
      max_scroll_x: Math.max(
        0,
        Math.round((scroller?.scrollWidth ?? 0) - contentWindow.innerWidth)
      ),
      max_scroll_y: Math.max(
        0,
        Math.round((scroller?.scrollHeight ?? 0) - contentWindow.innerHeight)
      ),
      viewport_width: contentWindow.innerWidth,
      viewport_height: contentWindow.innerHeight,
    };
  }

  #nextFrame() {
    return new Promise(resolve => this.contentWindow.requestAnimationFrame(resolve));
  }

  #getState() {
    const { document, contentWindow } = this;
    const snapshotId = `${this.manager.innerWindowId}:${++this.#snapshotCounter}`;
    this.#elements.clear();
    this.#latestSnapshotId = snapshotId;

    const elements = [];
    for (const element of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (elements.length >= MAX_ELEMENTS || !isVisible(element)) {
        continue;
      }

      const ref = `e${elements.length + 1}`;
      const rect = element.getBoundingClientRect();
      const type = element.getAttribute("type")?.toLowerCase() || undefined;
      const typeable = canType(element);
      const item = {
        ref,
        role: getRole(element),
        name: getName(element),
        actions: typeable ? ["click", "type"] : ["click"],
        disabled: Boolean(element.disabled),
        readonly: Boolean(element.readOnly),
        inViewport:
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= contentWindow.innerHeight &&
          rect.left <= contentWindow.innerWidth,
      };

      if (type) {
        item.type = type;
      }
      if (
        type !== "password" &&
        (element.localName === "input" || element.localName === "textarea")
      ) {
        item.value = cleanText(element.value);
      }
      if (element.localName === "a") {
        const href = element.href;
        if (href?.startsWith("http://") || href?.startsWith("https://")) {
          item.href = href;
        }
      }

      this.#elements.set(ref, element);
      elements.push(item);
    }

    return {
      status: "ok",
      snapshot_id: snapshotId,
      url: document.URL,
      title: cleanText(document.title),
      ready_state: document.readyState,
      text: cleanText(document.body?.innerText, MAX_PAGE_TEXT),
      elements,
      truncated: elements.length === MAX_ELEMENTS,
    };
  }

  #resolveElement({ snapshot_id: snapshotId, ref }) {
    if (!snapshotId || snapshotId !== this.#latestSnapshotId) {
      return this.#error(
        "stale_snapshot",
        "The page state changed or this snapshot was already used. Read browser_state again."
      );
    }

    const element = this.#elements.get(ref);
    if (!element?.isConnected) {
      return this.#error(
        "unknown_ref",
        "The element reference is no longer available. Read browser_state again."
      );
    }
    if (!isVisible(element)) {
      return this.#error(
        "element_not_visible",
        "The element is not visible. Read browser_state again."
      );
    }
    return element;
  }

  async #findText({
    text,
    case_sensitive: caseSensitive = false,
    whole_word: wholeWord = false,
  }) {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > MAX_FIND_TEXT
    ) {
      return this.#error(
        "invalid_text",
        `Text must contain between 1 and ${MAX_FIND_TEXT} characters.`
      );
    }

    const selection = this.contentWindow.getSelection();
    selection.removeAllRanges();
    const found = this.contentWindow.find(
      text,
      Boolean(caseSensitive),
      false,
      true,
      Boolean(wholeWord),
      false,
      false
    );
    await this.#nextFrame();
    this.#invalidateSnapshot();
    return {
      status: "ok",
      action: "find_text",
      found,
      highlighted: found && !selection.isCollapsed,
      ...this.#getScrollState(),
    };
  }

  async #scroll({ direction, amount }) {
    if (!SCROLL_DIRECTIONS.has(direction)) {
      return this.#error(
        "invalid_direction",
        "Direction must be up, down, left, right, top, or bottom."
      );
    }
    if (
      amount !== undefined &&
      (!Number.isFinite(amount) || amount < 1 || amount > MAX_SCROLL_AMOUNT)
    ) {
      return this.#error(
        "invalid_amount",
        `Amount must be between 1 and ${MAX_SCROLL_AMOUNT} CSS pixels.`
      );
    }

    const before = this.#getScrollState();
    const horizontal = direction === "left" || direction === "right";
    const distance =
      amount ??
      (horizontal ? before.viewport_width : before.viewport_height) * 0.8;
    let left = before.scroll_x;
    let top = before.scroll_y;

    switch (direction) {
      case "up":
        top -= distance;
        break;
      case "down":
        top += distance;
        break;
      case "left":
        left -= distance;
        break;
      case "right":
        left += distance;
        break;
      case "top":
        top = 0;
        break;
      case "bottom":
        top = before.max_scroll_y;
        break;
    }

    this.contentWindow.scrollTo({ left, top, behavior: "instant" });
    await this.#nextFrame();
    this.#invalidateSnapshot();
    const after = this.#getScrollState();
    return {
      status: "ok",
      action: "scroll",
      direction,
      did_scroll:
        before.scroll_x !== after.scroll_x || before.scroll_y !== after.scroll_y,
      ...after,
    };
  }

  #click(data) {
    const element = this.#resolveElement(data);
    if (!this.contentWindow.Element.isInstance(element)) {
      return element;
    }
    if (element.disabled) {
      return this.#error("element_disabled", "The element is disabled.");
    }

    element.focus();
    element.click();
    this.#invalidateSnapshot();
    return {
      status: "ok",
      action: "click",
      input_route: "dom_event",
      trusted: false,
    };
  }

  #type({ snapshot_id: snapshotId, ref, text, replace = true }) {
    const element = this.#resolveElement({ snapshot_id: snapshotId, ref });
    if (!this.contentWindow.Element.isInstance(element)) {
      return element;
    }
    if (!canType(element)) {
      return this.#error(
        "element_not_editable",
        "The element does not accept text input."
      );
    }
    if (typeof text !== "string") {
      return this.#error("invalid_text", "Text must be a string.");
    }

    element.focus();
    if (element.localName === "input" || element.localName === "textarea") {
      const value = replace ? text : `${element.value}${text}`;
      element.setUserInput(value);
    } else {
      const selection = this.contentWindow.getSelection();
      if (replace) {
        selection.selectAllChildren(element);
      } else {
        selection.collapse(element, element.childNodes.length);
      }
      element.ownerDocument.execCommand("insertText", false, text);
    }

    this.#invalidateSnapshot();
    return {
      status: "ok",
      action: "type",
      characters: text.length,
      input_route: "dom_event",
      trusted: false,
    };
  }
}
