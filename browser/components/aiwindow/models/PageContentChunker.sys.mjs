/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Fits a page that is longer than the get_page_content budget into that
 * budget, either by picking the chunks most relevant to a query, or by
 * building an overview from the start of the page and the lead of each
 * section.
 *
 * @import { TextBlock } from "../../../../toolkit/components/pageextractor/PageExtractor.d.ts"
 */

import { CountVectorizer } from "chrome://global/content/ml/NLPUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

// Chunks: visible characters per chunk, and the longest heading kept in a
// chunk's heading path.
const CHUNK_TARGET_CHARS = 500;
const MAX_HEADING_CHARS = 120;
const HEADING_SEPARATOR = " › ";
// Heading levels whose sections average fewer characters than this, on pages
// with at least this many such headings (teasers on a news front page), are
// treated as text, so a chunk holds several entries.
const MIN_AVERAGE_SECTION_CHARS = 200;
const MIN_DENSE_HEADINGS = 20;
const MARKDOWN_LINK_REGEX = /\[((?:\\.|[^\]\\])*)\]\([^)\s]*\)/g;
const MARKDOWN_ESCAPE_REGEX = /\\([\[\]()])/g;

// First reads: the share of the budget for the start of the page and for the
// opening of each section, and the fewest characters an opening gets (with
// and without a query).
const LEAD_BUDGET_SHARE = 0.3;
const SKELETON_BUDGET_SHARE = 0.3;
const MIN_SKELETON_SHARE = 120;
const MIN_SECTION_SHARE = 250;
// A page with more of its text than this before its first heading, like an
// article whose only heading is a box after it, is spread out like a page
// without headings.
const HEADINGLESS_LEAD_SHARE = 0.5;

// Search: how many of the best chunks also get their neighbours, and typo
// correction for words of at least FUZZY_MIN_LENGTH letters, up to
// FUZZY_MAX_EDITS edits.
const NEIGHBOUR_HITS = 3;
const FUZZY_MIN_LENGTH = 5;
const FUZZY_MAX_EDITS = 2;
// Alternate queries a follow-up read may add, unless the caller sets
// maxAlternateQueries.
const DEFAULT_ALTERNATE_QUERIES = 3;

// The lines a read adds: the query as quoted in its header, the headings of
// sections without an opening, and the length of each section.
const MAX_QUERY_CHARS = 200;
const OTHER_SECTIONS_CHARS = 400;
const OTHER_SECTIONS_QUERY_CHARS = 250;
const SECTION_LENGTHS_CHARS = 400;

// Follow-up reads: how much of a chunk's start identifies it in earlier
// results, the share of the best score that still counts as a match, and the
// least rest of the page worth adding after the matches.
const UNSEEN_PREFIX_CHARS = 40;
const REMAINING_MATCH_SHARE = 0.3;
const MIN_FILLER_CHARS = 500;

/**
 * How results that only make sense together with an earlier read of the same
 * page start. Prompt compaction keeps the earlier read when it sees one.
 */
const FOLLOW_UP_HEADERS = Object.freeze([
  "[More of this page",
  "[Showing more of this page",
  "[No other part of this page",
  "[This page was already read",
  "[The whole page was already returned",
  "[Characters ",
  "[Nothing from character ",
]);

const PARTIAL_READ_HEADERS = [
  "[This page has ",
  "[More of this page",
  "[Showing more of this page",
  "[Characters ",
];

/**
 * @param {string} text - A get_page_content result.
 * @returns {boolean} Whether it continues an earlier read of the page.
 */
export function isFollowUpRead(text) {
  return FOLLOW_UP_HEADERS.some(header => text.includes("\n" + header));
}

/**
 * @param {string} text - A get_page_content result.
 * @returns {boolean} Whether it holds only part of the page.
 */
export function isPartialRead(text) {
  return PARTIAL_READ_HEADERS.some(header => text.includes("\n" + header));
}

/**
 * The options get_page_content's chunked reads use. Tests and evals can turn
 * them off to compare.
 */
export const DEFAULT_PAGE_STRATEGIES = Object.freeze({
  stripLinks: true,
  fuzzy: true,
});

/**
 * @typedef {object} Chunk
 * @property {string} text - The chunk text, starting with its heading if it opens a section.
 * @property {string[]} headings - The heading path the chunk sits under.
 * @property {number} section - Increments at every heading, 0 before the first.
 * @property {number} level - Level of the heading that opens the section, 0
 *   for the lead.
 * @property {boolean} startsSection - Whether the chunk begins with its
 *   section heading.
 */

/**
 * @param {string} text
 * @returns {string} The text with markdown links reduced to their label.
 */
function stripLinks(text) {
  return text
    .replace(MARKDOWN_LINK_REGEX, "$1")
    .replace(MARKDOWN_ESCAPE_REGEX, "$1");
}

const LINK_WITH_URL_REGEX = /\[((?:\\.|[^\]\\])*)\]\(([^)\s]*)\)/g;

/**
 * @param {string} url
 * @returns {string} The URL without its fragment, decoded, for comparing pages.
 */
function pageOf(url) {
  const page = url.split("#")[0];
  try {
    return decodeURI(page);
  } catch {
    return page;
  }
}

/**
 * Links to places on the same page, such as reference markers and tables of
 * contents, cost a lot of the budget on some pages (15-30% of Wikipedia and
 * RFC pages) and lead nowhere new.
 *
 * @param {string} text
 * @param {string} pageUrl
 * @returns {string} The text with such links reduced to their label.
 */
