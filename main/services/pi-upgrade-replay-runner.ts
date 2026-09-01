import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type Model,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import {
  compactGenerationContext,
  projectNextContextUsage,
  type GenerationContextOptions,
} from "./generation-context.js";
import {
  PI_UPGRADE_REPLAY_CASE_IDS,
  type PiUpgradeReplayCaseId,
  type PiUpgradeReplayMeasurement,
} from "./pi-upgrade-evaluation.js";
import { PiCompactionCoordinator, type PiCompactionEvent } from "./pi-compaction-core.js";
import { createPiSessionPort } from "./pi-session-port.js";
import { migratePiSessionJournal } from "./pi-session-migration.js";
import type { ResolvedModelRuntime } from "./model-runtime-core.js";
import { SubagentRuntimeRegistry } from "./subagents/child-agent-runtime.js";
import { ContextLifecycleService } from "./context-lifecycle-service.js";
import { createTelegramLifecycleAdapter } from "./context-lifecycle-adapters.js";
import type { Chat } from "./types.js";

const options: GenerationContextOptions = {
  contextWindow: 16_000,
  systemPrompt: "Stable replay evaluation prompt.",
  tools: [],
  providerId: "replay-provider-new",
  modelId: "replay-model-new",
  supportsImages: true,
};

function user(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: 1 };
}

function assistantText(text: string, provider = options.providerId!, model = options.modelId!): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider,
    model,
    usage: {
      input: 950, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 970,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

function toolCall(id: string): AssistantMessage {
  const message = assistantText("");
  message.content = [{ type: "toolCall", id, name: "read_file", arguments: { path: `${id}.ts` } }];
  message.stopReason = "toolUse";
  return message;
}

function toolResult(id: string, text: string): ToolResultMessage {
  return {
    role: "toolResult", toolCallId: id, toolName: "read_file",
    content: [{ type: "text", text }], details: null, isError: false, timestamp: 3,
  };
}

function historicalTurns(prefix: string, count: number, chars = 1_200): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push(user(`${prefix}-request-${index}`), assistantText(`${prefix}-answer-${index}-${"x".repeat(chars)}`));
  }
  return messages;
}

interface ExecutableCase {
  messages: AgentMessage[];
  markers: string[];
  expectedFallback?: boolean;
  projectionCheck?: (messages: AgentMessage[]) => boolean;
}

function executableCase(caseId: PiUpgradeReplayCaseId): ExecutableCase {
  switch (caseId) {
    case "long_coding_chat":
      return {
        messages: [...historicalTurns("coding", 12), user("continue with exact identifier BUILD-417")],
        markers: ["BUILD-417"],
      };
    case "tool_heavy_turn": {
      const id = "tool-call-991";
      return {
        messages: [
          ...historicalTurns("tool-history", 5), user("inspect result"), toolCall(id),
          toolResult(id, `${id}-${"y".repeat(90_000)}`), user("continue after tool with ISSUE-882"),
        ],
        markers: ["ISSUE-882", id],
      };
    }
    case "attachment_heavy_first_prompt":
      return {
        messages: [user([
          { type: "text", text: `ATTACHMENT-204 ${"z".repeat(100_000)}` },
          ...Array.from({ length: 8 }, (_, index) => ({
            type: "image" as const,
            data: Buffer.from(`image-${index}`).toString("base64"),
            mimeType: "image/png",
          })),
        ])],
        markers: [],
        expectedFallback: true,
      };
    case "repeated_compaction":
      return {
        messages: [
          ...historicalTurns("first-checkpoint", 6),
          assistantText("Prior checkpoint retained decision RETAIN-77."),
          ...historicalTurns("second-checkpoint", 6),
          user("continue repeated compaction with RETAIN-77"),
        ],
        markers: ["RETAIN-77"],
      };
    case "provider_model_switch": {
      const messages = [
        ...historicalTurns("provider-switch", 10),
        assistantText("old provider usage", "replay-provider-old", "replay-model-old"),
        user("continue on new model with SWITCH-55"),
      ];
      return {
        messages,
        markers: ["SWITCH-55"],
        projectionCheck: (candidate) => projectNextContextUsage(candidate, options).usageAnchorIndex === null,
      };
    }
    case "bot_mac_telegram_alternation":
      return {
        messages: [
          ...historicalTurns("bot", 10),
          user("Mac retained shared Bot identifier BOT-314"),
          assistantText("Mac acknowledged BOT-314"),
          user("Telegram continues canonical Bot chat with BOT-314"),
        ],
        markers: ["BOT-314"],
      };
    case "child_initial_fork":
      return {
        messages: [
          ...historicalTurns("parent-fork", 12),
          user("Child first task must preserve CHILD-909 before provider I/O"),
        ],
        markers: ["CHILD-909"],
      };
  }
}

