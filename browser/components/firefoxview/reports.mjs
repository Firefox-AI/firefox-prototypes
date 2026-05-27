/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, when } from "chrome://global/content/vendor/lit.all.mjs";
import { ViewPage } from "./viewpage.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-button.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  ResearchAgent:
    "moz-src:///browser/components/aiwindow/models/ResearchAgent.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", function () {
  return console.createInstance({
    prefix: "ResearchReports",
    maxLogLevelPref: "browser.smartwindow.researchReports.loglevel",
  });
});

const IN_PROGRESS_STATUS = "In progress";
const STATUS_L10N_IDS = new Map([
  ["In progress", "firefoxview-report-status-in-progress"],
  ["Complete", "firefoxview-report-status-complete"],
  ["Failed", "firefoxview-report-status-failed"],
  ["Cancelled", "firefoxview-report-status-cancelled"],
]);

/**
 * Firefox View page for Smart Window research reports.
 */
class ReportsInView extends ViewPage {
  static properties = {
    exportingReportId: { state: true },
    isLoading: { type: Boolean, state: true },
    reports: { state: true },
  };

  constructor() {
    super();
    this.exportingReportId = "";
    this.isLoading = true;
    this.reports = [];
  }

  viewVisibleCallback() {
    this.#refreshReports();
  }

  async #refreshReports() {
    this.isLoading = true;
    try {
      this.reports = await lazy.ResearchAgent.getReports();
    } catch (error) {
      lazy.log.error("Could not load research reports.", error);
      this.reports = [];
    } finally {
      this.isLoading = false;
    }
  }

  async #deleteReport(event) {
    event.preventDefault();
    event.stopPropagation();
    const { reportId } = event.currentTarget.dataset;
    if (!reportId) {
      return;
    }

    try {
      await lazy.ResearchAgent.deleteReport(reportId);
    } catch (error) {
      lazy.log.error("Could not delete research report.", error);
    }
    await this.#refreshReports();
  }

  async #cancelReport(event) {
    event.preventDefault();
    event.stopPropagation();
    const { reportId } = event.currentTarget.dataset;
    if (!reportId) {
      return;
    }

    try {
      await lazy.ResearchAgent.cancelReport(reportId);
    } catch (error) {
      lazy.log.error("Could not cancel research report.", error);
    }
    await this.#refreshReports();
  }

  async #exportReportToPdf(event) {
    event.preventDefault();
    event.stopPropagation();
    const { reportId } = event.currentTarget.dataset;
    if (!reportId || this.exportingReportId) {
      return;
    }

    this.exportingReportId = reportId;
    try {
      const exportedReport =
        await lazy.ResearchAgent.exportReportToPdf(reportId);
      lazy.log.info("Exported research report PDF.", exportedReport.path);
    } catch (error) {
      lazy.log.error("Could not export research report PDF.", error);
    } finally {
      this.exportingReportId = "";
    }
  }

  #openReport(event) {
    event.preventDefault();
    event.stopPropagation();

    const url = event.currentTarget.href;
    if (!url) {
      return;
    }

    let where = lazy.BrowserUtils.whereToOpenLink(event, false, true);
    if (where === "current") {
      where = "tab";
    }

    this.getWindow().openTrustedLinkIn(url, where);
  }

  #formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  #statusTemplate(reportStatus) {
    const l10nId = STATUS_L10N_IDS.get(reportStatus);
    if (l10nId) {
      return html`<span
        class="research-report-status"
        data-l10n-id=${l10nId}
      ></span>`;
    }
    return html`<span class="research-report-status">${reportStatus}</span>`;
  }

  #maybeText(value, fallbackL10nId) {
    return value || html`<span data-l10n-id=${fallbackL10nId}></span>`;
  }

  #reportTemplate(report) {
    const timestamp = report.updatedAt || report.createdAt;
    const formattedDate = this.#formatDate(timestamp);

    return html`
      <li>
        <details class="research-report-item">
          <summary>
            <span class="research-report-summary">
              <span class="research-report-title">${report.title}</span>
              <span class="research-report-meta">
                ${this.#statusTemplate(report.status)}
                ${when(
                  formattedDate,
                  () =>
                    html`<time datetime=${timestamp}>${formattedDate}</time>`
                )}
              </span>
            </span>
          </summary>
          <div class="research-report-body">
            <dl>
              <dt data-l10n-id="firefoxview-report-query-label"></dt>
              <dd>
                ${this.#maybeText(
                  report.question,
                  "firefoxview-report-query-missing"
                )}
              </dd>
              <dt data-l10n-id="firefoxview-report-description-label"></dt>
              <dd>
                ${this.#maybeText(
                  report.description,
                  "firefoxview-report-description-missing"
                )}
              </dd>
            </dl>
            <div class="research-report-actions">
              <a
                class="research-report-link"
                href=${report.fileUri}
                target="_blank"
                rel="noopener"
                data-l10n-id="firefoxview-report-open"
                @click=${event => this.#openReport(event)}
              ></a>
              <moz-button
                type="ghost"
                data-report-id=${report.id}
                data-l10n-id="firefoxview-report-export-pdf"
                data-l10n-attrs="label"
                ?disabled=${!!this.exportingReportId}
                @click=${event => this.#exportReportToPdf(event)}
              ></moz-button>
              ${when(
                report.status === IN_PROGRESS_STATUS,
                () =>
                  html`<moz-button
                    type="ghost"
                    data-report-id=${report.id}
                    data-l10n-id="firefoxview-report-cancel"
                    data-l10n-attrs="label"
                    @click=${event => this.#cancelReport(event)}
                  ></moz-button>`
              )}
              <moz-button
                type="ghost"
                data-report-id=${report.id}
                data-l10n-id="firefoxview-report-delete"
                data-l10n-attrs="label"
                @click=${event => this.#deleteReport(event)}
              ></moz-button>
            </div>
          </div>
        </details>
      </li>
    `;
  }

  #cardsTemplate() {
    if (this.isLoading && !this.reports.length) {
      return html`<card-container toggleDisabled>
        <h3 slot="header" data-l10n-id="firefoxview-reports-loading"></h3>
      </card-container>`;
    }

    if (!this.reports.length) {
      return html`
        <fxview-empty-state
          headerLabel="firefoxview-reports-empty-header"
          .descriptionLabels=${["firefoxview-reports-empty-description"]}
          class="empty-state reports"
          ?isSelectedTab=${this.selectedTab}
          mainImageUrl="chrome://browser/content/firefoxview/history-empty.svg"
        >
        </fxview-empty-state>
      `;
    }

    return html`<card-container toggleDisabled>
      <h3 slot="header" data-l10n-id="firefoxview-reports-list-header"></h3>
      <ul slot="main" class="research-reports-list">
        ${this.reports.map(report => this.#reportTemplate(report))}
      </ul>
    </card-container>`;
  }

  render() {
    if (!this.selectedTab) {
      return null;
    }

    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/firefoxview/firefoxview.css"
      />
      <link
        rel="stylesheet"
        href="chrome://browser/content/firefoxview/reports.css"
      />
      <div class="sticky-container bottom-fade">
        <h2 class="page-header" data-l10n-id="firefoxview-reports-header"></h2>
      </div>
      <div class="cards-container">${this.#cardsTemplate()}</div>
    `;
  }
}
customElements.define("view-reports", ReportsInView);
