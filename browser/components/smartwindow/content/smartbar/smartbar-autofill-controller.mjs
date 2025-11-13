/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Controls lifecycle of inline autofill suggestions applied to the Smartbar input.
 */
class AutofillController {
  constructor() {
    this.reset();
  }

  reset() {
    this._autofillState = null;
    this._deletedQuery = "";
    this._previousText = "";
    this._mutationActive = false;
  }

  /**
   * Prepares applying an autofill suggestion if it is compatible with the current text.
   *
   * @param {object} params
   * @param {{ value:string, selectionStart:number, selectionEnd:number }} params.autofillData
   * @param {string} params.currentText - Plain-text representation of the editor contents.
   * @returns {{ value:string, selectionStart:number, selectionEnd:number } | null}
   */
  prepareAutofill({ autofillData, currentText }) {
    if (!autofillData?.value) {
      return null;
    }

    const loweredCurrent = currentText.toLowerCase().trim();
    if (
      this._deletedQuery &&
      (loweredCurrent === this._deletedQuery ||
        this._deletedQuery.startsWith(loweredCurrent))
    ) {
      return null;
    }

    const expectedPrefix = autofillData.value.substring(
      0,
      autofillData.selectionStart
    );
    if (currentText !== expectedPrefix) {
      return null;
    }

    this._autofillState = {
      value: autofillData.value.trim(),
      originalPrefix: currentText,
    };
    this._mutationActive = true;

    return {
      value: autofillData.value,
      selectionStart: autofillData.selectionStart,
      selectionEnd: autofillData.selectionEnd,
    };
  }

  finishAutofillMutation() {
    this._mutationActive = false;
  }

  /**
   * Updates internal tracking based on the latest document text.
   *
   * @param {string} text
   * @returns {{ isAutofilled: boolean }}
   */
  handleTextChange(text) {
    if (this._autofillState) {
      if (
        text !== this._autofillState.value &&
        text.length < this._autofillState.value.length
      ) {
        this._deletedQuery = this._autofillState.originalPrefix
          .toLowerCase()
          .trim();
        this._autofillState = null;
      } else if (text.length > this._autofillState.value.length) {
        this._autofillState = null;
      }
    }

    if (
      this._deletedQuery &&
      this._previousText &&
      text.toLowerCase().startsWith(this._previousText.toLowerCase()) &&
      text.length > this._previousText.length
    ) {
      this._deletedQuery = "";
    }

    this._previousText = text;
    return { isAutofilled: this._mutationActive };
  }
}

export { AutofillController };
