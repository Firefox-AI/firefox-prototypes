/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

do_get_profile();

const { JevBrowserEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/JevBrowserEngine.sys.mjs"
);

function makeFetch(answerQueue, requests) {
  return async (url, options) => {
    requests.push({
      url,
      authorization: options.headers.Authorization,
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return { model: "jev-test", answers: answerQueue.shift() };
      },
    };
  };
}

add_task(async function test_routes_planned_scroll_to_browser_scroll() {
  const requests = [];
  const dispatched = [];
  const engine = new JevBrowserEngine({
    apiKey: "test-key",
    fetchImpl: makeFetch(
      [
        {
          route: {
            type: "choice",
            choice: "browser_scroll",
            confidence: 0.91,
          },
          scroll_direction: {
            type: "choice",
            choice: "bottom",
            confidence: 0.98,
          },
          replace_text: { type: "noul", noul: 1 },
        },
      ],
      requests
    ),
  });

  const result = await engine.execute({
    instruction: "scroll to the bottom",
    async dispatchTool(name, params) {
      dispatched.push({ name, params });
      return { status: "ok", action: "scroll", direction: "bottom" };
    },
  });

  Assert.equal(requests.length, 1, "One TypeSafe routing request was made");
  Assert.equal(
    requests[0].url,
    "https://api.typesafe.ai/v1/systemone",
    "The official TypeSafe endpoint is used"
  );
  Assert.equal(
    requests[0].authorization,
    "Bearer test-key",
    "The configured API key is sent as a bearer token"
  );
  Assert.equal(
    requests[0].body.questions.route.type,
    "choice",
    "The browser route is a Jev Choice question"
  );
  Assert.deepEqual(
    dispatched,
    [{ name: "browser_scroll", params: { direction: "bottom" } }],
    "Jev routes the planned step through the Firefox dispatcher"
  );
  Assert.equal(result.action, "browser_scroll", "The selected action is returned");
  Assert.equal(result.confidence, 0.91, "Route confidence is returned");
});

add_task(async function test_click_reads_state_then_selects_element() {
  const requests = [];
  const dispatched = [];
  const engine = new JevBrowserEngine({
    apiKey: "test-key",
    fetchImpl: makeFetch(
      [
        {
          route: {
            type: "choice",
            choice: "browser_click",
            confidence: 0.87,
          },
          scroll_direction: {
            type: "choice",
            choice: "down",
            confidence: 0.5,
          },
          replace_text: { type: "noul", noul: 1 },
        },
        {
          target_element: {
            type: "choice",
            choice: "e2",
            confidence: 0.94,
          },
        },
      ],
      requests
    ),
  });
  const state = {
    status: "ok",
    tab_id: "tab-1",
    snapshot_id: "10:1",
    title: "Checkout",
    url: "https://example.com/checkout",
    elements: [
      {
        ref: "e1",
        role: "button",
        name: "Cancel",
        actions: ["click"],
        inViewport: true,
      },
      {
        ref: "e2",
        role: "button",
        name: "Continue",
        actions: ["click"],
        inViewport: true,
      },
    ],
  };

  const result = await engine.execute({
    instruction: "click the Continue button",
    async dispatchTool(name, params) {
      dispatched.push({ name, params });
      if (name === "browser_state") {
        return state;
      }
      return { status: "ok", action: "click" };
    },
  });

  Assert.equal(requests.length, 2, "Jev routes and then selects an element");
  Assert.deepEqual(
    dispatched,
    [
      { name: "browser_state", params: {} },
      {
        name: "browser_click",
        params: { tab_id: "tab-1", snapshot_id: "10:1", ref: "e2" },
      },
    ],
    "Click target identifiers come from the fresh Firefox snapshot"
  );
  Assert.deepEqual(
    result.result,
    { status: "ok", action: "click" },
    "Firefox's execution result is returned to the planner"
  );
});

add_task(async function test_type_uses_planned_text_without_generation() {
  const engine = new JevBrowserEngine({
    apiKey: "test-key",
    fetchImpl: makeFetch(
      [
        {
          route: {
            type: "choice",
            choice: "browser_type",
            confidence: 0.93,
          },
          scroll_direction: {
            type: "choice",
            choice: "down",
            confidence: 0.5,
          },
          replace_text: { type: "noul", noul: 0.82 },
        },
        {
          target_element: {
            type: "choice",
            choice: "e1",
            confidence: 0.9,
          },
        },
      ],
      []
    ),
  });
  const dispatched = [];

  await engine.execute({
    instruction: 'type "Firefox" into the Search field',
    async dispatchTool(name, params) {
      dispatched.push({ name, params });
      if (name === "browser_state") {
        return {
          status: "ok",
          tab_id: "tab-2",
          snapshot_id: "20:1",
          elements: [
            {
              ref: "e1",
              role: "textbox",
              name: "Search",
              actions: ["click", "type"],
              inViewport: true,
            },
          ],
        };
      }
      return { status: "ok", action: "type", characters: 7 };
    },
  });

  Assert.deepEqual(
    dispatched.at(-1),
    {
      name: "browser_type",
      params: {
        tab_id: "tab-2",
        snapshot_id: "20:1",
        ref: "e1",
        text: "Firefox",
        replace: true,
      },
    },
    "Typed text comes from Gemini's self-contained planned instruction"
  );
});
