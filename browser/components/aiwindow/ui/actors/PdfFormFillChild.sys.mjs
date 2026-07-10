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
// for LTR at default zoom; RTL is later work. Scoring is anchored on the field's
// writing line (its bottom edge), not the full box, so an oversized field box
// does not push the true label out of range.
const EDGE_TOLERANCE = 4;
const LEFT_ALIGN_TOLERANCE = 25;
const MAX_LEFT_GAP = 400;
const MAX_ABOVE_GAP = 50;
const COLON_BONUS = 150;
// How far a same-row label's baseline may differ from the field's and still
// count as the same line.
const BASELINE_TOLERANCE = 12;
// A label whose span horizontally contains the field (the "Prompt: ____" pattern
// where the fill line is part of the label span and the input overlays it) is a
// strong match; bonus sits above COLON_BONUS so it beats an adjacent or above label.
const CONTAINMENT_BONUS = 300;
// Slack allowing the field's right edge to sit slightly past the label's.
const CONTAINMENT_SLACK = 8;

// Name-match disambiguation. A field's AcroForm name (and TU alt text) often
// echoes its label; when it does, use that to break near-ties between adjacent
// geometry candidates. Spike knobs; the weight sits above COLON_BONUS and a
// typical adjacent-gap difference so a strong name match flips an adjacent
// mis-pick, but only among labels that already scored on geometry.
const USE_NAME_MATCH_BONUS = true;
const NAME_MATCH_THRESHOLD = 0.6;
const NAME_MATCH_WEIGHT = 400;

function overlap1D(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Split "addressLine1" / "f2_1" into space-separated words.
function splitMixedCase(str) {
  return (str ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.[\]]+/g, " ")
    .trim();
}

// Lowercase, split on non-alphanumerics, drop words shorter than 3 chars.
function tokenizeName(str) {
  return (str ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3);
}

// Overlap coefficient of two token lists: |intersection| / min(|a|, |b|). This
// rewards "the label's words are contained in the name" ("Street address" vs
// StreetAddress; "City" vs cityStateZip). 0 if either side has no usable tokens.
function labelNameSimilarity(nameTokens, labelTokens) {
  if (!nameTokens.length || !labelTokens.length) {
    return 0;
  }
  const nameSet = new Set(nameTokens);
  let shared = 0;
  for (const token of new Set(labelTokens)) {
    if (nameSet.has(token)) {
      shared++;
    }
  }
  return shared / Math.min(nameSet.size, new Set(labelTokens).size);
}

function leafName(fullName) {
  return (fullName || "")
    .split(".")
    .pop()
    .replace(/\[\d+\]$/, "");
}

