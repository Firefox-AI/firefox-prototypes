/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * PDF Smart Form Fill (spike POC) - parent actor.
 *
 * Classifies each field into the web-autofill taxonomy by reusing FormAutofill,
 * running BOTH classifiers so we can compare them on real PDF labels:
 *   - regex heuristics (HeuristicsRegExp + testRegex)
 *   - TinyBERT (FormAutofillML.detectFields), which needs browser.ml.enable and
 *     downloads mozilla/tinybert-address-autofill on first use.
 * Reconciliation is regex-first, then ML, then "unknown"; both raw outputs are
 * reported so we can judge which does better.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FormAutofillHeuristics:
    "resource://gre/modules/shared/FormAutofillHeuristics.sys.mjs",
  HeuristicsRegExp: "resource://gre/modules/shared/HeuristicsRegExp.sys.mjs",
  FormAutofillUtils: "resource://gre/modules/shared/FormAutofillUtils.sys.mjs",
  FormAutofillML: "resource://gre/modules/shared/FormAutofillML.sys.mjs",
  formAutofillStorage: "resource://autofill/FormAutofillStorage.sys.mjs",
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
  generateSuggestion:
    "moz-src:///browser/components/aiwindow/models/SmartFormFill.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "PdfFormFill",
    // POC: force-on so the spike trace is always visible.
    maxLogLevel: "Debug",
  })
);

// Split "addressLine1" / "f2_1" into space-separated words.
function splitMixedCase(str) {
  return (str ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]+/g, " ")
    .trim();
}

// Lowercase, split on non-alphanumerics, drop words shorter than 3 chars, to
// match the FormAutofill tokenization the TinyBERT model was trained on.
function tokenizeWords(str) {
  return (str ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3);
}

export class PdfFormFillParent extends JSWindowActorParent {
  async receiveMessage(message) {
    switch (message.name) {
      case "PdfFormFill:Classify":
        return this.#classify(message.data.fields);
      case "PdfFormFill:ResolveValue":
        return this.#resolveValue(message.data);
    }
    return null;
  }

  // Fill entry points invoked from the context-menu item / keyboard shortcut.
  fillTarget(targetIdentifier) {
    this.sendAsyncMessage("PdfFormFill:FillTarget", { targetIdentifier });
  }

  fillFocused() {
    this.sendAsyncMessage("PdfFormFill:FillFocused", {});
  }

  // Classified fields are all PII/autofill categories, so they fill from the
  // user's stored data ONLY (address profile, or credit-card store) and never
  // from the LLM. Only unknown/contextual fields fall back to LLM generation.
  async #resolveValue({ fieldName, category, label, url, title }) {
    if (fieldName && fieldName !== "unknown") {
      const value = await this.#storedValue(fieldName, category);
      if (value) {
        return { value, source: "profile" };
      }
      lazy.console.info(`no stored value for ${fieldName}; leaving empty`);
      return { value: null, source: "none" };
    }

