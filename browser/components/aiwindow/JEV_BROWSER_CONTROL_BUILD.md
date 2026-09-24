# Gemini-planned Jev browser control

This report describes the Jev browser-control integration in the current
working tree. The configured Smart Window chat model plans the workflow one
semantic step at a time, TypeSafe Jev grounds each step in Firefox's bounded
browser-control API, and Firefox validates and executes the resulting action.

For the underlying browser-control API, see
[`BROWSER_CONTROL_API.md`](BROWSER_CONTROL_API.md).

| Picker action | Planner | Grounder | Executor |
| --- | --- | --- | --- |
| Ask | Configured chat model | Configured chat model | Firefox |
| Go | Smartbar | Not applicable | Firefox navigation |
| Search | Smartbar | Not applicable | Firefox search |
| Jev | Configured chat model | TypeSafe Jev | Firefox browser control |

Jev does not click, type, navigate, or execute JavaScript itself. It selects a
bounded Firefox function and, for click and type, an eligible element from a
fresh page snapshot. Firefox remains the only action executor.

## Configuration

The Firefox process must inherit a TypeSafe API key:

```sh
export TYPESAFE_KEY="your-key"
./mach run
```

The configured Smart Window chat model must also be available because Jev no
longer replaces that model. The following preferences must be enabled:

```text
browser.smartwindow.enabled = true
browser.smartwindow.browserControl.enabled = true
```

Browser control remains off by default. Jev uses this TypeSafe contract:

| Setting | Value |
| --- | --- |
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| Authorization | `Authorization: Bearer <TYPESAFE_KEY>` |
| Content type | `application/json` |
| Model | `jev-latest` |
| Request shape | `{"model":"jev-latest","state":...,"questions":...}` |
| Response shape | `{"model":"...","answers":{...},"usage":{...}}` |

