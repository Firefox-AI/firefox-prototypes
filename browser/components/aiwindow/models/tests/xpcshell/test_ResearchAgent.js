/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

const { ExaClient } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ExaClient.sys.mjs"
);
const { parseResearchJson, renderReportMarkdown, repairReportMarkdownHtml } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/ResearchAgent.sys.mjs"
  );

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
