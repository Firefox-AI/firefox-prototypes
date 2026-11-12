/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @ts-check

/**
 * @import { MetaTag, StructuredMetadata } from './PageExtractor.d.ts'
 */

const HTML_META_NAMES = new Set([
  "description",
  "keywords",
  "author",
  "robots",
]);

/**
 * Open Graph, the vocabularies it defines for its object types
 * (https://ogp.me/#types), the product vocabulary of its commerce extension,
 * and Twitter Cards.
 */
const SOCIAL_META_PREFIXES = [
  "og:",
  "article:",
  "book:",
  "profile:",
  "music:",
  "video:",
  "product:",
  "twitter:",
];

// These bound what a hostile page can send to the parent process, well above
// what real pages declare.
const MAX_META_TAGS = 50;
const MAX_META_LENGTH = 1000;
const MAX_JSON_LD_LENGTH = 100_000;
const MAX_MICRODATA_ITEMS = 20;
const MAX_MICRODATA_VALUES = 300;
const MAX_MICRODATA_DEPTH = 5;
const MAX_MICRODATA_LENGTH = 100_000;

const URL_ELEMENTS = new Set(["a", "area", "link"]);
const SRC_ELEMENTS = new Set([
  "audio",
  "embed",
  "iframe",
  "img",
  "source",
  "track",
  "video",
]);

/**
 * @param {Element} element - An element with an itemprop and no itemscope.
 * @returns {string} Its microdata value, per the HTML spec's element rules.
 */
function microdataValue(element) {
  const tag = element.localName;
  if (tag == "meta") {
    return element.getAttribute("content") ?? "";
  }
  if (URL_ELEMENTS.has(tag)) {
    return element.href ?? "";
  }
  if (SRC_ELEMENTS.has(tag)) {
    return element.src ?? "";
  }
  if (tag == "object") {
    return element.data ?? "";
  }
  if (tag == "data" || tag == "meter") {
    return element.getAttribute("value") ?? "";
  }
  if (tag == "time" && element.hasAttribute("datetime")) {
    return element.getAttribute("datetime");
  }
  return element.textContent ?? "";
}

/**
 * Reads the page's top-level microdata items as JSON-LD shaped objects, with
 * itemtype as @type and each itemprop as a property. itemref is not followed.
 *
 * @param {Document} document
 * @param {(text: string) => string} clip - Shortens a value to the limit.
 * @param {() => void} onTruncate - Called when a limit leaves something out.
 * @returns {string[]} Each item as compact JSON.
 */
function extractMicrodata(document, clip, onTruncate) {
  let remainingValues = MAX_MICRODATA_VALUES;
  const readItem = (scope, depth) => {
    /** @type {Record<string, any>} */
    const item = {};
    const types = scope.getAttribute("itemtype")?.trim().split(/\s+/) ?? [];
    if (types[0]) {
      item["@type"] = types.length == 1 ? types[0] : types;
    }
    for (const element of scope.querySelectorAll("[itemprop]")) {
      if (element.parentElement?.closest("[itemscope]") != scope) {
        continue;
      }
      if (remainingValues <= 0) {
        onTruncate();
        break;
      }
      let value;
      if (element.hasAttribute("itemscope")) {
        if (depth >= MAX_MICRODATA_DEPTH) {
          onTruncate();
          continue;
        }
        value = readItem(element, depth + 1);
      } else {
        value = clip(microdataValue(element).trim());
        if (!value) {
          continue;
        }
      }
      remainingValues--;
      for (const name of element.getAttribute("itemprop").trim().split(/\s+/)) {
        item[name] = name in item ? [item[name]].flat().concat([value]) : value;
      }
    }
    return item;
  };

  const items = [];
  let remainingLength = MAX_MICRODATA_LENGTH;
  for (const scope of document.querySelectorAll(
    "[itemscope]:not([itemprop])"
  )) {
    if (items.length >= MAX_MICRODATA_ITEMS || remainingValues <= 0) {
      onTruncate();
      break;
    }
    const item = readItem(scope, 0);
    if (!item["@type"]) {
      continue;
    }
    const text = JSON.stringify(item);
    if (text.length > remainingLength) {
      onTruncate();
      continue;
    }
    items.push(text);
    remainingLength -= text.length;
  }
  return items;
}

/**
 * @param {Document} document
 * @yields {string} The trimmed, non-empty text of each JSON-LD script, read
 *   as the caller asks for it.
 */
export function* jsonLdScriptTexts(document) {
  for (const script of document.querySelectorAll(
    'script[type="application/ld+json" i]'
  )) {
    const text = script.textContent?.trim();
    if (text) {
      yield text;
    }
  }
}

/**
 * Collects the SEO and social tags, the JSON-LD and the microdata a page
 * declares about itself, keeping repeats and conflicts so callers can decide which ones
 * matter. StructuredMetadataReader interprets the result.
 *
 * @param {Document} document
 * @returns {StructuredMetadata}
 */
export function extractStructuredMetadata(document) {
  let truncated = false;
  const clip = text => {
    if (text.length <= MAX_META_LENGTH) {
      return text;
    }
    truncated = true;
    return text.slice(0, MAX_META_LENGTH);
  };

  const title = clip(document.title);
  const canonicalHref = document.querySelector(
    'link[rel~="canonical" i][href]'
  )?.href;
  const canonicalUrl = canonicalHref ? clip(canonicalHref) : null;
  const lang = document.documentElement?.lang;
  const language = lang ? clip(lang) : null;

  /** @type {MetaTag[]} */
  const metaTags = [];
  let metaTagsFull = false;
  for (const meta of document.querySelectorAll("meta[content]")) {
    // Open Graph is specified with `property` and Twitter Cards with `name`,
    // but pages mix them up, and some set both on one tag.
    const names = new Set(
      [meta.getAttribute("property"), meta.getAttribute("name")]
        .filter(Boolean)
        .map(name => name.toLowerCase())
    );
    for (const name of names) {
      if (
        !HTML_META_NAMES.has(name) &&
        !SOCIAL_META_PREFIXES.some(prefix => name.startsWith(prefix))
      ) {
        continue;
      }
      const value = meta.getAttribute("content");
      if (!value.trim()) {
        break;
      }
      if (metaTags.length >= MAX_META_TAGS) {
        truncated = true;
        metaTagsFull = true;
        break;
      }
      metaTags.push({ name, value: clip(value) });
    }
    if (metaTagsFull) {
      break;
    }
  }

  const jsonLd = [];
  let remainingLength = MAX_JSON_LD_LENGTH;
  for (const text of jsonLdScriptTexts(document)) {
    if (remainingLength <= 0) {
      truncated = true;
      break;
    }
    if (text.length > remainingLength) {
      truncated = true;
      continue;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed == "object") {
        // Serializing also drops a block nested too deeply to send to the
        // parent process.
        jsonLd.push(JSON.stringify(parsed));
        remainingLength -= text.length;
      }
    } catch {}
  }

  const microdata = extractMicrodata(document, clip, () => {
    truncated = true;
  });

  return {
    truncated,
    url: document.documentURI,
    title,
    canonicalUrl,
    language,
    metaTags,
    jsonLd,
    microdata,
  };
}
