/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * @type {import("../../../../../../toolkit/components/ml/tests/MLTestUtils.sys.mjs")}
 */
const { MLTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/MLTestUtils.sys.mjs"
);

/**
 * @type {import("../AIWindowTestUtils.sys.mjs")}
 */
const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);

const { ProfilerTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ProfilerTestUtils.sys.mjs"
);

const { GET_PAGE_CONTENT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

const { MESSAGE_ROLE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatEnums.sys.mjs"
);

/**
 * @import { ChatConversation } from "../../modules/ChatConversation.sys.mjs"
 */

/**
 * @returns {{url: string, cleanup: () => Promise<void>}}
 */
const serveRecipePage = () => MLTestUtils.serveHTML().html`
  <meta name="description" content="A quick tomato soup." />
  <meta
    property="og:description"
    content="The best tomato soup you will ever make."
  />
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Recipe",
      "name": "Tomato Soup",
      "author": { "@type": "Person", "name": "Ada" },
      "recipeIngredient": ["4 tomatoes", "1 onion"]
    }
  </script>
  <h1>Tomato Soup</h1>
  <p>Simmer the tomatoes and the onion for twenty minutes, then blend.</p>
`;

/**
 * Asks Smart Window about a page (the recipe page by default), has the model read it with
 * get_page_content, and returns the tool result found in the next chat request,
 * which is what the model actually receives.
 *
 * @param {() => {url: string, cleanup: () => Promise<void>}} [servePage]
 * @returns {Promise<string>}
 */
async function readRecipePageThroughSmartWindow(servePage = serveRecipePage) {
  const mockEngineManager = new MockEngineManager();
  const { win, sidebarBrowser } = await openAIWindowWithSidebar();
  const page = servePage();
  try {
    await mockEngineManager.respondTo({
      purpose: "convo-starters-sidebar",
      response: "A suggested conversation starter.",
    });

    await typeInSmartbar(sidebarBrowser, "What do I need for this soup?");
    await submitSmartbar(sidebarBrowser);

    /** @type {ChatConversation} */
    const conversation = await TestUtils.waitForCondition(
      () => AIWindow.getActiveConversation(win),
      "Conversation should be created when the first message is sent."
    );

    await mockEngineManager.respondTo({
      purpose: "chat",
      response: {
        text: "",
        tokens: null,
        isPrompt: false,
        toolCalls: [
          {
            id: "call_get_page_content_1",
            function: {
              name: GET_PAGE_CONTENT,
              arguments: JSON.stringify({ url_list: [page.url] }),
            },
          },
        ],
      },
    });

    const toolMessage = await TestUtils.waitForCondition(
      () =>
        conversation.messages.find(
          message =>
            message.role === MESSAGE_ROLE.TOOL &&
            message.content?.name === GET_PAGE_CONTENT
        ),
      "A tool result for get_page_content should be added to the conversation."
    );

    const { request, respond } = await mockEngineManager.captureRequest({
      purpose: "chat",
    });
    const modelSeen = request.args.find(
      message => message.role === "tool" && message.name === GET_PAGE_CONTENT
    );
    respond("Four tomatoes and an onion.");
    await mockEngineManager.respondTo({
      purpose: "title-generation",
      response: "Tomato soup",
    });

    const seenByModel = JSON.parse(modelSeen.content).join("\n");
    const metadataSection = text => text.split("\n\nMetadata the page")[1];
    Assert.strictEqual(
      metadataSection(seenByModel),
      metadataSection(toolMessage.content.body.join("\n")),
      "The model receives the same metadata section the conversation holds."
    );
    return seenByModel;
  } finally {
    mockEngineManager.rejectAllRequests();
    mockEngineManager.cleanupMocks();
    await BrowserTestUtils.closeWindow(win);
    await page.cleanup();
  }
}

/**
 * With the pref on, the tool result in the chat request the real code sends
 * to the model carries the page's metadata section after its text. Mirrors
 * browser_security_chat.js and captures the request as
 * browser_security_run_search.js does.
 */
add_task(async function test_get_page_content_includes_page_metadata() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.pageMetadata.enabled", true]],
  });

  const body = await readRecipePageThroughSmartWindow();

  Assert.stringContains(
    body,
    "Simmer the tomatoes and the onion",
    "The page content is still given to the model."
  );
  const recipe = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: "Tomato Soup",
    author: { "@type": "Person", name: "Ada" },
    recipeIngredient: ["4 tomatoes", "1 onion"],
  };
  Assert.ok(
    body.endsWith(
      [
        "Metadata the page declares about itself, which may be incomplete or wrong:",
        JSON.stringify(recipe),
        "description: A quick tomato soup.",
        "og:description: The best tomato soup you will ever make.",
      ].join("\n")
    ),
    `The model is told what the page declares: ${body}`
  );
  Assert.ok(
    !body.includes("left out"),
    "No omission notice is given when everything fits."
  );
});

/**
 * With the pref off, the content process records a text read but is never
 * asked for metadata. Mirrors test_page_extractor_metadata_markers in
 * browser_page_extractor_markers.js, reading the Glean phase events.
 */
add_task(async function test_get_page_content_without_page_metadata() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.pageMetadata.enabled", false]],
  });
  Services.fog.testResetFOG();

  const body = await readRecipePageThroughSmartWindow();
  await Services.fog.testFlushAllChildren();

  Assert.stringContains(
    body,
    "Simmer the tomatoes and the onion",
    "The page content is given to the model."
  );
  Assert.ok(
    !body.includes("Metadata the page declares"),
    "Without the pref, the metadata is left out."
  );

  const events = Glean.pageExtractor.phase.testGetValue("page-extractor") ?? [];
  Assert.ok(
    events.some(
      e => e.extra.phase === "get-text" && e.extra.process === "content"
    ),
    "The text read was recorded, so a missing metadata phase is not a flushing gap."
  );
  Assert.ok(
    !events.some(e => e.extra.phase === "get-structured-metadata"),
    "With the pref off, the content process is never asked for metadata."
  );
});

