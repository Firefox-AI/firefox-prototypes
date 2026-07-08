/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Content-side actor for Smart Form Fill (spike POC).
 *
 * - Classify: resolve a field, run FormAutofill heuristics, return structure.
 * - Fill: write via setUserInput + AUTO_FILLED highlight.
 * - Transparency: after fill, register fields with the shared autocomplete
 *   popup provider and open the panel on focus/hover (auto-open is driven by
 *   the parent for the originally triggered field).
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContentDOMReference: "resource://gre/modules/ContentDOMReference.sys.mjs",
  AutofillFormFactory:
    "resource://gre/modules/shared/AutofillFormFactory.sys.mjs",
  FormAutofillHeuristics:
    "resource://gre/modules/shared/FormAutofillHeuristics.sys.mjs",
  FormAutofillUtils: "resource://gre/modules/shared/FormAutofillUtils.sys.mjs",
  AutofillDataTypes: "resource://gre/modules/shared/AutofillDataTypes.sys.mjs",
  GenericAutocompleteItem: "resource://gre/modules/FillHelpers.sys.mjs",
  FormHistoryAutoCompleteResult:
    "resource://gre/modules/FormHistoryAutoComplete.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "SmartFormFill(child)",
    // POC: force-on so the spike trace is always visible.
    maxLogLevel: "Debug",
  })
);

// Ghost text shown via the autofill preview state while the model is working.
const BUSY_PREVIEW_TEXT = "Smart filling…";

// Only these text input types are eligible. Identity-by-type inputs (email,
// tel), passwords, textareas, and non-text controls (checkbox, date, file, etc.)
// are excluded outright and left to Firefox's existing autofill.
const FILLABLE_INPUT_TYPES = new Set(["text", "search"]);

// Debounce hover-open so moving across the form does not thrash the panel.
const HOVER_OPEN_MS = 200;

// After context-menu fill, wait for menu dismissal before opening the panel.
const AUTO_OPEN_DELAY_MS = 100;

const gFormFillController = Cc[
  "@mozilla.org/satchel/form-fill-controller;1"
].getService(Ci.nsIFormFillController);

function isFillable(element) {
  return (
    HTMLInputElement.isInstance(element) &&
    FILLABLE_INPUT_TYPES.has(element.type)
  );
}

/**
 *
 */
export class SmartFormFillChild extends JSWindowActorChild {
  /** @type {WeakSet<Element>} */
  #enabledFields = new WeakSet();

  /** @type {WeakMap<Element, object>} */
  #fieldIdentifiers = new WeakMap();

  /** @type {number} */
  #hoverTimer = 0;

  /** @type {Element | null} */
  #hoverTarget = null;

