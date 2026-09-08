/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const {
  buildVerbatimAnswerBlocks,
  formatDuration,
  ResearchAgent,
  parseResearchJson,
  renderReportMarkdown,
  renderResearchUsageSection,
  repairReportMarkdownHtml,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ResearchAgent.sys.mjs"
);

const { AITab } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/aitab/AITab.sys.mjs"
);

async function writeIndexedReport({
  id = crypto.randomUUID(),
  title = "Park Week Plan",
  description = "A week-long park itinerary.",
  question = "Plan my park week.",
  answer = "Day 1: Park A\n\nDay 2: Rest day",
  page = null,
} = {}) {
  const dir = PathUtils.join(PathUtils.profileDir, "smart-window-research");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const path = PathUtils.join(dir, `${id}.html`);
  const fileUri = PathUtils.toFileURI(path);
  const now = new Date().toISOString();
  await IOUtils.writeUTF8(
    path,
    `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<main>
<nav class="report-nav"><a href="about:firefoxview#reports">All research reports</a></nav>
<header>
<h1>${title}</h1>
<p class="description">${description}</p>
<p class="question">${question}</p>
<span class="status">Complete</span>
</header>
<section class="answer">
<h2>Final Answer</h2>
<div class="answer-body">${renderReportMarkdown(answer)}</div>
</section>
<section class="sources"><h2>Sources</h2><ol><li><a href="https://example.com/source">https://example.com/source</a></li></ol></section>
<section class="appendix"><h2>Research Log Appendix</h2></section>
</main>
</body>
</html>`
  );

  await IOUtils.writeUTF8(
    PathUtils.join(dir, "reports.json"),
    JSON.stringify({
      version: 1,
      reports: [
        {
          id,
          title,
          description,
          question,
          fileUri,
          path,
          status: "Complete",
          page,
          createdAt: now,
          updatedAt: now,
        },
      ],
    })
  );

  return { id, path, fileUri };
}

add_task(async function test_parseResearchJson_handles_fenced_json() {
  const parsed = parseResearchJson(
    '```json\n{"searches":["one"],"done":false}\n```'
  );
  Assert.deepEqual(parsed, { searches: ["one"], done: false });
});

add_task(function test_renderReportMarkdown_handles_full_markdown() {
  const result = renderReportMarkdown(`# Heading

**Bold** and *italic* with [a link](https://example.com).

1. First
2. Second

> Quote

\`\`\`js
const answer = 42;
\`\`\`

| Source | Status |
| --- | --- |
| Docs | Useful |

<script>alert("bad")</script>`);

  Assert.ok(result.includes("<h1>Heading</h1>"), "Should render headings");
  Assert.ok(result.includes("<strong>Bold</strong>"), "Should render bold");
  Assert.ok(result.includes("<em>italic</em>"), "Should render italic");
  Assert.ok(result.includes("<ol>"), "Should render ordered lists");
  Assert.ok(result.includes("<blockquote>"), "Should render blockquotes");
  Assert.ok(result.includes("<pre><code"), "Should render code fences");
  Assert.ok(result.includes("<table>"), "Should render tables");
  Assert.ok(!result.includes("<script>"), "Should not render raw HTML");
});

add_task(function test_renderResearchUsageSection_includes_cost_log() {
  const result = renderResearchUsageSection([
    {
      label: "Initial research",
      searchCalls: 7,
      modelCalls: 12,
      inputTokens: 123,
      outputTokens: 45,
      totalTokens: 168,
      estimatedTokens: true,
      updatedAt: "2026-06-09T12:00:00.000Z",
    },
  ]);

  Assert.ok(
    result.includes("<h2>Research Usage</h2>"),
    "Should render a usage section"
  );
  Assert.ok(result.includes("Initial research"), "Should include run label");
  Assert.ok(result.includes("7"), "Should include search calls");
  Assert.ok(result.includes("12"), "Should include model calls");
  Assert.ok(result.includes("123"), "Should include input tokens");
  Assert.ok(result.includes("45"), "Should include output tokens");
  Assert.ok(result.includes("168"), "Should include total tokens");
  Assert.ok(
    result.includes("Some token counts are estimated"),
    "Should explain estimated token counts"
  );
});

add_task(function test_repairReportMarkdownHtml_repairs_old_report_body() {
  const repaired = repairReportMarkdownHtml(`<!doctype html>
<section class="answer">
<h2>Final Answer</h2>
<div class="answer-body"><p>### Why this one?</p>
<ul><li>**Price**: See [Amazon](<a href="https://example.com/product">https://example.com/product</a>).</li></ul>
</div>
</section>`);

  Assert.ok(
    repaired.includes("<h3>Why this one?</h3>"),
    "Should repair markdown headings"
  );
  Assert.ok(
    repaired.includes("<strong>Price</strong>"),
    "Should repair markdown emphasis"
  );
  Assert.ok(
    repaired.includes('<a href="https://example.com/product">Amazon</a>'),
    "Should repair markdown links that were linkified as raw URLs"
  );
  Assert.ok(!repaired.includes("###"), "Should remove raw heading markers");
  Assert.ok(!repaired.includes("**Price**"), "Should remove raw bold markers");
});

