/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {
  DEFAULT_PAGE_STRATEGIES,
  PageIndex,
  blocksFromText,
  buildChunks,
  fitPageContent,
  selectForQuery,
  selectOverview,
  tokenize,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/PageContentChunker.sys.mjs"
);

/**
 * @param {string} query
 * @param {object[]} chunks - From buildChunks.
 * @returns {Promise<number[]>} BM25 score of each chunk, the best scaled to 1.
 */
async function scoreChunks(query, chunks) {
  const index = await PageIndex.create(chunks.map(chunk => chunk.text));
  try {
    return await index.scores(tokenize(query));
  } finally {
    await index.close();
  }
}

function paragraph(topic, n = 6) {
  return Array.from(
    { length: n },
    (_, i) => `Sentence ${i} is about ${topic} and nothing else.`
  ).join(" ");
}

function longPage() {
  const blocks = [
    { text: "Intro", headingLevel: 1 },
    { text: paragraph("the introduction"), headingLevel: 0 },
  ];
  for (const [title, topic] of [
    ["History", "the early years"],
    ["Features", "tabs and extensions"],
    ["Security", "sandboxing and patches"],
    ["Reception", "market share"],
  ]) {
    blocks.push({ text: title, headingLevel: 2 });
    for (let i = 0; i < 8; i++) {
      blocks.push({ text: paragraph(topic), headingLevel: 0 });
    }
  }
  blocks.push({ text: "Sandbox details", headingLevel: 3 });
  blocks.push({
    text: "The zebra-crossing sandbox shipped in version 57.",
    headingLevel: 0,
  });
  return blocks;
}

add_task(function test_blocksFromText() {
  Assert.deepEqual(blocksFromText("a\n\n  b \n"), [
    { text: "a", headingLevel: 0 },
    { text: "b", headingLevel: 0 },
  ]);
});

add_task(function test_buildChunks_respects_headings_and_size() {
  const chunks = buildChunks(longPage(), 400);
  for (const chunk of chunks) {
    Assert.lessOrEqual(chunk.text.length, 800, "Chunks stay near the target.");
  }
  const last = chunks.at(-1);
  Assert.deepEqual(last.headings, ["Intro", "Reception", "Sandbox details"]);
  Assert.ok(last.startsSection, "A heading opens a new chunk.");
  Assert.ok(
    chunks.every(c => !c.text.includes("History\n") || c.startsSection),
    "Headings only appear at the start of a chunk."
  );
  const historyChunks = chunks.filter(c => c.headings.at(-1) == "History");
  Assert.greater(historyChunks.length, 1, "Long sections are split.");
  Assert.ok(
    historyChunks.every(c => c.section == historyChunks[0].section),
    "Chunks of one section share its id."
  );
});

add_task(function test_buildChunks_splits_long_blocks() {
  const chunks = buildChunks(
    [{ text: paragraph("one long block", 60), headingLevel: 0 }],
    500
  );
  Assert.greater(chunks.length, 1);
  Assert.ok(chunks.every(c => c.text.length <= 500));
  Assert.ok(
    chunks.slice(0, -1).every(c => c.text.endsWith(".")),
    "Long blocks split at sentence ends."
  );
});

add_task(function test_buildChunks_splits_cjk_at_sentence_ends() {
  const sentence = "東京タワーは、東京都港区芝公園にある総合電波塔です。";
  const chunks = buildChunks(
    [{ text: sentence.repeat(40), headingLevel: 0 }],
    500
  );
  Assert.greater(chunks.length, 1);
  Assert.ok(
    chunks.every(c => c.text.endsWith("。")),
    "Text without spaces splits at sentence ends."
  );
});

add_task(function test_tokenize() {
  Assert.deepEqual(tokenize("The Firefox 57 Quantum, für Käse!"), [
    "firefox",
    "57",
    "quantum",
    "für",
    "käse",
  ]);
  Assert.deepEqual(
    tokenize("Is there anything beyond that?"),
    ["is", "there", "anything", "beyond", "that"],
    "A query made only of stop words keeps them."
  );
});

