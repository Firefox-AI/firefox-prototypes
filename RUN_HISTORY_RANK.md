# Run History Rank

This branch is an experiment for ranking Firefox New Tab recommendations with a user-history vector. It is intended to be run from this checkout and will not be merged to `main` as-is.

The flow is:

1. Build this Firefox checkout.
2. Copy a Firefox profile with `select_profile_copy.sh`.
3. Launch the copied profile once so its `about:config` page is available.
4. Enable the required preferences in the copied profile.
5. Restart the build with the copied profile.
6. Use the New Tab devtools panel to force a vector recompute or choose a reranking mode.
7. Inspect the automatically opened HTML report and the console output.

## Build Firefox

From the repository root:

```bash
./mach bootstrap
MOZ_SKIP_PATH_PERFORMANCE_CHECK=1 ./mach build
```

`./mach bootstrap` is only needed when this checkout has not been configured yet. On later front-end-only iterations, use:

```bash
MOZ_SKIP_PATH_PERFORMANCE_CHECK=1 ./mach build faster
```

The path performance check warning is harmless. Setting `MOZ_SKIP_PATH_PERFORMANCE_CHECK=1` avoids its delay on this checkout location.

## Copy a Firefox profile

Run the interactive profile selector from the repository root:

```bash
./select_profile_copy.sh
```

The script searches in this order:

1. macOS Firefox and Firefox Nightly locations.
2. Windows Firefox locations, including Git Bash and WSL path formats.
3. Ubuntu locations, including regular, Snap, and Flatpak profiles.

It stops at the first platform where it finds profiles containing `places.sqlite`. For each profile it reports:

- the number of `moz_places` rows;
- the size of `places.sqlite`;
- the most recent history visit.

Select the profile used by the daily driver. Close the original Firefox before copying it. The script excludes profile lock files and caches from the copy.

The default destination is:

```text
~/tmp/nightly-profile-copies/
```

The script prints the exact copied profile path when it finishes.

## First launch and required preferences

Launch the copied profile once before changing preferences. This lets you open
`about:config` in the copied profile rather than editing the profile files by
hand.

Use the launch command below, replacing the profile path with the path printed
by the selector script:

```bash
MOZ_SKIP_PATH_PERFORMANCE_CHECK=1 ./mach run --noprofile -- \
  --allow-downgrade \
  -profile '/absolute/path/to/nightly-profile-YYYYMMDD-HHMMSS'
```

Open `about:config` in the copied profile and verify these values:

| Preference | Value | Purpose |
| --- | --- | --- |
| `browser.newtabpage.activity-stream.discoverystream.sections.personalization.user-history-cosine.enabled` | `true` | Enables cosine scoring and within-section sorting. This branch defaults it to `true`. |
| `places.semanticHistory.featureGate` | `true` | Allows the semantic history database and user vector. Nightly normally defaults this to `true`; a profile override can still disable it. |
| `browser.ml.enable` | `true` | Allows the local embedding model to run. |
| `places.history.enabled` | `true` | Provides the browsing history and frecency data used to build the vector. |
| `browser.newtabpage.activity-stream.asrouter.devtoolsEnabled` | `true` | Shows the New Tab devtools panel and its reranking controls. |

If `places.semanticHistory.removeOnStartup` exists, it must not be `true`. Clear it or set it to `false`; otherwise the semantic database can be removed during startup.

The semantic-history manager also requires a supported region and locale, enough physical memory and CPU capacity, and a working local ML model. The current supported combinations include English in the US, Canada, Australia, the UK, Ireland, New Zealand, and the Philippines, plus English or French in France.

The profile must contain enough history for the semantic database to produce a valid, nonzero vector. The first run may need time to index history and initialize the model.

## Restart Firefox

After changing the preferences, restart Firefox with the copied profile:

```bash
MOZ_SKIP_PATH_PERFORMANCE_CHECK=1 ./mach run --noprofile -- \
  --allow-downgrade \
  -profile '/absolute/path/to/nightly-profile-YYYYMMDD-HHMMSS'
```

`--allow-downgrade` is for the copied profile. Do not use it with the real daily-driver profile.

