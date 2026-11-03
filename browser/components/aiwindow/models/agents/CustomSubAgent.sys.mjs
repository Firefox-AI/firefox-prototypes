/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChatConversation } from "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs";
import { Conversation, MESSAGE_ROLE } from "moz-src:///browser/components/aiwindow/models/Conversation.sys.mjs";
import { createParserState, flushTokenRemainder } from "moz-src:///browser/components/aiwindow/models/TokenStreamParser.sys.mjs";
import { AuthProvider } from "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs";
import { expandUrlTokensInToolParams } from "moz-src:///browser/components/aiwindow/models/ChatUtils.sys.mjs";
import {
  SUB_AGENT_TOOLS,
  SEARCH_THE_WEB,
  GET_USER_MEMORIES,
  CREATE_SUB_AGENT,
} from "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs";
import { runSearchTheWeb } from "moz-src:///browser/components/aiwindow/models/search/SearchWorkflow.sys.mjs";
import { ContextualIdentityService } from "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  SubAgentBrowser,
  SUB_AGENT_BROWSER_PROMPT,
  SUB_AGENT_BROWSER_TOOLS,
  subAgentBrowserToolsConfig,
} from "moz-src:///browser/components/aiwindow/models/agents/SubAgentBrowser.sys.mjs";

export const MAX_SUB_AGENT_ROUNDS = 30;
const MAX_TOOL_CALLS = MAX_SUB_AGENT_ROUNDS * 5;
const TIMEOUT_MS = 180000;
const sessionsByParent = new Map();

export function getCustomSubAgents(parent) {
  const sessions = [...(sessionsByParent.get(parent?.id)?.values() ?? [])];
  for (const session of sessions) {
    session.observers.add(parent);
    const group = session.browser?.ensureTabGroup();
    if (group) {
      session.state.tabGroup = group;
    }
  }
  return sessions;
}

export function listCustomSubAgents(parent) {
  return {
    sub_agents: getCustomSubAgents(parent).map(session => ({
      agent_id: session.id,
      name: session.name,
      task: session.task,
      tools: session.tools.map(tool => tool.function.name),
      status: session.state.status,
      can_continue: !session.controller,
      originAttributes: session.conversation.originAttributes,
      browserTab: !!session.browser?.hasOpenTab,
      tabGroup: session.browser?.tabGroup ?? null,
    })),
  };
}

export function continueCustomSubAgent(parent, agentId, text, signal, { onProgress } = {}) {
  if (typeof agentId !== "string" || !agentId.trim()) {
    throw new Error("agent_id must be a non-empty string");
  }
  const session = sessionsByParent.get(parent.id)?.get(agentId);
  if (!session) {
    throw new Error("This sub-agent is no longer available");
  }
  if (session.controller) {
    throw new Error("This sub-agent is already working");
  }
  if (typeof text !== "string" || !text.trim() || text.length > 16000) {
    throw new Error("A sub-agent message must contain 1 to 16000 characters");
  }
  session.parent = parent;
  session.observers.add(parent);
  return runSubAgentTurn(session, signal, text, onProgress);
}

function validateParams(params, availableTools) {
  for (const key of ["name", "system_prompt", "task"]) {
    if (typeof params?.[key] !== "string" || !params[key].trim()) {
      throw new Error(`${key} must be a non-empty string`);
    }
    if (params[key].length > (key === "name" ? 100 : 16000)) {
      throw new Error(`${key} is too long`);
    }
  }
  const available = new Set(availableTools.map(tool => tool.function.name));
  if (
    !Array.isArray(params.tools) ||
    params.tools.some(
      name => !SUB_AGENT_TOOLS.includes(name) || !available.has(name)
    ) ||
    new Set(params.tools).size !== params.tools.length
  ) {
    throw new Error(
      "tools must be a unique subset of the available sub-agent tools"
    );
  }
}