add_task(async function test_research_report_url_helpers_read_indexed_report() {
  const report = await writeIndexedReport();

  Assert.ok(
    await ResearchAgent.isResearchReportUrl(report.fileUri),
    "Indexed report file URLs should be recognized"
  );
  Assert.equal(
    await ResearchAgent.getReportUrlbarTitle(report.fileUri),
    "Park Week Plan",
    "Should provide the report title for URL bar display"
  );
  Assert.ok(
    !(await ResearchAgent.isResearchReportUrl(
      PathUtils.toFileURI(PathUtils.join(PathUtils.profileDir, "other.html"))
    )),
    "Non-report file URLs should not be recognized"
  );
  Assert.equal(
    await ResearchAgent.getReportUrlbarTitle(
      PathUtils.toFileURI(PathUtils.join(PathUtils.profileDir, "other.html"))
    ),
    "",
    "Should not provide a URL bar title for non-report file URLs"
  );

  const content = await ResearchAgent.getReportContentForUrl(report.fileUri);
  Assert.ok(content.includes("Park Week Plan"), "Should include report title");
  Assert.ok(
    content.includes("Plan my park week."),
    "Should include the original query"
  );
  Assert.ok(
    content.includes("Day 2: Rest day"),
    "Should include final answer text"
  );
  Assert.ok(
    content.includes("https://example.com/source"),
    "Should include report sources"
  );
});

add_task(async function test_updateReport_rewrites_answer_and_appends_log() {
  const report = await writeIndexedReport();

  const updated = await ResearchAgent.updateReport({
    reportUrl: report.fileUri,
    updatedAnswerMarkdown:
      "# Updated itinerary\n\nDay 1: Park A\n\nDay 4: Rest day",
    editSummary: "Moved the rest day to the middle of the week.",
    title: "Updated Park Week",
    description: "A park itinerary with a midweek rest day.",
  });

  Assert.equal(updated.title, "Updated Park Week");
  Assert.equal(updated.status, "Complete");

  const html = await IOUtils.readUTF8(report.path);
  Assert.ok(html.includes("<h1>Updated Park Week</h1>"));
  Assert.ok(html.includes("<h1>Updated itinerary</h1>"));
  Assert.ok(html.includes("Day 4: Rest day"));
  Assert.ok(html.includes("Report update"));
  Assert.ok(
    html.includes("Moved the rest day to the middle of the week."),
    "Should append the edit summary to the appendix"
  );
});

// writeIndexedReport replaces reports.json wholesale, so each of these writes
// its own index rather than sharing one.
add_task(async function test_getReports_preserves_page_config() {
  const page = {
    version: "2",
    header: { type: "header", title: "Strollers under $500" },
    blocks: [
      { type: "text", layout: "summary", body: "Two of the three fit." },
    ],
  };
  const written = await writeIndexedReport({
    title: "Strollers under $500",
    page,
  });

  Services.prefs.setStringPref(
    "browser.smartwindow.aitab.viewerURL",
    "https://viewer.example/app"
  );
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.smartwindow.aitab.viewerURL")
  );

  const report = (await ResearchAgent.getReports()).find(
    entry => entry.id === written.id
  );

  Assert.ok(report, "The report should come back from the index");
  // ResearchReportIndex rebuilds records field by field, so an unlisted field
  // is dropped on every read. This is the regression that guards it.
  Assert.deepEqual(
    report.page,
    page,
    "The composed page config must survive the index round trip"
  );
  Assert.ok(
    report.openUrl.startsWith("https://viewer.example/app#"),
    `openUrl should point at the viewer, got ${report.openUrl}`
  );
  Assert.deepEqual(
    JSON.parse(decodeURIComponent(report.openUrl.split("#")[1])),
    page,
    "The viewer URL hash should carry the page config"
  );
});

add_task(async function test_getReports_without_page_opens_html_report() {
  const written = await writeIndexedReport({ title: "No GenTab yet" });

  const report = (await ResearchAgent.getReports()).find(
    entry => entry.id === written.id
  );

  Assert.ok(report, "The report should come back from the index");
  Assert.equal(report.page, null, "A report with no GenTab has a null page");
  Assert.equal(
    report.openUrl,
    report.fileUri,
    "With no composed page, opening falls back to the HTML report"
  );
});

add_task(function test_formatDuration_renders_minutes_and_seconds() {
  Assert.equal(formatDuration(0), "0s");
  Assert.equal(formatDuration(48_000), "48s");
  Assert.equal(formatDuration(60_000), "1m 0s");
  Assert.equal(formatDuration(252_000), "4m 12s");
  // Rounds to the nearest second rather than truncating.
  Assert.equal(formatDuration(59_600), "1m 0s");
  Assert.equal(formatDuration(4_325_000), "72m 5s");
  // Nothing sensible to show.
  for (const bad of [null, undefined, NaN, -1, "nope"]) {
    Assert.equal(
      formatDuration(bad),
      "",
      `${JSON.stringify(bad)} should render as an empty string`
    );
  }
});