add_task(async function test_PageIndex_scores() {
  const index = await PageIndex.create([
    "nothing relevant here",
    "the sandbox is good",
    "the zebra sandbox",
  ]);
  const scores = await index.scores(tokenize("zebra sandbox"));
  await index.close();
  Assert.equal(scores[0], 0);
  Assert.equal(scores[2], 1, "Best match is scaled to 1.");
  Assert.greater(scores[2], scores[1]);
});

add_task(async function test_selectForQuery_finds_late_content() {
  const blocks = longPage();
  const chunks = buildChunks(blocks, 400);
  const totalLength = blocks.reduce((n, b) => n + b.text.length + 1, 0);
  const budget = 2500;
  Assert.greater(totalLength, budget * 3);

  const query = "When did the zebra-crossing sandbox ship?";
  const scores = await scoreChunks(query, chunks);
  const output = selectForQuery(chunks, scores, { budget, query, totalLength });
  info(output);

  Assert.lessOrEqual(output.length, budget, "Output fits the budget.");
  Assert.stringContains(output, "version 57", "The late answer is included.");
  Assert.stringContains(output, query, "The query is echoed.");
  for (const heading of ["History", "Features", "Security", "Reception"]) {
    Assert.stringContains(output, heading, `The ${heading} opening is shown.`);
  }
  Assert.stringContains(output, "the introduction", "The lead is included.");
  Assert.stringContains(output, "[…]", "Gaps are marked.");
  Assert.less(
    output.indexOf("the introduction"),
    output.indexOf("version 57"),
    "Chunks come out in document order."
  );
});

add_task(function test_selectOverview() {
  const blocks = longPage();
  const chunks = buildChunks(blocks, 400);
  const totalLength = blocks.reduce((n, b) => n + b.text.length + 1, 0);
  const budget = 2500;
  const output = selectOverview(chunks, { budget, totalLength });
  info(output);

  Assert.lessOrEqual(output.length, budget, "Output fits the budget.");
  for (const heading of ["History", "Features", "Security", "Reception"]) {
    Assert.stringContains(output, heading, `Section ${heading} is covered.`);
  }
  Assert.stringContains(output, "the introduction");
  Assert.stringContains(output, "market share", "The last section has a lead.");
});

add_task(function test_selectOverview_gives_unused_room_to_long_sections() {
  const blocks = [];
  for (let i = 0; i < 6; i++) {
    blocks.push({ text: `Short ${i}`, headingLevel: 2 });
    blocks.push({ text: `Brief note ${i}.`, headingLevel: 0 });
  }
  blocks.push({ text: "Long", headingLevel: 2 });
  for (let i = 0; i < 30; i++) {
    blocks.push({ text: paragraph(`detail ${i}`), headingLevel: 0 });
  }
  const chunks = buildChunks(blocks, 400);
  const totalLength = blocks.reduce((n, b) => n + b.text.length + 1, 0);
  const output = selectOverview(chunks, { budget: 3000, totalLength });
  info(output);
  Assert.lessOrEqual(output.length, 3000);
  Assert.greater(
    output.length,
    2500,
    "Room short sections don't use goes to the long one."
  );
  Assert.stringContains(output, "detail 3", "The long section gets more.");
  const percent = Number(output.match(/about (\d+)% of the page/)[1]);
  Assert.less(
    Math.abs(percent - (100 * output.length) / totalLength),
    5,
    "The header reports how much is shown."
  );
});

add_task(function test_selectOverview_too_many_sections() {
  const blocks = [{ text: paragraph("lead"), headingLevel: 0 }];
  for (let i = 0; i < 100; i++) {
    blocks.push({ text: `Heading ${i}`, headingLevel: 2 });
    blocks.push({ text: paragraph(`topic ${i}`), headingLevel: 0 });
  }
  const chunks = buildChunks(blocks, 400);
  const output = selectOverview(chunks, { budget: 3000, totalLength: 50000 });
  Assert.lessOrEqual(output.length, 3000);
  Assert.stringContains(output, "Heading 0");
  Assert.ok(
    !output.includes("Heading 99"),
    "Sections past the budget are cut."
  );
});

