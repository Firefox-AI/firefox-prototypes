# Trip Planner — Lightweight Brief

**Owner:** Jolie · **Last updated:** 2026-05-05 · **Status:** Prototype shipped (v1.7), ready for demo

## 1. Problem

Planning a multi-day trip means juggling tabs across Google Flights, Booking, Airbnb, TripAdvisor, Reddit, weather sites, and notes. Existing AI chatbots can answer questions but don't *organize* — the user still has to copy-paste, re-summarize, and lose track of what they decided. There's no single artifact a traveler can open, share, and iterate on.

## 2. Opportunity

Smart Window already has the user's open tabs, browsing history, and an LLM. We can turn that context into a **structured, persistent trip plan** that lives as a chrome page, stays anchored to the assistant chat, and updates conversationally. The plan becomes the source of truth; the chat is the editor.

## 3. Goals

- **G1.** A user can go from "plan a 3-day trip to NYC" to a fully-populated trip page in under 10 seconds.
- **G2.** The plan covers everything a traveler tracks: weather, flights, hotels, day-by-day itinerary, budget, packing list.
- **G3.** Every section can be edited via chat. The page reflects edits in <1 second.
- **G4.** When the LLM is slow or unreliable, the most common edits ("swap day N to X") still work deterministically.

## 4. Non-goals

- Real bookings, payments, or affiliate flows.
- Multi-trip dashboard / saved-trips library (one active trip at a time).
- Server-side sync. Plan lives in a local pref; cross-device sync is out of scope.
- Replacing dedicated travel apps. This is a planning + iteration surface, not a booking engine.

## 5. User scenarios

1. **Cold start.** Jolie types "plan a week trip to NYC for 2 adults in June" in Smart Window. The assistant calls `generate_travel_plan`. A new chrome tab opens at `tripPlan.html` showing destination, weather, flight, hotel, 7-day itinerary, budget, packing. The full-page assistant collapses to a sidebar that's anchored to the plan.
2. **Iterate via chat.** From the sidebar, Jolie types "swap day 1 to upper west side". The day card on the page updates instantly. She types "update my hotel to https://www.expedia.com/...The-Plaza..." — the hotel card swaps with the Plaza's hero image and a working "View on expedia.com" link.
3. **History-aware lodging.** Jolie says "I'm staying in an airbnb in Shibuya." The assistant searches the last 30 days of her browsing history for `airbnb.com` pages, lists 3 candidates, and on her pick fills the hotel slot.
4. **Tab-group convenience.** All travel-related tabs (Booking, TripAdvisor, theplazany.com, the new plan tab) end up in a "Trip: New York City" tab group.
5. **Download & share.** Jolie clicks "Download Trip Plan" — a self-contained HTML snapshot with everything needed to reference offline.

## 6. Functional requirements

### 6.1 Generation

- **F1.** `generate_travel_plan` tool accepts a permissive `{plan: {destination, nights, adults, ...}}` and never errors. Missing destination → tool inherits from the existing live plan if present (no-clobber merge).
- **F2.** When the LLM doesn't supply a section, the tool **mocks**:
  - **Weather** — live Open-Meteo geocode + forecast (no auth, 3s timeout). Returns `{condition, temp_high, temp_low, season_note, forecast: [5 days]}`. Falls back to empty on rate-limit/offline.
  - **Flight** — destination-aware mock: United UA1116 SFO→{LGA/JFK/SFO/NRT/...} with confirmation, duration, fare, terminal, gate.
  - **Hotel** — NYC defaults to The Plaza with full Expedia booking URL (check-in/check-out params), Wikimedia hero image, and "View on expedia.com" link. Background OG-meta fetch can upgrade the image if the booking site responds.
  - **Itinerary** — 3-6 timed activities per day from a destination-keyed pool (NYC: Russ & Daughters, the Met, Broadway, Brooklyn Bridge, etc.; SF, Tokyo, generic each have their own pool).
  - **Budget** — six-line breakdown (Flights / Hotel / Food / Transit / Activities / Misc) with destination-tiered per-night rates. Total set 12% above estimate so the user reads as under budget.
  - **Packing** — 5 categories (Documents, Clothing, Toiletries, Electronics, Day bag) with ~25 items, scaled to nights and biased warm/cold by destination.
- **F3.** Output the plan to **two surfaces in sync**: (a) the chrome page `tripPlan.html`, (b) the in-chat `<trip-itinerary>` artifact.

### 6.2 Hand-off

- **F4.** When `generate_travel_plan` runs from the full-page Smart Window, the conversation moves to the right-side sidebar via `AIWindow.moveConversationToSidebar(...)`. The original full-page tab is closed so there is one chat surface, not two.
- **F5.** No split view — the trip plan tab opens selected, full-width.
- **F6.** Travel-related tabs (`TRAVEL_DOMAIN_ALLOWLIST` + destination keyword) plus the plan tab are grouped under `Trip: <destination>` (blue).

### 6.3 Iteration

- **F7.** `mutate_trip` tool covers eight mutation types: `swap_activity`, `replace_day`, `replace_hotel`, `replace_flight`, `clear_hotel`, `clear_flight`, `reorder_days`, `change_duration`.
- **F8.** Every mutation writes to **both** v1 (`plan.days[]`, `plan.hotel_slot`, `plan.flight_slot`) and v0 (`plan.itinerary[]`, `plan.hotels[]`, `plan.flights[]`) shapes so the chrome page and in-chat artifact both reflect changes.
- **F9.** Local-edit shortcut in `ai-window.mjs::submitChatMessage`: text matching `/^(swap|change|make|set|rename|update)\s+day\s+(\d+)\s+(to|...)\s+(.+?)/i` notifies a chrome-process observer that runs `mutate_trip { replace_day }` directly, **without invoking the LLM**. End-to-end latency <1s. Verified across Day 1/3/5 swaps in Marionette tests.
- **F10.** `replace_hotel` with a `source_url` triggers a background OG-metadata fetch (3s timeout, desktop Chrome User-Agent). On success the hotel card upgrades to the booking site's hero image and canonical title.
- **F11.** New conversation hydration: when a fresh sidebar conversation opens, `_tripPlanV1` is hydrated from `browser.smartwindow.tripPlanData` so `mutate_trip` works against the open plan even from a brand-new chat.

