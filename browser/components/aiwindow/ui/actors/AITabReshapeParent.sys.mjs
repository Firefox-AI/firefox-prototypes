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
 * Spike behavior: open the Smart Window sidebar and prefill a prompt that
 * asks the assistant to reshape the AITab in the current tab (JSON in the
 * viewer URL hash). A dedicated refine_aitab tool can take over later.
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

    const prompt = this.#buildPrompt(edit, win);

    // Open sidebar (new chat if none). Prefill without auto-submitting so the
    // user can review; chips can later pass autoSubmit once refine_aitab lands.
    await lazy.AIWindowUI.openSidebar(win, null);

    const aiWindow = await lazy.AIWindowUI.getAiWindowElement(
      win,
      win.document.getElementById(lazy.AIWindowUI.BROWSER_ID)
    );
    if (!aiWindow) {
      console.warn("AITabReshapeParent: sidebar ai-window not ready");
      return;
    }

    if (typeof aiWindow.updateInput === "function") {
      aiWindow.updateInput({ text: prompt, mentions: [] });
    }

    await lazy.AIWindowUI.focusSidebar(win);

    // Notify chrome listeners (tests / future handlers).
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

  /**
   * @param {string} edit
   * @param {Window} win
   * @returns {string}
   */
  #buildPrompt(edit, win) {
    const tabUri = win.gBrowser?.selectedBrowser?.currentURI?.spec || "";
    const hasHash = tabUri.includes("#");
    const contextLine = hasHash
      ? "The current tab is an AITab viewer page (page JSON is in the URL hash)."
      : "Use the current tab as the AITab to reshape if it is a viewer page.";

    return [
      `Reshape my current AITab: ${edit}`,
      contextLine,
      "Keep the same job and source links. Update todo/list/info/footer to match the edit.",
      "When a refine_aitab (or equivalent) tool is available, use it on the page open in my current tab and load the result in that tab.",
    ].join("\n");
  }
}
