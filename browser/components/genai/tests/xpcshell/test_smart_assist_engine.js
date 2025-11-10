/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { SmartAssistEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/genai/SmartAssistEngine.sys.mjs"
);

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const {
  normalizeTextForWhitelist,
  tokenize,
  buildPhraseSets,
  makeIsolatedPhraseChecker,
  _isForcedChatIsolated,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/genai/SmartAssistEngine.sys.mjs"
);

// Prefs
const PREF_API_KEY = "browser.ml.smartAssist.apiKey";
const PREF_ENDPOINT = "browser.ml.smartAssist.endpoint";
const PREF_MODEL = "browser.ml.smartAssist.model";

// Clean prefs after all tests
registerCleanupFunction(() => {
  for (let pref of [PREF_API_KEY, PREF_ENDPOINT, PREF_MODEL]) {
    if (Services.prefs.prefHasUserValue(pref)) {
      Services.prefs.clearUserPref(pref);
    }
  }
});

add_task(async function test_createOpenAIEngine_uses_prefs_and_static_fields() {
  Services.prefs.setStringPref(PREF_API_KEY, "test-key-123");
  Services.prefs.setStringPref(PREF_ENDPOINT, "https://example.test/v1");
  Services.prefs.setStringPref(PREF_MODEL, "gpt-fake");

  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        throw new Error("not used");
      },
    };
    const stub = sb
      .stub(SmartAssistEngine, "_createEngine")
      .resolves(fakeEngine);

    const engine = await SmartAssistEngine.createOpenAIEngine();

    Assert.strictEqual(
      engine,
      fakeEngine,
      "Should return engine from _createEngine"
    );
    Assert.ok(stub.calledOnce, "_createEngine should be called once");

    const opts = stub.firstCall.args[0];
    Assert.equal(opts.apiKey, "test-key-123", "apiKey should come from pref");
    Assert.equal(
      opts.baseURL,
      "https://example.test/v1",
      "baseURL should come from pref"
    );
    Assert.equal(opts.modelId, "gpt-fake", "modelId should come from pref");
  } finally {
    sb.restore();
  }
});

add_task(async function test_fetchWithHistory_streams_and_forwards_args() {
  const sb = sinon.createSandbox();
  try {
    let capturedArgs = null;
    let capturedStreamOption = null;

    // Fake async generator that yields three text chunks and one empty (ignored)
    const fakeEngine = {
      runWithGenerator({ streamOptions, args }) {
        capturedArgs = args;
        capturedStreamOption = streamOptions;
        async function* gen() {
          yield { text: "Hello" };
          yield { text: " from" };
          yield { text: " fake engine!" };
          yield {}; // ignored by SmartAssistEngine
        }
        return gen();
      },
    };

    sb.stub(SmartAssistEngine, "_createEngine").resolves(fakeEngine);

    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi there" },
    ];

    // Collect streamed output
    let acc = "";
    for await (const t of SmartAssistEngine.fetchWithHistory(messages)) {
      acc += t;
    }

    Assert.equal(
      acc,
      "Hello from fake engine!",
      "Should concatenate streamed chunks"
    );
    Assert.deepEqual(
      capturedArgs,
      messages,
      "Should forward messages as args to runWithGenerator()"
    );
    Assert.deepEqual(
      capturedStreamOption.enabled,
      true,
      "Should enable streaming in runWithGenerator()"
    );
  } finally {
    sb.restore();
  }
});

add_task(
  async function test_fetchWithHistory_propagates_engine_creation_rejection() {
    const sb = sinon.createSandbox();
    try {
      const err = new Error("creation failed (generic)");
      const stub = sb.stub(SmartAssistEngine, "_createEngine").rejects(err);
      const messages = [{ role: "user", content: "Hi" }];

      // Must CONSUME the async generator to trigger the rejection
      const consume = async () => {
        for await (const _message of SmartAssistEngine.fetchWithHistory(
          messages
        )) {
          void _message;
        }
      };

      await Assert.rejects(
        consume(),
        e => e === err,
        "Should propagate the same error thrown by _createEngine"
      );
      Assert.ok(stub.calledOnce, "_createEngine should be called once");
    } finally {
      sb.restore();
    }
  }
);

add_task(async function test_fetchWithHistory_propagates_stream_error() {
  const sb = sinon.createSandbox();
  try {
    const fakeEngine = {
      runWithGenerator() {
        async function* gen() {
          yield { text: "partial" };
          throw new Error("engine stream boom");
        }
        return gen();
      },
    };
    sb.stub(SmartAssistEngine, "_createEngine").resolves(fakeEngine);

    const consume = async () => {
      let acc = "";
      for await (const t of SmartAssistEngine.fetchWithHistory([
        { role: "user", content: "x" },
      ])) {
        acc += t;
      }
      return acc;
    };

    await Assert.rejects(
      consume(),
      e => /engine stream boom/.test(e.message),
      "Should propagate errors thrown during streaming"
    );
  } finally {
    sb.restore();
  }
});

