/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ChatConversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
);

const CHUNKING_PREF = "browser.smartwindow.pageContent.chunking.enabled";

/**
 * A page longer than one read, with a fact in the middle of its last section.
 *
 * @returns {string}
 */
function longPage() {
  const paragraph = (topic, n) =>
    Array.from(
      { length: 8 },
      (_, i) => `Sentence ${i} of paragraph ${n} is about ${topic} only.`
    ).join(" ");
  const section = (topic, middle = "") =>
    `<h2>${topic}</h2>` +
    Array.from({ length: 12 }, (_, n) => `<p>${paragraph(topic, n)}</p>`)
      .map((p, n) => (n == 6 ? middle + p : p))
      .join("");
  return `<!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Example Page</title></head>
    <body>
      <main>
        <h1>Example Page</h1>
        ${section("history")}
        ${section("features")}
        ${section("security")}
        ${section("reception")}
        ${section("archives", "<p>The walrus ledger opened in 1998.</p>")}
      </main>
    </body>
    </html>`;
}

function newConversation(question) {
  const conversation = new ChatConversation({
    title: "",
    description: "",
    pageUrl: new URL("https://example.com"),
    pageMeta: {},
  });
  conversation.addUserMessage(question, "", 0);
  return conversation;
}

/**
 * Reads a page as Chat does: with follow-up reads, recording the call and its
 * result in the conversation.
 *
 * @param {object} GetPageContent
 * @param {ChatConversation} conversation
 * @param {string} id - The tool call id.
 * @param {object} params - The tool call arguments.
 * @returns {Promise<string>} The content returned for the first URL.
 */
async function readLikeChat(GetPageContent, conversation, id, params) {
  conversation.addAssistantMessage("function", {
    tool_calls: [
      {
        id,
        type: "function",
        function: {
          name: "get_page_content",
          arguments: JSON.stringify(params),
        },
      },
    ],
  });
  const results = await GetPageContent.getPageContent(params, conversation, {
    followUps: true,
  });
  conversation.addToolCallMessage({
    tool_call_id: id,
    body: results.map(result => result.content),
    name: "get_page_content",
  });
  return results[0].content;
}

add_task(async function test_chunked_read_finds_a_late_fact() {
  await SpecialPowers.pushPrefEnv({ set: [[CHUNKING_PREF, true]] });
  const { url_list, GetPageContent, cleanup } =
    await setupGetPageContentTests(longPage());

  const [read] = await GetPageContent.getPageContent(
    { url_list, query: "When did the walrsu ledger open?" },
    newConversation("When did the walrus ledger open?")
  );
  Assert.ok(read.ok, "The read succeeds.");
  Assert.stringContains(read.content, "opened in 1998", "Typos are corrected.");
  Assert.lessOrEqual(
    read.content.length,
    GetPageContent.MAX_CHARACTERS + 100,
    "The read fits the budget."
  );

  const [overview] = await GetPageContent.getPageContent(
    { url_list },
    newConversation("What is this page about?")
  );
  Assert.stringContains(
    overview.content,
    "beginning of each section",
    "A read without a query is an overview."
  );

  await cleanup();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_follow_up_reads() {
  await SpecialPowers.pushPrefEnv({ set: [[CHUNKING_PREF, true]] });
  const { url_list, GetPageContent, cleanup } =
    await setupGetPageContentTests(longPage());
  const conversation = newConversation("When did the walrus ledger open?");

  const first = await readLikeChat(GetPageContent, conversation, "call_1", {
    url_list,
    query: "security sandboxing",
  });
  Assert.ok(!first.includes("walrus"), "The first read misses the fact.");

  const followUp = await readLikeChat(GetPageContent, conversation, "call_2", {
    url_list,
    query: "walrus ledger",
    max_characters: 1500,
  });
  Assert.stringContains(followUp, "[More of this page");
  Assert.stringContains(followUp, "opened in 1998", "The follow-up finds it.");
  Assert.lessOrEqual(
    followUp.length,
    1500 + 100,
    "The follow-up returns no more than the model asked for."
  );
  const firstLines = new Set(
    first
      .split("\n")
      .filter(line => line.length > 60 && !line.startsWith("Content from"))
  );
  Assert.deepEqual(
    followUp.split("\n").filter(line => firstLines.has(line)),
    [],
    "The follow-up repeats nothing from the first read."
  );

  const capped = await readLikeChat(GetPageContent, conversation, "call_3", {
    url_list,
    query: "appendix",
  });
  Assert.stringContains(
    capped,
    "already read this turn",
    "One follow-up per turn, so the model can't read the page in a loop."
  );

  await cleanup();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_description_follows_the_budgets() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.smartwindow.pageContent.followUps.budget", 4000],
      ["browser.smartwindow.pageContent.alternateQueries.max", 2],
    ],
  });
  const { getPageContentToolConfigChunked } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
  );
  const { description, parameters } =
    getPageContentToolConfigChunked().function;
  Assert.stringContains(description, "at most 4,000");
  Assert.equal(parameters.properties.max_characters.maximum, 4000);
  Assert.equal(parameters.properties.alternate_queries.maxItems, 2);
  Assert.stringContains(
    parameters.properties.alternate_queries.description,
    "up to 2 other ways"
  );
  await SpecialPowers.popPrefEnv();
});
