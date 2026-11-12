/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * Toolbar of actions for the http(s) page shown in a Smart Window.
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const TOOLBAR_ID = "smart-actions-toolbar";

/**
 * @typedef {object} Suggestion
 * @property {string} type - Key of ACTION_TYPES.
 * @property {string} label - Button text.
 * @property {string} [detail] - Extra input for types that need more than
 *   the label, like a monitor condition.
 */

/**
 * @typedef {object} ToolbarAction
 * @property {string} label - Button text.
 * @property {string} iconSrc - Icon shown before the label.
 * @property {() => Promise<void>} run - Called on click. The button stays
 *   disabled until it settles.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  AIWindowUI:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindowUI.sys.mjs",
  AgentPageCategory:
    "moz-src:///browser/components/aiwindow/ui/modules/AgentPageDetector.sys.mjs",
  AgentPageDetector:
    "moz-src:///browser/components/aiwindow/ui/modules/AgentPageDetector.sys.mjs",
  AuthProvider:
    "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  Region: "resource://gre/modules/Region.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  buildConversation:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  generateConversationStartersSidebar:
    "moz-src:///browser/components/aiwindow/models/ConversationSuggestions.sys.mjs",
  makeJSONSchemaBlob:
    "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  MODEL_FEATURES: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  MonitorPanel:
    "moz-src:///browser/components/aiwindow/ui/modules/MonitorPanel.sys.mjs",
  parseAndExtractJSON:
    "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  renderPrompt: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  sanitizeUntrustedContent:
    "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs",
  StructuredMetadataReader:
    "moz-src:///toolkit/components/pageextractor/StructuredMetadataReader.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "clipboard",
  "@mozilla.org/widget/clipboardhelper;1",
  Ci.nsIClipboardHelper
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "actionCount",
  "browser.smartwindow.actionsToolbar.actionCount"
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "enabled",
  "browser.smartwindow.actionsToolbar.enabled",
  undefined,
  () => SmartActionsToolbar.updateAll()
);
// Template for the selected chat model, which answers with JSON actions that
// each have a type, a label and an optional detail. Empty uses the sidebar
// conversation starters instead.
// TODO: Bug 2093449 - review the page content the default prompt includes
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "prompt",
  "browser.smartwindow.actionsToolbar.prompt",
  undefined,
  () => {
    loadedKeys = new WeakMap();
    SmartActionsToolbar.updateAll();
  }
);

/** @type {WeakMap<ChromeWindow, object>} */
const windowStates = new WeakMap();

// TODO: Bug 2092109 - proper cache including titles to reuse actions
/**
 * Context key each window last loaded actions for.
 *
 * @type {WeakMap<ChromeWindow, ?string>}
 */
let loadedKeys = new WeakMap();

/**
 * Builds the toolbar action for each type of suggestion. Types that can run
 * their label ignore the detail, so a generated detail can't make a button do
 * something other than what it says.
 *
 * @type {Record<
 *   string,
 *   (win: ChromeWindow, label: string, detail: string) => ToolbarAction
 * >}
 */
const ACTION_TYPES = {
  chat: (win, label) => chatAction(win, label),
  jump: jumpAction,
  search: (win, label) => searchAction(win, label),
};

/**
 * @param {ChromeWindow} win
 * @param {string} label - Button text, and the message sent unless prompt is
 *   given.
 * @param {MozTabbrowserTab[]} [otherTabs] - Also mentioned in the message.
 * @param {string} [prompt] - Message sent instead of the label.
 * @returns {ToolbarAction} Starts a sidebar chat about this page.
 */
function chatAction(win, label, otherTabs = [], prompt = label) {
  const url = win.gBrowser.currentURI.spec;
  return {
    label,
    iconSrc: "chrome://browser/content/aiwindow/assets/ask-icon.svg",
    run: () =>
      lazy.AIWindowUI.submitToNewSidebarChat(win, {
        text: prompt,
        submitType: "toolbar",
        contextMentions: [
          { type: "currentTab", url, label: win.gBrowser.selectedTab.label },
          ...otherTabs.map(tab => ({
            type: "tab",
            url: tab.linkedBrowser.currentURI.spec,
            label: tab.label,
          })),
        ],
        contextPageUrl: URL.parse(url),
      }),
  };
}

/**
 * @param {ChromeWindow} win
 * @param {string} label - Button text.
 * @param {string} text - The #id of a section the page links to, or text on
 *   the page to scroll to and highlight.
 * @returns {ToolbarAction} Scrolls to that part of the page.
 */
