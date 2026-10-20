# Smart Window Auto Grouping, extension prototype

A WebExtension version of the Smart Window auto grouping logic spec, so the
behavior can be tried in an everyday Firefox (Nightly 139+ for the tab groups
API) without a custom build.

Source of truth for behavior: `_prototype/2026-10-14-smart-auto-grouping/`
(`spec.md`, the design handoff, and the logic spec). This extension covers the
same **lite** scope as the worktree build on branch `smart-auto-grouping`.

## What it does

- **JOIN.** Every tab opened after install is classified once, 2 s after its
  first web page finishes loading. If it fits an existing group it moves to the
  end of that group and the group expands if it was collapsed. For 5 s the
  moved tab carries the multi-select highlight and the group name reads
  "✦ Travel", then both revert. The toolbar button shows a badge until you open
  the menu, where a "Last moved" row names the tab and group with a **Show me**
  button that jumps to it. One tab is enough to join. Works for user-made
  groups too.
- **CREATE.** Otherwise, if the new tab and at least two other loose tabs in the
  window clearly belong together, they form a new group in place at the new tab
  (the new tab ends up last), named and colored from a topic table.
- **Passive.** No toasts, no per-move undo. Correct it the normal way: drag the
  tab out, ungroup, close. A tab dragged out of an auto group is never put back
  in that group.
- **Menu** (toolbar button "Organize tabs"): "Group tabs automatically" toggle
  (off keeps every group, just stops grouping new tabs; on resumes without
  regrouping existing loose tabs) and "Undo last group" (ungroups the most
  recent auto-made group in place; disabled when there is nothing to undo).
- **Classifier.** Heuristic by default (same host, shared topic keywords, title
  overlap; same domain on a different host is only a weak hint). Click **Enable** in the menu to add on-device sentence embeddings
  through Firefox's `trial.ml` API. The model is the one Nightly's own smart
  tab grouping uses for clustering: `Xenova/all-MiniLM-L6-v2` v0.1.0 q8 from
  the Mozilla model hub (Remote Settings feature `simple-text-embedder`, the
  shared "contextual" embeddings generator), embedded with mean pooling,
  normalization and `max_length` 100, on the site-stripped title. With the
  model on, similarity is the higher of the embedding cosine and the heuristic
  score, so cross-site pages (Lisbon on Wikivoyage, a Lisbon hotel on Booking,
  Lisbon flights on Kayak score 0.5 to 0.7) cluster while terse single-word
  titles still rely on keywords. Threshold 0.45. Clusters expand one hop
  (A~B, B~C puts C in the group). Falls back to the heuristic if the model is
  unavailable. Differences from the tree: no page description in the embedded
  text, nearest-neighbour clustering around the new tab instead of
  agglomerative clustering over all tabs, and **group names come from a topic
  table, not the Gemini/topic-model label path**.
- Strict one-at-a-time queue, re-validation at fire time (tab still open, still
  loose, group still exists), cancel if the tab closes before the 2 s delay.
  Pinned tabs and non-http(s) pages are ignored.

## Not in this prototype

First-run triage, bulk confirm for session restore, correction callouts and
pause-after-corrections, preview groups and the message bar, label pulse and
smooth scroll (an extension cannot animate the tab strip), split-view and
media-tab exclusions, correction-count decay.

## Install in your Firefox

Temporary (goes away on restart):

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** and pick `manifest.json` in this folder.

Permanent (your Nightly profile has `xpinstall.signatures.required = false`):

1. Build the package:
   ```bash
   cd /Users/joliehuang/FirefoxPrototype/extensions/smart-auto-grouping && web-ext build --overwrite-dest
   ```
2. Drag `web-ext-artifacts/smart-auto-grouping-0.1.4.xpi` onto a Firefox window
   and accept the prompt (a prebuilt one is already there).

The toolbar button is added to the overflow area by default. Pin it from the
extensions (puzzle) menu so it sits next to the tab strip.

## Try the demo

1. Make a 3-tab group by hand and name it "Travel". Open a fourth travel page.
   About 2 s after it loads it moves to the end of Travel.
2. Open three recipe pages one at a time. The third one forms a group.
   Two alone do nothing.
3. Open the toolbar menu: toggle off, open another travel page (stays loose),
   toggle on, open one more (joins). "Undo last group" dissolves the recipe
   group in place; reopen the menu and it reads "Nothing to undo".
4. Click **Enable** next to "On-device model" to try embedding-based grouping
   across different sites.

**Advanced** in the menu exposes the delay, minimum cluster size and the
similarity threshold (0.45 default; raise it if groups feel too eager).

## Test (15 checks, all passing on Nightly 160, 2026-10-20)

```bash
cd /Users/joliehuang/FirefoxPrototype/worktrees/smart-auto-grouping
./mach python /Users/joliehuang/FirefoxPrototype/extensions/smart-auto-grouping/test/e2e.py [--skip-model] [--keep]
```

Launches Firefox Nightly with a throwaway profile, installs the extension
temporarily and drives CREATE, JOIN, cancel-on-close, the menu, and the model
path through Marionette. Needs network (Wikivoyage, Wikibooks, Wikipedia
pages). Nothing touches your real profile. The test profile overrides
`services.settings.server` because Marionette's automation prefs point Remote
Settings at a dummy URL, which would starve the ML runtime; a normal profile
does not need this. `test/sim_probe.py` prints raw similarity matrices for
tuning the threshold.

## Files

- `manifest.json` MV2, permissions `tabs`, `tabGroups`, `storage`; optional `trialML`
- `background.js` the actor: trigger, queue, JOIN/CREATE, undo, settings, storage
- `classifier.js` heuristic + on-device embedding backends, topic/label table
- `popup/` the menu
- `test/e2e.py` Marionette end-to-end test
