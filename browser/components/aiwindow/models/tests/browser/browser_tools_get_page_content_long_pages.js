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
