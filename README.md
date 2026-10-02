# Prototype: Jev browser agent in Smart Window (`jev-browser-agent`)

Smart Window drives a visible tab with [TypeSafe's Jev](https://docs.typesafe.ai/introduction), ported from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast). Jev makes every click / type / select decision from an indexed element table; Firefox executes it through a content actor; Smart Window's own chat model writes typed values and produces the final result. Page URL, title, visible text, element labels and typed values are sent to Jev's API and to the Smart Window model on every step.

Code lives under `browser/components/aiwindow/` (`models/JevBrowseLoop.sys.mjs`, `ui/actors/JevBrowse{Parent,Child}.sys.mjs`, `ui/components/{recipe-ingredients-card,browse-results-card,jev-trace-strip}/`). Prefs are `browser.aiwindow.jev.*` in `browser/app/profile/firefox.js`.

## Setup

1. Put a TypeSafe/Jev API key in a single-line file at `~/.firefox-prototype-secrets/jev-api-key` (mode 0600). The launcher exports it as `JEV_API_KEY` into the Firefox process only; it is never written to prefs or the repo. A missing key fails before any tab opens.
2. Build with artifact builds and launch via the prototype launcher (`run.command` in the worktree, or `launch.sh` from the `_prototype` artifact dir). Without the launcher, set `JEV_API_KEY` in the environment yourself.
3. Type a direction into the Smart Window Smartbar.

## Supported test cases

### Recipe (verified live, 3/3 runs, about 6 s to a loaded card)

Imperative sentence + "recipe" + "ingredients", optional "for N people/servings". Seeds a DuckDuckGo search, Jev opens a result, the page is probed for an ingredient list, the chat model extracts and scales quantities.

- `find a simple butter pasta recipe and give me a list of ingredients for 4 people`
- `search for a classic chocolate chip cookie recipe and list the ingredients for 12 servings`
- `get a guacamole recipe and give me the ingredients for 8 servings` (forces visible scaling)
- `find a vegan banana bread recipe and list ingredients` (no count: shows the recipe's own yield)

Not routed to the agent on purpose: questions, sentences starting with why/how/what/is/does, and anything about "this recipe" or an attached tab.

### Directions: "go to / open / on / use <site> and <goal>" (offline suite passes; live Google Flights reaches the results page, final verification pending)

Built-in site map: google flights, airbnb, booking, kayak, expedia, opentable, wikipedia, amazon, yelp, google maps, youtube, github, allrecipes. Unknown sites fall back to a web search for `<site> <goal>`. Dates must use a month name; past dates roll forward a year.

- `go to google flights and find tickets from sfo to tpe on nov 6 to nov 23` (primary demo)
- `go to google flights and find one way flights from sfo to seattle on dec 12`
- `go to kayak and find flights from lax to tokyo on jan 10 to jan 24`
- `go to wikipedia and open the article about the Golden Gate Bridge`
- `go to opentable and find a table for 2 in san francisco on nov 7 at 7pm`
- `go to amazon and find a 65 inch oled tv under 1500 dollars`
- `go to yelp and find ramen restaurants in oakland`
- `go to airbnb and find places in taipei with at least 2 bedroom available on nov 6 to 23` (reaches results; the bedroom filter is a soft requirement and often not applied)
- `go to booking.com and find places in taipei available on nov 6 to 23` (sign-in overlays and date-field loops frequently end the run blocked)

### Explicit URL: `/browse <url> <goal>`

- `/browse https://www.google.com/travel/flights find flights from sfo to tpe on nov 6 to nov 23`
- `/browse https://www.bbcgoodfood.com/ find a lemon drizzle cake recipe and list the ingredients`
- `/browse find a cacio e pepe recipe and list the ingredients for 6 people` (no URL: seeds a search)

## What to expect

- The run opens a new tab with a "Smart Window is browsing <host> for you" bar and a Stop button; the tab is handed back when the run ends.
- The card shows requirement chips (From SFO, To TPE, Depart Nov 6, Return Nov 23), result rows with prices, and a trace strip with every Jev decision (operation, element, probability, latency, typed value).
- A "Needs your OK" prompt appears before any click that looks like book, reserve, pay or checkout, or on a checkout-style URL. One approval = one click. The agent stops and asks; it does not book on its own.
- Terminal states: done, blocked (no progress, budget, bot challenge, consent loop, done unverified), cancelled (Stop, declined gate, gate timeout), error (missing key, invalid args, network, timeout).

## Not supported

Multi-page aggregation (visiting several listings), login flows, canvas or closed-shadow-DOM widgets, numeric date formats like `6/11`, and anything that requires committing a purchase or reservation.

## Offline QA

A scripted fake Jev endpoint and HTML fixtures (search page, recipe page, travel search form with combobox + date picker, results page, bot-challenge page) live outside the repo in the prototype artifact dir (`_prototype/2026-10-02-jev-general-browse/qa/`). Set `browser.aiwindow.jev.endpoint` to the fake server and `verifierMode=tokens` to run without network or keys. Clear those prefs before live use.

---

![Firefox Browser](./docs/readme/readme-banner.svg)

[Firefox](https://firefox.com/) is a fast, reliable and private web browser from the non-profit [Mozilla organization](https://mozilla.org/).

### Contributing

To learn how to contribute to Firefox read the [Firefox Contributors' Quick Reference document](https://firefox-source-docs.mozilla.org/contributing/contribution_quickref.html).

We use [bugzilla.mozilla.org](https://bugzilla.mozilla.org/) as our issue tracker, please file bugs there.

### Resources

* [Firefox Source Docs](https://firefox-source-docs.mozilla.org/) is our primary documentation repository
* Nightly development builds can be downloaded from [Firefox Nightly page](https://www.mozilla.org/firefox/channel/desktop/#nightly)

If you have a question about developing Firefox, and can't find the solution
on [Firefox Source Docs](https://firefox-source-docs.mozilla.org/), you can try asking your question on Matrix at
chat.mozilla.org in the [Introduction channel](https://chat.mozilla.org/#/room/#introduction:mozilla.org).
