/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {
  DEFAULT_MONITOR_EXTRACTOR,
  MONITOR_AGENTS_CHANGED_TOPIC,
  MonitorAgent,
  scheduleToHumanLabel,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/MonitorAgent.sys.mjs"
);

const EXTRACTORS = [
  {
    value: "native",
    id: "monitor-agents-extractor-native",
    fallback: "Native browser extractor",
  },
  {
    value: "tabstack",
    id: "monitor-agents-extractor-tabstack",
    fallback: "Tabstack",
  },
  {
    value: "dom",
    id: "monitor-agents-extractor-dom",
    fallback: "Full rendered DOM",
  },
];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const WEEKDAYS = [
  { id: "monitor-agents-weekday-sunday", fallback: "Sunday" },
  { id: "monitor-agents-weekday-monday", fallback: "Monday" },
  { id: "monitor-agents-weekday-tuesday", fallback: "Tuesday" },
  { id: "monitor-agents-weekday-wednesday", fallback: "Wednesday" },
  { id: "monitor-agents-weekday-thursday", fallback: "Thursday" },
  { id: "monitor-agents-weekday-friday", fallback: "Friday" },
  { id: "monitor-agents-weekday-saturday", fallback: "Saturday" },
];

const CADENCES = [
  {
    value: "interval",
    id: "monitor-agents-cadence-interval",
    fallback: "Custom interval",
  },
  { value: "daily", id: "monitor-agents-cadence-daily", fallback: "Daily" },
  { value: "weekly", id: "monitor-agents-cadence-weekly", fallback: "Weekly" },
];

const INTERVAL_UNITS = [
  {
    value: "minute",
    id: "monitor-agents-interval-unit-minutes",
    fallback: "Minutes",
    intervalMs: MINUTE_MS,
  },
  {
    value: "hour",
    id: "monitor-agents-interval-unit-hours",
    fallback: "Hours",
    intervalMs: HOUR_MS,
  },
  {
    value: "day",
    id: "monitor-agents-interval-unit-days",
    fallback: "Days",
    intervalMs: DAY_MS,
  },
  {
    value: "week",
    id: "monitor-agents-interval-unit-weeks",
    fallback: "Weeks",
    intervalMs: WEEK_MS,
  },
];

const $ = selector => document.querySelector(selector);

// Monitor to scroll to and highlight, from a ?monitorId= deep link. Kept in a
// module variable so it survives the re-renders triggered by monitor changes.
let gHighlightMonitorId = null;

const observer = {
  observe() {
    renderMonitorList();
  },
};

function init() {
  MonitorAgent.init();
  Services.obs.addObserver(observer, MONITOR_AGENTS_CHANGED_TOPIC);
  window.addEventListener(
    "unload",
    () => Services.obs.removeObserver(observer, MONITOR_AGENTS_CHANGED_TOPIC),
    { once: true }
  );

  setupScheduleFields($("#new-monitor-schedule"));
  fillNewMonitorFromParams();
  gHighlightMonitorId =
    new URLSearchParams(location.search).get("monitorId") || null;
  $("#new-monitor-form").addEventListener("submit", onCreateMonitor);
  renderMonitorList();
}

function fillNewMonitorFromParams() {
  const params = new URLSearchParams(location.search);
  $("#new-monitor-prompt").value = params.get("prompt") ?? "";
  $("#new-monitor-url").value = params.get("pageUrl") ?? "";
  $("#new-monitor-title").value = params.get("pageTitle") ?? "";
}

function onCreateMonitor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  MonitorAgent.createMonitor({
    prompt: $("#new-monitor-prompt").value,
    pageUrl: $("#new-monitor-url").value,
    pageTitle: $("#new-monitor-title").value,
    extractor: $("#new-monitor-extractor").value,
    schedule: readSchedule(form),
  });
  form.reset();
  setupScheduleFields($("#new-monitor-schedule"));
}