function jumpAction(win, label, text) {
  const fragment = text.startsWith("#")
    ? text
    : `#:~:text=${encodeURIComponent(text.replace(/\s+/g, " ")).replace(/-/g, "%2D")}`;
  return {
    label,
    iconSrc: "chrome://global/skin/icons/arrow-down.svg",
    run: () => {
      const browser = win.gBrowser.selectedBrowser;
      browser.loadURI(
        Services.io.newURI(win.gBrowser.currentURI.specIgnoringRef + fragment),
        { triggeringPrincipal: browser.contentPrincipal }
      );
    },
  };
}

/**
 * @param {ChromeWindow} win
 * @param {string} label - Button text, and the search terms unless query is
 *   given.
 * @param {string} [query] - Search terms used instead of the label.
 * @returns {ToolbarAction} Searches with the default engine.
 */
function searchAction(win, label, query = label) {
  return {
    label,
    iconSrc: "chrome://global/skin/icons/search-glass.svg",
    // TODO: Bug 2092650 - proper search access point instead of the assistant
    run: () => lazy.AIWindow.performSearch(query, win),
  };
}

/**
 * Readers for the placeholders a prompt can use, run in this order. Only the
 * ones the prompt uses are read. {page_text|10000} keeps that many characters,
 * {page_anchors|10} that many #ids the page links to on itself and
 * {open_tabs|5} that many tabs. A {#key}...{/key} section is dropped when that
 * value is empty. Page text goes first since it waits for the page to load, so
 * the title read after it is the loaded one.
 *
 * @type {Record<
 *   string,
 *   (
 *     win: ChromeWindow,
 *     limit: number | undefined,
 *     readPage: (sufficientLength?: number) => Promise<?object>
 *   ) => string | number | Promise<string>
 * >}
 */
const PROMPT_VALUES = {
  page_text: async (win, limit, readPage) =>
    (await readPage(limit))?.text.slice(0, limit) ?? "",
  page_anchors: async (win, limit, readPage) => {
    const page = win.gBrowser.currentURI.specIgnoringRef;
    const anchors = new Set();
    for (const href of (await readPage())?.links ?? []) {
      const url = URL.parse(href);
      if (url?.hash.length > 1 && url.href.slice(0, -url.hash.length) == page) {
        anchors.add(url.hash);
      }
    }
    return [...anchors].slice(0, limit).join("\n");
  },
  title: win => lazy.sanitizeUntrustedContent(win.gBrowser.selectedTab.label),
  url: win => win.gBrowser.currentURI.specIgnoringRef,
  open_tabs: (win, limit) =>
    win.gBrowser.tabs
      .filter(tab => {
        const uri = tab.linkedBrowser.currentURI;
        return !tab.selected && (uri.schemeIs("http") || uri.schemeIs("https"));
      })
      .sort((a, b) => b.lastAccessed - a.lastAccessed)
      .slice(0, limit)
      .map(tab => `- ${lazy.sanitizeUntrustedContent(tab.label)}`)
      .join("\n"),
  n: () => lazy.actionCount,
  locale: () => Services.locale.appLocaleAsBCP47,
  date: () => new Date().toISOString().slice(0, 10),
};

/**
 * @param {ChromeWindow} win
 * @returns {boolean} Whether the toolbar can show in this window, so whether
 *   it needs to follow navigation. Consent is checked per page instead, since
 *   granting it doesn't call update.
 */
function isActive(win) {
  return (
    lazy.enabled &&
    lazy.AIWindow.isAIWindowEnabled() &&
    lazy.AIWindow.isAIWindowActive(win)
  );
}

/**
 * @param {ChromeWindow} win
 * @returns {?string} What the actions depend on, or null when the page can't
 *   have any. Fragment changes keep the same actions.
 */
function contextKey(win) {
  const uri = win.gBrowser.currentURI;
  if (
    !lazy.AIWindow.isEnabled ||
    (!uri.schemeIs("http") && !uri.schemeIs("https"))
  ) {
    return null;
  }
  return uri.specIgnoringRef;
}

/**
 * @param {ChromeWindow} win
 * @param {AbortSignal} signal
 * @returns {Promise<Suggestion[]>}
 */
