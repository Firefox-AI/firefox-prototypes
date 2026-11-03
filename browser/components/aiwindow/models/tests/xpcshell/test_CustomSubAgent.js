/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

do_get_profile();

const { runCustomSubAgent, MAX_SUB_AGENT_ROUNDS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/CustomSubAgent.sys.mjs"
);
const { ChatConversation } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/ui/modules/ChatConversation.sys.mjs"
);
const { AuthProvider } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/AuthProvider.sys.mjs"
);
const {
  toolsConfig,
  GET_NAVIGATION_INFO,
  GetPageContent,
  SUB_AGENT_CAPABILITY_PROMPT,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs"
);
const { SubAgentBrowser, SUB_AGENT_BROWSER_TOOLS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/aiwindow/models/agents/SubAgentBrowser.sys.mjs"
);
const { PageExtractorParent } = ChromeUtils.importESModule(
  "resource://gre/actors/PageExtractorParent.sys.mjs"
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const PARAMS = {
  name: "Settings helper",
  system_prompt: "Find relevant Firefox settings and report your findings.",
  task: "Find the home page setting.",
  tools: [GET_NAVIGATION_INFO],
};

function makeParent(responses) {
  const parent = new ChatConversation({});
  parent.engine = {
    model: "test-model",
    async *runWithGenerator(options) {
      yield await responses(options);
    },
  };
  return parent;
}

function toolCall(name, args = "{}") {
  return {
    id: crypto.randomUUID(),
    type: "function",
    function: { name, arguments: args },
  };
}

add_setup(function () {
  sinon.stub(AuthProvider, "getToken").resolves("test-token");
  registerCleanupFunction(() => sinon.restore());
});

add_task(async function test_custom_prompt_tools_progress_and_security() {
  const requests = [];
  const parent = makeParent(options => {
    requests.push(options);
    return requests.length === 1
      ? {
          text: "Looking up settings.",
          toolCalls: [toolCall(GET_NAVIGATION_INFO, '{"query":"home"}')],
        }
      : { text: "Open the Home settings." };
  });
  parent.securityProperties.setPrivateData();
  const snapshots = [];
  let contextId;
  const result = await runCustomSubAgent(PARAMS, parent, null, "sidebar", {
    availableTools: toolsConfig,
    onProgress: snapshot => snapshots.push(snapshot),
    executeTool: async (name, args, id, child) => {
      Assert.equal(name, GET_NAVIGATION_INFO);
      Assert.equal(args.query, "home");
      Assert.ok(
        child.securityProperties.privateData,
        "Parent security flags are inherited"
      );
      child.securityProperties.setUntrustedInput();
      child.addSeenUrls(["https://example.com/"]);
      contextId = child.originAttributes.userContextId;
      Assert.greater(contextId, 0, "The agent has an isolated origin");
      return { setting: "Home" };
    },
  });
  Assert.equal(requests[0].args[0].content, PARAMS.system_prompt);
  Assert.equal(requests[0].args[1].content, PARAMS.task);
  Assert.deepEqual(
    requests[0].tools.map(tool => tool.function.name),
    PARAMS.tools
  );
  Assert.equal(requests[0].chatId, result.agent_id);
  Assert.notEqual(result.agent_id, parent.id);
  Assert.equal(result.answer, "Open the Home settings.");
  Assert.equal(result.status, "completed");
  Assert.ok(
    snapshots.some(snapshot =>
      snapshot.execution.some(
        event => event.type === "tool" && event.status === "running"
      )
    )
  );
  Assert.deepEqual(
    result.execution.find(event => event.type === "tool").result,
    { setting: "Home" }
  );
  Assert.ok(
    parent.securityProperties.toJSON().untrustedInput,
    "Child flags propagate back to the parent"
  );
  Assert.ok(parent.seenUrls.has("https://example.com/"));
  Assert.ok(
    !ContextualIdentityService.removeAIIdentity(contextId),
    "The internal AI identity was cleaned up"
  );
});

add_task(async function test_runtime_tool_allowlist_and_bad_json() {
  let round = 0;
  const parent = makeParent(() =>
    ++round === 1
      ? {
          toolCalls: [
            toolCall("create_sub_agent"),
            toolCall("browser_click"),
            toolCall(GET_NAVIGATION_INFO, "{"),
          ],
        }
      : { text: "Unable to complete." }
  );
  const executeTool = sinon.spy();
  const result = await runCustomSubAgent(PARAMS, parent, null, "sidebar", {
    availableTools: toolsConfig,
    executeTool,
    onProgress() {},
  });
  Assert.ok(
    executeTool.notCalled,
    "Unselected tools and malformed arguments never reach dispatch"
  );
  const calls = result.execution.filter(event => event.type === "tool");
  Assert.equal(calls.length, 3);
  Assert.ok(calls.every(event => event.status === "failed"));
  Assert.ok(calls[0].result.error.includes("not allowed"));
});

add_task(async function test_browser_tools_are_only_delegatable() {
  const { executeToolByName } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs"
  );
  const parent = makeParent(() => ({ text: "Done" }));
  for (const name of SUB_AGENT_BROWSER_TOOLS) {
    Assert.ok(!toolsConfig.some(tool => tool.function.name === name));
    const creation = toolsConfig.find(
      tool => tool.function.name === "create_sub_agent"
    );
    Assert.ok(
      creation.function.parameters.properties.tools.items.enum.includes(name),
      "The assistant can grant this tool to a sub-agent"
    );
    await Assert.rejects(
      executeToolByName(name, {}, "call", parent, null, "sidebar"),
      /No such tool/
    );
  }
  let round = 0;
  parent.engine.runWithGenerator = async function* (options) {
    Assert.deepEqual(
      options.tools.map(tool => tool.function.name),
      ["browser_navigate"]
    );
    yield ++round === 1
      ? {
          toolCalls: [
            toolCall("browser_navigate", '{"url":"https://example.com/"}'),
          ],
        }
      : { text: "Done" };
  };
  const execute = sinon
    .stub(SubAgentBrowser.prototype, "execute")
    .resolves({ url: "https://example.com/" });
  const destroy = sinon.spy(SubAgentBrowser.prototype, "destroy");
  const dispatcher = sinon.spy();
  try {
    const result = await runCustomSubAgent(
      { ...PARAMS, tools: ["browser_navigate"] },
      parent,
      null,
      "sidebar",
      {
        availableTools: toolsConfig,
        executeTool: dispatcher,
        onProgress() {},
        parentOriginAttributes: { userContextId: 42 },
      }
    );
    Assert.equal(result.status, "completed");
    Assert.ok(execute.calledOnce);
    Assert.ok(destroy.calledOnce);
    Assert.ok(
      dispatcher.notCalled,
      "Browser tools use the agent's own dispatcher"
    );
    Assert.deepEqual(result.parentOriginAttributes, { userContextId: 42 });
    Assert.notEqual(result.originAttributes.userContextId, 42);
  } finally {
    execute.restore();
    destroy.restore();
  }
});

