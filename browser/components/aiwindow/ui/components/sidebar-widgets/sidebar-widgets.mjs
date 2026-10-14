/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  EMBEDDING_TYPE: "chrome://global/content/ml/EmbeddingsGenerator.sys.mjs",
  EmbeddingsGenerator: "chrome://global/content/ml/EmbeddingsGenerator.sys.mjs",
  MerinoClient: "moz-src:///browser/components/urlbar/MerinoClient.sys.mjs",
  cosSim: "chrome://global/content/ml/NLPUtils.sys.mjs",
});

/**
 * Prototype sidebar cards. Strings are hardcoded on purpose.
 *
 * Weather shows the current location until the selected page mentions a known
 * place (a Japan travel page shows Tokyo). The timer records how long the
 * previous tab was selected and totals that time by activity. Activities come
 * from static embeddings, the same family about:inference runs, scored with
 * the cosine similarity Smart Tab Grouping uses.
 */

// First match wins. city/region/country are sent straight to the Merino
// weather report. Location autocomplete is skipped: it is biased to the
// client country, so "Tokyo" returns nothing and "Paris" can resolve to a
// city in the US.
const DESTINATIONS = [
  {
    id: "japan",
    label: "Japan",
    city: "Tokyo",
    region: "Tokyo",
    country: "JP",
    timeZone: "Asia/Tokyo",
    pattern: /\b(japan|japanese|tokyo|kyoto|osaka|hiroshima|hokkaido)\b/i,
  },
  {
    id: "paris",
    label: "Paris",
    city: "Paris",
    region: "IDF",
    country: "FR",
    timeZone: "Europe/Paris",
    pattern: /\b(paris|france)\b/i,
  },
  {
    id: "london",
    label: "London",
    city: "London",
    region: "London",
    country: "GB",
    timeZone: "Europe/London",
    pattern: /\b(london|england|britain)\b/i,
  },
  {
    id: "rome",
    label: "Rome",
    city: "Rome",
    region: "62",
    country: "IT",
    timeZone: "Europe/Rome",
    pattern: /\b(rome|italy|florence|venice)\b/i,
  },
  {
    id: "newyork",
    label: "New York",
    city: "New York",
    region: "NY",
    country: "US",
    timeZone: "America/New_York",
    pattern: /\b(new york|nyc|manhattan)\b/i,
  },
];

const WEATHER_SOURCE = "newtab";
const PAGE_TEXT_LIMIT = 2500;
const ACTIVITY_TEXT_LIMIT = 600;
// Normalized static embeddings of a page and a short prototype. Below this
// the visit is "Other" instead of a forced category.
const MIN_ACTIVITY_SIMILARITY = 0.22;

const ACTIVITIES = [
  {
    id: "travel",
    label: "Travel",
    examples: [
      "travel guide flights hotels vacation itinerary tourism sightseeing",
      "visiting a city, booking a trip, things to do on holiday",
    ],
  },
  {
    id: "food",
    label: "Food",
    examples: [
      "restaurant recipe cooking food menu dining cuisine",
      "cafe grocery meal takeout what to eat",
    ],
  },
  {
    id: "research",
    label: "Research",
    examples: [
      "research documentation reference paper study tutorial",
      "how to technical docs wikipedia academic source",
    ],
  },
  {
    id: "news",
    label: "News",
    examples: [
      "news headline breaking report journalism politics",
      "world news newspaper article current events",
    ],
  },
];

const OTHER_ACTIVITY = { id: "other", label: "Other" };

const ACTIVITY_KEYWORDS = [
  {
    activity: ACTIVITIES[0],
    pattern:
      /\b(travel|trip|flight|hotel|vacation|itinerary|tourism|airline|sightseeing)\b/i,
  },
  {
    activity: ACTIVITIES[1],
    pattern: /\b(recipe|restaurant|menu|cuisine|dining|food|cafe|grocery)\b/i,
  },
  {
    activity: ACTIVITIES[3],
    pattern: /\b(news|headline|breaking|politics|newspaper|journalism)\b/i,
  },
  {
    activity: ACTIVITIES[2],
    pattern:
      /\b(research|documentation|wikipedia|tutorial|reference|paper|study)\b/i,
  },
];

function keywordActivity(text) {
  return (
    ACTIVITY_KEYWORDS.find(entry => entry.pattern.test(text))?.activity ||
    OTHER_ACTIVITY
  );
}

function matchDestination(haystack) {
  if (!haystack) {
    return null;
  }
  return DESTINATIONS.find(place => place.pattern.test(haystack)) || null;
}

function tabHost(tab) {
  try {
    const uri = tab?.linkedBrowser?.currentURI;
    return uri?.displayHost || uri?.spec || "this tab";
  } catch (ex) {
    return "this tab";
  }
}