    try {
      const suggestion = await lazy.generateSuggestion({
        page: { url: url ?? "", title: title ?? "" },
        field: { name: label ?? "", inputType: "text" },
        siblingFields: [],
      });
      if (suggestion?.value) {
        return { value: suggestion.value, source: "llm" };
      }
    } catch (e) {
      lazy.console.warn("LLM generation failed", e);
    }
    return { value: null, source: "none" };
  }

  async #storedValue(fieldName, category) {
    try {
      await lazy.formAutofillStorage.initialize();
      if (category === "creditCard") {
        return await this.#creditCardValue(fieldName);
      }
      const addresses = await lazy.formAutofillStorage.addresses.getAll();
      return addresses?.[0]?.[fieldName] || null;
    } catch (e) {
      lazy.console.warn("reading stored value failed", e);
      return null;
    }
  }

  async #creditCardValue(fieldName) {
    const cards = await lazy.formAutofillStorage.creditCards.getAll();
    const card = cards?.[0];
    if (!card) {
      return null;
    }
    if (fieldName === "cc-number") {
      const encrypted = card["cc-number-encrypted"];
      if (!encrypted) {
        return card["cc-number"] || null;
      }
      try {
        // "formautofill_cc" triggers the OS reauth prompt (same tag the
        // FormAutofill storage uses to decrypt card numbers).
        return await lazy.OSKeyStore.decrypt(encrypted, "formautofill_cc");
      } catch (e) {
        lazy.console.warn("cc-number decrypt failed or was cancelled", e);
        return null;
      }
    }
    return card[fieldName] || null;
  }

  async #classify(fields) {
    const rules = lazy.HeuristicsRegExp.getRules();
    const ruleNames = Object.keys(rules);

    // Per-field token lists, then the ML input string with previous/next field
    // tokens prefixed bb/aa (the FormAutofill recipe). Fields arrive in reading
    // order, so array neighbors approximate on-page neighbors.
    const ownTokens = fields.map(f =>
      tokenizeWords(`${splitMixedCase(f.leaf ?? "")} ${f.tu ?? ""} ${f.label ?? ""}`)
    );
    const mlData = fields.map((_, i) => {
      // Guard: a label with no real word tokens (e.g. "$") is not classifiable.
      // Skip it so ML does not hallucinate a type from neighbor tokens alone.
      if (!ownTokens[i].length) {
        return null;
      }
      const previous = ownTokens[i - 1] ?? [];
      const next = ownTokens[i + 1] ?? [];
      return [
        ...ownTokens[i],
        ...previous.map(word => `bb${word}`),
        ...next.map(word => `aa${word}`),
      ].join(" ");
    });

    const mlLabelByData = await this.#runMl([...new Set(mlData.filter(Boolean))]);

    return fields.map((field, i) => {
      if (!ownTokens[i].length) {
        return {
          id: field.id,
          regexGuess: null,
          mlLabel: null,
          chosenFieldName: "unknown",
          category: null,
        };
      }

      // Label-first regex text; the opaque full name is excluded on purpose.
      const regexText = `${field.label ?? ""} ${field.tu ?? ""} ${splitMixedCase(
        field.leaf ?? ""
      )}`
        .toLowerCase()
        .trim();

      let regexGuess = null;
      for (const fieldName of ruleNames) {
        if (lazy.FormAutofillHeuristics.testRegex(rules[fieldName], regexText)) {
          regexGuess = fieldName;
          break;
        }
      }

      const mlLabel = mlLabelByData.get(mlData[i]) ?? null;
      const chosenFieldName = regexGuess ?? mlLabel ?? "unknown";
      const category =
        chosenFieldName !== "unknown"
          ? lazy.FormAutofillUtils.getCategoryFromFieldName(chosenFieldName)
          : null;

      lazy.console.debug(
        `"${field.leaf}" label="${field.label ?? ""}" regex=${regexGuess} ml=${mlLabel} -> ${chosenFieldName}`
      );

      return { id: field.id, regexGuess, mlLabel, chosenFieldName, category };
    });
  }

  // Run TinyBERT once per unique input string; returns a Map input -> label.
  async #runMl(uniqueInputs) {
    const labelByInput = new Map();
    if (!uniqueInputs.length) {
      return labelByInput;
    }
    try {
      const entries = uniqueInputs.map(mlData => ({ mlData, fieldName: "" }));
      await new lazy.FormAutofillML().detectFields(entries);
      entries.forEach((entry, i) =>
        labelByInput.set(uniqueInputs[i], entry.fieldName || null)
      );
      const hits = [...labelByInput.values()].filter(Boolean).length;
      lazy.console.info(
        `ML classified ${hits}/${uniqueInputs.length} unique inputs`
      );
    } catch (e) {
      lazy.console.warn(
        "ML classification unavailable (is browser.ml.enable on?)",
        e
      );
    }
    return labelByInput;
  }
}