add_task(async function test_getPromptIntent_basic() {
  const sb = sinon.createSandbox();
  const cases = [
    { prompt: "please search for news on firefox", expected: "search" },
    { prompt: "Can you FIND me the docs for PageAssist?", expected: "search" }, // case-insensitive
    { prompt: "look up the best pizza in SF", expected: "search" },
    { prompt: "hello there, how are you?", expected: "chat" },
    { prompt: "tell me a joke", expected: "chat" },
  ];

  const fakeEngine = {
    run({ args: [[query]] }) {
      const searchKeywords = [
        "search",
        "find",
        "look",
        "query",
        "locate",
        "explore",
      ];
      const formattedPrompt = query.toLowerCase();
      const isSearch = searchKeywords.some(keyword =>
        formattedPrompt.includes(keyword)
      );

      // Simulate model confidence scores
      if (isSearch) {
        return [
          { label: "search", score: 0.95 },
          { label: "chat", score: 0.05 },
        ];
      }
      return [
        { label: "chat", score: 0.95 },
        { label: "search", score: 0.05 },
      ];
    },
  };

  sb.stub(SmartAssistEngine, "_createEngine").resolves(fakeEngine);

  for (const { prompt, expected } of cases) {
    const intent = await SmartAssistEngine.getPromptIntent(prompt);
    Assert.equal(
      intent,
      expected,
      `getPromptIntent("${prompt}") should return "${expected}"`
    );
  }

  sb.restore();
});

add_task(async function test_preprocessQuery_removes_question_marks() {
  const sb = sinon.createSandbox();

  // Use a minimal fake SmartAssistEngine to test only preprocessing
  const engine = Object.create(SmartAssistEngine);

  const cases = [
    { input: "hello?", expected: "hello" },
    { input: "?prompt", expected: "prompt" },
    { input: "multiple???", expected: "multiple" },
    { input: "mid?dle", expected: "middle" },
    { input: "question? ", expected: "question" },
    { input: " no?  spaces? ", expected: "no  spaces" },
    { input: "???", expected: "" },
    { input: "clean input", expected: "clean input" },
  ];

  for (const { input, expected } of cases) {
    const result = engine._preprocessQuery(input);
    Assert.equal(
      result,
      expected,
      `Expected "${input}" to preprocess to "${expected}", got "${result}"`
    );
  }

  sb.restore();
});

add_task(function test_normalizeTextForWhitelist_basic() {
  // lowercasing + trimming + collapsing internal spaces
  Assert.equal(
    normalizeTextForWhitelist("  HeLLo   There  "),
    "hello there",
    "Should lowercase, trim, and collapse spaces"
  );

  // NFKC normalization: compatibility forms → canonical
  // Fullwidth characters normalize: e.g., 'ＴＥＳＴ' → 'test'
  Assert.equal(
    normalizeTextForWhitelist("ＴＥＳＴ  １２３"),
    "test 123",
    "Should NFKC-normalize fullwidth letters/digits"
  );

  // Multiple whitespace kinds (NBSP, tabs, newlines) collapse
  Assert.equal(
    normalizeTextForWhitelist("a\u00A0b\tc\nd"),
    "a b c d",
    "Should collapse all whitespace kinds to single spaces"
  );
});

add_task(function test_tokenize_unicode_and_boundaries() {
  // Splits on non-word chars, keeps letters/digits/underscore
  Assert.deepEqual(
    tokenize("hello, world! 42_times"),
    ["hello", "world", "42_times"],
    "Should split on punctuation and keep underscores"
  );

  // Unicode letters should be treated as word chars (\p{L})
  Assert.deepEqual(
    tokenize("mañana—café!"),
    ["mañana", "café"],
    "Should keep Unicode letters and split on punctuation (em dash, bang)"
  );

  // Apostrophes split (non-word), as intended
  Assert.deepEqual(
    tokenize("what's up"),
    ["what", "s", "up"],
    "Apostrophes are separators, so tokens split around them"
  );
});