function tabUrl(tab) {
  try {
    return tab?.linkedBrowser?.currentURI?.spec || "";
  } catch (ex) {
    return "";
  }
}

function isHttp(spec) {
  return spec.startsWith("http://") || spec.startsWith("https://");
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function temperatureUnit() {
  return navigator.language === "en-US" ? "f" : "c";
}

/**
 * Weather and tab-time cards shown at the top of the AI Window sidebar.
 */
export class SidebarWidgets extends MozLitElement {
  static properties = {
    weather: { type: Object },
    elapsed: { type: String },
    lastSwitch: { type: String },
  };

  constructor() {
    super();
    this.weather = {
      status: "loading",
      destination: null,
      city: "",
      summary: "",
      temperature: null,
      unit: temperatureUnit(),
    };
    this.elapsed = "0:00";
    this.lastSwitch = "Switch tabs to compare";
    this.#merino = new lazy.MerinoClient("AIWINDOW_SIDEBAR_WEATHER", {
      allowOhttp: false,
    });
    this.#reports = new Map();
    this.#totals = new Map();
  }

  #merino;
  #reports;
  #win = null;
  #tab = null;
  #host = "";
  #visitStarted = 0;
  #watched = null;
  #timer = 0;
  #weatherTimer = 0;
  #weatherGen = 0;
  #totals = null;
  #segment = null;
  #pageSpec = "";
  #embeddings = null;
  #prototypePromise = null;

  #progress = {
    QueryInterface: ChromeUtils.generateQI([
      "nsIWebProgressListener",
      "nsISupportsWeakReference",
    ]),
    onStateChange: (webProgress, _request, flags) => {
      if (
        webProgress.isTopLevel &&
        flags & Ci.nsIWebProgressListener.STATE_STOP
      ) {
        this.#scheduleWeather();
        this.#noteDocument();
      }
    },
    onLocationChange: webProgress => {
      if (webProgress.isTopLevel) {
        this.#scheduleWeather();
      }
    },
    onProgressChange() {},
    onStatusChange() {},
    onSecurityChange() {},
    onContentBlockingEvent() {},
  };

  connectedCallback() {
    super.connectedCallback();
    const win = window.browsingContext?.topChromeWindow;
    if (!win?.gBrowser) {
      return;
    }
    this.#win = win;
    win.gBrowser.tabContainer.addEventListener("TabSelect", this.#onTabSelect);
    this.#adoptTab(win.gBrowser.selectedTab, false);
    this.#timer = setInterval(() => this.#tick(), 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.#timer);
    clearTimeout(this.#weatherTimer);
    this.#win?.gBrowser.tabContainer.removeEventListener(
      "TabSelect",
      this.#onTabSelect
    );
    this.#unwatch();
    this.#win = null;
    this.#weatherGen += 1;
  }

  #onTabSelect = event => {
    if (event.target === this.#tab) {
      return;
    }
    this.#adoptTab(event.target, true);
  };

  #tick() {
    if (!this.#visitStarted) {
      return;
    }
    this.elapsed = formatClock(Date.now() - this.#visitStarted);
  }

  #adoptTab(tab, recordPrevious) {
    if (recordPrevious && this.#visitStarted) {
      const spent = formatDuration(Date.now() - this.#visitStarted);
      this.lastSwitch = `Spent ${spent} on ${this.#host}`;
    }
    this.#closeSegment();
    this.#tab = tab;
    this.#host = tabHost(tab);
    this.#visitStarted = Date.now();
    this.elapsed = "0:00";
    this.#watch(tab?.linkedBrowser);
    this.#openSegment(tabUrl(tab));
    this.#scheduleWeather();
  }

  #noteDocument() {
    const spec = tabUrl(this.#tab);
    if (!spec) {
      return;
    }
    if (spec !== this.#pageSpec) {
      this.#openSegment(spec);
      return;
    }
    // The tab was selected before the title was ready. Classify once more
    // when the document finishes, keeping the time already accumulated.
    const segment = this.#segment;
    if (!segment || segment.refreshed) {
      return;
    }
    segment.refreshed = true;
    segment.activity = null;
    this.#startClassify(segment, this.#tab, spec);
  }

  #openSegment(spec) {
    this.#closeSegment();
    const tab = this.#tab;
    const segment = {
      started: Date.now(),
      spec,
      activity: null,
      done: null,
    };
    this.#segment = segment;
    this.#pageSpec = spec;
    this.#startClassify(segment, tab, spec);
  }

  #startClassify(segment, tab, spec) {
    segment.classifyGen = (segment.classifyGen || 0) + 1;
    const gen = segment.classifyGen;
    segment.done = this.#classify(tab, spec)
      .then(activity => {
        if (segment.classifyGen !== gen) {
          return activity;
        }
        if (this.#segment === segment) {
          segment.activity = activity;
          this.requestUpdate();
        }
        return activity;
      })
      .catch(() => OTHER_ACTIVITY);
  }

  #closeSegment() {
    const segment = this.#segment;
    this.#segment = null;
    if (!segment?.started) {
      return;
    }
    const ms = Date.now() - segment.started;
    if (ms < 1000) {
      return;
    }
    const apply = activity => {
      const id = activity?.id || OTHER_ACTIVITY.id;
      this.#totals.set(id, (this.#totals.get(id) || 0) + ms);
      this.requestUpdate();
    };
    if (segment.activity) {
      apply(segment.activity);
      return;
    }
    segment.done?.then(apply).catch(() => apply(OTHER_ACTIVITY));
  }

  async #classify(tab, spec) {
    const title = tab?.linkedBrowser?.contentTitle || "";
    const host = tabHost(tab);
    let text = `${title}\n${host}\n${spec}`;
    if (isHttp(spec)) {
      try {
        const actor =
          tab.linkedBrowser.browsingContext?.currentWindowGlobal?.getActor(
            "PageExtractor"
          );
        const extraction = await actor?.getText({
          sufficientLength: ACTIVITY_TEXT_LIMIT,
          removeBoilerplate: true,
          sourceUrl: spec,
        });
        if (extraction?.text) {
          text += `\n${extraction.text.slice(0, ACTIVITY_TEXT_LIMIT)}`;
        }
      } catch (ex) {
        // Title and host are enough for a guess.
      }
    }
    try {
      return await this.#nearestActivity(text);
    } catch (ex) {
      console.warn("Sidebar activity embedding failed", ex);
      return keywordActivity(text);
    }
  }

  #embedQueue = Promise.resolve();

  #embed(texts) {
    const run = this.#embedQueue.then(() => this.#embeddings.embedMany(texts));
    this.#embedQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  #ensurePrototypes() {
    if (!this.#prototypePromise) {
      this.#prototypePromise = this.#buildPrototypes().catch(error => {
        this.#prototypePromise = null;
        throw error;
      });
    }
    return this.#prototypePromise;
  }

  async #buildPrototypes() {
    if (!this.#embeddings) {
      // Static embeddings, not forGeneral(): that path loads the contextual
      // model Smart Tab Grouping uses, which is more than this per-page
      // classifier needs. forTest is the supported way to pin the backend.
      this.#embeddings = lazy.EmbeddingsGenerator.forTest({
        type: lazy.EMBEDDING_TYPE.STATIC,
        embeddingSize: 128,
      });
    }
    const texts = [];
    const activities = [];
    for (const activity of ACTIVITIES) {
      for (const example of activity.examples) {
        texts.push(example);
        activities.push(activity);
      }
    }
    const vectors = await this.#embed(texts);
    return activities.map((activity, index) => ({
      activity,
      vector: vectors[index],
    }));
  }

  async #nearestActivity(text) {
    const prototypes = await this.#ensurePrototypes();
    const [vector] = await this.#embed([text.slice(0, 1000)]);
    let best = null;
    let bestScore = MIN_ACTIVITY_SIMILARITY;
    for (const item of prototypes) {
      const score = lazy.cosSim(vector, item.vector);
      if (score > bestScore) {
        bestScore = score;
        best = item.activity;
      }
    }
    return best || OTHER_ACTIVITY;
  }

  #activityRows() {
    const totals = new Map(this.#totals);
    const segment = this.#segment;
    if (segment?.activity && segment.started) {
      const id = segment.activity.id;
      const live = Date.now() - segment.started;
      totals.set(id, (totals.get(id) || 0) + live);
    }
    const rows = ACTIVITIES.map(activity => ({
      id: activity.id,
      label: activity.label,
      ms: totals.get(activity.id) || 0,
    }));
    const other = totals.get(OTHER_ACTIVITY.id) || 0;
    if (other > 0) {
      rows.push({
        id: OTHER_ACTIVITY.id,
        label: OTHER_ACTIVITY.label,
        ms: other,
      });
    }
    return rows.filter(row => row.ms >= 1000).sort((a, b) => b.ms - a.ms);
  }

  #activityLine() {
    const label = this.#segment?.activity?.label;
    if (!label) {
      return "Classifying";
    }
    return `${label} · ${this.#host}`;
  }

  #watch(browser) {
    if (this.#watched === browser) {
      return;
    }
    this.#unwatch();
    if (!browser) {
      return;
    }
    this.#watched = browser;
    browser.addProgressListener(
      this.#progress,
      Ci.nsIWebProgress.NOTIFY_LOCATION |
        Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT
    );
  }

  #unwatch() {
    if (!this.#watched) {
      return;
    }
    try {
      this.#watched.removeProgressListener(this.#progress);
    } catch (ex) {
      // The browser can already be gone when the sidebar closes.
    }
    this.#watched = null;
  }

  #scheduleWeather() {
    clearTimeout(this.#weatherTimer);
    this.#weatherTimer = setTimeout(() => this.#refreshWeather(), 300);
  }

  async #pageHaystack(tab) {
    const spec = tabUrl(tab);
    const title = tab?.linkedBrowser?.contentTitle || "";
    const head = `${title}\n${spec}`;
    if (matchDestination(head) || !isHttp(spec)) {
      return head;
    }
    try {
      const actor =
        tab.linkedBrowser.browsingContext?.currentWindowGlobal?.getActor(
          "PageExtractor"
        );
      const extraction = await actor?.getText({
        sufficientLength: PAGE_TEXT_LIMIT,
        removeBoilerplate: true,
        sourceUrl: spec,
      });
      const text = extraction?.text?.slice(0, PAGE_TEXT_LIMIT) || "";
      return `${head}\n${text}`;
    } catch (ex) {
      console.warn("Sidebar widgets could not read the page", ex);
      return head;
    }
  }

  #fetchReport(destination) {
    if (!destination) {
      return this.#merino.fetchWeatherReport({
        source: WEATHER_SOURCE,
        timeoutMs: 7000,
      });
    }
    return this.#merino.fetchWeatherReport({
      source: WEATHER_SOURCE,
      city: destination.city,
      region: destination.region,
      country: destination.country,
      timeoutMs: 7000,
    });
  }

  async #refreshWeather() {
    const gen = ++this.#weatherGen;
    const tab = this.#tab;
    let destination = null;
    if (tab && isHttp(tabUrl(tab))) {
      const haystack = await this.#pageHaystack(tab);
      if (gen !== this.#weatherGen) {
        return;
      }
      destination = matchDestination(haystack);
    }
    const cacheKey = destination?.id || "geo";
    const cached = this.#reports.get(cacheKey);
    if (cached) {
      this.weather = { ...cached, destination, status: "ready" };
      return;
    }

    this.weather = { ...this.weather, destination, status: "loading" };
    let report;
    try {
      report = await this.#fetchReport(destination);
    } catch (ex) {
      console.warn("Sidebar weather fetch failed", ex);
      report = null;
    }
    if (gen !== this.#weatherGen) {
      return;
    }
    const conditions = report?.current_conditions;
    if (!conditions?.temperature) {
      this.weather = {
        ...this.weather,
        destination,
        status: "error",
      };
      return;
    }
    const unit = temperatureUnit();
    const ready = {
      status: "ready",
      destination,
      city: report.city_name || destination?.label || "Near you",
      summary: conditions.summary || "",
      temperature: Math.round(conditions.temperature[unit]),
      unit,
    };
    this.#reports.set(cacheKey, ready);
    this.weather = ready;
  }

  #placeLine() {
    if (this.weather.destination) {
      return `${this.weather.destination.label} · this page`;
    }
    if (this.weather.status === "ready" && this.weather.city) {
      return this.weather.city;
    }
    return "Near you";
  }

  #weatherValue() {
    if (this.weather.status === "ready") {
      const unit = this.weather.unit.toUpperCase();
      return `${this.weather.temperature}°${unit}`;
    }
    if (this.weather.status === "error") {
      return "Unavailable";
    }
    return "…";
  }

  #weatherSummary() {
    if (this.weather.status === "ready") {
      return this.weather.summary;
    }
    if (this.weather.status === "error") {
      return "Could not load a forecast";
    }
    return "Loading";
  }

  // Local time for the forecast place. Omitted timeZone is the browser zone,
  // which matches the geolocation forecast.
  #placeTime() {
    const timeZone = this.weather.destination?.timeZone;
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      }).format(new Date());
    } catch (ex) {
      return "";
    }
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/sidebar-widgets.css"
      />
      <section class="card" aria-label="Weather">
        <div class="label">Weather</div>
        <div class="value">${this.#weatherValue()}</div>
        <div class="time">${this.#placeTime()}</div>
        <div class="detail">${this.#weatherSummary()}</div>
        <div class="detail">${this.#placeLine()}</div>
      </section>
      <section class="card" aria-label="Time on tab">
        <div class="label">On this tab</div>
        <div class="value">${this.elapsed}</div>
        <div class="detail">${this.#activityLine()}</div>
        <div class="detail">${this.lastSwitch}</div>
        <ul class="history">
          ${this.#activityRows().map(
            row => html`
              <li>
                <span>${row.label}</span>
                <span>${formatDuration(row.ms)}</span>
              </li>
            `
          )}
        </ul>
      </section>
    `;
  }
}

customElements.define("sidebar-widgets", SidebarWidgets);
