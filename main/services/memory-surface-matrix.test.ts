import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  authorizeMemoryProposal,
  createMemoryExtension,
  memoryProvenanceForGeneration,
  memoryScopeForChat,
  prepareMemoryApproval,
  RECALL_MEMORY_TOOL_NAME,
  REMEMBER_MEMORY_TOOL_NAME,
  FORGET_MEMORY_TOOL_NAME,
} from "./memory-context.js";
import { MemoryStore } from "./memory-store.js";
import {
  PiAgentRuntimeHarness,
  resolvePiAgentRuntimeContributionSnapshot,
} from "./pi-agent-runtime-harness.js";
import { assertGenerationContextCapacity, estimateStaticContextTokens } from "./generation-context.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";
import type { Chat } from "./types.js";

function chat(id: string, workspaceId: string, botId?: string): Chat {
  return {
    id,
    title: id,
    workspaceId,
    ...(botId ? { botId } : {}),
    messages: [{ id: `${id}-message`, role: "user", content: "What is our launch policy?", createdAt: 1 }],
    createdAt: 1,
    updatedAt: 1,
  };
}

test("production memory surface matrix preserves scope, attendance, replay, and final budgeting", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-memory-surfaces-"));
  const store = new MemoryStore({ root: () => root, now: () => 1_000 });
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  const macBotChat = chat("mac-bot-chat", "mac-workspace", "shared-bot");
  const boundTelegramChat = chat("telegram-bot-chat", "telegram-workspace", "shared-bot");
  const ordinaryTelegramChat = chat("telegram-workspace-chat", "telegram-workspace");
  assert.deepEqual(memoryScopeForChat(macBotChat), memoryScopeForChat(boundTelegramChat));
  assert.notDeepEqual(memoryScopeForChat(macBotChat), memoryScopeForChat(ordinaryTelegramChat));

  const botScope = memoryScopeForChat(macBotChat);
  await store.put({
    id: "bot-launch-policy",
    scope: botScope,
    text: "The Bot launch window is Wednesday.",
    provenance: { kind: "user_edit", sourceId: "memory-editor" },
    alwaysOn: true,
  });
  await store.put({
    id: "workspace-launch-policy",
    scope: memoryScopeForChat(ordinaryTelegramChat),
    text: "The workspace launch window is Friday.",
    provenance: { kind: "user_edit", sourceId: "memory-editor" },
  });

  const attendedProvenance = memoryProvenanceForGeneration(macBotChat, "turn-mac", true);
  assert.ok(attendedProvenance);
  assert.equal(memoryProvenanceForGeneration(boundTelegramChat, "turn-telegram", false), undefined);
  assert.deepEqual(prepareMemoryApproval({ fact: "Never commit headlessly." }, undefined), {
    ok: false,
    reason: "Memory writes require a current attended source turn.",
  });
  const preparedApproval = prepareMemoryApproval(
    { fact: "Commit only after approval.", alwaysOn: false },
    { scope: botScope, provenance: attendedProvenance },
  );
  assert.equal(preparedApproval.ok, true);
  if (preparedApproval.ok) assert.match(preparedApproval.summary, /turn:turn-mac/u);
  const macExtension = await createMemoryExtension({ store, scope: botScope, provenance: attendedProvenance });
  const boundTelegramExtension = await createMemoryExtension({
    store,
    scope: memoryScopeForChat(boundTelegramChat),
  });
  const ordinaryTelegramExtension = await createMemoryExtension({
    store,
    scope: memoryScopeForChat(ordinaryTelegramChat),
  });

  assert.deepEqual(macExtension.tools?.map(({ name }) => name), [
    RECALL_MEMORY_TOOL_NAME,
    REMEMBER_MEMORY_TOOL_NAME,
    FORGET_MEMORY_TOOL_NAME,
  ]);
  assert.deepEqual(boundTelegramExtension.tools?.map(({ name }) => name), [RECALL_MEMORY_TOOL_NAME]);
  assert.deepEqual(ordinaryTelegramExtension.tools?.map(({ name }) => name), [RECALL_MEMORY_TOOL_NAME]);
  assert.equal(
    piRuntimeReplayPolicy(macExtension.tools?.find(({ name }) => name === REMEMBER_MEMORY_TOOL_NAME)),
    "never",
  );

  const runProposal = async (allowed: boolean) => {
    const core = createFauxCore({ provider: `memory-approval-${allowed ? "allow" : "deny"}` });
    core.setResponses([
      fauxAssistantMessage([
        fauxToolCall(REMEMBER_MEMORY_TOOL_NAME, {
          fact: allowed ? "Approved through the production gate." : "Denied by the production gate.",
          alwaysOn: false,
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const harness = new PiAgentRuntimeHarness({
      convertToLlm: (messages) => messages.filter(
        (message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
      ),
      streamFn: core.streamSimple,
      extensions: [macExtension],
      initialState: {
        systemPrompt: "Memory approval matrix",
        thinkingLevel: "off",
        tools: [],
        messages: [],
        model: core.getModel(),
      },
      beforeToolCall: async ({ toolCall, args }, signal) => {
        if (toolCall.name !== REMEMBER_MEMORY_TOOL_NAME) return undefined;
        const decision = await authorizeMemoryProposal(
          args,
          { scope: botScope, provenance: attendedProvenance },
          async () => allowed,
          signal,
        );
        return decision.allowed ? undefined : { block: true, reason: decision.reason };
      },
    });
    await harness.prompt("remember the proposed fact");
  };
  await runProposal(false);
  assert.equal((await store.list(botScope)).some(({ text }) => text.startsWith("Denied")), false);
  await runProposal(true);
  assert.equal((await store.list(botScope)).some(({ text }) => text.startsWith("Approved")), true);

  const cancelled = new AbortController();
  cancelled.abort();
  let cancellationRequested = false;
  assert.deepEqual(
    await authorizeMemoryProposal(
      { fact: "Cancelled before approval.", alwaysOn: false },
      { scope: botScope, provenance: attendedProvenance },
      async () => {
        cancellationRequested = true;
        return true;
      },
      cancelled.signal,
    ),
    { allowed: false, reason: "Memory approval was cancelled." },
  );
  assert.equal(cancellationRequested, false);

  for (const [outcome, reason] of [
    ["denied", "Memory proposal was not approved."],
    ["cancelled", "Memory approval was cancelled."],
    [
      "detached",
      "Memory approval is unavailable while this response continues in the background. Return to the chat and retry the action.",
    ],
    [
      "unavailable",
      "Aiden could not present the memory approval request. Return to the chat and retry the action.",
    ],
  ] as const) {
    assert.deepEqual(
      await authorizeMemoryProposal(
        { fact: `Approval outcome ${outcome}.`, alwaysOn: false },
        { scope: botScope, provenance: attendedProvenance },
        async () => outcome,
      ),
      { allowed: false, reason },
    );
  }

  const boundRecall = boundTelegramExtension.tools?.find(({ name }) => name === RECALL_MEMORY_TOOL_NAME)!;
  const ordinaryRecall = ordinaryTelegramExtension.tools?.find(({ name }) => name === RECALL_MEMORY_TOOL_NAME)!;
  const botResult = await boundRecall.execute("recall", { query: "launch window" });
  const workspaceResult = await ordinaryRecall.execute("recall", { query: "launch window" });
  const text = (result: Awaited<ReturnType<typeof boundRecall.execute>>) =>
    result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text(botResult), /Wednesday/u);
  assert.doesNotMatch(text(botResult), /Friday/u);
  assert.match(text(workspaceResult), /Friday/u);
  assert.doesNotMatch(text(workspaceResult), /Wednesday/u);

  const withoutMemory = resolvePiAgentRuntimeContributionSnapshot("base", [], {}, [], 1);
  const withMemory = resolvePiAgentRuntimeContributionSnapshot("base", [], {}, [macExtension], 1);
  const withoutTokens = estimateStaticContextTokens({
    contextWindow: 8_192,
    systemPrompt: withoutMemory.systemPrompt,
    tools: withoutMemory.tools,
  });
  const withTokens = estimateStaticContextTokens({
    contextWindow: 8_192,
    systemPrompt: withMemory.systemPrompt,
    tools: withMemory.tools,
  });
  assert.ok(withTokens > withoutTokens);
  assert.doesNotThrow(() => assertGenerationContextCapacity({
    contextWindow: 8_192,
    systemPrompt: withMemory.systemPrompt,
    tools: withMemory.tools,
  }));
});