Keep the terminal open. Firefox console warnings and the ranking lines are printed there while the build runs.

## Use the New Tab devtools controls

1. Open a new tab.
2. Click the wrench icon in the top-right corner to open New Tab devtools.
3. Find the admin controls near the bottom of the panel.

![New Tab devtools location](rerank_pics/show_devtools_location.jpeg)

### Recompute the user vector

Click **Recompute User History Vector**, then wait for the New Tab feed to reload.

![Recompute user history vector button](rerank_pics/recompute_button.jpeg)

The button forces a recompute immediately. Normal recommendation loads reuse the stored vector for the local calendar day. **Refresh Cache** reloads the recommendation data but does not force a vector recompute.

### Choose an article reranking mode

The **Article Reranking** section contains two buttons:

![Article reranking buttons](rerank_pics/rerank_option_buttons.jpeg)

- **Cosine: Rerank Within Sections** is the default. It fetches a fresh recommendation response and sorts articles by cosine similarity within each existing section. Section order stays unchanged.
- **Cosine: Promote Top 6 to Popular Today** fetches a fresh response, moves the six highest-scoring articles across the response into the first six Popular Today slots, and sorts the remaining articles within their existing sections. Section order stays unchanged.

The selected reranking mode remains active for later refreshes during the current Firefox run. Click **Cosine: Rerank Within Sections** to return to the default mode. Recomputing the user vector also returns to the default mode.

Each button triggers a fresh recommendation fetch and reranking pass.

## Open the HTML report

When a new Merino response produces at least one valid cosine score, Firefox writes and opens:

```text
newtab-history-rank.html
```

The file is stored in the running profile's local profile directory. Firefox prints the full path:

```text
[NewTab cosine] report=/path/to/profile/newtab-history-rank.html
```

For the copied-profile launch command in this guide, this is normally:

```text
/absolute/path/to/nightly-profile-YYYYMMDD-HHMMSS/newtab-history-rank.html
```

The report opens automatically in a new tab in the current Firefox window. If no browser window is available, use the path printed after `report=`. On macOS, for example:

```bash
open '/absolute/path/to/nightly-profile-YYYYMMDD-HHMMSS/newtab-history-rank.html'
```

If the console prints a different path after `report=`, use that path.

The report is one global list sorted by raw cosine similarity, regardless of the selected UI reranking mode. Articles without a valid score appear at the end. It includes the cosine rank, global Merino rank, server score, section, topic, image, title, excerpt, and URL. The topic histograms compare the global Merino and cosine rank distributions.

[Example HTML report](rerank_pics/rerank_report_example.html)

## Read the console ranking output

Filter the terminal or Browser Console for:

```text
[NewTab cosine]
```

Successful scoring produces one line per article:

```text
[NewTab cosine] section=travel original_rank=6 sim_rank=2 sim_score=0.1298 url=https://example.com/article
```

The fields mean:

- `section`: the New Tab section containing the article;
- `original_rank`: the article's rank in the incoming feed;
- `sim_rank`: its final rank within the section after the selected reranking mode;
- `sim_score`: cosine similarity to the user vector;
- `url`: the article URL.

Sections keep their original order. Within-section mode only reorders articles inside their existing sections. Promote Top 6 moves the six global leaders into Popular Today and reorders the remaining articles inside their sections.

## Fallback messages

If semantic history is unavailable or no valid vector exists, the console shows:

```text
[NewTab cosine] no user history vector available
```

The feed then keeps its existing order and does not generate article embeddings. If a user vector exists but no article can be scored, it shows a `no article scores` message and also preserves the existing order.

## Screenshots

The screenshots used in this guide are stored in [`rerank_pics/`](rerank_pics/). Markdown renders the JPEG files inline, and the example report is linked as an HTML file.

## TODO

- Modify Merino so `server_score` is available for every article.
- Combine `server_score` and cosine similarity to make explicit ranking tradeoffs.
- Track representations of articles the user clicks in New Tab.
- Combine the history representation, the New Tab article-click representation, cosine similarity, and `server_score` in a unified ranking strategy.
- Add client-side learning or adaptation for the three ranking signals: history similarity, article-click similarity, and `server_score`.
