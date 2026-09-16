/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// End-to-end generateAITab() with only the LLM mocked: the source pages are
// served over HTTP and read through the real GetPageContent, so this covers
// extraction, prompt assembly, page validation and metadata derivation. Later
// tasks cover implicit edit from the last-page cache, and the create_aitab
// tool loading the viewer into the current tab.

const { AITab } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/aitab/AITab.sys.mjs"
);
const { generateAITab } = AITab;

const { createAITab } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);
const { AITabStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/AITabStore.sys.mjs"
);
const { expandUrlTokens } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs"
);

const { MockEngineManager } = ChromeUtils.importESModule(
  "resource://testing-common/AIWindowTestUtils.sys.mjs"
);
const { MODEL_FEATURES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs"
);
const { ChatConversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
);
/**
 * @type {import("../../../../../../toolkit/components/ml/tests/MLTestUtils.sys.mjs")}
 */
const { MLTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/MLTestUtils.sys.mjs"
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

add_setup(async function () {
  // Raise AITab's log verbosity for the duration of this file so a failing run
  // surfaces the module's debug/error output. Reverted automatically at teardown.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.conversation.logLevel", "Debug"]],
  });
  AITab.clearLastPage();
  registerCleanupFunction(() => AITab.clearLastPage());
});

// What the mocked model returns. Schema coverage is browser_aitab_validation.js'
// job, so this is the smallest surface the packaged catalog accepts: a root
// Page, a Header (for the title), and one TextBlock.
const GENERATED_SURFACE = Object.freeze({
  components: [
    { id: "root", component: "Page", header: "hdr", children: ["lead"] },
    { id: "hdr", component: "Header", title: "Hotels in Lisbon" },
    {
      id: "lead",
      component: "TextBlock",
      lead: "Budget Central Hostel is $72 / night.",
    },
  ],
  dataModel: {},
});

// Serve a page for generation to read. The URL is not open in a tab, so
// GetPageContent extracts it headlessly — the real path, no stubbing. cleanup()
// resolves once the page has been served, so only call this when the test
// actually reads the URL.
function servePage() {
  const { html } = MLTestUtils.serveHTML();
  return html`
    <article>
      <h1>Hotels in Lisbon</h1>
      <p>Budget Central Hostel is $72 / night in Lisbon.</p>
      <p>It is a short walk from the Baixa district and has free breakfast.</p>
    </article>
  `;
}

function newConversation() {
  return new ChatConversation({
    title: "",
    description: "",
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });
}

add_task(async function test_generateAITab_requires_urls() {
  // No URLs and no last page: rejected before any model call, so no engine is
  // needed. clearLastPage keeps an earlier task from turning this into an edit.
  AITab.clearLastPage();
  const result = await generateAITab({ urlList: [] }, newConversation());
  Assert.ok(result.error, "an empty urlList is reported as an error");
});

add_task(async function test_generateAITab_honors_aborted_signal() {
  // Cancellation is checked before the extraction, so the URL is never read and
  // no page needs serving. No model call either, so no engine is needed.
  const result = await generateAITab(
    {
      urlList: ["https://example.com/lisbon-hotels"],
      signal: AbortSignal.abort(),
    },
    newConversation()
  );
  Assert.ok(result.error, "an aborted signal cancels generation");
  Assert.ok(!result.surface, "no surface is returned when canceled");
});

add_task(async function test_generateAITab_success() {
  const mockEngine = new MockEngineManager();
  const { url: GEN_URL, cleanup: stopServing } = servePage();
  try {
    const genPromise = generateAITab(
      { urlList: [GEN_URL], focus: "hotels in Lisbon" },
      newConversation()
    );

    // AITAB generation runs on the chat engine purpose (selectFeatureConfig
    // remaps the aitab purpose to chat), so respond there with a valid config.
    const { request, respond } = await mockEngine.captureRequest({
      purpose: MODEL_FEATURES.AITAB,
    });
    const serializedRequest = JSON.stringify(request.args);
    Assert.ok(
      serializedRequest.includes("Budget Central Hostel is $72 / night"),
      "the extracted page content reaches the model prompt"
    );
    Assert.ok(
      serializedRequest.includes("hotels in Lisbon"),
      "the requested focus reaches the model prompt"
    );
    respond(JSON.stringify(GENERATED_SURFACE));

    const result = await genPromise;

    Assert.ok(!result.error, `generation should succeed: ${result.error}`);
    Assert.deepEqual(
      result.surface,
      GENERATED_SURFACE,
      "the validated surface is returned unchanged"
    );
    Assert.equal(
      result.metadata.title,
      "Hotels in Lisbon",
      "metadata title comes from the Header component"
    );
    Assert.equal(
      result.metadata.id,
      "hotels_in_lisbon",
      "metadata id is the slugified title"
    );
    Assert.equal(result.metadata.howCreated, "chat", "howCreated is chat");
    Assert.deepEqual(
      result.metadata.components,
      GENERATED_SURFACE.components,
      "metadata components mirror the surface components"
    );
    Assert.deepEqual(
      result.metadata.context.urlsUsed.map(u => u.url),
      [GEN_URL],
      "the requested URL is recorded in the generation context"
    );
    Assert.ok(
      result.metadata.context.urlsUsed[0].extractedText.includes(
        "Budget Central Hostel"
      ),
      "the extracted page text is recorded in the generation context"
    );
  } finally {
    await stopServing();
    mockEngine.cleanupMocks();
  }
});

