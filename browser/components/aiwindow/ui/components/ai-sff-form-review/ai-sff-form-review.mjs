/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import {
  html,
  ifDefined,
  repeat,
} from "chrome://global/content/vendor/lit.all.mjs";
import {
  FORM_REVIEW_ACTIONS,
  FORM_REVIEW_ERRORS,
  FORM_REVIEW_READY_EVENT,
  FORM_REVIEW_STATES,
} from "chrome://browser/content/aiwindow/modules/SmartFormFillConstants.mjs";

// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button-group.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-input-text.mjs";

/** @typedef {import("chrome://global/content/vendor/lit.all.mjs").TemplateResult} TemplateResult */
/** @typedef {import("chrome://global/content/elements/moz-input-text.mjs").default} MozInputText */
/** @typedef {import("chrome://browser/content/aiwindow/modules/SmartFormFillConstants.mjs").FormReviewField} FormReviewField */
/** @typedef {import("chrome://browser/content/aiwindow/modules/SmartFormFillConstants.mjs").FormReviewActionType} FormReviewActionType */
/** @typedef {import("chrome://browser/content/aiwindow/modules/SmartFormFillConstants.mjs").FormReviewErrorType} FormReviewErrorType */
/** @typedef {import("chrome://browser/content/aiwindow/modules/SmartFormFillConstants.mjs").FormReviewState} FormReviewState */

/**
 * @typedef {object} FillFormActionDetail
 * @property {Array<{id: string, value: string}>} fields List of fields to fill
 */

/**
 * Smart Form Fill form fill review component
 */
export class AiSffFormReview extends MozLitElement {
  static properties = {
    fields: { type: Array },
    state: { type: String },
    errorType: { type: String },
    filling: { type: Boolean },
  };

  static queries = {
    summaryAction: ".form-review-summary-action",
    firstReviewField: "moz-input-text",
    stopButton: ".form-review-stop",
    closeButton: ".form-review-close",
  };

  /**
   * Creates a form review component in progress state
   */
  constructor() {
    super();

    /** @type {Array<FormReviewField>} */
    this.fields = [];

    /** @type {FormReviewState} */
    this.state = FORM_REVIEW_STATES.PROGRESS;

    /** @type {FormReviewErrorType | null} */
    this.errorType = null;

    /** @type {boolean} */
    this.filling = false;
  }

  /**
   * Sends ready event so value generation can begin
   *
   * @returns {void}
   */
  firstUpdated() {
    this.#focusCurrentState();
    this.dispatchEvent(
      new CustomEvent(FORM_REVIEW_READY_EVENT, {
        bubbles: true,
      })
    );
  }

  /**
   * Moves focus to the first meaningful control after a state transition.
   *
   * @param {Map<string, unknown>} changedProperties
   *   Properties changed by the completed update.
   * @returns {void}
   */
  updated(changedProperties) {
    super.updated(changedProperties);

    if (!changedProperties.has("state")) {
      return;
    }

    this.#focusCurrentState();
  }

