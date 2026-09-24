# Smart Window browser-control API

This report describes the browser-control API introduced by commit
`15f51b2ebcaef83aa1c883f0415cb1ddcc707800` (`browser control api added`).
The API gives a model bounded access to live HTTP and HTTPS pages in an active
Smart Window. It exposes seven function tools and deliberately does not expose
arbitrary CSS selectors or JavaScript execution.

The model calls these functions through the normal chat tool-call loop. The
JSON examples below use `function_name(arguments)` shorthand for the function
name and its JSON arguments.

On the wire, the chat engine represents the same call as a tool-call object
whose `arguments` value is a JSON string:

```json
{
  "id": "scroll-1",
  "function": {
    "name": "browser_scroll",
    "arguments": "{\"tab_id\":\"tab-1\",\"direction\":\"bottom\"}"
  }
}
```

## Function summary

| Function | How it is called | Successful return | Why it is useful |
| --- | --- | --- | --- |
| `browser_open_tab` | `browser_open_tab({"url":"https://example.com/"})`<br><br>`url` is required and must be an absolute HTTP or HTTPS URL. | `{"status":"ok","tab_id":"tab-1","url":"https://example.com/","message":"Tab opened and selected. Read browser_state before interacting."}` | Opens and selects a new page without navigating away from an existing controlled tab. The returned conversation-scoped `tab_id` lets later calls target the new tab. |
| `browser_state` | `browser_state({})` reads the selected web tab.<br><br>`browser_state({"tab_id":"tab-1"})` reads a known tab. | `status`, `tab_id`, `snapshot_id`, `url`, `title`, `ready_state`, bounded page `text`, `elements`, and `truncated`. See [Page-state shape](#page-state-shape). | Gives the model a compact, sanitized view of the page and opaque references for safe interaction. It is the required discovery step before clicking or typing. |
| `browser_find_text` | `browser_find_text({"tab_id":"tab-1","text":"pricing","case_sensitive":false,"whole_word":false})`<br><br>`tab_id` is optional; `text` is required and limited to 1–500 characters. Both flags default to `false`. | `{"status":"ok","action":"find_text","found":true,"highlighted":true,"scroll_x":0,"scroll_y":742,"max_scroll_x":0,"max_scroll_y":1200,"viewport_width":1280,"viewport_height":720,"tab_id":"tab-1"}` | Uses the browser's native find behavior to locate, scroll to, and visibly highlight text. This is more direct than repeatedly reading and scrolling through long pages. |
| `browser_navigate` | `browser_navigate({"tab_id":"tab-1","url":"https://example.com/docs"})`<br><br>`url` is required and must be an absolute HTTP or HTTPS URL. `tab_id` is optional. | `{"status":"ok","tab_id":"tab-1","url":"https://example.com/docs","message":"Navigation completed. Read browser_state before interacting."}` | Reuses a controlled tab for a new destination while retaining its conversation-scoped tab identifier. |
| `browser_scroll` | `browser_scroll({"tab_id":"tab-1","direction":"down","amount":600})`<br><br>`tab_id` and `amount` are optional. `direction` is one of `up`, `down`, `left`, `right`, `top`, or `bottom`. `amount` may be 1–5000 CSS pixels. Directional scrolling defaults to 80% of the viewport. | `{"status":"ok","action":"scroll","direction":"down","did_scroll":true,"scroll_x":0,"scroll_y":600,"max_scroll_x":0,"max_scroll_y":1200,"viewport_width":1280,"viewport_height":720,"tab_id":"tab-1"}` | Moves through pages and reports the resulting viewport position, including whether the page actually moved and how much scrollable area remains. |
| `browser_click` | `browser_click({"tab_id":"tab-1","snapshot_id":"123:1","ref":"e4"})`<br><br>All three arguments are required and must come from the newest `browser_state` result. | `{"status":"ok","action":"click","input_route":"dom_event","trusted":false}` | Activates a specific element without giving the model selector or script access. The opaque reference limits the action to an element Firefox exposed in the latest snapshot. |
| `browser_type` | `browser_type({"tab_id":"tab-1","snapshot_id":"123:2","ref":"e2","text":"Firefox","replace":true})`<br><br>`tab_id`, `snapshot_id`, `ref`, and `text` are required. `replace` defaults to `true`; set it to `false` to append. | `{"status":"ok","action":"type","characters":7,"input_route":"dom_event","trusted":false}` | Enters text into an exposed editable control. The response reports only the character count, so typed content is not echoed into the tool result. Password and file inputs are never typeable. |

## Page-state shape

`browser_state` returns a bounded snapshot with this structure:

```json
{
  "status": "ok",
  "tab_id": "tab-1",
  "snapshot_id": "123:1",
  "url": "https://example.com/",
  "title": "Example",
  "ready_state": "complete",
  "text": "Visible page text...",
  "elements": [
    {
      "ref": "e1",
      "role": "link",
      "name": "Documentation",
      "actions": ["click"],
      "disabled": false,
      "readonly": false,
      "inViewport": true,
      "href": "https://example.com/docs"
    },
    {
      "ref": "e2",
      "role": "textbox",
      "name": "Search",
      "actions": ["click", "type"],
      "disabled": false,
      "readonly": false,
      "inViewport": true,
      "type": "search",
      "value": ""
    }
  ],
  "truncated": false
}
```

| Field | Meaning |
| --- | --- |
| `tab_id` | Opaque tab identifier scoped to the current conversation. A tab ID from another conversation is not valid. |
| `snapshot_id` | Opaque identifier for the newest DOM snapshot in that document. It must be supplied with `ref` to click or type. |
| `text` | Whitespace-normalized page text, limited to 12,000 characters and marked as untrusted model input. |
| `elements` | Up to 100 visible interactive elements. Names and non-secret values are limited to 300 characters and sanitized as untrusted content. |
| `truncated` | `true` when the interactive-element list reached its 100-element limit. |
| `ref` | Snapshot-scoped element identifier such as `e1`. It is not a DOM ID or selector. |
| `role` | Explicit ARIA role when present; otherwise a role inferred from the HTML element. |
| `name` | Accessible-style name derived from ARIA labeling, associated labels, or element attributes and text. |
| `actions` | `click`, or `click` and `type` when the element accepts non-secret text input. |
| `inViewport` | Whether the element intersects the current viewport. Off-screen visible elements can still appear in the snapshot. |
| `type`, `value`, `href` | Optional element details. Password values are omitted, and only HTTP or HTTPS link destinations are returned. |

## Required interaction sequence

Element references are intentionally short-lived. A reliable interaction uses
this sequence:

1. Call `browser_state` and retain its `tab_id` and `snapshot_id`.
2. Select an element from `elements` by its role, name, and supported actions.
3. Call `browser_click` or `browser_type` with that exact `snapshot_id` and
   element `ref`.
4. Call `browser_state` again before another click or type.

`browser_click`, `browser_type`, `browser_find_text`, and `browser_scroll`
invalidate the previous snapshot. Page navigation also requires a fresh state
read. Reusing an invalidated snapshot returns `stale_snapshot`.

## Errors

Every failure uses the same top-level shape:

```json
{
  "status": "error",
  "code": "stale_snapshot",
  "message": "The page state changed or this snapshot was already used. Read browser_state again."
}
```

| Functions | Error codes | Meaning |
| --- | --- | --- |
| All functions | `feature_disabled`, `window_unavailable`, `not_smart_window` | Browser control is disabled, no usable browser window exists, or the window is not an active Smart Window. |
| Functions targeting an existing tab | `unknown_tab`, `tab_unavailable`, `unsupported_page` | The conversation does not know the tab, the tab has closed, or the current page is not HTTP/HTTPS. |
| `browser_open_tab`, `browser_navigate` | `invalid_url`, `navigation_failed` | The URL is not absolute HTTP/HTTPS, or navigation failed or exceeded the 15-second timeout. |
| `browser_state`, `browser_find_text`, `browser_scroll`, `browser_click`, `browser_type` | `actor_unavailable` | The page-side browser-control actor is unavailable. |
| `browser_find_text` | `invalid_text` | Search text is empty, is not a string, or exceeds 500 characters. |
| `browser_scroll` | `invalid_direction`, `invalid_amount` | The direction is unsupported, or the distance is outside 1–5000 CSS pixels. |
| `browser_click`, `browser_type` | `stale_snapshot`, `unknown_ref`, `element_not_visible` | The snapshot has expired, the reference is gone, or the element is no longer visible. |
| `browser_click` | `element_disabled` | The target is disabled. |
| `browser_type` | `element_not_editable`, `invalid_text` | The target cannot accept text, or `text` is not a string. |

## Availability and safety boundaries

The API is off by default. Both `browser.smartwindow.enabled` and
`browser.smartwindow.browserControl.enabled` must be enabled, and calls are
restricted to an active Smart Window. The page actor is registered only for
HTTP and HTTPS documents.

The implementation uses conversation-scoped tab IDs and snapshot-scoped
element references. It reads only bounded page data, sanitizes page-provided
text before returning it to the model, marks page data as untrusted, excludes
password values and password/file inputs from typing, and emits untrusted DOM
events rather than privileged native input.

## Implementation map

| Layer | Source | Responsibility |
| --- | --- | --- |
| Tool schemas and model-visible names | [`models/Tools.sys.mjs`](models/Tools.sys.mjs) | Declares the seven function schemas, feature gate, and mappings to implementation methods. |
| Tool dispatch | [`models/Chat.sys.mjs`](models/Chat.sys.mjs) | Routes model tool calls and removes browser-control tools when the feature preference is off. |
| Chrome-side controller | [`models/BrowserControl.sys.mjs`](models/BrowserControl.sys.mjs) | Validates scope and URLs, manages conversation tab IDs, drives navigation, sanitizes results, and queries the page actor. |
| Content-side actor | [`ui/actors/SmartWindowBrowserChild.sys.mjs`](ui/actors/SmartWindowBrowserChild.sys.mjs) | Produces page snapshots and performs bounded find, scroll, click, and type operations in the content process. |
| Actor registration | [`../DesktopActorRegistry.sys.mjs`](../DesktopActorRegistry.sys.mjs) | Registers the actor for HTTP/HTTPS pages only while both feature preferences are enabled. |
| End-to-end coverage | [`models/tests/browser/browser_browser_control.js`](models/tests/browser/browser_browser_control.js) | Verifies direct API calls and the complete model tool-call loop against a live page. |
