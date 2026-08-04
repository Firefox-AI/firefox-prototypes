/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Page action / urlbar chrome for AITab / GenTab viewer tabs.
 *
 * Layout matches the Smart Window Tab mock:
 *   [✦ Smart Window Tab]  {page title}              [Generated page]
 *
 * When available, the urlbar gets [aitab-viewer] so CSS can hide the long
 * hash URL and show the page title overlay instead. Focus/type restores the
 * real URL for copy/edit.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  isAITabViewerURI:
    "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs",
  parsePageFromViewerURI:
    "moz-src:///browser/components/aiwindow/services/aitab/AITab.sys.mjs",
});

const BUTTON_ID = "gentab-button";
const BUTTON_LABEL_ID = "gentab-button-label";
const TYPE_BADGE_ID = "gentab-type-badge";
const TITLE_LABEL_ID = "gentab-title-label";
const URLBAR_ATTR = "aitab-viewer";
const DEFAULT_TITLE = "GenTab";
const MAX_TITLE_CHARS = 64;

const STATUS_L10N = {
  generating: "gentab-urlbar-status-generating",
  error: "gentab-urlbar-status-error",
  ready: "gentab-urlbar-status-generated",
};

/**
 * @param {object|null} page
 * @returns {string}
 */
function titleFromPage(page) {
  if (!page) {
    return DEFAULT_TITLE;
  }
  if (page.status === "generating") {
    const t = page.header?.title;
    if (typeof t === "string" && t.trim()) {
      return t.trim();
    }
    return "Creating…";
  }
  if (page.status === "error") {
    return "Could not create GenTab";
  }
  const title = page.header?.title;
  if (typeof title === "string" && title.trim()) {
    return title.trim();
  }
  return DEFAULT_TITLE;
}

/**
 * @param {string} title
 * @returns {string}
 */
function truncateTitle(title) {
  if (title.length <= MAX_TITLE_CHARS) {
    return title;
  }
  return `${title.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

/**
 * @param {Document} doc
 * @returns {Element|null}
 */
function ensureTitleLabel(doc) {
  let titleLabel = doc.getElementById(TITLE_LABEL_ID);
  if (titleLabel) {
    return titleLabel;
  }
  const inputBox = doc.querySelector("#urlbar .urlbar-input-box");
  if (!inputBox) {
    return null;
  }
  titleLabel = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  titleLabel.id = TITLE_LABEL_ID;
  titleLabel.className = "gentab-title-label";
  titleLabel.setAttribute("aria-hidden", "true");
  inputBox.appendChild(titleLabel);
  return titleLabel;
}

/**
 * @param {Window} window
 * @param {nsIURI} location
 */
function updateForLocation(window, location) {
  const doc = window.document;
  const button = doc.getElementById(BUTTON_ID);
  const buttonLabel = doc.getElementById(BUTTON_LABEL_ID);
  const typeBadge = doc.getElementById(TYPE_BADGE_ID);
  const urlbar = doc.getElementById("urlbar");
  const titleLabel = ensureTitleLabel(doc);
  if (!button || !buttonLabel || !typeBadge || !urlbar) {
    return;
  }

  const isViewer = lazy.isAITabViewerURI(location);
  button.hidden = !isViewer;
  typeBadge.hidden = !isViewer;
  urlbar.toggleAttribute(URLBAR_ATTR, isViewer);

  if (!isViewer) {
    if (titleLabel) {
      titleLabel.textContent = "";
      titleLabel.hidden = true;
    }
    button.removeAttribute("tooltiptext");
    return;
  }

  const page = lazy.parsePageFromViewerURI(location);
  const title = titleFromPage(page);
  const displayTitle = truncateTitle(title);

  if (titleLabel) {
    titleLabel.textContent = displayTitle;
    titleLabel.hidden = false;
  }

  const statusKey =
    page?.status === "generating" || page?.status === "error"
      ? page.status
      : "ready";
  doc.l10n?.setAttributes(buttonLabel, STATUS_L10N[statusKey]);
  button.setAttribute("tooltiptext", title);
}

/**
 * Object which handles the GenTab page action.
 */
export const GenTabPageAction = {
  /**
   * @param {DOMWindow} window
   */
  init(window) {
    if (!window.toolbar?.visible) {
      return;
    }

    const button = window.document.getElementById(BUTTON_ID);
    if (!button) {
      return;
    }

    button.addEventListener("click", this);
    button.addEventListener("keypress", this);

    window.gBrowser.addProgressListener({
      onLocationChange(aWebProgress, _aRequest, aLocation) {
        if (aWebProgress.isTopLevel) {
          updateForLocation(window, aLocation);
        }
      },
    });

    // Hash replaceState after generation does not always fire onLocationChange
    // with a new URI object; also refresh when the selected tab changes.
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      updateForLocation(window, window.gBrowser.currentURI);
    });

    updateForLocation(window, window.gBrowser.currentURI);
  },

  /**
   * @param {Event} event
   */
  handleEvent(event) {
    if (
      event.type === "keypress" &&
      event.key !== "Enter" &&
      event.key !== " "
    ) {
      return;
    }
    if (event.type === "click" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.target.ownerGlobal.gURLBar?.select();
  },
};
