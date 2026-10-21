/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable=''], [contenteditable=true]",
  "[role=button], [role=link], [role=checkbox], [role=radio], [role=tab]",
  "[role=menuitem], [role=option], [role=switch], [role=combobox]",
  "[role=textbox], [role=searchbox]",
].join(", ");

const MAX_ELEMENTS = 300;
const MAX_LABEL_LENGTH = 100;

/**
 * @typedef {object} SnapshotElement
 * @property {number} uid - Identifies the element in later actions.
 * @property {string} role - The ARIA role, or what the element is.
 * @property {string} label - The accessible label, or the text.
 * @property {string} [type] - The type of an input.
 * @property {string} [value] - The value of a form control.
 * @property {string} [href] - The URL of a link.
 * @property {boolean} [checked] - Whether a checkbox is checked.
 * @property {boolean} [disabled] - Whether the element is disabled.
 * @property {boolean} inViewport - Whether the element is on screen.
 */

/**
 * Lets Smart Window read and drive the pages of its browsing sessions. Only
 * instantiated on demand by AIBrowseParent.
 */
export class AIBrowseChild extends JSWindowActorChild {
  #nextUid = 1;
  #uids = new WeakMap();
  #elements = new Map();

  receiveMessage({ name, data }) {
    switch (name) {
      case "AIBrowse:Snapshot":
        return this.#snapshot();
      case "AIBrowse:Click":
        return this.#click(data.uid);
      case "AIBrowse:Type":
        return this.#type(data.uid, data.text, data.submit);
      case "AIBrowse:Scroll":
        return this.#scroll(data.direction);
    }
    throw new Error(`Unknown message: ${name}`);
  }

  #uidFor(element) {
    let uid = this.#uids.get(element);
    if (!uid) {
      uid = this.#nextUid++;
      this.#uids.set(element, uid);
    }
    this.#elements.set(uid, new WeakRef(element));
    return uid;
  }

  #elementFor(uid) {
    const element = this.#elements.get(uid)?.deref();
    if (!element?.isConnected) {
      throw new Error(
        `Element ${uid} is not on the page anymore, take a new snapshot.`
      );
    }
    return element;
  }

  #isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return false;
    }
    return element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
  }

  #labelFor(element) {
    const label =
      element.getAttribute("aria-label") ||
      element.labels?.[0]?.textContent ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      element.getAttribute("alt") ||
      element.querySelector("img[alt]")?.getAttribute("alt") ||
      element.innerText ||
      element.getAttribute("name") ||
      "";
    return label.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
  }

  #roleFor(element) {
    const role = element.getAttribute("role");
    if (role) {
      return role;
    }
    switch (element.localName) {
      case "a":
        return "link";
      case "input":
        return ["checkbox", "radio", "button", "submit", "reset"].includes(
          element.type
        )
          ? element.type
          : "textbox";
      case "select":
        return "combobox";
      case "textarea":
        return "textbox";
      default:
        return element.isContentEditable ? "textbox" : element.localName;
    }
  }

  #snapshot() {
    const { document } = this;
    const win = this.contentWindow;
    const elements = [];
    this.#elements.clear();

    for (const element of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (elements.length >= MAX_ELEMENTS) {
        break;
      }
      if (!this.#isVisible(element)) {
        continue;
      }

      const rect = element.getBoundingClientRect();
      /** @type {SnapshotElement} */
      const entry = {
        uid: this.#uidFor(element),
        role: this.#roleFor(element),
        label: this.#labelFor(element),
        inViewport:
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < win.innerHeight &&
          rect.left < win.innerWidth,
      };
      if (element.localName === "input") {
        entry.type = element.type;
      }
      if (
        "value" in element &&
        element.type !== "password" &&
        element.localName !== "button"
      ) {
        entry.value = String(element.value).slice(0, MAX_LABEL_LENGTH);
      }
      if (element.localName === "a") {
        entry.href = element.href;
      }
      if (element.type === "checkbox" || element.type === "radio") {
        entry.checked = element.checked;
      }
      if (element.disabled) {
        entry.disabled = true;
      }
      elements.push(entry);
    }

    return {
      url: document.documentURI,
      title: document.title,
      scrollY: Math.round(win.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: win.innerHeight,
      elements,
    };
  }

  #centerOf(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  #click(uid) {
    const element = this.#elementFor(uid);
    const { x, y } = this.#centerOf(element);

    const target = this.document.elementFromPoint(x, y);
    if (target && target !== element && !element.contains(target)) {
      const by = target.localName + (target.id ? `#${target.id}` : "");
      throw new Error(
        `Element ${uid} is covered by ${by}, which would get the click.`
      );
    }

    const win = this.contentWindow;
    win.synthesizeMouseEvent("mousemove", x, y, { button: 0, clickCount: 0 });
    win.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
    win.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: 1 });
    return true;
  }

  #type(uid, text, submit) {
    const element = this.#elementFor(uid);
    this.#centerOf(element);
    element.focus();

    if (element.localName === "select") {
      const option = [...element.options].find(
        o => o.label.trim() === text || o.value === text
      );
      if (!option) {
        throw new Error(`Element ${uid} has no option "${text}".`);
      }
      element.value = option.value;
      element.dispatchEvent(
        new this.contentWindow.Event("input", { bubbles: true })
      );
      element.dispatchEvent(
        new this.contentWindow.Event("change", { bubbles: true })
      );
    } else if (
      element.localName === "input" ||
      element.localName === "textarea"
    ) {
      element.setUserInput(text);
    } else if (element.isContentEditable) {
      this.document.execCommand("selectAll");
      this.document.execCommand("insertText", false, text);
    } else {
      throw new Error(`Element ${uid} does not accept text.`);
    }

    if (submit) {
      this.#pressEnter();
    }
    return true;
  }

  #pressEnter() {
    const win = this.contentWindow;
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(
      Ci.nsITextInputProcessor
    );
    if (!tip.beginInputTransaction(win, () => true)) {
      throw new Error("The page is busy with another input.");
    }
    const event = new win.KeyboardEvent("", {
      key: "Enter",
      code: "Enter",
      keyCode: win.KeyboardEvent.DOM_VK_RETURN,
    });
    tip.keydown(event);
    tip.keyup(event);
  }

  #scroll(direction) {
    const win = this.contentWindow;
    const delta = Math.round(win.innerHeight * 0.8);
    win.scrollBy(0, direction === "up" ? -delta : delta);
    return true;
  }
}
