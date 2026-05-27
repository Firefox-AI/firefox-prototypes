/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ExaClient } from "moz-src:///browser/components/aiwindow/models/ExaClient.sys.mjs";
import {
  MODEL_FEATURES,
  openAIEngine,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";
import {
  RESEARCH_CLARIFY_QUESTIONS_SYSTEM_PROMPT,
  RESEARCH_CLARIFY_SEARCH_PLAN_SYSTEM_PROMPT,
  RESEARCH_FINAL_SYSTEM_PROMPT,
  RESEARCH_LOOP_SYSTEM_PROMPT,
  RESEARCH_NOTES_SYSTEM_PROMPT,
  RESEARCH_REPORT_METADATA_SYSTEM_PROMPT,
} from "moz-src:///browser/components/aiwindow/models/ResearchPrompts.sys.mjs";
import { ChatStore } from "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs";
import { AssistantRoleOpts } from "moz-src:///browser/components/aiwindow/ui/modules/ChatMessage.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "parseMarkdown", () => {
  const { parseMarkdown } = ChromeUtils.importESModule(
    "chrome://browser/content/aiwindow/modules/ChatMarkdownParser.mjs"
  );
  return parseMarkdown;
});
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "AlertsService",
  "@mozilla.org/alerts-service;1",
  "nsIAlertsService"
);
const AlertNotification = Components.Constructor(
  "@mozilla.org/alert-notification;1",
  "nsIAlertNotification",
  "initWithObject"
);

const PHASE = Object.freeze({
  CLARIFYING: "clarifying",
  WAITING_FOR_CLARIFICATIONS: "waiting_for_clarifications",
  RUNNING: "running",
  COMPLETE: "complete",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const MAX_PRELIMINARY_SEARCHES = 3;
const MAX_RESEARCH_ROUNDS = 5;
const MIN_RESEARCH_ROUNDS = 2;
const SEARCHES_PER_ROUND = 6;
const RESULTS_PER_SEARCH = 8;
const CONTENT_URLS_PER_ROUND = 10;
const MAX_VISITED_URLS = 45;
const MAX_MODEL_CONTEXT_CHARS = 28000;
const MAX_NOTE_CHARS = 5000;
const MODEL_RETRY_DELAYS_MS = [1000, 2500, 5000];
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const REPORTS_DIR_NAME = "smart-window-research";
const REPORTS_INDEX_FILE_NAME = "reports.json";
const REPORTS_LIST_FILE_NAME = "index.html";
const REPORTS_INDEX_VERSION = 1;
const REPORT_LIST_URL = "about:firefoxview#reports";
const MAX_REPORT_TITLE_CHARS = 80;
const MAX_REPORT_DESCRIPTION_CHARS = 220;
const MAX_REPORT_QUESTION_CHARS = 1200;
const PDF_EXPORT_LOAD_TIMEOUT_MS = 30000;

const REPORT_STATUS = Object.freeze({
  IN_PROGRESS: "In progress",
  COMPLETE: "Complete",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
});

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
    }
    return char;
  });
}

function truncate(value = "", maxLength = MAX_NOTE_CHARS) {
  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}

function compactWhitespace(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeReportText(
  value = "",
  maxLength = MAX_REPORT_DESCRIPTION_CHARS
) {
  return truncate(compactWhitespace(value), maxLength);
}

function fallbackReportTitle(question) {
  return (
    normalizeReportText(
      String(question || "").replace(/[?.!\s]+$/g, ""),
      MAX_REPORT_TITLE_CHARS
    ) || "Research report"
  );
}

function fallbackReportDescription(body, status = REPORT_STATUS.IN_PROGRESS) {
  const description = normalizeReportText(body, MAX_REPORT_DESCRIPTION_CHARS);
  if (description) {
    return description;
  }
  if (status === REPORT_STATUS.FAILED || status === PHASE.FAILED) {
    return "Research ended before a complete report was available.";
  }
  if (status === REPORT_STATUS.CANCELLED || status === PHASE.CANCELLED) {
    return "Research was cancelled before it completed.";
  }
  return "Research report in progress.";
}

function getReportPdfFileName(report) {
  const baseName =
    lazy.DownloadPaths.sanitize(
      normalizeReportText(report?.title, MAX_REPORT_TITLE_CHARS) ||
        "Research report"
    ) || "Research report";
  return `${baseName.replace(/\.pdf$/i, "")}.pdf`;
}

async function getUniquePdfPath(dir, fileName) {
  const baseName = fileName.replace(/\.pdf$/i, "");
  let targetPath = PathUtils.join(dir, `${baseName}.pdf`);
  for (let i = 2; await IOUtils.exists(targetPath); i++) {
    targetPath = PathUtils.join(dir, `${baseName} (${i}).pdf`);
  }
  return targetPath;
}

function getReportFilePath(report) {
  if (report?.path) {
    return report.path;
  }

  try {
    return Services.io
      .newURI(report?.fileUri || "")
      .QueryInterface(Ci.nsIFileURL).file.path;
  } catch {
    return "";
  }
}

function expandAppendixDetailsForPrint(html = "") {
  return String(html).replace(
    /<details\b([^>]*\bclass=(["'])[^"']*\blog-entry\b[^"']*\2[^>]*)>/gi,
    (match, attributes) =>
      /\sopen(?:\s|=|$)/i.test(attributes)
        ? match
        : `<details${attributes} open>`
  );
}

export function renderReportMarkdown(value = "") {
  return (
    lazy.parseMarkdown(String(value ?? "")).trim() ||
    "<p>No content recorded.</p>"
  );
}

function unescapeHtml(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlFragmentToMarkdownText(fragment = "") {
  return unescapeHtml(
    String(fragment)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<p[^>]*>/gi, "")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/(?:ul|ol)>/gi, "\n")
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_match, text) =>
        text.replace(/<[^>]+>/g, "")
      )
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function needsMarkdownRepair(fragment = "") {
  const html = String(fragment);
  if (/<(?:h[1-6]|strong|em|blockquote|pre|code|table)\b/i.test(html)) {
    return false;
  }

  const text = htmlFragmentToMarkdownText(html);
  return /(?:^|\n)#{1,6}\s|\*\*[^*\n][\s\S]*?\*\*|__[^_\n][\s\S]*?__|\[[^\]\n]+\]\([^)]+\)|(?:^|\n)>\s/.test(
    text
  );
}

export function repairReportMarkdownHtml(html = "") {
  const source = String(html);
  const match = source.match(
    /(<div class="answer-body"[^>]*>)([\s\S]*?)(<\/div>)/i
  );
  if (!match || !needsMarkdownRepair(match[2])) {
    return source;
  }

  const markdown = htmlFragmentToMarkdownText(match[2]);
  return source.replace(
    match[0],
    `${match[1]}${renderReportMarkdown(markdown)}${match[3]}`
  );
}

function slugify(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "research"
  );
}

