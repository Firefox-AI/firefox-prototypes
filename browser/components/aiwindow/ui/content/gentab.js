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
  const header = document.getElementById("gentab-page-header");
  if (!header) {
    return;
  }

  const emoji = (state.emoji || "✨").trim();
  const title = state.title || "GenTab";
  const blurb = (state.headerBlurb || state.summary || "").trim();
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const tabCount = tabs.length;

  const metaParts = [];
  if (tabCount > 0) {
    metaParts.push(`From ${tabCount} tab${tabCount === 1 ? "" : "s"}`);
  }
  if (state.intent) {
    metaParts.push(state.intent);
  }

  // emoji + title in page-header heading (iconSrc expects an image URL).
  header.heading = emoji ? `${emoji} ${title}` : title;
  header.headingLevel = 1;

  const descriptionParts = [];
  if (blurb) {
    descriptionParts.push(blurb);
  }
  if (metaParts.length) {
    descriptionParts.push(metaParts.join(" · "));
  }
  header.description = descriptionParts.join(" · ");
}

/**
 * @param {object} state
 */
function renderTimeline(state) {
  const card = document.getElementById("gentab-card");
  const list = document.getElementById("gentab-timeline-list");
  const subtitleEl = document.getElementById("gentab-timeline-subtitle");
  const progressEl = document.getElementById("gentab-timeline-progress");
  if (!card || !list) {
    return;
  }

  const timeline = state.timeline;
  if (!timeline?.steps?.length) {
    card.hidden = true;
    list.replaceChildren();
    return;
  }

  card.heading = timeline.title || "Checklist";
  card.headingLevel = 2;
  if (timeline.subtitle) {
    subtitleEl.textContent = timeline.subtitle;
    subtitleEl.hidden = false;
  } else {
    subtitleEl.textContent = "";
    subtitleEl.hidden = true;
  }

  list.replaceChildren();
  let doneCount = 0;
  let firstOpenIndex = -1;
  timeline.steps.forEach((step, index) => {
    if (step.done) {
      doneCount += 1;
    } else if (firstOpenIndex < 0) {
      firstOpenIndex = index;
    }
    const li = document.createElement("li");
    li.className = "gentab-timeline-item";
    if (step.done) {
      li.classList.add("done");
    } else if (index === firstOpenIndex) {
      li.classList.add("current");
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
    // Evidence note for steps pre-checked from open tabs.
    if (step.done && step.doneReason) {
      const reason = document.createElement("span");
      reason.className = "gentab-timeline-done-reason";
      reason.textContent = step.doneReason;
      body.appendChild(reason);
    }

    label.appendChild(checkbox);
    label.appendChild(num);
    label.appendChild(body);
    li.appendChild(label);

    // Research control outside the checkbox label so it does not toggle done.
    const query = (step.researchQuery || "").trim();
    if (query && !step.done) {
      const research = document.createElement("moz-button");
      research.className = "gentab-timeline-research";
      research.type = "ghost";
      research.size = "small";
      research.iconSrc = "chrome://global/skin/icons/search-glass.svg";
      research.label = query;
      research.title = `Search Google for “${query}”`;
      research.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        lazy.GenTab.openWebSearch(query);
      });
      li.appendChild(research);
    }

    list.appendChild(li);
  });

  const total = timeline.steps.length;
  const next =
    firstOpenIndex >= 0 ? timeline.steps[firstOpenIndex]?.heading : "";
  if (doneCount === total && total > 0) {
    progressEl.textContent = `${doneCount} of ${total} complete`;
  } else if (next) {
    progressEl.textContent = `${doneCount} of ${total} complete · Next: ${next}`;
  } else {
    progressEl.textContent = `${doneCount} of ${total} complete`;
  }
  progressEl.hidden = false;

  renderTimelineChoices(timeline.choices || []);
  card.hidden = false;
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
    const btn = document.createElement("moz-button");
    btn.className = "gentab-timeline-choice";
    btn.type = "ghost";
    btn.size = "small";
    btn.label = choice.label || choice.body || "Change plan";
    btn.title = choice.body || choice.label || "";
    btn.dataset.choiceId = choice.id;
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
      // Header blurb tracks the same done counts as the list.
      renderHeader(state);
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
    const btn = event.target.closest?.("moz-button.gentab-timeline-choice");
    if (!btn || btn.disabled) {
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
  const card = document.getElementById("gentab-card");
  const progressEl = document.getElementById("gentab-timeline-progress");
  const choicesList = document.getElementById("gentab-timeline-choices-list");
  if (card) {
    card.classList.toggle("is-updating", updating);
    card.setAttribute("aria-busy", updating ? "true" : "false");
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
    for (const btn of choicesList.querySelectorAll(
      "moz-button.gentab-timeline-choice"
    )) {
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
    // Drop stashed "Updating…" restore text so progress comes from the new list.
    const progressEl = document.getElementById("gentab-timeline-progress");
    if (progressEl) {
      delete progressEl.dataset.prevText;
    }
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