add_task(async function test_selectForQuery_broad_query_keeps_skeleton() {
  const blocks = longPage();
  const chunks = buildChunks(blocks, 400);
  const totalLength = blocks.reduce((n, b) => n + b.text.length + 1, 0);
  const query = "What is this page about?";
  const scores = await scoreChunks(query, chunks);
  const output = selectForQuery(chunks, scores, {
    budget: 2500,
    query,
    totalLength,
  });
  Assert.lessOrEqual(output.length, 2500);
  for (const topic of ["early years", "tabs and extensions", "market share"]) {
    Assert.stringContains(output, topic, `The ${topic} section has a lead.`);
  }
});

add_task(function test_selectOverview_without_headings() {
  const blocks = Array.from({ length: 40 }, (_, i) => ({
    text: paragraph(`part ${i}`),
    headingLevel: 0,
  }));
  const chunks = buildChunks(blocks, 400);
  const output = selectOverview(chunks, { budget: 3000, totalLength: 20000 });
  Assert.lessOrEqual(output.length, 3000);
  Assert.stringContains(output, "part 0 ");
  Assert.stringContains(output, "part 2", "Early parts are shown.");
  Assert.ok(
    ["part 30", "part 31", "part 32", "part 33", "part 34", "part 35"].some(p =>
      output.includes(p)
    ),
    "Late parts are shown."
  );
});

add_task(function test_buildChunks_strips_links_from_headings() {
  const chunks = buildChunks([
    {
      text: "[Syntax \\(old\\)](moz-nullprincipal:{abc}#syntax)¶",
      headingLevel: 2,
    },
    { text: "Body", headingLevel: 0 },
  ]);
  Assert.deepEqual(chunks[0].headings, ["Syntax (old)"]);
});

add_task(async function test_output_never_exceeds_budget() {
  const blocks = longPage();
  const totalLength = blocks.reduce((n, b) => n + b.text.length + 1, 0);
  for (const target of [200, 400, 800]) {
    const chunks = buildChunks(blocks, target);
    for (const query of ["sandbox", "What is this page about?", "market"]) {
      const scores = await scoreChunks(query, chunks);
      for (let budget = 1200; budget <= 4000; budget += 137) {
        const output = selectForQuery(chunks, scores, {
          budget,
          query,
          totalLength,
        });
        Assert.lessOrEqual(
          output.length,
          budget,
          `Fits ${budget} (chunks ${target}, "${query}")`
        );
      }
    }
  }
});

function pageWithBuriedFact() {
  const blocks = longPage();
  const history = blocks.findIndex(b => b.text == "History");
  blocks.splice(history + 6, 0, {
    text: "The walrus ledger opened in 1998.",
    headingLevel: 0,
  });
  return blocks;
}

add_task(async function test_fuzzy_matches_typos() {
  const blocks = pageWithBuriedFact();
  const text = blocks.map(b => b.text).join("\n");
  const fit = options =>
    fitPageContent({
      text,
      blocks,
      query: "Where is the walrsu ledgr?",
      budget: 2500,
      options,
    });
  Assert.ok(!(await fit({})).includes("walrus"), "Typos match nothing.");
  Assert.stringContains(
    await fit({ fuzzy: true }),
    "walrus ledger",
    "Typos are matched to the closest page word."
  );
  Assert.stringContains(
    await fitPageContent({
      text,
      blocks,
      query: "When did the ledgers open?",
      budget: 2500,
      options: {},
    }),
    "walrus ledger",
    "Other forms of a word match."
  );
});

add_task(async function test_correctTypos_swapped_letters() {
  const index = await PageIndex.create([
    "The causes of the war are disputed.",
    "Most cases were settled.",
  ]);
  try {
    Assert.deepEqual(
      await index.correctTypos(["casues", "cuases"]),
      ["causes", "causes"],
      "Swapped letters count as one typo."
    );
  } finally {
    await index.close();
  }
});

