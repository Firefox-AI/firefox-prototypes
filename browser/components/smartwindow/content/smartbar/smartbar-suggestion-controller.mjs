/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  buildExtractedTexts,
  hasExistingMentions,
} from "chrome://browser/content/smartwindow/smartbar/smartbar-document.mjs";

/**
 * Controller for smartbar suggestions.
 *
 * @class SuggestionController
 * @param {object} options
 * @param {Function} options.getEditorView - Lazy getter returning the current ProseMirror EditorView.
 * @param {import('chrome://browser/content/smartwindow/prosemirror.bundle.js').PluginKey} options.mentionDropdownKey - PluginKey for accessing mention dropdown plugin state.
 * @param {object} options.suggestionsView - View adapter.
 */
class SuggestionController {
  constructor({ getEditorView, mentionDropdownKey, suggestionsView }) {
    this._getEditorView = getEditorView;
    this._mentionDropdownKey = mentionDropdownKey;
    this._suggestionsView = suggestionsView;
  }

  show({
    suggestions,
    title = "Suggestions:",
    isQuickPrompts = false,
    query = "",
  }) {
    const view = this._getEditorView?.();
    if (!view) {
      return;
    }
    const docJSON = view.state.doc.toJSON();
    const { plainText } = buildExtractedTexts(docJSON);
    const trimmed = plainText.trim();
    const ps = this._mentionDropdownKey.getState(view.state);
    if (!trimmed || ps?.isOpen || hasExistingMentions(docJSON)) {
      return;
    }
    this._suggestionsView.show({
      suggestions,
      title,
      isQuickPrompts,
      query,
    });
  }

  hide() {
    this._suggestionsView.hide();
  }

  navigate(direction) {
    this._suggestionsView.navigate(direction);
  }

  getSelected() {
    return this._suggestionsView.getSelected();
  }

  hasSuggestions() {
    return this._suggestionsView.hasSuggestions();
  }

  isVisible() {
    return this._suggestionsView.isVisible();
  }

  handleDocUpdate({ text, docJSON }) {
    if ((!text.trim() && this.isVisible()) || hasExistingMentions(docJSON)) {
      this.hide();
    }
  }
}

export { SuggestionController };
