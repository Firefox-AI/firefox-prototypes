/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  BROWSER_CLICK,
  BROWSER_FIND_TEXT,
  BROWSER_NAVIGATE,
  BROWSER_OPEN_TAB,
  BROWSER_SCROLL,
  BROWSER_STATE,
  BROWSER_TYPE,
} from "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";

const ROUTE_CRITERIA = {
  [BROWSER_OPEN_TAB]:
    "Open an explicitly requested HTTP or HTTPS URL in a new tab.",
  [BROWSER_STATE]:
    "Read the current page, inspect its controls, or report what is available.",
  [BROWSER_FIND_TEXT]:
    "Find and visibly highlight specific text on the current page.",
  [BROWSER_NAVIGATE]:
    "Navigate the current tab to an explicitly requested HTTP or HTTPS URL.",
  [BROWSER_SCROLL]:
    "Scroll the current page in a direction or to a page boundary.",
  [BROWSER_CLICK]:
    "Click or activate a visible control, link, button, checkbox, radio button, or tab.",
  [BROWSER_TYPE]:
    "Type, enter, append, or replace text in an editable page control.",
};

const SCROLL_CRITERIA = {
  up: "Scroll toward the top by part of a viewport.",
  down: "Scroll toward the bottom by part of a viewport.",
  left: "Scroll horizontally toward the left.",
  right: "Scroll horizontally toward the right.",
  top: "Jump all the way to the top of the page.",
  bottom: "Jump all the way to the bottom of the page.",
};

function choiceQuestion(instructions, criteria) {
  return { type: "choice", instructions, criteria };
}

function extractURLs(value) {
  const matches = String(value).match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const urls = [];
  for (const match of matches) {
    const candidate = match.replace(/[),.;!?]+$/g, "");
    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !urls.includes(url.href)
      ) {
        urls.push(url.href);
      }
    } catch {}
  }
  return urls;
}

function extractQuotedText(value) {
  const matches = [];
  const pattern = /"([^"]+)"|'([^']+)'|`([^`]+)`|“([^”]+)”|‘([^’]+)’/g;
  for (const match of String(value).matchAll(pattern)) {
    const text = match.slice(1).find(Boolean)?.trim();
    if (text && !matches.includes(text)) {
      matches.push(text);
    }
  }
  return matches;
}

function extractFindText(value) {
  const quoted = extractQuotedText(value);
  if (quoted.length === 1) {
    return quoted[0];
  }
  return (
    String(value)
      .match(
        /(?:find|locate|highlight|search(?: the page)? for)\s+(?:the\s+(?:text|phrase)\s+)?(.+)$/i
      )?.[1]
      ?.trim() ?? ""
  );
}

function extractTypedText(value) {
  const quoted = extractQuotedText(value);
  if (quoted.length === 1) {
    return quoted[0];
  }
  return (
    String(value)
      .match(
        /(?:type|enter|input|fill(?: in)?)\s+(.+?)(?:\s+(?:into|in)\s+.+)?$/i
      )?.[1]
      ?.trim() ?? ""
  );
}

function extractScrollAmount(value) {
  const amount = Number(String(value).match(/\b(\d{1,4})\b/)?.[1]);
  return Number.isFinite(amount) && amount >= 1 && amount <= 5000
    ? amount
    : undefined;
}

/** Grounds one model-planned browser instruction in Firefox browser tools. */
export class JevBrowserEngine {
  #apiKey;
  #endpoint;
  #fetch;

  constructor({
    apiKey = Services.env.get("TYPESAFE_KEY"),
    endpoint = TYPESAFE_ENDPOINT,
    fetchImpl = fetch,
  } = {}) {
    this.#apiKey = apiKey;
    this.#endpoint = endpoint;
    this.#fetch = fetchImpl;
  }

