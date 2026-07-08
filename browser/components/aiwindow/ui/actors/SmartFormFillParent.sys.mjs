/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Parent-side actor for Smart Form Fill (spike POC).
 *
 * Orchestrates fill for one or more fields: classify the form, run a single
 * batch LLM call for all contextual targets, then arbitrate and write back per
 * field. Single-field fill is the same path as multi-field with targets.length
 * of 1. The arbiter is the only place stored values live: credit card /
 * identity fields never reach the model, and for a contextual field it picks
 * the LLM value when confident enough, else the stored value, else none.
 *
 * After a successful fill, per-field transparency is kept in a session map and
 * shown via the shared autocomplete popup (satchel/formfill panel).
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FormHistory: "resource://gre/modules/FormHistory.sys.mjs",
  generateSuggestions:
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

const MAX_REASONING_CHARS = 180;

/**
 * Stable map key for a ContentDOMReference identifier.
 *
 * @param {object} ref
 * @returns {string}
 */
function refKey(ref) {
  if (!ref) {
    return "";
  }
  return `${ref.browsingContextId}:${ref.id}`;
}

/**
 *
 */
export class SmartFormFillParent extends JSWindowActorParent {
  /**
   * Per-field transparency after a smart fill.
   * key: refKey(targetIdentifier) → session
   *
   * @type {Map<string, object>}
   */
  #sessions = new Map();

