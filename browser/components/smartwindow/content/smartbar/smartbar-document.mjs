/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  DOMSerializer,
  Decoration,
  DecorationSet,
  Plugin as PMPlugin,
  Schema,
  basicSchema,
} from "chrome://browser/content/smartwindow/prosemirror.bundle.js";

const PLACEHOLDER_TEXT = "Ask, search, or type a URL";

// matches http(s) URLs
const URL_REGEX = /^https?:\/\/[^\s]+$/i;

function resolveMentionIcon({ id, icon }) {
  if (!icon) {
    return id ? `page-icon:${id}` : "";
  }
  if (icon.startsWith("data:")) {
    return id ? `page-icon:${id}` : "";
  }
  return icon;
}

const mentionNodeSpec = {
  attrs: {
    id: { default: "" },
    label: { default: "" },
    icon: { default: "" },
    source: { default: null },
  },
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  parseDOM: [
    {
      tag: "span[data-mention-id]",
      getAttrs(dom) {
        const element = dom;
        return {
          id: element.getAttribute("data-mention-id") || "",
          label: element.getAttribute("data-mention-label") || "",
          icon: element.getAttribute("data-icon") || "",
          source: element.getAttribute("data-source") || null,
        };
      },
    },
  ],
  toDOM(node) {
    const { id, label, icon, source } = node.attrs;
    const finalLabel = label || id;
    const iconSrc = resolveMentionIcon({ id, icon });
    const attrs = {
      class: "mention",
      "data-mention-id": id,
      "data-mention-label": label || "",
      "data-mention-suggestion-char": "@",
      ...(source ? { "data-source": source } : {}),
      contenteditable: "false",
      "aria-label": id ? `${finalLabel} (${id})` : finalLabel,
    };
    return [
      "span",
      attrs,
      [
        "img",
        {
          src: iconSrc,
          alt: "",
          class: "mention-icon",
          width: "16",
          height: "16",
        },
      ],
      [
        "span",
        { class: "mention-label", title: `${finalLabel} (${id})` },
        finalLabel,
      ],
    ];
  },
};

const schema = new Schema({
  nodes: basicSchema.spec.nodes.append({ mention: mentionNodeSpec }),
  marks: basicSchema.spec.marks,
});

const serializer = DOMSerializer.fromSchema(schema);

/**
 * Returns a ProseMirror plugin that overlays placeholder text when the doc is empty.
 *
 * @param {string} [placeholder]
 * @param {typeof PMPlugin} [pluginClass]
 * @returns {PMPlugin}
 */
function createPlaceholderPlugin(
  placeholder = PLACEHOLDER_TEXT,
  pluginClass = PMPlugin
) {
  return new pluginClass({
    props: {
      decorations(state) {
        const firstChild = state.doc.firstChild;
        const isEmptyParagraph =
          state.doc.childCount === 1 &&
          firstChild?.type.name === "paragraph" &&
          firstChild.content.size === 0;

        if (!isEmptyParagraph) {
          return null;
        }

        return DecorationSet.create(state.doc, [
          Decoration.node(0, firstChild.nodeSize, {
            class: "is-editor-empty",
            "data-placeholder": placeholder,
          }),
        ]);
      },
    },
  });
}

/**
 * Returns a ProseMirror plugin that converts pasted URLs to mention pills.
 *
 * @param {Function} insertMentionCommand - Command function from MentionDropdownController that inserts a mention.
 * @param {typeof PMPlugin} [pluginClass]
 * @returns {PMPlugin}
 */
function createPasteToPillPlugin(insertMentionCommand, pluginClass = PMPlugin) {
  return new pluginClass({
    props: {
      handlePaste(view, _event, slice) {
        // Don’t intercept paste during composition
        if (view.composing) {
          return false;
        }

        // Extract text from the pasted content
        const pastedText = slice.content.textBetween(
          0,
          slice.content.size,
          "\n"
        );
        const trimmed = pastedText.trim();

        // Check URL
        if (!URL_REGEX.test(trimmed)) {
          return false; // Let default paste behavior handle it
        }

        // Create a mention pill covering the current selection
        const { from, to } = view.state.selection;
        const cmd = insertMentionCommand({
          id: trimmed,
          label: trimmed,
          icon: "",
          type: "paste",
        }, { from, to });

        // Execute the command with closeHistory to isolate as single undo step
        cmd(view.state, tr => {
          view.dispatch(tr.setMeta("closeHistory", true));
        });

        return true; // prevents default paste
      },
    },
  });
}

