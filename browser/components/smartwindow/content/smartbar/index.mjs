/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  EditorState,
  EditorView,
  Plugin as PMPlugin,
  PluginKey as PMPluginKey,
  TextSelection,
  baseKeymap,
  history as PMHistory,
  undo as PMHistoryUndo,
  redo as PMHistoryRedo,
  keymap,
  suggestionsPlugin,
  triggerCharacter,
} from "chrome://browser/content/smartwindow/prosemirror.bundle.js";

import {
  PLACEHOLDER_TEXT,
  buildExtractedTexts,
  createDocFromText,
  createPasteToPillPlugin,
  createPlaceholderPlugin,
  schema,
} from "chrome://browser/content/smartwindow/smartbar/smartbar-document.mjs";

import { MentionDropdownController } from "chrome://browser/content/smartwindow/smartbar/smartbar-mention-controller.mjs";
import { SmartbarController } from "chrome://browser/content/smartwindow/smartbar/smartbar-controller.mjs";
import { SmartbarSuggestions } from "chrome://browser/content/smartwindow/smartbar/smartbar-suggestions.mjs";
import { switchToMatchingTab } from "chrome://browser/content/smartwindow/smartbar/smartbar-tabs.mjs";
import { SuggestionController } from "chrome://browser/content/smartwindow/smartbar/smartbar-suggestion-controller.mjs";
import { AutofillController } from "chrome://browser/content/smartwindow/smartbar/smartbar-autofill-controller.mjs";

/**
 * Mounts the Smartbar editor into the provided element and returns its public API.
 *
 * @param {HTMLElement} element - Host element whose contents will be replaced with the editor.
 * @param {object} [options]
 * @param {(event: KeyboardEvent) => void} [options.onKeyDown] - Called before internal key handling.
 * @param {(state: {text: string, isAutofilled: boolean}) => void} [options.onUpdate] - Runs on document changes.
 * @param {(suggestion: object) => void} [options.onSuggestionSelect] - Fired after a suggestion is committed.
 * @param {(type: string) => string} [options.getQueryTypeIcon] - Supplies fallback for suggestion icons.
 * @returns {object} Smartbar controller helpers.
 */