function summary(markers: readonly string[]): string {
  return `## Goal\nPreserve replay continuity.\n\n## Constraints & Preferences\n- none\n\n## Progress\n### Done\n- [x] retained\n\n### In Progress\n- [ ] continue\n\n### Blocked\n- none\n\n## Key Decisions\n- ${markers.join(" ") || "bounded fallback"}\n\n## Next Steps\n1. Continue\n\n## Critical Context\n- ${markers.join(" ") || "attachment fallback"}`;
}

function replayResponse(
  markers: readonly string[],
  observed: Set<string>,
) {
  return (context: { messages: AgentMessage[] }) => {
    const serialized = JSON.stringify(context.messages);
    const received = markers.filter((marker) => serialized.includes(marker));
    for (const marker of received) observed.add(marker);
    return fauxAssistantMessage(summary(received));
  };
}

function replayRuntime(
  model: Model<Api>,
  streamSimple: ResolvedModelRuntime["streams"]["streamSimple"],
): ResolvedModelRuntime {
  return {
    models: createModels(),
    provider: {
      id: model.provider, kind: "openai", label: "Replay provider", baseUrl: model.baseUrl,
      models: [model.id], needsKey: false, deployment: "hosted",
    },
    model,
    apiKey: undefined,
    headers: undefined,
    streams: { streamSimple },
  };
}

async function childSurfaceReplay(): Promise<boolean> {
  const core = createFauxCore({
    provider: "aiden-phase7-child-surface",
    models: [{ id: "phase7-child", contextWindow: 32_768 }],
  });
  let providerContext = "";
  let summaryCalls = 0;
  core.setResponses(Array.from({ length: 32 }, () => async (context) => {
    const serialized = JSON.stringify(context);
    if (/context summarization assistant/u.test(serialized)) {
      summaryCalls += 1;
      return fauxAssistantMessage(summary(serialized.includes("CHILD-909") ? ["CHILD-909"] : []));
    }
    providerContext = serialized;
    return fauxAssistantMessage(serialized.includes("CHILD-909") ? "continued CHILD-909" : "continuity missing");
  }));
  const model = core.getModel() as Model<Api>;
  const registry = new SubagentRuntimeRegistry();
  const child = registry.create({
    authority: { generationId: "phase7", chatId: "phase7-child", workspaceId: "phase7-workspace" },
    groupId: "phase7-child",
    runtime: replayRuntime(model, core.streamSimple),
    thinkingLevel: "off",
    systemPrompt: "Continue the fork faithfully.",
    tools: [],
    initialMessages: [
      ...historicalTurns("child-surface", 10, 10_000),
      user("Child first task must preserve CHILD-909 before provider I/O"),
    ],
  });
  const outcome = await child.prompt("Continue CHILD-909.");
  await registry.shutdown(1_000);
  return outcome.kind === "completed" && summaryCalls > 0 && providerContext.includes("CHILD-909");
}

async function botTelegramSurfaceReplay(): Promise<boolean> {
  const core = createFauxCore({
    provider: "aiden-phase7-bot-surface",
    models: [{ id: "phase7-bot", contextWindow: 1_000, maxTokens: 200 }],
  });
  core.setResponses(Array.from({ length: 4 }, () => async (context) => {
    const serialized = JSON.stringify(context);
    return fauxAssistantMessage(summary(serialized.includes("BOT-314") ? ["BOT-314"] : []));
  }));
  const model = core.getModel() as Model<Api>;
  const runtime = replayRuntime(model, core.streamSimple);
  const session = createPiSessionPort(await new InMemorySessionRepo().create({ id: "phase7-bot" }));
  const chat = {
    id: "phase7-bot", title: "Bot replay", botId: "bot-314", providerId: model.provider,
    model: model.id, workspaceId: "workspace", createdAt: 1, updatedAt: 2,
    messages: Array.from({ length: 8 }, (_, index) => [
      { id: `u-${index}`, role: "user", content: `Mac ${index} ${"x".repeat(1_000)}`, createdAt: index * 2 + 1 },
      { id: `a-${index}`, role: "assistant", content: `Telegram ${index} BOT-314`, createdAt: index * 2 + 2 },
    ]).flat(),
  } as Chat;
  const service = new ContextLifecycleService({
    getChat: async () => chat,
    listChatsByBot: async () => [chat],
    isBotArchived: async () => false,
    beginChatTurn: () => ({
      chatId: chat.id, turnId: "phase7", ownerId: "telegram:phase7", isActive: () => true,
      reserveAppendPayload: () => undefined, reserveSkillPreparation: () => undefined,
      prepareSkillInvocation: () => undefined, settleAsyncWork: () => undefined,
      onReleased: () => undefined, release: () => undefined,
    }),
    openSession: async () => session,
    resolveRuntime: async () => runtime,
    resolveThinkingLevel: async () => "off",
  });
  const result = await createTelegramLifecycleAdapter(service, "phase7").compactChat(chat.id);
  return result.compacted && core.state.callCount > 0 &&
    JSON.stringify((await session.buildContext()).messages).includes("BOT-314");
}

