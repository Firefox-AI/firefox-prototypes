/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Parent-side actor for Smart Form Fill (spike POC).
 *
 * Orchestrates a single fill: ask content to classify the field, run the
 * client-side arbiter, and (only for contextual fields) call the LLM and write
 * the result back. The arbiter is the only place stored values live: credit
 * card / identity fields never reach the model, and for a contextual field it
 * picks the LLM value when confident enough, else the stored value, else none.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FormHistory: "resource://gre/modules/FormHistory.sys.mjs",
  generateSuggestion:
    "moz-src:///browser/components/aiwindow/models/SmartFormFill.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "SmartFormFill",
    // POC: force-on so the spike trace is always visible.
    maxLogLevel: "Debug",
  })
);

// POC tuning knob — edit and rebuild to experiment. For a contextual field, the
// minimum LLM confidence (0..1) needed to prefer the model's value over the
// user's stored past value for that same field. Raise it to fall back to stored
// values more; lower it to let the model win more often.
const CONFIDENCE_THRESHOLD = 0.7;

/**
 *
 */
export class SmartFormFillParent extends JSWindowActorParent {
  /**
   * Entry point invoked from the context menu handler.
   *
   * @param {object} targetIdentifier  ContentDOMReference for the clicked field.
   * @returns {Promise<{status: string, suggestion?: object}>}
   */
  async smartFill(targetIdentifier) {
    const data = await this.sendQuery("SmartFormFill:Classify", {
      targetIdentifier,
    });
    return this.#run(targetIdentifier, data);
  }

  /**
   * Keyboard entry point: act on the focused field. Content resolves the
   * focused element and hands back an identifier for it.
   *
   * @returns {Promise<{status: string, suggestion?: object}>}
   */
  async smartFillFocused() {
    const data = await this.sendQuery("SmartFormFill:ClassifyFocused", {});
    if (!data?.ok) {
      lazy.console.warn("Focused field not classifiable:", data?.reason);
      return { status: "unavailable" };
    }
    return this.#run(data.targetIdentifier, data);
  }

  async smartFillForm(targetIdentifier) {
    const data = await this.sendQuery("SmartFormFill:ClassifyForm", {
      targetIdentifier,
    });
    return this.#runForm(data);
  }

  async #run(targetIdentifier, data) {
    try {
      lazy.console.info("smartFill invoked");
      lazy.console.info("classify result:", data);
      if (!data?.ok) {
        lazy.console.warn("Field not classifiable:", data?.reason);
        return { status: "unavailable" };
      }

      const { clicked } = data;

      if (clicked.category === "creditCard") {
        lazy.console.info("Skipping credit card field");
        return { status: "skipped-creditcard" };
      }
      if (clicked.category) {
        lazy.console.info(
          `Identity field (${clicked.fieldName}); deferring to existing autofill`
        );
        return { status: "deferred-identity" };
      }

      lazy.console.info("Contextual field; asking the model");
      return this.#suggestAndFill(
        targetIdentifier,
        data.page,
        clicked,
        data.siblingFields
      );
    } catch (e) {
      lazy.console.error("smartFill failed", e);
      this.sendAsyncMessage("SmartFormFill:ClearPreview", { targetIdentifier });
      return { status: "error" };
    }
  }

  async #runForm(data) {
    try {
      lazy.console.info("smartFillForm invoked");
      if (!data?.ok) {
        return { status: "unavailable" };
      }
      const { page, fields = [] } = data;
      let filled = 0;
      for (const field of fields) {
        if (field.category === "creditCard" || field.category) {
          continue;
        }
        if (!field.targetIdentifier) {
          continue;
        }
        try {
          const res = await this.#suggestAndFill(
            field.targetIdentifier,
            page,
            field,
            fields
          );
          if (res?.status === "filled") {
            filled++;
          }
        } catch (e) {
          this.sendAsyncMessage("SmartFormFill:ClearPreview", {
            targetIdentifier: field.targetIdentifier,
          });
        }
      }
      return { status: "form-filled", filled };
    } catch (e) {
      lazy.console.error("smartFillForm failed", e);
      return { status: "error" };
    }
  }

  async #suggestAndFill(targetIdentifier, page, field, siblingFields) {
    const storedValue = await this.#readStoredValue(field.name);
    this.sendAsyncMessage("SmartFormFill:Preview", { targetIdentifier });

    const highConfidenceOnly = Services.prefs.getBoolPref(
      "browser.smartwindow.formfill.highConfidence",
      true
    );
    const suggestion = await lazy.generateSuggestion({
      page,
      field,
      siblingFields,
    });

    const confidence = suggestion?.confidence ?? 0;
    lazy.console.info(
      `arbiter: llm=${JSON.stringify(suggestion?.value)} confidence=${confidence} threshold=${CONFIDENCE_THRESHOLD} stored=${JSON.stringify(storedValue)}`
    );

    let chosen = null;
    if (suggestion?.value) {
      if (!highConfidenceOnly || confidence >= CONFIDENCE_THRESHOLD) {
        chosen = { value: suggestion.value, source: "llm" };
      }
    }
    if (!chosen && storedValue) {
      chosen = { value: storedValue, source: "stored" };
    }

    if (!chosen) {
      lazy.console.warn("arbiter: no value chosen");
      this.sendAsyncMessage("SmartFormFill:ClearPreview", {
        targetIdentifier,
      });
      return { status: "no-value", suggestion };
    }

    lazy.console.info(`arbiter: chose ${chosen.source} -> "${chosen.value}"`);
    const filled = await this.sendQuery("SmartFormFill:Fill", {
      targetIdentifier,
      value: chosen.value,
    });

    lazy.console.info(`Fill ${filled ? "succeeded" : "failed"}`);
    return {
      status: filled ? "filled" : "fill-failed",
      source: chosen.source,
      suggestion,
    };
  }

  /**
   * Most-recently-used form-history value for a field, read on the client.
   * Never leaves the parent process / never goes to the model.
   *
   * @param {string} fieldName  The field's name/id attribute.
   * @returns {Promise<string | null>}
   */
  async #readStoredValue(fieldName) {
    if (!fieldName) {
      return null;
    }
    try {
      const results = await lazy.FormHistory.search(["value", "lastUsed"], {
        fieldname: fieldName,
      });
      if (!results?.length) {
        return null;
      }
      results.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
      return results[0].value ?? null;
    } catch (e) {
      lazy.console.warn("readStoredValue failed", e);
      return null;
    }
  }
}