/**
 * Serializes the document node to an HTML string.
 *
 * @param {ProseMirrorNode} doc
 * @returns {string}
 */
function docToHTML(doc) {
  const fragment = serializer.serializeFragment(doc.content);
  const div = document.createElement("div");
  div.appendChild(fragment);
  return div.innerHTML;
}

/**
 * Builds a doc node from newline-delimited text.
 *
 * @param {string} text
 * @returns {ProseMirrorNode}
 */
function createDocFromText(text) {
  const paragraphs = text
    .split(/\n/)
    .map(line =>
      schema.nodes.paragraph.create(null, line ? schema.text(line) : null)
    );

  return schema.node(
    "doc",
    null,
    paragraphs.length ? paragraphs : [schema.nodes.paragraph.create()]
  );
}

/**
 * Computes the bounding rect for the mention trigger range.
 *
 * @param {EditorView} view
 * @param {{from:number,to:number}} range
 * @returns {{left:number,right:number,top:number,bottom:number,width:number,height:number}|null}
 */
function getMentionClientRect(view, range) {
  if (!range) {
    return null;
  }

  const start = view.coordsAtPos(range.from);
  const end = view.coordsAtPos(range.to);

  return {
    left: start.left,
    right: start.left,
    top: start.bottom,
    bottom: start.bottom,
    width: Math.max(end.left - start.left, 1),
    height: start.bottom - start.top,
  };
}

/**
 * Produces multiple textual versions of the doc: plain, query (ids), and labeled query.
 *
 * @param {object} json - ProseMirror JSON representation of the doc.
 * @returns {{plainText: string, queryText: string, labeledQueryText: string}}
 */
function buildExtractedTexts(json) {
  const plainParts = [];
  const queryParts = [];
  const labeledQueryParts = [];

  function walk(node) {
    if (!node) {
      return;
    }
    if (node.type === "text") {
      const t = node.text || "";
      plainParts.push(t);
      queryParts.push(t);
      labeledQueryParts.push(t);
      return;
    }
    if (node.type === "hard_break") {
      plainParts.push("\n");
      queryParts.push("\n");
      labeledQueryParts.push("\n");
      return;
    }
    if (node.type === "mention") {
      const label = node.attrs?.label || node.attrs?.id || "";
      const id = node.attrs?.id || "";
      plainParts.push(label);
      queryParts.push(id);
      labeledQueryParts.push(`@${label} (${id})`);
      return;
    }
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
    }
  }

  if (Array.isArray(json?.content)) {
    json.content.forEach(walk);
  }

  return {
    plainText: plainParts.join("").replace(/\u00A0/g, " "),
    queryText: queryParts.join("").replace(/\u00A0/g, " "),
    labeledQueryText: labeledQueryParts.join("").replace(/\u00A0/g, " "),
  };
}

/**
 * Collects mention IDs present in the document.
 *
 * @param {object} json - ProseMirror JSON document.
 * @returns {Set<string>}
 */
function getExistingMentionIds(json) {
  const mentionIds = new Set();
  if (!json?.content) {
    return mentionIds;
  }

  function extractMentionIds(node) {
    if (node?.type === "mention" && node.attrs?.id) {
      mentionIds.add(node.attrs.id);
    }
    if (node?.content) {
      node.content.forEach(extractMentionIds);
    }
  }

  json.content.forEach(extractMentionIds);
  return mentionIds;
}

/**
 * Indicates whether the doc already contains mention nodes.
 *
 * @param {object} json - ProseMirror JSON document.
 * @returns {boolean}
 */
function hasExistingMentions(json) {
  return getExistingMentionIds(json).size > 0;
}

export {
  PLACEHOLDER_TEXT,
  buildExtractedTexts,
  createDocFromText,
  createPasteToPillPlugin,
  createPlaceholderPlugin,
  docToHTML,
  getExistingMentionIds,
  getMentionClientRect,
  hasExistingMentions,
  schema,
};