add_task(async function test_generateAITab_includes_page_image() {
  // A page's cached preview image (og:image in Places) should reach the model
  // prompt as an `Image:` line and be recorded on its urlsUsed entry.
  const mockEngine = new MockEngineManager();
  const { url: GEN_URL, cleanup: stopServing } = servePage();
  const IMAGE_URL = "https://example.com/lisbon-hero.jpg";
  // Seed the preview image in Places for the page that generation will read.
  await PlacesTestUtils.addVisits(GEN_URL);
  await PlacesUtils.history.update({
    url: GEN_URL,
    previewImageURL: IMAGE_URL,
  });
  try {
    const genPromise = generateAITab(
      { urlList: [GEN_URL], focus: "hotels in Lisbon" },
      newConversation()
    );

    const { request, respond } = await mockEngine.captureRequest({
      purpose: MODEL_FEATURES.AITAB,
    });
    Assert.ok(
      JSON.stringify(request.args).includes(`Image: ${IMAGE_URL}`),
      "the page's preview image URL reaches the model prompt"
    );
    respond(JSON.stringify(GENERATED_SURFACE));

    const result = await genPromise;
    Assert.ok(!result.error, `generation should succeed: ${result.error}`);
    Assert.equal(
      result.metadata.context.urlsUsed[0].imageUrl,
      IMAGE_URL,
      "the preview image URL is recorded on the urlsUsed entry"
    );
  } finally {
    await stopServing();
    mockEngine.cleanupMocks();
    await PlacesUtils.history.clear();
  }
});

add_task(async function test_generateAITab_omits_image_for_denied_url() {
  // Threat model: a prompt injection could ask AITab to build a page from an
  // attacker-chosen URL. When the conversation holds both untrusted input and
  // private data, get_page_content refuses to fetch unmentioned, non-SERP URLs
  // headlessly to block that exfiltration channel. This test asserts the image
  // path honors the same refusal — the denied URL's cached og:image must reach
  // neither the model prompt nor the urlsUsed metadata — so it cannot become a
  // side channel around the existing block.
  const mockEngine = new MockEngineManager();
  const DENIED_URL = "https://example.com/denied-private-untrusted-page";
  const IMAGE_URL = "https://example.com/denied-hero.jpg";
  await PlacesTestUtils.addVisits(DENIED_URL);
  await PlacesUtils.history.update({
    url: DENIED_URL,
    previewImageURL: IMAGE_URL,
  });
  const conversation = newConversation();
  // Mark the conversation as holding private data and untrusted input;
  // commit() makes the staged flags visible to the security getters.
  conversation.securityProperties.setPrivateData();
  conversation.securityProperties.setUntrustedInput();
  conversation.securityProperties.commit();
  try {
    const genPromise = generateAITab({ urlList: [DENIED_URL] }, conversation);

    const { request, respond } = await mockEngine.captureRequest({
      purpose: MODEL_FEATURES.AITAB,
    });
    const serializedRequest = JSON.stringify(request.args);
    Assert.ok(
      serializedRequest.includes("Access is not allowed"),
      "the denied URL surfaces the refusal message, not page content"
    );
    Assert.ok(
      !serializedRequest.includes(IMAGE_URL),
      "the denied URL's preview image does not reach the model prompt"
    );
    respond(JSON.stringify(GENERATED_SURFACE));

    const result = await genPromise;
    Assert.ok(!result.error, `generation should succeed: ${result.error}`);
    Assert.equal(
      result.metadata.context.urlsUsed[0].imageUrl,
      null,
      "no preview image URL is recorded for a denied URL"
    );
  } finally {
    mockEngine.cleanupMocks();
    await PlacesUtils.history.clear();
  }
});