function renderMonitorList() {
  const monitors = MonitorAgent.listMonitors();
  const list = $("#monitor-list");
  list.replaceChildren();

  if (!monitors.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    document.l10n.setAttributes(empty, "monitor-agents-empty-state");
    list.append(empty);
    return;
  }

  list.className = "monitor-list";
  for (const monitor of monitors) {
    list.append(renderMonitorCard(monitor));
  }

  highlightTargetMonitor();
}

function highlightTargetMonitor() {
  if (!gHighlightMonitorId) {
    return;
  }
  for (const card of document.querySelectorAll(".monitor-card")) {
    if (card.dataset.monitorId === gHighlightMonitorId) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("monitor-card-highlight");
    } else {
      card.classList.remove("monitor-card-highlight");
    }
  }
}

function renderMonitorCard(monitor) {
  const card = document.createElement("article");
  card.className = "monitor-card";
  card.dataset.monitorId = monitor.id;

  const header = document.createElement("div");
  header.className = "monitor-card-header";

  const headerText = document.createElement("div");
  const title = document.createElement("h3");
  title.className = "monitor-title";
  if (monitor.pageTitle) {
    title.textContent = monitor.pageTitle;
  } else {
    document.l10n.setAttributes(title, "monitor-agents-untitled-page");
  }
  const url = document.createElement("p");
  url.className = "monitor-url";
  url.textContent = monitor.pageUrl;
  const meta = document.createElement("p");
  meta.className = "monitor-meta";
  const scheduleLabel = scheduleToHumanLabel(monitor.schedule);
  if (monitor.nextRunAt) {
    document.l10n.setAttributes(meta, "monitor-agents-next-check", {
      schedule: scheduleLabel,
      nextCheck: formatDate(monitor.nextRunAt),
    });
  } else {
    document.l10n.setAttributes(
      meta,
      "monitor-agents-next-check-not-scheduled",
      {
        schedule: scheduleLabel,
      }
    );
  }
  headerText.append(title, url, meta);

  const enabledLabel = document.createElement("label");
  enabledLabel.className = "field-group";
  const enabledText = document.createElement("span");
  document.l10n.setAttributes(enabledText, "monitor-agents-enabled-label");
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = monitor.enabled;
  enabledLabel.append(enabledText, enabled);

  header.append(headerText, enabledLabel);

  const fields = document.createElement("div");
  fields.className = "monitor-fields";

  const promptField = labeledTextarea(
    "monitor-agents-prompt-label",
    monitor.prompt
  );
  promptField.textarea.dataset.field = "prompt";
  const pageUrl = labeledInput(
    "monitor-agents-url-label",
    "url",
    monitor.pageUrl
  );
  pageUrl.input.dataset.field = "pageUrl";
  const pageTitle = labeledInput(
    "monitor-agents-title-label",
    "text",
    monitor.pageTitle ?? ""
  );
  pageTitle.input.dataset.field = "pageTitle";

  const extractor = labeledExtractorSelect(
    monitor.extractor ?? DEFAULT_MONITOR_EXTRACTOR
  );
  extractor.select.dataset.field = "extractor";

  const schedule = document.createElement("div");
  schedule.className = "schedule-fields";
  schedule.dataset.scheduleFields = "";
  setupScheduleFields(schedule, monitor.schedule);

  fields.append(
    promptField.label,
    pageUrl.label,
    pageTitle.label,
    extractor.label,
    schedule
  );

  const actions = document.createElement("div");
  actions.className = "monitor-actions";
  actions.append(
    actionButton("monitor-agents-save-button", () =>
      MonitorAgent.updateMonitor(monitor.id, {
        prompt: promptField.textarea.value,
        pageUrl: pageUrl.input.value,
        pageTitle: pageTitle.input.value,
        extractor: extractor.select.value,
        enabled: enabled.checked,
        schedule: readSchedule(card),
      })
    ),
    actionButton("monitor-agents-run-now-button", async button => {
      button.disabled = true;
      await MonitorAgent.runNow(monitor.id);
      button.disabled = false;
    }),
    actionButton(
      "monitor-agents-delete-button",
      () => MonitorAgent.deleteMonitor(monitor.id),
      {
        destructive: true,
      }
    )
  );

  card.append(header, fields, actions, renderHistory(monitor));
  return card;
}

