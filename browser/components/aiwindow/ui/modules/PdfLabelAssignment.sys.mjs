/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * PDF Smart Form Fill (spike POC) - label-to-field assignment.
 *
 * Given a (field x candidate-label) score matrix, choose one label per field.
 * Two strategies behind a single hardcoded toggle so we can evaluate whether
 * global assignment actually beats greedy on real forms:
 *
 *   - greedy: each field independently takes its best-scoring label; the same
 *     label can be claimed by more than one field.
 *   - global: Hungarian (Kuhn-Munkres) maximum-weight one-to-one assignment, so
 *     no label is double-claimed.
 *
 * Flip USE_GLOBAL_ASSIGNMENT and rebuild to A/B the two on the same PDF.
 */

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "console", () =>
  console.createInstance({
    prefix: "PdfFormFill",
    maxLogLevel: "Debug",
  })
);

// Spike knob.
export const USE_GLOBAL_ASSIGNMENT = true;

// A field scoring below this against every candidate is left unlabeled.
const MIN_SCORE = 1;

/**
 * @param {number[][]} scoreMatrix  scoreMatrix[i][j] = score of field i vs label j
 * @returns {{strategy: string, assignment: number[]}}  assignment[i] = label index or -1
 */
export function assignLabels(scoreMatrix) {
  const strategy = USE_GLOBAL_ASSIGNMENT ? "global" : "greedy";
  const assignment = USE_GLOBAL_ASSIGNMENT
    ? assignGlobal(scoreMatrix)
    : assignGreedy(scoreMatrix);
  lazy.console.info(`label assignment strategy: ${strategy}`);
  return { strategy, assignment };
}

function assignGreedy(matrix) {
  return matrix.map(row => {
    let bestLabel = -1;
    let bestScore = MIN_SCORE;
    for (let label = 0; label < row.length; label++) {
      if (row[label] > bestScore) {
        bestScore = row[label];
        bestLabel = label;
      }
    }
    return bestLabel;
  });
}

function assignGlobal(matrix) {
  const fieldCount = matrix.length;
  if (!fieldCount) {
    return [];
  }
  const labelCount = matrix[0].length;
  if (!labelCount) {
    return new Array(fieldCount).fill(-1);
  }

  let maxScore = 0;
  for (const row of matrix) {
    for (const score of row) {
      if (score > maxScore) {
        maxScore = score;
      }
    }
  }

  // The solver minimizes cost and needs rowCount <= columnCount, so pad to a
  // square matrix: real columns use cost = (maxScore - score), and any padding
  // columns get a prohibitive cost so they are never preferred.
  const size = Math.max(fieldCount, labelCount);
  const prohibitiveCost = maxScore + 1e6;
  const cost = [];
  for (let field = 0; field < fieldCount; field++) {
    const row = new Array(size);
    for (let label = 0; label < size; label++) {
      row[label] =
        label < labelCount ? maxScore - matrix[field][label] : prohibitiveCost;
    }
    cost.push(row);
  }

  const fieldToLabel = solveMinCostAssignment(cost);
  return fieldToLabel.map((label, field) =>
    label >= 0 && label < labelCount && matrix[field][label] >= MIN_SCORE
      ? label
      : -1
  );
}

/**
 * Kuhn-Munkres (Hungarian) assignment that minimizes total cost, for a cost
 * matrix with rowCount <= columnCount. Returns `rowToColumn`, where
 * rowToColumn[row] is the column assigned to that row.
 *
 * This is the O(n^3) dual-potentials + augmenting-path formulation. The
 * bookkeeping arrays are 1-based; index 0 is a sentinel that anchors each
 * augmenting search.
 */
function solveMinCostAssignment(cost) {
  const rowCount = cost.length;
  const columnCount = cost[0].length;

  // Dual potentials that keep every reduced cost non-negative.
  const rowPotential = new Array(rowCount + 1).fill(0);
  const columnPotential = new Array(columnCount + 1).fill(0);
  // columnToRow[column] = the row currently matched to `column` (0 = none).
  const columnToRow = new Array(columnCount + 1).fill(0);
  // previousColumn[column] = the column we arrived from, for path rebuilding.
  const previousColumn = new Array(columnCount + 1).fill(0);

  for (let row = 1; row <= rowCount; row++) {
    // Begin the augmenting search from the sentinel column, tied to this row.
    columnToRow[0] = row;
    let currentColumn = 0;
    const minSlack = new Array(columnCount + 1).fill(Infinity);
    const columnVisited = new Array(columnCount + 1).fill(false);

    // Grow the alternating tree until we reach an unmatched column.
    do {
      columnVisited[currentColumn] = true;
      const currentRow = columnToRow[currentColumn];
      let smallestSlack = Infinity;
      let nextColumn = -1;

      for (let column = 1; column <= columnCount; column++) {
        if (columnVisited[column]) {
          continue;
        }
        const reducedCost =
          cost[currentRow - 1][column - 1] -
          rowPotential[currentRow] -
          columnPotential[column];
        if (reducedCost < minSlack[column]) {
          minSlack[column] = reducedCost;
          previousColumn[column] = currentColumn;
        }
        if (minSlack[column] < smallestSlack) {
          smallestSlack = minSlack[column];
          nextColumn = column;
        }
      }

      // Adjust potentials by the tightest slack so a new edge becomes tight.
      for (let column = 0; column <= columnCount; column++) {
        if (columnVisited[column]) {
          rowPotential[columnToRow[column]] += smallestSlack;
          columnPotential[column] -= smallestSlack;
        } else {
          minSlack[column] -= smallestSlack;
        }
      }
      currentColumn = nextColumn;
    } while (columnToRow[currentColumn] !== 0);

    // Walk the augmenting path back to the sentinel, flipping matches.
    do {
      const cameFrom = previousColumn[currentColumn];
      columnToRow[currentColumn] = columnToRow[cameFrom];
      currentColumn = cameFrom;
    } while (currentColumn);
  }

  const rowToColumn = new Array(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column++) {
    const matchedRow = columnToRow[column];
    if (matchedRow >= 1 && matchedRow <= rowCount) {
      rowToColumn[matchedRow - 1] = column - 1;
    }
  }
  return rowToColumn;
}
