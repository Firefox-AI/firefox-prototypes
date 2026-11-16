/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const EMPTY_METADATA = {
  truncated: false,
  url: "",
  title: "",
  canonicalUrl: null,
  language: null,
  metaTags: [],
  jsonLd: [],
};

add_task(async function test_structured_metadata_reader_mode() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <meta name="description" content="Original description" />
    <article>
      <h1>Structured metadata in reader mode</h1>
      <p>
        ${"Reader mode presents an article without the original page metadata. ".repeat(
          100
        )}
      </p>
    </article>
  `;
  try {
    Assert.deepEqual(
      (await getPageExtractor().getStructuredMetadata()).metaTags,
      [{ name: "description", value: "Original description" }],
      "The original page exposes its metadata."
    );
    await toggleReaderMode();
    Assert.deepEqual(
      await getPageExtractor().getStructuredMetadata(),
      EMPTY_METADATA,
      "Reader mode does not expose metadata from the replaced page."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_structured_metadata_headless() {
  const { PageExtractorParent } = ChromeUtils.importESModule(
    "resource://gre/actors/PageExtractorParent.sys.mjs"
  );
  const page = MLTestUtils.serveHTML().html`
    <meta name="description" content="Headless description" />
    <script type="application/ld+json">{ "@type": "Recipe" }</script>
    <p>Headless page.</p>
  `;
  try {
    const result = await PageExtractorParent.getHeadlessExtractor({
      urlString: page.url,
      callback: (actor, traceId) => actor.getStructuredMetadata(traceId),
    });
    Assert.deepEqual(result, {
      truncated: false,
      url: page.url,
      title: "",
      canonicalUrl: null,
      language: null,
      metaTags: [{ name: "description", value: "Headless description" }],
      jsonLd: ['{"@type":"Recipe"}'],
    });
  } finally {
    await page.cleanup();
  }
});

add_task(async function test_meta_tags_keep_order_and_conflicts() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <meta name="viewport" content="width=device-width" />
    <meta name="csrf-token" content="secret-token" />
    <meta name="description" content="HTML description" />
    <meta name="Keywords" content="soup, winter" />
    <meta property="og:description" content="Open Graph description" />
    <meta property="og:image" content="https://example.com/first.jpg" />
    <meta property="og:image" content="https://example.com/second.jpg" />
    <meta property="article:published_time" content="2026-10-05" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta property="twitter:description" content="Twitter description" />
    <meta property="og:title" content="" />
    <meta property="og:site_name" name="twitter:site" content="@example" />
    <p>Soup.</p>
  `;
  try {
    Assert.deepEqual(
      (await getPageExtractor().getStructuredMetadata()).metaTags,
      [
        { name: "description", value: "HTML description" },
        { name: "keywords", value: "soup, winter" },
        { name: "og:description", value: "Open Graph description" },
        { name: "og:image", value: "https://example.com/first.jpg" },
        { name: "og:image", value: "https://example.com/second.jpg" },
        { name: "article:published_time", value: "2026-10-05" },
        { name: "twitter:card", value: "summary_large_image" },
        { name: "twitter:description", value: "Twitter description" },
        { name: "og:site_name", value: "@example" },
        { name: "twitter:site", value: "@example" },
      ],
      "SEO and social tags keep their order, repeats and conflicts, while " +
        "unrelated and empty tags are left out."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_no_metadata() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { tab, getPageExtractor, cleanup } = await html`
    <p>A page with no metadata.</p>
  `;
  try {
    const metadata = await getPageExtractor().getStructuredMetadata();
    Assert.equal(
      metadata.url,
      tab.linkedBrowser.currentURI.spec,
      "The document URL is always given."
    );
    Assert.deepEqual(
      { ...metadata, url: "" },
      EMPTY_METADATA,
      "A page without metadata produces empty collections."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_json_ld_blocks_are_kept_as_written() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": "#org", name: "Example Co" },
      {
        "@type": "Product",
        "@id": "https://example.com/p",
        name: "First name",
        brand: { "@id": "#org" },
      },
    ],
  };
  const conflicting = [
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "@id": "https://example.com/p",
      name: "Second name",
    },
  ];
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      ${JSON.stringify(graph)}
    </script>
    <script type="application/ld+json">
      ${JSON.stringify(conflicting)}
    </script>
  `;
  try {
    Assert.deepEqual(
      (await getPageExtractor().getStructuredMetadata()).jsonLd,
      [JSON.stringify(graph), JSON.stringify(conflicting)],
      "Each block is returned as written, and conflicting blocks stay separate."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_json_ld_invalid_blocks_do_not_block_others() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      { this is not valid json }
    </script>
    <script type="application/ld+json">
      "just a string"
    </script>
    <script type="application/ld+json"></script>
    <script type="APPLICATION/LD+JSON">
      { "@context": "https://schema.org/", "@type": "Product" }
    </script>
    <p>one two three</p>
  `;
  try {
    const { jsonLd } = await getPageExtractor().getStructuredMetadata();
    const { structuredDataTypes, wordCount } =
      await getPageExtractor().getPageMetadata();
    Assert.deepEqual(
      jsonLd,
      ['{"@context":"https://schema.org/","@type":"Product"}'],
      "Valid blocks are read after invalid ones."
    );
    Assert.deepEqual(
      structuredDataTypes,
      ["Product"],
      "getPageMetadata reads the same blocks."
    );
    Assert.equal(wordCount, 3, "The rest of the page metadata is unaffected.");
  } finally {
    await cleanup();
  }
});