export function stripSamePageLinks(text, pageUrl) {
  const page = pageOf(pageUrl);
  return text.replace(LINK_WITH_URL_REGEX, (link, label, url) =>
    url.startsWith("#") || (url.includes("#") && pageOf(url) == page)
      ? label.replace(MARKDOWN_ESCAPE_REGEX, "$1")
      : link
  );
}

/**
 * Treat each line of plain text as a block, for extractions that don't
 * provide blocks (PDF, YouTube).
 *
 * @param {string} text
 * @returns {TextBlock[]}
 */
export function blocksFromText(text) {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => ({ text: line, headingLevel: 0 }));
}

const sentenceSegmenter = new Intl.Segmenter(undefined, {
  granularity: "sentence",
});

/**
 * The sentences of a text, as Intl.Segmenter finds them, except that
 * reference markers such as "[30]" stay with the sentence they follow:
 * Intl.Segmenter ends a sentence inside them ("mode.[" and "30] Next …").
 *
 * @param {string} text
 * @returns {Array<{segment: string, index: number}>}
 */
export function segmentSentences(text) {
  const sentences = [];
  for (const { segment, index } of sentenceSegmenter.segment(text)) {
    const marker = sentences.at(-1)?.segment.endsWith("[")
      ? segment.match(/^[^\]\s]*\](?:\[[^\]\s]*\])*\s*/)?.[0]
      : null;
    if (!marker) {
      sentences.push({ segment, index });
      continue;
    }
    sentences.at(-1).segment += marker;
    if (marker.length < segment.length) {
      sentences.push({
        segment: segment.slice(marker.length),
        index: index + marker.length,
      });
    }
  }
  return sentences;
}

/**
 * Split text into pieces of at most maxChars, preferring sentence (or, for
 * code, line) and then word boundaries.
 *
 * @param {string} text
 * @param {number} maxChars
 * @param {boolean} [isCode]
 * @returns {string[]}
 */
function splitLongText(text, maxChars, isCode = false) {
  if (text.length <= maxChars) {
    return [text];
  }
  const pieces = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = -1;
    if (isCode) {
      cut = window.lastIndexOf("\n");
    } else {
      for (const { index } of segmentSentences(window)) {
        if (index) {
          cut = index;
        }
      }
    }
    if (cut < maxChars / 2) {
      cut = window.lastIndexOf(" ");
    }
    if (cut < maxChars / 2) {
      cut = maxChars;
    }
    const trim = isCode ? t => t.replace(/^\n+|\s+$/g, "") : t => t.trim();
    pieces.push(trim(rest.slice(0, cut)));
    rest = trim(rest.slice(cut));
  }
  if (rest) {
    pieces.push(rest);
  }
  return pieces;
}

/**
 * Headings so frequent (at least MIN_DENSE_HEADINGS) that their sections
 * average less than MIN_AVERAGE_SECTION_CHARS label single items, such as teasers on a news
 * front page or entries of a ticker. Treat those as text, so that a chunk
 * holds several items and a section groups them.
 *
 * @param {TextBlock[]} blocks
 * @returns {TextBlock[]}
 */
function demoteDenseHeadings(blocks) {
  // Text under a level includes the headings below it, which become text if
  // that level is kept and the lower ones are not.
  let contentLength = 0;
  const counts = new Array(7).fill(0);
  const headingLengths = new Array(7).fill(0);
  for (const { text, headingLevel } of blocks) {
    contentLength += text.length;
    counts[headingLevel]++;
    headingLengths[headingLevel] += text.length;
  }
  let maxLevel = 0;
  let headings = 0;
  for (let level = 1; level <= 6; level++) {
    headings += counts[level];
    contentLength -= headingLengths[level];
    if (
      counts[level] &&
      (headings < MIN_DENSE_HEADINGS ||
        contentLength / headings >= MIN_AVERAGE_SECTION_CHARS)
    ) {
      maxLevel = level;
    }
  }
  return blocks.map(block =>
    block.headingLevel > maxLevel ? { ...block, headingLevel: 0 } : block
  );
}

/**
 * Group blocks into chunks of roughly targetChars that never cross a heading.
 *
 * @param {TextBlock[]} blocks
 * @param {number} [targetChars]
 * @returns {Chunk[]}
 */
export function buildChunks(blocks, targetChars = CHUNK_TARGET_CHARS) {
  blocks = demoteDenseHeadings(blocks);
  const chunks = [];
  const headingStack = [];
  let section = 0;
  let level = 0;
  let current = null;

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = null;
    }
  };
  const start = (text, startsSection) => {
    current = {
      text,
      headings: headingStack.map(h => h.text),
      section,
      level,
      startsSection,
    };
  };

  for (const block of blocks) {
    // Keep the indentation of the first line of code.
    const text =
      block.kind == "code"
        ? block.text.replace(/^\s*\n|\s+$/g, "")
        : block.text.trim();
    if (!text) {
      continue;
    }
    if (block.headingLevel) {
      flush();
      while (headingStack.at(-1)?.level >= block.headingLevel) {
        headingStack.pop();
      }
      headingStack.push({
        level: block.headingLevel,
        text: stripLinks(text)
          .replace(/[\s¶#]+$/, "")
          .replace(/\s+/g, " ")
          .slice(0, MAX_HEADING_CHARS),
      });
      section++;
      level = block.headingLevel;
      start(text, true);
      continue;
    }
    const isCode = block.kind == "code";
    for (const piece of splitLongText(text, targetChars, isCode)) {
      // Code usually follows the sentence that introduces it ("Run this:"),
      // so keep its first piece in the same chunk.
      const introduced = isCode && current?.text.trimEnd().endsWith(":");
      if (
        current &&
        !introduced &&
        current.text.length + piece.length >= targetChars
      ) {
        if (current.startsSection && current.text.length < targetChars / 4) {
          current.text += "\n" + piece;
          flush();
          continue;
        }
        flush();
      }
      if (current) {
        current.text += "\n" + piece;
      } else {
        start(piece, false);
      }
    }
  }
  flush();
  return chunks;
}

const stopWords = new CountVectorizer().stopWords;

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = words.filter(word => !stopWords.has(word));
  // A query made only of stop words still asks for something.
  return kept.length ? kept : words;
}

