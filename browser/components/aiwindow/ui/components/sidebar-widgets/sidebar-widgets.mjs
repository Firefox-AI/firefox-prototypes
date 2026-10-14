/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MerinoClient: "moz-src:///browser/components/urlbar/MerinoClient.sys.mjs",
});

/**
 * Prototype sidebar cards. Strings are hardcoded on purpose.
 *
 * Weather shows the current location until the selected page mentions a known
 * place (a Japan travel page shows Tokyo). The timer records how long the
 * previous tab was selected.
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
    this.#tab = tab;
    this.#host = tabHost(tab);
    this.#visitStarted = Date.now();
    this.elapsed = "0:00";
    this.#watch(tab?.linkedBrowser);
    this.#scheduleWeather();
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
        <div class="detail">${this.lastSwitch}</div>
      </section>
    `;
  }
}

customElements.define("sidebar-widgets", SidebarWidgets);