const VERBATIM_MARKDOWN = [
  "For your **5.5-year-old**, the choice comes down to harness vs booster.",
  "",
  "## Comparison Summary",
  "",
  "| Feature | Nuna AACE | Nuna EXEC |",
  "| --- | --- | --- |",
  "| Primary Use | Dedicated Booster | All-in-One |",
  "| Tesla Fit | Slim; easy access | Wide; obstructs |",
  "",
  "### Key Considerations",
  "",
  "- **Safety:** keep them harnessed longer.",
  "- Tesla fit: see the [manual](https://example.com/manual).",
  "",
  "> Experts favour the harness.",
].join("\n");

/**
 * Every human-readable string in a block tree.
 *
 * @param {*} node - A block, or any value nested inside one.
 * @param {string[]} out - Accumulator.
 * @returns {string[]} Collected strings.
 */
function collectBlockText(node, out = []) {
  if (typeof node === "string") {
    out.push(node);
  } else if (Array.isArray(node)) {
    node.forEach(item => collectBlockText(item, out));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (
        key !== "type" &&
        key !== "layout" &&
        key !== "role" &&
        key !== "key"
      ) {
        collectBlockText(value, out);
      }
    }
  }
  return out;
}

add_task(function test_buildVerbatimAnswerBlocks_maps_each_construct() {
  const blocks = buildVerbatimAnswerBlocks(VERBATIM_MARKDOWN);
  const kinds = blocks.map(block => `${block.type}/${block.layout}`);

  Assert.deepEqual(
    kinds,
    ["text/summary", "table/ranked", "list/takeaways", "text/quote"],
    "Each markdown construct becomes the block type that fits it"
  );

  // Prose keeps its heading label.
  Assert.equal(blocks[0].title, "Full answer");
  Assert.ok(blocks[0].paragraphs[0].includes("5.5-year-old"));
  Assert.ok(!blocks[0].paragraphs[0].includes("**"), "Bold markers stripped");

  // The table is a real table, not pipe-joined prose.
  const table = blocks[1];
  Assert.equal(table.title, "Comparison Summary", "Heading labels the table");
  Assert.deepEqual(
    table.fields.map(field => field.label),
    ["Feature", "Nuna AACE", "Nuna EXEC"],
    "Header cells become column labels"
  );
  Assert.equal(table.fields[0].role, "title", "First column titles the row");
  Assert.equal(table.data.length, 2, "One object per body row");
  Assert.equal(table.data[0][table.fields[1].key], "Dedicated Booster");
  Assert.ok(
    !JSON.stringify(table).includes("---"),
    "The separator row is discarded"
  );

  // Bullets become list items, splitting a "Lead: detail" claim.
  const list = blocks[2];
  Assert.equal(list.title, "Key Considerations");
  Assert.equal(list.items.length, 2);
  Assert.equal(list.items[0].number, "01");
  Assert.equal(list.items[0].title, "Safety");
  Assert.equal(list.items[0].body, "keep them harnessed longer.");
  Assert.ok(
    list.items[1].body.includes("manual (https://example.com/manual)"),
    "Link text and target both survive"
  );

  Assert.equal(blocks[3].quote, "Experts favour the harness.");
});

add_task(function test_buildVerbatimAnswerBlocks_keeps_every_word() {
  const blocks = buildVerbatimAnswerBlocks(VERBATIM_MARKDOWN);
  const haystack = collectBlockText(blocks).join(" ");

  const words = VERBATIM_MARKDOWN.replace(/^[ ]{0,3}#{1,6}\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/[*>`[\]()]/g, " ")
    .split(/\s+/)
    // Punctuation may be absorbed into structure — "**Safety:** keep ..."
    // splits into a claim titled "Safety" plus its body — so compare bare words.
    .map(word => word.replace(/^[^A-Za-z0-9$]+|[^A-Za-z0-9%$]+$/g, ""))
    .filter(Boolean);

  const missing = words.filter(word => !haystack.includes(word));
  Assert.deepEqual(missing, [], "Every word of the answer appears in a block");
});

add_task(
  async function test_buildVerbatimAnswerBlocks_validates_against_schema() {
    const page = {
      header: { type: "header", title: "Nuna AACE vs EXEC" },
      blocks: buildVerbatimAnswerBlocks(VERBATIM_MARKDOWN),
    };
    const result = await AITab.validatePage(page);
    Assert.ok(
      result.ok,
      `Generated blocks must satisfy the packaged schemas: ${JSON.stringify(
        result.errors
      )}`
    );
  }
);

add_task(function test_buildVerbatimAnswerBlocks_handles_empty_input() {
  for (const value of ["", "   ", undefined]) {
    Assert.deepEqual(buildVerbatimAnswerBlocks(value), []);
  }
});