function normalizeArray(value) {
  return Array.isArray(value)
    ? value
        .filter(item => typeof item === "string" && item.trim())
        .map(s => s.trim())
    : [];
}

function formatError(error) {
  return error?.message || String(error);
}

function getErrorStatus(error) {
  const explicitStatus = Number(
    error?.status ?? error?.response?.status ?? error?.cause?.status
  );
  if (Number.isInteger(explicitStatus)) {
    return explicitStatus;
  }

  const match = formatError(error).match(
    /\b(408|429|500|502|503|504)\b(?: status code)?/i
  );
  return match ? Number(match[1]) : null;
}

function isTransientResearchError(error) {
  const status = getErrorStatus(error);
  return (
    TRANSIENT_STATUS_CODES.has(status) ||
    /(?:network|timeout|temporar|overload|unavailable)/i.test(
      formatError(error)
    )
  );
}

function wait(ms) {
  return new Promise(resolve => lazy.setTimeout(resolve, ms));
}

async function retryTransient(operation, label) {
  let lastError = null;
  for (let attempt = 0; attempt <= MODEL_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        !isTransientResearchError(error) ||
        attempt === MODEL_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      console.warn(`${label} failed transiently; retrying.`, error);
      await wait(MODEL_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

/**
 * Indicates that an active research session was cancelled by the user.
 */
class ResearchCancelledError extends Error {
  constructor() {
    super("Research was cancelled");
    this.name = "ResearchCancelledError";
  }
}

export function parseResearchJson(text) {
  const trimmed = String(text ?? "").trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return JSON.parse(withoutFence);
  } catch {}

  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Maintains persisted metadata for research reports.
 */
class ResearchReportIndex {
  static get dir() {
    return PathUtils.join(PathUtils.profileDir, REPORTS_DIR_NAME);
  }

  static get indexPath() {
    return PathUtils.join(this.dir, REPORTS_INDEX_FILE_NAME);
  }

  static async getReports() {
    await this.#ensureDir();
    const reports = await this.#readReports();
    return this.#sortReports(await this.#addDiscoveredReports(reports));
  }

  static async getReport(reportId) {
    const id = normalizeReportText(reportId, 120);
    if (!id) {
      return null;
    }
    return (await this.getReports()).find(report => report.id === id) || null;
  }

  static async upsert(report) {
    await this.#ensureDir();
    const normalizedReport = this.#normalizeReport(report);
    if (!normalizedReport) {
      return;
    }

    const reports = (await this.getReports()).filter(
      existing =>
        existing.id !== normalizedReport.id &&
        existing.fileUri !== normalizedReport.fileUri
    );
    reports.push(normalizedReport);
    this.#sortReports(reports);
    await this.#writeReports(reports);
  }

  static async delete(reportId) {
    await this.#ensureDir();
    const reports = await this.getReports();
    const report = reports.find(existing => existing.id === reportId);
    if (!report) {
      return false;
    }

    if (report.path) {
      await IOUtils.remove(report.path, { ignoreAbsent: true }).catch(error => {
        console.warn("Could not delete research report file:", error);
      });
    }
    await this.#writeReports(
      reports.filter(
        existing =>
          existing.id !== reportId && existing.fileUri !== report.fileUri
      )
    );
    return true;
  }

  static async cancel(reportId) {
    await this.#ensureDir();
    const reports = await this.getReports();
    const report = reports.find(existing => existing.id === reportId);
    if (!report || report.status !== REPORT_STATUS.IN_PROGRESS) {
      return false;
    }

    report.status = REPORT_STATUS.CANCELLED;
    report.description =
      report.description ||
      fallbackReportDescription("", REPORT_STATUS.CANCELLED);
    report.updatedAt = new Date().toISOString();
    await this.#writeReports(reports);
    return true;
  }

  static async #ensureDir() {
    await IOUtils.makeDirectory(this.dir, { ignoreExisting: true });
  }

  static async #readReports() {
    try {
      if (!(await IOUtils.exists(this.indexPath))) {
        return [];
      }
      const text = await IOUtils.readUTF8(this.indexPath);
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed?.reports)) {
        return [];
      }
      return parsed.reports
        .map(report => this.#normalizeReport(report))
        .filter(Boolean);
    } catch (error) {
      if (error?.name !== "NotFoundError") {
        console.warn("Could not read research report index:", error);
      }
      return [];
    }
  }

  static async #addDiscoveredReports(reports) {
    const byFileUri = new Map(reports.map(report => [report.fileUri, report]));
    let children;
    try {
      children = await IOUtils.getChildren(this.dir);
    } catch (error) {
      console.warn("Could not scan research report directory:", error);
      return reports;
    }

    for (const path of children) {
      if (
        !path.endsWith(".html") ||
        PathUtils.filename(path) === REPORTS_LIST_FILE_NAME
      ) {
        continue;
      }

      const fileUri = PathUtils.toFileURI(path);
      if (byFileUri.has(fileUri)) {
        continue;
      }

      const discoveredReport = await this.#readDiscoveredReport(path, fileUri);
      if (discoveredReport) {
        byFileUri.set(discoveredReport.fileUri, discoveredReport);
      }
    }

    return Array.from(byFileUri.values());
  }

  static async #readDiscoveredReport(path, fileUri) {
    let html = "";
    try {
      html = await IOUtils.readUTF8(path);
    } catch (error) {
      console.warn("Could not read discovered research report:", error);
    }

    const repairedHtml = repairReportMarkdownHtml(html);
    if (repairedHtml !== html) {
      await IOUtils.writeUTF8(path, repairedHtml, {
        tmpPath: `${path}.tmp`,
      }).catch(error => {
        console.warn("Could not repair research report markdown:", error);
      });
      html = repairedHtml;
    }

    const question = this.#extractHtmlText(
      html,
      /<p class="question"[^>]*>([\s\S]*?)<\/p>/i
    );
    const description = this.#extractHtmlText(
      html,
      /<p class="description"[^>]*>([\s\S]*?)<\/p>/i
    );
    const status = this.#extractHtmlText(
      html,
      /<span class="status"[^>]*>([\s\S]*?)<\/span>/i
    );
    let title = this.#extractHtmlText(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (!title || title === "Research Report") {
      title = fallbackReportTitle(question || PathUtils.filename(path));
    }

    const fileInfo = await IOUtils.stat(path).catch(() => null);
    const timestamp = new Date(
      fileInfo?.lastModified || Date.now()
    ).toISOString();
    return this.#normalizeReport({
      id: fileUri,
      title,
      description: description || "Imported local research report.",
      question,
      fileUri,
      path,
      status: status || "Unknown",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  static #extractHtmlText(html, pattern) {
    const match = String(html).match(pattern);
    if (!match) {
      return "";
    }

    return compactWhitespace(
      match[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    );
  }

  static #normalizeReport(report) {
    if (!report || typeof report !== "object") {
      return null;
    }

    const path = normalizeReportText(report.path, 4096);
    const fileUri =
      normalizeReportText(report.fileUri, 4096) ||
      (path ? PathUtils.toFileURI(path) : "");
    if (!fileUri) {
      return null;
    }

    const question = normalizeReportText(
      report.question,
      MAX_REPORT_QUESTION_CHARS
    );
    const status = normalizeReportText(report.status, 40) || "Unknown";
    const title =
      normalizeReportText(report.title, MAX_REPORT_TITLE_CHARS) ||
      fallbackReportTitle(question);
    const description =
      normalizeReportText(report.description, MAX_REPORT_DESCRIPTION_CHARS) ||
      fallbackReportDescription("", status);

    return {
      id: normalizeReportText(report.id, 120) || fileUri,
      title,
      description,
      question,
      fileUri,
      path,
      status,
      createdAt:
        normalizeReportText(report.createdAt, 80) || new Date().toISOString(),
      updatedAt:
        normalizeReportText(report.updatedAt, 80) || new Date().toISOString(),
    };
  }

  static #sortReports(reports) {
    return reports.sort((a, b) => {
      const aTime = Date.parse(a.createdAt || a.updatedAt || 0) || 0;
      const bTime = Date.parse(b.createdAt || b.updatedAt || 0) || 0;
      return bTime - aTime;
    });
  }

  static async #writeReports(reports) {
    await IOUtils.writeUTF8(
      this.indexPath,
      JSON.stringify(
        {
          version: REPORTS_INDEX_VERSION,
          reports,
        },
        null,
        2
      ),
      {
        tmpPath: `${this.indexPath}.tmp`,
      }
    );
  }
}