function setupScheduleFields(container, schedule = null) {
  container.replaceChildren();

  const cadence = fieldGroup("monitor-agents-interval-label");
  const cadenceSelect = document.createElement("select");
  cadenceSelect.dataset.scheduleField = "cadence";
  for (const { value, id, fallback } of CADENCES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = fallback;
    document.l10n.setAttributes(option, id);
    cadenceSelect.append(option);
  }
  cadence.append(cadenceSelect);

  const intervalValue = fieldGroup("monitor-agents-interval-every-label");
  intervalValue.classList.add("schedule-interval");
  const intervalInput = document.createElement("input");
  intervalInput.type = "number";
  intervalInput.min = "1";
  intervalInput.step = "1";
  intervalInput.required = true;
  intervalInput.dataset.scheduleField = "intervalValue";
  intervalInput.value = "15";
  intervalValue.append(intervalInput);

  const intervalUnit = fieldGroup("monitor-agents-interval-unit-label");
  intervalUnit.classList.add("schedule-interval");
  const intervalUnitSelect = document.createElement("select");
  intervalUnitSelect.required = true;
  intervalUnitSelect.dataset.scheduleField = "intervalUnit";
  for (const { value, id, fallback } of INTERVAL_UNITS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = fallback;
    document.l10n.setAttributes(option, id);
    intervalUnitSelect.append(option);
  }
  intervalUnit.append(intervalUnitSelect);

  const time = fieldGroup("monitor-agents-time-label");
  time.classList.add("schedule-time");
  const timeInput = document.createElement("input");
  timeInput.type = "time";
  timeInput.required = true;
  timeInput.dataset.scheduleField = "time";
  timeInput.value = "09:00";
  time.append(timeInput);

  const day = fieldGroup("monitor-agents-day-label");
  day.classList.add("schedule-day");
  const daySelect = document.createElement("select");
  daySelect.required = true;
  daySelect.dataset.scheduleField = "day";
  WEEKDAYS.forEach(({ id, fallback }, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = fallback;
    document.l10n.setAttributes(option, id);
    daySelect.append(option);
  });
  day.append(daySelect);

  container.append(cadence, intervalValue, intervalUnit, time, day);

  applySchedule(container, schedule);
  cadenceSelect.addEventListener("change", () =>
    updateScheduleVisibility(container)
  );
  updateScheduleVisibility(container);
}

function applySchedule(container, schedule) {
  if (!schedule) {
    return;
  }

  const cadence = container.querySelector('[data-schedule-field="cadence"]');
  const intervalValue = container.querySelector(
    '[data-schedule-field="intervalValue"]'
  );
  const intervalUnit = container.querySelector(
    '[data-schedule-field="intervalUnit"]'
  );
  const time = container.querySelector('[data-schedule-field="time"]');
  const day = container.querySelector('[data-schedule-field="day"]');

  if (schedule.type === "interval") {
    cadence.value = "interval";
    const interval = splitInterval(schedule.intervalMs);
    intervalValue.value = String(interval.value);
    intervalUnit.value = interval.unit;
  } else if (schedule.type === "daily") {
    cadence.value = "daily";
    time.value = clockValue(schedule);
  } else if (schedule.type === "weekly") {
    cadence.value = "weekly";
    time.value = clockValue(schedule);
    day.value = String(schedule.day ?? 1);
  }
}

function readSchedule(root) {
  const cadence = root.querySelector('[data-schedule-field="cadence"]').value;

  if (cadence === "interval") {
    const intervalValue = root.querySelector(
      '[data-schedule-field="intervalValue"]'
    ).value;
    const intervalUnit = root.querySelector(
      '[data-schedule-field="intervalUnit"]'
    ).value;
    return {
      type: "interval",
      intervalMs:
        readPositiveInteger(intervalValue) * intervalUnitMs(intervalUnit),
    };
  }

  const time = root.querySelector('[data-schedule-field="time"]').value;
  const { hour, minute } = parseTimeValue(time);
  if (cadence === "daily") {
    return { type: "daily", hour, minute };
  }
  return {
    type: "weekly",
    day: Number(root.querySelector('[data-schedule-field="day"]').value),
    hour,
    minute,
  };
}

