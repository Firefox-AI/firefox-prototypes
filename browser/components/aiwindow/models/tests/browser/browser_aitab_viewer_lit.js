/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const SAMPLE_PAGE = Object.freeze({
  header: {
    type: "header",
    eyebrow: "From your open tabs",
    icon: "H",
    title: "Hotels in Lisbon",
    subhead: "Gathered from your tabs",
  },
  blocks: [
    {
      type: "text",
      layout: "summary",
      lead: "Budget Central Hostel is $72 / night.",
    },
    {
      type: "list",
      layout: "takeaways",
      title: "What stands out",
      items: [
        {
          number: "01",
          title: "Walkable",
          body: "A short walk from Baixa.",
        },
      ],
    },
  ],
});

add_task(async function test_about_smartwindowtasks_renders_hash() {
  const url = `about:smartwindowtasks#${encodeURIComponent(
    JSON.stringify(SAMPLE_PAGE)
  )}`;
  await BrowserTestUtils.withNewTab(url, async browser => {
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.querySelector(".aitab-title"),
        "aitab-page rendered the header title"
      );
      const title = content.document.querySelector(".aitab-title");
      Assert.ok(title.textContent.includes("Hotels in Lisbon"));
      Assert.ok(content.document.querySelector(".aitab-takeaways"));
      Assert.ok(
        !content.document.querySelector("ai-tasks"),
        "the tasks UI is not loaded when a page hash is present"
      );
      Assert.equal(content.document.title, "Hotels in Lisbon");
    });
  });
});

add_task(async function test_about_smartwindowtasks_without_hash_keeps_tasks() {
  await BrowserTestUtils.withNewTab("about:smartwindowtasks", async browser => {
    await SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.querySelector("ai-tasks"),
        "ai-tasks still loads without a hash"
      );
      Assert.ok(!content.document.querySelector("aitab-page"));
    });
  });
});
