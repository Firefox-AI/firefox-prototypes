/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  CouponFollowClient,
  normalizeDomain,
} from "moz-src:///browser/components/aiwindow/models/CouponFollowClient.sys.mjs";
import {
  OUTCOME,
  ShopifyValidator,
} from "moz-src:///browser/components/aiwindow/models/ShopifyValidator.sys.mjs";
import {
  MODEL_FEATURES,
  openAIEngine,
} from "moz-src:///browser/components/aiwindow/models/Utils.sys.mjs";
import { SCOUT_RESOLVE_STORE_SYSTEM_PROMPT } from "moz-src:///browser/components/aiwindow/models/ScoutPrompts.sys.mjs";
import { ChatStore } from "moz-src:///browser/components/aiwindow/ui/modules/ChatStore.sys.mjs";
import { AssistantRoleOpts } from "moz-src:///browser/components/aiwindow/ui/modules/ChatMessage.sys.mjs";

const PHASE = Object.freeze({
  RUNNING: "running",
  COMPLETE: "complete",
  FAILED: "failed",
});

const MAX_RECOVERED_CODES = 8;
const MAX_VALIDATED_CODES = 8;
const DOMAIN_RE = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/i;

function parseScoutJson(text) {
  if (!text) {
    return null;
  }
  const withoutFence = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(withoutFence);
  } catch {}
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function formatError(error) {
  return error?.message || String(error);
}

/**
 * Coordinates coupon scout runs: recover candidate codes for a store, then
 * validate which actually work at a real cart, and report the ranked winners.
 *
 * Mirrors the ResearchAgent singleton/chat pattern. The pure scout() method is
 * also called directly by the chat assistant's scout_coupons tool.
 */
class ScoutAgentSingleton {
  #sessions = new Map();
  #couponFollow = new CouponFollowClient();
  #validator = new ShopifyValidator();

  isRunning(conversationId) {
    return this.#sessions.get(conversationId)?.phase === PHASE.RUNNING;
  }

