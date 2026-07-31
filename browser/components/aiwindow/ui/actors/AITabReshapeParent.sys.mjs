/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AIWindowUI:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindowUI.sys.mjs",
});

/**
 * Parent actor for AITab reshape requests from content.
 *
 * Opens the Smart Window sidebar with a reshape prompt. Complete chip edits
 * auto-submit; incomplete "add …" prompts prefill only so the user can type
 * the hotel / ingredient / task name before sending.
 */
export class AITabReshapeParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name !== "AITabReshape:Request") {
      return undefined;
    }
    this.#handleReshapeRequest(data).catch(error => {
      console.error("AITabReshapeParent: reshape request failed", error);
    });
    return undefined;
  }

  /**
   * @param {{ edit?: string, label?: string, source?: string, autoSubmit?: boolean }} data
   */
  async #handleReshapeRequest(data) {
    const rawEdit = data?.edit || data?.label || "";
    if (!String(rawEdit).trim()) {
      return;
    }

    const win = this.browsingContext?.topChromeWindow;
    if (!win) {
      console.warn("AITabReshapeParent: no chrome window");
      return;
    }

    const autoSubmit = data?.autoSubmit !== false;
    // Preserve trailing space on incomplete add prompts ("Add a new hotel: ").
    const edit = autoSubmit ? String(rawEdit).trim() : String(rawEdit);
    const prompt = edit.startsWith("Reshape my AITab:")
      ? edit
      : `Reshape my AITab: ${edit}`;

    await lazy.AIWindowUI.openSidebar(win, null);

    const aiWindow = await lazy.AIWindowUI.getAiWindowElement(
      win,
      win.document.getElementById(lazy.AIWindowUI.BROWSER_ID)
    );
    if (!aiWindow) {
      console.warn("AITabReshapeParent: sidebar ai-window not ready");
      return;
    }

    if (autoSubmit && typeof aiWindow.submitChatMessage === "function") {
      aiWindow.submitChatMessage({
        text: prompt.trim(),
        submitType: "follow-up",
      });
    } else if (typeof aiWindow.updateInput === "function") {
      aiWindow.updateInput({ text: prompt, mentions: [] });
    }

    await lazy.AIWindowUI.focusSidebar(win);

    try {
      win.dispatchEvent(
        new win.CustomEvent("aitab-reshape-request", {
          bubbles: true,
          detail: {
            edit,
            label: data?.label || "",
            source: data?.source || "page",
            autoSubmit,
            tabUri: win.gBrowser?.selectedBrowser?.currentURI?.spec || "",
          },
        })
      );
    } catch (e) {
      console.warn("AITabReshapeParent: chrome event failed", e);
    }
  }
}