  async #evaluate(state, questions, signal) {
    if (!this.#apiKey) {
      const error = new Error("TYPESAFE_KEY is not set.");
      error.clientReason = "jevMissingApiKey";
      throw error;
    }

    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: TYPESAFE_MODEL, state, questions }),
      signal,
    });

    if (!response.ok) {
      const error = new Error(
        `TypeSafe request failed with HTTP ${response.status}.`
      );
      error.status = response.status;
      error.clientReason = "jevApiFailure";
      throw error;
    }

    const payload = await response.json();
    if (!payload?.answers || typeof payload.answers !== "object") {
      const error = new Error("TypeSafe returned an invalid response.");
      error.clientReason = "jevInvalidResponse";
      throw error;
    }
    return payload.answers;
  }

  #createRouteQuestions(request) {
    const questions = {
      route: choiceQuestion(
        "Which single Firefox browser function best fulfills the user's request?",
        ROUTE_CRITERIA
      ),
      scroll_direction: choiceQuestion(
        "If this is a scroll request, which direction or boundary did the user request?",
        SCROLL_CRITERIA
      ),
      replace_text: {
        type: "noul",
        instructions:
          "If this is a typing request, should the new text replace the control's existing value instead of being appended?",
      },
    };

    const urls = extractURLs(request);
    if (urls.length > 1) {
      questions.url_target = choiceQuestion(
        "Which exact URL did the user ask Firefox to open or navigate to?",
        Object.fromEntries(urls.map((url, index) => [`url_${index}`, url]))
      );
    }

    const quoted = extractQuotedText(request);
    if (quoted.length > 1) {
      questions.text_target = choiceQuestion(
        "Which exact quoted string is the text to find or enter, rather than the name of a page control?",
        Object.fromEntries(quoted.map((text, index) => [`text_${index}`, text]))
      );
    }

    return { questions, urls, quoted };
  }

  #selectedCandidate(answer, candidates, prefix) {
    const index = Number(answer?.choice?.replace(`${prefix}_`, ""));
    return Number.isInteger(index) ? candidates[index] : undefined;
  }

  #buildToolParameters(route, request, routeAnswers, { urls, quoted }) {
    const selectedURL =
      this.#selectedCandidate(routeAnswers.url_target, urls, "url") ??
      urls[0] ??
      "";
    const selectedText = this.#selectedCandidate(
      routeAnswers.text_target,
      quoted,
      "text"
    );

    switch (route) {
      case BROWSER_OPEN_TAB:
      case BROWSER_NAVIGATE:
        return { url: selectedURL };
      case BROWSER_FIND_TEXT:
        return {
          text: selectedText ?? extractFindText(request),
          case_sensitive: /\bcase[- ]sensitive\b/i.test(request),
          whole_word: /\bwhole[- ]word\b/i.test(request),
        };
      case BROWSER_SCROLL: {
        const amount = extractScrollAmount(request);
        return {
          direction: routeAnswers.scroll_direction?.choice ?? "down",
          ...(amount === undefined ? {} : { amount }),
        };
      }
      default:
        return {};
    }
  }

  async #selectElement(request, action, state, routeAnswers, signal) {
    const elements = (state.elements ?? []).filter(element =>
      element.actions?.includes(action === BROWSER_TYPE ? "type" : "click")
    );
    if (!elements.length) {
      return { error: "No matching interactive elements are available." };
    }

    const criteria = Object.fromEntries(
      elements.map(element => [
        element.ref,
        {
          role: element.role,
          name: element.name,
          actions: element.actions,
          in_viewport: element.inViewport,
        },
      ])
    );
    const answers = await this.#evaluate(
      { request, page: { title: state.title, url: state.url } },
      {
        target_element: choiceQuestion(
          `Which page element should Firefox ${action === BROWSER_TYPE ? "type into" : "click"} to fulfill the user's request?`,
          criteria
        ),
      },
      signal
    );
    const ref = answers.target_element?.choice;
    if (!elements.some(element => element.ref === ref)) {
      return { error: "TypeSafe did not select a valid page element." };
    }

    const parameters = {
      tab_id: state.tab_id,
      snapshot_id: state.snapshot_id,
      ref,
    };
    if (action === BROWSER_TYPE) {
      const quoted = extractQuotedText(request);
      parameters.text =
        this.#selectedCandidate(
          routeAnswers.text_target,
          quoted,
          "text"
        ) ?? extractTypedText(request);
      parameters.replace = (routeAnswers.replace_text?.noul ?? 1) >= 0.5;
    }
    return { parameters };
  }

  async execute({ instruction, dispatchTool, signal } = {}) {
    const request = String(instruction ?? "").trim();
    if (!request || request.length > 2000) {
      const error = new Error(
        "Jev requires a browser-action instruction of 1 to 2000 characters."
      );
      error.clientReason = "jevInvalidInstruction";
      throw error;
    }
    if (typeof dispatchTool !== "function") {
      throw new TypeError("Jev requires a browser-tool dispatcher.");
    }

    const candidates = this.#createRouteQuestions(request);
    const routeAnswers = await this.#evaluate(
      { request },
      candidates.questions,
      signal
    );

    const route = routeAnswers.route?.choice;
    if (!Object.hasOwn(ROUTE_CRITERIA, route)) {
      const error = new Error("TypeSafe did not select a valid browser route.");
      error.clientReason = "jevInvalidRoute";
      throw error;
    }
    const confidence = routeAnswers.route.confidence;
    let parameters;

    if (route === BROWSER_CLICK || route === BROWSER_TYPE) {
      const state = await dispatchTool(BROWSER_STATE, {});
      if (state?.status !== "ok") {
        return {
          status: state?.status ?? "error",
          action: BROWSER_STATE,
          confidence,
          result: state,
        };
      }
      const selection = await this.#selectElement(
        request,
        route,
        state,
        routeAnswers,
        signal
      );
      if (selection.error) {
        return {
          status: "error",
          action: route,
          confidence,
          error: selection.error,
        };
      }
      parameters = selection.parameters;
    } else {
      parameters = this.#buildToolParameters(
        route,
        request,
        routeAnswers,
        candidates
      );
    }

    const result = await dispatchTool(route, parameters);
    return {
      status: result?.status ?? (result?.error ? "error" : "ok"),
      action: route,
      confidence,
      result,
    };
  }
}
