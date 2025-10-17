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

export function attachToElement(element, options = {}) {
  const { onKeyDown, onUpdate, onSuggestionSelect, getQueryTypeIcon } = options;

  // Internal state for suggestions
  let currentSuggestions = [];
  let selectedSuggestionIndex = -1;
  let suggestionsContainer = null;

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
        icon: {
          default: null,
          parseHTML: el => el.getAttribute("data-icon"),
          renderHTML: attrs => (attrs.icon ? { "data-icon": attrs.icon } : {}),
        },
      };
    },

    renderHTML({ node, HTMLAttributes }) {
      const attrs = {
        ...HTMLAttributes,
        class: `${HTMLAttributes.class ?? ""} mention`.trim(),
        "data-id": node.attrs.id,
        "data-icon": node.attrs.icon || "",
      };
      return [
        "span",
        attrs,
        ["img", { src: node.attrs.icon || "", alt: "", class: "mention-icon", width: "16", height: "16" }],
        ["span", { class: "mention-label", title: node.attrs.label }, `@${node.attrs.label}`],
      ];
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
        placeholder: "Ask, search, or type a URL...",
        showOnlyWhenEditable: false,
      }),
      MentionWithIcon.configure({
        HTMLAttributes: {
          class: "mention",
        },
        suggestion: {
          items: async ({ query }) => {
            return await getMentionSuggestions(query);
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
                  currentCommand({ id: item.id, label: item.label, icon: item.icon ?? item.favicon ?? `page-icon:${item.url}` });
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
      // Hide suggestions if input is empty
      if (
        !text.trim() &&
        suggestionsContainer &&
        !suggestionsContainer.classList.contains("hidden")
      ) {
        hideSuggestions();
      }
      if (onUpdate) {
        onUpdate(text);
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

  // Suggestion management functions
  function createSuggestionButton(suggestion, index) {
    const button = document.createElement("button");
    button.className = `suggestion-button suggestion-${suggestion.type}`;
    button.dataset.index = index;

    const icon = document.createElement("span");
    icon.className = "suggestion-icon";
    icon.textContent = getQueryTypeIcon
      ? getQueryTypeIcon(suggestion.type)
      : "🔍";

    const text = document.createElement("span");
    text.className = "suggestion-text";
    text.textContent = suggestion.text;

    button.appendChild(icon);
    button.appendChild(text);

    // Add event listeners
    button.addEventListener("mouseenter", () => {
      selectSuggestion(index);
    });

    button.addEventListener("click", e => {
      e.preventDefault();
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
    isQuickPrompts = false
  ) {
    if (!suggestionsContainer) {
      return;
    }

    // Don't show suggestions if the input is empty
    if (!editor.getText().trim() || isMentionsOpen) {
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
      const suggestionButton = createSuggestionButton(suggestion, index);
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

    getText() {
      // Get the JSON representation to access mention data
      const json = editor.getJSON();
      
      // Helper function to extract text with mention IDs instead of labels
      function extractTextWithMentionIds(node) {
        if (node.type === 'text') {
          return node.text || '';
        }
        if (node.type === 'mention') {
          // Use the ID (URL) instead of the label (title) for mentions
          return `@${node.attrs.id}`;
        }
        if (node.type === 'paragraph' || node.type === 'doc') {
          // Handle paragraphs and document nodes
          if (node.content) {
            return node.content.map(extractTextWithMentionIds).join('');
          }
        }
        if (node.content) {
          return node.content.map(extractTextWithMentionIds).join('');
        }
        return '';
      }
      
      // Extract text from all content nodes
      if (json.content) {
        const extractedText = json.content.map(extractTextWithMentionIds).join('');
        console.warn('[SmartBar] getText() extracted:', extractedText);
        return extractedText;
      }
      
      // Fallback to default getText if JSON parsing fails
      const fallbackText = editor.getText();
      console.warn('[SmartBar] getText() fallback:', fallbackText);
      return fallbackText;
    },

    setContent(content) {
      editor.commands.setContent(content);
    },

    clear() {
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

    showSuggestions,
    hideSuggestions,
    navigateSuggestions,
    getSelectedSuggestion,
    hasSuggestions,
  };
}