add_task(async function test_invalid_configuration_rejected_before_inference() {
  const parent = makeParent(() => {
    throw new Error("Must not run");
  });
  for (const params of [
    { ...PARAMS, system_prompt: " " },
    { ...PARAMS, tools: ["create_sub_agent"] },
    { ...PARAMS, tools: [GET_NAVIGATION_INFO, GET_NAVIGATION_INFO] },
  ]) {
    await Assert.rejects(
      runCustomSubAgent(params, parent, null, "sidebar", {
        availableTools: toolsConfig,
        executeTool() {},
        onProgress() {},
      }),
      /non-empty|subset/
    );
  }
});

add_task(async function test_cancellation_and_turn_limit() {
  const controller = new AbortController();
  let parent = makeParent(() => {
    controller.abort();
    return { text: "Interrupted" };
  });
  let result = await runCustomSubAgent(
    { ...PARAMS, tools: [] },
    parent,
    controller.signal,
    "sidebar",
    {
      availableTools: toolsConfig,
      executeTool() {},
      onProgress() {},
    }
  );
  Assert.equal(result.status, "cancelled");
  Assert.ok(result.execution.every(event => event.status !== "running"));
  let rounds = 0;
  parent = makeParent(() => {
    rounds++;
    return { toolCalls: [toolCall(GET_NAVIGATION_INFO)] };
  });
  result = await runCustomSubAgent(PARAMS, parent, null, "sidebar", {
    availableTools: toolsConfig,
    executeTool: async () => ({}),
    onProgress() {},
  });
  Assert.equal(rounds, MAX_SUB_AGENT_ROUNDS);
  Assert.equal(result.status, "failed");
  Assert.ok(result.error.includes("turn limit"));
});

