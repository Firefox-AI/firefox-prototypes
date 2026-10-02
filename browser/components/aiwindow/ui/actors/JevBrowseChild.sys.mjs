/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Content-side half of the Jev browse loop. Ports jev-ultrafast's snapshot.js
 * element table and browser.py's act/fresh checks to a JSWindowActorChild.
 *
 * The parent only ever sends element ids that came from this actor's own
 * Observe reply; the ids are resolved back to nodes through the per-document
 * Map below. Model output never becomes a selector, coordinate, URL or script.
 */

const ROLES = [
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemradio",
  "option",
  "gridcell",
  "combobox",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "select",
];

const SELECTOR =
  'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
  ROLES.map(role => `[role="${role}"]`).join(",");

const AD_CONTAINER_SELECTOR =
  '.result--ad,.badge--ad,[class*="sponsored" i]';

const NEVER_SEND_TYPES = new Set(["password", "email", "tel"]);
const NEVER_SEND_AUTOCOMPLETE = new Set([
  "name",
  "street-address",
  "postal-code",
]);
const EXCLUDED_TYPES = new Set(["password", "file", "hidden"]);
const CONSENT_TEXT_RE = /cookies?|consent|privacy choices|personali[sz]ed ads|accept all|only necessary/i;
const ROW_PRICE_RE = /[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*\s?(?:USD|EUR|GBP|TWD|NT\$)/;

const MAX_CANDIDATES = 250;
const TEXT_LIMIT = 6000;
const PAGE_TEXT_LIMIT = 8000;
const SCROLL_DELTA = 560;
const ACTION_KINDS = new Set([
  "CLICK",
  "TYPE_TEXT",
  "SELECT",
  "SCROLL_UP",
  "SCROLL_DOWN",
  "WAIT",
]);

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export class JevBrowseChild extends JSWindowActorChild {
  /** @type {WeakMap<Element, number>} */
  #ids = new WeakMap();
  /** @type {Map<number, Element>} */
  #nodes = new Map();
  #next = 1;
  #doc = null;
  #snapshotSeq = 0;
  /**
   * The most recent observation this actor handed out.
   *
   * @type {{snapshot_id: number, pageKey: string, marker: string, guards: Map<number, string>, options: Map<string, number>, comboboxIds: Set<number>} | null}
   */
  #current = null;

  async receiveMessage({ name, data }) {
    switch (name) {
      case "JevBrowse:Observe":
        return this.#observe();
      case "JevBrowse:Act":
        return this.#act(data);
      case "JevBrowse:Fresh":
        return { fresh: this.#fresh(data?.snapshot_id) };
      case "JevBrowse:Extract":
        return this.#extract();
    }
    return null;
  }

  didDestroy() {
    this.#nodes.clear();
    this.#current = null;
    this.#doc = null;
  }

  // ---------------------------------------------------------------------
  // Identity cache
  // ---------------------------------------------------------------------

  #resetIfNewDocument() {
    const doc = this.document;
    if (this.#doc !== doc) {
      this.#doc = doc;
      this.#ids = new WeakMap();
      this.#nodes = new Map();
      this.#next = 1;
      this.#current = null;
    }
    for (const [id, el] of this.#nodes) {
      if (!el.isConnected) {
        this.#nodes.delete(id);
      }
    }
  }

  #identity(el) {
    if (!this.#ids.has(el)) {
      this.#ids.set(el, this.#next++);
    }
    const id = this.#ids.get(el);
    this.#nodes.set(id, el);
    return id;
  }

  // ---------------------------------------------------------------------
  // Element table (port of snapshot.js)
  // ---------------------------------------------------------------------

  /** password | payment | otp | null: fields that never enter the element table. */
  static #sensitiveKind(el) {
    if (el.tagName !== "INPUT") {
      return null;
    }
    if (el.type === "password") {
      return "password";
    }
    const ac = (el.getAttribute("autocomplete") || "").trim().toLowerCase();
    if (ac.startsWith("cc-")) {
      return "payment";
    }
    if (ac === "one-time-code") {
      return "otp";
    }
    return null;
  }

  static #safe(el) {
    return !EXCLUDED_TYPES.has(el.type) && !JevBrowseChild.#sensitiveKind(el);
  }

  #sensitiveFields() {
    const counts = { password: 0, payment: 0, otp: 0 };
    for (const el of this.document.querySelectorAll("input")) {
      const kind = JevBrowseChild.#sensitiveKind(el);
      if (kind) {
        counts[kind]++;
      }
    }
    return counts;
  }

  static #visible(el) {
    if (el.closest('[aria-hidden="true"],[inert]')) {
      return false;
    }
    try {
      return el.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      });
    } catch {
      return false;
    }
  }

  static #isAd(el) {
    if (el.closest(AD_CONTAINER_SELECTOR)) {
      return true;
    }
    const anchor = el.closest("a[href]");
    if (anchor) {
      try {
        const url = new URL(anchor.href, el.ownerDocument.baseURI);
        if (
          url.host.endsWith("duckduckgo.com") &&
          url.pathname === "/y.js"
        ) {
          return true;
        }
      } catch {
        // not a URL; fall through
      }
    }
    return false;
  }

  static #name(el, seen = new Set()) {
    if (!el || seen.has(el)) {
      return "";
    }
    seen.add(el);
    const doc = el.ownerDocument;
    const referenced = (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map(id => JevBrowseChild.#name(doc.getElementById(id), seen))
      .filter(Boolean)
      .join(" ");
    if (referenced) {
      return referenced;
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) {
      return ariaLabel;
    }
    const labels = [...(el.labels || [])]
      .map(l => JevBrowseChild.#name(l, seen))
      .filter(Boolean)
      .join(" ");
    if (labels) {
      return labels;
    }
    if (["button", "submit", "reset"].includes(el.type) && el.value) {
      return el.value;
    }
    const alt = el.getAttribute("alt");
    if (alt) {
      return alt;
    }
    if (el.tagName !== "INPUT") {
      const text = [...el.childNodes]
        .map(n => {
          if (n.nodeType === 3) {
            return n.textContent;
          }
          if (n.nodeType === 1 && n.getAttribute("aria-hidden") !== "true") {
            return JevBrowseChild.#name(n, seen);
          }
          return "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        return text;
      }
    }
    return el.getAttribute("title") || el.getAttribute("placeholder") || "";
  }

  static #role(el) {
    const explicit = el.getAttribute("role");
    if (ROLES.includes(explicit)) {
      return explicit;
    }
    const tag = el.tagName;
    if (tag === "BUTTON" || tag === "SUMMARY") {
      return "button";
    }
    if (tag === "A") {
      return "link";
    }
    if (tag === "SELECT") {
      return "select";
    }
    if (tag === "TEXTAREA" || el.isContentEditable) {
      return "textbox";
    }
    if (tag === "INPUT") {
      if (["checkbox", "radio"].includes(el.type)) {
        return el.type;
      }
      if (["button", "submit", "reset", "image"].includes(el.type)) {
        return "button";
      }
      if (el.type === "search") {
        return "searchbox";
      }
      if (el.type === "number") {
        return "spinbutton";
      }
      if (el.type === "range") {
        return "slider";
      }
      if (["text", "email", "url", "tel", "date", "time"].includes(el.type)) {
        return "textbox";
      }
    }
    return null;
  }

  static #sendableValue(el) {
    if (NEVER_SEND_TYPES.has(el.type)) {
      return "";
    }
    const autocomplete = (el.getAttribute("autocomplete") || "")
      .trim()
      .toLowerCase();
    if (
      autocomplete.startsWith("cc-") ||
      NEVER_SEND_AUTOCOMPLETE.has(autocomplete)
    ) {
      return "";
    }
    if ("value" in el && el.tagName !== "SELECT") {
      return String(el.value ?? "");
    }
    if (el.isContentEditable || el.getAttribute("role") === "combobox") {
      return (el.innerText || "").trim();
    }
    return "";
  }

  /**
   * Walks the composed tree (open shadow roots, same-origin frames) and
   * collects element candidates. Returns candidates in document order.
   */
  #collectCandidates() {
    const win = this.contentWindow;
    const top = { w: win.innerWidth, h: win.innerHeight };
    const candidates = [];
    const comboboxIds = new Set();
    let omitted = 0;

    const walk = (root, offset) => {
      const doc = root.ownerDocument || root;
      const walker = doc.createTreeWalker(root, 1 /* SHOW_ELEMENT */);
      let el = root.nodeType === 1 ? root : walker.nextNode();
      while (el) {
        if (el.matches?.(SELECTOR)) {
          this.#consider(el, offset, top, candidates, comboboxIds, () =>
            omitted++
          );
        }
        if (el.shadowRoot) {
          walk(el.shadowRoot, offset);
        }
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          let frameDoc = null;
          try {
            frameDoc = el.contentDocument;
          } catch {
            frameDoc = null;
          }
          if (frameDoc?.body && JevBrowseChild.#visible(el)) {
            const r = el.getBoundingClientRect();
            walk(frameDoc.body, { x: offset.x + r.x, y: offset.y + r.y });
          }
        }
        el = walker.nextNode();
      }
    };

    if (this.document.body) {
      walk(this.document.body, { x: 0, y: 0 });
    }
    return { candidates, comboboxIds, omitted };
  }

  #consider(el, offset, top, candidates, comboboxIds, noteOmitted) {
    if (
      !JevBrowseChild.#safe(el) ||
      !JevBrowseChild.#visible(el) ||
      el.matches(":disabled") ||
      el.closest('[aria-disabled="true"]') ||
      JevBrowseChild.#isAd(el)
    ) {
      return;
    }
    const rname = JevBrowseChild.#role(el);
    if (!rname) {
      return;
    }
    if (rname === "gridcell" && el.querySelector('button,[role="button"]')) {
      return;
    }
    const r = el.getBoundingClientRect();
    const x = offset.x + r.x + r.width / 2;
    const y = offset.y + r.y + r.height / 2;
    if (
      r.width <= 0 ||
      r.height <= 0 ||
      x < 0 ||
      y < 0 ||
      x >= top.w ||
      y >= top.h
    ) {
      return;
    }
    if (candidates.length >= MAX_CANDIDATES) {
      noteOmitted();
      return;
    }
    const id = this.#identity(el);
    const element = {
      id: String(id),
      role: rname,
      label: JevBrowseChild.#name(el) || rname,
      value: "",
      operations: [],
    };
    for (const key of ["checked", "selected", "expanded"]) {
      const value = el.getAttribute(`aria-${key}`);
      if (value !== null) {
        element[key] = value;
      }
    }
    if (["checkbox", "radio"].includes(el.type)) {
      element.checked = String(el.checked);
    }

    if (el.tagName === "SELECT") {
      element.value = [...el.selectedOptions].map(o => o.label).join(", ");
      element.options = [];
      let n = 0;
      for (const o of el.options) {
        if (o.selected || o.disabled || o.closest("optgroup[disabled]")) {
          continue;
        }
        n++;
        element.options.push({
          id: `${id}:${n}`,
          label: o.label,
          value: o.value,
          option_index: o.index,
        });
      }
      if (element.options.length) {
        element.operations.push("SELECT");
      } else {
        element.operations.push("CLICK");
      }
    } else {
      const editable =
        !el.readOnly &&
        el.getAttribute("aria-readonly") !== "true" &&
        !["checkbox", "radio"].includes(rname) &&
        (["textbox", "searchbox", "spinbutton"].includes(rname) ||
          (rname === "combobox" && ["INPUT", "TEXTAREA"].includes(el.tagName)));
      element.value = JevBrowseChild.#sendableValue(el);
      if (editable) {
        element.operations.push("TYPE_TEXT", "CLICK");
        if (rname === "combobox" || el.getAttribute("role") === "combobox") {
          comboboxIds.add(id);
        }
      } else {
        element.operations.push("CLICK");
      }
    }
    candidates.push({ element, node: el });
  }

  #visibleText() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc.body) {
      return "";
    }
    const words = [];
    const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
    const range = doc.createRange();
    let node;
    let length = 0;
    while ((node = walker.nextNode()) && length < TEXT_LIMIT) {
      const value = node.textContent.trim();
      const parent = node.parentElement;
      if (
        !value ||
        !parent ||
        parent.closest("script,style,noscript,template") ||
        !JevBrowseChild.#visible(parent)
      ) {
        continue;
      }
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < win.innerHeight &&
        r.right > 0 &&
        r.left < win.innerWidth
      ) {
        words.push(value);
        length += value.length;
      }
    }
    return words.join("\n").slice(0, TEXT_LIMIT);
  }

  #formValues() {
    const doc = this.document;
    return [...doc.querySelectorAll("input,textarea,select")]
      .filter(e => JevBrowseChild.#safe(e))
      .map(e => [
        this.#identity(e),
        JevBrowseChild.#sendableValue(e),
        e.checked ?? null,
        e.selectedIndex ?? null,
        e.disabled,
        e.readOnly ?? null,
      ]);
  }

  #pageKey() {
    const win = this.contentWindow;
    // Viewport size is deliberately not part of the key: the Smart Window
    // sidebar opening resizes the content area mid-run, and geometry is
    // re-resolved and hit-tested immediately before every input anyway.
    return JSON.stringify([
      win.location.href,
      win.scrollX,
      win.scrollY,
      this.#formValues(),
    ]);
  }

  #guard(el) {
    if (!el?.isConnected || !JevBrowseChild.#visible(el)) {
      return null;
    }
    const scope =
      el.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') ||
      el.parentElement;
    return JSON.stringify([
      this.#identity(el),
      JevBrowseChild.#role(el),
      JevBrowseChild.#name(el),
      el.tagName === "SELECT" ? el.selectedIndex : JevBrowseChild.#sendableValue(el),
      el.checked ?? null,
      el.readOnly ?? null,
      el.matches(":disabled"),
      el.getAttribute("aria-disabled"),
      el.getAttribute("aria-expanded"),
      el.getAttribute("aria-checked"),
      el.getAttribute("aria-selected"),
      el.getAttribute("href"),
      scope?.innerText?.slice(0, 6000) || "",
    ]);
  }

  #marker(text, elements) {
    const win = this.contentWindow;
    return JSON.stringify([
      win.location.href,
      win.scrollX,
      win.scrollY,
      this.document.title,
      text,
      elements,
      this.#formValues(),
    ]);
  }

  // ---------------------------------------------------------------------
  // Probe (D11)
  // ---------------------------------------------------------------------

  static #findRecipe(value, depth = 0) {
    if (!value || depth > 6) {
      return null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = JevBrowseChild.#findRecipe(item, depth + 1);
        if (found) {
          return found;
        }
      }
      return null;
    }
    if (typeof value !== "object") {
      return null;
    }
    const type = value["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (
      types.some(t => typeof t === "string" && /recipe$/i.test(t)) &&
      Array.isArray(value.recipeIngredient) &&
      value.recipeIngredient.length
    ) {
      return {
        name: typeof value.name === "string" ? value.name : null,
        recipeYield: value.recipeYield ?? null,
        recipeIngredient: value.recipeIngredient
          .filter(x => typeof x === "string")
          .slice(0, 60),
      };
    }
    if (value["@graph"]) {
      return JevBrowseChild.#findRecipe(value["@graph"], depth + 1);
    }
    return null;
  }

  #jsonLdRecipe() {
    const scripts = this.document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const script of scripts) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      const recipe = JevBrowseChild.#findRecipe(parsed);
      if (recipe) {
        return recipe;
      }
    }
    return null;
  }

  #ingredientsHeading() {
    const doc = this.document;
    const headings = doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]');
    const hasList = el =>
      el &&
      ((["UL", "OL"].includes(el.tagName) && el.querySelectorAll("li").length >= 3) ||
        [...el.querySelectorAll("ul,ol")].some(
          l => l.querySelectorAll("li").length >= 3
        ));
    for (const h of headings) {
      if (!/ingredients/i.test(h.textContent || "")) {
        continue;
      }
      let sibling = h.nextElementSibling;
      for (let i = 0; i < 4 && sibling; i++) {
        if (hasList(sibling)) {
          return true;
        }
        sibling = sibling.nextElementSibling;
      }
      let parentSibling = h.parentElement?.nextElementSibling;
      for (let i = 0; i < 2 && parentSibling; i++) {
        if (hasList(parentSibling)) {
          return true;
        }
        parentSibling = parentSibling.nextElementSibling;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------

  #observe() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc?.body || !win) {
      return { error: "no_body" };
    }
    this.#resetIfNewDocument();

    const { candidates, comboboxIds, omitted } = this.#collectCandidates();
    const elements = candidates.map(c => c.element);
    const text = this.#visibleText();
    const height = doc.documentElement.scrollHeight;
    const scroll = { y: win.scrollY, height };
    const controls = {};
    if (win.scrollY + win.innerHeight < height - 2) {
      controls.scroll_down = true;
    }
    if (win.scrollY > 0) {
      controls.scroll_up = true;
    }

    const guards = new Map();
    const options = new Map();
    for (const { element, node } of candidates) {
      guards.set(Number(element.id), this.#guard(node));
      for (const o of element.options || []) {
        options.set(o.id, o.option_index);
      }
    }

    const semantics = elements.map(e => ({
      id: e.id,
      role: e.role,
      label: e.label,
      value: e.value,
      operations: e.operations,
      options: e.options?.map(o => o.label),
    }));
    const fingerprint = fnv1a(
      JSON.stringify([win.location.href, text, semantics, scroll])
    );

    const snapshot_id = ++this.#snapshotSeq;
    this.#current = {
      snapshot_id,
      pageKey: this.#pageKey(),
      marker: this.#marker(text, semantics),
      guards,
      options,
      comboboxIds,
    };

    // option_index stays on the reply for the parent's Act payload; the
    // parent strips it from the Jev request body.
    const outElements = elements.map(e => ({ ...e }));

    return {
      snapshot_id,
      url: win.location.href,
      title: doc.title,
      text,
      elements: outElements,
      controls,
      scroll,
      fingerprint,
      omitted_candidates: omitted,
      sensitive_fields: this.#sensitiveFields(),
      has_main: Boolean(doc.querySelector('main,[role="main"]')),
      consent_dialog: this.#consentDialogPresent(),
      probe: {
        ingredients_heading: this.#ingredientsHeading(),
        json_ld_recipe: this.#jsonLdRecipe(),
      },
    };
  }

  /** A visible dialog-like region whose text reads like a cookie/consent prompt. */
  #consentDialogPresent() {
    const doc = this.document;
    const sel =
      'dialog[open],[role="dialog"],[aria-modal="true"],[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i]';
    for (const el of doc.querySelectorAll(sel)) {
      if (!JevBrowseChild.#visible(el) || !el.querySelector('button,[role="button"]')) {
        continue;
      }
      if (CONSENT_TEXT_RE.test((el.innerText || "").slice(0, 1500))) {
        return true;
      }
    }
    return false;
  }

  #fresh(snapshot_id) {
    const current = this.#current;
    if (!current || current.snapshot_id !== snapshot_id) {
      return false;
    }
    if (!this.document?.body || this.#doc !== this.document) {
      return false;
    }
    try {
      const { candidates } = this.#collectCandidates();
      const semantics = candidates.map(({ element: e }) => ({
        id: e.id,
        role: e.role,
        label: e.label,
        value: e.value,
        operations: e.operations,
        options: e.options?.map(o => o.label),
      }));
      return this.#marker(this.#visibleText(), semantics) === current.marker;
    } catch {
      return false;
    }
  }

  static #validateAction(action) {
    if (!action || typeof action !== "object") {
      return false;
    }
    const keys = Object.keys(action).sort();
    const allowed = new Set(["id", "kind"]);
    if (action.kind === "TYPE_TEXT") {
      allowed.add("text");
      allowed.add("suggest");
    }
    if (action.kind === "SELECT") {
      allowed.add("optionIndex");
    }
    if (!keys.every(k => allowed.has(k))) {
      return false;
    }
    if (!ACTION_KINDS.has(action.kind)) {
      return false;
    }
    if (typeof action.id !== "string" || !/^\d+$/.test(action.id)) {
      return false;
    }
    if (action.kind === "TYPE_TEXT" && typeof action.text !== "string") {
      return false;
    }
    if ("suggest" in action && typeof action.suggest !== "boolean") {
      return false;
    }
    if (
      action.kind === "SELECT" &&
      !(Number.isInteger(action.optionIndex) && action.optionIndex >= 0)
    ) {
      return false;
    }
    if (["SCROLL_UP", "SCROLL_DOWN", "WAIT"].includes(action.kind)) {
      return action.id === "0";
    }
    return action.id !== "0";
  }

  async #act(data) {
    const action = data?.action;
    if (!JevBrowseChild.#validateAction(action)) {
      return { ok: false, error: "bad_action" };
    }
    const current = this.#current;
    if (!current || current.snapshot_id !== data.snapshot_id) {
      return { ok: false, stale: true, why: "snapshot_not_current" };
    }
    const win = this.contentWindow;
    const doc = this.document;
    if (!doc?.body || this.#doc !== doc) {
      return { ok: false, stale: true, why: "document_changed" };
    }
    if (this.#pageKey() !== current.pageKey) {
      return { ok: false, stale: true, why: "page_key_changed" };
    }

    const kind = action.kind;
    if (kind === "WAIT") {
      await new Promise(resolve => win.setTimeout(resolve, 100));
      return { ok: true };
    }
    if (kind === "SCROLL_DOWN" || kind === "SCROLL_UP") {
      win.scrollBy(0, kind === "SCROLL_DOWN" ? SCROLL_DELTA : -SCROLL_DELTA);
      await this.#settle(false);
      return { ok: true };
    }

    const id = Number(action.id);
    const node = this.#nodes.get(id);
    if (!node?.isConnected) {
      return { ok: false, stale: true, why: "node_gone" };
    }
    if (
      node.matches(":disabled") ||
      node.closest('[aria-disabled="true"],[inert]') ||
      !JevBrowseChild.#visible(node)
    ) {
      return { ok: false, stale: true, why: "node_not_interactable" };
    }
    if (this.#guard(node) !== current.guards.get(id)) {
      return { ok: false, stale: true, why: "node_changed" };
    }
    const nodeWin = node.ownerDocument.defaultView;
    const r = node.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    if (
      !r.width ||
      !r.height ||
      x < 0 ||
      y < 0 ||
      x >= nodeWin.innerWidth ||
      y >= nodeWin.innerHeight
    ) {
      return { ok: false, stale: true, why: "node_offscreen" };
    }
    const root = node.getRootNode();
    const hit = root.elementFromPoint?.(x, y);
    if (!JevBrowseChild.#composedContains(node, hit)) {
      return { ok: false, stale: true, why: "node_occluded" };
    }

    if (kind === "SELECT") {
      if (node.tagName !== "SELECT") {
        return { ok: false, error: "not_a_select" };
      }
      const option = node.options[action.optionIndex];
      if (
        !option ||
        option.disabled ||
        option.closest("optgroup[disabled]") ||
        ![...current.options.values()].includes(action.optionIndex)
      ) {
        return { ok: false, stale: true, why: "option_not_offered" };
      }
      node.selectedIndex = action.optionIndex;
      node.dispatchEvent(new nodeWin.Event("input", { bubbles: true }));
      node.dispatchEvent(new nodeWin.Event("change", { bubbles: true }));
      await this.#settle(false);
      return { ok: true };
    }

    if (kind === "TYPE_TEXT") {
      if (node.readOnly || node.getAttribute("aria-readonly") === "true") {
        return { ok: false, stale: true, why: "field_readonly" };
      }
      JevBrowseChild.#click(nodeWin, node, x, y);
      node.focus();
      if (typeof node.setUserInput === "function") {
        node.setUserInput(action.text);
      } else if (node.isContentEditable) {
        const selection = nodeWin.getSelection();
        selection.selectAllChildren(node);
        nodeWin.windowUtils.sendContentCommandEvent(
          "insertText",
          null,
          action.text
        );
        node.dispatchEvent(new nodeWin.Event("input", { bubbles: true }));
      } else {
        return { ok: false, error: "not_editable" };
      }
      const isCombobox = current.comboboxIds.has(id);
      await this.#settle(isCombobox);
      // Sites like Google Flights open an overlay dialog on focus whose own
      // input takes focus; the text we wrote into the page-level node never
      // reaches it. If focus moved to a different editable field and the
      // original either vanished or did not keep our text, retype there.
      let retargeted = false;
      const active = JevBrowseChild.#deepActiveElement(nodeWin.document);
      if (
        active &&
        active !== node &&
        !node.contains(active) &&
        JevBrowseChild.#retargetable(active) &&
        (!JevBrowseChild.#visible(node) || node.value !== action.text)
      ) {
        if (typeof active.setUserInput === "function") {
          active.setUserInput(action.text);
          retargeted = true;
        } else if (active.isContentEditable) {
          const selection = nodeWin.getSelection();
          selection.selectAllChildren(active);
          nodeWin.windowUtils.sendContentCommandEvent(
            "insertText",
            null,
            action.text
          );
          active.dispatchEvent(new nodeWin.Event("input", { bubbles: true }));
          retargeted = true;
        }
        if (retargeted) {
          await this.#settle(true);
        }
      }
      if (action.suggest && isCombobox) {
        this.#comboboxKeyFallback(nodeWin, retargeted ? active : node);
        await this.#settle(true);
      }
      return retargeted ? { ok: true, retargeted: true } : { ok: true };
    }

    // CLICK
    JevBrowseChild.#click(nodeWin, node, x, y);
    await this.#settle(false);
    return { ok: true };
  }

  /** document.activeElement, followed down through open shadow roots. */
  static #deepActiveElement(doc) {
    let el = doc?.activeElement ?? null;
    while (el?.shadowRoot?.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  /** An editable, non-sensitive text field we may retype into after a focus move. */
  static #retargetable(el) {
    if (!el || el.readOnly || el.getAttribute("aria-readonly") === "true") {
      return false;
    }
    if (JevBrowseChild.#sensitiveKind(el)) {
      return false;
    }
    if (el.tagName === "INPUT") {
      return !EXCLUDED_TYPES.has(el.type) && typeof el.setUserInput === "function";
    }
    return el.tagName === "TEXTAREA" || !!el.isContentEditable;
  }

  static #composedContains(node, hit) {
    let el = hit;
    while (el) {
      if (node.contains(el)) {
        return true;
      }
      const root = el.getRootNode();
      el = root?.host ?? null;
    }
    return false;
  }

  /**
   * Pref-gated combobox -> listbox fallback: untrusted ArrowDown (and Enter
   * only once an option is active) dispatched on the combobox node. Untrusted
   * key events run framework handlers but never a browser default action, so
   * Enter cannot implicitly submit a form.
   */
  #comboboxKeyFallback(win, node) {
    const doc = node.ownerDocument;
    const listId = node.getAttribute("aria-controls") || node.getAttribute("aria-owns");
    const list =
      (listId && doc.getElementById(listId)) || doc.querySelector('[role="listbox"]');
    const open =
      node.getAttribute("aria-expanded") === "true" &&
      list &&
      JevBrowseChild.#visible(list) &&
      list.querySelector('[role="option"]');
    if (!open) {
      return;
    }
    JevBrowseChild.#key(win, node, "ArrowDown", 40);
    if (node.getAttribute("aria-activedescendant")) {
      JevBrowseChild.#key(win, node, "Enter", 13);
    }
  }

  static #key(win, node, key, keyCode) {
    for (const type of ["keydown", "keyup"]) {
      node.dispatchEvent(
        new win.KeyboardEvent(type, {
          key,
          code: key,
          keyCode,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  static #click(win, node, x, y) {
    try {
      win.synthesizeMouseEvent("mousemove", x, y, {}, {});
      win.synthesizeMouseEvent(
        "mousedown",
        x,
        y,
        { button: 0, clickCount: 1 },
        {}
      );
      win.synthesizeMouseEvent(
        "mouseup",
        x,
        y,
        { button: 0, clickCount: 1 },
        {}
      );
    } catch {
      // Fallback for windows where synthesized events are unavailable.
      node.click();
    }
  }

  #settle(combobox) {
    const win = this.contentWindow;
    return new Promise(resolve => {
      let frames = 0;
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        win.setTimeout(finish, combobox ? 200 : 50);
        const tick = () => {
          if (done) {
            return;
          }
          if (++frames >= 2) {
            finish();
          } else {
            win.requestAnimationFrame(tick);
          }
        };
        win.requestAnimationFrame(tick);
      } catch {
        finish();
      }
    });
  }

  #extract() {
    const doc = this.document;
    if (!doc?.body) {
      return { page_text: "", json_ld: null };
    }
    const text = (doc.body.innerText || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .slice(0, PAGE_TEXT_LIMIT);
    return {
      page_text: text,
      json_ld: this.#jsonLdRecipe(),
      rows: this.#rows(),
      title: doc.title,
      url: this.contentWindow.location.href,
    };
  }

  /**
   * Candidate result rows: innermost visible list-like elements outside ad
   * containers whose text carries a price. Cap 20, document order.
   */
  #rows() {
    const doc = this.document;
    const sel = 'article,li,tr,[role="row"],[role="listitem"],[role="article"]';
    const priced = n =>
      JevBrowseChild.#visible(n) &&
      !n.closest(AD_CONTAINER_SELECTOR) &&
      ROW_PRICE_RE.test(n.innerText || "");
    let nodes = [...doc.querySelectorAll(sel)].filter(priced);
    nodes = nodes.filter(n => !nodes.some(m => m !== n && n.contains(m)));
    if (!nodes.length) {
      let best = null;
      let bestCount = 0;
      for (const c of doc.querySelectorAll("ol,ul,table,section,div")) {
        const kids = [...c.children].filter(priced);
        if (kids.length > bestCount) {
          best = kids;
          bestCount = kids.length;
        }
      }
      nodes = best ?? [];
    }
    return nodes.slice(0, 20).map(n => {
      const a = n.querySelector("a[href]") || n.closest("a[href]");
      let href = null;
      try {
        href = a ? new URL(a.href, doc.baseURI).href : null;
      } catch {
        href = null;
      }
      return {
        text: (n.innerText || "").replace(/\s+/g, " ").trim().slice(0, 240),
        href,
      };
    });
  }
}