add_task(async function test_query_on_page_with_long_title_only() {
  const title = "A title long enough to fill the share of an opening, ".repeat(
    3
  );
  const blocks = [{ text: title, headingLevel: 1 }];
  for (let i = 0; i < 60; i++) {
    blocks.push({ text: paragraph(`topic ${i}`), headingLevel: 0 });
  }
  const text = blocks.map(b => b.text).join("\n");
  const output = await fitPageContent({
    text,
    blocks,
    query: "topic 42",
    budget: 10000,
  });
  Assert.lessOrEqual(output.length, 10000, "Output fits the budget.");
  Assert.stringContains(output, "about topic 42 ", "The match is included.");
});

add_task(async function test_overview_of_article_with_late_heading() {
  const blocks = [{ text: "Long read", headingLevel: 1 }];
  for (let i = 0; i < 50; i++) {
    blocks.push({
      text: `Paragraph ${i} of the story goes on for a while, with enough words to make it long. `.repeat(
        6
      ),
      headingLevel: 0,
    });
  }
  blocks.push({ text: "Most viewed", headingLevel: 2 });
  blocks.push({ text: "A popular story", headingLevel: 0 });
  const text = blocks.map(b => b.text).join("\n");
  const output = await fitPageContent({ text, blocks, budget: 10000 });
  Assert.greater(output.length, 8000, "The overview fills its budget.");
  Assert.stringContains(
    output,
    "Paragraph 45 ",
    "The overview reaches the end of the article."
  );
});

add_task(function test_buildChunks_keeps_code_with_its_introduction() {
  const listing = Array.from({ length: 200 }, (_, i) => `  step${i}();`).join(
    "\n"
  );
  const chunks = buildChunks([
    { text: "Setup", headingLevel: 2 },
    { text: paragraph("installing the tools", 10), headingLevel: 0 },
    { text: "Run this:", headingLevel: 0 },
    { text: listing, headingLevel: 0, kind: "code" },
  ]);
  const intro = chunks.find(c => c.text.includes("Run this:"));
  Assert.stringContains(
    intro.text,
    "Run this:\n  step0();",
    "The listing starts in the chunk that introduces it."
  );
  for (const chunk of chunks.filter(c => c.text.includes("step"))) {
    Assert.ok(
      chunk.text
        .split("\n")
        .every(
          line => !line.includes("step") || /^ {2}step\d+\(\);$/.test(line)
        ),
      "Code is only split between lines."
    );
  }
});

add_task(async function test_default_strategies_fit_budget() {
  const blocks = pageWithBuriedFact();
  const text = blocks.map(b => b.text).join("\n");
  for (let budget = 1200; budget <= 4000; budget += 311) {
    for (const query of ["sandbox", "walrsu ledgr", ""]) {
      const output = await fitPageContent({
        text,
        blocks,
        query,
        budget,
        options: DEFAULT_PAGE_STRATEGIES,
      });
      Assert.lessOrEqual(
        output.length,
        budget,
        `Fits ${budget} for "${query}"`
      );
    }
  }
});

function frontPage() {
  const blocks = [{ text: "Top stories", headingLevel: 2 }];
  for (let i = 0; i < 40; i++) {
    blocks.push({ text: `Teaser headline number ${i}`, headingLevel: 3 });
    blocks.push({ text: `Short summary of story ${i}.`, headingLevel: 0 });
  }
  for (const section of ["Sport", "Culture", "Science"]) {
    blocks.push({ text: section, headingLevel: 2 });
    for (let i = 0; i < 20; i++) {
      blocks.push({ text: `${section} teaser ${i}`, headingLevel: 3 });
      blocks.push({
        text: paragraph(section.toLowerCase(), 2),
        headingLevel: 0,
      });
    }
  }
  blocks.push({ text: "Ticker", headingLevel: 2 });
  for (let i = 0; i < 30; i++) {
    blocks.push({
      text: `Breaking item ${i}: a longer headline about what happened today`,
      headingLevel: 3,
    });
    blocks.push({ text: `${i + 1} minutes ago`, headingLevel: 0 });
  }
  return blocks;
}

