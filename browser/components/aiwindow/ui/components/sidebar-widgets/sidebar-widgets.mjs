/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  EMBEDDING_TYPE: "chrome://global/content/ml/EmbeddingsGenerator.sys.mjs",
  EmbeddingsGenerator: "chrome://global/content/ml/EmbeddingsGenerator.sys.mjs",
  AuthProvider:
    "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs",
  GetPageContent: "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs",
  MemoriesManager:
    "moz-src:///browser/components/aiwindow/models/memories/MemoriesManager.sys.mjs",
  MODEL_FEATURES: "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs",
  MerinoClient: "moz-src:///browser/components/urlbar/MerinoClient.sys.mjs",
  buildEngineForFeature:
    "moz-src:///browser/components/aiwindow/models/PromptLoader.sys.mjs",
  cosSim: "chrome://global/content/ml/NLPUtils.sys.mjs",
});

/**
 * Prototype sidebar cards. Strings are hardcoded on purpose.
 *
 * Weather shows the current location until the selected page mentions a known
 * place (a Japan travel page shows Tokyo). The timer records how long the
 * previous tab was selected and totals that time by activity. Activities come
 * from static embeddings, the same family about:inference runs, scored with
 * the cosine similarity Smart Tab Grouping uses. That activity also picks
 * memories from MemoriesManager, with placeholder examples when none match.
 * A note card asks the title-generation model for a short practical note
 * grounded in that page and only the memories that bear on it.
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
const NOTE_PAGE_LIMIT = 1500;
// Quiet period after the last top-level load event. Session restore selects
// a tab before its document has any content, and a short wait starts the
// note on an empty page.
const NOTE_DEBOUNCE_MS = 1500;
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
    id: "shopping",
    label: "Shopping",
    examples: [
      "online shopping product reviews prices checkout cart",
      "buying clothes shoes furniture comparing deals",
    ],
  },
  {
    id: "entertainment",
    label: "Entertainment",
    examples: [
      "movies tv shows streaming music concerts games",
      "what to watch playlist album trailer box office",
    ],
  },
  {
    id: "health",
    label: "Health",
    examples: [
      "fitness workout running sleep health symptoms exercise",
      "training plan yoga steps calories doctor visit",
    ],
  },
  {
    id: "finance",
    label: "Finance",
    examples: [
      "banking budget savings investing credit card bills",
      "mortgage taxes retirement portfolio spending",
    ],
  },
  {
    id: "sports",
    label: "Sports",
    examples: [
      "sports scores standings game highlights team schedule",
      "soccer basketball baseball match results playoffs",
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

// Query passed to MemoriesManager.getRelevantMemories for the current activity.
const MEMORY_QUERIES = {
  travel: "travel flights airlines hotels trips",
  food: "food diet vegan restaurants meals",
  shopping: "shopping products prices purchases",
  entertainment: "movies music shows games streaming",
  health: "health fitness exercise sleep workouts",
  finance: "finance banking budget savings investing",
  sports: "sports scores teams games",
  research: "research learning studying documentation",
  news: "news current events headlines",
  other: "personal preferences",
};

// Shown when getRelevantMemories returns nothing. Prototype examples only.
const PLACEHOLDER_MEMORIES = {
  travel: [
    "Flies United",
    "Prefers aisle seats",
    "Books hotels downtown",
    "Travels with a carry-on only",
  ],
  food: ["Is vegan", "Likes spicy food", "Cooks on weeknights", "Avoids dairy"],
  shopping: [
    "Compares prices before buying",
    "Buys running shoes online",
    "Shops for home goods",
    "Prefers free shipping",
  ],
  entertainment: [
    "Watches sci-fi movies",
    "Listens to jazz",
    "Plays puzzle games",
    "Follows new album releases",
  ],
  health: [
    "Runs three times a week",
    "Tracks sleep",
    "Prefers morning workouts",
    "Stretches after running",
  ],
  finance: [
    "Uses a high-yield savings account",
    "Tracks monthly spending",
    "Invests in index funds",
    "Pays credit cards in full",
  ],
  sports: [
    "Follows soccer scores",
    "Plays pickup basketball",
    "Watches weekend games",
    "Checks standings on Mondays",
  ],
  research: [
    "Researches AI news",
    "Reads technical docs",
    "Saves papers to read later",
    "Keeps notes on new tools",
  ],
  news: [
    "Researches AI news",
    "Follows world politics",
    "Reads morning headlines",
    "Skips celebrity news",
  ],
  other: [
    "Is vegan",
    "Flies United",
    "Researches AI news",
    "Runs three times a week",
    "Compares prices before buying",
    "Watches sci-fi movies",
  ],
};

function placeholderMemories(activityId) {
  const lines = PLACEHOLDER_MEMORIES[activityId] || PLACEHOLDER_MEMORIES.other;
  return lines.map(text => ({ text, placeholder: true }));
}

const ACTIVITY_KEYWORDS = [
  {
    id: "travel",
    pattern:
      /\b(travel|trip|flight|hotel|vacation|itinerary|tourism|airline|sightseeing)\b/i,
  },
  {
    id: "food",
    pattern: /\b(recipe|restaurant|menu|cuisine|dining|food|cafe|grocery)\b/i,
  },
  {
    id: "shopping",
    pattern: /\b(shop|shopping|cart|checkout|price|buy|store|deal)\b/i,
  },
  {
    id: "entertainment",
    pattern:
      /\b(movie|film|netflix|spotify|music|album|concert|game|streaming|trailer)\b/i,
  },
  {
    id: "health",
    pattern:
      /\b(workout|fitness|running|yoga|sleep|exercise|health|calories|training)\b/i,
  },
  {
    id: "finance",
    pattern:
      /\b(bank|budget|savings|invest|mortgage|credit|taxes|retirement|portfolio)\b/i,
  },
  {
    id: "sports",
    pattern:
      /\b(soccer|basketball|baseball|football|nfl|nba|score|standings|playoffs|match)\b/i,
  },
  {
    id: "news",
    pattern: /\b(news|headline|breaking|politics|newspaper|journalism)\b/i,
  },
  {
    id: "research",
    pattern:
      /\b(research|documentation|wikipedia|tutorial|reference|paper|study)\b/i,
  },
];

function activityById(id) {
  return ACTIVITIES.find(activity => activity.id === id) || OTHER_ACTIVITY;
}

function keywordActivity(text) {
  const id = ACTIVITY_KEYWORDS.find(entry => entry.pattern.test(text))?.id;
  return id ? activityById(id) : OTHER_ACTIVITY;
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

function noteText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

// Enough of a conversation for GetPageContent to read an already-open tab.
// Headless fetches are not used: a missing tab returns ok: false.
const PAGE_READ = {
  getAllMentionURLs() {
    return new Set();
  },
  addSeenUrls() {},
  securityProperties: {
    setPrivateData() {},
    setUntrustedInput() {},
  },
};

const NOTE_SYSTEM = [
  "Write a short practical note for a sidebar card, two or three sentences.",
  "Lead with what is useful on this page: what to do, book, change, or notice.",
  "Memories are a mixed list. Use one only when it changes that advice.",
  "Leave out memories that do not bear on this page.",
  "Do not mention every memory, and do not say that you are using memories.",
  "Plain prose. No preamble, no title, no quotes, and no list.",
].join(" ");

/**
 * Weather, tab-time, memory, and note cards shown at the top of the AI Window sidebar.
 */
