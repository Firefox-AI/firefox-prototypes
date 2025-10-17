/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarController:
    "moz-src:///browser/components/urlbar/UrlbarController.sys.mjs",
  UrlbarProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarQueryContext:
    "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
});

import { detectQueryType } from "./utils.mjs";

/**
 * Generates live suggestions for a search query by querying the urlbar
 * providers and processing the results.
 *
 * @param {string} query - The search query to generate suggestions for
 * @param {Window} topChromeWindow - The top chrome window reference
 * @returns {Promise<Array<{text: string, type: string}>>} Array of suggestion objects
 */
export async function generateLiveSuggestions(query, topChromeWindow) {
  try {
    const context = new lazy.UrlbarQueryContext({
      searchString: query.trim(),
      allowAutofill: false,
      isPrivate: false,
      maxResults: 20,
      sapName: "smart-window",
      userContextId: 0,
    });

    const controller = new lazy.UrlbarController({
      input: {
        isPrivate: false,
        onFirstResult() {},
        window: topChromeWindow,
      },
    });

    // Start the query and wait for results
    await lazy.UrlbarProvidersManager.startQuery(context, controller);

    // Process the results similar to api.ts getUrlbarSuggestions
    const suggestions = [];

    // Convert Firefox urlbar results to our suggestion format
    const urlbarSuggestions = [];
    for (const result of context.results) {
      let suggestion = {
        type: "search", // default
        text: "",
        title: "",
        url: "",
        icon: "",
        description: "",
      };

      // Map Firefox result types to our suggestion types (based on api.ts)
      switch (result.type) {
        case 1: // Tab switch
          suggestion.type = "action";
          suggestion.text = `tab switch: ${result.payload.title || result.payload.url || ""}`;
          suggestion.title = result.payload.title || "";
          suggestion.url = result.payload.url || "";
          suggestion.icon = result.payload.icon || "";
          break;

        case 2: // Search suggestion
          suggestion.type = "search";
          suggestion.text =
            result.payload.suggestion || result.payload.query || query;
          suggestion.title = result.payload.suggestion || "";
          suggestion.description = result.payload.description || "";
          suggestion.icon = result.payload.icon || "";
          break;

        case 3: // URL/bookmark
          suggestion.type = "navigate";
          suggestion.text =
            result.payload.displayUrl || result.payload.url || "";
          suggestion.title = result.payload.title || "";
          suggestion.url = result.payload.url || "";
          suggestion.icon = result.payload.icon || "";
          break;

        default:
          continue; // Skip unknown types
      }

      // Only add non-empty suggestions
      if (suggestion.text.trim()) {
        urlbarSuggestions.push(suggestion);
      }
    }

    // Process suggestions similar to extension's generateLiveSuggestions

    // Get search results from urlbar
    const searchResults = urlbarSuggestions.filter(s => s.type === "search");

    if (searchResults.length) {
      // Process search results through detectQueryType to determine final type
      const resultsToProcess = searchResults.slice(0, 6);
      for (const result of resultsToProcess) {
        const detectedType = await detectQueryType(result.text);
        suggestions.push({
          text: result.text,
          type: detectedType,
        });
      }
    }

    // Add navigate results as-is
    const navigateResults = urlbarSuggestions.filter(
      s => s.type === "navigate"
    );
    const navigateSuggestions = navigateResults.slice(0, 2).map(s => ({
      text: s.text,
      type: s.type,
    }));
    suggestions.push(...navigateSuggestions);

    // Add action results as-is
    const actionResults = urlbarSuggestions.filter(s => s.type === "action");
    const actionSuggestions = actionResults.slice(0, 2).map(s => ({
      text: s.text,
      type: s.type,
    }));
    suggestions.push(...actionSuggestions);

    // If we don't have enough suggestions, add some fallbacks
    if (suggestions.length < 4) {
      const queryType = await detectQueryType(query);

      // Add the query itself if not already present
      if (!suggestions.some(s => s.text === query)) {
        suggestions.push({ text: query, type: queryType });
      }

      // Add some generic suggestions if still short
      if (suggestions.length < 6) {
        const fallbacks = [
          //{ text: "tab next", type: "action" },
          { text: "github.com", type: "navigate" },
          { text: query + " guide", type: "search" },
          { text: query + " tutorial", type: "search" },
        ];

        for (const fallback of fallbacks) {
          if (suggestions.length >= 6) {
            break;
          }
          if (!suggestions.some(s => s.text === fallback.text)) {
            suggestions.push(fallback);
          }
        }
      }
    }

    return suggestions.slice(0, 10);
  } catch (error) {
    console.error("Error getting live suggestions:", error);

    // Fall back to simple suggestions on error
    const suggestions = [];
    const type = await detectQueryType(query);

    suggestions.push(
      { text: query, type },
      { text: "tab next", type: "action" },
      { text: "github.com", type: "navigate" }
    );

    return suggestions;
  }
}