async function generateFromPrompt(win, signal) {
  // Limit of each placeholder the prompt uses, if it has one.
  const used = new Map();
  const template = lazy.prompt.replace(
    /\{(#?)(\w+)(?:\|(\d+))?\}/g,
    (_match, section, key, limit) => {
      used.set(key, limit ? Number(limit) : used.get(key));
      return `{${section}${key}}`;
    }
  );
  let extraction;
  const readPage = sufficientLength =>
    (extraction ??=
      win.gBrowser.selectedBrowser.browsingContext.currentWindowGlobal
        ?.getActor("PageExtractor")
        .getText({
          sufficientLength,
          cleanWhitespace: true,
          removeBoilerplate: true,
          useSimpleText: true,
        }));
  const values = {};
  for (const [key, read] of Object.entries(PROMPT_VALUES)) {
    if (used.has(key)) {
      values[key] = await read(win, used.get(key), readPage);
    }
  }
  signal.throwIfAborted();
  // TODO: Bug 2092649 - proper prompt feature instead of pref and chat model
  const conversation = await lazy.buildConversation(lazy.MODEL_FEATURES.CHAT);
  conversation.addUserMessage(lazy.renderPrompt(template, values));
  const result = await conversation.run({
    token: await lazy.AuthProvider.getToken(),
    signal,
    inferenceParams: {
      response_format: lazy.makeJSONSchemaBlob("SmartActions", {
        type: "object",
        properties: {
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: Object.keys(ACTION_TYPES) },
                label: { type: "string" },
                detail: { type: "string" },
              },
              required: ["type", "label"],
            },
          },
        },
        required: ["actions"],
      }),
    },
  });
  const actions = lazy.parseAndExtractJSON(result, {})?.actions;
  return Array.isArray(actions)
    ? actions.filter(
        action =>
          Object.hasOwn(ACTION_TYPES, action?.type) &&
          typeof action.label == "string" &&
          action.label.trim()
      )
    : [];
}

/**
 * @param {ChromeWindow} win
 * @param {AbortSignal} signal
 * @returns {Promise<ToolbarAction[]>}
 */
async function suggestActions(win, signal) {
  const suggestions = lazy.prompt
    ? await generateFromPrompt(win, signal)
    : (
        await lazy.generateConversationStartersSidebar(
          [
            {
              title: win.gBrowser.selectedTab.label,
              url: win.gBrowser.currentURI.spec,
            },
          ],
          lazy.actionCount,
          false,
          null,
          signal
        )
      ).map(({ text, type }) => ({ type, label: text }));
  // Built after generating, so the page title has had time to load.
  return suggestions
    .slice(0, lazy.actionCount)
    .map(({ type, label, detail }) =>
      ACTION_TYPES[type](win, label, detail?.trim?.() || label)
    );
}

/**
 * @param {ChromeWindow} win
 * @returns {string} The most title-like part of the page title, without the
 *   site name, or empty while the page has no title yet.
 */
function shortTitle(win) {
  const tab = win.gBrowser.selectedTab;
  if (!tab.labelIsContentTitle) {
    return "";
  }
  const longest = tab.label
    .split(/\s[|\u2013\u2014\u00b7-]\s|:\s/)
    .reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), "");
  return longest.split(/\s+/).slice(0, 8).join(" ");
}

/**
 * @param {nsIURI} uri
 * @returns {boolean}
 */
function isProductPage(uri) {
  return (
    (uri.schemeIs("http") || uri.schemeIs("https")) &&
    lazy.AgentPageDetector.getPageInfo(uri)?.category ==
      lazy.AgentPageCategory.PRODUCT_DETAIL
  );
}

/**
 * Actions from what the browser knows about this tab, most specific first.
 *
 * @param {ChromeWindow} win
 * @returns {ToolbarAction[]}
 */
function browserActions(win) {
  const browser = win.gBrowser.selectedBrowser;
  const uri = win.gBrowser.currentURI;
  const otherTabs = win.gBrowser.tabs.filter(tab => !tab.selected);
  const actions = [];

  const history = browser.browsingContext?.sessionHistory;
  for (let index = (history?.index ?? 0) - 1; index >= 0; index--) {
    let search = null;
    try {
      search = lazy.SearchService.parseSubmissionURL(
        history.getEntryAtIndex(index).URI.spec
      );
    } catch (error) {}
    if (search?.engine && search.terms) {
      actions.push({
        label: `Back to \u201c${search.terms}\u201d`,
        iconSrc: "chrome://browser/skin/back.svg",
        run: () => browser.gotoIndex(index),
      });
      break;
    }
  }

  const duplicate = otherTabs.find(
    tab => tab.linkedBrowser.currentURI.specIgnoringRef == uri.specIgnoringRef
  );
  if (duplicate) {
    actions.push({
      label: "Switch to the open tab",
      iconSrc: "chrome://browser/skin/tab.svg",
      run: () => {
        win.gBrowser.selectedTab = duplicate;
      },
    });
  }

  if (isProductPage(uri)) {
    const seen = new Set([uri.specIgnoringRef]);
    const products = otherTabs.filter(tab => {
      const tabUri = tab.linkedBrowser.currentURI;
      if (!isProductPage(tabUri) || seen.has(tabUri.specIgnoringRef)) {
        return false;
      }
      seen.add(tabUri.specIgnoringRef);
      return true;
    });
    if (products.length) {
      actions.push(
        chatAction(
          win,
          `Compare with ${products.length} other product${products.length > 1 ? "s" : ""}`,
          products.slice(0, 4)
        )
      );
    }
  }

  const clean = lazy.BrowserUtils.getExposableURI(uri, {
    stripTracking: true,
  }).displaySpec;
  if (clean != Services.io.createExposableURI(uri).displaySpec) {
    actions.push({
      label: "Copy clean link",
      iconSrc: "chrome://global/skin/icons/link.svg",
      run: button => {
        lazy.clipboard.copyString(
          clean,
          browser.browsingContext.currentWindowGlobal
        );
        button.label = "Link copied";
      },
    });
  }

  if (/\b(404|not found)\b/i.test(win.gBrowser.selectedTab.label)) {
    actions.unshift({
      label: "Find an archived copy",
      iconSrc: "chrome://browser/skin/history.svg",
      run: () =>
        win.openTrustedLinkIn(
          `https://web.archive.org/web/${uri.spec}`,
          "current"
        ),
    });
  }
  return actions;
}

