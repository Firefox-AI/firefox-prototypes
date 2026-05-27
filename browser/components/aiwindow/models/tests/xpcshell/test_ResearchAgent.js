/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const { ExaClient } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ExaClient.sys.mjs"
);
const {
  ResearchAgent,
  parseResearchJson,
  renderReportMarkdown,
  renderResearchUsageSection,
  repairReportMarkdownHtml,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ResearchAgent.sys.mjs"
);

async function writeIndexedReport({
  id = crypto.randomUUID(),
  title = "Park Week Plan",
  description = "A week-long park itinerary.",
  question = "Plan my park week.",
  answer = "Day 1: Park A\n\nDay 2: Rest day",
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

add_task(async function test_exa_search_posts_expected_payload() {
  let request;
  const client = new ExaClient({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      };
    },
  });

  await client.search({ query: "mozilla research", numResults: 4 });

  Assert.equal(request.url, "https://api.exa.ai/search");
  Assert.equal(request.options.method, "POST");
  Assert.equal(request.options.headers["x-api-key"], "test-key");
  Assert.deepEqual(JSON.parse(request.options.body), {
    query: "mozilla research",
    type: "auto",
    numResults: 4,
    contents: {
      highlights: true,
    },
  });
});

add_task(async function test_exa_contents_posts_urls() {
  let body;
  const client = new ExaClient({
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [] }),
      };
    },
  });

  await client.contents({ urls: ["https://example.com/"] });

  Assert.deepEqual(body, {
    urls: ["https://example.com/"],
    text: {
      maxCharacters: 8000,
    },
  });
});

add_task(async function test_exa_search_retries_transient_502() {
  let attempts = 0;
  const client = new ExaClient({
    apiKey: "test-key",
    maxRetries: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) {
        return {
          ok: false,
          status: 502,
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ results: [{ url: "https://a.com" }] }),
      };
    },
  });

  const result = await client.search({ query: "mozilla research" });

  Assert.equal(attempts, 2);
  Assert.equal(result.results[0].url, "https://a.com");
});