export function attachToElement(element, options = {}) {
  const { onKeyDown, onUpdate, onSuggestionSelect, getQueryTypeIcon } = options;

  const autofillController = new AutofillController();

  const wrapper = document.createElement("div");
  wrapper.className = "smartbar-wrapper";

  const parentNode = element.parentNode;
  parentNode.replaceChild(wrapper, element);
  wrapper.appendChild(element);

  const suggestionsView = new SmartbarSuggestions({
    parentNode,
    getQueryTypeIcon,
    onActionSuggestion: suggestion => {
      switchToMatchingTab(
        {
          url: suggestion.url,
          title: suggestion.title,
          query: suggestion.query || suggestion.text,
        },
        window
      );
    },
    onSuggestionActivated: suggestion => {
      setEditorContent(suggestion.text);
      if (onSuggestionSelect) {
        onSuggestionSelect(suggestion);
      }
    },
  });

  const mentionDropdownKey = new PMPluginKey("mentionDropdown");
  const mentionDropdownStatePlugin = new PMPlugin({
    key: mentionDropdownKey,
    state: {
      init() {
        return {
          dropdown: null,
          range: null,
          isOpen: false,
          abortController: null,
        };
      },
      apply(tr, prev) {
        const meta = tr.getMeta(mentionDropdownKey);
        if (!meta) {
          return prev;
        }
        return { ...prev, ...meta };
      },
    },
  });

  const suggestionController = new SuggestionController({
    getEditorView: () => editorView,
    mentionDropdownKey,
    suggestionsView,
  });

  const mentionController = new MentionDropdownController({
    mentionDropdownKey,
    hideSuggestions: () => suggestionController.hide(),
    getEditorView: () => editorView,
  });

  const placeholderPlugin = createPlaceholderPlugin(PLACEHOLDER_TEXT);
  const pasteToPillPlugin = createPasteToPillPlugin((item, range) =>
    mentionController.insertMentionCommand(item, range)
  );

  const mentionPlugin = suggestionsPlugin({
    matcher: triggerCharacter("@"),
    onEnter: payload => mentionController.handleEnter(payload),
    onChange: payload => mentionController.handleChange(payload),
    onExit: payload => mentionController.handleExit(payload?.view),
    onKeyDown: payload =>
      mentionController.handleKeyDown(payload?.view, payload?.event),
  });

  const state = EditorState.create({
    schema,
    plugins: [
      PMHistory(),
      keymap(baseKeymap),
      keymap({
        "Mod-z": PMHistoryUndo,
        "Mod-y": PMHistoryRedo,
        "Shift-Mod-z": PMHistoryRedo,
      }),
      placeholderPlugin,
      pasteToPillPlugin,
      mentionPlugin,
      mentionDropdownStatePlugin,
    ],
  });

  let editable = true;

  const editorView = new EditorView(
    { mount: element },
    {
      state,
      editable: () => editable,
      dispatchTransaction(transaction) {
        const newState = editorView.state.apply(transaction);
        editorView.updateState(newState);

        if (transaction.docChanged) {
          handleDocUpdate();
        }
      },
      handleKeyDown(view, event) {
        const ps = mentionDropdownKey.getState(view.state);
        if (ps?.isOpen) {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            const inserted = ps?.dropdown?.selectItem?.();
            if (inserted) {
              view.focus();
            }
            return true;
          }
          return false;
        }

        if (onKeyDown) {
          onKeyDown(event);
        }

        if (event.key === "Enter" && event.shiftKey) {
          return insertHardBreak(view);
        }

        const keysToPrevent = ["Enter", "ArrowUp", "ArrowDown", "Escape"];
        if (keysToPrevent.includes(event.key)) {
          return true;
        }

        // return false to let other plugins handle the event
        return false;
      },
    }
  );

  element.addEventListener("click", event => {
    const mentionElement = event.target.closest(".mention");
    if (mentionElement) {
      event.preventDefault();
      event.stopPropagation();
      mentionElement.classList.toggle("expanded");
    }
  });

  function handleDocUpdate() {
    const json = editorView.state.doc.toJSON();
    const { plainText: text } = buildExtractedTexts(json);

    const { isAutofilled } = autofillController.handleTextChange(text);
    suggestionController.handleDocUpdate({ text, docJSON: json });
    if (onUpdate) {
      onUpdate({ text, isAutofilled });
    }
  }

  function insertHardBreak(view) {
    const hardBreak = schema.nodes.hard_break;
    if (!hardBreak) {
      return false;
    }

    const { dispatch } = view;
    const tr = view.state.tr
      .replaceSelectionWith(hardBreak.create())
      .scrollIntoView();
    dispatch(tr);
    return true;
  }

  function setEditorContent(content, { moveToEnd = true } = {}) {
    const text = typeof content === "string" ? content : "";
    const { state: viewState, dispatch } = editorView;
    const newDoc = createDocFromText(text);
    if (viewState.doc.eq(newDoc)) {
      return; // content did not change
    }
    let tr = viewState.tr.replaceWith(
      0,
      viewState.doc.content.size,
      newDoc.content
    );
    if (moveToEnd) {
      tr = tr.setSelection(TextSelection.atEnd(tr.doc));
    }
    dispatch(tr);
  }

  function focusEditorAtEnd() {
    const selection = TextSelection.atEnd(editorView.state.doc);
    editorView.dispatch(editorView.state.tr.setSelection(selection));
    editorView.focus();
  }

  const controller = new SmartbarController({
    editorView,
    suggestionController,
    autofillController,
    setEditorContent,
    focusEditorAtEnd,
    getDocJSON: () => editorView.state.doc.toJSON(),
    destroyResources: () => {
      editorView.destroy();
      suggestionsView.destroy();
    },
    setEditableState: isEditable => {
      editable = isEditable;
      editorView.setProps({
        editable: () => editable,
      });
    },
    mentionController,
  });

  return controller;
}
