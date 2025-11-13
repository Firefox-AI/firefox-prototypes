/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Renders the Smartbar suggestion list, manages selection state,
 * and forwards activation callbacks.
 */
class SmartbarSuggestions {
  constructor({
    parentNode,
    getQueryTypeIcon,
    onActionSuggestion,
    onSuggestionActivated,
  }) {
    this._getQueryTypeIcon = getQueryTypeIcon;
    this._onActionSuggestion = onActionSuggestion;
    this._onSuggestionActivated = onSuggestionActivated;
    this._suggestions = [];
    this._selectedIndex = -1;
    this._container = this.#createContainer();
    parentNode.appendChild(this._container);
    this._list = this._container.querySelector(".suggestions-list");
    this._title = this._container.querySelector(".suggestions-title");

    this._container.addEventListener("mouseleave", () => {
      if (this._selectedIndex >= 0) {
        this.select(-1);
      }
    });
  }

  get container() {
    return this._container;
  }

  destroy() {
    this._container?.remove();
    this._container = null;
    this._suggestions = [];
    this._selectedIndex = -1;
  }

  show({
    suggestions,
    title = "Suggestions:",
    isQuickPrompts = false,
    query = "",
  }) {
    if (!this._container) {
      return;
    }
    this._container.classList.remove("hidden");
    this._container.classList.toggle("quick-prompts", !!isQuickPrompts);
    this._container.classList.toggle("user-edited", !isQuickPrompts);

    this._suggestions = suggestions;
    this._selectedIndex = -1;

    if (this._title) {
      this._title.textContent = title;
    }

    this._list.textContent = "";
    suggestions.forEach((suggestion, index) => {
      const button = this.#createSuggestionButton(
        { ...suggestion, query: query.trim() },
        index
      );
      this._list.appendChild(button);
    });
  }

  hide() {
    if (!this._container) {
      return;
    }
    this._container.classList.add("hidden");
    this._container.classList.remove("quick-prompts", "user-edited");
    this._suggestions = [];
    this._selectedIndex = -1;
  }

  isVisible() {
    return !!this._container && !this._container.classList.contains("hidden");
  }

  navigate(direction) {
    if (!this._suggestions.length) {
      return;
    }
    if (direction === "down") {
      this._selectedIndex = Math.min(
        this._selectedIndex + 1,
        this._suggestions.length - 1
      );
    } else if (direction === "up") {
      this._selectedIndex = Math.max(this._selectedIndex - 1, -1);
    }
    this.#updateSelection();
  }

  select(index) {
    this._selectedIndex = index;
    this.#updateSelection();
  }

  getSelected() {
    return this._selectedIndex >= 0
      ? this._suggestions[this._selectedIndex]
      : null;
  }

  hasSuggestions() {
    return !!this._suggestions.length;
  }

  #createContainer() {
    const container = document.createElement("div");
    container.id = "suggestions-container";
    container.className = "suggestions-container hidden";

    const suggestionsHeader = document.createElement("div");
    suggestionsHeader.className = "suggestions-header";
    const suggestionsTitle = document.createElement("span");
    suggestionsTitle.className = "suggestions-title";
    suggestionsTitle.textContent = "Suggestions:";
    suggestionsHeader.appendChild(suggestionsTitle);

    const suggestionsList = document.createElement("div");
    suggestionsList.className = "suggestions-list";
    suggestionsList.id = "suggestions-list";
    suggestionsList.setAttribute("role", "listbox");
    suggestionsList.setAttribute("aria-label", "Suggestions");

    container.appendChild(suggestionsHeader);
    container.appendChild(suggestionsList);
    return container;
  }

  #createSuggestionButton(suggestion, index) {
    const button = document.createElement("button");
    button.className = `suggestion-button suggestion-${suggestion.type}`;
    button.dataset.index = index;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");

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
      icon.textContent = this._getQueryTypeIcon
        ? this._getQueryTypeIcon(suggestion.type)
        : "🔍";
    }

    const textContainer = document.createElement("div");
    textContainer.className = "suggestion-text-container";

    if (suggestion.type === "navigate" && suggestion.title) {
      const title = document.createElement("span");
      title.className = "suggestion-title";
      title.textContent = suggestion.title;

      const url = document.createElement("span");
      url.className = "suggestion-url";
      url.textContent = suggestion.text || suggestion.url;

      if (suggestion.query) {
        this.#highlightQueryMatches(title, suggestion.query);
        this.#highlightQueryMatches(url, suggestion.query);
      }

      textContainer.appendChild(title);
      textContainer.appendChild(url);
    } else {
      const text = document.createElement("span");
      text.className = "suggestion-text";
      text.textContent = suggestion.text;

      if (suggestion.query) {
        this.#highlightQueryMatches(text, suggestion.query);
      }

      textContainer.appendChild(text);
    }

    button.appendChild(icon);
    button.appendChild(textContainer);

    button.addEventListener("mouseenter", () => {
      this.select(index);
    });

    button.addEventListener("click", event => {
      event.preventDefault();
      if (suggestion.type === "action") {
        this._onActionSuggestion?.(suggestion);
      } else {
        this._onSuggestionActivated?.(suggestion);
      }
    });

    return button;
  }

  #updateSelection() {
    const buttons =
      this._container?.querySelectorAll(".suggestion-button") || [];
    buttons.forEach((button, index) => {
      const selected = index === this._selectedIndex;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
  }

  #highlightQueryMatches(container, query) {
    const raw = (query || "").trim();
    if (!raw || !container.textContent) {
      return;
    }
    const source = container.textContent;
    const words = raw
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!words.length) {
      return;
    }
    const regex = new RegExp(words.join("|"), "gi");
    const ranges = [];
    let match;
    while ((match = regex.exec(source))) {
      ranges.push({ from: match.index, to: match.index + match[0].length });
    }
    if (!ranges.length) {
      return;
    }
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const r of ranges) {
      if (cursor < r.from) {
        frag.appendChild(document.createTextNode(source.slice(cursor, r.from)));
      }
      const mark = document.createElement("mark");
      mark.textContent = source.slice(r.from, r.to);
      frag.appendChild(mark);
      cursor = r.to;
    }
    if (cursor < source.length) {
      frag.appendChild(document.createTextNode(source.slice(cursor)));
    }
    container.textContent = "";
    container.appendChild(frag);
  }
}

export { SmartbarSuggestions };
