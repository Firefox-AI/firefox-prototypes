/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Child actor: detect AITab reshape CustomEvents from any web page (spike).
 *
 * Content pages fire:
 *   window.dispatchEvent(new CustomEvent("AITab:Reshape", {
 *     bubbles: true,
 *     composed: true,
 *     detail: { edit: "Make vegetarian", label: "Make vegetarian" },
 *   }));
 *
 * The parent opens the sidebar assistant with a prefilled reshape prompt.
 * Prior page JSON is expected to be read from the current tab URI hash later.
 */
export class AITabReshapeChild extends JSWindowActorChild {
  /**
   * @param {CustomEvent} event
   */
  handleEvent(event) {
    if (event.type !== "AITab:Reshape") {
      return;
    }

    const detail = event.detail;
    if (!detail || typeof detail !== "object") {
      return;
    }

    // Structured-clone only plain data across the process boundary.
    let edit = "";
    if (typeof detail.edit === "string") {
      edit = detail.edit;
    } else if (typeof detail.label === "string") {
      edit = detail.label;
    }
    if (!edit.trim()) {
      return;
    }

    const payload = {
      edit: edit.trim().slice(0, 500),
      label:
        typeof detail.label === "string"
          ? detail.label.trim().slice(0, 100)
          : "",
      source:
        typeof detail.source === "string"
          ? detail.source.trim().slice(0, 40)
          : "page",
    };

    this.sendAsyncMessage("AITabReshape:Request", payload);
  }
}
