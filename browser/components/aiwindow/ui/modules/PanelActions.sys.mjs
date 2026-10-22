/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Extra entries under "Create new task" in the Tasks panel.
 *
 * Each entry is plain data, which is the shape a later model can return for
 * the page the user is on. `kind: "immediate"` runs `handler` and closes the
 * panel. `kind: "form"` opens a panel built from `blocks`, in that order.
 *
 * Block types are `text`, `longtext`, `pages`, `frequency`, and `time`.
 * Copy is the model's `label` (and `menuLabel`, `title`, `submitLabel`) when
 * it supplied one, and a Fluent id otherwise.
 *
 * `handler` is what the button does. `create-smart-page`, `open-smart-page`,
 * and `notify-at` are wired. Anything else is accepted and does nothing, so a
 * model can offer a control before it has a behavior.
 */

export const PANEL_ACTIONS = [
  {
    id: "news-page",
    kind: "form",
    handler: "create-smart-page",
    menuL10nId: "smartwindow-monitor-panel-news",
    titleL10nId: "smartwindow-monitor-panel-create-smart-page-title",
    submitL10nId: "smartwindow-monitor-panel-create-smart-page-title",
    requiresMonitorSlot: true,
    blocks: [
      {
        type: "text",
        id: "name",
        l10nId: "ai-tasks-alert-name",
        required: true,
      },
      {
        type: "longtext",
        id: "focus",
        l10nId: "smartwindow-monitor-panel-news-focus",
        required: true,
      },
      {
        type: "pages",
        id: "pages",
        l10nId: "ai-tasks-alert-pages",
        required: true,
      },
      { type: "frequency", id: "frequency" },
      { type: "time", id: "time" },
    ],
  },
  {
    id: "custom-page",
    kind: "form",
    handler: "open-smart-page",
    menuL10nId: "smartwindow-monitor-panel-custom",
    titleL10nId: "smartwindow-monitor-panel-custom-title",
    submitL10nId: "smartwindow-monitor-panel-create-smart-page-title",
    blocks: [
      {
        type: "text",
        id: "focus",
        l10nId: "smartwindow-monitor-panel-custom-focus",
        l10nAttrs: "label,placeholder",
        errorL10nId: "smartwindow-monitor-panel-custom-focus-error",
        required: true,
      },
    ],
  },
  {
    id: "remind-me",
    kind: "form",
    handler: "notify-at",
    menuL10nId: "smartwindow-monitor-panel-remind",
    titleL10nId: "smartwindow-monitor-panel-remind-title",
    submitL10nId: "smartwindow-monitor-panel-remind-button",
    blocks: [{ type: "time", id: "time" }],
  },
  {
    id: "zoom-in",
    kind: "immediate",
    handler: "zoom-in",
    menuL10nId: "smartwindow-monitor-panel-zoom-in",
  },
];
