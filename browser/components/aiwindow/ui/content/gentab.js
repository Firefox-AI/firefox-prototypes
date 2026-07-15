/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
const { topChromeWindow } = window.browsingContext;

ChromeUtils.defineESModuleGetters(lazy, {
  AboutWelcomeParent: "resource:///actors/AboutWelcomeParent.sys.mjs",
  GenTab: "moz-src:///browser/components/aiwindow/ui/modules/GenTab.sys.mjs",
});

function getGenerationId() {
  try {
    return new URL(window.location.href).searchParams.get("id");
  } catch {
    return null;
  }
}

function showStatus(message) {
  const status = document.getElementById("gentab-status");
  const text = document.getElementById("gentab-status-message");
  text.textContent = message;
  status.hidden = false;
}

function hideStatus() {
  document.getElementById("gentab-status").hidden = true;
}

/**
 * @param {number} generatedAt ms epoch
 * @returns {string}
 */
function formatGeneratedLabel(generatedAt) {
  if (!generatedAt) {
    return "Generated just now";
  }
  const deltaMs = Date.now() - generatedAt;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) {
    return "Generated just now";
  }
  if (minutes === 1) {
    return "Generated 1 minute ago";
  }
  if (minutes < 60) {
    return `Generated ${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 1) {
    return "Generated 1 hour ago";
  }
  if (hours < 24) {
    return `Generated ${hours} hours ago`;
  }
  return "Generated earlier";
}

/**
 * Populate the chrome header from GenTab state.
 * Intent + Tabs chips are non-interactive placeholders for regenerate UX.
 *
 * @param {object} state
 */
function renderHeader(state) {
  const header = document.getElementById("gentab-header");
  if (!header) {
    return;
  }

  const emoji = state.emoji || "✨";
  const title = state.title || "GenTab";
  const blurb = state.headerBlurb || state.summary || "";
  const intent = (state.intent || "").trim();
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];

  document.getElementById("gentab-header-emoji").textContent = emoji;
  document.getElementById("gentab-header-generated").textContent =
    formatGeneratedLabel(state.generatedAt);
  document.getElementById("gentab-header-title").textContent = title;
  const blurbEl = document.getElementById("gentab-header-blurb");
  blurbEl.textContent = blurb;
  blurbEl.hidden = !blurb;

  const intentValue = document.getElementById("gentab-intent-value");
  intentValue.textContent = intent || "Auto";
  const intentControl = document.getElementById("gentab-intent-control");
  intentControl.setAttribute(
    "aria-label",
    intent
      ? `Intent: ${intent}. Editing coming soon.`
      : "Intent: Auto. Editing coming soon."
  );

  const tabsValue = document.getElementById("gentab-tabs-value");
  const tabCount = tabs.length;
  tabsValue.textContent = tabCount > 0 ? `${tabCount} ›` : "›";
  const tabsControl = document.getElementById("gentab-tabs-control");
  const tabTitles = tabs
    .map(t => t.title || t.url)
    .filter(Boolean)
    .slice(0, 6)
    .join(", ");
  tabsControl.title = tabTitles
    ? `Sources: ${tabTitles}. Managing tabs coming soon.`
    : "Source tabs management coming soon — will regenerate GenTab";
  tabsControl.setAttribute(
    "aria-label",
    tabCount
      ? `${tabCount} source tabs. Managing tabs coming soon.`
      : "Source tabs. Managing tabs coming soon."
  );

  header.hidden = false;
}

function mountAboutWelcome(config) {
  const AWParent = new lazy.AboutWelcomeParent();
  const receive = name => data =>
    AWParent.onContentMessage(
      `AWPage:${name}`,
      data,
      topChromeWindow.gBrowser.selectedBrowser
    );

  window.AWGetFeatureConfig = () => config;
  window.AWEvaluateScreenTargeting = screens => screens;
  window.AWGetSelectedTheme = () => ({});
  window.AWGetInstalledAddons = () => [];
  window.AWSendToParent = (name, data) => receive(name)(data);
  window.AWSendEventTelemetry = () => {};
  window.AWFinish = () => {
    // GenTab is the artifact; finishing the multistage flow is a no-op.
  };

  window.addEventListener(
    "unload",
    () => {
      AWParent.didDestroy();
    },
    { once: true }
  );

  const script = document.createElement("script");
  script.src = "chrome://browser/content/aboutwelcome/aboutwelcome.bundle.js";
  document.body.appendChild(script);
}

async function renderGenTab() {
  const id = getGenerationId();
  if (!id) {
    showStatus("Missing GenTab id.");
    return;
  }

  showStatus("Creating GenTab from page content…");

  let state = lazy.GenTab.getState(id);
  if (!state) {
    showStatus("This GenTab session is no longer available.");
    return;
  }

  if (state.status === "loading") {
    state = await lazy.GenTab.waitForState(id);
  }

  if (state.status === "error") {
    showStatus(state.error || "Could not create GenTab.");
    document.title = "GenTab error";
    return;
  }

  if (!state.config) {
    showStatus("GenTab config was empty.");
    return;
  }

  document.title = state.title || "GenTab";
  hideStatus();
  renderHeader(state);
  mountAboutWelcome(state.config);
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => renderGenTab().catch(console.error),
    { once: true }
  );
} else {
  renderGenTab().catch(console.error);
}