// A decodable favicon payload for Places (setFaviconForPage rejects data it
// cannot decode as an image).
const FAVICON_DATA_URL =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#424e5a"/></svg>`
  );

add_task(async function test_generateAITab_hydrates_link_favicons() {
  // Covers the `items` shapes hydration must handle: a literal array
  // (Header.references), an absolute data-model binding (SourceLinks), and a
  // relative binding (left alone — validation does not check those). Also
  // covers that model-supplied favicons are replaced or stripped, never kept.
  const mockEngine = new MockEngineManager();
  const { url: GEN_URL, cleanup: stopServing } = servePage();
  const FAVICON_URL = "https://example.com/favicon.ico";
  const NO_FAVICON_URL = "https://example.org/never-visited";
  const MODEL_FAVICON = "https://model.example/injected.ico";
  await PlacesTestUtils.addVisits(GEN_URL);
  await PlacesTestUtils.setFaviconForPage(
    GEN_URL,
    FAVICON_URL,
    FAVICON_DATA_URL
  );
  try {
    const genPromise = generateAITab(
      { urlList: [GEN_URL], focus: "hotels in Lisbon" },
      newConversation()
    );

    await mockEngine.respondTo({
      purpose: MODEL_FEATURES.AITAB,
      response: JSON.stringify({
        components: [
          {
            id: "root",
            component: "Page",
            header: "hdr",
            children: ["lead", "links", "more"],
          },
          {
            id: "hdr",
            component: "Header",
            title: "Hotels in Lisbon",
            references: {
              items: [
                { href: GEN_URL, title: "Hotels", favicon: MODEL_FAVICON },
                {
                  href: NO_FAVICON_URL,
                  title: "Unvisited",
                  favicon: MODEL_FAVICON,
                },
              ],
            },
          },
          {
            id: "lead",
            component: "TextBlock",
            lead: "Budget Central Hostel is $72 / night.",
          },
          {
            id: "links",
            component: "SourceLinks",
            items: { path: "/sources" },
          },
          {
            id: "more",
            component: "SourceLinks",
            items: { path: "more" },
          },
        ],
        dataModel: {
          sources: [{ href: GEN_URL, title: "Hotels" }],
          more: [{ href: GEN_URL, title: "More" }],
        },
      }),
    });

    const result = await genPromise;
    Assert.ok(!result.error, `generation should succeed: ${result.error}`);
    const header = result.surface.components.find(
      c => c.component === "Header"
    );
    Assert.equal(
      header.references.items[0].favicon,
      FAVICON_URL,
      "a literal SourceLink item gets its stored favicon URL, replacing the model's"
    );
    Assert.ok(
      !("favicon" in header.references.items[1]),
      "a model-supplied favicon is stripped when Places has none stored"
    );
    Assert.equal(
      result.surface.dataModel.sources[0].favicon,
      FAVICON_URL,
      "an absolutely-bound SourceLink item gets its stored favicon URL"
    );
    Assert.ok(
      !("favicon" in result.surface.dataModel.more[0]),
      "a relatively-bound array is not resolved, so its items are not touched"
    );
  } finally {
    await stopServing();
    mockEngine.cleanupMocks();
    await PlacesUtils.history.clear();
  }
});

add_task(async function test_generateAITab_hydrates_favicon_for_denied_url() {
  // Unlike the og:image path above, favicon hydration is not subject to the
  // conversation's access-control decision: Places only has favicons for
  // sites the user has visited, so they already count as seen. A visited
  // page's favicon hydrates (replacing the model's value) even when the
  // conversation refuses to read the page itself.
  const mockEngine = new MockEngineManager();
  const DENIED_URL = "https://example.com/denied-sourcelink-page";
  const FAVICON_URL = "https://example.com/denied-favicon.ico";
  await PlacesTestUtils.addVisits(DENIED_URL);
  await PlacesTestUtils.setFaviconForPage(
    DENIED_URL,
    FAVICON_URL,
    FAVICON_DATA_URL
  );
  const conversation = newConversation();
  conversation.securityProperties.setPrivateData();
  conversation.securityProperties.setUntrustedInput();
  conversation.securityProperties.commit();
  try {
    const genPromise = generateAITab({ urlList: [DENIED_URL] }, conversation);

    await mockEngine.respondTo({
      purpose: MODEL_FEATURES.AITAB,
      response: JSON.stringify({
        components: [
          {
            id: "root",
            component: "Page",
            header: "hdr",
            children: ["lead", "links"],
          },
          { id: "hdr", component: "Header", title: "Hotels in Lisbon" },
          {
            id: "lead",
            component: "TextBlock",
            lead: "Budget Central Hostel is $72 / night.",
          },
          {
            id: "links",
            component: "SourceLinks",
            items: [
              {
                href: DENIED_URL,
                favicon: "https://model.example/injected.ico",
              },
            ],
          },
        ],
        dataModel: {},
      }),
    });

    const result = await genPromise;
    Assert.ok(!result.error, `generation should succeed: ${result.error}`);
    const links = result.surface.components.find(
      c => c.component === "SourceLinks"
    );
    Assert.equal(
      links.items[0].favicon,
      FAVICON_URL,
      "the visited page's stored favicon hydrates despite the content refusal"
    );
  } finally {
    mockEngine.cleanupMocks();
    await PlacesUtils.history.clear();
  }
});