/**
 * Metadata for each browser, for the page it was read from.
 *
 * @type {WeakMap<MozBrowser, {key: string, reader: ?StructuredMetadataReader}>}
 */
const pageMeta = new WeakMap();

/**
 * @param {ChromeWindow} win
 * @returns {?StructuredMetadataReader} Metadata already read for the current
 *   page.
 */
function cachedMeta(win) {
  const entry = pageMeta.get(win.gBrowser.selectedBrowser);
  return entry?.key == win.gBrowser.currentURI.specIgnoringRef
    ? entry.reader
    : null;
}

/**
 * Reads the current page's metadata once, then redraws.
 *
 * @param {ChromeWindow} win
 */
async function loadMeta(win) {
  const browser = win.gBrowser.selectedBrowser;
  const key = win.gBrowser.currentURI.specIgnoringRef;
  if (pageMeta.get(browser)?.key == key) {
    return;
  }
  pageMeta.set(browser, { key, reader: null });
  let reader;
  try {
    reader = new lazy.StructuredMetadataReader(
      await browser.browsingContext.currentWindowGlobal
        .getActor("PageExtractor")
        .getStructuredMetadata()
    );
  } catch (error) {
    pageMeta.delete(browser);
    return;
  }
  if (pageMeta.get(browser)?.key == key) {
    pageMeta.set(browser, { key, reader });
    refreshHeuristics();
  }
}

/**
 * @param {string} [duration] - ISO 8601 duration like PT1H15M.
 * @returns {number} Minutes, or 0.
 */
function isoMinutes(duration) {
  const [, days, hours, minutes] =
    /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(duration ?? "") ?? [];
  return (days ?? 0) * 1440 + (hours ?? 0) * 60 + Number(minutes ?? 0);
}

/**
 * @param {any} amount - A price as a page writes it, like "269.00",
 *   "$1,299.99" or "12,50 €".
 * @returns {?number} The amount, or null when it isn't a positive number.
 */
function parsePrice(amount) {
  let digits = String(amount ?? "").replace(/[^\d.,]/g, "");
  // A comma followed by two final digits is a decimal comma.
  digits = /,\d{2}$/.test(digits)
    ? digits.replace(/\./g, "").replace(",", ".")
    : digits.replace(/,/g, "");
  const value = parseFloat(digits);
  return value > 0 ? value : null;
}

/**
 * @param {number} value
 * @param {string} [currency]
 * @returns {string}
 */
