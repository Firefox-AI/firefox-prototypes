/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

do_get_profile();

const {
  TOOLS,
  toolsConfig,
  RunSearch,
  RUN_SEARCH_VERBATIM_QUERY_DESCRIPTION,
  RUN_SEARCH_GENERATED_QUERY_DESCRIPION,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);

add_task(async function test_run_search_is_callable() {
  Assert.strictEqual(
    typeof RunSearch.runSearch,
    "function",
    "RunSearch.runSearch should be a function"
  );
});

add_task(async function test_run_search_in_TOOLS_array() {
  Assert.ok(
    TOOLS.includes("run_search"),
    "run_search should be in the TOOLS array"
  );
});

add_task(async function test_run_search_tool_config_exists() {
  // Check 1st turn config
  const firstTurnConfig = toolsConfig.find(
    t => t.function?.name === "run_search"
  );
  Assert.ok(
    firstTurnConfig,
    "First turn run_search tool config should exist in toolsConfig"
  );
  Assert.equal(
    firstTurnConfig.type,
    "function",
    "First turn tool type should be 'function'"
  );
  Assert.equal(
    firstTurnConfig.function.description,
    RUN_SEARCH_VERBATIM_QUERY_DESCRIPTION,
    "First turn tool description should be the one for verbatim search queries"
  );
  const firstTurnParams = firstTurnConfig.function.parameters;
  Assert.deepEqual(
    firstTurnParams.properties,
    {},
    "First turn parameters should be an empty object"
  );

  // Check subsequent turn config
  const swappedToolsConfig = RunSearch.setGeneratedSearchQueryDescription(
    structuredClone(toolsConfig)
  );
  const subsequentTurnConfig = swappedToolsConfig.find(
    t => t.function?.name === "run_search"
  );
  Assert.ok(
    subsequentTurnConfig,
    "Subsequent turn run_search tool config should exist in toolsConfig"
  );
  Assert.equal(
    subsequentTurnConfig.type,
    "function",
    "Subsequent turn tool type should be 'function'"
  );
  Assert.equal(
    subsequentTurnConfig.function.description,
    RUN_SEARCH_GENERATED_QUERY_DESCRIPION,
    "Subsequent turn tool description should be the one for generated search queries."
  );
  const subsequentTurnParams = subsequentTurnConfig.function.parameters;
  Assert.ok(
    subsequentTurnParams.properties.query,
    "Should have a query parameter"
  );
  Assert.equal(
    subsequentTurnParams.properties.query.type,
    "string",
    "query should be a string"
  );
  Assert.ok(
    subsequentTurnParams.required.includes("query"),
    "query should be required"
  );
});

add_task(async function test_run_search_empty_query_returns_error() {
  const result = await RunSearch.runSearch({ query: "" });
  Assert.ok(
    result.includes("Error"),
    "Empty query should return an error string"
  );
});

add_task(async function test_run_search_null_query_returns_error() {
  const result = await RunSearch.runSearch({ query: null });
  Assert.ok(
    result.includes("Error"),
    "Null query should return an error string"
  );
});

add_task(async function test_run_search_whitespace_query_returns_error() {
  const result = await RunSearch.runSearch({ query: "   " });
  Assert.ok(
    result.includes("Error"),
    "Whitespace-only query should return an error string"
  );
});

function withFakeExaSearch(searchImpl) {
  const original = RunSearch._createExaClient;
  RunSearch._createExaClient = () => ({
    search: searchImpl,
  });
  registerCleanupFunction(() => {
    RunSearch._createExaClient = original;
  });
  return () => {
    RunSearch._createExaClient = original;
  };
}

add_task(async function test_runSearch_sets_security_flags() {
  const conversation = makeConversation();
  const restore = withFakeExaSearch(async () => ({
    results: [
      {
        title: "Example result",
        url: "https://example.com/",
        highlights: ["Example highlight"],
      },
    ],
  }));
  const result = await RunSearch.runSearch(
    { query: "test query" },
    null,
    conversation
  );
  restore();
  conversation.securityProperties.commit();

  Assert.ok(result.includes("Exa search results"), "Expected Exa results");
  Assert.equal(
    conversation.securityProperties.privateData,
    true,
    "private_data flag set"
  );
  Assert.equal(
    conversation.securityProperties.untrustedInput,
    true,
    "untrusted_input flag set"
  );
});

add_task(async function test_runSearch_allowed_when_flags_set() {
  const conversation = makeConversation({
    privateData: true,
    untrustedInput: true,
  });
  const restore = withFakeExaSearch(async () => ({ results: [] }));
  const result = await RunSearch.runSearch(
    { query: "test query" },
    null,
    conversation
  );
  restore();

  Assert.ok(result.includes("No Exa search results"), "no security refusal");
});

add_task(async function test_runSearch_no_security_flags_on_early_exit() {
  const conversation = makeConversation();
  await RunSearch.runSearch({ query: "" }, {}, conversation);
  conversation.securityProperties.commit();
  Assert.equal(
    conversation.securityProperties.untrustedInput,
    false,
    "flag not set early"
  );
});

add_task(async function test_run_search_uses_exa_without_browsingContext() {
  let searchParams;
  const restore = withFakeExaSearch(async params => {
    searchParams = params;
    return {
      results: [
        {
          title: "Result",
          url: "https://example.org/",
          text: "Result text",
        },
      ],
    };
  });
  const result = await RunSearch.runSearch(
    { query: "test query" },
    null,
    makeConversation()
  );
  restore();

  Assert.equal(searchParams.query, "test query");
  Assert.deepEqual(searchParams.contents, { highlights: true });
  Assert.ok(result.includes("https://example.org/"));
});