function cleanLabel(str) {
  return str
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*[_.]{2,}$/, "") // trailing fill line (underscores/dots)
    .replace(/:$/, "")
    .trim();
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
      // Skip blanks and decoration-only spans (fill lines of underscores/dots,
      // bare symbols like "$"): they are not labels, and a fill line that
      // encloses a field would otherwise win as an empty containment match.
      if (!str || !/[a-z0-9]/i.test(str)) {
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
  // Anchored on the field's writing line, its bottom-left point in LTR, so an
  // oversized field box (top far above the input line) does not gate out the
  // true label. Client coordinates: y grows downward, so a label "above" the
  // line has a smaller `bottom` than the field's.
  #scoreLabel(fieldRect, label) {
    const lr = label.rect;
    const colonBonus = label.str.trim().endsWith(":") ? COLON_BONUS : 0;
    let score = 0;

    // Label to the left on the same writing line. Qualifying on the label's
    // start (not its end) lets a span that begins left of the field and extends
    // into or past it count: the "Prompt: ____" pattern renders the prompt and
    // fill line as one span with the input overlaid, so the label horizontally
    // contains the field. That containment is a strong signal and earns a bonus.
    const leftGap = fieldRect.left - lr.right;
    const sameLine = Math.abs(lr.bottom - fieldRect.bottom) <= BASELINE_TOLERANCE;
    const startsLeft = lr.left <= fieldRect.left + EDGE_TOLERANCE;
    if (startsLeft && sameLine && leftGap <= MAX_LEFT_GAP) {
      const contains = fieldRect.right <= lr.right + CONTAINMENT_SLACK;
      const containmentBonus = contains ? CONTAINMENT_BONUS : 0;
      score = Math.max(
        score,
        1000 - Math.max(0, leftGap) + colonBonus + containmentBonus
      );
    }

    // Label above the writing line. Requiring a gap strictly above the line
    // drops a value that sits on it (aboveGap near 0).
    const aboveGap = fieldRect.bottom - lr.bottom;
    const horizontalOverlap = overlap1D(
      lr.left,
      lr.right,
      fieldRect.left,
      fieldRect.right
    );
    if (
      aboveGap > EDGE_TOLERANCE &&
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
    // Geometry-only snapshot, for the diagnostic below (rawScores gets the
    // name bonus added in place).
    const geometryScores = rawScores.map(row => row.slice());

    const nameTokensByField = pageFields.map(field =>
      tokenizeName(`${splitMixedCase(field.leaf)} ${field.tu ?? ""}`)
    );

    // Name-match bonus: when a field's name (plus TU alt text) echoes a label
    // it already scored on geometry, boost that pair so the assignment breaks
    // near-ties toward the name. Gated to positive-geometry candidates so the
    // name only disambiguates plausible neighbors, never pulls in a far label.
    const nameBoosted = pageFields.map(() => labels.map(() => false));
    if (USE_NAME_MATCH_BONUS) {
      pageFields.forEach((field, i) => {
        const nameTokens = nameTokensByField[i];
        if (!nameTokens.length) {
          return;
        }
        for (let j = 0; j < labels.length; j++) {
          if (rawScores[i][j] <= 0) {
            continue;
          }
          const similarity = labelNameSimilarity(
            nameTokens,
            tokenizeName(labels[j].str)
          );
          if (similarity >= NAME_MATCH_THRESHOLD) {
            rawScores[i][j] += NAME_MATCH_WEIGHT * similarity;
            nameBoosted[i][j] = true;
          }
        }
      });
    }

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
        const labelIndex = usefulLabels[column];
        field.associatedLabel = cleanLabel(labels[labelIndex].str);
        field.labelScore = Math.round(matrix[i][column]);
        field.labelSource = nameBoosted[i][labelIndex]
          ? "geometry+name"
          : "geometry";
      }
      field.assignmentStrategy = strategy;

      // Diagnostic: name/TU similarity to every label, ignoring the geometry
      // gate. Reveals whether the true label matched the name but scored 0 on
      // geometry (gated out) or just lost a near-tie.
      const nameTokens = nameTokensByField[i];
      const simScores = labels.map(label =>
        nameTokens.length
          ? labelNameSimilarity(nameTokens, tokenizeName(label.str))
          : 0
      );
      let bestSim = 0;
      let bestJ = -1;
      simScores.forEach((sim, j) => {
        if (sim > bestSim) {
          bestSim = sim;
          bestJ = j;
        }
      });
      const nameMatch =
        bestJ >= 0
          ? `bestName="${cleanLabel(labels[bestJ].str)}" sim=${bestSim.toFixed(
              2
            )} geo=${Math.round(geometryScores[i][bestJ])}`
          : "bestName=none";
      lazy.console.debug(
        `${field.leaf} tu="${field.tu ?? ""}" -> "${field.associatedLabel}" (score ${field.labelScore}, ${field.labelSource}) | ${nameMatch}`
      );

      // Dump competing candidates when a boosted label won, a strong name match
      // was gated out, or the field got no label at all. dx/dy are each label's
      // offset from the field's top-left (negative = left/above), so a missed
      // field shows whether the nearby labels are positioned where we score.
      const gatedNameMatch = simScores.some(
        (sim, j) => sim >= NAME_MATCH_THRESHOLD && geometryScores[i][j] <= 0
      );
      if (
        field.labelSource === "geometry+name" ||
        gatedNameMatch ||
        field.labelSource === "none"
      ) {
        const fr = field.rect;
        const candidates = labels
          .map((label, j) => ({
            text: cleanLabel(label.str),
            geo: Math.round(geometryScores[i][j]),
            sim: simScores[j],
            dx: Math.round(label.rect.left - fr.left),
            dy: Math.round(label.rect.top - fr.top),
            dist: Math.hypot(label.rect.left - fr.left, label.rect.top - fr.top),
          }))
          .filter(c => c.text)
          .sort((a, b) => b.geo - a.geo || a.dist - b.dist)
          .slice(0, 6)
          .map(
            c =>
              `"${c.text}"(geo=${c.geo},sim=${c.sim.toFixed(2)},dx=${c.dx},dy=${c.dy})`
          )
          .join("  ");
        lazy.console.debug(`   candidates: ${candidates}`);
      }
    });
  }

  #render(fields, results) {
    const byId = new Map((results ?? []).map(r => [r.id, r]));
    const rows = fields.map(f => {
      const r = byId.get(f.id) ?? {};
      return {
        name: f.leaf,
        fullName: f.name,
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
