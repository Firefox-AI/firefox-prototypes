/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/**
 * @import { GetTextOptions } from "../../PageExtractor.d.ts"
 */

/** @type {GetTextOptions} */
const REMOVE_BOILERPLATE = {
  removeBoilerplate: true,
  boilerplateStrategy: "landmarks",
};

/**
 * @param {string} text
 * @param {string[]} expected
 * @param {string[]} unexpected
 */
function checkText(text, expected, unexpected) {
  for (const snippet of expected) {
    ok(text.includes(snippet), `The text includes "${snippet}".`);
  }
  for (const snippet of unexpected) {
    ok(!text.includes(snippet), `The text does not include "${snippet}".`);
  }
}

add_task(async function test_boilerplate_keeps_content_outside_main_article() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <header>
      <nav><a href="/">Home</a> <a href="/recipes">All recipes</a></nav>
    </header>
    <main>
      <h1>Chewy Cookies</h1>
      <div class="intro">
        <p>
          These cookies are the result of many afternoons of baking, tasting,
          and adjusting the ratio of brown to white sugar until the edges came
          out crisp and the centers stayed soft for days. The dough rests
          overnight, which deepens the flavor considerably.
        </p>
        <p>
          Resting the dough also lets the flour hydrate fully, so the cookies
          spread less in the oven and develop a toffee-like flavor. If you are
          short on time, an hour in the fridge still helps, although the
          difference is noticeable.
        </p>
        <p>
          Use good chocolate. Chopped bars melt into puddles in a way that
          chips, which contain stabilizers, never quite manage, and the uneven
          pieces make every bite a little different from the last one.
        </p>
      </div>
      <div class="ingredients">
        <h2>Ingredients</h2>
        <ul>
          <li>1 cup butter, softened</li>
          <li>2 large eggs</li>
          <li>3 cups flour</li>
        </ul>
      </div>
      <div class="steps">
        <h2>Directions</h2>
        <ol>
          <li>Preheat the oven to 350 degrees F.</li>
          <li>Cream the butter and sugars.</li>
        </ol>
      </div>
    </main>
    <footer>Copyright Example Recipes</footer>
  `;

  checkText(
    (await getPageExtractor().getText(REMOVE_BOILERPLATE)).text,
    [
      "Chewy Cookies",
      "many afternoons of baking",
      "1 cup butter, softened",
      "2 large eggs",
      "Preheat the oven to 350 degrees F.",
    ],
    ["All recipes", "Copyright Example Recipes"]
  );

  await cleanup();
});

add_task(async function test_boilerplate_keeps_link_dense_content() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <header>
      <nav><a href="/">Home</a> <a href="/explore">Explore projects</a></nav>
    </header>
    <main>
      <section class="about">
        <p>
          This repository contains the source code of the project, along with
          its build system, its test suites and the tools used by contributors
          to work on it every day.
        </p>
        <p>
          The code is written in several languages and organized into
          components, each with its own directory, owners and documentation that
          explains how the component works.
        </p>
        <p>
          Releases are published on a regular schedule, and every change goes
          through code review and automated testing before it is merged into the
          main branch of the repository.
        </p>
        <p>
          The repository history goes back many years, so cloning it for the
          first time can take a while; a shallow clone is enough if you only
          want to build and run the latest version.
        </p>
      </section>
      <div class="readme">
        <h2>Getting involved</h2>
        <p>
          Start with the
          <a href="https://example.org/docs">contributor documentation</a> and
          pick a <a href="https://example.org/bugs">good first bug</a> to work
          on.
        </p>
        <p>
          Run the
          <a href="https://example.org/bootstrap">bootstrap command</a> before
          your first <a href="https://example.org/build">build</a>, then ask in
          the <a href="https://example.org/chat">developer chat</a>.
        </p>
        <p>
          Patches are reviewed on
          <a href="https://example.org/review">the review tool</a> and tested on
          <a href="https://example.org/ci">continuous integration</a>.
        </p>
      </div>
    </main>
  `;

  checkText(
    (await getPageExtractor().getText(REMOVE_BOILERPLATE)).text,
    [
      "This repository contains the source code",
      "Getting involved",
      "good first bug",
      "bootstrap command",
      "Patches are reviewed",
    ],
    ["Explore projects"]
  );

  await cleanup();
});