const FTS5_TOKENIZER = "porter unicode61 remove_diacritics 2";
const FTS5_WORDS_TOKENIZER = "unicode61 remove_diacritics 2";

/**
 * Chunks indexed by SQLite FTS5 in a short-lived in-memory database, which
 * ranks them with BM25 off the main thread. Close it when done.
 */
export class PageIndex {
  #storage;
  #db;
  #count;

  /**
   * How many chunks contain each word, before stemming.
   *
   * @type {Map<string, number>}
   */
  vocabulary = new Map();

  /**
   * @param {mozIStorageAsyncConnection} connection
   * @param {OpenedConnection} db - The Sqlite.sys.mjs wrapper of connection.
   * @param {number} count - Number of chunks.
   */
  constructor(connection, db, count) {
    this.#storage = connection;
    this.#db = db;
    this.#count = count;
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<PageIndex>}
   */
  static async create(texts) {
    const connection = await new Promise((resolve, reject) =>
      Services.storage.openAsyncDatabase("memory", 0, 0, (status, db) =>
        Components.isSuccessCode(status)
          ? resolve(db.QueryInterface(Ci.mozIStorageAsyncConnection))
          : reject(new Error(`Could not open the page index: ${status}`))
      )
    );
    let db;
    try {
      await new Promise((resolve, reject) =>
        connection.loadExtension("fts5", status =>
          Components.isSuccessCode(status)
            ? resolve()
            : reject(new Error(`Could not load FTS5: ${status}`))
        )
      );
      db = await lazy.Sqlite.wrapStorageConnection({ connection });
      await db.execute(
        `CREATE VIRTUAL TABLE chunks USING fts5(body, tokenize = "${FTS5_TOKENIZER}")`
      );
      await db.execute(
        `CREATE VIRTUAL TABLE words USING fts5(body, tokenize = "${FTS5_WORDS_TOKENIZER}")`
      );
      await db.execute(
        "CREATE VIRTUAL TABLE vocabulary USING fts5vocab(words, row)"
      );
      const rows = texts.map((body, id) => ({ id, body }));
      if (rows.length) {
        await db.execute(
          "INSERT INTO chunks(rowid, body) VALUES (:id, :body)",
          rows
        );
        await db.execute(
          "INSERT INTO words(rowid, body) VALUES (:id, :body)",
          rows
        );
      }
      const index = new PageIndex(connection, db, texts.length);
      for (const row of await db.execute("SELECT term, doc FROM vocabulary")) {
        index.vocabulary.set(
          row.getResultByName("term"),
          row.getResultByName("doc")
        );
      }
      return index;
    } catch (error) {
      await db?.close();
      connection.asyncClose();
      throw error;
    }
  }

  /**
   * Replace tokens that are not on the page with the closest page word, so
   * typos still match, using mozStorage's levenshteinDistance. Short tokens
   * are left alone because too many words are a few edits apart, and typos
   * rarely change the first letter.
   *
   * @param {string[]} tokens
   * @returns {Promise<string[]>}
   */
  async correctTypos(tokens) {
    return Promise.all(
      tokens.map(async token => {
        if (token.length < FUZZY_MIN_LENGTH || this.vocabulary.has(token)) {
          return token;
        }
        // Swapped letters are one typo, but two edits for levenshteinDistance.
        for (let i = 0; i < token.length - 1; i++) {
          const swapped =
            token.slice(0, i) + token[i + 1] + token[i] + token.slice(i + 2);
          if (this.vocabulary.has(swapped)) {
            return swapped;
          }
        }
        const [row] = await this.#db.execute(
          `SELECT term, levenshteinDistance(term, :token) AS distance
           FROM vocabulary
           WHERE substr(term, 1, 1) = substr(:token, 1, 1)
             AND abs(length(term) - length(:token)) <= :limit
             AND distance <= :limit
           ORDER BY distance, doc DESC
           LIMIT 1`,
          { token, limit: FUZZY_MAX_EDITS }
        );
        return row?.getResultByName("term") ?? token;
      })
    );
  }

  /**
   * BM25 score of every chunk against the tokens.
   *
   * @param {string[]} tokens
   * @param {boolean} [normalize] - Scale the scores so the best is 1.
   * @returns {Promise<number[]>}
   */
  async scores(tokens, normalize = true) {
    const scores = new Array(this.#count).fill(0);
    const unique = [...new Set(tokens)];
    if (unique.length) {
      const rows = await this.#db.execute(
        "SELECT rowid, bm25(chunks) AS score FROM chunks WHERE chunks MATCH :query",
        { query: unique.map(token => `"${token}"`).join(" OR ") }
      );
      // FTS5 reports better matches as more negative.
      for (const row of rows) {
        scores[row.getResultByName("rowid")] = -row.getResultByName("score");
      }
    }
    const max = Math.max(0, ...scores);
    return max && normalize ? scores.map(score => score / max) : scores;
  }

  async close() {
    await this.#db.close();
    await new Promise(resolve => this.#storage.asyncClose(resolve));
  }
}

