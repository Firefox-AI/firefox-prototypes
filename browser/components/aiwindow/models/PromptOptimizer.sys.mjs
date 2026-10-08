/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/**
 * ===================================================================
 * ARCHITECTURE ROADMAP: The Compaction Waterfall
 * ===================================================================
 * This module prevents LLM context window collapse and reduces TTFT
 * (Time-To-First-Token) latency by deterministically compacting massive
 * background tool payloads before they are dispatched to the API.
 * * Planned Stages:
 * - Stage 1 (Active): ID-Based Upsert. Deduplicates repetitive get_page_content reads.
 * - Stage 2 (Planned): Proportional Bottom-Up Shave. Truncates old page content/Search payloads.
 * - Stage 3 (Planned): Copy-Paste Tax. Truncates massive old user queries.
 * - Stage 4 (Planned): LRU Eviction. Drops oldest conversation turns as a failsafe.
 * ===================================================================
 */

import { isFollowUpRead } from "moz-src:///browser/components/aiwindow/models/PageContentChunker.sys.mjs";

/**
 * Scans the conversation history, tracks the latest fetch for each URL, and
 * replaces older redundant page content with a lightweight placeholder.
 *
 * CRITICAL ASSUMPTION: This logic relies on an implicit contract with the
 * `get_page_content` tool. It assumes the tool returns a JSON-stringified array
 * of text contents that strictly matches the exact index order and length of
 * the requested `url_list` arguments.
 *
 * @param {Array<object>} messages - The caller-owned history array, compacted in place.
 * @returns {Array<object>} The same array, with compacted get_page_content payloads.
 */
function deduplicatePageContent(messages) {
  const callIdToUrls = new Map();
  const urlToCallIds = new Map();
  const pageContents = new Map();

  // PASS 1: Match the Assistant's requests to completed page-content responses.
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        if (
          toolCall.type === "function" &&
          toolCall.function?.name === "get_page_content"
        ) {
          try {
            const args = JSON.parse(toolCall.function.arguments);

            if (Array.isArray(args.url_list)) {
              // Map the Call ID to the ordered array of URLs it requested
              callIdToUrls.set(toolCall.id, args.url_list);
            }
          } catch (error) {
            console.warn(
              "SmartWindow: Failed to parse get_page_content arguments during compaction.",
              error
            );
          }
        }
      }
    } else if (
      msg.role === "tool" &&
      msg.name === "get_page_content" &&
      msg.tool_call_id
    ) {
      const requestedUrls = callIdToUrls.get(msg.tool_call_id);

      if (requestedUrls) {
        try {
          // The get_page_content tool returns a JSON stringified array of text blocks
          const contentArray = JSON.parse(msg.content);

          if (
            Array.isArray(contentArray) &&
            contentArray.length === requestedUrls.length
          ) {
            pageContents.set(msg, contentArray);
            // Every read of each URL in order, so a follow-up read can keep the
            // reads it continues.
            contentArray.forEach((textContent, index) => {
              if (typeof textContent === "string" && textContent.trim()) {
                const url = requestedUrls[index];
                urlToCallIds.set(url, [
                  ...(urlToCallIds.get(url) ?? []),
                  { callId: msg.tool_call_id, textContent },
                ]);
              }
            });
          }
        } catch (error) {
          console.warn(
            `SmartWindow: Failed to parse tool content for ID ${msg.tool_call_id}.`,
            error
          );
        }
      }
    }
  }

  // Keep the latest read of each URL, plus the earlier reads that a follow-up
  // read continues, since it skips what those already showed.
  const keptReads = new Set();
  for (const [url, reads] of urlToCallIds) {
    for (let i = reads.length - 1; i >= 0; i--) {
      keptReads.add(`${reads[i].callId} ${url}`);
      if (!isFollowUpRead(reads[i].textContent)) {
        break;
      }
    }
  }

  // PASS 2: Execute the replacement on the Tool responses
  for (const [msg, contentArray] of pageContents) {
    const requestedUrls = callIdToUrls.get(msg.tool_call_id);
    const compactedContentArray = contentArray.map((textContent, index) => {
      // Relies on the assumption that contentArray[index] maps perfectly to requestedUrls[index]
      const url = requestedUrls[index];

      // If we tracked this URL and no longer need this read, drop the heavy text
      if (
        url &&
        urlToCallIds.has(url) &&
        !keptReads.has(`${msg.tool_call_id} ${url}`)
      ) {
        return `[System Note: Content omitted for ${url}. A fresher read occurs later in context.]`;
      }

      return textContent;
    });

    msg.content = JSON.stringify(compactedContentArray);
  }

  return messages;
}

/**
 * MAIN ENTRY POINT
 * Orchestrates the prompt compaction waterfall.
 *
 * Compacts in place: callers must pass a wire-format snapshot they own, such as
 * the freshly built array from Conversation.getMessagesInChatCompletionsFormat.
 * Stages may reassign top-level message fields, but values reached *through*
 * those fields (content objects, tool_calls) still alias live UI state, so they
 * must be replaced rather than mutated.
 *
 * @param {Array<object>} rawMessages - A caller-owned wire-format history array.
 * @returns {Array<object>} The optimized array ready to be sent to the LLM API.
 */
export function compactMessages(rawMessages) {
  try {
    // Stage 1: Deduplication (Always runs, zero semantic loss)
    let compactedMessages = deduplicatePageContent(rawMessages);

    // Future stages (Threshold checking, proportional shaving) will be injected here

    return compactedMessages;
  } catch (error) {
    console.error(
      "SmartWindow: Prompt compaction failed. Falling back to raw messages.",
      error
    );
    return rawMessages;
  }
}