add_task(async function test_generateAITab_rejects_invalid_page() {
  const mockEngine = new MockEngineManager();
  const { url: GEN_URL, cleanup: stopServing } = servePage();
  try {
    const genPromise = generateAITab({ urlList: [GEN_URL] }, newConversation());

    // A structurally valid JSON object that does not match the catalog (a root
    // Page referencing an unknown component type) must fail validation rather
    // than be returned.
    await mockEngine.respondTo({
      purpose: MODEL_FEATURES.AITAB,
      response: JSON.stringify({
        components: [
          { id: "root", component: "Page", header: "hdr", children: ["b"] },
          { id: "hdr", component: "Header", title: "Hotels in Lisbon" },
          { id: "b", component: "Banner" },
        ],
      }),
    });

    const result = await genPromise;
    Assert.ok(result.error, "a surface that fails validation is an error");
    Assert.ok(!result.surface, "no surface is returned on validation failure");
  } finally {
    await stopServing();
    mockEngine.cleanupMocks();
  }
});

add_task(async function test_generateAITab_default_title_is_localized() {
  const mockEngine = new MockEngineManager();
  // Two URLs, so the single-URL heading fallback doesn't apply either.
  const first = servePage();
  const second = servePage();
  try {
    const genPromise = generateAITab(
      { urlList: [first.url, second.url] },
      newConversation()
    );

    // The model bound the Header title to data that is not a string, so no
    // title can be derived from the surface; with no focus from the user
    // either, it falls all the way through to the localized default.
    await mockEngine.respondTo({
      purpose: MODEL_FEATURES.AITAB,
      response: JSON.stringify({
        components: [
          { id: "root", component: "Page", header: "hdr", children: ["lead"] },
          { id: "hdr", component: "Header", title: { path: "/nights" } },
          {
            id: "lead",
            component: "TextBlock",
            lead: "Budget Central Hostel is $72 / night.",
          },
        ],
        dataModel: { nights: 3 },
      }),
    });

    const result = await genPromise;
    Assert.ok(!result.error, `generation should succeed: ${result.error}`);
    Assert.equal(
      result.metadata.title,
      "Generated page",
      "the default title comes from ai-tab-default-page-title"
    );
  } finally {
    await first.cleanup();
    await second.cleanup();
    mockEngine.cleanupMocks();
  }
});

const EDITED_SURFACE = Object.freeze({
  components: [
    { id: "root", component: "Page", header: "hdr", children: ["lead"] },
    { id: "hdr", component: "Header", title: "Hotels in Lisbon" },
    {
      id: "lead",
      component: "TextBlock",
      lead: "One hotel remains after the edit.",
    },
  ],
  dataModel: {},
});