function formatPrice(value, currency) {
  try {
    return new Intl.NumberFormat(Services.locale.appLocaleAsBCP47, {
      style: currency ? "currency" : "decimal",
      currency,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  } catch (error) {
    return String(value);
  }
}

/**
 * @param {ChromeWindow} win
 * @param {string} [label]
 * @returns {?ToolbarAction} Opens the task form, when tasks are available.
 */
function watchAction(win, label = "Watch for a price drop") {
  if (!win.document.getElementById("smartwindow-monitor-button")) {
    return null;
  }
  return {
    label,
    iconSrc: "chrome://browser/content/aiwindow/assets/agent-watch.svg",
    run: () => lazy.MonitorPanel.showCreateForm(win),
  };
}

/**
 * Readers for schema.org values, which may be lists, @id references or
 * items with a name.
 *
 * @param {StructuredMetadataReader} reader
 */
function metaValues(reader) {
  const first = value =>
    [reader.resolve(value)]
      .flat()
      .map(entry => reader.resolve(entry))
      .find(entry => entry != null && entry !== "");
  const text = value => {
    const entry = first(value);
    if (typeof entry == "string" || typeof entry == "number") {
      return String(entry)
        .trim()
        .replace(/[\s|:\u2013\u2014-]+$/, "");
    }
    return entry?.name ? text(entry.name) : "";
  };
  const meta = name => reader.metaValues(name)[0];
  return { first, text, meta };
}

/**
 * @param {ChromeWindow} win
 * @param {number} minutes - How long the recipe takes.
 * @returns {?ToolbarAction} When to start to eat at 7 PM, while that is
 *   still ahead today.
 */
function startTimeAction(win, minutes) {
  if (minutes < 20) {
    return null;
  }
  const now = new Date();
  const dinner = new Date(now);
  dinner.setHours(19, 0, 0, 0);
  const start = new Date(dinner - minutes * 60_000);
  start.setMinutes(Math.floor(start.getMinutes() / 5) * 5);
  if (start <= now || start - now > 8 * 3_600_000) {
    return null;
  }
  const time = new Intl.DateTimeFormat(Services.locale.appLocaleAsBCP47, {
    hour: "numeric",
    minute: "2-digit",
  });
  return chatAction(
    win,
    `Start by ${time.format(start)} to eat at ${time.format(dinner)}`,
    [],
    `Plan a timeline so this is ready to eat at ${time.format(dinner)}`
  );
}

/**
 * @param {ChromeWindow} win
 * @param {string[]} ingredients
 * @returns {?ToolbarAction} Converts units the user's region doesn't use.
 */
function unitsAction(win, ingredients) {
  const region = lazy.Region.home;
  if (!region) {
    return null;
  }
  const list = ingredients.join("\n");
  const usesImperial = ["US", "LR", "MM"].includes(region);
  if (
    !usesImperial &&
    /\b(cups?|oz|ounces?|pounds?|lbs?|°F)\b|\d\s*°F/i.test(list)
  ) {
    return chatAction(win, "Convert to metric");
  }
  if (usesImperial && /\d\s*(g|kg|ml|l)\b|grams|millilit/i.test(list)) {
    return chatAction(win, "Convert to US units");
  }
  return null;
}

/**
 * Actions for a schema.org Recipe.
 *
 * @param {ChromeWindow} win
 * @param {StructuredMetadataReader} reader
 * @param {string} title
 * @returns {?ToolbarAction[]} Null when the page has no such item.
 */
function recipeActions(win, reader, title) {
  const { first, text } = metaValues(reader);
  const actions = [];
  const [recipe] = reader.findItems("Recipe");
  if (recipe) {
    const name = text(recipe.name) || title;
    const step = first(recipe.recipeInstructions);
    const stepUrl = URL.parse(
      text(step?.url) || text(first(step?.itemListElement)?.url)
    );
    if (
      stepUrl?.hash &&
      stepUrl.href.split("#")[0] == win.gBrowser.currentURI.specIgnoringRef
    ) {
      actions.push(jumpAction(win, "Jump to the recipe", stepUrl.hash));
    }
    const servings = parseInt(text(recipe.recipeYield));
    if (servings) {
      actions.push(chatAction(win, `Scale to ${servings * 2} servings`));
    }
    const ingredients = [recipe.recipeIngredient ?? []]
      .flat()
      .filter(entry => typeof entry == "string");
    const keywords = [
      recipe.keywords,
      recipe.recipeCategory,
      recipe.recipeCuisine,
      ingredients,
    ]
      .flat()
      .filter(entry => typeof entry == "string")
      .join(", ");
    if (
      /\b(beef|chicken|pork|sausage|bacon|turkey|lamb|meat)\b/i.test(keywords)
    ) {
      actions.push(chatAction(win, "Make it vegetarian"));
    }
    const rating = first(recipe.aggregateRating);
    const reviews = Number(
      text(rating?.reviewCount) || text(rating?.ratingCount)
    );
    if (reviews) {
      actions.push(
        chatAction(win, `What ${reviews.toLocaleString()} reviewers changed`)
      );
    }
    const start = startTimeAction(
      win,
      isoMinutes(text(recipe.totalTime)) ||
        isoMinutes(text(recipe.prepTime)) + isoMinutes(text(recipe.cookTime))
    );
    if (start) {
      actions.splice(
        actions[0]?.label == "Jump to the recipe" ? 1 : 0,
        0,
        start
      );
    }
    const units = unitsAction(win, ingredients);
    if (units) {
      actions.push(units);
    }
    if (ingredients.length) {
      actions.push(
        chatAction(win, `Shopping list for ${ingredients.length} ingredients`)
      );
    }
    if (isoMinutes(text(recipe.totalTime)) >= 45) {
      actions.push(
        searchAction(win, `Quicker ${name} recipes`, `30 minute ${name}`)
      );
    }
    actions.push(chatAction(win, `What goes with ${name}`));
    return actions;
  }

  return null;
}

/**
 * @param {?object} offer - A schema.org Offer.
 * @param {?string} formatted - The offer's price, formatted.
 * @returns {string} What a task for this offer would watch for.
 */
function watchLabel(offer, formatted) {
  const availability = String([offer?.availability].flat()[0] ?? "");
  if (/(OutOfStock|SoldOut|BackOrder)$/i.test(availability)) {
    return "Tell me when it's back";
  }
  const until = new Date([offer?.priceValidUntil].flat()[0] ?? "");
  const days = (until - Date.now()) / 86_400_000;
  if (days > 0 && days <= 14) {
    const date = new Intl.DateTimeFormat(Services.locale.appLocaleAsBCP47, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(until);
    return `Sale ends ${date}, remind me`;
  }
  return formatted
    ? `Watch for a drop below ${formatted}`
    : "Watch for a price drop";
}

/**
 * Actions for a product page.
 *
 * @param {ChromeWindow} win
 * @param {StructuredMetadataReader} reader
 * @param {string} title
 * @returns {?ToolbarAction[]} Null when the page has no such item.
 */
function productActions(win, reader, title) {
  const { first, text, meta } = metaValues(reader);
  const actions = [];
  const [product] = reader.findItems("Product", "ProductGroup");
  const offers = [reader.resolve(product?.offers)]
    .flat()
    .map(offer => reader.resolve(offer))
    .filter(offer => offer && typeof offer == "object");
  const offer = offers.find(
    entry => parsePrice(text(entry.price ?? entry.lowPrice)) != null
  );
  const price = [
    text(offer?.price ?? offer?.lowPrice),
    meta("product:price:amount"),
    meta("og:price:amount"),
  ]
    .map(parsePrice)
    .find(value => value != null);
  if (product || price || meta("og:type") == "product") {
    const name = text(product?.name) || title;
    const currency =
      text(offer?.priceCurrency ?? offers[0]?.priceCurrency) ||
      meta("product:price:currency") ||
      meta("og:price:currency");
    const formatted = price != null && formatPrice(price, currency);
    actions.push(
      chatAction(
        win,
        formatted ? `Is ${formatted} a good price` : "Is this a good price"
      )
    );
    const rating = first(product?.aggregateRating);
    const reviews = Number(
      text(rating?.reviewCount) || text(rating?.ratingCount)
    );
    actions.push(
      reviews
        ? chatAction(
            win,
            `Pros and cons from ${reviews.toLocaleString()} reviews`
          )
        : searchAction(win, `${name} reviews`, `${name} reviews`)
    );
    const watch = watchAction(win, watchLabel(offer ?? offers[0], formatted));
    if (watch) {
      actions.push(watch);
    }
    actions.push(
      searchAction(win, `Alternatives to ${name}`, `${name} alternatives`)
    );
    const brand = text(product?.brand);
    if (brand) {
      actions.push(searchAction(win, `More from ${brand}`, brand));
    }
    return actions;
  }

  return null;
}

/**
 * Actions for a restaurant or other local business.
 *
 * @param {ChromeWindow} win
 * @param {StructuredMetadataReader} reader
 * @returns {?ToolbarAction[]} Null when the page has no such item.
 */
function placeActions(win, reader) {
  const { first, text } = metaValues(reader);
  const actions = [];
  const [place] = reader.findItems(
    "Restaurant",
    "FoodEstablishment",
    "CafeOrCoffeeShop",
    "BarOrPub",
    "Bakery",
    "LocalBusiness",
    "Store"
  );
  const placeName = text(place?.name);
  if (placeName) {
    const locality = text(first(place.address)?.addressLocality);
    const where = locality ? ` ${locality}` : "";
    actions.push(
      searchAction(win, `${placeName} hours`, `${placeName}${where} hours`),
      searchAction(
        win,
        `Reviews of ${placeName}`,
        `${placeName}${where} reviews`
      )
    );
    return actions;
  }

  return null;
}

/**
 * Actions for an article.
 *
 * @param {ChromeWindow} win
 * @param {StructuredMetadataReader} reader
 * @returns {?ToolbarAction[]} Null when the page has no such item.
 */
function articleActions(win, reader) {
  const { text, meta } = metaValues(reader);
  const actions = [];
  const [article] = reader.findItems("Article", "NewsArticle", "BlogPosting");
  if (article || meta("og:type") == "article") {
    const label = [1, 2].find(n =>
      /reading time/i.test(meta(`twitter:label${n}`) ?? "")
    );
    const reading = label && meta(`twitter:data${label}`);
    const headline = text(article?.headline) || text(reader.title);
    if (
      headline &&
      /^false$/i.test(String([article?.isAccessibleForFree].flat()[0]))
    ) {
      actions.push(searchAction(win, "Other coverage of this story", headline));
    }
    actions.push(
      chatAction(
        win,
        reading
          ? `Summarize this ${reading.replace(/s$/, "")} read`
          : "Summarize this article"
      )
    );
    const year = new Date(
      reader.modifiedTime ?? reader.publishedTime
    ).getFullYear();
    if (year < new Date().getFullYear() - 1) {
      actions.push(chatAction(win, `What's changed since ${year}`));
    }
    const author = reader.author;
    if (author && author.length < 40) {
      actions.push(searchAction(win, `More by ${author}`, author));
    }
    return actions;
  }
  return null;
}

/**
 * Actions for a page that is mainly a video.
 *
 * @param {ChromeWindow} win
 * @param {StructuredMetadataReader} reader
 * @returns {?ToolbarAction[]} Null when the page has no video.
 */
function videoActions(win, reader) {
  const { text, meta } = metaValues(reader);
  const [video] = reader.findItems("VideoObject");
  if (!video && !meta("og:type")?.startsWith("video")) {
    return null;
  }
  const minutes =
    isoMinutes(text(video?.duration)) ||
    Math.round(Number(meta("video:duration") ?? 0) / 60);
  return [
    chatAction(
      win,
      minutes ? `Summarize this ${minutes} min video` : "Summarize this video"
    ),
  ];
}

/**
 * Actions from the page's meta tags, JSON-LD and microdata.
 *
 * @param {ChromeWindow} win
 * @param {?StructuredMetadataReader} reader
 * @returns {ToolbarAction[]}
 */
function metaActions(win, reader) {
  if (!reader) {
    return [];
  }
  const title = metaValues(reader).text(reader.title) || shortTitle(win);
  return (
    recipeActions(win, reader, title) ??
    productActions(win, reader, title) ??
    placeActions(win, reader) ??
    articleActions(win, reader) ??
    videoActions(win, reader) ??
    []
  );
}

/**
 * Actions from the browser, URL and title alone, with no model request until
 * clicked.
 *
 * @param {ChromeWindow} win
 * @returns {ToolbarAction[]}
 */
function heuristicActions(win) {
  const title = shortTitle(win);
  const category = lazy.AgentPageDetector.getPageInfo(
    win.gBrowser.currentURI
  )?.category;
  const { PRODUCT_DETAIL, SHOPPING_HOME, NEWS_HOME } = lazy.AgentPageCategory;
  const suggestions = [{ type: "chat", label: "Summarize this page" }];
  if (category == NEWS_HOME) {
    suggestions.push({ type: "chat", label: "What are the top stories here" });
  } else if (category == SHOPPING_HOME) {
    suggestions.push({ type: "chat", label: "Find the best deals here" });
  } else if (category == PRODUCT_DETAIL && title) {
    suggestions.splice(
      0,
      1,
      { type: "chat", label: "Is this a good price" },
      { type: "search", label: `${title} reviews` },
      { type: "search", label: `${title} alternatives` }
    );
  } else if (title) {
    suggestions.push(
      { type: "chat", label: "Explain the key points" },
      { type: "search", label: title }
    );
  }
  const fromMeta = metaActions(win, cachedMeta(win));
  return [
    ...browserActions(win),
    ...fromMeta,
    ...(fromMeta.length
      ? []
      : [
          ...suggestions.map(({ type, label }) =>
            ACTION_TYPES[type](win, label, label)
          ),
          ...(category == PRODUCT_DETAIL ? [watchAction(win)] : []),
        ]),
  ]
    .filter(Boolean)
    .slice(0, 5);
}

/**
 * Redraws the heuristic actions of each window not showing model ones.
 */
function refreshHeuristics() {
  for (const win of ChromeUtils.nondeterministicGetWeakMapKeys(windowStates)) {
    const state = windowStates.get(win);
    if (
      !win.closed &&
      state.listening &&
      !state.expanded &&
      loadedKeys.get(win)
    ) {
      render(win, heuristicActions(win));
    }
  }
}

/**
 * @param {ChromeWindow} win
 * @param {ToolbarAction[]} actions
 * @param {object} [options]
 * @param {boolean} [options.loading] - Show the loading text after actions.
 * @param {boolean} [options.expanded] - Model suggestions were requested, so
 *   the icon button can't ask again for this page.
 */
function render(win, actions, { loading = false, expanded = false } = {}) {
  const doc = win.document;
  let toolbar = doc.getElementById(TOOLBAR_ID);
  if (!toolbar) {
    // TODO: Bug 2092110 - proper toolbar instead of inserting it
    win.windowUtils.loadSheetUsingURIString(
      "chrome://browser/content/aiwindow/smart-actions-toolbar.css",
      Ci.nsIDOMWindowUtils.AUTHOR_SHEET
    );
    toolbar = doc.createXULElement("toolbar");
    toolbar.id = TOOLBAR_ID;
    toolbar.className = "browser-toolbar";
    toolbar.setAttribute("fullscreentoolbar", "true");
    doc.l10n.setAttributes(toolbar, "smart-actions-toolbar");
    doc.getElementById("nav-bar").after(toolbar);
  }

  const more = doc.createElement("moz-button");
  more.className = "smart-actions-more";
  more.type = "icon ghost";
  more.size = "small";
  more.iconSrc = "chrome://browser/skin/smart-window-simplified.svg";
  more.disabled = expanded;
  doc.l10n.setAttributes(more, "smart-actions-more");
  more.addEventListener("click", () => SmartActionsToolbar.expand(win));

  const children = [
    more,
    ...actions.map(action => {
      const button = doc.createElement("moz-button");
      button.type = "toolbar";
      button.size = "small";
      button.iconSrc = action.iconSrc;
      button.label = action.label;
      button.title = action.label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await action.run();
        } finally {
          button.disabled = false;
        }
      });
      return button;
    }),
  ];
  if (loading) {
    const text = doc.createElement("span");
    text.className = "smart-actions-loading";
    doc.l10n.setAttributes(text, "smart-actions-loading");
    children.push(text);
  }
  toolbar.replaceChildren(...children);
  toolbar.hidden = false;
}