/**
 * Writes the live local HTML file for a single research task.
 */
class ResearchReport {
  #id = crypto.randomUUID();
  #path;
  #fileUri;
  #question;
  #title = "";
  #description = "";
  #finalAnswer = "";
  #status = REPORT_STATUS.IN_PROGRESS;
  #sources = [];
  #sections = [];
  #createdAt = new Date().toISOString();
  #updatedAt = this.#createdAt;
  #deleted = false;

  constructor(question) {
    this.#question = question;
  }

  get path() {
    return this.#path;
  }

  get fileUri() {
    return this.#fileUri;
  }

  get id() {
    return this.#id;
  }

  markDeleted() {
    this.#deleted = true;
  }

  async init() {
    const dir = ResearchReportIndex.dir;
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const fileName = `${this.#createdAt.replace(/[:.]/g, "-")}-${slugify(
      this.#question
    )}.html`;
    this.#path = PathUtils.join(dir, fileName);
    this.#fileUri = PathUtils.toFileURI(this.#path);
    await this.#write({ updateIndex: true });
  }

  async addSection(title, body) {
    this.#sections.push({
      type: "section",
      title,
      body,
      createdAt: new Date().toISOString(),
    });
    await this.#write();
  }

  async addSearch(query, results = []) {
    this.#sections.push({
      type: "search",
      title: query,
      results,
      createdAt: new Date().toISOString(),
    });
    await this.#write();
  }

  async addPages(pages = []) {
    if (!pages.length) {
      return;
    }
    this.#sections.push({
      type: "pages",
      title: "Visited pages",
      pages,
      createdAt: new Date().toISOString(),
    });
    await this.#write();
  }

  async setFinalAnswer(body, sources = [], metadata = null) {
    this.#finalAnswer = body;
    this.#status = REPORT_STATUS.COMPLETE;
    this.#sources = sources;
    this.#setMetadata(metadata);
    await this.#write({ updateIndex: true });
  }

  async setFailedSummary(body, sources = [], metadata = null) {
    this.#finalAnswer = body;
    this.#status = REPORT_STATUS.FAILED;
    this.#sources = sources;
    this.#setMetadata(metadata);
    await this.#write({ updateIndex: true });
  }

  async setCancelledSummary(body, sources = [], metadata = null) {
    this.#finalAnswer = body;
    this.#status = REPORT_STATUS.CANCELLED;
    this.#sources = sources;
    this.#setMetadata(metadata);
    await this.#write({ updateIndex: true });
  }

  #setMetadata(metadata = null) {
    if (!metadata) {
      return;
    }

    const title = normalizeReportText(metadata.title, MAX_REPORT_TITLE_CHARS);
    if (title) {
      this.#title = title;
    }

    const description = normalizeReportText(
      metadata.description,
      MAX_REPORT_DESCRIPTION_CHARS
    );
    if (description) {
      this.#description = description;
    }
  }

  #toRecord() {
    return {
      id: this.#id,
      title: this.#title || fallbackReportTitle(this.#question),
      description:
        this.#description ||
        fallbackReportDescription(this.#finalAnswer, this.#status),
      question: normalizeReportText(this.#question, MAX_REPORT_QUESTION_CHARS),
      fileUri: this.#fileUri,
      path: this.#path,
      status: this.#status,
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
    };
  }

  #getSources() {
    const sources = new Set(this.#sources.filter(Boolean));
    for (const section of this.#sections) {
      for (const result of section.results || []) {
        if (result.url) {
          sources.add(result.url);
        }
      }
      for (const page of section.pages || []) {
        if (page.url) {
          sources.add(page.url);
        }
      }
    }
    return Array.from(sources).slice(0, 80);
  }

  #renderSection(section) {
    const sectionTitle = escapeHtml(section.title);
    const time = escapeHtml(section.createdAt);
    if (section.type === "search") {
      const items = section.results
        .map(result => {
          const href = escapeHtml(result.url || "");
          const resultTitle = escapeHtml(
            result.title || result.url || "Untitled"
          );
          const text = escapeHtml(
            truncate(
              result.text ||
                result.summary ||
                result.highlights?.join("\n") ||
                result.snippet ||
                "",
              1200
            )
          );
          return `<li><a href="${href}">${resultTitle}</a><p>${text}</p></li>`;
        })
        .join("\n");
      return `<details class="log-entry"><summary><span>Search: ${sectionTitle}</span><time>${time}</time></summary><ol>${items}</ol></details>`;
    }

    if (section.type === "pages") {
      const pages = section.pages
        .map(page => {
          const href = escapeHtml(page.url || "");
          const pageTitle = escapeHtml(page.title || page.url || "Untitled");
          const text = escapeHtml(
            truncate(page.text || page.summary || "", 1800)
          );
          return `<article><h3><a href="${href}">${pageTitle}</a></h3><pre>${text}</pre></article>`;
        })
        .join("\n");
      return `<details class="log-entry"><summary><span>${sectionTitle}</span><time>${time}</time></summary>${pages}</details>`;
    }

    return `<details class="log-entry"><summary><span>${sectionTitle}</span><time>${time}</time></summary><pre>${escapeHtml(section.body)}</pre></details>`;
  }

  async #write({ updateIndex = false } = {}) {
    if (this.#deleted) {
      return;
    }

    this.#updatedAt = new Date().toISOString();
    const sources = this.#getSources();
    const sourceList = sources
      .map(source => {
        const href = escapeHtml(source);
        return `<li><a href="${href}">${href}</a></li>`;
      })
      .join("\n");
    const hasReportSummary = this.#status !== REPORT_STATUS.IN_PROGRESS;
    let answerHeading = "Research In Progress";
    if (hasReportSummary) {
      if (this.#status === REPORT_STATUS.FAILED) {
        answerHeading = "Partial Report";
      } else if (this.#status === REPORT_STATUS.CANCELLED) {
        answerHeading = "Cancelled Report";
      } else {
        answerHeading = "Final Answer";
      }
    }
    const answerBody = hasReportSummary
      ? renderReportMarkdown(
          this.#finalAnswer ||
            "Research finished without a final model response. The appendix contains the collected notes and sources."
        )
      : "<p>The agent is still collecting sources and writing notes. This report will update as it works.</p>";
    const reportTitle = this.#title || "Research Report";
    const reportDescription = this.#description
      ? `<p class="description">${escapeHtml(this.#description)}</p>`
      : "";
    const reportListUri = escapeHtml(REPORT_LIST_URL);
    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(reportTitle)}</title>
