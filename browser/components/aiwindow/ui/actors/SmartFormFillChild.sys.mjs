/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Content-side actor for Smart Form Fill (spike POC).
 *
 * Two jobs:
 * - Classify: resolve a field, run the existing FormAutofill heuristics over
 *   its form, and return field STRUCTURE (with currentValue) for every
 *   fillable control. Single- and multi-field fill both use this form shape.
 * - Fill: write the chosen value back via setUserInput so the page sees it as
 *   real user input, and flag it as autofilled for the highlight + undo path.
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
      case "SmartFormFill:ClearPreview":
        return this.#clearPreview(message.data.targetIdentifier);
    }
    return null;
  }

  #preview(targetIdentifier) {
    const element = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!element || !isFillable(element)) {
      return false;
    }
    element.previewValue = BUSY_PREVIEW_TEXT;
    element.autofillState = lazy.FormAutofillUtils.FIELD_STATES.PREVIEW;
    return true;
  }

  #clearPreview(targetIdentifier) {
    const element = lazy.ContentDOMReference.resolve(targetIdentifier);
    if (!element || !isFillable(element)) {
      return false;
    }
    element.previewValue = "";
    element.autofillState = lazy.FormAutofillUtils.FIELD_STATES.NORMAL;
    return true;
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
}