/**
 * @param {Chunk} chunk
 * @returns {string}
 */
function textForRanking(chunk) {
  const text = stripLinks(chunk.text);
  // Every chunk is indexed with its full heading path, as the section it
  // opens already starts with its own heading.
  return [
    ...(chunk.startsSection ? chunk.headings.slice(0, -1) : chunk.headings),
    text,
  ].join("\n");
}

/**
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncate(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars < 2) {
    return "";
  }
  const pieces = splitLongText(text, maxChars - 1);
  return pieces[0] + "…";
}

/**
 * @param {string} label
 * @param {string[]} items
 * @param {number} maxChars
 * @returns {string} "[label: item · item · …]", cut between items so that it
 *   stays a line get_page_content adds, ending with "]".
 */
function listLine(label, items, maxChars) {
  const kept = [];
  let length = label.length + 4;
  for (const item of items) {
    length += item.length + 3;
    if (length > maxChars - 4 && kept.length) {
      return `[${label}: ${kept.join(" · ")} · …]`;
    }
    kept.push(item);
  }
  return `[${label}: ${kept.join(" · ")}]`;
}

/**
 * How long each top-level section of the page is, which a read can't show,
 * for questions about the page's structure.
 *
 * @param {Chunk[]} chunks
 * @returns {string} A "[Section lengths in characters: …]" line, longest
 *   first, or "" for a page with fewer than two sections.
 */
function sectionLengths(chunks) {
  const levels = chunks
    .filter((chunk, i) => chunk.startsSection && i > 0)
    .map(chunk => chunk.level);
  // The highest heading level with at least two sections, so that the page
  // title isn't a section of its own.
  const level = [...new Set(levels)]
    .sort((a, b) => a - b)
    .find(l => levels.filter(other => other == l).length > 1);
  if (level === undefined) {
    return "";
  }
  const sections = [];
  for (const [i, chunk] of chunks.entries()) {
    if (i == 0 || (chunk.startsSection && chunk.level <= level)) {
      sections.push({
        heading:
          chunk.startsSection && chunk.level == level
            ? chunk.headings.at(-1)
            : "Start of the page",
        length: 0,
      });
    }
    if (sections.length) {
      sections.at(-1).length += chunk.text.length;
    }
  }
  const lengths = sections
    .filter(({ heading }) => /\p{L}/u.test(heading ?? ""))
    .sort((a, b) => b.length - a.length)
    .map(
      ({ heading, length }) =>
        `${heading} ${(Math.round(length / 100) * 100).toLocaleString("en-US")}`
    );
  return lengths.length > 1
    ? listLine("Section lengths in characters", lengths, SECTION_LENGTHS_CHARS)
    : "";
}

/**
 * @param {string} read - A first read of a page, starting with its header.
 * @param {string} line - A line to add after the header, or "".
 * @returns {string}
 */
function withLineAfterHeader(read, line) {
  if (!line) {
    return read;
  }
  const end = read.indexOf("\n");
  return end < 0
    ? `${line}\n${read}`
    : `${read.slice(0, end)}\n${line}${read.slice(end)}`;
}

/**
 * Pick the chunks that open a section, at the deepest heading level where
 * every section still gets at least minShare characters of the budget. Pages
 * without headings, or with most of their text before the first one, get
 * evenly spaced chunks instead. The first chunk is the lead and never counts
 * as an opening.
 *
 * @param {Chunk[]} chunks
 * @param {number} budget
 * @param {number} minShare
 * @returns {number[]} Chunk indexes in document order.
 */
function pickOpenings(chunks, budget, minShare) {
  const maxCount = Math.max(1, Math.floor(budget / minShare));
  const openings = chunks
    .map((chunk, i) => (chunk.startsSection && i > 0 ? i : -1))
    .filter(i => i > 0);
  const length = list => list.reduce((sum, c) => sum + c.text.length, 0);
  if (
    !openings.length ||
    length(chunks.slice(0, openings[0])) >
      HEADINGLESS_LEAD_SHARE * length(chunks)
  ) {
    const count = Math.min(maxCount, chunks.length - 1);
    const step = (chunks.length - 1) / (count + 1);
    return [
      ...new Set(
        Array.from({ length: count }, (_, k) => Math.round(step * (k + 1)))
      ),
    ].filter(i => i > 0);
  }
  const levels = [...new Set(openings.map(i => chunks[i].level))].sort(
    (a, b) => b - a
  );
  let shown = openings;
  for (const maxLevel of levels) {
    shown = openings.filter(i => chunks[i].level <= maxLevel);
    if (shown.length <= maxCount) {
      return shown;
    }
  }
  return shown.slice(0, maxCount);
}

/**
 * List the headings of sections that get no opening, so the model knows they
 * exist and can ask for them.
 *
 * @param {Chunk[]} chunks
 * @param {number[]} openings - The section openings that are shown.
 * @param {Iterable<number>} [included] - Other chunks that are shown, whose
 *   sections aren't listed either.
 * @param {number} [maxChars]
 * @returns {string} A "[Other sections: …]" line, or "" when all are shown.
 */