/**
 * @param {object} params - Assistant-authored name, system_prompt, task and tools.
 * @param {ChatConversation} parent
 * @param {AbortSignal} signal
 * @param {string} mode
 * @param {object} options
 * @param {object[]} options.availableTools - Tools available to the parent.
 * @param {Function} options.executeTool - The parent's tool dispatcher.
 * @param {Function} options.onProgress - Updates the originating action-log row.
 * @param {{userContextId: number}} [options.parentOriginAttributes]
 * @param {Window} [options.window]
 * @returns {Promise<object>} Final answer and execution details.
 */
export async function runCustomSubAgent(
  params,
  parent,
  signal,
  mode,
  {
    availableTools,
    executeTool,
    onProgress,
    parentOriginAttributes = { userContextId: 0 },
    window,
  }
) {
  availableTools = [...availableTools, ...subAgentBrowserToolsConfig];
  validateParams(params, availableTools);
  signal?.throwIfAborted();
  const agentId = crypto.randomUUID();
  const identity = ContextualIdentityService.createForAI(agentId);
  const child = new ChatConversation({
    id: agentId,
    securityProperties: parent.securityProperties.toJSON(),
    seenUrls: [...parent.seenUrls],
    serpUrlsForAnonymousFetch: [...parent.serpUrlsForAnonymousFetch],
  });
  child.engine = parent.engine;
  child.parameters = parent.parameters;
  child.originAttributes = Object.freeze({
    userContextId: identity.userContextId,
  });
  const childMentionURLs = child.getAllMentionURLs.bind(child);
  child.setSystemMessage({ type: "text", body: params.system_prompt });
  child.addUserMessage(params.task);

  const tools = availableTools.filter(tool =>
    params.tools.includes(tool.function.name)
  );
  const allowed = new Set(params.tools);
  const events = [];
  const state = {
    agent_id: agentId,
    name: params.name,
    status: "running",
    originAttributes: child.originAttributes,
    parentOriginAttributes,
    answer: "",
  };
  const session = {
    id: agentId,
    name: params.name,
    task: params.task,
    conversation: child,
    parent,
    engineSource: parent.engine,
    observers: new Set([parent]),
    tools,
    allowed,
    events,
    state,
    executeTool,
    mode,
    window,
    browser: null,
    controller: null,
    progress: null,
    reportToParent: true,
    report() {
      if (session.reportToParent) {
        onProgress?.({ ...state, execution: structuredClone(events) });
      }
      if (session.progress) {
        session.progress.callback({
          ...state,
          execution: structuredClone(events.slice(session.progress.start)),
        });
      }
      for (const observer of session.observers) {
        if (session.reportToParent && observer !== parent) {
          const message = observer.messages.find(item =>
            item.content?.name === CREATE_SUB_AGENT &&
            item.content?.body?.agent_id === agentId
          );
          if (message) {
            observer.updateToolCallMessage(message, {
              ...message.content,
              body: { ...state, pending: state.status === "running" },
              args: { ...message.content.args, execution: structuredClone(events) },
            });
          }
        }
        observer.emit("chat-conversation:sub-agents-updated");
      }
    },
  };
  child.getAllMentionURLs = () => new Set([
    ...session.parent.getAllMentionURLs(),
    ...childMentionURLs(),
  ]);
  if (!sessionsByParent.has(parent.id)) {
    sessionsByParent.set(parent.id, new Map());
  }
  sessionsByParent.get(parent.id).set(agentId, session);
  window?.addEventListener("unload", () => {
    session.controller?.abort();
    const sessions = sessionsByParent.get(parent.id);
    sessions?.delete(agentId);
    if (!sessions?.size) {
      sessionsByParent.delete(parent.id);
    }
    ContextualIdentityService.removeAIIdentity(identity.userContextId);
    for (const observer of session.observers) {
      observer.emit("chat-conversation:sub-agents-updated");
    }
  }, { once: true });
  try {
    return await runSubAgentTurn(session, signal);
  } finally {
    session.reportToParent = false;
  }
}