add_task(async function test_generateAITab_edit_uses_last_page() {
  const mockEngine = new MockEngineManager();
  const { url: GEN_URL, cleanup: stopServing } = servePage();
  try {
    const conversation = newConversation();
    const genPromise = generateAITab(
      { urlList: [GEN_URL], focus: "hotels in Lisbon" },
      conversation
    );
    await mockEngine.respondTo({
      purpose: MODEL_FEATURES.AITAB,
      response: JSON.stringify(GENERATED_SURFACE),
    });
    const created = await genPromise;
    Assert.ok(!created.error, `create should succeed: ${created.error}`);
    Assert.deepEqual(
      AITab.getLastPage()?.surface,
      GENERATED_SURFACE,
      "a successful generation is kept as the last page"
    );

    // Stop serving so a mistaken re-fetch of the source URL would fail. The
    // edit path has to reuse the stored extracted text and surface.
    await stopServing();

    const editPromise = generateAITab(
      { focus: "remove the second item" },
      conversation
    );
    const { request, respond } = await mockEngine.captureRequest({
      purpose: MODEL_FEATURES.AITAB,
    });
    const serializedRequest = JSON.stringify(request.args);
    Assert.ok(
      serializedRequest.includes("remove the second item"),
      "the edit request reaches the model prompt"
    );
    Assert.ok(
      serializedRequest.includes("CURRENT SURFACE JSON"),
      "the last surface is included so the model can revise it"
    );
    Assert.ok(
      serializedRequest.includes("Hotels in Lisbon"),
      "the stored surface JSON reaches the model prompt"
    );
    Assert.ok(
      serializedRequest.includes("Budget Central Hostel is $72 / night"),
      "the stored source text is reused without re-fetching"
    );
    respond(JSON.stringify(EDITED_SURFACE));

    const edited = await editPromise;
    Assert.ok(!edited.error, `edit should succeed: ${edited.error}`);
    Assert.equal(
      edited.metadata.howCreated,
      "chat-edit",
      "an implicit edit is tagged chat-edit"
    );
    Assert.equal(
      edited.metadata.id,
      created.metadata.id,
      "the page slug is kept across the edit"
    );
    Assert.equal(
      edited.metadata.context.urlsUsed[0].url,
      GEN_URL,
      "the original source URL is kept"
    );
    Assert.deepEqual(
      edited.surface,
      EDITED_SURFACE,
      "the edited surface is returned"
    );
    Assert.deepEqual(
      AITab.getLastPage()?.surface,
      EDITED_SURFACE,
      "the last page is replaced with the edit"
    );
  } finally {
    await stopServing();
    mockEngine.cleanupMocks();
    AITab.clearLastPage();
  }
});

// Stands in for the external viewer until its components are in-tree. Served by
// the mochitest server so the link is a real https page a tab can load.
const VIEWER_URL =
  "https://example.com/browser/browser/components/aiwindow/models/tests/browser/aitab_viewer_stub.html";

add_task(async function test_createAITab_link_loads_config_in_a_tab() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.aitab.viewerURL", VIEWER_URL]],
  });
  const mockEngine = new MockEngineManager();
  const { url, cleanup: stopServing } = servePage();
  const conversation = newConversation();
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  try {
    const loaded = BrowserTestUtils.browserLoaded(
      tab.linkedBrowser,
      false,
      loadedURL => loadedURL.startsWith(VIEWER_URL)
    );
    const toolPromise = createAITab(
      { url_list: [url], focus: "hotels in Lisbon" },
      conversation
    );
    await mockEngine.respondTo({
      purpose: MODEL_FEATURES.AITAB,
      response: JSON.stringify(GENERATED_SURFACE),
    });
    const toolResult = await toolPromise;
    await loaded;

    Assert.ok(
      toolResult.includes("created"),
      `the tool reports a create: ${toolResult}`
    );
    const expanded = expandUrlTokens(toolResult, conversation.tokenToUrl);
    const [, viewerURL] = expanded.match(/\]\((https:\/\/[^\s)]+)\)/) ?? [];
    Assert.ok(viewerURL, `the tool returns a viewer link: ${expanded}`);
    Assert.ok(
      viewerURL.startsWith(`${VIEWER_URL}#`),
      "the link points at the configured viewer, with the config in the hash"
    );

    const [title, hash] = await SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      () => [content.document.title, content.location.hash]
    );
    Assert.equal(
      title,
      "AITab viewer stub",
      "the current tab loaded the viewer"
    );
    Assert.deepEqual(
      JSON.parse(decodeURIComponent(hash.slice(1))),
      GENERATED_SURFACE,
      "the surface round-trips through the hash of the loaded URL"
    );

    await stopServing();

    const locationChanged = BrowserTestUtils.waitForLocationChange(gBrowser);
    const editPromise = createAITab(
      { focus: "remove the second item" },
      conversation
    );
    await mockEngine.respondTo({
      purpose: MODEL_FEATURES.AITAB,
      response: JSON.stringify(EDITED_SURFACE),
    });
    const editResult = await editPromise;
    await locationChanged;

    Assert.ok(
      editResult.includes("updated"),
      `the tool reports an update: ${editResult}`
    );
    const editedHash = await SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      () => content.location.hash
    );
    Assert.deepEqual(
      JSON.parse(decodeURIComponent(editedHash.slice(1))),
      EDITED_SURFACE,
      "the current tab's hash is replaced with the edited surface"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    await stopServing();
    mockEngine.cleanupMocks();
    AITab.clearLastPage();
    await SpecialPowers.popPrefEnv();
  }
});