function otherSections(
  chunks,
  openings,
  included = [],
  maxChars = OTHER_SECTIONS_CHARS
) {
  const shown = new Set([...openings, ...included].map(i => chunks[i].section));
  const levels = openings.map(i => chunks[i].level);
  // Headings above the openings' levels, such as the page title, aren't
  // sections of their own.
  const minLevel = Math.min(...levels);
  const maxLevel = Math.max(0, ...levels);
  const headings = chunks
    .filter(
      chunk =>
        chunk.startsSection &&
        chunk.level >= minLevel &&
        chunk.level <= maxLevel &&
        !shown.has(chunk.section) &&
        /\p{L}/u.test(chunk.headings.at(-1))
    )
    .map(chunk => chunk.headings.at(-1));
  if (!headings.length) {
    return "";
  }
  return listLine("Other sections", headings, maxChars);
}

/**
 * Show the lead, the opening of each section, and the chunks that score best
 * against the query with their neighbours, in document order with gap
 * markers. The section openings keep broad questions answerable even when
 * the query matches little.
 *
 * @param {Chunk[]} chunks
 * @param {number[]} scores
 * @param {object} options
 * @param {number} options.budget
 * @param {string} options.query
 * @param {number} options.totalLength
 * @param {number} [options.neighbourHits] - How many top chunks also get
 *   their neighbours.
 * @param {number} [options.maxAlternateQueries] - How many alternate queries a
 *   follow-up read may add, as the header tells the model.
 * @param {Set<number>} [options.shown] - Chunks an earlier call already
 *   returned. When set, this is a follow-up: no lead or section openings,
 *   only the best chunks not shown before.
 * @param {Map<number, string>} [options.partial] - For chunks an earlier
 *   call returned only the start of, the rest of their text.
 * @returns {string}
 */
export function selectForQuery(
  chunks,
  scores,
  {
    budget,
    query,
    totalLength,
    neighbourHits = NEIGHBOUR_HITS,
    maxAlternateQueries = DEFAULT_ALTERNATE_QUERIES,
    shown,
    partial,
  }
) {
  const quoted = `"${truncate(query.replace(/\s+/g, " "), MAX_QUERY_CHARS)}"`;
  const order = scores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => b.score - a.score)
    .map(({ i }) => i);
  if (shown && chunks.every((_, i) => shown.has(i))) {
    return `[No other part of this page is left; earlier results showed all of it.]`;
  }
  const about = length => `about ${Math.ceil(length / 100) * 100}`;
  const header = (
    shownLength,
    filler,
    unshownMatches,
    matchLength,
    unread,
    weakMatches
  ) => {
    let text;
    if (!shown) {
      text =
        `[This page has ${totalLength} characters, more than fit. Showing ` +
        `${shownLength} of them: the start of the page, the opening of each ` +
        `section, and the parts most relevant to ${quoted}; omitted parts ` +
        `are marked with […].`;
    } else if (filler == shownLength) {
      text =
        `[More of this page (${totalLength} characters): ${shownLength} ` +
        `characters that earlier results did not include. None of them ` +
        `contain the words of ${quoted}; they are the rest of the page in ` +
        `page order. Omitted parts are marked with […].`;
    } else {
      text =
        `[More of this page (${totalLength} characters): ${shownLength} ` +
        `characters that earlier results did not include: the parts most ` +
        `relevant to ${quoted}` +
        (filler
          ? `, then ${filler} characters of the rest of the page in page order.`
          : `.`) +
        ` Omitted parts are marked with […].`;
    }
    if (unshownMatches) {
      text +=
        ` ${unshownMatches} more parts of the page (${about(matchLength)} ` +
        `characters) match well and are not shown.`;
    } else if (weakMatches) {
      text +=
        ` ${weakMatches} more parts contain some of these words but match ` +
        `less well; ${about(unread)} characters are not shown.`;
    } else if (unread) {
      text += ` No other part uses these words, but ${about(unread)} characters are not shown.`;
    } else {
      text += ` Nothing else on the page is left to read.`;
    }
    if (!shown) {
      return (
        text +
        ` To read more of it, call get_page_content again for this page ` +
        `with a query, up to ${maxAlternateQueries} alternate_queries in other ` +
        `words the page may use, and max_characters for how much to return; ` +
        `earlier results are kept and not repeated.]`
      );
    }
    return unshownMatches || unread
      ? text +
          ` To read the rest in page order, call get_page_content again ` +
          `with start_at; a negative number counts from the end.]`
      : text + `]`;
  };

  const longestHeader = Math.max(
    ...[0, 1, totalLength].map(
      filler => header(totalLength, filler, 0, 0, totalLength).length
    ),
    header(totalLength, 1, chunks.length, totalLength, 0).length,
    header(totalLength, 1, 0, 0, totalLength, chunks.length).length
  );
  let remaining = budget - longestHeader - "\n[…]".length;
  /** @type {Map<number, string>} */
  const selected = new Map();
  // Each part costs its newline, plus a "[…]" line before it and, for a
  // chunk in the middle of a section, a "[section: …]" line.
  const marker = i =>
    chunks[i].startsSection
      ? 5
      : 17 + chunks[i].headings.join(HEADING_SEPARATOR).length;
  const fullText = i => partial?.get(i) ?? chunks[i]?.text;
  const take = (i, text = fullText(i)) => {
    if (i < 0 || i >= chunks.length || shown?.has(i)) {
      return;
    }
    const previous = selected.get(i);
    if (previous?.length >= text.length) {
      return;
    }
    const cost = previous
      ? text.length - previous.length
      : text.length + marker(i);
    if (cost <= remaining) {
      selected.set(i, text);
      remaining -= cost;
    }
  };

  let outlineOpenings = null;
  if (!shown) {
    take(0);
    const skeletonBudget = remaining * SKELETON_BUDGET_SHARE;
    const openings = pickOpenings(chunks, skeletonBudget, MIN_SKELETON_SHARE);
    const outline = otherSections(
      chunks,
      openings,
      [],
      OTHER_SECTIONS_QUERY_CHARS
    );
    if (outline) {
      // Listed at the end, without the sections the hits come from.
      outlineOpenings = openings;
      remaining -= outline.length + 1;
    }
    const share = Math.floor(skeletonBudget / Math.max(1, openings.length));
    for (const i of openings) {
      const room = share - marker(i);
      if (room >= MIN_SKELETON_SHARE / 2) {
        take(i, truncate(chunks[i].text, room));
      }
    }
  }

  const withNeighbours = i => {
    if (selected.get(i) == fullText(i)) {
      take(i + 1);
      if (!chunks[i].startsSection) {
        take(i - 1);
      }
    }
  };
  for (const i of order.slice(0, neighbourHits)) {
    take(i);
    withNeighbours(i);
  }
  // Ties keep page order, so parts that match none of the words fill the
  // rest of the budget in page order.
  for (const i of order) {
    take(i);
  }

  const minMatch = Math.max(...scores) * REMAINING_MATCH_SHARE;
  const unshownMatches = order.filter(
    i => scores[i] > 0 && !selected.has(i) && !shown?.has(i)
  );
  const unshown = unshownMatches.filter(i => scores[i] >= minMatch);
  const length = texts => texts.reduce((sum, text) => sum + text.length, 0);
  const unread = chunks
    .map((_, i) => i)
    .filter(i => !shown?.has(i))
    .reduce(
      (sum, i) => sum + fullText(i).length - (selected.get(i)?.length ?? 0),
      0
    );
  const shownLength = length([...selected.values()]);
  const filler = length(
    [...selected].filter(([i]) => !(scores[i] > 0)).map(([, t]) => t)
  );
  const parts = [
    header(
      shownLength,
      // A short part next to a match is context, not the rest of the page.
      filler < MIN_FILLER_CHARS && filler < shownLength ? 0 : filler,
      unshown.length,
      length(unshown.map(fullText)),
      unread,
      unshownMatches.length - unshown.length
    ),
  ];
  for (let i = 0; i < chunks.length; i++) {
    if (!selected.has(i)) {
      if (selected.has(i - 1) || i == 0) {
        parts.push("[…]");
      }
      continue;
    }
    const chunk = chunks[i];
    if (!selected.has(i - 1) && !chunk.startsSection && chunk.headings.length) {
      parts.push(`[section: ${chunk.headings.join(HEADING_SEPARATOR)}]`);
    }
    parts.push(selected.get(i));
  }
  const others =
    outlineOpenings &&
    otherSections(
      chunks,
      outlineOpenings,
      selected.keys(),
      OTHER_SECTIONS_QUERY_CHARS
    );
  if (others) {
    parts.push(others);
  }
  return parts.join("\n");
}