async function runSubAgentTurn(session, signal, text, onProgress) {
  signal?.throwIfAborted();
  const {
    id: agentId,
    conversation: child,
    parent,
    tools,
    allowed,
    events,
    state,
    executeTool,
    mode,
    window,
    report,
  } = session;
  const eventStart = events.length;
  session.progress = onProgress ? { callback: onProgress, start: eventStart } : null;
  state.status = "running";
  state.answer = "";
  delete state.error;
  const controller = new AbortController();
  session.controller = controller;
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(new DOMException("Sub-agent timed out", "TimeoutError")),
    TIMEOUT_MS
  );
  let toolCalls = 0;
  const outstandingCalls = new Map();
  let browser = session.browser;
  if (!browser || browser.wasClosed) {
    browser = new SubAgentBrowser(child, controller.signal, {
      window,
      name: session.name,
      groupColor: state.tabGroup?.color,
      onTabCreated() {
        state.browserTab = true;
        state.tabGroup = browser.tabGroup;
        report();
      },
      onTabClosed() {
        state.browserTab = false;
        report();
      },
    });
    session.browser = browser;
  } else {
    browser.resume(controller.signal);
  }

  try {
    state.tabGroup = browser.tabGroup ?? state.tabGroup;
    if (text) {
      const message = child.addUserMessage(text);
      child.emit("chat-conversation:message-update", message);
    }
    report();
    const token = await AuthProvider.getToken();
    if (!token) {
      throw new Error("Token unavailable");
    }
    const engineSource = session.engineSource ??= child.engine;
    if (typeof engineSource.fork === "function") {
      child.engine = await engineSource.fork({
        engineId: `smart-sub-agent-${agentId}`,
        flowId: agentId,
      });
    }
    for (let round = 0; round < MAX_SUB_AGENT_ROUNDS; round++) {
      controller.signal.throwIfAborted();
      let text = "";
      let pending = [];
      let args = child.compactChatCompletions();
      if (tools.some(tool => SUB_AGENT_BROWSER_TOOLS.includes(tool.function.name))) {
        const systemIndex = args.findIndex(message => message.role === "system");
        args = systemIndex === -1
          ? [{ role: "system", content: SUB_AGENT_BROWSER_PROMPT }, ...args]
          : args.map((message, index) => index === systemIndex
            ? { ...message, content: `${message.content}\n\n${SUB_AGENT_BROWSER_PROMPT}` }
            : message);
      }
      const assistantMessage = child.addAssistantMessage("text", "");
      const parserState = createParserState();
      const updateMessage = () => {
        const content = { body: assistantMessage.content.body };
        expandUrlTokensInToolParams(content, child.tokenToUrl);
        assistantMessage.content = { ...assistantMessage.content, ...content };
        child.emit("chat-conversation:message-update", assistantMessage);
      };
      const messageEvent = { type: "message", text: "", status: "running" };
      events.push(messageEvent);
      let lastReport = ChromeUtils.now();
      for await (const chunk of child.runWithGenerator({
        token,
        chatId: agentId,
        args,
        streamOptions: { enabled: true },
        tools,
        inferenceParams: { tool_choice: "auto" },
        signal: controller.signal,
      })) {
        controller.signal.throwIfAborted();
        text += chunk.text ?? "";
        if (chunk.text) {
          Conversation.prototype.handleChunk.call(child, chunk.text, assistantMessage, parserState);
        }
        messageEvent.text = text;
        if (chunk.toolCalls?.length) {
          pending = chunk.toolCalls;
        }
        if (ChromeUtils.now() - lastReport > 150) {
          updateMessage();
          report();
          lastReport = ChromeUtils.now();
        }
      }
      const remainder = flushTokenRemainder(parserState);
      if (remainder) {
        assistantMessage.content.body += remainder;
      }
      messageEvent.status = "completed";
      if (text) {
        updateMessage();
        child.emit("chat-conversation:message-complete", assistantMessage);
      }
      report();
      if (!pending.length) {
        state.answer = assistantMessage.content.body;
        expandUrlTokensInToolParams(state, child.tokenToUrl);
        state.status = "completed";
        return { ...state, execution: structuredClone(events.slice(eventStart)) };
      }
      child.addAssistantMessage("function", { tool_calls: pending });
      for (const call of pending) {
        outstandingCalls.set(call.id, call);
      }
      for (const call of pending) {
        controller.signal.throwIfAborted();
        if (++toolCalls > MAX_TOOL_CALLS) {
          throw new Error("Sub-agent tool-call limit reached");
        }
        const name = call.function?.name;
        const event = {
          type: "tool",
          tool_call_id: call.id,
          name,
          arguments: call.function?.arguments ?? "{}",
          status: "running",
        };
        events.push(event);
        report();
        let result;
        try {
          if (!allowed.has(name)) {
            throw new Error(`Tool is not allowed for this sub-agent: ${name}`);
          }
          const lastUser = parent.messages.findLast(
            message => message.role === MESSAGE_ROLE.USER
          );
          if (
            name === GET_USER_MEMORIES &&
            (lastUser?.content?.memoriesEnabled === false ||
              lastUser?.memoriesEnabled === false)
          ) {
            throw new Error("Memories are disabled for this message");
          }
          const args = JSON.parse(event.arguments);
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            throw new Error("Tool arguments must be an object");
          }
          expandUrlTokensInToolParams(args, child.tokenToUrl);
          event.arguments = JSON.stringify(args, null, 2);
          if (SUB_AGENT_BROWSER_TOOLS.includes(name)) {
            result = await browser.execute(name, args);
          } else if (name === SEARCH_THE_WEB) {
            result = await runSearchTheWeb(
              args,
              child,
              controller.signal,
              mode
            );
            if (result.directAnswerStream) {
              let answer = "";
              for await (const chunk of result.directAnswerStream) {
                answer += chunk.text ?? "";
              }
              delete result.directAnswerStream;
              result.answer = answer;
            }
            if (result.requiresSearchHandoff) {
              result = {
                error:
                  "Search handoff is unavailable to sub-agents. Answer using the results already gathered.",
              };
            }
          } else {
            result = await executeTool(
              name,
              { ...args, signal: controller.signal },
              call.id,
              child,
              null,
              mode
            );
          }
          event.status = result?.error ? "failed" : "completed";
        } catch (error) {
          controller.signal.throwIfAborted();
          event.status = "failed";
          result = { error: String(error) };
        }
        event.result = result;
        child.addToolCallMessage({
          tool_call_id: call.id,
          name,
          body: result,
          args: { arguments: event.arguments },
        });
        outstandingCalls.delete(call.id);
        report();
      }
    }
    throw new Error("Sub-agent turn limit reached");
  } catch (error) {
    state.status = "failed";
    if (
      controller.signal.aborted &&
      controller.signal.reason?.name !== "TimeoutError"
    ) {
      state.status = "cancelled";
    }
    state.error = String(controller.signal.reason ?? error);
    for (const call of outstandingCalls.values()) {
      const result = { error: state.error };
      child.addToolCallMessage({
        tool_call_id: call.id,
        name: call.function?.name,
        body: result,
      });
      const event = events.findLast(item => item.tool_call_id === call.id);
      if (event) {
        event.result = result;
      }
    }
    for (const event of events) {
      if (event.status === "running") {
        event.status = state.status;
      }
    }
    child.addAssistantWithL10nMessage("sub-agent-run-error", {
      error: state.error,
    });
    return { ...state, execution: structuredClone(events.slice(eventStart)) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    await browser.destroy();
    state.tabGroup = browser.tabGroup ?? state.tabGroup;
    const security = child.securityProperties.toJSON();
    if (security.privateData) {
      parent.securityProperties.setPrivateData();
    }
    if (security.untrustedInput) {
      parent.securityProperties.setUntrustedInput();
    }
    parent.addSeenUrls(child.seenUrls);
    parent.addSerpUrlsForAnonymousFetch(child.serpUrlsForAnonymousFetch);
    parent.addCitations(child.getCitationsSnapshot());
    session.controller = null;
    try {
      report();
    } finally {
      session.progress = null;
    }
  }
}
