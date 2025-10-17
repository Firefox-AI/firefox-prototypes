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

// Top US websites for prefix matching navigation suggestions
const TOP_US_WEBSITES = [
  "adobe.com",
  "airbnb.co",
  "airbnb.com",
  "airtable.com",
  "alibaba.com",
  "amazon.com",
  "americanexpress.com",
  "apple.com",
  "att.com",
  "bankofamerica.com",
  "bbc.com",
  "bestbuy.com",
  "bing.com",
  "blogspot.com",
  "booking.com",
  "buzzfeed.com",
  "canva.com",
  "capitalone.com",
  "chase.com",
  "chatgpt.com",
  "chewy.com",
  "cnn.com",
  "coinbase.com",
  "costco.com",
  "craigslist.org",
  "delta.com",
  "discord.com",
  "disneyplus.com",
  "dropbox.com",
  "duckduckgo.com",
  "ebay.com",
  "espn.com",
  "etsy.com",
  "expedia.com",
  "facebook.com",
  "fidelity.com",
  "figma.com",
  "flickr.com",
  "forbes.com",
  "ford.com",
  "fox.com",
  "github.com",
  "glassdoor.com",
  "gmail.com",
  "godaddy.com",
  "google.com",
  "hbomax.com",
  "homedepot.com",
  "hotels.com",
  "hulu.com",
  "ibm.com",
  "ikea.com",
  "imdb.com",
  "indeed.com",
  "instagram.com",
  "intel.com",
  "kayak.com",
  "linkedin.com",
  "lowes.com",
  "lyft.com",
  "macys.com",
  "mailchimp.com",
  "mapquest.com",
  "max.com",
  "medium.com",
  "microsoft.com",
  "microsoft365.com",
  "nbc.com",
  "netflix.com",
  "nike.com",
  "nordstrom.com",
  "notion.so",
  "nvidia.com",
  "nytimes.com",
  "office.com",
  "openai.com",
  "oracle.com",
  "paramount.com",
  "paypal.com",
  "pinterest.com",
  "quora.com",
  "reddit.com",
  "roblox.com",
  "salesforce.com",
  "schwab.com",
  "shopify.com",
  "slack.com",
  "snapchat.com",
  "southwest.com",
  "spotify.com",
  "stackoverflow.com",
  "starbucks.com",
  "target.com",
  "telegram.org",
  "threads.net",
  "tiktok.com",
  "trello.com",
  "tripadvisor.com",
  "tumblr.com",
  "twitch.tv",
  "twitter.com",
  "uber.com",
  "united.com",
  "ups.com",
  "usatoday.com",
  "usps.com",
  "verizon.com",
  "walmart.com",
  "washingtonpost.com",
  "wayfair.com",
  "weather.com",
  "webmd.com",
  "wellsfargo.com",
  "whatsapp.com",
  "wikipedia.org",
  "wsj.com",
  "x.com",
  "yahoo.com",
  "yelp.com",
  "youtube.com",
  "zillow.com",
  "zoom.us",
];

/**
 * Generates live suggestions for a search query by querying the urlbar
 * providers and processing the results.
 *
 * @param {string} query - The search query to generate suggestions for
 * @param {Window} topChromeWindow - The top chrome window reference
 * @returns {Promise<{suggestions: Array<{text: string, type: string}>, autofillData: object|null}>} Object containing suggestions array and autofill data
 */
export async function generateLiveSuggestions(query, topChromeWindow) {
  try {
    const context = new lazy.UrlbarQueryContext({
      searchString: query.trim(),
      allowAutofill: true,
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

    // Check for autofill data in the context
    let autofillData = null;

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

      if (!autofillData && result.autofill) {
        autofillData = result.autofill;
      }

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

    // If no autofill data from urlbar, check TOP_US_WEBSITES for prefix match
    if (!autofillData) {
      const lowerQuery = query.toLowerCase().trim();
      const match = TOP_US_WEBSITES.find(site =>
        site.toLowerCase().startsWith(lowerQuery)
      );

      if (match) {
        autofillData = {
          value: match,
          selectionStart: query.length,
          selectionEnd: match.length,
        };
      }
    }

    return {
      suggestions: suggestions.slice(0, 10),
      autofillData,
    };
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

    return {
      suggestions,
      autofillData: null,
    };
  }
}