  didDestroy() {
    if (this.#hoverTimer) {
      this.contentWindow?.clearTimeout(this.#hoverTimer);
    }
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "SmartFormFill:ClassifyForm":
        return this.#classifyForm(message.data.targetIdentifier);
      case "SmartFormFill:ClassifyFocusedForm":
        return this.#classifyFocusedForm();
      case "SmartFormFill:Fill":
        return this.#fill(message.data.targetIdentifier, message.data.value);
      case "SmartFormFill:Preview":
        return this.#preview(message.data.targetIdentifier);
      case "SmartFormFill:PreviewForm":
        return this.#previewForm(message.data.targetIdentifier);
      case "SmartFormFill:ClearPreview":
        return this.#clearPreview(message.data.targetIdentifier);
      case "SmartFormFill:ClearFormPreview":
        return this.#clearFormPreview(message.data.targetIdentifier);
      case "SmartFormFill:EnableTransparency":
        return this.#enableTransparency(
          message.data.fields,
          message.data.autoOpenTargetIdentifier
        );
      case "SmartFormFill:ClearFill":
        return this.#clearFill(message.data.targetIdentifier);
      case "SmartFormFill:PreviewValue":
        return this.#previewValue(
          message.data.targetIdentifier,
          message.data.value
        );
      case "SmartFormFill:ClearValuePreview":
        return this.#clearValuePreview(message.data.targetIdentifier);
    }
    return null;
  }

  // --- AutoComplete provider (child) -------------------------------------

  get actorName() {
    return "SmartFormFill";
  }

  getAutoCompleteSearchOption(input) {
    return {
      targetIdentifier:
        this.#fieldIdentifiers.get(input) ||
        lazy.ContentDOMReference.get(input),
    };
  }

  shouldSearchForAutoComplete(input) {
    return this.#enabledFields.has(input);
  }

  searchResultToAutoCompleteResult(searchString, input, records) {
    if (!records?.session) {
      return null;
    }
    const session = records.session;
    const targetIdentifier =
      this.#fieldIdentifiers.get(input) || lazy.ContentDOMReference.get(input);

    const acResult = new lazy.FormHistoryAutoCompleteResult(
      input,
      [],
      input.name || input.id || "",
      searchString
    );
    // Current applied value (transparency).
    acResult.externalEntries.push(
      new lazy.GenericAutocompleteItem(
        "",
        session.value,
        session.secondary || "",
        "SmartFormFill:Keep",
        { targetIdentifier }
      )
    );
    // Alternative suggestions — selecting applies that value.
    for (const alt of session.alternatives || []) {
      if (!alt?.value || alt.value === session.value) {
        continue;
      }
      acResult.externalEntries.push(
        new lazy.GenericAutocompleteItem(
          "",
          alt.value,
          alt.secondary || "",
          "SmartFormFill:Apply",
          {
            targetIdentifier,
            value: alt.value,
            confidence: alt.confidence ?? 0,
            reasoning: alt.reasoning ?? "",
          }
        )
      );
    }
    const clearItem = new lazy.GenericAutocompleteItem(
      "",
      "Clear smart fill",
      "Remove this value and transparency",
      "SmartFormFill:Clear",
      { targetIdentifier }
    );
    clearItem.style = "action";
    acResult.externalEntries.push(clearItem);
    return acResult;
  }

  // --- Preview / fill ----------------------------------------------------

  #setPreviewState(element) {
    element.previewValue = BUSY_PREVIEW_TEXT;
    element.autofillState = lazy.FormAutofillUtils.FIELD_STATES.PREVIEW;
  }

  #clearPreviewState(element) {
    element.previewValue = "";
    element.autofillState = lazy.FormAutofillUtils.FIELD_STATES.NORMAL;
  }

  #preview(targetIdentifier) {
    const element = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!element || !isFillable(element)) {
      return false;
    }
    this.#setPreviewState(element);
    return true;
  }

  #clearPreview(targetIdentifier) {
    const element = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!element || !isFillable(element)) {
      return false;
    }
    this.#clearPreviewState(element);
    return true;
  }

  /**
   * Immediately show busy preview on every fillable field in the form so the
   * UI reacts before classification / the model round-trip finish.
   *
   * @param {object} targetIdentifier  ContentDOMReference for a field in the form.
   */
  #previewForm(targetIdentifier) {
    for (const el of this.#fillableElementsInForm(targetIdentifier)) {
      this.#setPreviewState(el);
    }
    return true;
  }

  #clearFormPreview(targetIdentifier) {
    for (const el of this.#fillableElementsInForm(targetIdentifier)) {
      this.#clearPreviewState(el);
    }
    return true;
  }

  #fillableElementsInForm(targetIdentifier) {
    const clickedEl = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!clickedEl || !isFillable(clickedEl)) {
      return [];
    }
    const formLike = lazy.AutofillFormFactory.createFromField(clickedEl);
    const fieldDetails = lazy.FormAutofillHeuristics.getFormInfo(
      formLike,
      true
    );
    const elements = [];
    let foundClicked = false;
    for (const fd of fieldDetails) {
      const el = fd.element;
      if (!el || !isFillable(el)) {
        continue;
      }
      if (el === clickedEl) {
        foundClicked = true;
      }
      elements.push(el);
    }
    if (!foundClicked) {
      elements.push(clickedEl);
    }
    return elements;
  }

  #describeField(fieldDetail, clickedElement) {
    const element = fieldDetail.element;
    const fieldName = fieldDetail.fieldName || "";
    return {
      fieldName,
      category: fieldName
        ? (lazy.AutofillDataTypes.fieldToSubCategory[fieldName] ?? null)
        : null,
      inputType: element?.type ?? "",
      name: element?.name || element?.id || "",
      isClicked: element === clickedElement,
      maxLength: element?.maxLength > 0 ? element.maxLength : null,
      currentValue: element ? (element.value ?? null) : null,
    };
  }

  // Keyboard entry: classify the form around the focused field.
  #classifyFocusedForm() {
    const element = this.document.activeElement;
    if (!element || !isFillable(element)) {
      lazy.console.warn(
        "classifyFocusedForm: not a fillable input",
        element?.tagName,
        element?.type
      );
      return { ok: false, reason: "not-fillable" };
    }
    // No parent-side target id yet — show busy state before heuristics run.
    this.#setPreviewState(element);
    return this.#classifyFormFromElement(element);
  }

  #classifyForm(targetIdentifier) {
    const clickedEl = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!clickedEl || !isFillable(clickedEl)) {
      return { ok: false, reason: "not-fillable" };
    }
    return this.#classifyFormFromElement(clickedEl, targetIdentifier);
  }

  #classifyFormFromElement(clickedEl, targetIdentifier = null) {
    const formLike = lazy.AutofillFormFactory.createFromField(clickedEl);
    const fieldDetails = lazy.FormAutofillHeuristics.getFormInfo(
      formLike,
      true
    );
    lazy.console.info(
      `classifyForm: ${fieldDetails.length} heuristic fields; clicked type=${clickedEl.type} name=${clickedEl.name || clickedEl.id}`
    );

    const fields = [];
    let foundClicked = false;
    for (const fd of fieldDetails) {
      const el = fd.element;
      if (!el || !isFillable(el)) {
        continue;
      }
      const desc = this.#describeField(fd, clickedEl);
      desc.targetIdentifier = lazy.ContentDOMReference.get(el);
      if (el === clickedEl) {
        foundClicked = true;
      }
      fields.push(desc);
    }
    if (!foundClicked) {
      fields.push({
        fieldName: "",
        category: null,
        inputType: clickedEl.type ?? "",
        name: clickedEl.name || clickedEl.id || "",
        isClicked: true,
        maxLength: clickedEl.maxLength > 0 ? clickedEl.maxLength : null,
        currentValue: clickedEl.value ?? null,
        targetIdentifier:
          targetIdentifier || lazy.ContentDOMReference.get(clickedEl),
      });
    }
    return {
      ok: true,
      page: {
        url: this.document.documentURIObject?.spec ?? "",
        title: this.document.title ?? "",
      },
      fields,
    };
  }

  #fill(targetIdentifier, value) {
    const element = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!element || !isFillable(element) || typeof value !== "string") {
      lazy.console.warn("fill: bad target or value");
      return false;
    }

    let finalValue = value;
    if (element.maxLength > 0) {
      finalValue = finalValue.slice(0, element.maxLength);
    }
    if (!finalValue) {
      lazy.console.warn("fill: value empty after clamping");
      return false;
    }

    element.previewValue = "";
    element.setUserInput(finalValue);
    element.autofillState = lazy.FormAutofillUtils.FIELD_STATES.AUTO_FILLED;
    lazy.console.info(`fill: set "${finalValue}"`);
    return true;
  }

  #clearFill(targetIdentifier) {
    const element = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!element || !isFillable(element)) {
      return false;
    }
    element.previewValue = "";
    element.setUserInput("");
    element.autofillState = lazy.FormAutofillUtils.FIELD_STATES.NORMAL;
    this.#teardownField(element);
    return true;
  }

  /**
   * Ghost-preview an alternative value while hovering a panel row.
   *
   * @param {object} targetIdentifier  ContentDOMReference for the field.
   * @param {string} value
   */
  #previewValue(targetIdentifier, value) {
    const element = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!element || !isFillable(element) || typeof value !== "string") {
      return false;
    }
    element.previewValue = value;
    element.autofillState = lazy.FormAutofillUtils.FIELD_STATES.PREVIEW;
    return true;
  }

  /**
   * Clear alt hover preview; restore autofilled highlight if still smart-filled.
   *
   * @param {object} targetIdentifier  ContentDOMReference for the field.
   */
  #clearValuePreview(targetIdentifier) {
    const element = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!element || !isFillable(element)) {
      return false;
    }
    element.previewValue = "";
    element.autofillState = this.#enabledFields.has(element)
      ? lazy.FormAutofillUtils.FIELD_STATES.AUTO_FILLED
      : lazy.FormAutofillUtils.FIELD_STATES.NORMAL;
    return true;
  }

  // --- Transparency registration / panel triggers ------------------------

  /**
   * @param {Array<object>} fieldIdentifiers  ContentDOMReferences for filled fields.
   * @param {object | null} autoOpenTargetIdentifier
   *   If set, open the transparency panel on this field after a short delay.
   * @returns {boolean}
   */
  #enableTransparency(fieldIdentifiers, autoOpenTargetIdentifier = null) {
    const autoComplete = this.manager.getActor("AutoComplete");
    if (!autoComplete) {
      lazy.console.warn("AutoComplete actor unavailable");
      return false;
    }

    for (const targetIdentifier of fieldIdentifiers || []) {
      const element = lazy.ContentDOMReference.resolve(targetIdentifier);
      if (!element || !isFillable(element)) {
        continue;
      }
      if (this.#enabledFields.has(element)) {
        this.#fieldIdentifiers.set(element, targetIdentifier);
        continue;
      }

      this.#enabledFields.add(element);
      this.#fieldIdentifiers.set(element, targetIdentifier);
      autoComplete.markAsAutoCompletableField(element, this);
      element.addEventListener("focus", this.#onFocus, true);
      element.addEventListener("mouseover", this.#onMouseOver, true);
      element.addEventListener("mouseout", this.#onMouseOut, true);
      lazy.console.info(
        `transparency enabled on ${element.name || element.id || element.type}`
      );
    }

    if (autoOpenTargetIdentifier) {
      // Delay so context-menu dismissal does not immediately dismiss the panel.
      this.contentWindow.setTimeout(() => {
        this.#openTransparencyPopup(autoOpenTargetIdentifier, {
          focusField: true,
        });
      }, AUTO_OPEN_DELAY_MS);
    }
    return true;
  }

  #teardownField(element) {
    if (!element || !this.#enabledFields.has(element)) {
      return;
    }
    this.#enabledFields.delete(element);
    this.#fieldIdentifiers.delete(element);
    element.removeEventListener("focus", this.#onFocus, true);
    element.removeEventListener("mouseover", this.#onMouseOver, true);
    element.removeEventListener("mouseout", this.#onMouseOut, true);
  }

  /** When true, ignore focus-driven open (programmatic focus during auto-open). */
  #suppressFocusOpen = false;

  /**
   * Open the shared form-fill autocomplete popup for a smart-filled field.
   * Same machinery as pressing Down while focused — uses nsIFormFillController
   * so SmartFormFill is queried as an autocomplete provider.
   *
   * Important: nsIFormFillController.showPopup() *toggles* if already open, so
   * we never call it when the popup is already showing for this field.
   *
   * @param {object} targetIdentifier
   * @param {object} [options]
   * @param {boolean} [options.focusField]
   * @returns {boolean}
   */
  #openTransparencyPopup(targetIdentifier, { focusField = false } = {}) {
    const element = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!element || !isFillable(element) || !this.#enabledFields.has(element)) {
      lazy.console.warn("openTransparencyPopup: field not ready");
      return false;
    }

    const autoComplete = this.manager.getActor("AutoComplete");

    if (focusField && this.document.activeElement !== element) {
      this.#suppressFocusOpen = true;
      try {
        element.focus({ preventScroll: true });
      } catch (e) {
        lazy.console.warn("openTransparencyPopup: focus failed", e);
      } finally {
        this.#suppressFocusOpen = false;
      }
    }

    try {
      // Already open for this field — do not call showPopup() (it would close).
      if (
        autoComplete?.popupOpen &&
        gFormFillController.controlledElement === element
      ) {
        return true;
      }
      if (autoComplete?.popupOpen) {
        autoComplete.closePopup();
      }

      // Attach form-fill to this field (works without keyboard focus for hover).
      gFormFillController.controlledElement = element;
      gFormFillController.showPopup();
      lazy.console.info(
        `openTransparencyPopup: showPopup on ${element.name || element.id || element.type}`
      );
      return true;
    } catch (e) {
      lazy.console.error("openTransparencyPopup failed", e);
      return false;
    }
  }

  #onFocus = event => {
    if (this.#suppressFocusOpen) {
      return;
    }
    const element = event.currentTarget;
    if (!this.#enabledFields.has(element)) {
      return;
    }
    const targetIdentifier = this.#fieldIdentifiers.get(element);
    if (targetIdentifier) {
      this.#openTransparencyPopup(targetIdentifier);
    }
  };

  #onMouseOver = event => {
    const element = event.currentTarget;
    if (!this.#enabledFields.has(element)) {
      return;
    }
    this.#hoverTarget = element;
    if (this.#hoverTimer) {
      this.contentWindow.clearTimeout(this.#hoverTimer);
    }
    this.#hoverTimer = this.contentWindow.setTimeout(() => {
      this.#hoverTimer = 0;
      if (this.#hoverTarget !== element) {
        return;
      }
      const targetIdentifier = this.#fieldIdentifiers.get(element);
      if (targetIdentifier) {
        this.#openTransparencyPopup(targetIdentifier);
      }
    }, HOVER_OPEN_MS);
  };

  #onMouseOut = event => {
    if (event.currentTarget !== this.#hoverTarget) {
      return;
    }
    this.#hoverTarget = null;
    if (this.#hoverTimer) {
      this.contentWindow.clearTimeout(this.#hoverTimer);
      this.#hoverTimer = 0;
    }
  };
}