/**
 * Give the start of the page and the opening of each section, for questions
 * that need the whole page rather than one part of it.
 *
 * @param {Chunk[]} chunks
 * @param {object} options
 * @param {number} options.budget
 * @param {number} options.totalLength
 * @param {Map<number, string>} [options.unseen] - When set, continue each
 *   section after what earlier results showed instead (see selectCoverage).
 * @returns {string}
 */
export function selectOverview(chunks, { budget, totalLength, unseen }) {
  if (unseen) {
    return selectCoverage(chunks, { budget, totalLength, unseen });
  }
  const header = shown =>
    `[This page has ${totalLength} characters, more than fit. Showing the ` +
    `start of the page and the beginning of each section, about ` +
    `${Math.max(1, Math.round((100 * shown) / totalLength))}% of the page. ` +
    `If the answer needs more detail than this, call get_page_content again ` +
    `with a query and max_characters instead of answering from general ` +
    `knowledge.]`;
  let remaining = budget - header(totalLength).length;
  const parts = [];

  const openings = pickOpenings(
    chunks,
    remaining * (1 - LEAD_BUDGET_SHARE),
    MIN_SECTION_SHARE
  );
  const outline = otherSections(chunks, openings);
  remaining -= outline ? outline.length + 1 : 0;
  let lead = "";
  const leadBudget = remaining * LEAD_BUDGET_SHARE;
  for (let i = 0; i < (openings[0] ?? chunks.length); i++) {
    const next = lead ? lead + "\n" + chunks[i].text : chunks[i].text;
    if (next.length > leadBudget) {
      lead = lead || truncate(chunks[i].text, leadBudget);
      break;
    }
    lead = next;
  }
  parts.push(lead);
  remaining -= lead.length + 1;

  const texts = openings.map((start, k) =>
    chunks
      .slice(start, openings[k + 1] ?? chunks.length)
      .map(c => c.text)
      .join("\n")
  );
  // Sections shorter than an even share pass what they don't use on to the
  // longer ones.
  const rooms = new Array(texts.length);
  let left = remaining;
  let open = texts.map((_, k) => k);
  while (open.length) {
    const share = Math.floor(left / open.length);
    const fits = open.filter(k => texts[k].length + 5 <= share);
    if (!fits.length) {
      open.forEach(k => (rooms[k] = share));
      break;
    }
    for (const k of fits) {
      rooms[k] = texts[k].length + 5;
      left -= rooms[k];
    }
    open = open.filter(k => !fits.includes(k));
  }
  texts.forEach((text, k) => parts.push("[…]", truncate(text, rooms[k] - 5)));
  parts.push("[…]");
  if (outline) {
    parts.push(outline);
  }
  const body = parts.join("\n");
  const shown = body.replace(/^\[(?:…|Other sections: .*)\]$/gm, "").length;
  return header(shown) + "\n" + body;
}

