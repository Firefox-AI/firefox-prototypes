/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * PDF Smart Form Fill (spike POC) - content actor.
 *
 * Runs in the pdf.js viewer document (principal resource://pdf.js/web/viewer.html).
 * Associates each rendered form field with a nearby page label using the DOM:
 * the annotation-layer <input>s and the text-layer <span>s are both real DOM
 * elements, so we can read them and their client rects directly (no pdf.js
 * runtime calls, no Xray waiver gymnastics) and associate them in the shared
 * screen-coordinate space. Then the parent classifies. Read-only; nothing is
 * written to the document.
 *
 * Limitation: pdf.js renders pages lazily, so only rendered pages have DOM. We
 * run on each `pagerendered` event and re-associate as pages come into view.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  assignLabels:
    "moz-src:///browser/components/aiwindow/ui/modules/PdfLabelAssignment.sys.mjs",
  ContentDOMReference: "resource://gre/modules/ContentDOMReference.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "PdfFormFill",
    // POC: force-on so the spike trace is always visible.
    maxLogLevel: "Debug",
  })
);

const VIEWER_PRINCIPAL = "resource://pdf.js/web/viewer.html";

// Geometry thresholds, in CSS pixels (client coords, y grows downward). Tuned
// for LTR at default zoom; RTL is later work.
const EDGE_TOLERANCE = 4;
const LEFT_ALIGN_TOLERANCE = 25;
const MAX_LEFT_GAP = 400;
const MAX_ABOVE_GAP = 50;
const COLON_BONUS = 150;
const MIN_VERTICAL_OVERLAP_RATIO = 0.25;

