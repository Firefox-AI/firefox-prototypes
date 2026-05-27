/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {
  getNextMonitorRunDate,
  normalizeMonitorSchedule,
  parseMonitorSchedule,
  scheduleToHumanLabel,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/MonitorAgent.sys.mjs"
);

add_task(function test_parse_interval_schedules() {
  Assert.deepEqual(parseMonitorSchedule("every 30 min"), {
    type: "interval",
    intervalMs: 30 * 60 * 1000,
    description: "every 30 minutes",
  });
  Assert.deepEqual(parseMonitorSchedule("every 2 hours"), {
    type: "interval",
    intervalMs: 2 * 60 * 60 * 1000,
    description: "every 2 hours",
  });
  Assert.deepEqual(parseMonitorSchedule("each 3 days"), {
    type: "interval",
    intervalMs: 3 * 24 * 60 * 60 * 1000,
    description: "every 3 days",
  });
});

add_task(function test_parse_calendar_schedules() {
  Assert.deepEqual(parseMonitorSchedule("daily at noon"), {
    type: "daily",
    hour: 12,
    minute: 0,
    description: "daily at 12:00 PM",
  });
  Assert.deepEqual(parseMonitorSchedule("daily"), {
    type: "daily",
    hour: 9,
    minute: 0,
    description: "daily at 9:00 AM",
  });
  Assert.deepEqual(parseMonitorSchedule("every Monday at 9am"), {
    type: "weekly",
    day: 1,
    hour: 9,
    minute: 0,
    description: "weekly Monday at 9:00 AM",
  });
  Assert.deepEqual(parseMonitorSchedule("Fridays 17:30"), {
    type: "weekly",
    day: 5,
    hour: 17,
    minute: 30,
    description: "weekly Friday at 5:30 PM",
  });
});

add_task(function test_reject_invalid_schedules() {
  Assert.equal(parseMonitorSchedule(""), null);
  Assert.equal(parseMonitorSchedule("every 0 minutes"), null);
  Assert.equal(parseMonitorSchedule("daily at 25:00"), null);
  Assert.equal(parseMonitorSchedule("weekly at 9am"), null);
});

add_task(function test_normalize_schedule_labels() {
  Assert.equal(
    scheduleToHumanLabel({ type: "interval", intervalMs: 60 * 60 * 1000 }),
    "every 1 hour"
  );
  Assert.equal(
    scheduleToHumanLabel({
      type: "weekly",
      day: 2,
      hour: 13,
      minute: 45,
    }),
    "weekly Tuesday at 1:45 PM"
  );
  Assert.throws(
    () => normalizeMonitorSchedule({ type: "interval", intervalMs: 30 * 1000 }),
    /Monitor interval must be at least one minute\./
  );
});

add_task(function test_next_run_dates() {
  const morning = new Date("2026-06-02T08:00:00");
  const late = new Date("2026-06-02T10:00:00");
  const daily = { type: "daily", hour: 9, minute: 0 };

  Assert.equal(
    getNextMonitorRunDate(daily, morning).toISOString(),
    new Date("2026-06-02T09:00:00").toISOString()
  );
  Assert.equal(
    getNextMonitorRunDate(daily, late).toISOString(),
    new Date("2026-06-03T09:00:00").toISOString()
  );
});