async function semanticReplay(caseId: PiUpgradeReplayCaseId, fixture: ExecutableCase): Promise<PiUpgradeReplayMeasurement> {
  const provider = fauxProvider({
    api: "openai-completions",
    provider: `replay-${caseId}`,
    models: [{ id: "summary-model", contextWindow: 1_000, maxTokens: 200 }],
  });
  const providerObservedMarkers = new Set<string>();
  // Split-turn compaction can perform both a history and a turn-prefix summary.
  // Queue enough deterministic provider responses for both calls at each checkpoint.
  const responseCount = caseId === "repeated_compaction" ? 8 : 4;
  const responses = Array.from(
    { length: responseCount },
    () => replayResponse(fixture.markers, providerObservedMarkers),
  );
  provider.setResponses(responses);
  const models = createModels();
  models.setProvider(provider.provider);
  const model = provider.getModel() as Model<Api>;
  const session = createPiSessionPort(await new InMemorySessionRepo().create({ id: `replay-${caseId}` }));
  const events: PiCompactionEvent[] = [];
  const coordinator = new PiCompactionCoordinator({
    session,
    models,
    model,
    thinkingLevel: "off",
    settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    onEvent: (event) => events.push(event),
  });
  const started = performance.now();
  const replayMessages = [
    ...fixture.messages,
    assistantText(`Replay continuation acknowledged ${fixture.markers.join(" ")}.`),
  ].map((message, index, all): AgentMessage => {
    const timestamp = Date.now() + index;
    if (message.role !== "assistant") return { ...message, timestamp };
    const isTerminal = index === all.length - 1;
    return {
      ...message,
      ...(caseId === "provider_model_switch" && !isTerminal ? {} : {
        api: model.api,
        provider: model.provider,
        model: model.id,
      }),
      timestamp,
    };
  });
  const primaryChecks: Array<{ compacted: boolean }> = [];
  const appendAndCheck = async (messages: AgentMessage[], timestampOffset = 0) => {
    const adjusted = messages.map((message) => ({
      ...message,
      timestamp: (message.timestamp ?? Date.now()) + timestampOffset,
    })) as AgentMessage[];
    for (const message of adjusted) await session.appendMessage(message);
    const terminal = [...adjusted]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant");
    if (!terminal) throw new Error(`Replay case ${caseId} has no assistant checkpoint.`);
    const check = await coordinator.check(terminal);
    primaryChecks.push(check);
  };
  if (caseId === "repeated_compaction") {
    const firstCheckpointEnd = 13;
    await appendAndCheck(replayMessages.slice(0, firstCheckpointEnd));
    await appendAndCheck(replayMessages.slice(firstCheckpointEnd), 10_000);
  } else {
    await appendAndCheck(replayMessages);
  }
  const primaryResults = events.flatMap((event) => event.type === "end" && event.result ? [event.result] : []);
  const context = await session.buildContext();
  const serialized = JSON.stringify(context.messages);
  const retained = fixture.markers.filter((marker) => serialized.includes(marker)).length;
  let turnsUntilNextCompaction = 0;
  const primaryResultCount = primaryResults.length;
  for (const inputTokens of [700, 950, 950]) {
    turnsUntilNextCompaction += 1;
    const timestamp = Date.now() + 20_000 + turnsUntilNextCompaction;
    await session.appendMessage({ ...user(`observed follow-up ${turnsUntilNextCompaction}`), timestamp });
    const next = {
      ...assistantText(`observed answer ${turnsUntilNextCompaction}`, model.provider, model.id),
      api: model.api,
      usage: {
        ...assistantText("").usage,
        input: inputTokens,
        totalTokens: inputTokens + 20,
      },
      timestamp: timestamp + 1,
    } as AssistantMessage;
    await session.appendMessage(next);
    const before = events.filter((event) => event.type === "end" && event.result).length;
    await coordinator.check(next);
    const after = events.filter((event) => event.type === "end" && event.result).length;
    if (after > before) break;
  }
  const usage = primaryResults.reduce((total, result) => ({
    cacheRead: total.cacheRead + (result.usage?.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (result.usage?.cacheWrite ?? 0),
    cost: total.cost + (result.usage?.cost.total ?? 0),
  }), { cacheRead: 0, cacheWrite: 0, cost: 0 });
  const surfaceCorrect = caseId === "child_initial_fork"
    ? await childSurfaceReplay()
    : caseId === "bot_mac_telegram_alternation"
      ? await botTelegramSurfaceReplay()
      : true;
  return {
    caseId,
    continuationCorrect:
      retained === fixture.markers.length &&
      surfaceCorrect &&
      primaryResults.length === (caseId === "repeated_compaction" ? 2 : 1) &&
      (fixture.projectionCheck?.(fixture.messages) ?? true),
    pendingReferencesExpected: fixture.markers.length,
    pendingReferencesRetained: retained,
    tokensBefore: primaryResults.reduce((total, result) => total + result.tokensBefore, 0),
    tokensAfter: primaryResults.reduce((total, result) => total + result.estimatedTokensAfter, 0),
    durationMs: performance.now() - started,
    costMicros: usage.cost * 1_000_000,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    turnsUntilNextCompaction,
    emergencyProjections: 0,
    noOpAttempts: primaryChecks.filter((check) => !check.compacted).length +
      Math.max(0, primaryResultCount - primaryChecks.length),
    migrationFailures: 0,
  };
}

export async function runPiUpgradeReplayCases(): Promise<PiUpgradeReplayMeasurement[]> {
  let migrationFailures = 0;
  const migrationRoot = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-evaluation-migration-"));
  try {
    const journal = path.join(migrationRoot, "replay-migration.jsonl");
    const lines = (await readFile(path.resolve("main/services/fixtures/pi-legacy/uncompacted.jsonl"), "utf8")).split("\n");
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    header.id = "replay-migration";
    header.cwd = migrationRoot;
    header.metadata = { kind: "aiden-chat-compaction-v1", chatId: "replay-migration" };
    lines[0] = JSON.stringify(header);
    await writeFile(journal, lines.join("\n"), { mode: 0o600 });
    const migrated = await migratePiSessionJournal(journal, "replay-migration");
    if (migrated.receipt.validation !== "passed" || migrated.receipt.newFormat !== "pi-session-v4" ||
      JSON.parse((await readFile(journal, "utf8")).split("\n")[0]!).version !== 4) {
      migrationFailures += 1;
    }
  } catch {
    migrationFailures += 1;
  } finally {
    await rm(migrationRoot, { recursive: true, force: true });
  }
  return Promise.all(PI_UPGRADE_REPLAY_CASE_IDS.map(async (caseId, caseIndex) => {
    const fixture = executableCase(caseId);
    if (caseId !== "attachment_heavy_first_prompt") {
      const measurement = await semanticReplay(caseId, fixture);
      return { ...measurement, migrationFailures: caseIndex === 0 ? migrationFailures : 0 };
    }
    const started = performance.now();
    const result = compactGenerationContext(fixture.messages, options);
    const serialized = JSON.stringify(result.messages);
    const retained = fixture.markers.filter((marker) => serialized.includes(marker)).length;
    const fallbackCorrect = fixture.expectedFallback === undefined || result.usedContextFallback === fixture.expectedFallback;
    const projectionCorrect = fixture.projectionCheck?.(fixture.messages) ?? true;
    let turnsUntilNextCompaction = 0;
    const probe = [...result.messages];
    for (const inputTokens of [8_000, 15_500, 15_500]) {
      turnsUntilNextCompaction += 1;
      const next = assistantText(`attachment follow-up ${turnsUntilNextCompaction}`);
      next.usage.input = inputTokens;
      next.usage.totalTokens = inputTokens + next.usage.output;
      probe.push(user(`attachment follow-up ${turnsUntilNextCompaction}`), next);
      if (projectNextContextUsage(probe, options).shouldCompact) break;
    }
    return {
      caseId,
      continuationCorrect: fallbackCorrect && projectionCorrect && retained === fixture.markers.length,
      pendingReferencesExpected: fixture.markers.length,
      pendingReferencesRetained: retained,
      tokensBefore: result.estimatedTokensBefore,
      tokensAfter: result.estimatedTokensAfter,
      durationMs: performance.now() - started,
      costMicros: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turnsUntilNextCompaction,
      emergencyProjections: result.emergencyProjection.kind === "none" ? 0 : 1,
      noOpAttempts: result.compacted && result.estimatedTokensAfter >= result.estimatedTokensBefore ? 1 : 0,
      migrationFailures: caseIndex === 0 ? migrationFailures : 0,
    };
  }));
}