This follows TypeSafe's [API reference](https://docs.typesafe.ai/api) and
[function-calling pattern](https://docs.typesafe.ai/cookbooks/function_calling).

## End-to-end flow

1. The user selects **Jev** and submits a goal.
2. Firefox builds the configured chat engine normally and adds the user turn to
   the normal conversation.
3. Firefox removes all seven direct browser-control tools from the planner's
   tool list and inserts one `jev_browser_action` tool.
4. The planner calls `jev_browser_action` with one precise, self-contained next
   step, such as `click the No, thanks button`.
5. `JevBrowserEngine` asks TypeSafe to route that instruction to one of the
   seven bounded Firefox browser functions.
6. For click or type, Firefox reads a fresh page snapshot and Jev selects one
   eligible opaque element reference.
7. Firefox validates and executes the selected browser function.
8. The structured result, selected action, and Jev confidence return to the
   planner.
9. The planner reassesses the result and either delegates one more step or
   gives the user a final response.

This is deliberately an observe–act loop instead of execution of a static
multi-step plan. Every page mutation may invalidate element references, so
click and type always use state captured immediately before the action.

## Planner contract

During a Jev submission, the configured chat model receives this tool instead
of `browser_open_tab`, `browser_state`, `browser_find_text`,
`browser_navigate`, `browser_scroll`, `browser_click`, and `browser_type`:

```json
{
  "name": "jev_browser_action",
  "arguments": {
    "instruction": "click the No, thanks button"
  }
}
```

The instruction represents exactly one next action. It must include the target,
exact URL, or exact text when applicable. After the action result, the planner
may issue another `jev_browser_action` call. Because the raw browser tools are
not present in this mode, the planner cannot bypass Jev and choose an element
reference directly.

Non-browser tools remain available to the planner. For example, it may search
the web to discover an exact destination before delegating an open or navigate
step to Jev.

## Jev routing and grounding

Jev first receives the planner's instruction and closed-set questions:

| Question | Type | Purpose |
| --- | --- | --- |
| `route` | `choice` | Select one of the seven Firefox browser functions. |
| `scroll_direction` | `choice` | Select `up`, `down`, `left`, `right`, `top`, or `bottom`. |
| `replace_text` | `noul` | Map replace-versus-append language to a boolean. |
| `url_target` | `choice` | Select among multiple explicit HTTP/HTTPS URLs without inventing one. |
| `text_target` | `choice` | Select among multiple quoted strings without generating typed text. |

Click and type add a second Jev request:

1. Firefox calls `browser_state` on the selected web tab.
2. Firefox filters the returned elements to those eligible for the planned
   action.
3. Jev receives the instruction, page title and URL, and each candidate's
   opaque reference, role, accessible name, actions, and viewport status.
4. A `target_element` choice selects one candidate.
5. Firefox calls `browser_click` or `browser_type` with that reference and the
   fresh `snapshot_id`.

The full page text is not sent in the element-selection request. URLs and text
entered into controls must originate in the planner's instruction; Jev only
selects among extracted candidates.

## Result contract

`jev_browser_action` returns a structured result to the planner:

```json
{
  "status": "ok",
  "action": "browser_click",
  "confidence": 0.94,
  "result": {
    "status": "ok",
    "action": "click",
    "input_route": "dom_event",
    "trusted": false
  }
}
```

The chat model, rather than Jev, interprets this result, chooses the next step,
and writes the user-facing response. This keeps conversational planning and
recovery with the general model while constraining action grounding.

## Browser functions

| Function | Jev's role | Firefox's role |
| --- | --- | --- |
| `browser_open_tab` | Select the route and an explicit URL from the instruction. | Validate the URL, open the tab, and return a conversation-scoped `tab_id`. |
| `browser_state` | Select the state-read route. | Return bounded page text and interactive elements. |
| `browser_find_text` | Select the route and requested text. | Find, scroll to, and highlight the text. |
| `browser_navigate` | Select the route and an explicit URL from the instruction. | Validate the URL and navigate the controlled tab. |
| `browser_scroll` | Select the route, direction, and optional distance. | Scroll the page and report its resulting position. |
| `browser_click` | Select a clickable element from a fresh snapshot. | Validate the snapshot and dispatch an untrusted DOM event. |
| `browser_type` | Select an editable element and replace/append behavior. | Validate the snapshot and enter planner-supplied text. |

## Safety boundaries

- The planner cannot access direct browser-control tools during a Jev
  submission.
- Jev can only select functions implemented by Firefox.
- Only HTTP and HTTPS URLs are accepted for open and navigate.
- Page text and accessible names are treated as untrusted input.
- Tab identifiers are scoped to the conversation.
- Element references are opaque and scoped to a short-lived snapshot.
- Click and type invalidate the snapshot after one action.
- Password and file inputs are not exposed as typeable elements.
- Typed text is not repeated in the browser tool's result.
- Firefox emits untrusted DOM events rather than privileged native input.
- Neither the planner nor Jev can provide a CSS selector or JavaScript payload.

## Errors and limitations

| Condition | Result |
| --- | --- |
| `TYPESAFE_KEY` is absent | Throws `jevMissingApiKey` before making a TypeSafe request. |
| The configured chat model is unavailable | The planner request fails before Jev runs. |
| TypeSafe returns a non-success HTTP status | Throws `jevApiFailure` and records the HTTP status. |
| TypeSafe does not return an `answers` object | Throws `jevInvalidResponse`. |
| Jev returns an unknown function | Throws `jevInvalidRoute`. |
| Jev returns an ineligible element reference | Returns an error to the planner without executing an action. |
| Browser control is disabled | The Jev delegation tool is not offered to the planner. |
| The selected page is not HTTP/HTTPS | Firefox returns `unsupported_page`. |
| An open or navigate instruction lacks an absolute URL | Firefox returns `invalid_url`. |
| A click or type snapshot becomes stale | Firefox returns `stale_snapshot`; the planner can delegate another step. |

The current integration relies on the planner choosing the delegation tool
under automatic tool choice. It does not yet apply confidence thresholds,
confirmation policy, a maximum delegated-step count, or dedicated telemetry
for the inner Jev-selected browser function.

## Implementation map

| Layer | Source | Responsibility |
| --- | --- | --- |
| Planner tool schema | [`models/Tools.sys.mjs`](models/Tools.sys.mjs) | Defines `jev_browser_action` and the seven direct browser tools it replaces. |
| Jev grounder | [`models/JevBrowserEngine.sys.mjs`](models/JevBrowserEngine.sys.mjs) | Calls TypeSafe, routes one semantic instruction, selects eligible elements, and dispatches through Firefox. |
| Chat orchestration | [`models/Chat.sys.mjs`](models/Chat.sys.mjs) | Gives Gemini the Jev delegation tool, hides direct browser tools, runs Jev, and returns the structured result to the planner. |
| Smartbar integration | [`ui/components/ai-window/ai-window.mjs`](ui/components/ai-window/ai-window.mjs) | Keeps the configured chat engine and enables Jev delegation for a Jev submission. |
| Picker UI | [`ui/components/input-cta/input-cta.mjs`](ui/components/input-cta/input-cta.mjs) | Displays Jev after Ask, Go, and Search. |
| Browser controller | [`models/BrowserControl.sys.mjs`](models/BrowserControl.sys.mjs) | Validates scope and URLs, manages tab IDs, and forwards bounded actions. |
| Content actor | [`ui/actors/SmartWindowBrowserChild.sys.mjs`](ui/actors/SmartWindowBrowserChild.sys.mjs) | Reads bounded page state and performs find, scroll, click, and type. |
| Jev tests | [`models/tests/xpcshell/test_JevBrowserEngine.js`](models/tests/xpcshell/test_JevBrowserEngine.js) | Cover routing, Firefox dispatch, fresh-state click grounding, and typed text. |
| Chat tests | [`models/tests/xpcshell/test_Chat.js`](models/tests/xpcshell/test_Chat.js) | Verify that Jev mode exposes the delegation tool and removes direct browser tools. |

## Validation status

| Check | Result |
| --- | --- |
| `./mach format` | Passed with no remaining issues. |
| `./mach build faster` | Passed with no compiler warnings. |
| Chat, Jev, and tool-definition xpcshell suites | Passed: 3 test files, 0 failures. |
| Headless Smartbar picker browser test | Passed: 33 checks, 0 unexpected results. |