export const SmartActionsToolbar = {
  /**
   * @param {ChromeWindow} win
   */
  init(win) {
    windowStates.set(win, {
      controller: null,
      expanded: false,
      listening: false,
      // Tabbrowser also sends onLocationChange on tab switches.
      progressListener: { onLocationChange: () => this.update(win) },
      // The title usually arrives after the location changes.
      onTabAttrModified: event => {
        const state = windowStates.get(win);
        if (
          state?.listening &&
          !state.expanded &&
          event.target.selected &&
          event.detail.changed.includes("label") &&
          loadedKeys.get(win)
        ) {
          render(win, heuristicActions(win));
          loadMeta(win);
        }
      },
    });
    this.update(win);
  },

  /**
   * @param {ChromeWindow} win
   */
  uninit(win) {
    const state = windowStates.get(win);
    if (!state) {
      return;
    }
    state.controller?.abort();
    if (state.listening) {
      win.gBrowser.removeProgressListener(state.progressListener);
      win.gBrowser.tabContainer.removeEventListener(
        "TabAttrModified",
        state.onTabAttrModified
      );
    }
    windowStates.delete(win);
  },

  updateAll() {
    for (const win of ChromeUtils.nondeterministicGetWeakMapKeys(
      windowStates
    )) {
      if (!win.closed) {
        this.update(win);
      }
    }
  },

  /**
   * Follows navigation only while the toolbar can show. When the context key
   * changed, hides the toolbar or loads new actions.
   *
   * @param {ChromeWindow} win
   */
  update(win) {
    const state = windowStates.get(win);
    if (!state) {
      return;
    }
    const listen = isActive(win);
    if (listen !== state.listening) {
      state.listening = listen;
      if (listen) {
        win.gBrowser.addProgressListener(state.progressListener);
        win.gBrowser.tabContainer.addEventListener(
          "TabAttrModified",
          state.onTabAttrModified
        );
      } else {
        win.gBrowser.removeProgressListener(state.progressListener);
        win.gBrowser.tabContainer.removeEventListener(
          "TabAttrModified",
          state.onTabAttrModified
        );
      }
    }
    const key = listen ? contextKey(win) : null;
    if (key === loadedKeys.get(win)) {
      return;
    }
    loadedKeys.set(win, key);
    state.controller?.abort();
    if (!key) {
      const toolbar = win.document.getElementById(TOOLBAR_ID);
      if (toolbar) {
        toolbar.hidden = true;
      }
      return;
    }

    state.expanded = false;
    render(win, heuristicActions(win));
    loadMeta(win);
  },

  /**
   * Asks the model for suggestions about the current page and shows them
   * before the heuristic actions.
   *
   * @param {ChromeWindow} win
   */
  async expand(win) {
    const state = windowStates.get(win);
    if (!state || state.expanded || !loadedKeys.get(win)) {
      return;
    }
    state.expanded = true;
    state.controller?.abort();
    state.controller = new AbortController();
    const { signal } = state.controller;
    const heuristics = heuristicActions(win);
    render(win, heuristics, { loading: true, expanded: true });
    let actions = [];
    try {
      actions = await suggestActions(win, signal);
    } catch (error) {
      if (!signal.aborted) {
        console.error("Failed to suggest smart actions:", error);
      }
    }
    if (!signal.aborted) {
      render(win, [...actions, ...heuristics], { expanded: true });
    }
  },
};