  /**
   * Pure scout logic. Recovers candidate codes for a store and validates them.
   * Used by both the chat entry point and the scout_coupons assistant tool.
   *
   * @param {string} domain Bare store domain, e.g. "glossier.com".
   * @param {object} [options]
   * @param {(stage: object) => void} [options.onProgress]
   * @returns {Promise<object>} {
   *   domain, platform, recoveredCount, candidateCount, baselineTotal, product,
   *   valid: [{ code, savings, pct, discount }], summary
   * }
   */
  async scout(domain, { onProgress } = {}) {
    const host = normalizeDomain(domain);
    if (!host) {
      return {
        domain: "",
        platform: "unknown",
        recoveredCount: 0,
        candidateCount: 0,
        valid: [],
        summary: "No store domain was provided.",
      };
    }

    onProgress?.({ stage: "recovering", domain: host });
    const recovered = await this.#couponFollow.recoverCodes(host, {
      limit: MAX_RECOVERED_CODES,
    });
    const codes = recovered.map(entry => entry.code);
    const discountByCode = new Map(
      recovered.map(entry => [entry.code.toUpperCase(), entry.discount])
    );

    onProgress?.({
      stage: "validating",
      domain: host,
      candidateCount: codes.length,
    });
    const validation = await this.#validator.validateStore(host, codes, {
      maxCodes: MAX_VALIDATED_CODES,
    });

    const valid = validation.results
      .filter(result => result.outcome === OUTCOME.VALID)
      .map(result => ({
        code: result.code,
        savings: result.savings,
        pct: result.pct,
        discount: discountByCode.get(result.code.toUpperCase()) || "",
      }))
      .sort((a, b) => b.savings - a.savings);

    const result = {
      domain: host,
      platform: validation.platform,
      product: validation.product,
      baselineTotal: validation.baselineTotal,
      recoveredCount: recovered.length,
      candidateCount: codes.length,
      candidates: recovered,
      valid,
      summary: this.#summarize(
        host,
        validation.platform,
        recovered.length,
        valid
      ),
    };
    onProgress?.({ stage: "done", ...result });
    return result;
  }

  async submit({ conversation, text, pageUrl = null, userOpts = undefined }) {
    if (this.isRunning(conversation.id)) {
      this.#addAssistantMessage(
        conversation,
        "I am already scouting coupons for this conversation. I will update this chat when it finishes."
      );
      return { phase: PHASE.RUNNING };
    }

    const session = { phase: PHASE.RUNNING, conversation };
    this.#sessions.set(conversation.id, session);

    this.#ensureConversationTitle(conversation, text);
    this.#addUserMessage(conversation, text, pageUrl, userOpts);
    const assistantMessage = this.#addAssistantMessage(
      conversation,
      "Looking for the store to scout...",
      { complete: false }
    );

    try {
      const domain = await this.#resolveDomain(conversation, text, pageUrl);
      if (!domain) {
        this.#updateAssistantMessage(
          conversation,
          assistantMessage,
          "Tell me which store to scout (a domain like glossier.com works best) and I will find and test coupon codes for it.",
          true
        );
        await ChatStore.updateConversation(conversation);
        return { phase: PHASE.COMPLETE };
      }

      const result = await this.scout(domain, {
        onProgress: stage => {
          if (stage.stage === "recovering") {
            this.#updateAssistantMessage(
              conversation,
              assistantMessage,
              `Scouting ${domain}: recovering candidate codes...`
            );
          } else if (stage.stage === "validating") {
            this.#updateAssistantMessage(
              conversation,
              assistantMessage,
              `Recovered ${stage.candidateCount} candidate codes for ${domain}. Testing each at a real cart...`
            );
          }
        },
      });

      this.#updateAssistantMessage(
        conversation,
        assistantMessage,
        this.#renderResult(result),
        true
      );
      await ChatStore.updateConversation(conversation);
      session.phase = PHASE.COMPLETE;
      return { phase: PHASE.COMPLETE, result };
    } catch (error) {
      session.phase = PHASE.FAILED;
      this.#updateAssistantMessage(
        conversation,
        assistantMessage,
        `Coupon scout failed: ${formatError(error)}`,
        true
      );
      await ChatStore.updateConversation(conversation).catch(() => {});
      return { phase: PHASE.FAILED, error };
    } finally {
      this.#sessions.delete(conversation.id);
    }
  }

  async #resolveDomain(conversation, text, pageUrl) {
    const fromText = text.match(DOMAIN_RE)?.[1];
    if (fromText) {
      return normalizeDomain(fromText);
    }
    if (pageUrl) {
      const fromPage = normalizeDomain(pageUrl);
      if (fromPage) {
        return fromPage;
      }
    }
    try {
      const engine = await openAIEngine.build(
        MODEL_FEATURES.CHAT,
        conversation.id
      );
      const response = await this.#runModel(engine, [
        { role: "system", content: SCOUT_RESOLVE_STORE_SYSTEM_PROMPT },
        { role: "user", content: text },
      ]);
      const parsed = parseScoutJson(response) || {};
      return parsed.domain ? normalizeDomain(parsed.domain) : "";
    } catch (error) {
      console.warn("Scout store resolution failed:", error);
      return "";
    }
  }

  #summarize(domain, platform, recoveredCount, valid) {
    if (platform !== "shopify") {
      return `Recovered ${recoveredCount} candidate codes for ${domain}, but validation currently supports Shopify stores only.`;
    }
    if (valid.length) {
      const best = valid[0];
      return `Best working code for ${domain}: ${best.code} for ${best.pct}% off. ${valid.length} of ${recoveredCount} recovered codes validated.`;
    }
    return `Recovered ${recoveredCount} candidate codes for ${domain}, but none are currently valid at checkout.`;
  }

  #renderResult(result) {
    const lines = [];
    if (result.platform !== "shopify") {
      lines.push(
        `I recovered ${result.recoveredCount} candidate codes for **${result.domain}**, but I can only validate Shopify stores right now, so these are unverified:`
      );
      for (const candidate of result.candidates.slice(0, 10)) {
        lines.push(
          `- \`${candidate.code}\`${candidate.discount ? ` (${candidate.discount})` : ""}`
        );
      }
      return lines.join("\n");
    }

    if (result.valid.length) {
      lines.push(
        `Found **${result.valid.length}** working code${result.valid.length === 1 ? "" : "s"} for **${result.domain}**, tested at a real cart (of ${result.recoveredCount} recovered):`
      );
      for (const code of result.valid) {
        lines.push(`- \`${code.code}\` — $${code.savings} off (${code.pct}%)`);
      }
      return lines.join("\n");
    }

    return `I recovered ${result.recoveredCount} candidate codes for **${result.domain}** but none currently apply at checkout. Coupon codes expire fast; want me to set a monitor to recheck?`;
  }

  async #runModel(engine, messages) {
    const fxAccountToken = await openAIEngine.getFxAccountToken();
    if (!fxAccountToken) {
      throw new Error("FxA token unavailable");
    }
    const config = engine.getConfig(engine.feature);
    const inferenceParams = config?.parameters || {};
    const response = await engine.run({
      args: messages,
      fxAccountToken,
      ...inferenceParams,
    });
    return response?.finalOutput?.trim() || "";
  }

  #ensureConversationTitle(conversation, text) {
    if (!conversation.title) {
      conversation.title = `Coupon scout: ${String(text).slice(0, 40)}`;
    }
  }

  #addUserMessage(conversation, text, pageUrl, userOpts) {
    const message = conversation.addUserMessage(text, pageUrl, userOpts);
    conversation.emit("chat-conversation:message-update", message);
    return message;
  }

  #addAssistantMessage(conversation, text, { complete = true } = {}) {
    const message = conversation.addAssistantMessage(
      "text",
      text,
      new AssistantRoleOpts()
    );
    conversation.emit("chat-conversation:message-update", message);
    if (complete) {
      conversation.emit("chat-conversation:message-complete", message);
    }
    ChatStore.updateConversation(conversation).catch(() => {});
    return message;
  }

  #updateAssistantMessage(conversation, message, text, complete = false) {
    message.content.body = text;
    conversation.emit("chat-conversation:message-update", message);
    if (complete) {
      conversation.emit("chat-conversation:message-complete", message);
    }
  }
}

export const ScoutAgent = new ScoutAgentSingleton();
