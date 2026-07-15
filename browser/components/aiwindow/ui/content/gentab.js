/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
const { topChromeWindow } = window.browsingContext;

ChromeUtils.defineESModuleGetters(lazy, {
  AboutWelcomeParent: "resource:///actors/AboutWelcomeParent.sys.mjs",
  GenTab: "moz-src:///browser/components/aiwindow/ui/modules/GenTab.sys.mjs",
});

/** @type {string | null} */
let gGenerationId = null;
/** @type {object | null} */
let gHeaderState = null;

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

function closeIntentPanel() {
  const panel = document.getElementById("gentab-intent-panel");
  const control = document.getElementById("gentab-intent-control");
  if (panel) {
    panel.hidden = true;
  }
  if (control) {
    control.setAttribute("aria-expanded", "false");
  }
}

function openIntentPanel() {
  const panel = document.getElementById("gentab-intent-panel");
  const control = document.getElementById("gentab-intent-control");
  const input = document.getElementById("gentab-intent-input");
  if (!panel || !control) {
    return;
  }
  panel.hidden = false;
  control.setAttribute("aria-expanded", "true");
  if (input) {
    input.value = (gHeaderState?.intent || "").trim();
    // Focus custom field so free entry is immediate.
    input.focus();
    input.select();
  }
}

function toggleIntentPanel() {
  const panel = document.getElementById("gentab-intent-panel");
  if (!panel || panel.hidden) {
    openIntentPanel();
  } else {
    closeIntentPanel();
  }
}

/**
 * @param {string[]} suggestions
 * @param {string} currentIntent
 */
function populateIntentSuggestions(suggestions, currentIntent) {
  const list = document.getElementById("gentab-intent-suggestions");
  if (!list) {
    return;
  }
  list.replaceChildren();
  const current = (currentIntent || "").trim().toLowerCase();
  for (const label of suggestions) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gentab-intent-option";
    btn.textContent = label;
    if (label.trim().toLowerCase() === current) {
      btn.classList.add("selected");
      btn.setAttribute("aria-selected", "true");
    } else {
      btn.setAttribute("aria-selected", "false");
    }
    btn.addEventListener("click", () => {
      applyIntent(label);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
  if (!suggestions.length) {
    const empty = document.createElement("li");
    empty.className = "gentab-intent-empty";
    empty.textContent = "Type a custom intent below.";
    list.appendChild(empty);
  }
}

/**
 * Populate the chrome header from GenTab state.
 *
 * @param {object} state
 */
function renderHeader(state) {
  const header = document.getElementById("gentab-header");
  if (!header) {
    return;
  }
  gHeaderState = state;

  const emoji = state.emoji || "✨";
  const title = state.title || "GenTab";
  const blurb = state.headerBlurb || state.summary || "";
  const intent = (state.intent || "").trim();
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const suggestions = Array.isArray(state.intentSuggestions)
    ? state.intentSuggestions
    : [];

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
  intentControl.disabled = false;
  intentControl.setAttribute(
    "aria-label",
    intent
      ? `Intent: ${intent}. Activate to change.`
      : "Intent: Auto. Activate to choose or type an intent."
  );
  intentControl.title = "Change intent and regenerate GenTab";

  populateIntentSuggestions(suggestions, intent);

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

/**
 * @param {string} intent
 */
async function applyIntent(intent) {
  const next = (intent || "").trim();
  if (!next) {
    return;
  }
  const id = gGenerationId || getGenerationId();
  if (!id) {
    return;
  }

  const current = (gHeaderState?.intent || "").trim();
  if (next.toLowerCase() === current.toLowerCase()) {
    closeIntentPanel();
    return;
  }

  closeIntentPanel();
  showStatus(`Regenerating GenTab for “${next}”…`);
  document.getElementById("gentab-header").hidden = true;
  document.getElementById("multi-stage-message-root").hidden = true;

  try {
    await lazy.GenTab.regenerateWithIntent(id, next);
    // Module state persists across reload; remount aboutwelcome cleanly.
    window.location.reload();
  } catch (error) {
    console.error(error);
    showStatus(error?.message || "Could not regenerate GenTab.");
    document.getElementById("gentab-header").hidden = false;
    document.getElementById("multi-stage-message-root").hidden = false;
  }
}

function bindIntentSwitcher() {
  const control = document.getElementById("gentab-intent-control");
  const panel = document.getElementById("gentab-intent-panel");
  const input = document.getElementById("gentab-intent-input");
  const apply = document.getElementById("gentab-intent-apply");
  if (!control || !panel) {
    return;
  }

  control.addEventListener("click", event => {
    event.stopPropagation();
    toggleIntentPanel();
  });

  apply?.addEventListener("click", () => {
    applyIntent(input?.value || "");
  });

  input?.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyIntent(input.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeIntentPanel();
      control.focus();
    }
  });

  document.addEventListener("click", event => {
    if (panel.hidden) {
      return;
    }
    const switcher = document.querySelector(".gentab-intent-switcher");
    if (switcher && !switcher.contains(event.target)) {
      closeIntentPanel();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) {
      closeIntentPanel();
    }
  });
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
  gGenerationId = getGenerationId();
  if (!gGenerationId) {
    showStatus("Missing GenTab id.");
    return;
  }

  showStatus("Creating GenTab from page content…");

  let state = lazy.GenTab.getState(gGenerationId);
  if (!state) {
    showStatus("This GenTab session is no longer available.");
    return;
  }

  if (state.status === "loading") {
    state = await lazy.GenTab.waitForState(gGenerationId);
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
  document.getElementById("multi-stage-message-root").hidden = false;
  renderHeader(state);
  mountAboutWelcome(state.config);
}

bindIntentSwitcher();

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => renderGenTab().catch(console.error),
    { once: true }
  );
} else {
  renderGenTab().catch(console.error);
}