/**
 * Follow-up for broad questions: continue every section where earlier
 * results stopped, sharing the budget evenly.
 *
 * @param {Chunk[]} chunks
 * @param {object} options
 * @param {number} options.budget
 * @param {number} options.totalLength
 * @param {Map<number, string>} options.unseen - Text of each chunk that
 *   earlier results did not include, empty when fully shown.
 * @returns {string}
 */
function selectCoverage(chunks, { budget, totalLength, unseen }) {
  const header =
    `[Showing more of this page (${totalLength} characters): the next part ` +
    `of each section that earlier results did not include; omitted parts ` +
    `are marked with […].]`;
  const openings = pickOpenings(chunks, budget, MIN_SECTION_SHARE);
  const starts = openings[0] > 0 ? [0, ...openings] : openings;
  const sections = starts
    .map((start, k) => {
      const end = starts[k + 1] ?? chunks.length;
      const text = chunks
        .slice(start, end)
        .map((chunk, i) => unseen.get(start + i) ?? chunk.text)
        .filter(Boolean)
        .join("\n");
      const path = chunks[start].headings.join(HEADING_SEPARATOR);
      return { text, label: path ? `[section: ${path}]` : "" };
    })
    .filter(section => section.text);
  let remaining = budget - header.length - "\n[…]".length;
  const parts = [header];
  const share = Math.floor(remaining / Math.max(1, sections.length));
  for (const { text, label } of sections) {
    const room = share - label.length - "\n[…]\n\n".length;
    if (room < MIN_SKELETON_SHARE) {
      continue;
    }
    parts.push("[…]", ...(label ? [label] : []), truncate(text, room));
  }
  parts.push("[…]");
  return parts.join("\n");
}

/**
 * Read the page in order from a position instead of by relevance, skipping
 * what earlier results showed.
 *
 * @param {Chunk[]} chunks
 * @param {object} options
 * @param {number} options.budget
 * @param {number} options.totalLength
 * @param {number} options.start - Where to start in the page text.
 * @param {number[]} options.offsets - Where each chunk starts in the page text.
 * @param {string[]} options.unseen - Text of each chunk earlier results did
 *   not include, empty when fully shown.
 * @returns {string}
 */
function selectInOrder(
  chunks,
  { budget, totalLength, start, offsets, unseen }
) {
  const end = i => offsets[i + 1] ?? totalLength;
  const first = chunks.findIndex((_, i) => end(i) > start);
  const header = (from, to, skipped) =>
    `[Characters ${from}–${to} of this page (${totalLength} characters), ` +
    `in page order${skipped ? ", skipping parts shown earlier" : ""}; ` +
    `omitted parts are marked with […]. ` +
    (to < totalLength
      ? `To read on, call get_page_content again with start_at ${to}.]`
      : `This is the end of the page.]`);
  if (first < 0 || !unseen.slice(first).some(Boolean)) {
    return (
      `[Nothing from character ${start} on that earlier results didn't ` +
      `already show; this page has ${totalLength} characters.]`
    );
  }
  const marker = i =>
    chunks[i].startsSection
      ? 5
      : 17 + chunks[i].headings.join(HEADING_SEPARATOR).length;
  let remaining =
    budget - header(totalLength, totalLength, true).length - "\n[…]".length;
  /** @type {Map<number, string>} */
  const selected = new Map();
  let to = offsets[first];
  let skipped = false;
  for (let i = first; i < chunks.length; i++) {
    const text = unseen[i];
    if (!text) {
      skipped = true;
      to = end(i);
      continue;
    }
    const cost = text.length + marker(i);
    if (cost > remaining) {
      const room = remaining - marker(i);
      if (room >= MIN_SKELETON_SHARE) {
        selected.set(i, truncate(text, room));
        to = offsets[i] + Math.round(((end(i) - offsets[i]) * room) / cost);
      }
      break;
    }
    selected.set(i, text);
    remaining -= cost;
    to = end(i);
  }
  const parts = [header(offsets[first], to, skipped)];
  for (let i = first; i < chunks.length; i++) {
    if (!selected.has(i)) {
      if (selected.has(i - 1) || i == first) {
        parts.push("[…]");
      }
      continue;
    }
    const chunk = chunks[i];
    if (!selected.has(i - 1) && !chunk.startsSection && chunk.headings.length) {
      parts.push(`[section: ${chunk.headings.join(HEADING_SEPARATOR)}]`);
    }
    parts.push(selected.get(i));
  }
  return parts.join("\n");
}

/**
 * @param {Chunk} chunk
 * @param {string} previous - Earlier results with whitespace squashed.
 * @returns {string} The part of the chunk not in previous.
 */