<style>
:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.55;
  background: Canvas;
  color: CanvasText;
}
body { margin: 0; background: Canvas; color: CanvasText; }
main { max-width: 1040px; margin: 0 auto; padding: 40px 28px 56px; }
header { padding-block: 12px 28px; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
h1 { font-size: 34px; line-height: 1.15; margin: 0 0 12px; }
h2 { font-size: 22px; margin: 0 0 14px; }
h3 { font-size: 16px; margin: 16px 0 6px; }
p { margin: 0 0 14px; }
a { color: LinkText; overflow-wrap: anywhere; }
.report-nav { margin-block-end: 22px; }
.report-nav a { font-size: 14px; font-weight: 650; }
.eyebrow { color: GrayText; font-size: 13px; font-weight: 650; letter-spacing: 0; text-transform: uppercase; margin-bottom: 8px; }
.question { color: color-mix(in srgb, CanvasText 72%, transparent); font-size: 17px; max-width: 780px; }
.description { color: color-mix(in srgb, CanvasText 72%, transparent); font-size: 16px; max-width: 780px; }
.status { display: inline-block; margin-top: 14px; padding: 4px 9px; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, transparent); font-size: 13px; color: color-mix(in srgb, CanvasText 75%, transparent); }
.answer, .sources, .appendix { padding-block: 28px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
.answer-body { font-size: 17px; max-width: 840px; }
.answer-body > :first-child { margin-block-start: 0; }
.answer-body h1 { font-size: 26px; line-height: 1.2; margin: 24px 0 12px; }
.answer-body h2 { font-size: 22px; line-height: 1.25; margin: 22px 0 10px; }
.answer-body h3 { font-size: 18px; line-height: 1.3; margin: 18px 0 8px; }
.answer-body h4, .answer-body h5, .answer-body h6 { font-size: 16px; line-height: 1.35; margin: 16px 0 8px; }
.answer-body ul, .answer-body ol { padding-inline-start: 24px; margin: 0 0 14px; }
.answer-body li { margin-block-end: 6px; }
.answer-body li > p { margin-block-end: 6px; }
.answer-body blockquote { border-inline-start: 4px solid color-mix(in srgb, CanvasText 24%, transparent); color: color-mix(in srgb, CanvasText 78%, transparent); margin: 0 0 14px; padding-inline-start: 14px; }
.answer-body code { background: color-mix(in srgb, CanvasText 8%, transparent); border-radius: 4px; font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: .92em; padding: 2px 4px; }
.answer-body pre { overflow-x: auto; white-space: pre; }
.answer-body pre code { background: transparent; border-radius: 0; display: block; padding: 0; }
.answer-body hr { border: 0; border-block-start: 1px solid color-mix(in srgb, CanvasText 16%, transparent); margin: 24px 0; }
.answer-body img { display: block; height: auto; max-width: 100%; }
.answer-body ai-chat-table { display: block; margin: 0 0 14px; max-width: 100%; overflow-x: auto; }
.answer-body table { border-collapse: collapse; font-size: 15px; min-width: 100%; }
.answer-body th, .answer-body td { border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); padding: 8px 10px; text-align: start; vertical-align: top; }
.answer-body th { background: color-mix(in srgb, CanvasText 6%, transparent); font-weight: 650; }
.sources ol { columns: 2; column-gap: 32px; padding-inline-start: 24px; }
.sources li { break-inside: avoid; margin-bottom: 8px; }
.appendix-intro { color: GrayText; max-width: 760px; }
.log-entry { border: 1px solid color-mix(in srgb, CanvasText 14%, transparent); border-radius: 8px; margin: 12px 0; padding: 0; background: color-mix(in srgb, CanvasText 3%, transparent); }
.log-entry summary { cursor: pointer; display: flex; gap: 16px; justify-content: space-between; align-items: baseline; padding: 12px 14px; font-weight: 650; }
.log-entry summary time { color: GrayText; font-size: 12px; font-weight: 400; white-space: nowrap; }
.log-entry > :not(summary) { margin: 0 14px 14px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: color-mix(in srgb, CanvasText 6%, transparent); padding: 12px; border-radius: 6px; }
ol { padding-inline-start: 24px; }
@media (max-width: 760px) {
  main { padding-inline: 18px; }
  h1 { font-size: 28px; }
  .sources ol { columns: 1; }
  .log-entry summary { display: block; }
  .log-entry summary time { display: block; margin-top: 4px; }
}
</style>
</head>
<body>
<main>
<nav class="report-nav"><a href="${reportListUri}">All research reports</a></nav>
<header>
<p class="eyebrow">Smart Window Research</p>
<h1>${escapeHtml(reportTitle)}</h1>
${reportDescription}
<p class="question">${escapeHtml(this.#question)}</p>
<span class="status">${escapeHtml(this.#status)}</span>
</header>
<section class="answer">
<h2>${answerHeading}</h2>
<div class="answer-body">${answerBody}</div>
</section>
${
  sources.length
    ? `<section class="sources"><h2>Sources</h2><ol>${sourceList}</ol></section>`
    : ""
}
<section class="appendix">
<h2>Research Log Appendix</h2>
<p class="appendix-intro">Detailed searches, visited pages, intermediate notes, and any recoverable errors are preserved here for inspection.</p>
${this.#sections.map(section => this.#renderSection(section)).join("\n")}
</section>
</main>
</body>
</html>`;
    await IOUtils.writeUTF8(this.#path, html, {
      tmpPath: `${this.#path}.tmp`,
    });
    if (updateIndex) {
      await ResearchReportIndex.upsert(this.#toRecord());
    }
  }
}

/**
 * Coordinates research sessions, model calls, and report generation.
 */
class ResearchAgentSingleton {
  #sessions = new Map();
  #exaClient = new ExaClient();

  isWaitingForClarifications(conversationId) {
    return (
      this.#sessions.get(conversationId)?.phase ===
      PHASE.WAITING_FOR_CLARIFICATIONS
    );
  }

  isRunning(conversationId) {
    const phase = this.#sessions.get(conversationId)?.phase;
    return phase === PHASE.CLARIFYING || phase === PHASE.RUNNING;
  }

  async submit({ conversation, text, pageUrl = null, userOpts = undefined }) {
    const existing = this.#sessions.get(conversation.id);
    if (existing?.phase === PHASE.WAITING_FOR_CLARIFICATIONS) {
      existing.conversation = conversation;
      return this.#startDeepResearch(existing, text, pageUrl, userOpts);
    }

    if (
      existing?.phase === PHASE.CLARIFYING ||
      existing?.phase === PHASE.RUNNING
    ) {
      this.#addAssistantMessage(
        conversation,
        "Research is already running for this conversation. I will update this chat when it finishes."
      );
      return { phase: existing.phase };
    }

    return this.#startClarifying({ conversation, text, pageUrl, userOpts });
  }

  async #startClarifying({ conversation, text, pageUrl, userOpts }) {
    const session = {
      id: crypto.randomUUID(),
      phase: PHASE.CLARIFYING,
      cancelled: false,
      conversation,
      question: text,
      clarifications: "",
      preliminaryResults: [],
      findings: [],
      visitedUrls: new Set(),
      report: new ResearchReport(text),
      assistantMessage: null,
    };
    this.#sessions.set(conversation.id, session);
    await session.report.init();
    if (session.cancelled) {
      return { phase: PHASE.CANCELLED };
    }

    this.#ensureConversationTitle(conversation, text);
    this.#addUserMessage(conversation, text, pageUrl, userOpts);
    const assistantMessage = this.#addAssistantMessage(
      conversation,
      "I am doing a quick scan before I ask clarifying questions.",
      { complete: false }
    );
    session.assistantMessage = assistantMessage;

    try {
      this.#throwIfCancelled(session);
      await session.report.addSection("Initial question", text);
      this.#throwIfCancelled(session);
      const engine = await openAIEngine.build(
        MODEL_FEATURES.CHAT,
        conversation.id
      );
      this.#throwIfCancelled(session);
      const plan = await this.#buildClarifyingSearchPlan(engine, text);
      this.#throwIfCancelled(session);
      const searches = (plan.searches.length ? plan.searches : [text]).slice(
        0,
        MAX_PRELIMINARY_SEARCHES
      );

      await session.report.addSection(
        "Preliminary plan",
        plan.reason || `Running ${searches.length} preliminary searches.`
      );

      for (const query of searches) {
        this.#throwIfCancelled(session);
        const results = await this.#runSearch(query, 5, session);
        this.#throwIfCancelled(session);
        session.preliminaryResults.push({ query, results });
        this.#rememberUrls(session, results);
        await session.report.addSearch(query, results);
      }

      const questions = await this.#buildClarifyingQuestions(engine, session);
      this.#throwIfCancelled(session);
      session.phase = PHASE.WAITING_FOR_CLARIFICATIONS;
      const body =
        questions ||
        "I have enough direction to start. Add any constraints, preferred sources, or output format you want, and I will continue in the background.";
      this.#updateAssistantMessage(conversation, assistantMessage, body, true);
      await ChatStore.updateConversation(conversation);
      return { phase: session.phase };
    } catch (error) {
      if (error instanceof ResearchCancelledError) {
        return { phase: PHASE.CANCELLED };
      }

      session.phase = PHASE.FAILED;
      const message =
        `Research setup failed: ${formatError(error)}` +
        `\n\nPartial HTML report:\n${session.report.fileUri}`;
      await session.report.addSection("Error", message).catch(() => {});
      await session.report
        .setFailedSummary(
          message,
          [],
          this.#buildFallbackReportMetadata(session, message)
        )
        .catch(() => {});
      this.#updateAssistantMessage(
        conversation,
        assistantMessage,
        message,
        true
      );
      await ChatStore.updateConversation(conversation).catch(() => {});
      this.#sessions.delete(conversation.id);
      return { phase: session.phase, error };
    }
  }

  async #startDeepResearch(session, text, pageUrl, userOpts) {
    const { conversation } = session;
    if (session.cancelled) {
      return { phase: PHASE.CANCELLED };
    }
    session.phase = PHASE.RUNNING;
    session.clarifications = text;

    this.#addUserMessage(conversation, text, pageUrl, userOpts);
    session.assistantMessage = this.#addAssistantMessage(
      conversation,
      `Thanks. I will keep researching in the background and save the report here:\n\n${session.report.fileUri}`
    );
    await session.report.addSection("Clarifications", text);
    if (session.cancelled) {
      return { phase: PHASE.CANCELLED };
    }
    await ChatStore.updateConversation(conversation);

    this.#runDeepResearch(session).catch(error => {
      if (error instanceof ResearchCancelledError) {
        return;
      }
      console.error("Research agent failed:", error);
      this.#finishWithError(session, error);
    });

    return { phase: session.phase, background: true };
  }

  async #runDeepResearch(session) {
    this.#throwIfCancelled(session);
    const engine = await openAIEngine.build(
      MODEL_FEATURES.CHAT,
      session.conversation.id
    );
    this.#throwIfCancelled(session);
    let done = false;

    for (let round = 1; round <= MAX_RESEARCH_ROUNDS; round++) {
      this.#throwIfCancelled(session);
      const plan = await this.#buildResearchRoundPlan(engine, session, round);
      this.#throwIfCancelled(session);
      const searches = normalizeArray(plan.searches).slice(
        0,
        SEARCHES_PER_ROUND
      );
      done = Boolean(plan.done) && round >= MIN_RESEARCH_ROUNDS;

      await session.report.addSection(
        `Round ${round} notes`,
        plan.thought || "Continuing the research pass."
      );

      if (!searches.length && done) {
        break;
      }

      const roundResults = [];
      for (const query of searches.length ? searches : [session.question]) {
        this.#throwIfCancelled(session);
        const results = await this.#runSearch(
          query,
          RESULTS_PER_SEARCH,
          session
        );
        this.#throwIfCancelled(session);
        roundResults.push({ query, results });
        this.#rememberUrls(session, results);
        await session.report.addSearch(query, results);
      }

      const pages = await this.#visitSearchResults(session, roundResults);
      this.#throwIfCancelled(session);
      await session.report.addPages(pages);

      const notes = await this.#buildResearchNotes(
        engine,
        session,
        roundResults,
        pages
      );
      this.#throwIfCancelled(session);
      session.findings.push({
        round,
        notes,
      });
      await session.report.addSection(`Round ${round} findings`, notes);

      if (
        done ||
        session.visitedUrls.size >= MAX_VISITED_URLS ||
        (!searches.length && !pages.length)
      ) {
        break;
      }
    }

    const finalAnswer = await this.#buildFinalAnswer(engine, session);
    this.#throwIfCancelled(session);
    const metadata = await this.#buildReportMetadata(
      engine,
      session,
      finalAnswer
    );
    this.#throwIfCancelled(session);
    await session.report.setFinalAnswer(
      finalAnswer,
      Array.from(session.visitedUrls),
      metadata
    );
    session.phase = PHASE.COMPLETE;

    const message = `Research is done.\n\nLocal HTML report:\n${session.report.fileUri}`;
    this.#addAssistantMessage(session.conversation, message);
    await ChatStore.updateConversation(session.conversation);
    this.#notifyDone(session);
    this.#sessions.delete(session.conversation.id);
  }

  async #buildClarifyingSearchPlan(engine, question) {
    try {
      const text = await this.#runModel(engine, [
        {
          role: "system",
          content: RESEARCH_CLARIFY_SEARCH_PLAN_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: question,
        },
      ]);
      const parsed = parseResearchJson(text) || {};
      return {
        searches: normalizeArray(parsed.searches).slice(
          0,
          MAX_PRELIMINARY_SEARCHES
        ),
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    } catch (error) {
      if (!isTransientResearchError(error)) {
        throw error;
      }
      console.warn(
        "Research planning model call failed; using fallback.",
        error
      );
      return {
        searches: [question],
        reason: `Model planning was temporarily unavailable (${formatError(
          error
        )}). Using the original question as the preliminary search.`,
      };
    }
  }

  async #buildClarifyingQuestions(engine, session) {
    const prompt = {
      question: session.question,
      preliminaryResults: session.preliminaryResults.map(
        ({ query, results }) => ({
          query,
          results: this.#trimResultsForModel(results),
        })
      ),
    };
    try {
      return await this.#runModel(engine, [
        {
          role: "system",
          content: RESEARCH_CLARIFY_QUESTIONS_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: truncate(JSON.stringify(prompt), MAX_MODEL_CONTEXT_CHARS),
        },
      ]);
    } catch (error) {
      if (!isTransientResearchError(error)) {
        throw error;
      }
      console.warn(
        "Research clarifying question model call failed; using fallback.",
        error
      );
      return (
        "I hit a temporary model error while preparing clarifying questions, " +
        "but I can still continue. Share any constraints, preferred sources, " +
        "date range, or output format you want, and I will research in the " +
        "background and save a local HTML research report."
      );
    }
  }

  async #buildResearchRoundPlan(engine, session, round) {
    const prompt = {
      round,
      question: session.question,
      clarifications: session.clarifications,
      visitedUrls: Array.from(session.visitedUrls),
      findings: session.findings,
    };
    try {
      const text = await this.#runModel(engine, [
        {
          role: "system",
          content: RESEARCH_LOOP_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: truncate(JSON.stringify(prompt), MAX_MODEL_CONTEXT_CHARS),
        },
      ]);
      const parsed = parseResearchJson(text) || {};
      return {
        done: Boolean(parsed.done),
        thought: typeof parsed.thought === "string" ? parsed.thought : "",
        searches: normalizeArray(parsed.searches),
        gaps: normalizeArray(parsed.gaps),
      };
    } catch (error) {
      if (!isTransientResearchError(error)) {
        throw error;
      }
      console.warn(
        "Research round planning model call failed; using fallback.",
        error
      );
      return {
        done: round >= MIN_RESEARCH_ROUNDS && !!session.findings.length,
        thought: `Model planning was temporarily unavailable (${formatError(
          error
        )}). Continuing with a fallback search plan.`,
        searches:
          round === 1 || !session.findings.length ? [session.question] : [],
        gaps: ["Model planning step was temporarily unavailable."],
      };
    }
  }

  async #buildResearchNotes(engine, session, roundResults, pages) {
    const prompt = {
      question: session.question,
      clarifications: session.clarifications,
      searchResults: roundResults.map(({ query, results }) => ({
        query,
        results: this.#trimResultsForModel(results),
      })),
      pages: pages.map(page => ({
        title: page.title,
        url: page.url,
        text: truncate(page.text || page.summary || "", 3000),
      })),
      previousFindings: session.findings,
    };
    try {
      return await this.#runModel(engine, [
        {
          role: "system",
          content: RESEARCH_NOTES_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: truncate(JSON.stringify(prompt), MAX_MODEL_CONTEXT_CHARS),
        },
      ]);
    } catch (error) {
      if (!isTransientResearchError(error)) {
        throw error;
      }
      console.warn("Research notes model call failed; using fallback.", error);
      return this.#buildFallbackNotes(roundResults, pages, error);
    }
  }

  async #buildFinalAnswer(engine, session) {
    const prompt = {
      question: session.question,
      clarifications: session.clarifications,
      findings: session.findings,
      visitedUrls: Array.from(session.visitedUrls),
    };
    try {
      return await this.#runModel(engine, [
        {
          role: "system",
          content: RESEARCH_FINAL_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: truncate(JSON.stringify(prompt), MAX_MODEL_CONTEXT_CHARS),
        },
      ]);
    } catch (error) {
      if (!isTransientResearchError(error)) {
        throw error;
      }
      console.warn(
        "Research final answer model call failed; using fallback.",
        error
      );
      return this.#buildFallbackFinalAnswer(session, error);
    }
  }

  async #buildReportMetadata(engine, session, finalAnswer) {
    const fallback = this.#buildFallbackReportMetadata(session, finalAnswer);
    const prompt = {
      question: session.question,
      clarifications: session.clarifications,
      finalAnswer: truncate(finalAnswer, 4000),
      findings: session.findings.map(({ round, notes }) => ({
        round,
        notes: truncate(notes, 1000),
      })),
    };

    try {
      const text = await this.#runModel(engine, [
        {
          role: "system",
          content: RESEARCH_REPORT_METADATA_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: truncate(JSON.stringify(prompt), MAX_MODEL_CONTEXT_CHARS),
        },
      ]);
      const parsed = parseResearchJson(text) || {};
      return {
        title:
          normalizeReportText(parsed.title, MAX_REPORT_TITLE_CHARS) ||
          fallback.title,
        description:
          normalizeReportText(
            parsed.description,
            MAX_REPORT_DESCRIPTION_CHARS
          ) || fallback.description,
      };
    } catch (error) {
      console.warn(
        "Research report metadata model call failed; using fallback.",
        error
      );
      return fallback;
    }
  }

  #buildFallbackReportMetadata(session, body) {
    return {
      title: fallbackReportTitle(session.question),
      description: fallbackReportDescription(body, session.phase),
    };
  }

  #buildFallbackNotes(roundResults, pages, error) {
    const searchLines = roundResults
      .flatMap(({ query, results }) =>
        results.slice(0, 4).map(result => {
          const title = result.title || result.url || "Untitled";
          return `- ${query}: ${title} (${result.url || "no URL"})`;
        })
      )
      .slice(0, 16);
    const pageLines = pages.slice(0, 8).map(page => {
      const title = page.title || page.url || "Untitled";
      return `- ${title} (${page.url || "no URL"})`;
    });

    return [
      `The notes model call failed after retries: ${formatError(error)}`,
      "",
      "Search result sources:",
      searchLines.length ? searchLines.join("\n") : "- No search results.",
      "",
      "Visited pages:",
      pageLines.length ? pageLines.join("\n") : "- No pages visited.",
    ].join("\n");
  }

  #buildFallbackFinalAnswer(session, error) {
    const findings = session.findings
      .map(({ round, notes }) => `Round ${round}:\n${truncate(notes, 1400)}`)
      .join("\n\n");
    const sources = Array.from(session.visitedUrls)
      .slice(0, 30)
      .map(url => `- ${url}`)
      .join("\n");

    return [
      `The final-answer model call failed after retries: ${formatError(error)}`,
      "",
      "Use the research notes and sources in this HTML report as the current result.",
      findings ? `\nCollected notes:\n${findings}` : "",
      sources ? `\nVisited sources:\n${sources}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async #runModel(engine, messages) {
    const fxAccountToken = await openAIEngine.getFxAccountToken();
    if (!fxAccountToken) {
      throw new Error("FxA token unavailable");
    }

    const config = engine.getConfig(engine.feature);
    const inferenceParams = config?.parameters || {};
    const response = await retryTransient(
      () =>
        engine.run({
          args: messages,
          fxAccountToken,
          ...inferenceParams,
        }),
      "Research LLM call"
    );

    return response?.finalOutput?.trim() || "";
  }

  async #runSearch(query, numResults, session = null) {
    try {
      this.#throwIfCancelled(session);
      const data = await this.#exaClient.search({
        query,
        numResults,
        contents: {
          highlights: true,
        },
      });
      this.#throwIfCancelled(session);
      return Array.isArray(data.results) ? data.results : [];
    } catch (error) {
      if (error instanceof ResearchCancelledError) {
        throw error;
      }
      if (!isTransientResearchError(error)) {
        throw error;
      }
      const message = `Search failed after retries for "${query}": ${formatError(
        error
      )}`;
      console.warn(message, error);
      await session?.report.addSection("Search error", message).catch(() => {});
      return [];
    }
  }

  async #visitSearchResults(session, roundResults) {
    this.#throwIfCancelled(session);
    const urls = [];
    for (const { results } of roundResults) {
      for (const result of results) {
        if (
          result.url &&
          !session.visitedUrls.has(result.url) &&
          !urls.includes(result.url) &&
          urls.length < CONTENT_URLS_PER_ROUND
        ) {
          urls.push(result.url);
        }
      }
    }

    if (!urls.length) {
      return [];
    }

    try {
      const data = await this.#exaClient.contents({
        urls,
        text: {
          maxCharacters: 8000,
        },
      });
      this.#throwIfCancelled(session);
      const pages = Array.isArray(data.results) ? data.results : [];
      this.#rememberUrls(session, pages, { visited: true });
      return pages;
    } catch (error) {
      if (error instanceof ResearchCancelledError) {
        throw error;
      }
      if (!isTransientResearchError(error)) {
        throw error;
      }
      const message = `Page contents fetch failed after retries: ${formatError(
        error
      )}`;
      console.warn(message, error);
      await session.report
        .addSection("Page visit error", message)
        .catch(() => {});
      return [];
    }
  }

  #rememberUrls(session, items, { visited = false } = {}) {
    const urls = items.map(item => item.url).filter(Boolean);
    if (visited) {
      for (const url of urls) {
        session.visitedUrls.add(url);
      }
    }
    session.conversation.addSeenUrls(urls);
  }

  #throwIfCancelled(session) {
    if (session?.cancelled) {
      throw new ResearchCancelledError();
    }
  }

  #findSessionByReportId(reportId) {
    for (const session of this.#sessions.values()) {
      if (session.report.id === reportId) {
        return session;
      }
    }
    return null;
  }

  async #cancelSession(session, { deleteReport = false } = {}) {
    if (session.cancelled) {
      return;
    }

    session.cancelled = true;
    session.phase = PHASE.CANCELLED;

    const message = "Research was cancelled before it completed.";
    if (deleteReport) {
      session.report.markDeleted();
    } else {
      await session.report
        .setCancelledSummary(
          message,
          Array.from(session.visitedUrls),
          this.#buildFallbackReportMetadata(session, message)
        )
        .catch(error => {
          console.warn("Could not save cancelled research report:", error);
        });
    }

    const chatMessage = deleteReport
      ? "Research was cancelled and its local report was deleted."
      : `Research was cancelled.\n\nLocal HTML report:\n${session.report.fileUri}`;
    if (session.assistantMessage) {
      this.#updateAssistantMessage(
        session.conversation,
        session.assistantMessage,
        chatMessage,
        true
      );
    } else {
      this.#addAssistantMessage(session.conversation, chatMessage);
    }
    await ChatStore.updateConversation(session.conversation).catch(() => {});
    this.#sessions.delete(session.conversation.id);
  }

  #trimResultsForModel(results) {
    return results.slice(0, RESULTS_PER_SEARCH).map(result => ({
      title: result.title,
      url: result.url,
      publishedDate: result.publishedDate,
      author: result.author,
      text: truncate(
        result.text ||
          result.summary ||
          result.highlights?.join("\n") ||
          result.snippet ||
          "",
        1600
      ),
    }));
  }

  #addUserMessage(conversation, text, pageUrl, userOpts) {
    const message = conversation.addUserMessage(text, pageUrl, userOpts);
    conversation.emit("chat-conversation:message-update", message);
    return message;
  }

  #addAssistantMessage(conversation, text, { complete = true } = {}) {
    const message = conversation.addAssistantMessage(
      "text",
      text,
      new AssistantRoleOpts()
    );
    conversation.emit("chat-conversation:message-update", message);
    if (complete) {
      conversation.emit("chat-conversation:message-complete", message);
    }
    ChatStore.updateConversation(conversation).catch(() => {});
    return message;
  }

  #updateAssistantMessage(conversation, message, text, complete = false) {
    message.content.body = text;
    conversation.emit("chat-conversation:message-update", message);
    if (complete) {
      conversation.emit("chat-conversation:message-complete", message);
    }
  }

  #ensureConversationTitle(conversation, question) {
    if (!conversation.title) {
      conversation.title = `Research: ${truncate(question, 48)}`;
    }
  }

  async #finishWithError(session, error) {
    if (session.cancelled || session.phase === PHASE.CANCELLED) {
      return;
    }

    session.phase = PHASE.FAILED;
    const message =
      `Research failed: ${formatError(error)}` +
      `\n\nPartial HTML report:\n${session.report.fileUri}`;
    await session.report.addSection("Error", message).catch(() => {});
    await session.report
      .setFailedSummary(
        message,
        Array.from(session.visitedUrls),
        this.#buildFallbackReportMetadata(session, message)
      )
      .catch(() => {});
    this.#addAssistantMessage(session.conversation, message);
    await ChatStore.updateConversation(session.conversation).catch(() => {});
    this.#sessions.delete(session.conversation.id);
  }

  #notifyDone(session) {
    try {
      const alertName = `smart-window-research-${session.id}`;
      const alert = new AlertNotification({
        name: alertName,
        title: "Smart Window research complete",
        text: "Click to open the local research report.",
      });
      const observer = {
        observe: (_subject, topic) => {
          if (topic === "alertclickcallback") {
            this.#openReport(session.report.fileUri);
          }
        },
      };
      lazy.AlertsService.showAlert(alert, observer);
    } catch (error) {
      console.warn("Could not show research completion notification:", error);
    }
  }

  #openReport(fileUri) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (!win?.gBrowser) {
      return;
    }
    const tab = win.gBrowser.addTab(fileUri, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    win.gBrowser.selectedTab = tab;
  }

  #createPdfPrintSettings(targetPath) {
    const psService = Cc["@mozilla.org/gfx/printsettings-service;1"].getService(
      Ci.nsIPrintSettingsService
    );
    const printSettings = psService.createNewPrintSettings();

    printSettings.printerName = "";
    printSettings.isInitializedFromPrinter = true;
    printSettings.isInitializedFromPrefs = true;
    printSettings.outputDestination =
      Ci.nsIPrintSettings.kOutputDestinationFile;
    printSettings.toFileName = targetPath;
    printSettings.printSilent = true;
    printSettings.outputFormat = Ci.nsIPrintSettings.kOutputFormatPDF;
    printSettings.printBGColors = true;
    printSettings.printBGImages = true;
    printSettings.headerStrLeft = "";
    printSettings.headerStrCenter = "";
    printSettings.headerStrRight = "";
    printSettings.footerStrLeft = "";
    printSettings.footerStrCenter = "";
    printSettings.footerStrRight = "";

    return printSettings;
  }

  #loadReportForPdfExport(browser, fileUri) {
    const triggeringPrincipal =
      Services.scriptSecurityManager.getSystemPrincipal();
    const reportUri = Services.io.newURI(fileUri);

    return new Promise((resolve, reject) => {
      let listener;
      let timeoutId;
      let isDone = false;
      const finish = error => {
        if (isDone) {
          return;
        }
        isDone = true;
        lazy.clearTimeout(timeoutId);
        if (browser?.webProgress) {
          try {
            browser.removeProgressListener(listener);
          } catch {}
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      timeoutId = lazy.setTimeout(() => {
        finish(
          new Error("Timed out while loading research report for PDF export.")
        );
      }, PDF_EXPORT_LOAD_TIMEOUT_MS);

      listener = {
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),

        onStateChange(webProgress, request, stateFlags, status) {
          if (
            !webProgress.isTopLevel ||
            !(stateFlags & Ci.nsIWebProgressListener.STATE_STOP)
          ) {
            return;
          }

          let requestUri = "";
          try {
            requestUri = request.QueryInterface(Ci.nsIChannel).URI?.spec || "";
          } catch {}
          if (requestUri !== reportUri.spec) {
            return;
          }

          if (Components.isSuccessCode(status)) {
            finish();
          } else {
            finish(
              new Error(
                `Could not load research report for PDF export: ${status}`
              )
            );
          }
        },

        onLocationChange() {},
        onProgressChange() {},
        onSecurityChange() {},
        onStatusChange() {},
        onContentBlockingEvent() {},
      };

      browser.addProgressListener(
        listener,
        Ci.nsIWebProgress.NOTIFY_STATE_WINDOW
      );
      try {
        browser.loadURI(reportUri, { triggeringPrincipal });
      } catch (error) {
        finish(error);
      }
    });
  }

  async #createPdfExportReportFile(report) {
    const reportPath = getReportFilePath(report);
    if (!reportPath) {
      return { fileUri: report.fileUri, path: "" };
    }

    const html = await IOUtils.readUTF8(reportPath);
    const printHtml = expandAppendixDetailsForPrint(html);
    if (printHtml === html) {
      return { fileUri: report.fileUri, path: "" };
    }

    const path = await IOUtils.createUniqueFile(
      PathUtils.tempDir,
      "smart-window-research-export.html"
    );
    await IOUtils.writeUTF8(path, printHtml, {
      tmpPath: `${path}.tmp`,
    });
    return {
      fileUri: PathUtils.toFileURI(path),
      path,
    };
  }

  async #exportReportToPdf(report) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (!win?.gBrowser) {
      throw new Error("No browser window is available for PDF export.");
    }

    const downloadsDir = await lazy.Downloads.getPreferredDownloadsDirectory();
    await IOUtils.makeDirectory(downloadsDir, { ignoreExisting: true });
    const targetPath = await getUniquePdfPath(
      downloadsDir,
      getReportPdfFileName(report)
    );
    const triggeringPrincipal =
      Services.scriptSecurityManager.getSystemPrincipal();
    const tab = win.gBrowser.addTab("about:blank", {
      inBackground: true,
      triggeringPrincipal,
    });

    let exportReportFile = null;
    try {
      exportReportFile = await this.#createPdfExportReportFile(report);
      const browser = tab.linkedBrowser;
      await this.#loadReportForPdfExport(browser, exportReportFile.fileUri);
      await browser.browsingContext.print(
        this.#createPdfPrintSettings(targetPath)
      );
      const fileInfo = await IOUtils.stat(targetPath);
      if (!fileInfo.size) {
        throw new Error("PDF export created an empty file.");
      }
      return {
        path: targetPath,
        fileUri: PathUtils.toFileURI(targetPath),
      };
    } catch (error) {
      await IOUtils.remove(targetPath, { ignoreAbsent: true }).catch(() => {});
      throw error;
    } finally {
      if (exportReportFile?.path) {
        await IOUtils.remove(exportReportFile.path, {
          ignoreAbsent: true,
        }).catch(() => {});
      }
      win.gBrowser.removeTab(tab);
    }
  }

  async openReportList() {
    this.#openReport(REPORT_LIST_URL);
  }

  async getReports() {
    return ResearchReportIndex.getReports();
  }

  async exportReportToPdf(reportId) {
    const report = await ResearchReportIndex.getReport(reportId);
    if (!report) {
      throw new Error("Research report not found.");
    }
    return this.#exportReportToPdf(report);
  }

  async deleteReport(reportId) {
    const session = this.#findSessionByReportId(reportId);
    if (session) {
      await this.#cancelSession(session, { deleteReport: true });
    }
    return ResearchReportIndex.delete(reportId);
  }

  async cancelReport(reportId) {
    const session = this.#findSessionByReportId(reportId);
    if (session) {
      await this.#cancelSession(session);
      return true;
    }
    return ResearchReportIndex.cancel(reportId);
  }
}

export const ResearchAgent = new ResearchAgentSingleton();
