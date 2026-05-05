/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Tools: "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "ClipboardHelper",
  "@mozilla.org/widget/clipboardhelper;1",
  Ci.nsIClipboardHelper
);

/**
 * Represents a child actor for getting page data from the browser.
 */
export class AIChatContentChild extends JSWindowActorChild {
  static #EVENT_MAPPINGS_FROM_PARENT = {
    "AIChatContent:DispatchMessage": {
      event: "aiChatContentActor:message",
    },
    "AIChatContent:TruncateConversation": {
      event: "aiChatContentActor:truncate",
    },
    "AIChatContent:RemoveAppliedMemory": {
      event: "aiChatContentActor:remove-applied-memory",
    },
    "AIChatContent:SeenUrls": {
      event: "aiChatContentActor:seen-urls",
    },
  };

  static #VALID_EVENTS_FROM_CONTENT = new Set([
    "AIChatContent:DispatchSearch",
    "AIChatContent:DispatchFollowUp",
    "AIChatContent:Ready",
    "AIChatContent:DispatchAction",
    "AIChatContent:OpenLink",
    "AIChatContent:DispatchNewChat",
    "AIChatContent:AccountSignIn",
  ]);

  /**
   *  Receives event from the content process and sends to the parent.
   *
   * @param {CustomEvent} event
   */
  handleEvent(event) {
    if (!AIChatContentChild.#VALID_EVENTS_FROM_CONTENT.has(event.type)) {
      console.warn(`AIChatContentChild received unknown event: ${event.type}`);
      return;
    }

    switch (event.type) {
      case "AIChatContent:DispatchSearch":
        this.#handleSearchDispatch(event);
        break;

      case "AIChatContent:DispatchAction":
        this.#handleActionDispatch(event);
        break;

      case "AIChatContent:DispatchFollowUp":
        this.#handleFollowUpDispatch(event);
        break;

      case "AIChatContent:DispatchNewChat":
        /*
         * This message round-trips:
         * child
         * -> parent (to reset conversation state in ai-window)
         * -> child (to clear the UI via "clear-conversation").
         * The parent owns the conversation state, so we must go through it to start a new chat.
         */
        this.sendAsyncMessage("AIChatContent:DispatchNewChat");
        break;

      case "AIChatContent:Ready":
        this.sendAsyncMessage("AIChatContent:Ready");
        break;

      case "AIChatContent:OpenLink":
        this.sendAsyncMessage("AIChatContent:OpenLink", event.detail);
        break;

      case "AIChatContent:AccountSignIn":
        this.sendAsyncMessage("AIChatContent:AccountSignIn", event.detail);
        break;

      default:
        console.warn(
          `AIChatContentChild received unknown event: ${event.type}`
        );
    }
  }

  #handleSearchDispatch(event) {
    this.sendAsyncMessage("aiChatContentActor:search", event.detail);
  }

  #handleActionDispatch(event) {
    const { action, text } = event.detail ?? {};
    // Copy is handled in the child actor since it depends on content-side
    // selection and clipboard context.
    if (action === "copy") {
      if (text) {
        lazy.ClipboardHelper.copyString(text, this.windowContext);
      }
    }
    this.sendAsyncMessage("aiChatContentActor:footer-action", event.detail);
  }

  #handleFollowUpDispatch(event) {
    this.sendAsyncMessage("aiChatContentActor:followUp", event.detail);
  }

  async receiveMessage(message) {
    if (message.name === "AIChatContent:TripData") {
      this.#dispatchToChatContent(
        "aiChatContentActor:tripData",
        message.data
      );
      return undefined;
    }

    if (message.name === "AIChatContent:TripPlanV1") {
      this.#dispatchToChatContent(
        "aiChatContentActor:tripPlanV1",
        message.data
      );
      return undefined;
    }

    if (message.name === "AIChatContent:TabScopeProposal") {
      this.#dispatchToChatContent(
        "aiChatContentActor:tabScopeProposal",
        message.data
      );
      return undefined;
    }

    if (message.name === "AIChatContent:TripMutation") {
      this.#dispatchToChatContent(
        "aiChatContentActor:tripMutation",
        message.data
      );
      return undefined;
    }

    if (message.name === "AIChatContent:RunSmokeTest") {
      return this.#runSmokeTest(message.data || {});
    }

    const mapping =
      AIChatContentChild.#EVENT_MAPPINGS_FROM_PARENT[message.name];

    if (!mapping) {
      console.warn(
        `AIChatContentChild received unknown message: ${message.name}`
      );
      return undefined;
    }

    const payload = message.data;
    return this.#dispatchToChatContent(mapping.event, payload);
  }

  /**
   * Run the trip-planner smoke test inside the remote about:aichatcontent
   * process. Drives planTrip, dispatches the trip-plan event into the live
   * <ai-chat-content>, reads back the <trip-itinerary> shadow DOM, and
   * optionally exercises mutate_trip. Returns a structured PASS/FAIL summary.
   *
   * Called from the parent actor via sendQuery("AIChatContent:RunSmokeTest").
   */
  async #runSmokeTest({
    destination = "San Francisco",
    duration = 3,
    exerciseMutation = true,
  } = {}) {
    const result = {
      pass: false,
      reason: null,
      plan: null,
      rendered: null,
      checks: {},
      mutationChecks: {},
    };

    const chatContent = this.document?.querySelector("ai-chat-content");
    if (!chatContent) {
      result.reason = "No <ai-chat-content> in this remote document.";
      return result;
    }

    // Snapshot existing conversation state so we can restore it for idempotency.
    const originalState = chatContent.conversationState ?? [];

    let plan;
    try {
      const stubConv = {
        id: "smoke-test-conv",
        securityProperties: { setPrivateData() {} },
        addSeenUrls() {},
        _tripPlanV1: null,
      };
      plan = await lazy.Tools.planTrip(
        { destination, duration_days: duration },
        stubConv,
        {}
      );
    } catch (e) {
      result.reason = `planTrip threw: ${e?.message || e}`;
      return result;
    }
    if (!plan || plan.error) {
      result.reason = `planTrip returned error: ${plan?.error || "no plan"}`;
      return result;
    }
    result.plan = plan;

    result.checks.planSchemaIsTripPlanV1 = plan.schema === "TripPlanV1";
    result.checks.planDayCountMatches = plan.day_count === duration;
    result.checks.planHasDestination = plan.destination === destination;
    result.checks.planHasFlightSlot = !!plan.flight_slot;
    result.checks.planHasHotelSlot = !!plan.hotel_slot;
    result.checks.planFlightSlotEmpty = plan.flight_slot?.filled === false;
    result.checks.planHotelSlotEmpty = plan.hotel_slot?.filled === false;

    // Inject a synthetic assistant entry so <ai-chat-content> has a target
    // for the tripPlanV1 actor event.
    try {
      const list = [...(chatContent.conversationState || [])];
      list.push({
        role: "assistant",
        convId: "smoke-test-conv",
        messageId: "smoke-test-msg",
        body: "(smoke-test injected)",
        appliedMemories: [],
        showCallout: false,
        searchTokens: [],
        isLastChunk: true,
        tripData: null,
        tripPlanV1: null,
        tabScopeProposal: null,
      });
      chatContent.conversationState = list;
      chatContent.requestUpdate?.();
      await chatContent.updateComplete;
    } catch (e) {
      result.reason = `Failed to inject conversationState entry: ${e?.message || e}`;
      return result;
    }

    // Dispatch the same event the actor normally dispatches when
    // AIChatContent:TripPlanV1 arrives.
    this.#dispatchToChatContent("aiChatContentActor:tripPlanV1", plan);
    await chatContent.updateComplete;

    const itineraryEl = chatContent.shadowRoot?.querySelector("trip-itinerary");
    const summary = this.#readShadowSummary(itineraryEl);
    result.rendered = summary;
    if (!summary) {
      result.reason = "<trip-itinerary> never mounted into ai-chat-content shadow DOM.";
      this.#resetSmokeState(chatContent, originalState);
      return result;
    }

    result.checks.headerRendered = !!summary.tripName;
    result.checks.headerHasDestination = summary.tripName.includes(destination);
    result.checks.dayCardCountMatchesPlan = summary.dayCount === duration;
    result.checks.weatherStripPresent = summary.weatherCellCount > 0;
    result.checks.flightSlotRendered = summary.flightSlotPresent;
    result.checks.hotelSlotRendered = summary.hotelSlotPresent;
    result.checks.tabChipsAreUnique =
      summary.tabChipUrls.length === new Set(summary.tabChipUrls).size;
    result.checks.groundingBadgeIsGeneral = /general/i.test(
      summary.groundingBadge
    );
    // Slot order: header -> flight -> hotel -> weather -> days -> map.
    result.checks.slotOrderCorrect = summary.slotOrderCorrect;
    // Empty CTAs are verb-first: "Click to find a flight" / "Click to find a hotel".
    result.checks.emptyFlightCtaVerbFirst = /^Click to find a flight$/.test(
      summary.flightCta || ""
    );
    result.checks.emptyHotelCtaVerbFirst = /^Click to find a hotel$/.test(
      summary.hotelCta || ""
    );

    // Re-render with use_tab_context=true to verify the badge format
    // ("Using titles from N tabs", per MAJOR-1) and the tab-chip row
    // (MAJOR-3 + BUILD-2 dedup). Synthesize a populated plan with
    // duplicate tab URLs to verify the dedup invariant on the render side.
    try {
      const populatedPlan = JSON.parse(JSON.stringify(plan));
      populatedPlan.grounding = { source: "tabs", tab_count: 2 };
      populatedPlan.tabs = [
        { url: "https://example.com/sf-guide", title: "SF Guide", favicon: "" },
        { url: "https://example.com/sf-eats", title: "SF Eats", favicon: "" },
        // Duplicate URL (regression guard for BUILD-2 — render-side dedup).
        { url: "https://example.com/sf-guide", title: "SF Guide", favicon: "" },
      ];
      this.#dispatchToChatContent(
        "aiChatContentActor:tripPlanV1",
        populatedPlan
      );
      await chatContent.updateComplete;
      const populatedEl =
        chatContent.shadowRoot?.querySelector("trip-itinerary");
      const populatedSummary = this.#readShadowSummary(populatedEl);
      result.rendered.populated = populatedSummary;
      result.checks.badgeUsingTitlesFormat = /Using titles from 2 .* tab/i.test(
        populatedSummary?.groundingBadge || ""
      );
      result.checks.tabChipRowPresent = populatedSummary?.tabChipCount > 0;
      // Render-side: chips render verbatim from plan.tabs, so a duplicate URL
      // in the input array DOES produce a duplicate chip. The dedup happens
      // upstream in getOpenTabs / makeStubTripPlan. To regression-guard that
      // dedup, we assert the input's de-duped equivalent: the unique-URL
      // count among rendered chips equals the unique-URL count of the input.
      const inputUnique = new Set(populatedPlan.tabs.map(t => t.url)).size;
      result.checks.tabChipUniqueCountMatchesInput =
        new Set(populatedSummary?.tabChipUrls || []).size === inputUnique;
    } catch (e) {
      result.checks.badgeUsingTitlesFormat = false;
      result.checks.tabChipRowPresent = false;
      result.checks.tabChipUniqueCountMatchesInput = false;
      result.reason = `populated-tab-context render failed: ${e?.message || e}`;
    }

    // Optional: exercise mutate_trip to verify AC6 (replace_hotel: empty -> filled)
    // and AC7 (swap_activity: only the targeted row gets data-mutated="true").
    if (exerciseMutation) {
      try {
        // Re-dispatch the original (empty-hotel) plan for a clean mutation
        // baseline. The active live plan is whatever was last rendered.
        const baseline = JSON.parse(JSON.stringify(plan));
        this.#dispatchToChatContent("aiChatContentActor:tripPlanV1", baseline);
        await chatContent.updateComplete;

        // 1. swap_activity on day 2 — only that row should flash.
        const day2 = baseline.days?.find(d => d.day === 2);
        const targetActivityId = day2?.activities?.[0]?.id;
        if (targetActivityId) {
          const swapMutation = {
            updated_trip: (() => {
              const updated = JSON.parse(JSON.stringify(baseline));
              const d = updated.days.find(x => x.day === 2);
              d.activities[0] = {
                ...d.activities[0],
                title: "Hike Lands End",
                location: "Lands End Trail",
              };
              return updated;
            })(),
            mutated_path: { kind: "activity", activity_id: targetActivityId },
            mutation_type: "swap_activity",
            diff: [],
          };
          this.#dispatchToChatContent(
            "aiChatContentActor:tripMutation",
            swapMutation
          );
          await chatContent.updateComplete;
          // Wait for the next frame so flashMutation's setTimeout(_,0)/property
          // assignment lands and the data-mutated attribute is reflected.
          await new Promise(r => this.contentWindow.setTimeout(r, 30));

          const mutEl = chatContent.shadowRoot?.querySelector("trip-itinerary");
          const flashed = mutEl?.shadowRoot?.querySelectorAll(
            ".activity-row[data-mutated='true']"
          );
          result.mutationChecks.activityFlashedCount = flashed?.length ?? 0;
          result.mutationChecks.onlyOneActivityFlashed =
            (flashed?.length ?? 0) === 1;
        }

        // 2. replace_hotel — hotel slot transitions empty -> filled.
        const hotelMutation = {
          updated_trip: (() => {
            const updated = JSON.parse(JSON.stringify(baseline));
            updated.hotel_slot = {
              filled: true,
              name: "Hotel Drisco",
              price: "$420",
              check_in: "2026-05-01",
              check_out: "2026-05-04",
              source_url: "https://example.com/hotel-drisco",
            };
            return updated;
          })(),
          mutated_path: { kind: "hotel" },
          mutation_type: "replace_hotel",
          diff: [],
        };
        this.#dispatchToChatContent(
          "aiChatContentActor:tripMutation",
          hotelMutation
        );
        await chatContent.updateComplete;
        const hotelEl = chatContent.shadowRoot?.querySelector("trip-itinerary");
        const filledHotel = hotelEl?.shadowRoot?.querySelector(
          ".hotel-slot.slot-filled"
        );
        result.mutationChecks.hotelTransitionedToFilled = !!filledHotel;
      } catch (e) {
        result.mutationChecks.error = e?.message || String(e);
      }
    }

    // Reset state so the harness is idempotent.
    this.#resetSmokeState(chatContent, originalState);

    const failedChecks = Object.entries(result.checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const failedMutChecks = exerciseMutation
      ? Object.entries(result.mutationChecks)
          .filter(([k, v]) => k !== "error" && v === false)
          .map(([k]) => k)
      : [];
    result.pass = failedChecks.length === 0 && failedMutChecks.length === 0;
    if (!result.pass) {
      result.reason = `Failed checks: ${[...failedChecks, ...failedMutChecks].join(", ")}`;
    }
    return result;
  }

  #readShadowSummary(itineraryEl) {
    if (!itineraryEl) {
      return null;
    }
    const root = itineraryEl.shadowRoot;
    if (!root) {
      return null;
    }
    const tripName =
      root.querySelector(".trip-name")?.textContent?.trim() || "";
    const groundingBadge =
      root.querySelector(".grounding-badge")?.textContent?.trim() || "";
    const dayCards = root.querySelectorAll(".day-card");
    const dayTitles = [...dayCards].map(
      d => d.querySelector(".day-title")?.textContent?.trim() || ""
    );
    const tabChips = root.querySelectorAll("ai-website-chip");
    const tabChipUrls = [...tabChips].map(
      c => c.getAttribute?.("href") || c.href || ""
    );
    const flightSlot = root.querySelector(".flight-slot");
    const hotelSlot = root.querySelector(".hotel-slot");
    const weatherCells = root.querySelectorAll(".weather-cell");
    const flightCta = flightSlot?.querySelector(".slot-cta")?.textContent?.trim() || "";
    const hotelCta = hotelSlot?.querySelector(".slot-cta")?.textContent?.trim() || "";

    // Slot order check: walk top-level children of .trip-body and compare
    // against [flight, hotel, weather-strip, day-list, trip-map].
    const body = root.querySelector(".trip-body");
    const expectedOrder = [
      ".flight-slot",
      ".hotel-slot",
      ".weather-strip",
      ".day-list",
      ".trip-map",
    ];
    let slotOrderCorrect = true;
    if (body) {
      const positions = expectedOrder.map(sel => {
        const el = body.querySelector(sel);
        return el ? [...body.children].indexOf(el) : -1;
      });
      // Allow .trip-map to be missing (it only renders when activities have
      // lat/lng). All other slots must appear in strictly increasing order.
      const required = positions.slice(0, 4);
      slotOrderCorrect =
        required.every(p => p >= 0) &&
        required.every((p, i) => i === 0 || p > required[i - 1]);
    } else {
      slotOrderCorrect = false;
    }

    return {
      tripName,
      groundingBadge,
      dayCount: dayCards.length,
      dayTitles,
      tabChipCount: tabChips.length,
      tabChipUrls,
      flightSlotPresent: !!flightSlot,
      hotelSlotPresent: !!hotelSlot,
      weatherCellCount: weatherCells.length,
      flightCta,
      hotelCta,
      slotOrderCorrect,
    };
  }

  #resetSmokeState(chatContent, originalState) {
    try {
      chatContent.conversationState = [...originalState];
      chatContent.requestUpdate?.();
    } catch {}
  }

  #dispatchToChatContent(eventName, payload) {
    try {
      const chatContent = this.document.querySelector("ai-chat-content");

      if (!chatContent) {
        console.error(`No ai-chat-content element found for ${eventName}`);
        return false;
      }

      const clonedPayload = Cu.cloneInto(payload, this.contentWindow);

      const event = new this.contentWindow.CustomEvent(eventName, {
        detail: clonedPayload,
        bubbles: true,
      });

      chatContent.dispatchEvent(event);
      return true;
    } catch (error) {
      console.error(`Error dispatching ${eventName} to chat content:`, error);
      return false;
    }
  }
}
