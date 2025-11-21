/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  Editor,
  StarterKit,
  Link,
  Placeholder,
  Mention,
} from "chrome://browser/content/smartwindow/tiptap-bundle.js";

import {
  MentionDropdown,
  getMentionSuggestions,
} from "chrome://browser/content/smartwindow/mentions.mjs";

// Track autofill state
let autofillState = null;
let deletedQuery = "";
let previousText = "";

export function attachToElement(element, options = {}) {
  const { onKeyDown, onUpdate, onSuggestionSelect, getQueryTypeIcon } = options;

  // Internal state for suggestions
  let currentSuggestions = [];
  let selectedSuggestionIndex = -1;
  let suggestionsContainer = null;
  let isAutofilled = false;

  // Get existing mention IDs from the content
  function getExistingMentionIds(json) {
    const mentionIds = [];
    if (!json?.content) {
      return mentionIds;
    }

    function extractMentionIds(node) {
      if (node?.type === "mention" && node.attrs?.id) {
        mentionIds.push(node.attrs.id);
      }
      if (node?.content) {
        node.content.forEach(extractMentionIds);
      }
    }

    json.content.forEach(extractMentionIds);
    return mentionIds;
  }

  // Check for existing mentions in the content
  function hasExistingMentions(json) {
    return getExistingMentionIds(json)?.length > 0;
  }

  // Handle tab switch behaviour
  function switchToMatchingTab({ url, title, query } = {}, win = window) {
    const searchTerm = (url || title || query || "").toLowerCase();
    if (!searchTerm) {
      return;
    }

    let browserWindow =
      win && win.gBrowser
        ? win
        : Services.wm.getMostRecentWindow("navigator:browser");
    if (!browserWindow || !browserWindow.gBrowser) {
      return;
    }

    const { gBrowser } = browserWindow;
    const tabs = Array.from(gBrowser.tabs);

    const match = tabs.find(tab => {
      const linkedBrowser = tab.linkedBrowser;
      const titleText = (
        linkedBrowser?.contentTitle ||
        tab.label ||
        ""
      ).toLowerCase();
      const urlText = (linkedBrowser?.currentURI?.spec || "").toLowerCase();

      if (url) {
        return urlText.includes(searchTerm);
      }
      if (title) {
        return titleText.includes(searchTerm);
      }
      return titleText.includes(searchTerm) || urlText.includes(searchTerm);
    });

    if (!match) {
      return;
    }

    browserWindow.focus();
    gBrowser.selectedTab = match;
  }

  // Create suggestions container
  function createSuggestionsContainer() {
    suggestionsContainer = document.createElement("div");
    suggestionsContainer.id = "suggestions-container";
    suggestionsContainer.className = "suggestions-container hidden";

    const suggestionsHeader = document.createElement("div");
    suggestionsHeader.className = "suggestions-header";
    suggestionsHeader.innerHTML = `
      <span class="suggestions-title">Suggestions:</span>
    `;

    const suggestionsList = document.createElement("div");
    suggestionsList.className = "suggestions-list";
    suggestionsList.id = "suggestions-list";

    suggestionsContainer.appendChild(suggestionsHeader);
    suggestionsContainer.appendChild(suggestionsList);

    // Add mouseleave handler to clear selection
    suggestionsContainer.addEventListener("mouseleave", () => {
      if (selectedSuggestionIndex >= 0) {
        selectedSuggestionIndex = -1;
        updateSuggestionSelection();
      }
    });

    return suggestionsContainer;
  }

  // Create wrapper for editor and suggestions
  const wrapper = document.createElement("div");
  wrapper.className = "smartbar-wrapper";

  // Move the element's parent and siblings to wrapper
  const parentNode = element.parentNode;
  parentNode.replaceChild(wrapper, element);
  wrapper.appendChild(element);

  // Create and append suggestions container
  const suggestionsEl = createSuggestionsContainer();
  parentNode.appendChild(suggestionsEl);

  const MentionWithIcon = Mention.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        label: {
          default: null,
        },
        icon: {
          default: null,
          parseHTML: el => el.getAttribute("data-icon"),
          renderHTML: attrs => (attrs.icon ? { "data-icon": attrs.icon } : {}),
        },
        source: {
          default: null,
          parseHTML: el => el.getAttribute("data-source"),
          renderHTML: attrs =>
            attrs.source ? { "data-source": attrs.source } : {},
        },
      };
    },

    renderHTML({ node, HTMLAttributes }) {
      const { id, label, icon, source } = node.attrs;
      const iconSrc = icon || (id ? `page-icon:${id}` : "");
      const attrs = {
        ...HTMLAttributes,
        class: `${HTMLAttributes.class ?? ""} mention`.trim(),
        "data-id": id,
        "data-icon": icon || "",
        ...(source ? { "data-source": source } : {}),
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
          { class: "mention-label", title: `${label} (${id})` },
          `${label || id}`,
        ],
      ];
    },

    renderText({ node }) {
      const { id, label } = node.attrs;
      return `${label || id}`;
    },
  });

  let isMentionsOpen = false;
  // Create editor instance
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: false,
      }),
      Placeholder.configure({
        placeholder: "Ask, search, or type a URL",
        showOnlyWhenEditable: false,
      }),
      MentionWithIcon.configure({
        HTMLAttributes: {
          class: "mention",
        },
        suggestion: {
          items: async ({ query }) => {
            const allSuggestions = await getMentionSuggestions(query);
            const existingMentionIds = getExistingMentionIds(editor.getJSON());

            // Filter out already mentioned tabs
            return allSuggestions.filter(
              suggestion => !existingMentionIds.includes(suggestion.id)
            );
          },
          // Replace @-query with mention(id/label/icon) + trailing space so caret exits the chip
          command: ({ range, props }) => {
            const { id, label, favicon, source } = props;
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                {
                  type: "mention",
                  attrs: { id, label, icon: favicon, source },
                },
                { type: "text", text: " " },
              ])
              .run();
          },
          render: () => {
            let dropdown;
            let currentCommand;

            return {
              onStart: props => {
                isMentionsOpen = true;
                hideSuggestions();
                dropdown = new MentionDropdown();
                currentCommand = props.command;
                dropdown.create(props.items, item => {
                  currentCommand({
                    id: item.id,
                    label: item.label,
                    icon: item.icon ?? item.favicon ?? `page-icon:${item.url}`,
                    source: item.type || null,
                  });
                });
                dropdown.updatePosition(props.clientRect());
              },

              onUpdate(props) {
                currentCommand = props.command;
                dropdown?.update(props.items);
                dropdown?.updatePosition(props.clientRect());
              },

              onKeyDown(props) {
                return dropdown?.handleKeyDown(props.event) || false;
              },

              onExit() {
                isMentionsOpen = false;
                dropdown?.destroy();
              },
            };
          },
        },
      }),
    ],
    content: "",
    onUpdate: ({ editor: editorInstance }) => {
      const text = editorInstance.getText();

      // Check if user deleted autofilled content
      if (autofillState) {
        if (
          text !== autofillState.value &&
          text.length < autofillState.value.length
        ) {
          // User deleted autofill
          deletedQuery = autofillState.originalPrefix.toLowerCase().trim();
          autofillState = null;
        } else if (text.length > autofillState.value.length) {
          // User typed beyond autofill
          autofillState = null;
        }
      }

      // Reset deletion memory when typing forward
      if (
        deletedQuery &&
        previousText &&
        text.toLowerCase().startsWith(previousText.toLowerCase()) &&
        text.length > previousText.length
      ) {
        deletedQuery = "";
      }

      previousText = text;

      // Hide suggestions if input is empty or if mentions already exist
      if (
        (!text.trim() &&
          suggestionsContainer &&
          !suggestionsContainer.classList.contains("hidden")) ||
        hasExistingMentions(editorInstance.getJSON())
      ) {
        hideSuggestions();
      }

      // Call external onUpdate
      if (onUpdate) {
        onUpdate({ text, isAutofilled });
      }
    },
    editorProps: {
      handleKeyDown(_view, event) {
        if (isMentionsOpen) {
          return false;
        }
        // Call the external key handler if provided
        if (onKeyDown) {
          onKeyDown(event);
        }

        // Prevent default Tiptap behavior for certain keys
        const keysToPrevent = ["Enter", "ArrowUp", "ArrowDown", "Escape"];

        if (keysToPrevent.includes(event.key)) {
          // For Enter, only prevent if Shift is not pressed (allow Shift+Enter for newlines)
          if (event.key === "Enter" && event.shiftKey) {
            return false; // Let Tiptap handle Shift+Enter for new lines
          }
          // Prevent Tiptap's default handling
          return true;
        }

        return false;
      },
    },
  });

  // Add click event listener for mention expansion toggle
  element.addEventListener("click", event => {
    const mentionElement = event.target.closest(".mention");
    if (mentionElement) {
      event.preventDefault();
      event.stopPropagation();
      mentionElement.classList.toggle("expanded");
    }
  });

  function highlightQueryMatches(element, query) {
    if (!query || !element.textContent) {
      return;
    }

    const text = element.textContent;
    // Split query into words and escape special chars
    const words = query
      .split(/\s+/)
      .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    if (words.length === 0) {
      return;
    }

    // Highlight matched words
    const regex = new RegExp(`(${words.join("|")})`, "gi");

    // Split and rebuild nodes
    element.textContent = "";
    for (const part of text.split(regex)) {
      const node = regex.test(part)
        ? Object.assign(document.createElement("mark"), { textContent: part })
        : document.createTextNode(part);
      element.appendChild(node);
    }
  }

  // Suggestion management functions
  function createSuggestionButton(suggestion, index) {
    const button = document.createElement("button");
    button.className = `suggestion-button suggestion-${suggestion.type}`;
    button.dataset.index = index;

    const icon = document.createElement("span");
    icon.className = "suggestion-icon";
    const useProvidedIcon =
      suggestion.type !== "action" && suggestion.type !== "search";

    if (useProvidedIcon && suggestion.icon) {
      const imgElement = document.createElement("img");
      imgElement.src = suggestion.icon;
      imgElement.alt = "";
      icon.appendChild(imgElement);
    } else {
      icon.textContent = getQueryTypeIcon
        ? getQueryTypeIcon(suggestion.type)
        : "🔍";
    }

    const textContainer = document.createElement("div");
    textContainer.className = "suggestion-text-container";

    // For matches of type navigate: Show title and URL
    if (suggestion.type === "navigate" && suggestion.title) {
      const title = document.createElement("span");
      title.className = "suggestion-title";
      title.textContent = suggestion.title;

      const url = document.createElement("span");
      url.className = "suggestion-url";
      url.textContent = suggestion.text || suggestion.url;

      // Highlight matches if query is provided
      if (suggestion.query) {
        highlightQueryMatches(title, suggestion.query);
        highlightQueryMatches(url, suggestion.query);
      }

      textContainer.appendChild(title);
      textContainer.appendChild(url);
    } else {
      // For other suggestion types: Use the original text
      const text = document.createElement("span");
      text.className = "suggestion-text";
      text.textContent = suggestion.text;

      // Highlight matches if query is provided
      if (suggestion.query) {
        highlightQueryMatches(text, suggestion.query);
      }

      textContainer.appendChild(text);
    }

    button.appendChild(icon);
    button.appendChild(textContainer);

    // Add event listeners
    button.addEventListener("mouseenter", () => {
      selectSuggestion(index);
    });

    button.addEventListener("click", e => {
      e.preventDefault();
      // If this is a "tab switch" row, activate the tab instead
      if (suggestion.type === "action") {
        switchToMatchingTab(
          {
            url: suggestion.url,
            title: suggestion.title,
            query: suggestion.query || suggestion.text,
          },
          window
        );
        return;
      }

      // default behavior for all other suggestion types
      editor.commands.setContent(suggestion.text);
      if (onSuggestionSelect) {
        onSuggestionSelect(suggestion);
      }
    });

    return button;
  }

  function selectSuggestion(index) {
    selectedSuggestionIndex = index;
    updateSuggestionSelection();
  }

  function updateSuggestionSelection() {
    const suggestionButtons =
      suggestionsContainer.querySelectorAll(".suggestion-button");
    suggestionButtons.forEach((button, index) => {
      button.classList.toggle("selected", index === selectedSuggestionIndex);
    });
  }

  function showSuggestions(
    suggestions,
    title = "Suggestions:",
    isQuickPrompts = false,
    query = ""
  ) {
    if (!suggestionsContainer) {
      return;
    }

    // Don’t show suggestions if the input is empty
    if (!editor.getText().trim() || isMentionsOpen) {
      return;
    }

    // Don’t show suggestions if there are existing mentions
    const json = editor.getJSON();
    if (hasExistingMentions(json)) {
      return;
    }

    suggestionsContainer.classList.remove("hidden");

    if (isQuickPrompts) {
      suggestionsContainer.classList.add("quick-prompts");
      suggestionsContainer.classList.remove("user-edited");
    } else {
      suggestionsContainer.classList.remove("quick-prompts");
      suggestionsContainer.classList.add("user-edited");
    }

    currentSuggestions = suggestions;
    selectedSuggestionIndex = -1;

    // Update header
    const header = suggestionsContainer.querySelector(".suggestions-title");
    if (header) {
      header.textContent = title;
    }

    // Clear and populate suggestions list
    const suggestionsList =
      suggestionsContainer.querySelector(".suggestions-list");
    suggestionsList.innerHTML = "";

    suggestions.forEach((suggestion, index) => {
      const suggestionWithQuery = { ...suggestion, query: query.trim() };
      const suggestionButton = createSuggestionButton(
        suggestionWithQuery,
        index
      );
      suggestionsList.appendChild(suggestionButton);
    });
  }

  function hideSuggestions() {
    if (!suggestionsContainer) {
      return;
    }

    suggestionsContainer.classList.add("hidden");
    suggestionsContainer.classList.remove("quick-prompts", "user-edited");
    currentSuggestions = [];
    selectedSuggestionIndex = -1;
  }

  function navigateSuggestions(direction) {
    if (!currentSuggestions.length) {
      return;
    }

    if (direction === "down") {
      selectedSuggestionIndex = Math.min(
        selectedSuggestionIndex + 1,
        currentSuggestions.length - 1
      );
    } else if (direction === "up") {
      selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
    }

    updateSuggestionSelection();
  }

  function getSelectedSuggestion() {
    return selectedSuggestionIndex >= 0
      ? currentSuggestions[selectedSuggestionIndex]
      : null;
  }

  function hasSuggestions() {
    return !!currentSuggestions.length;
  }

  // Return an object with the editor and helper functions
  return {
    editor,

    // Helper functions
    focus() {
      editor.commands.focus("end");
    },

    setAutofill(autofillData) {
      if (!autofillData || !autofillData.value) {
        return;
      }

      // Get current text to check if user has typed more since autofill was requested
      const currentText = editor.getText();

      // Block if query matches or is subset of deleted query
      if (
        deletedQuery &&
        (currentText.toLowerCase().trim() === deletedQuery ||
          deletedQuery.startsWith(currentText.toLowerCase().trim()))
      ) {
        return;
      }

      // Extract the expected prefix (what user had typed when autofill was requested)
      const expectedPrefix = autofillData.value.substring(
        0,
        autofillData.selectionStart
      );

      // Only apply autofill if current query is still the expected prefix
      if (currentText != expectedPrefix) {
        return;
      }

      autofillState = {
        value: autofillData.value.trim(),
        originalPrefix: currentText,
      };

      // Mark that the text update was initiated by autofill
      isAutofilled = true;
      // Set the autofilled text
      editor.commands.setContent(autofillData.value);

      // Select the autofilled portion (from selectionStart to selectionEnd)
      // Tiptap uses 1-based position counting, and we need to account for the paragraph wrapper
      const from = autofillData.selectionStart + 1; // +1 for paragraph node
      const to = autofillData.selectionEnd + 1; // +1 for paragraph node

      editor.commands.setTextSelection({ from, to });

      // Reset after setting the autofilled text
      isAutofilled = false;
    },

    getText() {
      // Get the JSON representation to access mention data
      const json = editor.getJSON();

      // Helper function to extract text with mention IDs instead of labels
      function extractTextWithMentionIds(node) {
        if (node.type === "text") {
          return node.text || "";
        }
        if (node.type === "mention") {
          const label = node.attrs.label || "";
          const url = node.attrs.id || "";
          // Send both title and URL to LLM
          return `@${label} (${url})`;
        }
        if (node.type === "paragraph" || node.type === "doc") {
          // Handle paragraphs and document nodes
          if (node.content) {
            return node.content.map(extractTextWithMentionIds).join("");
          }
        }
        if (node.content) {
          return node.content.map(extractTextWithMentionIds).join("");
        }
        return "";
      }

      // Extract text from all content nodes
      if (json.content) {
        const extractedText = json.content
          .map(extractTextWithMentionIds)
          .join("");
        console.warn("[SmartBar] getText() extracted:", extractedText);
        return extractedText;
      }

      // Fallback to default getText if JSON parsing fails
      const fallbackText = editor.getText();
      console.warn("[SmartBar] getText() fallback:", fallbackText);
      return fallbackText;
    },

    getHTML() {
      return editor.getHTML();
    },

    getMentions() {
      const mentions = [];
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
      const json = editor.getJSON();
      if (Array.isArray(json?.content)) {
        json.content.forEach(collectMentions);
      }
      return mentions;
    },

    setContent(content) {
      editor.commands.setContent(content);
    },

    clear() {
      autofillState = null;
      deletedQuery = "";
      previousText = "";

      editor.commands.setContent("");
      // Hide suggestions when clearing
      hideSuggestions();
      // Refocus after clearing
      editor.commands.focus("end");
    },

    setEditable(editable) {
      editor.setEditable(editable);
    },

    destroy() {
      editor.destroy();
      if (suggestionsContainer) {
        suggestionsContainer.remove();
      }
    },

    hasExistingMentions() {
      return hasExistingMentions(editor.getJSON());
    },

    switchToMatchingTab,
    showSuggestions,
    hideSuggestions,
    navigateSuggestions,
    getSelectedSuggestion,
    hasSuggestions,
  };
}