export class SidebarWidgets extends MozLitElement {
  static properties = {
    weather: { type: Object },
    elapsed: { type: String },
    lastSwitch: { type: String },
    memories: { type: Array },
    memoriesLabel: { type: String },
    note: { type: String },
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
    this.memories = placeholderMemories("other");
    this.memoriesLabel = "Examples";
    this.note = "Waiting for the page";
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
  #memoryGen = 0;
  #memoryActivityId = "";
  #noteTimer = 0;
  #noteGen = 0;
  #noteKey = "";
  #enginePromise = null;

  #progress = {
    QueryInterface: ChromeUtils.generateQI([
      "nsIWebProgressListener",
      "nsISupportsWeakReference",
    ]),
    onStateChange: (webProgress, _request, flags) => {
      if (!webProgress.isTopLevel) {
        return;
      }
      const loadStart = flags & Ci.nsIWebProgressListener.STATE_START;
      const loadStop = flags & Ci.nsIWebProgressListener.STATE_STOP;
      if (loadStop) {
        this.#scheduleWeather();
        this.#noteDocument();
      }
      if (loadStart || loadStop) {
        this.#postponeNote();
      }
    },
    onLocationChange: webProgress => {
      if (webProgress.isTopLevel) {
        this.#scheduleWeather();
        this.#postponeNote();
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
    clearTimeout(this.#noteTimer);
    this.#win?.gBrowser.tabContainer.removeEventListener(
      "TabSelect",
      this.#onTabSelect
    );
    this.#unwatch();
    this.#win = null;
    this.#weatherGen += 1;
    this.#noteGen += 1;
    this.#noteKey = "";
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
    clearTimeout(this.#noteTimer);
    this.#noteTimer = 0;
    this.#noteGen += 1;
    this.#noteKey = "";
    this.note = "Waiting for the page";
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
          this.#loadMemories(activity);
          this.requestUpdate();
        }
        return activity;
      })
      .catch(() => {
        if (this.#segment === segment) {
          segment.activity = OTHER_ACTIVITY;
          this.#loadMemories(OTHER_ACTIVITY);
          this.requestUpdate();
        }
        return OTHER_ACTIVITY;
      });
  }

