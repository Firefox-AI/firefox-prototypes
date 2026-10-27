/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const BROWSE_AGENT_TEST_PAGE =
  "https://example.com/browser/browser/components/aiwindow/models/tests/browser/browse_agent_test_page.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.smartwindow.browseAgent.enabled", true]],
  });
});

function query(browser, name, data = {}) {
  return browser.browsingContext.currentWindowGlobal
    .getActor("BrowseAgent")
    .sendQuery(`BrowseAgent:${name}`, data);
}

function readResult(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.document.getElementById("result").textContent
  );
}

async function waitForResult(browser, expected) {
  await TestUtils.waitForCondition(
    async () => (await readResult(browser)) === expected,
    `Waiting for the page to report "${expected}"`
  );
}

async function listedElement(browser, label) {
  const { elements } = await query(browser, "ListElements");
  const element = elements.find(el => el.label === label);
  Assert.ok(element, `"${label}" is listed`);
  return element;
}

add_task(async function test_viewport_and_list_elements() {
  await BrowserTestUtils.withNewTab(BROWSE_AGENT_TEST_PAGE, async browser => {
    const viewport = await query(browser, "Viewport");
    Assert.greater(viewport.width, 0, "viewport has a width");
    Assert.greater(viewport.height, 0, "viewport has a height");
    Assert.equal(viewport.url, BROWSE_AGENT_TEST_PAGE, "url is reported");
    Assert.equal(viewport.title, "Browse Agent Test Page", "title is reported");
    Assert.equal(viewport.readyState, "complete", "document is loaded");

    const { elements, total } = await query(browser, "ListElements");
    Assert.greater(total, 0, "candidates were found");
    const labels = elements.map(el => el.label);
    Assert.ok(
      labels.includes("Search products"),
      "input listed by placeholder"
    );
    Assert.ok(labels.includes("Search"), "submit button listed");
    Assert.ok(labels.includes("Add to cart"), "button listed by text");
    Assert.ok(labels.includes("Product details"), "link listed by text");
    Assert.ok(!labels.includes("Hidden button"), "hidden element not listed");
    Assert.ok(
      !labels.includes("Far away button"),
      "offscreen element not listed"
    );

    const select = elements.find(el => el.tag === "select");
    Assert.equal(select.label, "Size", "select listed by aria-label");
    const link = elements.find(el => el.label === "Product details");
    Assert.ok(link.href.endsWith("#details"), "links carry their href");
    for (const el of elements) {
      Assert.ok(
        el.x >= 0 &&
          el.x < viewport.width &&
          el.y >= 0 &&
          el.y < viewport.height,
        `${el.label} has viewport coordinates`
      );
    }
  });
});

add_task(async function test_click_type_and_keys() {
  await BrowserTestUtils.withNewTab(BROWSE_AGENT_TEST_PAGE, async browser => {
    const add = await listedElement(browser, "Add to cart");
    const click = await query(browser, "Click", {
      x: add.x,
      y: add.y,
      button: "left",
      double: false,
    });
    Assert.ok(click.target.includes("Add to cart"), "click reports its target");
    await waitForResult(browser, "added");

    await Assert.rejects(
      query(browser, "Type", { text: "nope", submit: false }),
      /Nothing that accepts text is focused/,
      "typing with nothing focused is refused"
    );

    const input = await listedElement(browser, "Search products");
    await query(browser, "Click", {
      x: input.x,
      y: input.y,
      button: "left",
      double: false,
    });
    const typed = await query(browser, "Type", {
      text: "chair",
      submit: false,
    });
    Assert.ok(typed.target.includes("input"), "typing reports the field");
    Assert.equal(
      await SpecialPowers.spawn(
        browser,
        [],
        () => content.document.getElementById("q").value
      ),
      "chair",
      "text was typed into the focused input"
    );

    await query(browser, "Key", { keys: "ctrl+a", repeat: 1 });
    await query(browser, "Type", { text: "desk", submit: true });
    await waitForResult(browser, "submitted:desk");

    await Assert.rejects(
      query(browser, "Key", { keys: "bogus+a", repeat: 1 }),
      /Unknown modifier/,
      "unknown modifiers are reported"
    );
  });
});

add_task(async function test_scroll_read_and_find() {
  await BrowserTestUtils.withNewTab(BROWSE_AGENT_TEST_PAGE, async browser => {
    const page = await query(browser, "ReadPage");
    Assert.ok(page.text.includes("Browse Agent Test Page"), "page text read");
    Assert.ok(page.text.includes("Add to cart"), "button text included");
    Assert.ok(!page.truncated, "short page is not truncated");

    const down = await query(browser, "Scroll", {
      direction: "down",
      amount: 1,
    });
    Assert.greater(down.scrollY, 0, "the page scrolled down");
    Assert.ok(down.target.includes("<html"), "the page itself scrolled");
    const up = await query(browser, "Scroll", { direction: "up", amount: 5 });
    Assert.equal(up.scrollY, 0, "the page scrolled back up");

    const scroller = await SpecialPowers.spawn(browser, [], () => {
      const rect = content.document
        .getElementById("scroller")
        .getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const inner = await query(browser, "Scroll", {
      direction: "down",
      amount: 0.5,
      ...scroller,
    });
    Assert.ok(inner.target.includes("scroller"), "scrollable ancestor used");
    Assert.greater(inner.scrollY, 0, "the inner scroller moved");
    Assert.equal(
      await SpecialPowers.spawn(browser, [], () => content.scrollY),
      0,
      "the page did not scroll"
    );

    const { matches } = await query(browser, "Find", { text: "far away" });
    Assert.equal(matches.length, 1, "one match for the offscreen button");
    Assert.equal(matches[0].label, "Far away button");
    Assert.ok(matches[0].inViewport, "the match was scrolled into view");
    await query(browser, "Click", {
      x: matches[0].x,
      y: matches[0].y,
      button: "left",
      double: false,
    });
    await waitForResult(browser, "far-clicked");

    const none = await query(browser, "Find", { text: "zzz nothing here" });
    Assert.equal(none.matches.length, 0, "no matches for absent text");
    await Assert.rejects(
      query(browser, "Find", { text: "   " }),
      /find needs some text/,
      "empty search text is refused"
    );
  });
});

add_task(async function test_select_option_and_hover() {
  await BrowserTestUtils.withNewTab(BROWSE_AGENT_TEST_PAGE, async browser => {
    const size = await listedElement(browser, "Size");
    const selected = await query(browser, "SelectOption", {
      x: size.x,
      y: size.y,
      option: "Large",
    });
    Assert.equal(selected.selected, "Large");
    Assert.equal(selected.value, "l");
    await waitForResult(browser, "size:l");

    await Assert.rejects(
      query(browser, "SelectOption", {
        x: size.x,
        y: size.y,
        option: "Gigantic",
      }),
      /No option matches "Gigantic"\. Options: Small \| Medium \| Large/,
      "unknown options list the available ones"
    );
    const add = await listedElement(browser, "Add to cart");
    await Assert.rejects(
      query(browser, "SelectOption", { x: add.x, y: add.y, option: "Large" }),
      /There is no <select>/,
      "select_option needs a native select"
    );

    const { matches } = await query(browser, "Find", { text: "hover me" });
    Assert.equal(matches[0].tag, "div", "plain text is found too");
    await query(browser, "Hover", { x: matches[0].x, y: matches[0].y });
    await waitForResult(browser, "hovered");
  });
});
