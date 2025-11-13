/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TextSelection } from "chrome://browser/content/smartwindow/prosemirror.bundle.js";
import {
  buildExtractedTexts,
  docToHTML,
  hasExistingMentions,
} from "chrome://browser/content/smartwindow/smartbar/smartbar-document.mjs";

/**
 * Controller for the Smartbar.
 *
 * @class SmartbarController
 * @param {object} options
 * @param {import('prosemirror-view').EditorView} options.editorView - Active ProseMirror EditorView instance.
 * @param {object} options.suggestionController - Controller handling suggestions UI.
 * @param {object} options.autofillController - Controller encapsulating autofill preparation and mutation lifecycle.
 * @param {Function} options.setEditorContent - Function(content:string, options?:{moveToEnd?:boolean}) -> void for controlled content replacement.
 * @param {Function} options.focusEditorAtEnd - Focuses editor and moves cursor to end of document.
 * @param {Function} options.getDocJSON - Returns the current editor doc as JSON.
 * @param {Function} options.destroyResources - Callback to free resources on teardown.
 * @param {Function} options.setEditableState - Toggles editor editable state.
 * @param {import('./smartbar-mention-controller.mjs').MentionDropdownController} options.mentionController - Controller for mention dropdown lifecycle.
 */
class SmartbarController {
  constructor({
    editorView,
    suggestionController,
    autofillController,
    setEditorContent,
    focusEditorAtEnd,
    getDocJSON,
    destroyResources,
    setEditableState,
    mentionController,
  }) {
    this.editor = editorView;
    this._suggestionController = suggestionController;
    this._autofillController = autofillController;
    this._setEditorContent = setEditorContent;
    this._focusEditorAtEnd = focusEditorAtEnd;
    this._getDocJSON = getDocJSON;
    this._destroyResources = destroyResources;
    this._setEditableState = setEditableState;
    this._mentionController = mentionController;
  }

  focus() {
    this._focusEditorAtEnd();
  }

  setAutofill(autofillData) {
    const json = this._getDocJSON();
    const { plainText: currentText } = buildExtractedTexts(json);
    const payload = this._autofillController.prepareAutofill({
      autofillData,
      currentText,
    });
    if (!payload) {
      return;
    }
    this._setEditorContent(payload.value, { moveToEnd: false });
    const from = payload.selectionStart + 1;
    const to = payload.selectionEnd + 1;
    const selection = TextSelection.create(this.editor.state.doc, from, to);
    this.editor.dispatch(this.editor.state.tr.setSelection(selection));
    this._autofillController.finishAutofillMutation();
  }

  getText() {
    return buildExtractedTexts(this._getDocJSON()).labeledQueryText;
  }

  getPlainText() {
    return buildExtractedTexts(this._getDocJSON()).plainText;
  }

  getQueryText() {
    return buildExtractedTexts(this._getDocJSON()).queryText;
  }

  getHTML() {
    return docToHTML(this.editor.state.doc);
  }

  getMentions() {
    const mentions = [];
    const json = this._getDocJSON();
    function collectMentions(node) {
      if (!node) {
        return;
      }
      if (node.type === "mention") {
        mentions.push({
          id: node.attrs?.id || "",
          label: node.attrs?.label || "",
          source: node.attrs?.source || null,
        });
      }
      if (Array.isArray(node.content)) {
        node.content.forEach(collectMentions);
      }
    }
    if (Array.isArray(json?.content)) {
      json.content.forEach(collectMentions);
    }
    return mentions;
  }

  setContent(content) {
    this._setEditorContent(content);
  }

  clear() {
    this._autofillController.reset();
    this._setEditorContent("");
    this._suggestionController.hide();
    this._focusEditorAtEnd();
  }

  setEditable(isEditable) {
    this._setEditableState(isEditable);
  }

  destroy() {
    this._mentionController.destroyDropdown(this.editor);
    this._destroyResources();
  }

  hasExistingMentions() {
    return hasExistingMentions(this._getDocJSON());
  }

  showSuggestions(suggestions, title, isQuickPrompts, query) {
    this._suggestionController.show({
      suggestions,
      title,
      isQuickPrompts,
      query,
    });
  }

  hideSuggestions() {
    this._suggestionController.hide();
  }

  navigateSuggestions(direction) {
    this._suggestionController.navigate(direction);
  }

  getSelectedSuggestion() {
    return this._suggestionController.getSelected();
  }

  hasSuggestions() {
    return this._suggestionController.hasSuggestions();
  }
}

export { SmartbarController };