add_task(function test_buildPhraseSets_grouping_and_normalization() {
  const phrases = [
    "sup",
    "hi there",           // 2 tokens
    "what's up",          // becomes "what s up" (3 tokens)
    " foo   bar  ",       // leading/trailing + multiple spaces
    "",                   // empty should be skipped
    "___",                // token of underscores counts as 1 token
  ];
  const sets = buildPhraseSets(phrases);

  // Expect keys for lengths: 1, 2, 3
  Assert.ok(sets.has(1), "Should have set for single-token phrases");
  Assert.ok(sets.has(2), "Should have set for two-token phrases");
  Assert.ok(sets.has(3), "Should have set for three-token phrases");

  // 1-token set contains: "sup", "___"
  Assert.ok(sets.get(1).has("sup"), "Single-token set should contain 'sup'");
  Assert.ok(sets.get(1).has("___"), "Single-token set should contain '___'");

  // 2-token set contains normalized "hi there" and "foo bar"
  Assert.ok(sets.get(2).has("hi there"), "Two-token set should contain 'hi there'");
  Assert.ok(sets.get(2).has("foo bar"), "Two-token set should contain normalized 'foo bar'");

  // 3-token set contains "what s up" (note apostrophe split)
  Assert.ok(sets.get(3).has("what s up"), "Three-token set should contain 'what s up'");

  // Empty phrase skipped: nothing added for length 0
  for (const [k, set] of sets) {
    Assert.ok(k > 0 && set.size >= 1, "No empty keys, each set has at least one entry");
  }
});

add_task(function test_isolated_phrase_checker_single_word_boundaries() {
  const phrases = ["sup", "hello", "___"];
  const isForced = makeIsolatedPhraseChecker(phrases);

  // Positive: exact token present
  Assert.ok(isForced("sup bro"), "Should match 'sup' as an isolated token at start");
  Assert.ok(isForced("hey, hello there"), "Should match 'hello' surrounded by punctuation");
  Assert.ok(isForced("foo ___ bar"), "Should match token with underscores");

  // Negative: partial-word should NOT match
  Assert.ok(!isForced("supposingly, this should not match"), "No partial-word match for 'sup'");
  Assert.ok(!isForced("supper time"), "No partial-word match inside 'supper'");
  Assert.ok(!isForced("shelloworld"), "No partial-word match for 'hello'");
});

add_task(function test_isolated_phrase_checker_multiword_and_punctuation() {
  // Multiword phrases; apostrophes become token splits -> "what's up" => "what s up"
  const phrases = ["hi there", "what's up"];
  const isForced = makeIsolatedPhraseChecker(phrases);

  // Positive: punctuation between words should still match (token split)
  Assert.ok(isForced("hi—there!"), "Em dash between words should match 'hi there'");
  Assert.ok(isForced("well, hi there!!"), "Punctuation around phrase should match");
  Assert.ok(isForced("so, what’s up today?"), "Curly apostrophe splits to tokens; should match 'what s up'");

  // Negative: glued words should not match
  Assert.ok(!isForced("hithere"), "Concatenated words should not match 'hi there'");
  Assert.ok(!isForced("whatssup"), "Should not match 'what s up' without separators");
});

add_task(function test_isolated_phrase_checker_spacing_and_unicode_norm() {
  const phrases = ["good morning", "hello"];
  const isForced = makeIsolatedPhraseChecker(phrases);

  // Multiple spaces collapse
  Assert.ok(isForced("good     morning everyone"), "Multiple spaces between tokens should still match");

  // Fullwidth / NFKC normalization (ＴＥＳＴ) and basic usage
  Assert.ok(isForced("  HELLO  "), "Case and surrounding spaces should normalize and match 'hello'");

  // Non-breaking spaces and tabs
  Assert.ok(isForced("good\u00A0morning\tteam"), "NBSP and tabs normalize and match");
});

add_task(function test_isolated_phrase_checker_no_match_cases() {
  const phrases = ["hi there", "sup"];
  const isForced = makeIsolatedPhraseChecker(phrases);

  Assert.ok(!isForced(""), "Empty string should not match");
  Assert.ok(!isForced("nothing to see here"), "Unrelated text should not match");
  Assert.ok(!isForced("support"), "Partial token with 'sup' prefix should not match");
});

add_task(function test_isolated_phrase_checker_caching_stability() {
  const phrases = ["hello", "hi there"];
  const isForced = makeIsolatedPhraseChecker(phrases);

  // Repeated calls with the same input should return identical results (cache sanity)
  const q1 = "Hello there!";
  const first = isForced(q1);
  const second = isForced(q1);
  Assert.equal(first, second, "Same query should yield identical result across calls (cache-stable)");

  // Different whitespace should normalize to the same outcome
  Assert.equal(isForced("  hello   there "), isForced("hello there"), "Whitespace variations should not affect result");
});