add_task(async function test_boilerplate_excludes_page_landmarks() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <header><a href="/">Site logo</a> <a href="/login">Sign in</a></header>
    <div role="navigation"><a href="/news">News section</a></div>
    <div role="dialog" aria-label="Cookies">Accept all cookies</div>
    <main>
      <header><h1>Article headline</h1></header>
      <nav><a href="#part-1">Table of contents</a></nav>
      <p>The article body is the content that should be extracted.</p>
      <aside>Related stories you may like</aside>
      <article>
        <header>Comment by a reader</header>
        <p>A comment that belongs to the page content.</p>
        <footer>Posted yesterday</footer>
      </article>
      <footer>Footer inside main</footer>
    </main>
    <footer>Site footer and legal notices</footer>
  `;

  checkText(
    (await getPageExtractor().getText(REMOVE_BOILERPLATE)).text,
    [
      "Article headline",
      "The article body is the content that should be extracted.",
      "Comment by a reader",
      "A comment that belongs to the page content.",
      "Posted yesterday",
      "Footer inside main",
    ],
    [
      "Site logo",
      "Sign in",
      "News section",
      "Accept all cookies",
      "Table of contents",
      "Related stories you may like",
      "Site footer and legal notices",
    ]
  );

  await cleanup();
});

add_task(async function test_boilerplate_without_main_landmark() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <header>
      <nav><a href="/">Home</a> <a href="/about">About us</a></nav>
    </header>
    <div class="content">
      <h1>A page without a main element</h1>
      <p>Its content is still extracted from the body.</p>
    </div>
    <aside>Advertisement</aside>
    <footer>Site footer</footer>
  `;

  checkText(
    (await getPageExtractor().getText(REMOVE_BOILERPLATE)).text,
    [
      "A page without a main element",
      "Its content is still extracted from the body.",
    ],
    ["About us", "Advertisement", "Site footer"]
  );

  await cleanup();
});

add_task(async function test_boilerplate_with_empty_main_landmark() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <nav><a href="/">Home</a> <a href="/shop">Shop all</a></nav>
    <main><span>Loading</span></main>
    <div class="app">
      <h1>Single page app content</h1>
      <p>The app renders its content outside of the main element.</p>
    </div>
  `;

  checkText(
    (await getPageExtractor().getText(REMOVE_BOILERPLATE)).text,
    [
      "Single page app content",
      "The app renders its content outside of the main element.",
    ],
    ["Shop all"]
  );

  await cleanup();
});

add_task(async function test_boilerplate_defaults_to_reader_mode() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const paragraph =
    "Reader mode stays the default way to remove boilerplate. ".repeat(6);
  const { getPageExtractor, cleanup } = await html`
    <nav><a href="/">Home</a> <a href="/blog">Blog index</a></nav>
    <main>
      <article>
        <h1>Reader strategy</h1>
        <p>${paragraph}</p>
        <p>${paragraph}</p>
      </article>
      <div class="comments"><p>A comment from a reader.</p></div>
    </main>
  `;
  const actor = getPageExtractor();

  checkText(
    (await actor.getText({ removeBoilerplate: true })).text,
    ["Reader strategy", "Reader mode stays the default"],
    ["Blog index", "A comment from a reader."]
  );
  checkText(
    (await actor.getText(REMOVE_BOILERPLATE)).text,
    ["Reader strategy", "A comment from a reader."],
    ["Blog index"]
  );

  await cleanup();
});

add_task(async function test_boilerplate_drops_action_buttons() {
  const { html } = await MLTestUtils.serveHTMLInTab({ browser: gBrowser });
  const { getPageExtractor, cleanup } = await html`
    <main>
      <h1>Content-Security-Policy</h1>
      <p>
        The HTTP Content-Security-Policy response header allows website
        administrators to control resources the user agent is allowed to load
        for a given page, which helps guard against cross-site scripting.
      </p>
      <div class="code-example">
        <div class="example-header">
          <span>http</span>
          <button type="button">Copy</button>
          <mdn-copy-button><span>Copy code</span></mdn-copy-button>
          <span role="button">Share</span>
        </div>
        <pre><code>Content-Security-Policy: default-src 'self'</code></pre>
      </div>
      <h2>
        <button aria-expanded="false">Is it supported everywhere?</button>
      </h2>
      <button aria-expanded="true">Show browser details</button>
    </main>
  `;
  const actor = getPageExtractor();

  checkText(
    (await actor.getText(REMOVE_BOILERPLATE)).text,
    [
      "Content-Security-Policy: default-src 'self'",
      "Is it supported everywhere?",
      "Show browser details",
    ],
    ["Copy", "Share"]
  );
  checkText((await actor.getText()).text, ["Copy"], []);

  return cleanup();
});
