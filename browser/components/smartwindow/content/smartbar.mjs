import {
  Editor,
  StarterKit,
  Link,
  Placeholder,
} from "chrome://browser/content/smartwindow/tiptap-bundle.js";

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
      }),
    ],
    content: "",
    onUpdate: ({ editor: editorInstance }) => {
      const text = editorInstance.getText();
      // Hide suggestions if input is empty
      if (!text.trim() && suggestionsContainer && !suggestionsContainer.classList.contains("hidden")) {
        hideSuggestions();
      }
      if (onUpdate) {
        onUpdate(text);
      }
    },
    editorProps: {
      handleKeyDown(view, event) {
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
      return editor.getText();
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

    // Suggestions API
    showSuggestions,
    hideSuggestions,
    navigateSuggestions,
    getSelectedSuggestion,
    hasSuggestions,
  };
}