add_task(async function test_hostile_metadata_is_bounded() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const depth = 15_000;
  const deep = '{"a":'.repeat(depth) + "{}" + "}".repeat(depth);
  const huge = JSON.stringify({ "@type": "Thing", name: "x".repeat(200_000) });
  const { getPageExtractor, cleanup } = await html`
    <meta name="description" content=${"d".repeat(100_000)} />
    ${'<meta name="keywords" content="k" />'.repeat(100)}
    <script type="application/ld+json">
      ${huge}
    </script>
    <script type="application/ld+json">
      ${deep}
    </script>
    <script type="application/ld+json">
      { "@type": "Recipe" }
    </script>
  `;
  try {
    const { metaTags, jsonLd, truncated } =
      await getPageExtractor().getStructuredMetadata();
    Assert.ok(truncated, "The limits are visible to callers.");
    Assert.equal(
      metaTags[0].value.length,
      1000,
      "A long meta value is shortened in the content process."
    );
    Assert.equal(metaTags.length, 50, "The number of meta tags is capped.");
    Assert.deepEqual(
      jsonLd,
      ['{"@type":"Recipe"}'],
      "Blocks too large or too deeply nested are left out, and later blocks " +
        "are still read."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_truncated_only_reports_values_callers_receive() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const ignored = await html`
    <meta name="description" content="Short description" />
    <meta name="csrf-token" content=${"c".repeat(2000)} />
    <p>Page.</p>
  `;
  try {
    const metadata = await ignored.getPageExtractor().getStructuredMetadata();
    Assert.deepEqual(
      metadata.metaTags,
      [{ name: "description", value: "Short description" }],
      "The tag outside the allowlist is not returned."
    );
    Assert.strictEqual(
      metadata.truncated,
      false,
      "A long value on a tag that is left out does not count as truncation."
    );
  } finally {
    await ignored.cleanup();
  }

  const clipped = await html`
    <meta name="description" content=${"d".repeat(2000)} />
    <p>Page.</p>
  `;
  try {
    const metadata = await clipped.getPageExtractor().getStructuredMetadata();
    Assert.equal(
      metadata.metaTags[0].value.length,
      1000,
      "The allowlisted value is shortened."
    );
    Assert.strictEqual(
      metadata.truncated,
      true,
      "Shortening a value the caller receives counts as truncation."
    );
  } finally {
    await clipped.cleanup();
  }
});

add_task(async function test_oversized_json_ld_block_is_skipped() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const huge = JSON.stringify({ "@type": "Thing", name: "x".repeat(150_000) });
  const { getPageExtractor, cleanup } = await html`
    <script type="application/ld+json">
      ${huge}
    </script>
    <script type="application/ld+json">
      { "@type": "Recipe" }
    </script>
  `;
  try {
    const { jsonLd, truncated } =
      await getPageExtractor().getStructuredMetadata();
    Assert.deepEqual(
      jsonLd,
      ['{"@type":"Recipe"}'],
      "The oversized block is skipped and the later small block is extracted."
    );
    Assert.strictEqual(
      truncated,
      true,
      "Skipping a block is reported to callers."
    );
  } finally {
    await cleanup();
  }
});

add_task(async function test_document_fields() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { tab, getPageExtractor, cleanup } = await html`
    <title>Soupe aux tomates</title>
    <link rel="Canonical" href="/recettes/soupe" />
    <p>Soupe.</p>
  `;
  try {
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.document.documentElement.lang = "fr-CA";
    });
    const { url, title, canonicalUrl, language } =
      await getPageExtractor().getStructuredMetadata();
    Assert.equal(
      title,
      "Soupe aux tomates",
      "The document title is returned as written."
    );
    Assert.equal(
      canonicalUrl,
      new URL("/recettes/soupe", url).href,
      "The canonical link is resolved against the document."
    );
    Assert.equal(
      language,
      "fr-CA",
      "The language is read from the root element's lang attribute."
    );
  } finally {
    await cleanup();
  }
});