function unseenText(chunk, previous) {
  const text = chunk.text.replace(/\s+/g, " ");
  if (previous.includes(text)) {
    return "";
  }
  if (!previous.includes(text.slice(0, UNSEEN_PREFIX_CHARS))) {
    return chunk.text;
  }
  let shown = UNSEEN_PREFIX_CHARS;
  let high = text.length;
  while (shown < high) {
    const mid = (shown + high + 1) >> 1;
    if (previous.includes(text.slice(0, mid))) {
      shown = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(shown).trim();
}

/**
 * Fit extracted page text into the budget. Text that already fits is
 * returned unchanged.
 *
 * @param {object} options
 * @param {string} options.text
 * @param {TextBlock[]} [options.blocks]
 * @param {string} [options.query] - What the model is looking for. Without
 *   one, an overview of the page is returned.
 * @param {number} options.budget
 * @param {object} [options.options] - DEFAULT_PAGE_STRATEGIES has what
 *   get_page_content uses on a first read: stripLinks (send link labels
 *   without URLs) and fuzzy (match query words that are not on the page to
 *   the closest page word). Follow-ups add previous (the text of earlier
 *   results for this page: return only chunks they did not include, without
 *   lead or section openings), queries (up to maxAlternateQueries more queries,
 *   whose BM25 scores add to the query's), coverage (with previous: continue every section
 *   where previous stopped instead of matching the query) and startAt (read
 *   the page in order from this character, negative from the end).
 *   maxAlternateQueries sets how many queries a follow-up may add.
 * @returns {Promise<string>}
 */
export async function fitPageContent({
  text,
  blocks,
  query,
  budget,
  options = {},
}) {
  if (text.length <= budget) {
    return text;
  }
  if (options.stripLinks) {
    // Before chunking, so that chunk sizes count the text that is sent, and
    // a chunk boundary can't split a link and leave its URL behind.
    text = stripLinks(text);
    blocks = blocks?.map(block => ({ ...block, text: stripLinks(block.text) }));
  }
  const chunks = buildChunks(blocks ?? blocksFromText(text));
  // Where each chunk starts in the page text.
  const offsets = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const at = text.indexOf(chunk.text.slice(0, 40), cursor);
    offsets.push(at < 0 ? cursor : at);
    // A chunk is never longer than the page text it comes from, so the next
    // one starts after it, even where the page repeats itself.
    cursor = at < 0 ? cursor : at + chunk.text.length;
  }
  if (!chunks.length) {
    return text.slice(0, budget);
  }
  const totalLength = text.length;
  if (Number.isInteger(options.startAt)) {
    const previous = (options.previous ?? "").replace(/\s+/g, " ");
    return selectInOrder(chunks, {
      budget,
      totalLength,
      start:
        options.startAt < 0
          ? Math.max(0, totalLength + options.startAt)
          : Math.min(options.startAt, totalLength),
      offsets,
      unseen: chunks.map(chunk =>
        previous ? unseenText(chunk, previous) : chunk.text
      ),
    });
  }
  if (options.coverage && options.previous) {
    const previous = options.previous.replace(/\s+/g, " ");
    return selectOverview(chunks, {
      budget,
      totalLength,
      unseen: new Map(
        chunks.map((chunk, i) => [i, unseenText(chunk, previous)])
      ),
    });
  }
  // A first read says how long each section is; follow-ups already did.
  const lengthsLine = options.previous ? "" : sectionLengths(chunks);
  const firstBudget = budget - (lengthsLine ? lengthsLine.length + 1 : 0);
  if (!query?.trim()) {
    return withLineAfterHeader(
      selectOverview(chunks, { budget: firstBudget, totalLength }),
      lengthsLine
    );
  }
  const maxAlternateQueries =
    options.maxAlternateQueries ?? DEFAULT_ALTERNATE_QUERIES;
  // A follow-up also carries over the earlier query.
  const extraQueries = (options.queries ?? [])
    .filter(q => q?.trim())
    .slice(0, maxAlternateQueries + 1);
  const texts = chunks.map(textForRanking);
  const index = await PageIndex.create(texts);
  try {
    const tokenLists = await Promise.all(
      [query, ...extraQueries].map(q => {
        const tokens = tokenize(q);
        return options.fuzzy ? index.correctTypos(tokens) : tokens;
      })
    );
    const selection = {
      budget: firstBudget,
      query,
      totalLength,
      maxAlternateQueries,
    };
    if (options.previous) {
      const previous = options.previous.replace(/\s+/g, " ");
      selection.shown = new Set();
      selection.partial = new Map();
      chunks.forEach((chunk, i) => {
        const unseen = unseenText(chunk, previous);
        if (!unseen) {
          selection.shown.add(i);
        } else if (unseen != chunk.text) {
          selection.partial.set(i, unseen);
        }
      });
    }
    // Raw BM25 keeps how well each query matches, so a vague query cannot
    // push out the strong matches of another.
    const raw = await Promise.all(
      tokenLists.map(tokens => index.scores(tokens, false))
    );
    const scores = raw[0].map((_, i) => raw.reduce((sum, s) => sum + s[i], 0));
    return withLineAfterHeader(
      selectForQuery(chunks, scores, {
        ...selection,
        neighbourHits: Math.max(NEIGHBOUR_HITS, tokenLists.length),
      }),
      lengthsLine
    );
  } finally {
    await index.close();
  }
}
