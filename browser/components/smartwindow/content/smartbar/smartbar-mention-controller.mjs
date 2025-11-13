/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TextSelection } from "chrome://browser/content/smartwindow/prosemirror.bundle.js";
import {
  MentionDropdown,
  getMentionSuggestions,
} from "chrome://browser/content/smartwindow/mentions.mjs";
import {
  getExistingMentionIds,
  getMentionClientRect,
  schema,
} from "chrome://browser/content/smartwindow/smartbar/smartbar-document.mjs";

/**
 * Controller for the mentions dropdown.
 *
 * @class MentionDropdownController
 * @param {object} options - Construction options.
 * @param {import("chrome://browser/content/smartwindow/prosemirror.bundle.js").PluginKey} options.mentionDropdownKey - PluginKey used to store dropdown state meta on transactions.
 * @param {Function} options.hideSuggestions - Callback to hide any non-mention suggestions UI when opening the mention dropdown.
 * @param {Function} options.getEditorView - Lazy getter returning the current EditorView if handlers are invoked without an explicit view.
 */
class MentionDropdownController {
  constructor({ mentionDropdownKey, hideSuggestions, getEditorView }) {
    this.key = mentionDropdownKey;
    this.hideSuggestions = hideSuggestions;
    this.getEditorView = getEditorView;
  }

  dispatchMeta(view, meta) {
    view.dispatch(view.state.tr.setMeta(this.key, meta));
  }

  destroyDropdown(view) {
    if (!view) {
      return;
    }
    const ps = this.key.getState(view.state);
    ps?.dropdown?.destroy();
    if (ps?.abortController) {
      ps.abortController.abort();
    }
    this.dispatchMeta(view, {
      dropdown: null,
      range: null,
      isOpen: false,
      abortController: null,
    });
  }

  async updateMentionSuggestions(view, text, range) {
    if (!view) {
      return;
    }
    const query = text.replace(/^@/, "").trim();
    const current = this.key.getState(view.state);
    if (current?.abortController) {
      current.abortController.abort();
    }
    const abortController = new AbortController();
    const { signal } = abortController;
    this.dispatchMeta(view, { abortController });

    let items = [];
    try {
      items = await getMentionSuggestions(query, { signal });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      console.error("Mention suggestions error", error);
      const ps = this.key.getState(view.state);
      ps?.dropdown?.destroy();
      this.dispatchMeta(view, {
        dropdown: null,
        range: null,
        isOpen: false,
        abortController: null,
      });
      return;
    }

    if (signal.aborted) {
      return;
    }

    const postFetchJson = view.state.doc.toJSON();
    const postFetchMentionIds = getExistingMentionIds(postFetchJson);
    const filtered = items.filter(
      suggestion => !postFetchMentionIds.has(suggestion.id)
    );

    const ps = this.key.getState(view.state);
    let dropdown = ps?.dropdown;
    if (!dropdown) {
      dropdown = new MentionDropdown();
      dropdown.create(filtered, item => {
        const cmd = this.insertMentionCommand(item, ps?.range);
        cmd(view.state, view.dispatch, view);
        this.destroyDropdown(view);
        requestAnimationFrame(() => view.focus());
      });
      this.dispatchMeta(view, { dropdown });
    } else {
      dropdown.update(filtered);
    }

    const rect = getMentionClientRect(view, range);
    if (rect) {
      dropdown.updatePosition(rect);
    }
  }

  insertMentionCommand(item, range) {
    return (editorState, dispatch) => {
      if (!range) {
        return false;
      }
      const icon =
        item.icon ?? item.favicon ?? (item.id ? `page-icon:${item.id}` : "");
      const mentionNode = schema.nodes.mention.create({
        id: item.id,
        label: item.label || item.id || "",
        icon,
        source: item.type || null,
      });
      const afterMention = range.from + mentionNode.nodeSize;
      const tr = editorState.tr.replaceWith(range.from, range.to, mentionNode);
      tr.setSelection(TextSelection.create(tr.doc, afterMention))
        .insertText("\u00A0", afterMention)
        .setSelection(TextSelection.create(tr.doc, afterMention + 1))
        .scrollIntoView();
      if (dispatch) {
        dispatch(tr);
      }
      return true;
    };
  }

  handleEnter({ view, range, text }) {
    const targetView = view || this.getEditorView?.();
    if (!targetView) {
      return;
    }
    this.dispatchMeta(targetView, { isOpen: true, range });
    this.hideSuggestions?.();
    this.updateMentionSuggestions(targetView, text, range);
  }

  handleChange({ view, range, text }) {
    const targetView = view || this.getEditorView?.();
    if (!targetView) {
      return;
    }
    this.dispatchMeta(targetView, { range });
    this.updateMentionSuggestions(targetView, text, range);
  }

  handleExit(view) {
    this.destroyDropdown(view || this.getEditorView?.());
  }

  handleKeyDown(view, event) {
    const targetView = view || this.getEditorView?.();
    if (!targetView) {
      return false;
    }
    const ps = this.key.getState(targetView.state);
    return ps?.dropdown?.handleKeyDown(event) || false;
  }
}

export { MentionDropdownController };
