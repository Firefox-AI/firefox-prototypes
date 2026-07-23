/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
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
 * @param {object} state
 */
function renderHeader(state) {
  gHeaderState = state;
  const emoji = state.emoji || "✨";
  const title = state.title || "GenTab";
  const blurb = state.headerBlurb || state.summary || "";
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const tabCount = tabs.length;

  document.getElementById("gentab-header-emoji").textContent = emoji;
  document.getElementById("gentab-header-title").textContent = title;
  const blurbEl = document.getElementById("gentab-header-blurb");
  blurbEl.textContent = blurb;
  blurbEl.hidden = !blurb;

  const meta = document.getElementById("gentab-header-meta-line");
  const parts = [];
  if (tabCount > 0) {
    parts.push(`From ${tabCount} tab${tabCount === 1 ? "" : "s"}`);
  }
  if (state.intent) {
    parts.push(state.intent);
  }
  meta.textContent = parts.join(" · ");
  meta.hidden = !parts.length;
}

/**
 * @param {object} state
 */
function renderTimeline(state) {
  const section = document.getElementById("gentab-timeline");
  const list = document.getElementById("gentab-timeline-list");
  const titleEl = document.getElementById("gentab-timeline-title");
  const subtitleEl = document.getElementById("gentab-timeline-subtitle");
  const progressEl = document.getElementById("gentab-timeline-progress");
  if (!section || !list) {
    return;
  }

  const timeline = state.timeline;
  if (!timeline?.steps?.length) {
    section.hidden = true;
    list.replaceChildren();
    return;
  }

  titleEl.textContent = timeline.title || "Checklist";
  if (timeline.subtitle) {
    subtitleEl.textContent = timeline.subtitle;
    subtitleEl.hidden = false;
  } else {
    subtitleEl.textContent = "";
    subtitleEl.hidden = true;
  }

  list.replaceChildren();
  let doneCount = 0;
  timeline.steps.forEach((step, index) => {
    if (step.done) {
      doneCount += 1;
    }
    const li = document.createElement("li");
    li.className = "gentab-timeline-item";
    if (step.done) {
      li.classList.add("done");
    }
    li.dataset.stepId = step.id;

    const label = document.createElement("label");
    label.className = "gentab-timeline-label";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "gentab-timeline-check";
    checkbox.checked = !!step.done;
    checkbox.dataset.stepId = step.id;
    checkbox.setAttribute(
      "aria-label",
      step.done
        ? `Mark incomplete: ${step.heading}`
        : `Mark complete: ${step.heading}`
    );

    const num = document.createElement("span");
    num.className = "gentab-timeline-num";
    num.setAttribute("aria-hidden", "true");
    num.textContent = String(index + 1);

    const body = document.createElement("span");
    body.className = "gentab-timeline-body";

    const heading = document.createElement("span");
    heading.className = "gentab-timeline-heading";
    heading.textContent = step.heading || " ";

    body.appendChild(heading);
    if (step.body && step.body.trim() && step.body !== " ") {
      const detail = document.createElement("span");
      detail.className = "gentab-timeline-detail";
      detail.textContent = step.body;
      body.appendChild(detail);
    }

    label.appendChild(checkbox);
    label.appendChild(num);
    label.appendChild(body);
    li.appendChild(label);
    list.appendChild(li);
  });

  const total = timeline.steps.length;
  progressEl.textContent = `${doneCount} of ${total} complete`;
  progressEl.hidden = false;

  renderTimelineChoices(timeline.choices || []);
  section.hidden = false;
}

/**
 * @param {Array<{id: string, label: string, body: string}>} choices
 */
function renderTimelineChoices(choices) {
  const wrap = document.getElementById("gentab-timeline-choices");
  const list = document.getElementById("gentab-timeline-choices-list");
  if (!wrap || !list) {
    return;
  }
  list.replaceChildren();
  if (!choices.length) {
    wrap.hidden = true;
    return;
  }
  for (const choice of choices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gentab-timeline-choice";
    btn.dataset.choiceId = choice.id;
    btn.title = choice.body || choice.label;
    btn.textContent = choice.label || choice.body || "Change plan";
    list.appendChild(btn);
  }
  wrap.hidden = false;
}