add_task(async function test_page_reads_never_use_user_tabs() {
  const parent = makeParent(() => ({ text: "Done" }));
  parent.originAttributes = { userContextId: 123 };
  const url = "https://example.com/";
  parent.getAllMentionURLs = () => new Set([url]);
  const tab = sinon
    .stub(GetPageContent, "getTabWithURL")
    .throws(new Error("Must not read user tabs"));
  const headless = sinon
    .stub(PageExtractorParent, "getHeadlessExtractor")
    .resolves({ ok: true, content: "Isolated content" });
  try {
    const result = await GetPageContent.getPageContentText(
      { url_list: [url] },
      parent
    );
    Assert.deepEqual(result, ["Isolated content"]);
    Assert.ok(tab.notCalled);
    Assert.deepEqual(
      headless.firstCall.args[0].originAttributes,
      parent.originAttributes
    );
  } finally {
    tab.restore();
    headless.restore();
  }
});

add_task(async function test_main_chat_records_sub_agent_progress() {
  const { Chat } = ChromeUtils.importESModule(
    "moz-src:///browser/components/aiwindow/models/Chat.sys.mjs"
  );
  let parentRequests = 0;
  const requests = [];
  const parent = makeParent(options => {
    requests.push(options);
    if (options.chatId !== parent.id) {
      return { text: "Child answer" };
    }
    return ++parentRequests === 1
      ? {
          toolCalls: [
            toolCall(
              "create_sub_agent",
              JSON.stringify({ ...PARAMS, tools: [] })
            ),
          ],
        }
      : { text: "Parent answer" };
  });
  parent.engine.isCustomEndpoint = true;
  const legacyPrompt =
    "No actions on behalf of the user: you cannot click, type, purchase, submit forms, or modify settings. Keep existing safety rules.";
  parent.setSystemMessage({ type: "text", body: legacyPrompt });
  parent.addAssistantMessage(
    "text",
    "I cannot create a sub-agent or navigate websites."
  );
  parent.addUserMessage("Delegate the settings task.", null);
  parent.addAssistantMessage("text", "");
  const progress = [];
  parent.on("chat-conversation:message-update", (_event, message) => {
    if (message.content.name === "create_sub_agent") {
      progress.push(structuredClone(message.content));
    }
  });
  await Chat.fetchWithHistory({ conversation: parent, mode: "sidebar" });
  for (const request of requests.filter(
    options => options.chatId === parent.id
  )) {
    const system = request.args.find(
      message => message.role === "system"
    ).content;
    Assert.ok(
      system.startsWith(legacyPrompt),
      "Existing instructions are preserved"
    );
    Assert.ok(
      system.endsWith(SUB_AGENT_CAPABILITY_PROMPT),
      "Every main-assistant request gets the current delegation capabilities"
    );
    Assert.equal(
      system.split(SUB_AGENT_CAPABILITY_PROMPT).length,
      2,
      "The capability update is added once per request"
    );
    Assert.ok(
      !request.tools.some(tool =>
        SUB_AGENT_BROWSER_TOOLS.includes(tool.function.name)
      ),
      "Browser tools remain unavailable to the main assistant"
    );
  }
  const childRequest = requests.find(options => options.chatId !== parent.id);
  Assert.equal(
    childRequest.args[0].content,
    PARAMS.system_prompt,
    "The assistant-authored sub-agent prompt is preserved"
  );
  Assert.equal(
    parent.messages[0].content.body,
    legacyPrompt,
    "Stored prompts are not repeatedly amended"
  );
  const completed = progress.at(-1);
  Assert.ok(
    progress.some(message => message.body.pending),
    "The main chat gets progress while the child is running"
  );
  Assert.equal(completed.body.answer, "Child answer");
  Assert.equal(completed.body.status, "completed");
  Assert.equal(completed.args.system_prompt, PARAMS.system_prompt);
  Assert.equal(completed.args.execution[0].text, "Child answer");
  Assert.ok(
    !("execution" in completed.body),
    "The trace is kept out of the main model's tool result"
  );
  Assert.equal(
    parentRequests,
    2,
    "The main assistant resumes after the child returns"
  );
});
