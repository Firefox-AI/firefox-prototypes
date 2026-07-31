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
 * Opens the Smart Window sidebar and submits a short prompt that should
 * call refine_aitab (reads page JSON from the current tab URI hash, reloads
 * the same tab with the updated page).
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
   * @param {{ edit?: string, label?: string, source?: string }} data
   */
  async #handleReshapeRequest(data) {
    const edit = (data?.edit || data?.label || "").trim();
    if (!edit) {
      return;
    }

    const win = this.browsingContext?.topChromeWindow;
    if (!win) {
      console.warn("AITabReshapeParent: no chrome window");
      return;
    }

    // Keep the selected content tab (AITab viewer) focused so refine_aitab
    // can read its URL hash — openSidebar must not steal the selected tab.
    const prompt = `Reshape my AITab: ${edit}`;

    await lazy.AIWindowUI.openSidebar(win, null);

    const aiWindow = await lazy.AIWindowUI.getAiWindowElement(
      win,
      win.document.getElementById(lazy.AIWindowUI.BROWSER_ID)
    );
    if (!aiWindow) {
      console.warn("AITabReshapeParent: sidebar ai-window not ready");
      return;
    }

    if (typeof aiWindow.submitChatMessage === "function") {
      aiWindow.submitChatMessage({
        text: prompt,
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
            tabUri: win.gBrowser?.selectedBrowser?.currentURI?.spec || "",
          },
        })
      );
    } catch (e) {
      console.warn("AITabReshapeParent: chrome event failed", e);
    }
  }
}