### 6.4 History-aware hotel pick

- **F12.** `lookup_lodging_history` tool scans local Places for visits in the last 30 days, filtered by domain inferred from the user's wording ("airbnb" → `airbnb.com`; brand → that brand; generic → full lodging allowlist). Returns up to 5 ranked matches.
- **F13.** Privacy: the query stays in the chrome process. URLs aren't echoed to the LLM directly — only the user-visible summary.

## 7. Surfaces

### 7.1 Chrome page (`tripPlan.html`)

Tabs: **Overview** (weather + 5-day forecast strip + info tiles + Flights inline + Hotels inline + alerts), **Itinerary** (collapsible day cards), **Budget**, **Packing**.

- Flight card: airline logo, name + flight #, status pill, large times with dates, IATA route line, two-column details grid (Confirmation / Amenities, Duration / Terminal, Fare / Gate, Class), price.
- Hotel card: hero image (180px), accommodation tag + rating, name as link to `source_url`, address, check-in/check-out, "View on expedia.com" link with arrow icon.
- Weather card: emoji + condition + H/L + season note, plus a 5-cell forecast strip.

### 7.2 Sidebar chat

Standard Smart Window chat. New system prompt explains: when the user iterates, call `mutate_trip` (NOT `generate_travel_plan`), pick the right `mutation_type`, acknowledge in one short sentence.

### 7.3 In-chat artifact (`<trip-itinerary>`)

Same plan, compact rendering for the in-chat preview path (`plan_trip` v1 tool). Stays in sync via the propagation hook.

## 8. Architecture (high-level)

| Layer | Files |
|---|---|
| Tool definitions + handlers | `models/Tools.sys.mjs` (`generate_travel_plan`, `plan_trip`, `mutate_trip`, `lookup_lodging_history`, `propose_tab_scope`, `open_search_split_view`) |
| Tool dispatch + LLM | `models/Chat.sys.mjs` |
| Conversation hydration + system prompts | `ui/modules/ChatConversation.sys.mjs` |
| Local-edit shortcut | `ui/components/ai-window/ai-window.mjs::#tryLocalTripEdit` |
| Local-edit observer | `models/Tools.sys.mjs::registerTripEditObserver` (topic: `smartwindow-trip-edit`) |
| Plan persistence | pref `browser.smartwindow.tripPlanData` + obs topic `trip-plan-data-updated` |
| Chrome page | `ui/content/tripPlan.html` (vanilla JS, observes the pref) |
| In-chat artifact | `ui/components/trip-itinerary/`, `ui/components/trip-artifact/` |
| Places lookup | `models/HistoryQuery.sys.mjs` |

## 9. Acceptance criteria (for QA)

1. "plan a 3-day trip to NYC for 2 adults" → plan tab opens with weather, flight, Plaza hotel + image, 3 days × 3-6 activities, budget breakdown, packing list. <10s end-to-end.
2. From sidebar, "swap day 1 to upper east side" → day 1 title changes to "Upper East Side" in <1s. Works without the local MLEngine.
3. "update my hotel to https://www.expedia.com/...The-Plaza..." → hotel card updates with The Plaza, dates, link to the dated booking URL, image (Wikimedia fallback if Expedia rate-limits OG).
4. "I'm staying in an airbnb in Shibuya" → assistant lists candidate Airbnb URLs from last 30 days of history, OR asks for a URL if none found.
5. After Generate, exactly **one** chat surface (the sidebar) and **one** plan tab; no split view; no orphan full-page AI Window tab.
6. The "Trip: <destination>" tab group contains the plan tab + travel-related research tabs.
7. No fabricated specifics from the LLM that weren't in the user's input — mocks come from the data layer (clearly tagged `mocked: true`), the LLM is told not to invent.

## 10. Known limitations / open issues

- **MLEngine worker stability.** The local LLM worker crashes intermittently with `Internal error: worker terminated`. Free-form chat is affected; the local-edit shortcut bypasses this for the most common iterations. Tracked separately as infrastructure.
- **OG-fetch fragility.** Expedia, Airbnb, Booking aggressively rate-limit chrome-process scrapes. The Wikimedia fallback covers The Plaza; other hotels rely on the OG fetch succeeding.
- **No activity regeneration on `replace_day`.** Local-edit shortcut only swaps the day title; activities stay intact. A fuller theme→activities mapping is a follow-up.
- **Single active trip.** Generating a new plan overwrites the live pref (with a no-clobber guard against empty calls). Multi-trip storage is deferred.
- **v0 / v1 dual shape.** `mutate_trip` writes both shapes; this works but is the largest source of complexity. A unified shape would simplify.

## 11. Out-of-scope (deferred)

- Real-time price updates, calendar integration, contact-sharing.
- Map view of itinerary stops.
- Group trips (multiple participants editing one plan).
- Mobile / Android.

## 12. References

- Spec: `_prototype/2026-04-26-trip-planner/spec.md`
- Build reports: `_prototype/2026-04-26-trip-planner/build-report-{1..7}.md`
- QA screenshots: `_prototype/2026-04-26-trip-planner/screenshots/qa-final-*.png`
- Worktree: `worktrees/assistant-travel-planner-v2`, branch `trip-planner-v1-build`
