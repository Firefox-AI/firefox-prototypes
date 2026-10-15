# Smart Window Auto Grouping (lite) prototype
**Branch:** `smart-auto-grouping` **Base:** `ai/main` @ 71c2ec0314b6 **Built:** 2026-10-14

## What it does
Every new tab opened in a Smart Window is classified by the in-tree on-device
model (`SmartTabGroupingManager` via `AutoTabGroupingSuggestions`) 2 s after its
first real page load. If it fits an existing group it JOINs the end of that group
(label pulses, strip scrolls to it); otherwise, if it and ≥2 other loose tabs form
one cluster, a new named group is CREATEd in place at the trigger tab. The
"Organize Tabs" panel gains a "Group tabs automatically" toggle and an "Undo last
group" row.

## Try it
1. `./run.command` (first launch clones the golden profile). Open a Smart Window.
2. Wait ~2 min with network on the first launch so the topic + embedding models download.
3. Demo scenarios:
- **JOIN**: make a "Travel" group of 3 travel tabs, open a 4th travel page →
  ~2 s after load it moves to the end of the group, the label pulses
  (`data-sw-pulse="true"` on `.tab-group-label`), strip scrolls if overflowing.
  Close the tab before 2 s → nothing happens.
- **CREATE**: with no matching group open 3 related loose pages (e.g. 3 recipes)
  → after the third loads (+2 s + inference) one expanded group forms at the
  selected tab, anchor last, model-generated label, pulse. With 2 tabs: nothing.
- **MENU**: click the Organize Tabs button right of the New tab (+) button:
  `#sw-autogroup-toggle` ("Group tabs automatically" + description) and
  `#sw-autogroup-undo` ("Undo last group", secondary = group's current name,
  or "Nothing to undo" + disabled). Undo dissolves the group in place and closes
  the panel.

## Prefs (`browser/app/profile/firefox.js`)
- `browser.smartwindow.autoTabGrouping.auto.enabled` (true) — the toggle writes this
- `browser.smartwindow.autoTabGrouping.auto.joinDelayMs` (2000)
- `browser.smartwindow.autoTabGrouping.auto.minClusterSize` (3)
- `browser.smartwindow.autoTabGrouping.auto.joinTiming`, `.collapseOnSettle` — declared, inert
- `browser.smartwindow.autoTabGrouping.auto.buttonPlaced` — set once after the button is moved next to (+)
- ML gating: `browser.ml.enable` (golden user.js), `browser.tabs.groups.smart.{enabled,userEnabled,optin}` all true (optin flipped to true here)

## Setup
No keys or servers. Models come from model-hub via Remote Settings on first use
and are cached in `profile-default/`. Group labels use the cloud LLM when the
golden FxA session is valid, else the on-device topic model.

## What it does not do
No first-run triage, preview groups, CONFIRM for multiple clusters, corrections /
exclusions (field declared, never written), peek chip, custom scroll curve (uses
`arrowScrollbox.ensureElementIsVisible`), vertical tabs, multi-window, telemetry.
`on-leave` timing and `collapseOnSettle` are inert. Scroll only moves when the
strip overflows.

## Where the code is
- `browser/components/aiwindow/ui/modules/AutoTabGrouping.sys.mjs` — queue, JOIN/CREATE, pulse, scroll, undo, toggle, button placement, card wiring
- `browser/components/aiwindow/ui/modules/AIWindow.sys.mjs` — arms/disarms per Smart Window from `_updateGroupTabsButtonVisibility`
- `browser/components/aiwindow/ui/components/smartwindow-group-tabs/smartwindow-group-tabs.mjs` — toggle + undo rows at the top of the card
- `browser/themes/shared/smartwindowGroupTabs.css` — row styles
- `browser/locales/en-US/browser/autoTabGrouping.ftl` — 3 strings
- `browser/app/profile/firefox.js` — prefs above