function updateScheduleVisibility(container) {
  const cadence = container.querySelector(
    '[data-schedule-field="cadence"]'
  ).value;
  const showInterval = cadence === "interval";
  const showTime = ["daily", "weekly"].includes(cadence);
  const showDay = cadence === "weekly";

  for (const field of container.querySelectorAll(".schedule-interval")) {
    setFieldHidden(field, !showInterval);
  }
  setFieldHidden(container.querySelector(".schedule-time"), !showTime);
  setFieldHidden(container.querySelector(".schedule-day"), !showDay);
}

function renderHistory(monitor) {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  document.l10n.setAttributes(summary, "monitor-agents-history-summary", {
    count: monitor.history?.length ?? 0,
  });
  details.append(summary);

  const historyList = document.createElement("ol");
  historyList.className = "history-list";
  for (const entry of monitor.history ?? []) {
    const item = document.createElement("li");
    item.className = "history-entry";
    item.dataset.status = entry.status;
    const time = document.createElement("time");
    time.dateTime = entry.checkedAt;
    time.textContent = formatDate(entry.checkedAt);
    const result = document.createElement("p");
    result.textContent = entry.result;
    item.append(time, result);
    historyList.append(item);
  }
  details.append(historyList);
  return details;
}

function labeledTextarea(labelId, value) {
  const label = document.createElement("label");
  const text = document.createElement("span");
  document.l10n.setAttributes(text, labelId);
  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.value = value;
  label.append(text, textarea);
  return { label, textarea };
}

function labeledInput(labelId, type, value) {
  const label = document.createElement("label");
  const text = document.createElement("span");
  document.l10n.setAttributes(text, labelId);
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  label.append(text, input);
  return { label, input };
}

function labeledExtractorSelect(value) {
  const label = document.createElement("label");
  const text = document.createElement("span");
  document.l10n.setAttributes(text, "monitor-agents-extractor-label");
  const select = document.createElement("select");
  for (const { value: optionValue, id, fallback } of EXTRACTORS) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = fallback;
    document.l10n.setAttributes(option, id);
    select.append(option);
  }
  select.value = value;
  label.append(text, select);
  return { label, select };
}

function fieldGroup(labelId) {
  const label = document.createElement("label");
  label.className = "field-group";
  const text = document.createElement("span");
  document.l10n.setAttributes(text, labelId);
  label.append(text);
  return label;
}

function actionButton(labelId, callback, { destructive = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  document.l10n.setAttributes(button, labelId);
  if (destructive) {
    button.className = "ghost-button";
  }
  button.addEventListener("click", () => callback(button));
  return button;
}

function clockValue(schedule) {
  return `${String(schedule.hour).padStart(2, "0")}:${String(
    schedule.minute
  ).padStart(2, "0")}`;
}

function readPositiveInteger(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

function intervalUnitMs(unit) {
  return (
    INTERVAL_UNITS.find(intervalUnit => intervalUnit.value === unit)
      ?.intervalMs ?? MINUTE_MS
  );
}

function splitInterval(intervalMs) {
  for (const { value: unit, intervalMs: unitMs } of [
    ...INTERVAL_UNITS,
  ].reverse()) {
    if (intervalMs % unitMs === 0) {
      return { value: intervalMs / unitMs, unit };
    }
  }
  return {
    value: Math.max(1, Math.round(intervalMs / MINUTE_MS)),
    unit: "minute",
  };
}

function parseTimeValue(value) {
  const [hour = 9, minute = 0] = String(value || "09:00")
    .split(":")
    .map(Number);
  return { hour, minute };
}

function setFieldHidden(field, hidden) {
  field.hidden = hidden;
  for (const control of field.querySelectorAll("input, select")) {
    control.disabled = hidden;
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