  async #loadMemories(activity) {
    const activityId = activity?.id || OTHER_ACTIVITY.id;
    // Same activity on a new URL still needs a new note. Memories stay put.
    if (activityId === this.#memoryActivityId) {
      this.#scheduleNote();
      return;
    }
    this.#memoryActivityId = activityId;
    const gen = ++this.#memoryGen;
    const label = activity?.label || OTHER_ACTIVITY.label;
    let found = [];
    try {
      const matches = await lazy.MemoriesManager.getRelevantMemories(
        MEMORY_QUERIES[activityId] || MEMORY_QUERIES.other,
        3,
        0.2
      );
      found = (matches || [])
        .map(memory => memory.memory_summary?.trim())
        .filter(Boolean)
        .slice(0, 3)
        .map(text => ({ text, placeholder: false }));
    } catch (ex) {
      console.warn("Sidebar memories lookup failed", ex);
    }
    if (gen !== this.#memoryGen) {
      return;
    }
    if (found.length) {
      this.memories = found;
      this.memoriesLabel = label;
    } else {
      this.memories = placeholderMemories(activityId);
      this.memoriesLabel = `${label} · examples`;
    }
    this.#scheduleNote();
  }

  // Push note generation out while a restored or newly opened document is
  // still loading. Does not change a note that already finished.
  #postponeNote() {
    if (!this.#segment?.activity) {
      return;
    }
    if (this.note === "Writing a note") {
      this.#noteGen += 1;
      this.#noteKey = "";
      this.note = "Waiting for the page";
    }
    this.#scheduleNote();
  }

  #documentLoading() {
    try {
      return !!this.#tab?.linkedBrowser?.webProgress?.isLoadingDocument;
    } catch (ex) {
      return false;
    }
  }

  #scheduleNote() {
    if (!this.#segment?.activity) {
      return;
    }
    clearTimeout(this.#noteTimer);
    this.#noteTimer = setTimeout(() => {
      this.#noteTimer = 0;
      this.#loadNote();
    }, NOTE_DEBOUNCE_MS);
  }

  async #loadNote() {
    if (this.#documentLoading()) {
      this.#scheduleNote();
      return;
    }
    const activity = this.#segment?.activity;
    const spec = this.#pageSpec;
    if (!activity || !spec) {
      return;
    }
    const lines = (this.memories || [])
      .map(memory => memory.text)
      .filter(Boolean);
    const examples = (this.memories || []).some(memory => memory.placeholder);
    const title = this.#tab?.label || "";
    const key = `${spec}\0${title}\0${activity.id}\0${lines.join("\n")}`;
    if (key === this.#noteKey) {
      return;
    }
    this.#noteKey = key;
    const gen = ++this.#noteGen;
    this.note = "Writing a note";
    try {
      const text = await this.#writeNote(spec, activity, lines, examples);
      if (gen !== this.#noteGen) {
        return;
      }
      this.note = text || "Could not write a note";
    } catch (ex) {
      console.warn("Sidebar note failed", ex);
      if (gen !== this.#noteGen) {
        return;
      }
      this.note = "Could not write a note";
    }
  }

  async #writeNote(spec, activity, lines, examples) {
    const excerpt = await this.#pageExcerpt(spec);
    const title = this.#tab?.label || "";
    const memoryBlock = lines.length
      ? lines.map(line => `- ${line}`).join("\n")
      : "- (none)";
    const memoryLabel = examples
      ? "Example memories for this activity"
      : "Saved memories";
    const content = [
      `Activity: ${activity.label}`,
      `Title: ${title}`,
      `URL: ${spec}`,
      excerpt ? `Page:\n${excerpt}` : "Page text is unavailable.",
      `${memoryLabel}:\n${memoryBlock}`,
      "Write the note. Skip memories that are not relevant to this page.",
    ].join("\n\n");
    const { engine, parameters } = await this.#engineBundle();
    const response = await engine.run({
      args: [
        { role: "system", content: NOTE_SYSTEM },
        { role: "user", content },
      ],
      token: await lazy.AuthProvider.getToken(),
      inferenceParams: {
        ...parameters,
        max_completion_tokens: 220,
      },
    });
    const text = noteText(response?.finalOutput);
    if (!text) {
      throw new Error("empty note");
    }
    return text;
  }

  async #pageExcerpt(spec) {
    if (!isHttp(spec)) {
      return "";
    }
    const results = await lazy.GetPageContent.getPageContent(
      { url_list: [spec] },
      PAGE_READ
    );
    const result = results?.[0];
    if (!result?.ok) {
      return "";
    }
    return result.content.slice(0, NOTE_PAGE_LIMIT);
  }

  #engineBundle() {
    if (!this.#enginePromise) {
      this.#enginePromise = lazy
        .buildEngineForFeature(lazy.MODEL_FEATURES.TITLE_GENERATION)
        .catch(error => {
          this.#enginePromise = null;
          throw error;
        });
    }
    return this.#enginePromise;
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
      <section class="card memories" aria-label="Memories">
        <div class="label">Memories · ${this.memoriesLabel}</div>
        <ul class="memories-list">
          ${this.memories.map(memory => html`<li>${memory.text}</li>`)}
        </ul>
      </section>
      <section class="card note" aria-label="Note">
        <div class="label">Note</div>
        <p class="note-body">${this.note}</p>
      </section>
    `;
  }
}

customElements.define("sidebar-widgets", SidebarWidgets);