  /**
   * Fill the right-clicked field only (batch of one).
   *
   * @param {object} targetIdentifier  ContentDOMReference for the clicked field.
   * @returns {Promise<{status: string, filled?: number, results?: object[]}>}
   */
  async smartFill(targetIdentifier) {
    // Busy state on the target immediately — do not wait for classification.
    this.sendAsyncMessage("SmartFormFill:Preview", { targetIdentifier });
    const data = await this.sendQuery("SmartFormFill:ClassifyForm", {
      targetIdentifier,
    });
    return this.#runForm(data, {
      onlyClicked: true,
      earlyPreviewAnchor: targetIdentifier,
    });
  }

  /**
   * Keyboard entry: fill the focused field only (batch of one).
   *
   * @returns {Promise<{status: string, filled?: number, results?: object[]}>}
   */
  async smartFillFocused() {
    const data = await this.sendQuery("SmartFormFill:ClassifyFocusedForm", {});
    if (!data?.ok) {
      lazy.console.warn("Focused field not classifiable:", data?.reason);
      return { status: "unavailable" };
    }
    // Focused path has no target id until classify; preview the clicked field now.
    const clicked = data.fields?.find(f => f.isClicked);
    if (clicked?.targetIdentifier) {
      this.sendAsyncMessage("SmartFormFill:Preview", {
        targetIdentifier: clicked.targetIdentifier,
      });
    }
    return this.#runForm(data, {
      onlyClicked: true,
      earlyPreviewAnchor: clicked?.targetIdentifier ?? null,
    });
  }

  /**
   * Fill every contextual field on the form (one batch model call).
   *
   * @param {object} targetIdentifier
   * @returns {Promise<{status: string, filled?: number, results?: object[]}>}
   */
  async smartFillForm(targetIdentifier) {
    // Yellow "Smart filling…" on every fillable field immediately.
    this.sendAsyncMessage("SmartFormFill:PreviewForm", { targetIdentifier });
    const data = await this.sendQuery("SmartFormFill:ClassifyForm", {
      targetIdentifier,
    });
    return this.#runForm(data, {
      onlyClicked: false,
      earlyPreviewAnchor: targetIdentifier,
      earlyPreviewWholeForm: true,
    });
  }

  /**
   * Fill the right-clicked field using extra page content from a chosen tab.
   * Busy preview starts immediately; tab extract and classify run in parallel.
   *
   * @param {object} targetIdentifier
   * @param {object | Promise<object | null>} tabContext
   *   Resolved tab page content, or a promise of it (e.g. in-flight extract).
   * @returns {Promise<{status: string, filled?: number, results?: object[]}>}
   */
  async smartFillWithTabContext(targetIdentifier, tabContext) {
    this.sendAsyncMessage("SmartFormFill:Preview", { targetIdentifier });
    const [data, resolvedContext] = await Promise.all([
      this.sendQuery("SmartFormFill:ClassifyForm", { targetIdentifier }),
      this.#resolveTabContext(tabContext),
    ]);
    return this.#runForm(data, {
      onlyClicked: true,
      extraTabContext: resolvedContext,
      earlyPreviewAnchor: targetIdentifier,
    });
  }

  /**
   * Fill every contextual field using extra page content from a chosen tab.
   * Busy preview starts immediately; tab extract and classify run in parallel.
   *
   * @param {object} targetIdentifier
   * @param {object | Promise<object | null>} tabContext
   *   Resolved tab page content, or a promise of it (e.g. in-flight extract).
   * @returns {Promise<{status: string, filled?: number, results?: object[]}>}
   */
  async smartFillFormWithTabContext(targetIdentifier, tabContext) {
    this.sendAsyncMessage("SmartFormFill:PreviewForm", { targetIdentifier });
    const [data, resolvedContext] = await Promise.all([
      this.sendQuery("SmartFormFill:ClassifyForm", { targetIdentifier }),
      this.#resolveTabContext(tabContext),
    ]);
    return this.#runForm(data, {
      onlyClicked: false,
      extraTabContext: resolvedContext,
      earlyPreviewAnchor: targetIdentifier,
      earlyPreviewWholeForm: true,
    });
  }

  /**
   * @param {object | Promise<object | null> | null} tabContext
   * @returns {Promise<object | null>}
   */
  async #resolveTabContext(tabContext) {
    try {
      return (await tabContext) ?? null;
    } catch (e) {
      lazy.console.warn("tab context failed; continuing without it", e);
      return null;
    }
  }

  #clearEarlyPreview(earlyPreviewAnchor, earlyPreviewWholeForm) {
    if (!earlyPreviewAnchor) {
      return;
    }
    if (earlyPreviewWholeForm) {
      this.sendAsyncMessage("SmartFormFill:ClearFormPreview", {
        targetIdentifier: earlyPreviewAnchor,
      });
    } else {
      this.sendAsyncMessage("SmartFormFill:ClearPreview", {
        targetIdentifier: earlyPreviewAnchor,
      });
    }
  }

  /**
   * Shared path for single- and multi-field fill. Always one model call over
   * `targets`; single fill is just targets.length === 1.
   *
   * @param {object} data  ClassifyForm result.
   * @param {object} [options]
   * @param {boolean} [options.onlyClicked]
   * @param {object | null} [options.extraTabContext]
   * @param {object | null} [options.earlyPreviewAnchor]
   *   ContentDOMReference used for the pre-classify busy preview.
   * @param {boolean} [options.earlyPreviewWholeForm]
   *   When true, early preview covered every fillable field in the form.
   * @returns {Promise<{status: string, filled?: number, results?: object[]}>}
   */
  async #runForm(
    data,
    {
      onlyClicked = false,
      extraTabContext = null,
      earlyPreviewAnchor = null,
      earlyPreviewWholeForm = false,
    } = {}
  ) {
    const previewIds = [];
    try {
      lazy.console.info(`smartFill form invoked (onlyClicked=${onlyClicked})`);
      if (!data?.ok) {
        lazy.console.warn("Form not classifiable:", data?.reason);
        this.#clearEarlyPreview(earlyPreviewAnchor, earlyPreviewWholeForm);
        return { status: "unavailable" };
      }

      const { page, fields = [] } = data;
      const clicked = fields.find(f => f.isClicked);

      let targets = fields.filter(f => f.targetIdentifier && !f.category);
      if (onlyClicked) {
        targets = targets.filter(f => f.isClicked);
      }

      if (!targets.length) {
        this.#clearEarlyPreview(earlyPreviewAnchor, earlyPreviewWholeForm);
        if (clicked?.category === "creditCard") {
          lazy.console.info("Skipping credit card field");
          return { status: "skipped-creditcard" };
        }
        if (clicked?.category) {
          lazy.console.info(
            `Identity field (${clicked.fieldName}); deferring to existing autofill`
          );
          return { status: "deferred-identity" };
        }
        lazy.console.warn("No contextual fields to fill");
        return { status: "unavailable" };
      }

      const targetIdSet = new Set(targets.map(f => f.targetIdentifier));
      for (const field of targets) {
        previewIds.push(field.targetIdentifier);
      }

      // Drop busy state on fields we will not fill (identity / non-targets
      // that were previewed with PreviewForm before classification).
      if (earlyPreviewWholeForm) {
        for (const field of fields) {
          if (
            field.targetIdentifier &&
            !targetIdSet.has(field.targetIdentifier)
          ) {
            this.sendAsyncMessage("SmartFormFill:ClearPreview", {
              targetIdentifier: field.targetIdentifier,
            });
          }
        }
      } else if (earlyPreviewAnchor && !targetIdSet.has(earlyPreviewAnchor)) {
        this.sendAsyncMessage("SmartFormFill:ClearPreview", {
          targetIdentifier: earlyPreviewAnchor,
        });
      }

      // Ensure targets show busy state (no-op if early preview already did).
      for (const field of targets) {
        this.sendAsyncMessage("SmartFormFill:Preview", {
          targetIdentifier: field.targetIdentifier,
        });
      }

      const highConfidenceOnly = Services.prefs.getBoolPref(
        "browser.smartwindow.formfill.highConfidence",
        true
      );
      const alternativeCount = Services.prefs.getIntPref(
        "browser.smartwindow.formfill.alternatives",
        1
      );
      const suggestions = await lazy.generateSuggestions({
        page,
        fields: targets,
        extraTabContext,
        alternativeCount,
      });

      let filled = 0;
      const results = [];
      const filledFields = [];
      for (let i = 0; i < targets.length; i++) {
        const field = targets[i];
        const suggestion = suggestions?.get(i) ?? null;
        try {
          const res = await this.#arbitrateAndFill(
            field,
            suggestion,
            highConfidenceOnly
          );
          if (res.status === "filled") {
            filled++;
            this.#sessions.set(refKey(field.targetIdentifier), {
              value: res.value,
              source: res.source,
              confidence: suggestion?.confidence ?? 0,
              reasoning: suggestion?.reasoning ?? "",
              pageType: suggestion?.pageType ?? "",
              alternatives: suggestion?.alternatives ?? [],
              targetIdentifier: field.targetIdentifier,
            });
            filledFields.push({
              targetIdentifier: field.targetIdentifier,
              isTrigger: !!field.isClicked,
            });
          }
          results.push(res);
        } catch (e) {
          lazy.console.error("arbitrateAndFill failed", e);
          this.sendAsyncMessage("SmartFormFill:ClearPreview", {
            targetIdentifier: field.targetIdentifier,
          });
          results.push({ status: "error" });
        }
      }

      lazy.console.info(`form fill done: filled=${filled}/${targets.length}`);

      if (filledFields.length) {
        await this.#enableTransparency(filledFields);
      }

      return { status: "form-filled", filled, results };
    } catch (e) {
      lazy.console.error("smartFill form failed", e);
      if (earlyPreviewWholeForm && earlyPreviewAnchor) {
        this.sendAsyncMessage("SmartFormFill:ClearFormPreview", {
          targetIdentifier: earlyPreviewAnchor,
        });
      } else {
        for (const targetIdentifier of previewIds) {
          this.sendAsyncMessage("SmartFormFill:ClearPreview", {
            targetIdentifier,
          });
        }
        // ContentDOMReference objects may not match by identity after IPC.
        if (earlyPreviewAnchor) {
          this.sendAsyncMessage("SmartFormFill:ClearPreview", {
            targetIdentifier: earlyPreviewAnchor,
          });
        }
      }
      return { status: "error" };
    }
  }

  /**
   * Register filled fields for autocomplete transparency and auto-open the
   * panel on the originally triggered field.
   *
   * Opens via content-side form-fill showPopup() (same path as VK_DOWN), not
   * AutoCompleteParent.showPopupWithResults — the latter is unreliable right
   * after context-menu dismissal / without form-fill controller attachment.
   *
   * @param {Array<{targetIdentifier: object, isTrigger: boolean}>} filledFields
   */
  async #enableTransparency(filledFields) {
    const autoOpen =
      filledFields.find(f => f.isTrigger)?.targetIdentifier ??
      filledFields[0].targetIdentifier;

    try {
      await this.sendQuery("SmartFormFill:EnableTransparency", {
        fields: filledFields.map(f => f.targetIdentifier),
        autoOpenTargetIdentifier: autoOpen,
      });
    } catch (e) {
      lazy.console.warn("EnableTransparency failed", e);
    }
  }

  /**
   * Format secondary line for a primary or alternative suggestion.
   *
   * @param {object} entry
   * @param {string} [entry.source]
   * @param {number} [entry.confidence]
   * @param {string} [entry.reasoning]
   * @param {string} [sourceLabel]
   * @returns {string}
   */
  #formatSecondary(entry, sourceLabel = null) {
    let label = sourceLabel;
    if (!label) {
      if (entry.source === "llm") {
        label = "AI suggestion";
      } else if (entry.source === "stored") {
        label = "Form history";
      } else if (entry.source) {
        label = entry.source;
      } else {
        label = "Alternative";
      }
    }
    const conf =
      typeof entry.confidence === "number" ? entry.confidence.toFixed(2) : "—";
    let reasoning = (entry.reasoning || "").trim().replace(/\s+/g, " ");
    if (reasoning.length > MAX_REASONING_CHARS) {
      reasoning = reasoning.slice(0, MAX_REASONING_CHARS - 1) + "…";
    }
    if (reasoning) {
      return `${label} · confidence ${conf} — ${reasoning}`;
    }
    return `${label} · confidence ${conf}`;
  }

  // --- AutoComplete provider (parent) ------------------------------------

  /**
   * @param {string} searchString
   * @param {object} options
   * @param {object} [options.targetIdentifier]
   * @returns {Promise<object | null>}
   */
  async searchAutoCompleteEntries(searchString, options) {
    const key = refKey(options?.targetIdentifier);
    const session = this.#sessions.get(key);
    if (!session) {
      return null;
    }
    const alternatives = (session.alternatives || []).map(alt => ({
      value: alt.value,
      confidence: alt.confidence,
      reasoning: alt.reasoning,
      secondary: this.#formatSecondary(alt, "Alternative"),
    }));
    return {
      session: {
        ...session,
        secondary: this.#formatSecondary(session),
        alternatives,
      },
    };
  }

  onAutoCompleteEntrySelected(message, data) {
    switch (message) {
      case "SmartFormFill:Keep":
        // Transparency-only row; keep current value and dismiss.
        this.browsingContext.currentWindowGlobal
          .getActor("AutoComplete")
          ?.closePopup();
        break;
      case "SmartFormFill:Apply": {
        const targetIdentifier = data?.targetIdentifier;
        const value = data?.value;
        if (!targetIdentifier || typeof value !== "string" || !value) {
          break;
        }
        this.#applyAlternative(targetIdentifier, {
          value,
          confidence: data.confidence ?? 0,
          reasoning: data.reasoning ?? "",
        }).catch(e => lazy.console.error("Apply alternative failed", e));
        break;
      }
      case "SmartFormFill:Clear": {
        const targetIdentifier = data?.targetIdentifier;
        if (!targetIdentifier) {
          break;
        }
        this.#sessions.delete(refKey(targetIdentifier));
        this.sendAsyncMessage("SmartFormFill:ClearFill", {
          targetIdentifier,
        });
        this.browsingContext.currentWindowGlobal
          .getActor("AutoComplete")
          ?.closePopup();
        break;
      }
      default:
        lazy.console.warn("Unsupported autocomplete message:", message);
    }
  }

  /**
   * Apply an alternative suggestion as the field value and update the session.
   *
   * @param {object} targetIdentifier
   * @param {{value: string, confidence: number, reasoning: string}} alt
   */
  async #applyAlternative(targetIdentifier, alt) {
    const key = refKey(targetIdentifier);
    const session = this.#sessions.get(key);
    const filled = await this.sendQuery("SmartFormFill:Fill", {
      targetIdentifier,
      value: alt.value,
    });
    if (!filled) {
      return;
    }
    // Move previous primary into alternatives when distinct; drop applied alt.
    const previous = session
      ? {
          value: session.value,
          confidence: session.confidence,
          reasoning: session.reasoning,
        }
      : null;
    let alternatives = (session?.alternatives || []).filter(
      a => a.value !== alt.value
    );
    if (previous && previous.value && previous.value !== alt.value) {
      alternatives = [
        previous,
        ...alternatives.filter(a => a.value !== previous.value),
      ];
    }
    this.#sessions.set(key, {
      value: alt.value,
      source: "llm",
      confidence: alt.confidence,
      reasoning: alt.reasoning,
      pageType: session?.pageType ?? "",
      alternatives,
      targetIdentifier,
    });
    this.browsingContext.currentWindowGlobal
      .getActor("AutoComplete")
      ?.closePopup();
  }

  onAutoCompleteEntryHovered(message, data) {
    if (
      message === "SmartFormFill:Apply" &&
      data?.value &&
      data?.targetIdentifier
    ) {
      this.sendAsyncMessage("SmartFormFill:PreviewValue", {
        targetIdentifier: data.targetIdentifier,
        value: data.value,
      });
      return;
    }
    if (data?.targetIdentifier) {
      this.sendAsyncMessage("SmartFormFill:ClearValuePreview", {
        targetIdentifier: data.targetIdentifier,
      });
    }
  }

  onAutoCompleteEntryClearPreview(_message, data) {
    if (data?.targetIdentifier) {
      this.sendAsyncMessage("SmartFormFill:ClearValuePreview", {
        targetIdentifier: data.targetIdentifier,
      });
    }
  }

  onAutoCompletePopupOpened(_elementId) {}

  /**
   * Pick LLM vs stored value for one field and write it, or clear preview.
   *
   * @param {object} field
   * @param {object | null} suggestion
   * @param {boolean} highConfidenceOnly
   * @returns {Promise<{status: string, source?: string, value?: string, suggestion?: object}>}
   */
  async #arbitrateAndFill(field, suggestion, highConfidenceOnly) {
    const targetIdentifier = field.targetIdentifier;
    const storedValue = await this.#readStoredValue(field.name);
    const confidence = suggestion?.confidence ?? 0;

    lazy.console.info(
      `arbiter[${field.name || field.fieldName || "?"}] llm=${JSON.stringify(suggestion?.value)} confidence=${confidence} threshold=${CONFIDENCE_THRESHOLD} stored=${JSON.stringify(storedValue)}`
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
      value: chosen.value,
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
