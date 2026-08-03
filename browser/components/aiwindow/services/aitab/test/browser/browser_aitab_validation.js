/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Exercises the real packaged schemas (fetched via loadAssets from chrome://):
// buildPage() validates a page config against the schemas and returns the
// validated config. Runs as a browser-chrome test because loadAssets needs the
// browser chrome package, which xpcshell lacks.

const { loadAssets, buildPage } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs"
);

let gEnv;

add_setup(async function () {
  const { env } = await loadAssets();
  gEnv = env;
});

// A well-formed page config exercising every block type.
const VALID_PAGE = Object.freeze({
  version: "1",
  theme: "firefox",
  header: {
    type: "header",
    icon: "🏨",
    title: "Hotels in Lisbon",
    subhead: "4 options gathered from your open tabs",
  },
  blocks: [
    {
      type: "info",
      size: "square",
      icon: "💰",
      heading: "Cheapest",
      value: "$72 / night",
      accent: true,
    },
    {
      type: "list",
      title: "Compare",
      itemType: "Hotel",
      layout: "table",
      fields: [
        { key: "name", label: "Name", type: "text", role: "title" },
        {
          key: "price",
          label: "Price",
          type: "currency",
          role: "detail",
          sortable: true,
          suffix: " / night",
          goal: "min",
        },
      ],
      data: [{ name: "Budget Central Hostel", price: 72 }],
    },
    {
      type: "todo",
      title: "Before you book",
      items: [
        { text: "Check the free-cancellation window", priority: "high" },
        { text: "Compare total price incl. taxes", done: false },
      ],
    },
  ],
  footer: {
    type: "footer",
    text: "Next steps",
    buttons: [
      { text: "Book", href: "https://www.booking.com", variant: "primary" },
    ],
  },
});

add_task(function test_valid_page_validates() {
  const result = buildPage(VALID_PAGE, gEnv);
  Assert.ok(
    result.ok,
    `valid page should pass validation; errors: ${JSON.stringify(
      result.errors
    )}`
  );
  Assert.deepEqual(
    result.page,
    VALID_PAGE,
    "the validated page config is returned unchanged"
  );
});

add_task(function test_missing_required_blocks() {
  const result = buildPage(
    { header: { type: "header", title: "No blocks" } },
    gEnv
  );
  Assert.ok(!result.ok, "page without `blocks` is rejected");
  Assert.greater(result.errors.length, 0, "reports at least one error");
});

add_task(function test_header_missing_title() {
  const result = buildPage({ header: { type: "header" }, blocks: [] }, gEnv);
  Assert.ok(!result.ok, "header without required `title` is rejected");
});

add_task(function test_unknown_block_type() {
  const result = buildPage({ blocks: [{ type: "banner" }] }, gEnv);
  Assert.ok(!result.ok, "unknown block type is rejected");
  Assert.ok(
    result.errors.some(e => e.instanceLocation?.includes("/blocks")),
    "an error points at the offending blocks entry"
  );
});

add_task(function test_info_block_requires_content() {
  // info requires one of value/body/heading (anyOf).
  const result = buildPage({ blocks: [{ type: "info" }] }, gEnv);
  Assert.ok(!result.ok, "empty info panel is rejected");
});

add_task(function test_list_block_missing_data() {
  const result = buildPage(
    { blocks: [{ type: "list", fields: [{ key: "a", type: "text" }] }] },
    gEnv
  );
  Assert.ok(!result.ok, "list without `data` is rejected");
});

add_task(function test_additional_property_rejected() {
  const result = buildPage(
    { blocks: [], header: { type: "header", title: "X", bogus: 1 } },
    gEnv
  );
  Assert.ok(!result.ok, "unexpected property on a block is rejected");
});

// --- browser.smartwindow.aitab.components pref override -------------------

const COMPONENTS_PREF = "browser.smartwindow.aitab.components";

// Minimal override schema set: a page of "note" blocks. Each schema's bare $id
// is its key, so "note" introduces a "note" block type the packaged schemas
// don't have.
const OVERRIDE_PAGE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "page",
  type: "object",
  required: ["blocks"],
  additionalProperties: false,
  properties: {
    blocks: {
      type: "array",
      items: { oneOf: [{ $ref: "note" }] },
    },
  },
};

const OVERRIDE_NOTE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "note",
  type: "object",
  required: ["type", "text"],
  additionalProperties: false,
  properties: {
    type: { const: "note" },
    text: { type: "string", minLength: 1 },
  },
};

add_task(async function test_pref_override() {
  Services.prefs.setStringPref(
    COMPONENTS_PREF,
    JSON.stringify([OVERRIDE_PAGE_SCHEMA, OVERRIDE_NOTE_SCHEMA])
  );

  try {
    const { env } = await loadAssets();

    Assert.deepEqual(
      [...env.names].sort(),
      ["note", "page"],
      "schemas are read from the pref, replacing the packaged set"
    );
    Assert.ok(
      "note" in env.typeSchema,
      "block type is derived from the bare $id"
    );
    Assert.ok(
      !("list" in env.typeSchema),
      "packaged block types are replaced, not merged"
    );

    let result = buildPage({ blocks: [{ type: "note", text: "hi" }] }, env);
    Assert.ok(
      result.ok,
      `an override-schema page validates; errors: ${JSON.stringify(result.errors)}`
    );

    result = buildPage(
      { blocks: [{ type: "list", fields: [], data: [] }] },
      env
    );
    Assert.ok(
      !result.ok,
      "a packaged block type is unknown under the override schema set"
    );
  } finally {
    Services.prefs.clearUserPref(COMPONENTS_PREF);
  }
});

add_task(async function test_reverts_to_packaged_when_unset() {
  // loadOverrideEnv re-reads the pref each call, so clearing it reverts
  // immediately.
  const { env } = await loadAssets();
  Assert.ok(
    "list" in env.typeSchema,
    "reverts to the packaged schemas once the pref is cleared"
  );
});
