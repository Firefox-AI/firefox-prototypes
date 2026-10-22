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
 * `handler` is what the button does. It can be omitted. A missing or unknown
 * handler is accepted and does nothing, so a model can offer a control before
 * it has a behavior.
 */

// Listed under Create new task. The page the user is on comes first, then
// making a smart page, then anything that happens later.
export const PANEL_ACTIONS = [
  {
    id: "summarize-page",
    kind: "immediate",
    handler: "summarize-page",
    menuL10nId: "smartwindow-monitor-panel-summarize",
  },
  {
    id: "find-in-page",
    kind: "form",
    handler: "find-in-page",
    menuL10nId: "smartwindow-monitor-panel-find",
    titleL10nId: "smartwindow-monitor-panel-find-title",
    submitL10nId: "smartwindow-monitor-panel-find-button",
    blocks: [
      {
        type: "text",
        id: "query",
        l10nId: "smartwindow-monitor-panel-find-query",
        l10nAttrs: "label,placeholder",
        errorL10nId: "smartwindow-monitor-panel-find-error",
        required: true,
      },
    ],
  },
  {
    id: "bookmark-page",
    kind: "form",
    handler: "bookmark-page",
    menuL10nId: "smartwindow-monitor-panel-bookmark",
    titleL10nId: "smartwindow-monitor-panel-bookmark-title",
    submitL10nId: "smartwindow-monitor-panel-bookmark-button",
    blocks: [
      {
        type: "text",
        id: "name",
        l10nId: "smartwindow-monitor-panel-bookmark-name",
        l10nAttrs: "label,placeholder",
      },
    ],
  },
  {
    id: "reader-view",
    kind: "immediate",
    handler: "reader-view",
    menuL10nId: "smartwindow-monitor-panel-reader",
  },
  {
    id: "zoom-in",
    kind: "immediate",
    handler: "zoom-in",
    menuL10nId: "smartwindow-monitor-panel-zoom-in",
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
    id: "compare-pages",
    kind: "form",
    handler: "compare-pages",
    menuL10nId: "smartwindow-monitor-panel-compare",
    titleL10nId: "smartwindow-monitor-panel-compare-title",
    submitL10nId: "smartwindow-monitor-panel-create-smart-page-title",
    blocks: [
      {
        type: "longtext",
        id: "focus",
        l10nId: "smartwindow-monitor-panel-compare-focus",
      },
      {
        type: "pages",
        id: "pages",
        l10nId: "ai-tasks-alert-pages",
        required: true,
      },
    ],
  },
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
    id: "price-watch",
    kind: "form",
    handler: "create-monitor",
    menuL10nId: "smartwindow-monitor-panel-price",
    titleL10nId: "smartwindow-monitor-panel-price-title",
    submitL10nId: "smartwindow-monitor-panel-price-button",
    requiresMonitorSlot: true,
    blocks: [
      {
        type: "text",
        id: "prompt",
        l10nId: "smartwindow-monitor-panel-price-query",
        l10nAttrs: "label,placeholder",
        errorL10nId: "smartwindow-monitor-panel-price-error",
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
    id: "remind-me",
    kind: "form",
    handler: "notify-at",
    menuL10nId: "smartwindow-monitor-panel-remind",
    titleL10nId: "smartwindow-monitor-panel-remind-title",
    submitL10nId: "smartwindow-monitor-panel-remind-button",
    blocks: [{ type: "time", id: "time" }],
  },
  {
    id: "note-reminder",
    kind: "form",
    handler: "notify-at",
    menuL10nId: "smartwindow-monitor-panel-note",
    titleL10nId: "smartwindow-monitor-panel-note-title",
    submitL10nId: "smartwindow-monitor-panel-remind-button",
    blocks: [
      {
        type: "longtext",
        id: "note",
        l10nId: "smartwindow-monitor-panel-note-body",
        errorL10nId: "smartwindow-monitor-panel-note-error",
        required: true,
      },
      { type: "time", id: "time" },
    ],
  },
  {
    id: "research",
    kind: "form",
    menuL10nId: "smartwindow-monitor-panel-research",
    titleL10nId: "smartwindow-monitor-panel-research-title",
    submitL10nId: "smartwindow-monitor-panel-done",
    blocks: [
      {
        type: "longtext",
        id: "brief",
        l10nId: "smartwindow-monitor-panel-research-brief",
        errorL10nId: "smartwindow-monitor-panel-research-error",
        required: true,
      },
      {
        type: "pages",
        id: "pages",
        l10nId: "ai-tasks-alert-pages",
        required: true,
      },
      { type: "frequency", id: "frequency" },
    ],
  },
];