/**
 * With the pref on, the metadata read is requested while the text read is
 * still in flight instead of after it. Mirrors
 * test_page_extractor_metadata_markers in browser_page_extractor_markers.js,
 * comparing the parent "PageExtractor" markers' raw start and end times.
 * Glean phase events carry only a millisecond-truncated timestamp and a
 * rounded duration, too coarse for a metadata read that lasts about 1 ms.
 */
add_task(async function test_page_metadata_read_overlaps_the_text_read() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.pageMetadata.enabled", true]],
  });

  await ProfilerTestUtils.startProfilerForMarkerTests();
  let profile;
  try {
    await readRecipePageThroughSmartWindow();
    profile = await ProfilerTestUtils.stopNowAndGetProfile();
  } finally {
    if (Services.profiler.IsActive()) {
      await Services.profiler.StopProfiler();
    }
  }

  const markers = ProfilerTestUtils.getThreads(profile)
    .flatMap(thread => ProfilerTestUtils.getInflatedMarkerData(thread))
    .filter(
      marker =>
        marker.data?.type === "PageExtractor" &&
        marker.data.process === "parent"
    );
  const find = phase => markers.find(marker => marker.data.phase === phase);
  const metadataRead = find("get-structured-metadata");
  const textRead = find("get-text");
  Assert.ok(metadataRead, "The parent recorded the metadata read.");
  Assert.ok(textRead, "The parent recorded the text read.");
  Assert.deepEqual(
    metadataRead.data.traceId,
    textRead.data.traceId,
    "Both reads belong to the same extraction."
  );
  Assert.less(
    metadataRead.startTime,
    textRead.endTime,
    "The metadata read is requested while the text read is in flight instead of after it."
  );
});

add_task(async function test_get_page_content_keeps_whole_metadata_entries() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.pageMetadata.enabled", true]],
  });

  const budget = 4000;
  const oversized = JSON.stringify({
    "@type": "Product",
    name: "Oversized",
    description: "o".repeat(budget),
  });
  const blocks = [
    { "@type": "Recipe", name: "Tomato Soup", description: "a".repeat(1500) },
    JSON.parse(oversized),
    { "@type": "Article", headline: "Small later block" },
    { "@type": "Event", name: "Fits only if skipping continues" },
  ];
  const servePage = () => MLTestUtils.serveHTML().html`
    ${blocks
      .map(
        block =>
          `<script type="application/ld+json">${JSON.stringify(block)}</script>`
      )
      .join("\n")}
    ${[1, 2, 3, 4]
      .map(i => `<meta property="og:image" content="${"m".repeat(900)}${i}" />`)
      .join("\n")}
    <p>Simmer the tomatoes and the onion for twenty minutes, then blend.</p>
  `;

  const body = await readRecipePageThroughSmartWindow(servePage);
  const header =
    "Metadata the page declares about itself, which may be incomplete or wrong:";
  const section = body.slice(body.indexOf(header));
  Assert.lessOrEqual(
    section.length,
    budget + "\nSome of the page's metadata was left out.".length,
    `The metadata section stays within its budget: ${section.length}`
  );

  const lines = section.split("\n").slice(1);
  const jsonLines = lines.filter(line => line.startsWith("{"));
  Assert.greaterOrEqual(jsonLines.length, 2, "JSON-LD blocks are included.");
  for (const line of jsonLines) {
    JSON.parse(line);
  }
  Assert.ok(
    !section.includes('"Oversized"'),
    "The block larger than the budget is left out whole."
  );
  Assert.ok(
    section.includes("Small later block"),
    "A smaller block after the oversized one is still included."
  );
  Assert.equal(
    lines.at(-1),
    "Some of the page's metadata was left out.",
    "The model is told the metadata is incomplete."
  );
  Assert.ok(
    lines.every(
      line =>
        line.startsWith("{") ||
        (line.startsWith("og:image: ") && line.length == 10 + 901) ||
        line == "Some of the page's metadata was left out."
    ),
    "No entry is cut in the middle."
  );
});

/**
 * Metadata the extractor itself truncated yields the omission notice even
 * when every entry fits the budget. Mirrors
 * test_get_page_content_keeps_whole_metadata_entries above.
 */
add_task(async function test_get_page_content_reports_extractor_truncation() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.pageMetadata.enabled", true]],
  });

  const servePage = () => MLTestUtils.serveHTML().html`
    ${Array.from(
      { length: 60 },
      (_, i) => `<meta property="og:see_also" content="link ${i}" />`
    ).join("\n")}
    <p>Simmer the tomatoes and the onion for twenty minutes, then blend.</p>
  `;

  const body = await readRecipePageThroughSmartWindow(servePage);
  const header =
    "Metadata the page declares about itself, which may be incomplete or wrong:";
  const section = body.slice(body.indexOf(header));
  const lines = section.split("\n").slice(1);
  Assert.equal(
    lines.filter(line => line.startsWith("og:see_also: ")).length,
    50,
    "The extractor's cap of 50 meta tags reaches the model."
  );
  Assert.less(
    section.length,
    1000 + 4000 / 4,
    "Everything the extractor kept fits well within the budget."
  );
  Assert.equal(
    lines.at(-1),
    "Some of the page's metadata was left out.",
    "The model is told the extractor left metadata out."
  );
});