  /**
   * Focuses the primary control for the current state.
   *
   * @returns {void}
   */
  #focusCurrentState() {
    // TODO Bug 2062498 - Ensure screen readers announce context for each state
    switch (this.state) {
      case FORM_REVIEW_STATES.PROGRESS:
        this.stopButton?.focus();
        break;
      case FORM_REVIEW_STATES.SUMMARY:
        this.summaryAction?.focus();
        break;
      case FORM_REVIEW_STATES.REVIEW:
        this.#focusFirstReviewField();
        break;
      case FORM_REVIEW_STATES.FINAL:
        this.closeButton?.focus();
        break;
    }
  }

  /**
   * Focuses the first review field after its internal input is rendered.
   *
   * @returns {Promise<void>}
   */
  async #focusFirstReviewField() {
    const field = this.firstReviewField;
    if (!field) {
      return;
    }

    await field.updateComplete;

    if (this.state === FORM_REVIEW_STATES.REVIEW && field.isConnected) {
      field.focus();
    }
  }

  /**
   * Dispatches an action from the review component to its dialog host.
   *
   * @param {FormReviewActionType} type
   *   The action being requested.
   * @param {FillFormActionDetail} [detail]
   *   Data associated with the action.
   * @returns {void}
   */
  #dispatchAction(type, detail) {
    this.dispatchEvent(
      new CustomEvent(type, {
        bubbles: true,
        composed: true,
        detail,
      })
    );
  }

  /**
   * Moves the component to the editable review state.
   *
   * @returns {void}
   */
  #handleReview() {
    if (this.filling) {
      return;
    }

    this.state = FORM_REVIEW_STATES.REVIEW;
  }

  /**
   * Saves an edited generated value for its corresponding form field.
   *
   * @param {InputEvent & {currentTarget: MozInputText}} event
   *   The input event containing the edited value.
   * @param {string} fieldId The identifier of the edited form field.
   *
   * @returns {void}
   */
  #handleInput(event, fieldId) {
    if (this.filling) {
      return;
    }

    this.fields = this.fields.map(field =>
      field.id === fieldId
        ? {
            ...field,
            value: event.currentTarget.value,
          }
        : field
    );
  }

  /**
   * Requests that the current reviewed values be filled into the form.
   *
   * @returns {void}
   */
  #handleFill() {
    if (this.filling) {
      return;
    }

    this.filling = true;
    this.#dispatchAction(FORM_REVIEW_ACTIONS.FILL_FORM, {
      fields: this.fields.map(({ id, value }) => ({ id, value })),
    });
  }

  /**
   * Cancels review without requesting that any values be filled.
   *
   * @returns {void}
   */
  #handleCancel() {
    if (this.filling) {
      return;
    }

    this.#dispatchAction(FORM_REVIEW_ACTIONS.CANCEL);
  }

  /**
   * Requests cancellation of suggestion generation.
   *
   * @returns {void}
   */
  #handleStop() {
    this.#dispatchAction(FORM_REVIEW_ACTIONS.STOP);
  }

  /**
   * Requests that the completed dialog be closed.
   *
   * @returns {void}
   */
  #handleClose() {
    this.#dispatchAction(FORM_REVIEW_ACTIONS.CLOSE);
  }

  /**
   * Renders the value generation summary and review-or-fill buttons.
   *
   * @returns {TemplateResult}
   */
  #renderSummary() {
    return html`
      <section
        class="form-review-dialog"
        aria-labelledby="form-review-summary-heading"
        aria-describedby="form-review-summary-description"
      >
        <h1
          id="form-review-summary-heading"
          data-l10n-id="ai-smart-form-fill-suggestions-found"
        ></h1>
        <p
          id="form-review-summary-description"
          data-l10n-id="ai-smart-form-fill-suggestions-found-description"
          data-l10n-args=${JSON.stringify({
            count: this.fields.length,
          })}
        ></p>
        <moz-button-group class="form-review-actions">
          <moz-button
            .disabled=${this.filling}
            data-l10n-id="ai-smart-form-fill-fill-form"
            @click=${this.#handleFill}
          ></moz-button>
          <moz-button
            class="form-review-summary-action"
            type="primary"
            .disabled=${this.filling}
            data-l10n-id="ai-smart-form-fill-review-suggestions"
            @click=${this.#handleReview}
          ></moz-button>
        </moz-button-group>
      </section>
    `;
  }

  /**
   * Renders an editable generated value with the detected field label.
   *
   * @param {FormReviewField} field The generated field value to render.
   *
   * @returns {TemplateResult}
   */
  #renderReviewField(field) {
    const label = field.label || field.placeholder || field.name || "";
    const usesGenericLabel = !label;

    return html`
      <moz-input-text
        .value=${field.value}
        .label=${label}
        .disabled=${this.filling}
        data-l10n-id=${ifDefined(
          usesGenericLabel ? "ai-smart-form-fill-field" : undefined
        )}
        @input=${event => this.#handleInput(event, field.id)}
      ></moz-input-text>
    `;
  }

  /**
   * Renders the editable list of generated values and its fill and cancel
   * actions.
   *
   * @returns {TemplateResult}
   */
  #renderReview() {
    return html`
      <section
        class="form-review-dialog"
        aria-labelledby="form-review-heading"
        aria-describedby="form-review-description"
      >
        <h1
          id="form-review-heading"
          data-l10n-id="ai-smart-form-fill-review-heading"
        ></h1>
        <p
          id="form-review-description"
          data-l10n-id="ai-smart-form-fill-review-description"
        ></p>
        <div class="form-review-fields">
          ${repeat(
            this.fields,
            field => field.id,
            field => this.#renderReviewField(field)
          )}
        </div>
        <moz-button-group class="form-review-actions">
          <moz-button
            .disabled=${this.filling}
            data-l10n-id="ai-smart-form-fill-cancel-review"
            @click=${this.#handleCancel}
          ></moz-button>
          <moz-button
            type="primary"
            .disabled=${this.filling}
            data-l10n-id="ai-smart-form-fill-fill-form"
            @click=${this.#handleFill}
          ></moz-button>
        </moz-button-group>
      </section>
    `;
  }

  /**
   * Renders the suggestion-generation progress indicator and stop action.
   *
   * @returns {TemplateResult}
   */
  #renderProgress() {
    return html`
      <section
        class="form-review-dialog form-review-progress"
        aria-labelledby="form-review-progress-label"
      >
        <img
          class="form-review-progress-icon"
          src="chrome://global/skin/icons/loading.svg"
          alt=""
        />
        <span
          id="form-review-progress-label"
          class="form-review-progress-label"
          data-l10n-id="ai-smart-form-fill-finding-suggestions"
        ></span>
        <moz-button
          class="form-review-stop"
          icon-src="chrome://browser/content/aiwindow/assets/stop-generation.svg"
          data-l10n-id="ai-smart-form-fill-stop-finding-suggestions"
          @click=${this.#handleStop}
        ></moz-button>
      </section>
    `;
  }

  /**
   * Renders the success or failure result and its close action.
   *
   * @returns {TemplateResult}
   */
  #renderFinal() {
    const hasErrors = this.errorType !== null;
    let headingId = "ai-smart-form-fill-success-heading";
    let descriptionId = "ai-smart-form-fill-success-description";

    if (this.errorType === FORM_REVIEW_ERRORS.NO_SUGGESTIONS) {
      headingId = "ai-smart-form-fill-no-suggestions-heading";
      descriptionId = "ai-smart-form-fill-no-suggestions-description";
    } else if (hasErrors) {
      headingId = "ai-smart-form-fill-error-heading";
      descriptionId = "ai-smart-form-fill-error-description";
    }

    const icon = hasErrors
      ? "chrome://global/skin/icons/error.svg"
      : "chrome://global/skin/icons/check-filled.svg";

    return html`
      <section
        class="form-review-dialog"
        aria-labelledby="form-review-final-heading"
        aria-describedby="form-review-final-description"
      >
        <h1 id="form-review-final-heading" class="form-review-final-heading">
          <img class="form-review-status-icon" src=${icon} alt="" />
          <span data-l10n-id=${headingId}></span>
        </h1>
        <p id="form-review-final-description" data-l10n-id=${descriptionId}></p>
        <moz-button-group class="form-review-actions">
          <moz-button
            class="form-review-close"
            type="primary"
            data-l10n-id="ai-smart-form-fill-close-review"
            @click=${this.#handleClose}
          ></moz-button>
        </moz-button-group>
      </section>
    `;
  }

  /**
   * Renders the view associated with the component's current state.
   *
   * @returns {TemplateResult}
   */
  render() {
    let content;

    switch (this.state) {
      case FORM_REVIEW_STATES.PROGRESS:
        content = this.#renderProgress();
        break;
      case FORM_REVIEW_STATES.SUMMARY:
        content = this.#renderSummary();
        break;
      case FORM_REVIEW_STATES.REVIEW:
        content = this.#renderReview();
        break;
      case FORM_REVIEW_STATES.FINAL:
        content = this.#renderFinal();
        break;
      default:
        content = this.#renderSummary();
    }

    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/ai-sff-form-review.css"
      />
      ${content}
    `;
  }
}

customElements.define("ai-sff-form-review", AiSffFormReview);