function bindTimelineChecks() {
  const list = document.getElementById("gentab-timeline-list");
  if (!list || list.dataset.bound === "1") {
    return;
  }
  list.dataset.bound = "1";
  list.addEventListener("change", event => {
    const checkbox = event.target;
    if (
      !HTMLInputElement.isInstance(checkbox) ||
      checkbox.type !== "checkbox"
    ) {
      return;
    }
    const stepId = checkbox.dataset.stepId;
    const id = gGenerationId || getGenerationId();
    if (!stepId || !id) {
      return;
    }
    const timeline = lazy.GenTab.setStepDone(id, stepId, checkbox.checked);
    if (!timeline) {
      return;
    }
    const state = lazy.GenTab.getState(id);
    if (state) {
      gHeaderState = state;
      renderTimeline(state);
    }
  });
}

function bindTimelineChoices() {
  const list = document.getElementById("gentab-timeline-choices-list");
  if (!list || list.dataset.bound === "1") {
    return;
  }
  list.dataset.bound = "1";
  list.addEventListener("click", event => {
    const btn = event.target.closest?.(".gentab-timeline-choice");
    if (!btn) {
      return;
    }
    const choiceId = btn.dataset.choiceId;
    if (choiceId) {
      applyTimelineChoice(choiceId);
    }
  });
}

/**
 * @param {boolean} updating
 * @param {string} [label]
 */
function setTimelineUpdating(updating, label = "") {
  const section = document.getElementById("gentab-timeline");
  const progressEl = document.getElementById("gentab-timeline-progress");
  const choicesList = document.getElementById("gentab-timeline-choices-list");
  if (section) {
    section.classList.toggle("is-updating", updating);
    section.setAttribute("aria-busy", updating ? "true" : "false");
  }
  if (progressEl) {
    if (updating) {
      progressEl.dataset.prevText = progressEl.textContent || "";
      progressEl.textContent = label
        ? `Updating list: ${label}…`
        : "Updating list…";
      progressEl.hidden = false;
    } else if (progressEl.dataset.prevText) {
      progressEl.textContent = progressEl.dataset.prevText;
      delete progressEl.dataset.prevText;
    }
  }
  if (choicesList) {
    for (const btn of choicesList.querySelectorAll(".gentab-timeline-choice")) {
      btn.disabled = updating;
    }
  }
}

/**
 * @param {string} choiceId
 */
async function applyTimelineChoice(choiceId) {
  const id = gGenerationId || getGenerationId();
  if (!id || !choiceId) {
    return;
  }
  const choice = (gHeaderState?.timeline?.choices || []).find(
    c => c.id === choiceId
  );
  const label = choice?.label || "change";

  setTimelineUpdating(true, label);

  try {
    const state = await lazy.GenTab.applyTimelineChoice(id, choiceId);
    gHeaderState = state;
    renderHeader(state);
    renderTimeline(state);
  } catch (error) {
    console.error(error);
    setTimelineUpdating(false);
    const progressEl = document.getElementById("gentab-timeline-progress");
    if (progressEl) {
      progressEl.textContent =
        error?.message || "Could not update the list. Try again.";
      progressEl.hidden = false;
    }
    return;
  }

  setTimelineUpdating(false);
}

async function renderGenTab() {
  gGenerationId = getGenerationId();
  if (!gGenerationId) {
    showStatus("Missing GenTab id.");
    return;
  }

  showStatus("Creating checklist from page content…");

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

  if (!state.timeline?.steps?.length) {
    showStatus("GenTab list was empty.");
    return;
  }

  document.title = state.title || "GenTab";
  hideStatus();
  const main = document.getElementById("gentab-main");
  if (main) {
    main.hidden = false;
  }
  renderHeader(state);
  renderTimeline(state);
  bindTimelineChecks();
  bindTimelineChoices();
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