function overlap1D(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function leafName(fullName) {
  return (fullName || "")
    .split(".")
    .pop()
    .replace(/\[\d+\]$/, "");
}

function cleanLabel(str) {
  return str.trim().replace(/\s+/g, " ").replace(/:$/, "").trim();
}

export class PdfFormFillChild extends JSWindowActorChild {
  #app = null;
  #scheduleTimer = null;
  #classificationByName = null;

  handleEvent(event) {
    if (event.type !== "DOMContentLoaded") {
      return;
    }
    // The viewer's document URI is the PDF's own URL, so actor `matches` cannot
    // target it. We run on every DOMContentLoaded and bail unless this document
    // is the viewer, identified by its principal (as fullZoom/ZoomUI do).
    if (this.document?.nodePrincipal?.spec !== VIEWER_PRINCIPAL) {
      return;
    }
    lazy.console.info("viewer document detected");
    this.#init().catch(e => lazy.console.error("init failed", e));
  }

  async #init() {
    // Waive Xray to reach the viewer's page-JS global (for initializedPromise
    // and the eventBus only; all field/label reads go through the DOM).
    const app = this.contentWindow?.wrappedJSObject?.PDFViewerApplication;
    if (!app) {
      lazy.console.debug("No PDFViewerApplication on this document");
      return;
    }
    lazy.console.info("child created; awaiting viewer initialization");
    await app.initializedPromise;
    this.#app = app;

    // Re-associate as pages render (lazy rendering means DOM appears over time).
    app.eventBus?.on("pagerendered", () => this.#schedule());

    this.#schedule();
  }

  receiveMessage(message) {
    switch (message.name) {
      case "PdfFormFill:FillTarget": {
        // Context menu: fill the right-clicked element.
        const el = lazy.ContentDOMReference.resolve(
          message.data.targetIdentifier
        );
        this.#fillFocused(el).catch(e => lazy.console.error("fill failed", e));
        break;
      }
      case "PdfFormFill:FillFocused":
        // Keyboard shortcut: fill the currently focused element.
        this.#fillFocused(this.document.activeElement).catch(e =>
          lazy.console.error("fill failed", e)
        );
        break;
    }
  }

  #schedule() {
    lazy.clearTimeout(this.#scheduleTimer);
    this.#scheduleTimer = lazy.setTimeout(
      () => this.#run().catch(e => lazy.console.error("run failed", e)),
      400
    );
  }

  async #run() {
    const fields = this.#collectFields();
    if (!fields.length) {
      lazy.console.debug("no rendered form fields yet");
      return;
    }
    lazy.console.info(`associating ${fields.length} rendered field(s)`);

    this.#associate(fields);

    // Reading order (page, then top, then left) so the parent's neighbor tokens
    // approximate on-page neighbors.
    fields.sort(
      (a, b) =>
        Number(a.page) - Number(b.page) ||
        a.rect.top - b.rect.top ||
        a.rect.left - b.rect.left
    );

    const bundles = fields.map(f => ({
      id: f.id,
      name: f.name,
      leaf: f.leaf,
      tu: f.tu,
      label: f.associatedLabel,
      labelSource: f.labelSource,
      type: f.type,
    }));
    const results = await this.sendQuery("PdfFormFill:Classify", {
      fields: bundles,
    });

    const resultById = new Map((results ?? []).map(r => [r.id, r]));
    this.#classificationByName = new Map(
      fields.map(f => [
        f.name,
        {
          chosenFieldName: resultById.get(f.id)?.chosenFieldName ?? "unknown",
          category: resultById.get(f.id)?.category ?? null,
          label: f.associatedLabel,
        },
      ])
    );

    this.#render(fields, results);
  }

  async #fillFocused(el) {
    if (!el?.name || !el.closest?.(".annotationLayer")) {
      lazy.console.info("focused/clicked element is not a fillable form field");
      return;
    }
    const info = this.#classificationByName?.get(el.name);
    if (!info) {
      lazy.console.info(`no classification yet for "${el.name}"`);
      return;
    }
    lazy.console.info(
      `fill requested: "${el.name}" classified as ${info.chosenFieldName}`
    );
    const { value, source } = await this.sendQuery("PdfFormFill:ResolveValue", {
      fieldName: info.chosenFieldName,
      category: info.category,
      label: info.label,
      url: this.document.documentURIObject?.spec ?? "",
      title: this.document.title ?? "",
    });
    if (!value) {
      lazy.console.info(`no value to fill (source ${source})`);
      return;
    }
    el.setUserInput(value);
    try {
      el.autofillState = "autofill";
    } catch (e) {
      // Highlight is best-effort on annotation-layer inputs.
    }
    lazy.console.info(`filled "${el.name}" with "${value}" (source ${source})`);
  }

  #collectFields() {
    const fields = [];
    for (const el of this.document.querySelectorAll(
      ".annotationLayer input, .annotationLayer textarea"
    )) {
      const isText =
        el.tagName === "TEXTAREA" || el.getAttribute("type") === "text";
      if (!isText || !el.name) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const page = el.closest(".page")?.dataset.pageNumber ?? null;
      fields.push({
        id: el.name,
        name: el.name,
        leaf: leafName(el.name),
        type: "text",
        page,
        rect,
        tu: el.closest("section")?.title ?? "",
        associatedLabel: "",
        labelSource: "none",
        labelScore: 0,
        assignmentStrategy: "n/a",
      });
    }
    return fields;
  }

  #collectLabelsByPage() {
    const byPage = new Map();
    for (const span of this.document.querySelectorAll(".textLayer span")) {
      const str = span.textContent;
      if (!str || !str.trim()) {
        continue;
      }
      const page = span.closest(".page")?.dataset.pageNumber ?? null;
      if (!byPage.has(page)) {
        byPage.set(page, []);
      }
      byPage.get(page).push({ str, rect: span.getBoundingClientRect() });
    }
    return byPage;
  }

  // Score how likely `label` is the label for `field` (0 = not a candidate).
  // Client coordinates: y grows downward, so "above" means a smaller `top`.
  #scoreLabel(fieldRect, label) {
    const lr = label.rect;

    // A label overlapping the field box is the field's own value, not a label.
    if (
      overlap1D(lr.left, lr.right, fieldRect.left, fieldRect.right) > 0 &&
      overlap1D(lr.top, lr.bottom, fieldRect.top, fieldRect.bottom) > 0
    ) {
      return 0;
    }

    const colonBonus = label.str.trim().endsWith(":") ? COLON_BONUS : 0;
    let score = 0;

    // Label to the left on the same row.
    const leftGap = fieldRect.left - lr.right;
    const verticalOverlap = overlap1D(
      lr.top,
      lr.bottom,
      fieldRect.top,
      fieldRect.bottom
    );
    const labelHeight = Math.max(lr.height, 1);
    if (
      leftGap >= -EDGE_TOLERANCE &&
      leftGap <= MAX_LEFT_GAP &&
      verticalOverlap / labelHeight > MIN_VERTICAL_OVERLAP_RATIO
    ) {
      score = Math.max(score, 1000 - leftGap + colonBonus);
    }

    // Label directly above.
    const aboveGap = fieldRect.top - lr.bottom;
    const horizontalOverlap = overlap1D(
      lr.left,
      lr.right,
      fieldRect.left,
      fieldRect.right
    );
    if (
      aboveGap >= -EDGE_TOLERANCE &&
      aboveGap <= MAX_ABOVE_GAP &&
      (horizontalOverlap > 0 ||
        Math.abs(lr.left - fieldRect.left) <= LEFT_ALIGN_TOLERANCE)
    ) {
      score = Math.max(score, 800 - aboveGap + colonBonus);
    }

    return score;
  }

  #associate(fields) {
    const labelsByPage = this.#collectLabelsByPage();

    const fieldsByPage = new Map();
    for (const field of fields) {
      if (!fieldsByPage.has(field.page)) {
        fieldsByPage.set(field.page, []);
      }
      fieldsByPage.get(field.page).push(field);
    }

    for (const [page, pageFields] of fieldsByPage) {
      const labels = labelsByPage.get(page) ?? [];
      if (!labels.length) {
        continue;
      }
      this.#associatePage(pageFields, labels);
    }
  }

  #associatePage(pageFields, labels) {
    // Raw scores field x label, then keep only labels that match some field so
    // the assignment matrix stays small.
    const rawScores = pageFields.map(field =>
      labels.map(label => this.#scoreLabel(field.rect, label))
    );
    const usefulLabels = [];
    for (let j = 0; j < labels.length; j++) {
      if (rawScores.some(row => row[j] > 0)) {
        usefulLabels.push(j);
      }
    }
    if (!usefulLabels.length) {
      return;
    }

    const matrix = pageFields.map((_, i) =>
      usefulLabels.map(j => rawScores[i][j])
    );
    const { assignment, strategy } = lazy.assignLabels(matrix);

    pageFields.forEach((field, i) => {
      const column = assignment[i];
      if (column >= 0) {
        field.associatedLabel = cleanLabel(labels[usefulLabels[column]].str);
        field.labelScore = Math.round(matrix[i][column]);
        field.labelSource = "geometry";
      }
      field.assignmentStrategy = strategy;
      lazy.console.debug(
        `${field.leaf} -> "${field.associatedLabel}" (score ${field.labelScore})`
      );
    });
  }

  #render(fields, results) {
    const byId = new Map((results ?? []).map(r => [r.id, r]));
    const rows = fields.map(f => {
      const r = byId.get(f.id) ?? {};
      return {
        name: f.leaf,
        label: f.associatedLabel,
        labelSource: f.labelSource,
        tu: f.tu,
        regexGuess: r.regexGuess ?? null,
        mlLabel: r.mlLabel ?? null,
        chosenFieldName: r.chosenFieldName ?? "unknown",
        category: r.category ?? null,
      };
    });

    const labeled = fields.filter(f => f.labelSource !== "none").length;
    const classified = rows.filter(r => r.chosenFieldName !== "unknown").length;
    lazy.console.info(
      `association: ${labeled}/${fields.length} labeled (strategy ${
        fields[0]?.assignmentStrategy ?? "n/a"
      }); classification: ${classified}/${rows.length}`
    );
    lazy.console.info("classification results:", rows);

    try {
      this.#app._formFillClassification = Cu.cloneInto(rows, this.contentWindow);
    } catch (e) {
      lazy.console.debug("could not expose results on the viewer global", e);
    }
  }
}