add_task(function test_buildChunks_ignores_teaser_headings() {
  const chunks = buildChunks(frontPage());
  Assert.deepEqual(
    [...new Set(chunks.map(c => c.headings.join(" › ")))],
    ["Top stories", "Sport", "Culture", "Science", "Ticker"],
    "Headings that only label single teasers don't make sections."
  );
});

add_task(async function test_query_naming_a_section_gets_it() {
  const blocks = frontPage();
  const text = blocks.map(b => b.text).join("\n");
  const output = await fitPageContent({
    text,
    blocks,
    query: "Ticker",
    budget: 6000,
    options: DEFAULT_PAGE_STRATEGIES,
  });
  info(output);
  for (let i = 0; i < 30; i++) {
    Assert.stringContains(output, `Breaking item ${i}`);
  }
});

add_task(async function test_overview_lists_sections_that_do_not_fit() {
  const blocks = frontPage();
  const text = blocks.map(b => b.text).join("\n");
  const output = await fitPageContent({ text, blocks, budget: 1500 });
  info(output);
  Assert.lessOrEqual(output.length, 1500);
  Assert.ok(
    /\[Other sections: .*Ticker\]/.test(output),
    "Sections without an opening are listed by heading."
  );
});

add_task(async function test_long_blocks_are_split_without_breaking_links() {
  // Long enough with its URL to be split near the link, short enough without.
  const linked =
    "Words of a paragraph. ".repeat(34) +
    "It has [private browsing](https://example.com/wiki/Private_browsing) and more.";
  const blocks = [];
  for (let i = 0; i < 20; i++) {
    blocks.push({ text: `Section ${i}`, headingLevel: 2 });
    blocks.push({ text: linked, headingLevel: 0 });
  }
  const output = await fitPageContent({
    text: blocks.map(b => b.text).join("\n"),
    blocks,
    query: "private browsing",
    budget: 4000,
    options: DEFAULT_PAGE_STRATEGIES,
  });
  info(output);
  Assert.ok(!output.includes("]("), "No part of a link's URL is left.");
  Assert.stringContains(output, "It has private browsing and more.");
});

add_task(function test_segmentSentences_keeps_reference_markers() {
  const { segmentSentences } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/PageContentChunker.sys.mjs"
  );
  const sentences = text => segmentSentences(text).map(s => s.segment);
  Assert.deepEqual(sentences("It has a mode.[30][31] Next one. Last."), [
    "It has a mode.[30][31] ",
    "Next one. ",
    "Last.",
  ]);
  Assert.deepEqual(sentences("Until version 28).[40]"), [
    "Until version 28).[40]",
  ]);
  const text = "First one.[2] Second one.";
  Assert.deepEqual(
    segmentSentences(text).map(({ segment, index }) => [
      segment,
      text.slice(index, index + segment.length),
    ]),
    [
      ["First one.[2] ", "First one.[2] "],
      ["Second one.", "Second one."],
    ],
    "Indexes point at each sentence."
  );
});

add_task(function test_stripSamePageLinks() {
  const { stripSamePageLinks } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/PageContentChunker.sys.mjs"
  );
  const page = "https://en.wikipedia.org/wiki/Rust_(programming_language)";
  Assert.equal(
    stripSamePageLinks(
      "Released in 2015.[\\[1\\]](https://en.wikipedia.org/wiki/Rust_%28programming_language%29#cite_note-1) " +
        "See [History](#History), [Firefox](https://en.wikipedia.org/wiki/Firefox) " +
        "and [this page](https://en.wikipedia.org/wiki/Rust_(programming_language)",
      page
    ),
    "Released in 2015.[1] See History, [Firefox](https://en.wikipedia.org/wiki/Firefox) " +
      "and [this page](https://en.wikipedia.org/wiki/Rust_(programming_language)",
    "Links to places on the page lose their URL; links to other pages keep it."
  );
});
