// Prefix stability across turns of one chat, measured on the rendered
// provider payload. Cases a later phase of docs/plans/prompt-cache-hit-rate.md
// fixes are marked `todo` (they run and report, but do not fail the suite);
// the phase that fixes a cause removes its `todo`.
//
// Each changing case builds its heads through the builders the product uses
// (`buildWorkspaceChatBasePrompt` and `assembleChatPrompt` as llm-client calls
// them, the real memory extension, `composeBotSystemSections`), and also
// checks that the changed value still reaches the request, so a fix that
// drops the information instead of moving it fails.

import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { BotOpenWorkItem, BotOpenWorkSnapshot } from "../../renderer/shared/bot-open-work.js";
import { renderBotMemorySection, withBotMemoryEdits } from "./bot-memory/prompt.js";
import { createBotMemoryService } from "./bot-memory/service.js";
import { createBotMemoryStore } from "./bot-memory/store.js";
import { botMemoryToolEntry, withBotMemoryIngress } from "./bot-memory/tool.js";
import { botOpenWorkPromptTail } from "./bot-open-work/prompt.js";
import { createBotRegistry, type BotExtensionDeps } from "./bot-runtime/bot-extension.js";
import { botIngressAllowsTool } from "./bot-runtime/bot-tool-policy.js";
import { createFauxModels, FAUX_MODEL_REF } from "./bot-runtime/test-support/faux.js";
import { recordingDeps } from "./bot-runtime/test-support/fixtures.js";
import { composeBotSystemSections } from "./bot-system-prompt.js";
import { assembleChatPrompt, buildWorkspaceChatBasePrompt, type ChatPromptAssembly } from "./chat-prompt-assembly.js";
import { buildSystemPrompt, type ChatSystemPromptPermission } from "./chat-system-prompt.js";
import { createMemoryExtension } from "./memory-context.js";
import { hookContextMessage, hookTurnContextText } from "./workspace-chat-hooks.js";
import { turnNoteMessage } from "./chat-frozen-state.js";
import { fingerprintPromptPrefix } from "./pi-cache-telemetry.js";
import type { MemoryFact, MemoryScope, MemoryStore } from "./memory-store.js";
import { markMcpAgentTool } from "./mcp-tool-identity.js";
import { createPiCodemodeTool } from "./pi-codemode.js";
import { forgetPromptSectionDeviceKeys } from "./prompt-section-secret.js";
import { LOAD_TOOLS_TOOL_NAME } from "./on-demand-tools.js";
import { createAidenAppTools } from "./aiden-app-tools.js";
import { canUseBrowserTools } from "./browser-tools.js";
import { canUseDeviceTools } from "./devices/device-tools.js";
import { designCanvasToolsAllowed } from "./design-canvas/canvas-tools.js";
import type { AppControlContext, AppControlsService } from "./app-controls-core.js";
import { chatToolOffers, chatTurnAudienceFor, chatTurnToolRefusal, declaresWindowTools, windowlessChatTurn, type ChatToolSurface, type ChatTurnAudience, type ChatTurnOwnerScope } from "./chat-turn-tool-policy.js";
import { remoteGenerationSurface, scheduledGenerationSurface } from "./conversation-surface-generation.js";
import { UNATTENDED_FOLLOW_UP_GENERATION } from "./follow-through/notice-delivery.js";
import { owedTurnStartRequest } from "./chat-owed-turn-start.js";
import { assembleAgentTools } from "./agent-tool-assembly.js";
import { subagentsAllowedForGeneration } from "./subagents/eligibility.js";
import { createGenerativeUiExtensionRuntime, shouldEnableGenerativeUiExtension } from "./generative-ui-extension.js";
import { createAskUserQuestionExtension, shouldEnableAskUserQuestionExtension } from "./ask-user-question-extension.js";
import { ROUTINE_NOTES_TOOL } from "./bot-runtime/bot-tool-policy.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import type { ApprovalWorkspaceFields } from "../../renderer/shared/approval-mode.js";
import type { Workspace } from "./types.js";
import { currentWorkspaceApproval, generationApprovalPolicy, legacyAccessOf } from "./approval-gate/run-approval.js";
import { workspaceToolApproval } from "./approval-gate/workspace-tool-approval.js";
import {
  comparePromptRequests,
  createPromptPrefixHarness,
  createPromptRequestRecorder,
  type PromptPrefixChatState,
  type PromptPrefixHarnessOptions,
  type PromptProviderContext,
  type PromptPrefixTurnInput,
  type PromptPrefixWire,
  type RecordedPromptRequest,
} from "./prompt-prefix-harness.js";

function textTool(name: string, description: string, output = "ok"): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async () => ({ content: [{ type: "text", text: output }], details: null }),
  };
}

const readFileTool = textTool("read_file", "Read a workspace file.", "file contents");
const listFilesTool = textTool("list_files", "List workspace files.", "a.ts\nb.ts");
const codemodeTool = textTool("codemode", "Run a short script over the available tools.");
// An on-demand tool: declared only once the model loads it. Only the full
// declaration carries the second sentence; the loader's catalog line stops at the first.
const classifyTool = textTool("classify", "Classify a document. Returns one label from the configured set.", "label: invoice");
const workspaceTools = [readFileTool, listFilesTool];

let screenshotCount = 0;
const computerUseTool: AgentTool = {
  name: "computer_use",
  label: "Computer use",
  description: "Operate the computer and return a screenshot.",
  parameters: Type.Object({ action: Type.String() }),
  execute: async () => {
    screenshotCount += 1;
    return {
      content: [
        { type: "text", text: `Screenshot ${screenshotCount}.` },
        { type: "image", data: Buffer.from(`png-${screenshotCount}`).toString("base64"), mimeType: "image/png" },
      ],
      details: null,
    };
  },
};

const reply = (text: string) => [fauxAssistantMessage(text)];

/** A workspace chat's head, built the way llm-client builds it. */
async function workspaceChat(options: {
  branch?: string;
  permission?: ChatSystemPromptPermission;
  tools?: AgentTool[];
  extensions?: PiAgentRuntimeExtension[];
} = {}): Promise<ChatPromptAssembly> {
  const tools = options.tools ?? workspaceTools;
  const extensions = options.extensions ?? [];
  const base = await buildWorkspaceChatBasePrompt({
    folderPath: "/workspace/project",
    branch: options.branch ?? "main",
    permission: options.permission ?? "ask",
    tools: [...tools, ...extensions.flatMap((extension) => extension.tools ?? [])],
  });
  return assembleChatPrompt({
    basePrompt: base.systemPrompt,
    ...(base.skills ? { baseSkills: base.skills } : {}),
    tools,
    resources: {},
    extensions,
    allowOnDemandTools: true,
  });
}

type TurnHead = ({ assembly: ChatPromptAssembly } | { systemPrompt: string; tools: AgentTool[] } | { chatState: PromptPrefixChatState }) & {
  /** Host messages journaled right after the prompt (hook context, a turn note). */
  following?: (promptTimestamp: number) => AgentMessage[];
  /** An unattended follow-up that connects none of the chat's servers. */
  connectorsWithheld?: boolean;
};

/**
 * A workspace chat whose branch, permission, memory and canvas the harness
 * freezes at its head and updates in the turn tail, as llm-client does.
 */
function statefulChat(state: {
  branch?: string;
  permission?: ChatSystemPromptPermission;
  extensions?: PiAgentRuntimeExtension[];
} = {}): { chatState: PromptPrefixChatState } {
  return {
    chatState: {
      branch: state.branch ?? "main",
      permission: state.permission ?? "ask",
      extensions: state.extensions ?? [],
      assembly: (head) => workspaceChat({ ...(head.branch ? { branch: head.branch } : {}), permission: head.permission, extensions: head.extensions }),
    },
  };
}

const lastOf = (requests: readonly RecordedPromptRequest[]) => requests[requests.length - 1]!;

/** The text of each user message a request sends, in order. */
const userTexts = (request: RecordedPromptRequest) => request.messages
  .filter((message) => message.role === "user")
  .map((message) => typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));

/** Two user turns; returns turn 1's last request and turn 2's first. */
async function twoTurns(options: PromptPrefixHarnessOptions, first: TurnHead, second: TurnHead = first) {
  const harness = createPromptPrefixHarness(options);
  const one = await harness.turn({ prompt: "Summarize the project.", responses: reply("It is a small project."), ...first } as PromptPrefixTurnInput);
  const two = await harness.turn({ prompt: "Now list the files.", responses: reply("Here they are."), ...second } as PromptPrefixTurnInput);
  assert.equal(harness.networkCalls, 0);
  return { previous: lastOf(one), current: two[0]!, harness };
}

const tempRoots: string[] = [];
after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function agentsRoots(contents: string) {
  const root = await mkdtemp(path.join(tmpdir(), "aiden-prefix-"));
  tempRoots.push(root);
  const globalRoot = path.join(root, "global");
  const workspaceRoot = path.join(root, "workspace");
  // Stands in for the app data folder that holds the device's prompt section key.
  const userDataDir = path.join(root, "user-data");
  await Promise.all([mkdir(globalRoot), mkdir(workspaceRoot), mkdir(userDataDir)]);
  await writeFile(path.join(workspaceRoot, "AGENTS.md"), contents);
  return {
    globalRoot,
    workspaceRoot,
    userDataDir,
    // The production reader is a native helper; this reads the same anchored file directly.
    read: async (anchored: { canonicalPath: string }) => readFile(path.join(anchored.canonicalPath, "AGENTS.md"), "utf8"),
  };
}

const mcpSection = () => "<mcp_servers>\nlinear: issue tracker tools.\n</mcp_servers>";

/** One MCP server's tool, shaped the way the MCP manager builds it for codemode. */
function mcpServerTool(serverId: string, label: string, description: string, output = "ok"): AgentTool {
  return markMcpAgentTool(Object.assign(textTool(`${serverId}_search`, `Search ${label}.`, output), {
    codemode: true,
    discovery: Object.freeze({ namespace: `mcp:${serverId.padEnd(24, "0")}`, label, alias: serverId, description }),
  }), { serverId, toolName: "search" });
}

const wires: { wire: PromptPrefixWire; midConversationSystem: boolean; label: string }[] = [
  { wire: "anthropic-messages", midConversationSystem: false, label: "Anthropic Messages" },
  { wire: "anthropic-messages", midConversationSystem: true, label: "Anthropic Messages with in-place system messages" },
  { wire: "openai-responses", midConversationSystem: true, label: "OpenAI Responses with in-place system messages" },
];

/**
 * A store whose active facts are `facts`, newest first, read through the real
 * memory extension: like the real store, the always-on block holds the newest
 * six, and the rest stay approved and recallable.
 */
function memoryStore(facts: MemoryFact[]): MemoryStore {
  return {
    alwaysOn: async () => facts.slice(0, 6),
    list: async () => facts,
    recall: async () => [],
  } as unknown as MemoryStore;
}

const memoryScope: MemoryScope = { kind: "workspace", id: "workspace-1" };
const memoryFact = (id: string, text: string): MemoryFact => ({
  id, scope: memoryScope, text, provenance: { kind: "user_edit", sourceId: id }, createdAt: 1, updatedAt: 1,
  confidence: 1, reviewState: "approved", state: "active", alwaysOn: true,
});

const bot = {
  id: "bot-1",
  revision: "botrev:bot-1",
  name: "Bookkeeper",
  description: "Keeps the receipts in order",
  instructions: "Be brief.",
  avatar: { version: 1 as const, shape: "hex" as const, color: "sun" as const },
  createdAt: 1,
  updatedAt: 2,
};
const botWorkspace = {
  botId: bot.id,
  workspaceId: "8604cafe-0648-4b86-bdaa-fc6f27cc4781",
  homePath: "/bots/bot-1",
  createdAt: 4,
  incarnation: { device: "1", inode: "2" },
};
const openWorkItem = (id: string, title: string): BotOpenWorkItem => ({
  id, revision: "r1", title, note: "", state: "open", createdAt: 1, updatedAt: 1,
  source: { kind: "person" }, links: [], execution: { state: "idle", canStop: false },
});
const openWork = (items: BotOpenWorkItem[]): BotOpenWorkSnapshot => ({ botId: bot.id, revision: String(items.length), items, undo: [] });

/**
 * A Bot chat on Pi Durable, the runtime Bots use: the Bot extension's own
 * sections (base, persona, authority and guidance fixed per refresh, the
 * memory section rendered before every request) over a real memory service.
 * The faux model clones each provider context it is given; a turn renders
 * them through the wire adapter afterwards.
 */
async function botChat(options: { userMemory: string; openWork?: BotOpenWorkItem[]; extraTools?: AgentTool[]; midConversationSystem?: boolean }) {
  const profileDir = await mkdtemp(path.join(tmpdir(), "aiden-prefix-bot-"));
  tempRoots.push(profileDir);
  const memoryDir = path.join(profileDir, "bots", bot.id, "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(path.join(memoryDir, "USER.md"), options.userMemory);
  const memory = createBotMemoryService({ store: createBotMemoryStore({ profileDir }) });
  const state = { openWork: options.openWork ?? [] };
  const deps: BotExtensionDeps = {
    ...recordingDeps(),
    loadBot: async () => bot,
    currentTools: async () => [
      botMemoryToolEntry(bot.id, memory),
      { tool: readFileTool, replay: "safe" },
      { tool: textTool("open_work", "Read and update the Bot's open work."), replay: "safe" },
      ...(options.extraTools ?? []).map((tool) => ({ tool, replay: "safe" as const })),
    ],
    turnAllows: withBotMemoryIngress(botIngressAllowsTool),
    // The sections as bot-session-main composes them.
    systemSections: async (_bot, offered) => {
      const toolNames = new Set(offered.toolNames);
      const base = await buildSystemPrompt(botWorkspace.homePath, undefined, "full", false, true, undefined, toolNames);
      return composeBotSystemSections({
        base,
        bot,
        workspace: botWorkspace,
        fileAuthority: { mode: "full_mac", botHome: true },
        rules: "",
        offeredToolNames: toolNames,
        toolGuidance: "",
        lessons: "",
      });
    },
    // Open work and the person's memory edits as bot-session-main appends them: after the person's input.
    promptTail: async (botId, offered) => withBotMemoryEdits(
      await botOpenWorkPromptTail(offered.toolNames, async () => openWork(state.openWork)),
      memory.takeEdits(botId),
    ),
    memorySection: async (botId, offer) => renderBotMemorySection(await memory.snapshot(botId), offer),
  };
  const fauxModels = createFauxModels();
  const recorder = createPromptRequestRecorder({ model: fauxModels.faux.getModel(), midConversationSystem: options.midConversationSystem ?? false });
  const registry = createBotRegistry(bot.id, deps);
  await registry.refresh();
  const ctx = BACKGROUND_CONTEXT;
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  let turnNumber = 0;
  return {
    memory,
    state,
    /** `requestId` names the ingress the way the Bot session service does (`routine:`, `tg:`, none for a person). */
    async turn(prompt: string, responses: ReturnType<typeof fauxAssistantMessage>[], requestId?: string): Promise<RecordedPromptRequest[]> {
      turnNumber += 1;
      const thisTurn = turnNumber;
      const captured: PromptProviderContext[] = [];
      const capture = (response: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory => (context) => {
        captured.push(structuredClone(context) as PromptProviderContext);
        return response;
      };
      fauxModels.faux.setResponses(responses.map(capture));
      // The Bot session service refreshes the registry before every turn.
      await registry.refresh();
      await (await root.submit({ type: "input", content: prompt, ...(requestId === undefined ? {} : { requestId }) }, ctx)).wait(ctx);
      assert.equal(captured.length, responses.length, "every scripted response was requested");
      const requests: RecordedPromptRequest[] = [];
      for (const [index, context] of captured.entries()) requests.push(await recorder.record(context, { turn: thisTurn, step: index + 1 }));
      assert.equal(recorder.networkCalls, 0);
      return requests;
    },
    close: () => harness.close(ctx),
  };
}

/** Two Bot turns; returns turn 1's last request and turn 2's first. */
async function twoBotTurns(
  chat: Awaited<ReturnType<typeof botChat>>,
  between: () => Promise<void> = async () => {},
  firstResponses = reply("Noted."),
) {
  try {
    const one = await chat.turn("What is open?", firstResponses);
    await between();
    const two = await chat.turn("And now?", reply("Here it is."));
    return { previous: lastOf(one), current: two[0]! };
  } finally {
    await chat.close();
  }
}

describe("prompt prefix stability: already stable", () => {
  for (const { wire, midConversationSystem, label } of wires) {
    test(`a second turn extends the first turn's request (${label})`, async () => {
      const { previous, current } = await twoTurns({ wire, midConversationSystem }, { assembly: await workspaceChat() });
      assert.deepEqual(comparePromptRequests(previous, current), {});
      assert.ok(current.wire.length > previous.wire.length, "turn 2 appends to the prefix");
    });

    test(`an unchanged MCP section keeps the prefix (${label})`, async () => {
      // A section patch applied at turn start reaches the head before the run
      // sends anything, through the managed run's shared prepare step, so
      // this holds with compaction on or off.
      const { previous, current } = await twoTurns(
        { wire, midConversationSystem, mcpServersSection: mcpSection },
        { assembly: await workspaceChat() },
      );
      assert.deepEqual(comparePromptRequests(previous, current), {});
      assert.ok(current.carries("linear: issue tracker tools."), "the section still reaches turn 2");
    });

    test(`a turn's hook context is journaled after its prompt and later turns keep it (${label})`, async () => {
      const context = hookTurnContextText(["ticket: OPS-12"])!;
      const harness = createPromptPrefixHarness({ wire, midConversationSystem });
      const assembly = await workspaceChat();
      const one = await harness.turn({
        prompt: "Summarize the project.", assembly, responses: reply("It is a small project."),
        following: (timestamp) => [hookContextMessage(context, timestamp)],
      });
      const [two] = await harness.turn({ prompt: "Now list the files.", assembly, responses: reply("Here they are.") });
      assert.deepEqual(comparePromptRequests(lastOf(one), two!), {});
      // The prompt, then the hook context as its own user message, then the reply.
      const texts = userTexts(two!);
      assert.deepEqual(texts.slice(0, 2), ["Summarize the project.", context]);
      assert.equal(texts[texts.length - 1], "Now list the files.");
    });
  }

  test("each step of a tool loop extends the step before it", async () => {
    const harness = createPromptPrefixHarness();
    const requests = await harness.turn({
      prompt: "Read both files.",
      assembly: await workspaceChat(),
      responses: [
        fauxAssistantMessage(fauxToolCall("list_files", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Done."),
      ],
    });
    assert.equal(requests.length, 3);
    for (let index = 1; index < requests.length; index += 1) {
      assert.deepEqual(comparePromptRequests(requests[index - 1]!, requests[index]!), {}, `step ${index + 1}`);
    }
  });

  test("a tool loaded in one turn is declared from the start of the next", async () => {
    const assembly = await workspaceChat({ tools: [...workspaceTools, codemodeTool, classifyTool] });
    const harness = createPromptPrefixHarness();
    const first = await harness.turn({
      prompt: "Classify the attachment.",
      assembly,
      responses: [
        fauxAssistantMessage(fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["classify"] }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("classify", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("It is an invoice."),
      ],
    });
    const second = await harness.turn({ prompt: "And the next one?", assembly, responses: reply("Also an invoice.") });
    assert.deepEqual(comparePromptRequests(lastOf(first), second[0]!), {});
    assert.ok(second[0]!.carries("Returns one label from the configured set."), "the loaded tool stays declared");
  });

  test("a workspace without AGENTS.md adds no section, so turns stay stable", async () => {
    const roots = await agentsRoots("");
    const { previous, current } = await twoTurns({ agentsInstructions: roots }, { assembly: await workspaceChat() });
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("a Bot's second turn extends the first, memory section included", async () => {
    const chat = await botChat({ userMemory: "Prefers short answers.", openWork: [openWorkItem("w1", "Draft the weekly note")] });
    const { previous, current } = await twoBotTurns(chat);
    assert.ok(current.carries("Prefers short answers."), "the memory section reaches turn 2");
    assert.ok(current.carries("Draft the weekly note"), "open work reaches turn 2");
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("a Bot's own memory save keeps the next turn's prefix", async () => {
    // The memory section stays as the session first read it until a person edit or a new session.
    const chat = await botChat({ userMemory: "Prefers short answers." });
    const { previous, current } = await twoBotTurns(chat, async () => {}, [
      fauxAssistantMessage(
        fauxToolCall("bot_memory", { target: "user", operations: [{ action: "add", content: "Has a dog." }] }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Saved."),
    ]);
    assert.ok((await chat.memory.view(bot.id)).user.entries.some(({ text }) => text === "Has a dog."), "the save landed");
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("no message is edited in place once a request has carried it", async () => {
    // The miss telemetry hashes each message object once (a WeakMap memo), so
    // an in-place edit would go unreported. Compare each request's fingerprint
    // taken when it was sent with one of fresh copies of the same objects now.
    screenshotCount = 0;
    const roots = await agentsRoots("Use tabs for indentation.\n");
    const harness = createPromptPrefixHarness({ agentsInstructions: roots, mcpServersSection: mcpSection });
    const assembly = await workspaceChat({ tools: [...workspaceTools, codemodeTool, classifyTool, computerUseTool] });
    const look = (index: number) => fauxAssistantMessage(fauxToolCall("computer_use", { action: `look-${index}` }), { stopReason: "toolUse" });
    const requests = [
      ...await harness.turn({
        prompt: "Classify the attachment, then check the screen.",
        assembly,
        responses: [
          fauxAssistantMessage(fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["classify"] }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall("classify", {}), { stopReason: "toolUse" }),
          look(1), look(2), look(3),
          fauxAssistantMessage("Done."),
        ],
      }),
      ...await harness.turn({ prompt: "Check it again.", assembly, responses: [look(4), look(5), fauxAssistantMessage("Still fine.")] }),
      ...await harness.turn({ prompt: "Thanks.", assembly, responses: reply("Any time.") }),
    ];
    // The first call to the held-back computer tool loads it rather than running it.
    assert.equal(screenshotCount, 4, "more screenshots than the history keeps whole");
    const model = { provider: "fresh-copy", id: "fresh-copy" };
    for (const request of requests) {
      const now = fingerprintPromptPrefix({ messages: JSON.parse(JSON.stringify(request.messages)), model });
      assert.deepEqual(now.messages, request.fingerprint.messages, `turn ${request.turn}, step ${request.step}`);
    }
  });

  test("a restarted app frames a chat's AGENTS.md section with the same bytes", async () => {
    // The nonce comes from the device key in the app data folder, so the first
    // request after a restart matches the last session's for the same chat.
    const roots = await agentsRoots("Use tabs for indentation.\n");
    const assembly = await workspaceChat();
    const first = async () => {
      const harness = createPromptPrefixHarness({ agentsInstructions: roots });
      return (await harness.turn({ prompt: "Summarize the project.", responses: reply("It is a small project."), assembly }))[0]!;
    };
    const beforeRestart = await first();
    forgetPromptSectionDeviceKeys();
    const afterRestart = await first();
    assert.ok(afterRestart.carries("Use tabs for indentation."));
    assert.deepEqual(comparePromptRequests(beforeRestart, afterRestart), {});
  });

  for (const { wire, midConversationSystem, label } of wires) {
    test(`AGENTS.md section is identical across turns (${label})`, async () => {
      const roots = await agentsRoots("Use tabs for indentation.\n");
      const { previous, current } = await twoTurns(
        { wire, midConversationSystem, agentsInstructions: roots },
        { assembly: await workspaceChat() },
      );
      assert.ok(current.carries("Use tabs for indentation."), "the instructions still reach turn 2");
      assert.deepEqual(comparePromptRequests(previous, current), {});
    });

    test(`an edited AGENTS.md is the first difference on the next turn (${label})`, async () => {
      // The oracle for the stable case: a real edit still reaches the model and is named.
      const roots = await agentsRoots("Use tabs for indentation.\n");
      const harness = createPromptPrefixHarness({ wire, midConversationSystem, agentsInstructions: roots });
      const assembly = await workspaceChat();
      const one = await harness.turn({ prompt: "Summarize the project.", responses: reply("It is a small project."), assembly });
      await writeFile(path.join(roots.workspaceRoot, "AGENTS.md"), "Use spaces for indentation.\n");
      const [two] = await harness.turn({ prompt: "Now list the files.", responses: reply("Here they are."), assembly });
      assert.ok(two!.carries("Use spaces for indentation."));
      assert.ok(!two!.carries("Use tabs for indentation."));
      const comparison = comparePromptRequests(lastOf(one), two!);
      assert.notDeepEqual(comparison, {});
      assert.equal(comparison.transcript?.source, "system:agents-instructions");
    });
  }

  const connectingNote = "More services may still be connecting";

  for (const { wire, midConversationSystem, label } of wires) {
    test(`an MCP server admitted mid-turn is callable at once and joins the section at the next turn (${label})`, async () => {
      // Discovery that finishes past the admission window lands between two
      // steps of a turn. The server is callable at once through codemode; the
      // section keeps the turn-start render (with its note that more services
      // may connect) until the next user turn.
      const linear = mcpServerTool("linear", "Linear", "Issue tracker tools.");
      const notion = mcpServerTool("notion", "Notion", "Workspace notes and pages.", "Found the release page.");
      let admitted = false;
      const waitTool = textTool("wait_for_build", "Wait for the build to finish.");
      const waitForBuild: AgentTool = { ...waitTool, execute: async (...args) => { admitted = true; return waitTool.execute(...args); } };
      const harness = createPromptPrefixHarness({
        wire,
        midConversationSystem,
        lateMcp: { tools: () => (admitted ? [notion] : []), pending: () => (admitted ? 0 : 1) },
      });
      const codemode = createPiCodemodeTool({
        tools: () => harness.callableTools(),
        executeTool: (...args) => harness.executeNestedToolCall(...args),
        settled: async () => {},
      });
      const one = await harness.turn({
        prompt: "Wait for the build, then find the release page.",
        assembly: await workspaceChat({ tools: [...workspaceTools, codemode, waitForBuild, linear] }),
        responses: [
          fauxAssistantMessage(fauxToolCall("wait_for_build", {}), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall("codemode", { code: "text(await tools.notion_search({}));" }), { stopReason: "toolUse" }),
          fauxAssistantMessage("Found it."),
        ],
      });
      assert.equal(one.length, 3);
      assert.ok(one[0]!.carries("Issue tracker tools."), "the admitted server is in the section");
      assert.ok(one[0]!.carries(connectingNote), "the section says more services may still connect");
      assert.ok(one[2]!.carries("Found the release page."), "the late server answered a codemode call mid-turn");
      assert.ok(!one[2]!.carries("Workspace notes and pages."), "the late server waits for the next turn's section");
      assert.deepEqual(comparePromptRequests(one[0]!, one[1]!), {});
      assert.deepEqual(comparePromptRequests(one[1]!, one[2]!), {});
      const [two] = await harness.turn({
        prompt: "Now add a page about it.",
        assembly: await workspaceChat({ tools: [...workspaceTools, codemode, waitForBuild, linear, notion] }),
        responses: reply("Added."),
      });
      assert.ok(two!.carries("Workspace notes and pages."), "the next turn's section lists the late server");
      assert.ok(!two!.carries(connectingNote), "nothing is still connecting");
      assert.equal(comparePromptRequests(lastOf(one), two!).transcript?.source, "system:mcp-servers");
      assert.equal(harness.networkCalls, 0);
    });

    test(`an MCP server removed mid-chat leaves the section at the next turn (${label})`, async () => {
      const linear = mcpServerTool("linear", "Linear", "Issue tracker tools.");
      const notion = mcpServerTool("notion", "Notion", "Workspace notes and pages.");
      const codemode = textTool("codemode", "Run a short script over the available tools.");
      const harness = createPromptPrefixHarness({ wire, midConversationSystem, lateMcp: { tools: () => [], pending: () => 0 } });
      const turn = async (prompt: string, servers: AgentTool[]) => harness.turn({
        prompt,
        assembly: await workspaceChat({ tools: [...workspaceTools, codemode, ...servers] }),
        responses: reply("Done."),
      });
      const [both] = await turn("Check the tracker and the notes.", [linear, notion]);
      assert.ok(both!.carries("Issue tracker tools.") && both!.carries("Workspace notes and pages."));
      const [linearOnly] = await turn("Check the tracker.", [linear]);
      assert.ok(linearOnly!.carries("Issue tracker tools."));
      assert.ok(!linearOnly!.carries("Workspace notes and pages."), "the removed server is gone");
      assert.equal(comparePromptRequests(both!, linearOnly!).transcript?.source, "system:mcp-servers");
      const [none] = await turn("Anything else?", []);
      assert.ok(!none!.carries("Issue tracker tools.") && !none!.carries("Workspace notes and pages."));
      assert.ok(!none!.carries("<mcp_servers>"), "no empty section is left behind");
      assert.equal(comparePromptRequests(linearOnly!, none!).transcript?.source, "system:mcp-servers");
      assert.equal(harness.networkCalls, 0);
    });
  }

  test("the harness names a changed base prompt as the first difference", async () => {
    // The oracle the todo cases rely on: a real change is reported, at the system segment.
    const { previous, current } = await twoTurns(
      {},
      { systemPrompt: "Base prompt, version one.", tools: workspaceTools },
      { systemPrompt: "Base prompt, version two.", tools: workspaceTools },
    );
    const comparison = comparePromptRequests(previous, current);
    assert.equal(comparison.wire?.kind, "system");
    assert.equal(comparison.transcript?.source, "system:base");
  });
});

describe("prompt prefix stability: tool list identical across turns", () => {
  // The rendered tool declarations, the first thing a request caches.
  const toolsOf = (request: RecordedPromptRequest) => request.wire.filter((segment) => segment.kind === "tools").map((segment) => segment.hash);
  const attended: ChatTurnAudience = chatTurnAudienceFor({}, {});
  const workspaceSurface: ChatToolSurface = { usageSource: "chat", bot: false, assistant: false, harnessProvider: false };
  // A chat's own tools that only an attended turn on this computer may run.
  const hooksTool = textTool("hooks", "List, propose and test this chat's hooks.");
  const workspaceArtifactTool = textTool("workspace_artifact", "Create, refresh or run a workspace artifact.");
  const chatTools = (surface: ChatToolSurface) => [
    ...workspaceTools, codemodeTool, computerUseTool, workspaceArtifactTool,
    ...(chatToolOffers(surface).hooks ? [hooksTool] : []),
  ];

  test("a workspace chat with inline visuals On request: a /visualize turn and a plain turn", async () => {
    const visuals = (visualize: boolean) => {
      const turn = { usageSource: "chat" as const, assistantMode: false, permission: "ask" as const, excluded: false, inlineVisuals: "on_request" as const };
      assert.equal(shouldEnableGenerativeUiExtension(turn), true, "On request declares the drawing tools on every turn");
      return createGenerativeUiExtensionRuntime({
        workspaceRoot: undefined, onArtifact: () => undefined, onUiVisual: () => undefined, onRequest: true, preferArtifactThisTurn: visualize,
      });
    };
    const plainTurn = visuals(false);
    const visualizeTurn = visuals(true);
    // llm-client journals the turn's note right after its prompt.
    const note = (timestamp: number) => [turnNoteMessage([visualizeTurn.turnNote], timestamp)!];
    const { previous, current } = await twoTurns(
      {},
      { assembly: await workspaceChat({ tools: chatTools(workspaceSurface), extensions: [plainTurn.extension] }) },
      { assembly: await workspaceChat({ tools: chatTools(workspaceSurface), extensions: [visualizeTurn.extension] }), following: note },
    );
    assert.deepEqual(comparePromptRequests(previous, current), {}, "tools and system are the same; /visualize rides after the prompt");
    assert.ok(current.carries("render_artifact"), "the drawing tools stay declared");
    const texts = userTexts(current);
    assert.equal(texts[texts.length - 2], "Now list the files.");
    assert.match(texts[texts.length - 1] ?? "", /<turn_note>[\s\S]*\/visualize[\s\S]*<\/turn_note>/u);
    const plain = chatTurnToolRefusal(workspaceSurface, chatTurnAudienceFor({}, { inlineVisuals: "on_request" }));
    assert.match(plain("render_artifact") ?? "", /not available in this turn.*\/visualize/su);
    assert.equal(chatTurnToolRefusal(workspaceSurface, chatTurnAudienceFor({}, { inlineVisuals: "on_request", visualize: true }))("render_artifact"), undefined);
  });

  test("a Bot chat: a routine turn, a person's turn and a Telegram turn", async () => {
    // The routine notepad is for routine runs alone; the other turns refuse its call.
    const routineNotes = textTool(ROUTINE_NOTES_TOOL, "Read and update this routine's notes.");
    const chat = await botChat({ userMemory: "Prefers short answers.", extraTools: [routineNotes] });
    try {
      const routine = await chat.turn("Run the brief.", reply("Brief done."), "routine:task-1:1000");
      const [person] = await chat.turn("What is open?", reply("Nothing."));
      const [telegram] = await chat.turn("Anything new?", reply("No."), "tg:chat-1:1");
      assert.ok(person!.carries("Read and update this routine's notes."), "the notepad stays declared");
      assert.deepEqual(comparePromptRequests(lastOf(routine), person!), {});
      assert.deepEqual(toolsOf(telegram!), toolsOf(person!));
    } finally {
      await chat.close();
    }
  });

  // The chat's declarations built the way llm-client builds them: the
  // generation options pass through subagent eligibility and the real tool
  // assembly, with the main-process sources replaced by fixed ones.
  type GenerationToolOptions = { usageSource: "chat"; unattended?: boolean; allowSubagents?: boolean; allowMcpTools?: boolean };
  const attendedGeneration: GenerationToolOptions = { usageSource: "chat" };
  const followUpGeneration: GenerationToolOptions = UNATTENDED_FOLLOW_UP_GENERATION;
  const linearServer = mcpServerTool("linear", "Linear", "Issue tracker tools.");
  const subagentTool = textTool("subagent", "Start a focused subagent; call with action list for what it can use.");
  const assembledChatTools = async (options: GenerationToolOptions) => {
    const allowSubagents = subagentsAllowedForGeneration({
      assistantMode: false,
      allowSubagents: options.allowSubagents !== false,
      usageSource: options.usageSource,
      workspaceId: "workspace",
      folderPath: "/workspace",
      permission: "ask",
    });
    const assembled = await assembleAgentTools({
      workspaceId: "workspace",
      permission: "ask",
      allowScheduling: false,
      includeCodingTools: false,
      allowMcpTools: options.allowMcpTools,
      allowSubagents,
      createSubagentTool: () => subagentTool,
    }, {
      configuredMcpTools: async () => [linearServer],
      webSearchToolForGeneration: async () => undefined,
      skillsEnabled: async () => false,
      skillSnapshot: async () => undefined,
    });
    return [...chatTools(workspaceSurface), ...assembled];
  };
  const followUpAudience: ChatTurnAudience = chatTurnAudienceFor(UNATTENDED_FOLLOW_UP_GENERATION, {});
  const followUpSurface: ChatToolSurface = { ...workspaceSurface, usageSource: UNATTENDED_FOLLOW_UP_GENERATION.usageSource };

  test("an unattended follow-up declares the chat's tools and refuses what nobody can approve", async () => {
    // A chat without connectors: everything the chat declares, the follow-up declares.
    const withoutConnectors = async (options: GenerationToolOptions) => (await assembledChatTools(options)).filter((tool) => tool !== linearServer);
    const { previous, current } = await twoTurns(
      {},
      { assembly: await workspaceChat({ tools: await withoutConnectors(attendedGeneration) }) },
      { assembly: await workspaceChat({ tools: await withoutConnectors(followUpGeneration) }) },
    );
    assert.deepEqual(comparePromptRequests(previous, current), {});
    assert.ok(current.carries("List, propose and test this chat's hooks."), "hooks stays declared");
    assert.ok(current.carries("Start a focused subagent"), "the subagent tool stays declared");
    const refuse = chatTurnToolRefusal(followUpSurface, followUpAudience);
    for (const name of ["hooks", "computer_use", "subagent"]) {
      assert.match(refuse(name) ?? "", /not available in this turn.*follow-up/su, name);
    }
    assert.equal(refuse("read_file"), undefined);
    const refuseAttended = chatTurnToolRefusal(workspaceSurface, attended);
    for (const name of ["hooks", "computer_use", "subagent"]) assert.equal(refuseAttended(name), undefined, name);
  });

  test("an unattended follow-up in a chat with connectors keeps the chat's connector section", async () => {
    const attendedTools = await assembledChatTools(attendedGeneration);
    assert.ok(attendedTools.includes(linearServer), "the attended turn declares the connector");
    const followUpTools = await assembledChatTools(followUpGeneration);
    assert.ok(!followUpTools.includes(linearServer), "the follow-up connects no server, so it has no connector tool to call");
    // The section is built from the turn's connector tools, as llm-client
    // builds it; the follow-up shows the one the attended turn journaled.
    const { previous, current, harness } = await twoTurns(
      { lateMcp: { tools: () => [], pending: () => 0 } },
      { assembly: await workspaceChat({ tools: attendedTools }) },
      { assembly: await workspaceChat({ tools: followUpTools }), connectorsWithheld: true },
    );
    assert.ok(previous.carries("Issue tracker tools."), "the attended turn lists the connector");
    assert.deepEqual(comparePromptRequests(previous, current), {});
    const texts = userTexts(current);
    assert.equal(texts[texts.length - 2], "Now list the files.");
    assert.match(texts[texts.length - 1] ?? "", /<turn_note>[\s\S]*not connected for this follow-up[\s\S]*<\/turn_note>/u);
    assert.ok(!harness.callableTools().some((tool) => tool.name === linearServer.name), "the listed connector cannot be called");
  });

  test("a chat that never connected a server shows no connector section on its follow-up", async () => {
    const withoutConnectors = async (options: GenerationToolOptions) => (await assembledChatTools(options)).filter((tool) => tool !== linearServer);
    const { previous, current } = await twoTurns(
      { lateMcp: { tools: () => [], pending: () => 0 } },
      { assembly: await workspaceChat({ tools: await withoutConnectors(attendedGeneration) }) },
      { assembly: await workspaceChat({ tools: await withoutConnectors(followUpGeneration) }), connectorsWithheld: true },
    );
    assert.deepEqual(comparePromptRequests(previous, current), {});
    assert.ok(!current.carries("not connected for this follow-up"), "no note when no connector is listed");
  });

  // A workspace chat turn's declarations, from the same gates llm-client
  // reads: Computer Use unless the turn withholds it, hooks from the chat's
  // surface, questions from who owns the turn, and the browser, Simulator,
  // design canvas and app-and-scheduling tools from whether the turn declares
  // a window's tools (`declaresWindowTools`), in a design-mode chat with
  // Simulator access on.
  const questionTool = textTool("ask_user_question", "Ask the person a question with choices.");
  const browserTool = textTool("browser_open", "Open a page in the in-app browser.");
  const deviceTool = textTool("device_list", "List the Simulator devices.");
  const canvasTool = textTool("canvas_place_frame", "Place a frame on the design canvas.");
  const ownerAppTools = createAidenAppTools({
    // Declaring the tools reads neither; only a call does.
    service: {} as AppControlsService,
    context: {} as AppControlContext,
    liveState: false,
    present: () => undefined,
  });
  /** The tools a turn declares only when it declares a window's tools; a windowless turn refuses each. */
  const windowGatedTools = (scope: ChatTurnOwnerScope, options: { excludeToolNames?: ReadonlySet<string> }) => {
    const declares = declaresWindowTools(scope);
    const owner = { permission: "ask", rendererOwner: declares, assistantMode: scope.assistantMode, bot: scope.botBound };
    const telegram = scope.interactionSurface === "telegram";
    return [
      ...(canUseBrowserTools(owner) ? [browserTool] : []),
      ...(canUseDeviceTools({ ...owner, enabled: true, agentAccess: true }) ? [deviceTool] : []),
      ...(!scope.botBound && !scope.assistantMode && !telegram && !options.excludeToolNames?.has("schedule_task") &&
        (declares || scope.remote) ? ownerAppTools : []),
      ...(designCanvasToolsAllowed({
        flagEnabled: true, localRenderer: declares && !scope.remote, assistant: scope.assistantMode,
        telegram, hasWorkspaceFolder: true, designMode: true,
      }) ? [canvasTool] : []),
    ].filter((tool) => !options.excludeToolNames?.has(tool.name));
  };
  const ownedTurnTools = (scope: ChatTurnOwnerScope, options: { allowComputerUse?: boolean; excludeToolNames?: ReadonlySet<string> }) => [
    ...workspaceTools, codemodeTool,
    ...(options.allowComputerUse === false ? [] : [computerUseTool]),
    workspaceArtifactTool,
    ...(chatToolOffers({ ...workspaceSurface, usageSource: scope.usageSource as ChatToolSurface["usageSource"], excludedToolNames: options.excludeToolNames }).hooks ? [hooksTool] : []),
    ...(shouldEnableAskUserQuestionExtension({
      usageSource: scope.usageSource as "chat",
      assistantMode: scope.assistantMode,
      botBound: scope.botBound,
      rendererOwner: declaresWindowTools(scope),
      remoteOwner: scope.remote,
      excluded: options.excludeToolNames?.has("ask_user_question") ?? false,
    }) ? [questionTool] : []),
    ...windowGatedTools(scope, options),
  ];
  const desktopScope: ChatTurnOwnerScope = { window: true, remote: false, usageSource: "chat", assistantMode: false, botBound: false };

  test("the turn a settled run owes its chat declares the chat's tools and refuses what needs a window", async () => {
    const owed = owedTurnStartRequest(
      { chatId: "chat", settledStreamId: "run", context: { providerId: "provider", model: "model" }, inputs: [{ messageId: "queued" }] },
      "owed",
    );
    // The owed turn's owner, as llm-client sees it: main, no window, no paired device.
    const owedScope: ChatTurnOwnerScope = { window: false, remote: false, usageSource: owed.options.usageSource, assistantMode: false, botBound: false };
    const { previous, current } = await twoTurns(
      {},
      { assembly: await workspaceChat({ tools: ownedTurnTools(desktopScope, {}) }) },
      { assembly: await workspaceChat({ tools: ownedTurnTools(owedScope, owed.options) }) },
    );
    assert.deepEqual(comparePromptRequests(previous, current), {});
    for (const description of ["List, propose and test this chat's hooks.", "Ask the person a question"]) {
      assert.ok(current.carries(description), description);
    }
    // Declared is not runnable: no window owns the owed turn, so every tool a
    // window's gate declared is refused, as llm-client lists them.
    const windowOnly = windowGatedTools(owedScope, owed.options).map((tool) => tool.name);
    for (const name of ["browser_open", "device_list", "aiden_open", "canvas_place_frame"]) {
      assert.ok(windowOnly.includes(name), `the owed turn declares ${name}`);
    }
    const refuse = chatTurnToolRefusal(workspaceSurface, {
      ...chatTurnAudienceFor({ windowless: windowlessChatTurn(owedScope) }, {}),
      windowOnlyToolNames: new Set(windowOnly),
    });
    for (const name of ["computer_use", "hooks", "ask_user_question", "todo", "advisor", ...windowOnly]) {
      assert.match(refuse(name) ?? "", /not available in this turn.*no window owns it/su, name);
    }
    for (const name of ["read_file", "workspace_artifact", "subagent"]) assert.equal(refuse(name), undefined, name);
    const refuseAttended = chatTurnToolRefusal(workspaceSurface, chatTurnAudienceFor({ windowless: windowlessChatTurn(desktopScope) }, {}));
    for (const name of ["computer_use", "hooks", "ask_user_question"]) assert.equal(refuseAttended(name), undefined, name);
  });

  test("a scheduled run in a chat, then a turn on this computer: the desktop turn keeps the chat's tools", async () => {
    const scheduled = scheduledGenerationSurface({
      chatId: "chat", streamId: "scheduled", ownerId: "schedule", workspaceId: "workspace",
      providerId: "provider", model: "model", mode: undefined, prompt: "Check the build.", permission: "full",
      excludeToolNames: new Set(["schedule_task"]), allowMcpTools: false,
    });
    const scheduledScope: ChatTurnOwnerScope = { window: false, remote: false, usageSource: scheduled.options.usageSource, assistantMode: false, botBound: false };
    // A scheduled run keeps its own tool policy; it is not a windowless chat turn.
    assert.equal(windowlessChatTurn(scheduledScope), false);
    const harness = createPromptPrefixHarness({});
    const desktopTools = ownedTurnTools(desktopScope, {});
    const first = await harness.turn({ prompt: "Summarize the project.", responses: reply("It is a small project."), assembly: await workspaceChat({ tools: desktopTools }) });
    const run = await harness.turn({ prompt: "Check the build.", responses: reply("The build passes."), assembly: await workspaceChat({ tools: ownedTurnTools(scheduledScope, scheduled.options) }) });
    const desktop = await harness.turn({ prompt: "Now list the files.", responses: reply("Here they are."), assembly: await workspaceChat({ tools: desktopTools }) });
    assert.equal(harness.networkCalls, 0);
    assert.notDeepEqual(toolsOf(run[0]!), toolsOf(lastOf(first)), "the scheduled run withholds Computer Use and hooks");
    // The desktop turn after it reads the cache the chat's earlier desktop turn wrote.
    assert.deepEqual(comparePromptRequests(lastOf(first), desktop[0]!), {});
  });

  for (const { wire, midConversationSystem, label } of wires) {
    test(`a remote-audience turn and a turn on this computer (${label})`, async () => {
      const remote = remoteGenerationSurface({
        chatId: "chat", turnId: "turn", streamId: "stream", ownerId: "owner",
        workspaceId: "workspace", providerId: "provider", model: "model", onTurnAccepted: () => undefined,
      });
      const appTools = (fromPhone: boolean) => createAidenAppTools({
        // Declaring the tools reads neither; only a call does.
        service: {} as AppControlsService,
        context: {} as AppControlContext,
        liveState: !fromPhone,
        ...(fromPhone ? {} : { open: async () => ({ opened: true }) }),
        present: () => undefined,
      });
      const visuals = (fromPhone: boolean) => createGenerativeUiExtensionRuntime({
        workspaceRoot: undefined, onArtifact: () => undefined, ...(fromPhone ? { audience: remote.options.visualAudience } : {}),
      });
      const head = async (fromPhone: boolean) => workspaceChat({
        tools: [...chatTools(workspaceSurface), ...appTools(fromPhone)],
        extensions: [visuals(fromPhone).extension],
      });
      const phoneNote = (timestamp: number) => [turnNoteMessage([visuals(true).turnNote], timestamp)!];
      const { previous, current } = await twoTurns(
        { wire, midConversationSystem },
        { assembly: await head(false) },
        { assembly: await head(true), following: phoneNote },
      );
      assert.deepEqual(comparePromptRequests(previous, current), {}, "the phone audience rides after the prompt, not in system");
      const texts = userTexts(current);
      assert.match(texts[texts.length - 1] ?? "", /<turn_note>[\s\S]*still image[\s\S]*<\/turn_note>/u);
      const fromPhone = chatTurnToolRefusal(workspaceSurface, chatTurnAudienceFor(remote.options, {}));
      assert.match(fromPhone("workspace_artifact") ?? "", /not available in this turn.*paired device/su);
      assert.match(fromPhone("hooks") ?? "", /paired device/u);
      assert.ok(current.carries("computer_use"), "Computer Use stays declared");
      assert.match(fromPhone("computer_use") ?? "", /not available in this turn.*paired device/su);
      assert.equal(chatTurnToolRefusal(workspaceSurface, attended)("workspace_artifact"), undefined);
    });
  }

  test("a paired device without question prompts and a turn on this computer", async () => {
    const outdatedPhone = remoteGenerationSurface({
      chatId: "chat", turnId: "turn", streamId: "stream", ownerId: "owner",
      workspaceId: "workspace", providerId: "provider", model: "model",
      questionPromptsUnavailable: true, onTurnAccepted: () => undefined,
    });
    // The client's own gate, given what each turn's options say.
    const questions = (options: { excludeToolNames?: ReadonlySet<string> }, owner: { rendererOwner: boolean; remoteOwner: boolean }) => {
      const declared = shouldEnableAskUserQuestionExtension({
        usageSource: "chat", assistantMode: false, botBound: false, ...owner,
        excluded: options.excludeToolNames?.has("ask_user_question") ?? false,
      });
      return declared ? [createAskUserQuestionExtension({ request: async () => { throw new Error("never asked"); } })] : [];
    };
    const { previous, current } = await twoTurns(
      {},
      { assembly: await workspaceChat({ tools: chatTools(workspaceSurface), extensions: questions({}, { rendererOwner: true, remoteOwner: false }) }) },
      { assembly: await workspaceChat({ tools: chatTools(workspaceSurface), extensions: questions(outdatedPhone.options, { rendererOwner: false, remoteOwner: true }) }) },
    );
    assert.ok(current.carries("ask_user_question"), "the question tool stays declared");
    assert.deepEqual(toolsOf(current), toolsOf(previous));
    const fromPhone = chatTurnToolRefusal(workspaceSurface, chatTurnAudienceFor(outdatedPhone.options, {}));
    assert.match(fromPhone("ask_user_question") ?? "", /not available in this turn.*question prompts/su);
    assert.equal(chatTurnToolRefusal(workspaceSurface, attended)("ask_user_question"), undefined);
  });
});

describe("prompt prefix stability: causes fixed by later phases", () => {
  // On a wire that can append a tool (a `tool_addition` block, or Responses'
  // additional tools), the agent loop declares a loaded tool in an appended
  // system message and the request's tool list stays as it was. A wire
  // without in-place system messages collapses every declaration into the one
  // tool list, so loading a tool there costs one miss (phase 2 deviation).
  const appendingWires = wires.filter((entry) => entry.midConversationSystem);
  const loadClassify = async (harness: ReturnType<typeof createPromptPrefixHarness>) => harness.turn({
    prompt: "Classify the attachment.",
    assembly: await workspaceChat({ tools: [...workspaceTools, codemodeTool, classifyTool] }),
    responses: [
      fauxAssistantMessage(fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["classify"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Loaded."),
    ],
  });
  for (const { wire, midConversationSystem, label } of appendingWires) {
    test(`loading a tool mid-turn leaves the next step's prefix unchanged (${label})`, async () => {
      const harness = createPromptPrefixHarness({ wire, midConversationSystem });
      const requests = await loadClassify(harness);
      assert.equal(requests.length, 2);
      assert.ok(!requests[0]!.carries("Returns one label from the configured set."), "held back before loading");
      assert.ok(requests[1]!.carries("Returns one label from the configured set."), "declared once loaded");
      assert.deepEqual(comparePromptRequests(requests[0]!, requests[1]!), {});
      assert.equal(harness.networkCalls, 0);
    });

    test(`a tool loaded on one turn leaves the next turn's tool list unchanged (${label})`, { todo: "phase 8: the turn-start head collapse folds the loaded tool into the head" }, async () => {
      const harness = createPromptPrefixHarness({ wire, midConversationSystem });
      const one = await loadClassify(harness);
      const [next] = await harness.turn({
        prompt: "And the next one?",
        assembly: await workspaceChat({ tools: [...workspaceTools, codemodeTool, classifyTool] }),
        responses: reply("Invoice again."),
      });
      assert.ok(next!.carries("Returns one label from the configured set."), "still declared");
      assert.deepEqual(comparePromptRequests(lastOf(one), next!), {});
    });
  }

  test(
    "loading a tool mid-turn leaves the next step's prefix unchanged (Anthropic Messages)",
    { todo: "phase 8: deferred tool declarations keep a loaded tool out of the cached tool list on this wire" },
    async () => {
      // Without in-place system messages the loaded tool joins the one tool
      // list, so the step after the load re-reads the tools cache.
      const harness = createPromptPrefixHarness();
      const requests = await loadClassify(harness);
      assert.equal(requests.length, 2);
      assert.ok(requests[1]!.carries("Returns one label from the configured set."), "declared once loaded");
      assert.deepEqual(comparePromptRequests(requests[0]!, requests[1]!), {});
    },
  );

  test("a tool loaded on one turn leaves the next turn's tools on the wire unchanged (Anthropic Messages)", async () => {
    // The collapsed tool list already carried the loaded tool on turn 1's last step.
    const harness = createPromptPrefixHarness();
    const one = await loadClassify(harness);
    const [next] = await harness.turn({
      prompt: "And the next one?",
      assembly: await workspaceChat({ tools: [...workspaceTools, codemodeTool, classifyTool] }),
      responses: reply("Invoice again."),
    });
    assert.ok(next!.carries("Returns one label from the configured set."), "still declared");
    assert.equal(comparePromptRequests(lastOf(one), next!).wire, undefined);
  });

  test("Bot open work changing between turns does not change system", async () => {
    const chat = await botChat({ userMemory: "Prefers short answers.", openWork: [openWorkItem("w1", "Draft the weekly note")] });
    const { previous, current } = await twoBotTurns(chat, async () => {
      chat.state.openWork = [openWorkItem("w1", "Draft the weekly note"), openWorkItem("w2", "File the receipt")];
    });
    assert.ok(current.carries("File the receipt"), "the new item still reaches turn 2");
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  // Privacy over cache: a person's edit always removes approved text (a
  // replace removes the old one), so it rewrites system once rather than
  // leave the old text in the cached snapshot. Pi Durable journals the
  // re-read as a section patch; a wire that keeps system messages in place
  // must not send the first snapshot either.
  for (const midConversationSystem of [false, true]) {
    const label = midConversationSystem ? "system messages kept in place" : "one system prompt";
    test(`a person's Bot memory edit rewrites system once and never re-sends the text it replaced (${label})`, async () => {
      const chat = await botChat({ userMemory: "Prefers terse replies.", midConversationSystem });
      const { previous, current } = await twoBotTurns(chat, async () => {
        const entry = (await chat.memory.view(bot.id)).user.entries.find(({ text }) => text === "Prefers terse replies.")!;
        const edited = await chat.memory.edit({ botId: bot.id, edit: { kind: "replace", target: "user", entryId: entry.id, text: "Prefers detailed answers." } });
        assert.equal(edited.ok, true);
      });
      assert.ok(previous.carries("Prefers terse replies."));
      assert.ok(current.carries("Prefers detailed answers."), "the edit reaches turn 2");
      assert.ok(current.carries("Removed 1 entry."), "and is named after the person's input");
      assert.ok(!current.carries("Prefers terse replies."), "the replaced text is gone from every part of the request");
      assert.equal(comparePromptRequests(previous, current).wire?.kind, "system");
    });

    test(`a Bot memory re-read that only adds keeps every earlier system message (${label})`, async () => {
      const chat = await botChat({ userMemory: "Prefers terse replies.", midConversationSystem });
      const { previous, current } = await twoBotTurns(chat, async () => {
        await chat.memory.apply(bot.id, "user", [{ action: "add", content: "Has a dog named Miso." }]);
        chat.memory.markStale(bot.id);
      });
      assert.ok(current.carries("Has a dog named Miso."), "the re-read reaches turn 2");
      assert.ok(current.carries("Prefers terse replies."));
      if (midConversationSystem) assert.deepEqual(comparePromptRequests(previous, current), {}, "the re-read is appended as a patch");
    });
  }

  /** The newest user message's text: the prompt, then what llm-client journals after it. */
  const tailOf = (request: RecordedPromptRequest) => {
    const texts = userTexts(request);
    return texts[texts.length - 1] ?? "";
  };

  test("branch switch does not change system", async () => {
    const { previous, current } = await twoTurns(
      {},
      statefulChat({ branch: "main" }),
      statefulChat({ branch: "feature/login" }),
    );
    assert.match(tailOf(current), /<state_update>[\s\S]*Git branch: `feature\/login`/u, "the new branch reaches turn 2 after its prompt");
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("permission mode change does not change system", async () => {
    const { previous, current } = await twoTurns(
      {},
      statefulChat({ permission: "ask" }),
      statefulChat({ permission: "full" }),
    );
    assert.ok(current.carries("run commands directly"), "the new permission still reaches turn 2");
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  const memoryChat = async (facts: MemoryFact[]) => statefulChat({
    extensions: [await createMemoryExtension({ store: memoryStore(facts), scope: memoryScope })],
  });

  test("an added memory fact does not change system", async () => {
    const { previous, current } = await twoTurns(
      {},
      await memoryChat([memoryFact("m1", "Prefers short answers.")]),
      await memoryChat([memoryFact("m1", "Prefers short answers."), memoryFact("m2", "Uses pnpm.")]),
    );
    // Only the difference goes out after the prompt.
    const tail = tailOf(current);
    assert.match(tail, /Added facts:\n- \[memory:m2\] Uses pnpm\./u);
    assert.doesNotMatch(tail, /memory:m1/u, "an unchanged fact is not repeated");
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("a forgotten memory fact never reaches a later request", async () => {
    // A removal is named by id and rebuilds system, so no request after the
    // forget carries the fact's text: not system, not an earlier update.
    const facts = {
      m1: memoryFact("m1", "Prefers short answers."),
      m2: memoryFact("m2", "Uses pnpm."),
      m3: memoryFact("m3", "Deploys on Fridays."),
    };
    for (const [label, before, after, forgotten] of [
      ["a head fact", [facts.m1, facts.m3], [facts.m1], "Deploys on Fridays."],
      ["a fact an update added", [facts.m1, facts.m2], [facts.m1], "Uses pnpm."],
      ["memory turned off", [facts.m1, facts.m3], [], "Deploys on Fridays."],
      // A row the store did not normalize (an old import, an edited
      // database) still renders as one line, so it leaves as a whole.
      ["a fact stored across lines", [facts.m1, memoryFact("m4", "Deploys on Fridays.\nAsk before the release train.")], [facts.m1], "release train"],
    ] as const) {
      const harness = createPromptPrefixHarness();
      const turn = async (prompt: string, memory: readonly MemoryFact[]) =>
        harness.turn({ prompt, responses: reply("Done."), ...(await memoryChat([...memory])) });
      // The update case learns m2 from an update on turn 2, not from system.
      if (label === "a fact an update added") await turn("Start.", [facts.m1]);
      const [learned] = await turn("Remember this.", before);
      assert.ok(learned!.carries(forgotten), `${label}: the fact reaches the request before the forget`);
      const [forgot] = await turn("Forget it.", after);
      const [later] = await turn("And now?", after);
      for (const [name, request] of [["the forget turn", forgot!], ["the next turn", later!]] as const) {
        assert.equal(request.carries(forgotten), false, `${label}: ${name} carries the forgotten fact`);
      }
      assert.match(tailOf(forgot!), /Removed facts, no longer approved, so do not rely on them: [^\n]*\[memory:m[2-4]\]/u, label);
      assert.deepEqual(comparePromptRequests(forgot!, later!), {}, `${label}: the rebuilt head holds on the next turn`);
    }
  });

  test("a fact the always-on cap pushes out is not a removal and does not change system", async () => {
    const harness = createPromptPrefixHarness();
    const stored: MemoryFact[] = [];
    const requests: RecordedPromptRequest[] = [];
    // One new always-on fact per turn; the seventh pushes the first out of the block of six.
    for (let n = 1; n <= 7; n += 1) {
      stored.unshift(memoryFact(`m${n}`, `Fact number ${n}.`));
      requests.push(...await harness.turn({ prompt: `Turn ${n}.`, responses: reply("Done."), ...(await memoryChat([...stored])) }));
    }
    for (let index = 1; index < requests.length; index += 1) {
      assert.deepEqual(comparePromptRequests(requests[index - 1]!, requests[index]!), {}, `request ${index + 1} keeps the prefix`);
    }
    const seventh = tailOf(lastOf(requests));
    assert.match(seventh, /No longer always-on, still approved and found with recall_memory: \[memory:m1\]/u);
    assert.match(seventh, /Added facts:\n- \[memory:m7\] Fact number 7\./u);
    assert.doesNotMatch(seventh, /Removed facts|no longer approved/u, "a fact that is still approved is not called removed");
    // An eighth turn with nothing changed is told nothing and keeps the prefix.
    const [eighth] = await harness.turn({ prompt: "Turn 8.", responses: reply("Done."), ...(await memoryChat([...stored])) });
    assert.deepEqual(comparePromptRequests(lastOf(requests), eighth!), {}, "the eighth request keeps the prefix");
    assert.equal(tailOf(eighth!).includes("<state_update>"), false, "an unchanged turn sends no update");
    // Forgetting the pushed-out fact is a removal: system is rebuilt without it.
    const [forgot] = await harness.turn({ prompt: "Forget the first.", responses: reply("Done."), ...(await memoryChat(stored.slice(0, -1))) });
    assert.equal(forgot!.carries("Fact number 1."), false);
    assert.match(tailOf(forgot!), /Removed facts, no longer approved, so do not rely on them: \[memory:m1\]/u);
  });

  test("a store that cannot be read confirms no pushed-out fact, so it is treated as removed", async () => {
    const harness = createPromptPrefixHarness();
    const stored: MemoryFact[] = [];
    for (let n = 1; n <= 6; n += 1) {
      stored.unshift(memoryFact(`m${n}`, `Fact number ${n}.`));
      await harness.turn({ prompt: `Turn ${n}.`, responses: reply("Done."), ...(await memoryChat([...stored])) });
    }
    stored.unshift(memoryFact("m7", "Fact number 7."));
    const unreadable = {
      alwaysOn: async () => stored.slice(0, 6),
      list: async () => { throw new Error("The memory database is unreadable."); },
      recall: async () => [],
    } as unknown as MemoryStore;
    const [seventh] = await harness.turn({
      prompt: "Turn 7.",
      responses: reply("Done."),
      ...statefulChat({ extensions: [await createMemoryExtension({ store: unreadable, scope: memoryScope })] }),
    });
    assert.equal(seventh!.carries("Fact number 1."), false, "an unconfirmed fact is not sent");
    assert.match(tailOf(seventh!), /Removed facts, no longer approved, so do not rely on them: \[memory:m1\]/u);
    assert.doesNotMatch(tailOf(seventh!), /No longer always-on/u);
  });

  test("a retried prompt the journal holds records no head without its state update", async () => {
    const harness = createPromptPrefixHarness();
    const both = [memoryFact("m1", "Prefers short answers."), memoryFact("m3", "Deploys on Fridays.")];
    const turn = async (input: { prompt?: string; retry?: boolean }, memory: MemoryFact[]) =>
      harness.turn({ prompt: input.prompt ?? "", ...(input.retry ? { retry: true } : {}), responses: reply("Done."), ...(await memoryChat(memory)) });
    await turn({ prompt: "Start." }, both);
    await turn({ prompt: "Deploy today?" }, both);
    const held = await harness.journaledChatState();
    // The fact is forgotten before the retry: the retry's request says so, but
    // the journal already holds the prompt, so it records neither the new head
    // nor the update that announces it.
    const [retried] = await turn({ retry: true }, [both[0]!]);
    assert.equal(retried!.carries("Deploys on Fridays."), false);
    assert.deepEqual(await harness.journaledChatState(), held);
    const [next] = await turn({ prompt: "And now?" }, [both[0]!]);
    assert.equal(next!.carries("Deploys on Fridays."), false);
    assert.match(tailOf(next!), /Removed facts[^\n]*\[memory:m3\]/u, "the next turn states the removal the retry could not record");
    assert.notDeepEqual((await harness.journaledChatState()).head, held.head);
  });

  test("after a permission mode change the next request states the mode the approval gate enforces", async () => {
    // llm-client states `legacyAccessOf(generationApprovalPolicy(...))` when the
    // turn starts and gates each call on `currentWorkspaceApproval`, read again
    // before the call. Both come from the same workspace and settings here.
    const turnUnder = async (fields: ApprovalWorkspaceFields) => {
      const workspace = { id: "w1", ...fields } as Workspace;
      const getSettings = async () => ({ approvalMode: "ask" as const });
      const policy = await generationApprovalPolicy(
        { workspace, botBound: false, mode: undefined, permission: undefined },
        getSettings,
      );
      assert.ok(policy, "a person's workspace chat runs under an approval policy");
      const permission = legacyAccessOf(policy);
      const runApproval = await currentWorkspaceApproval({ getSettings, getWorkspace: async () => workspace }, "w1");
      assert.ok(runApproval);
      const gate = workspaceToolApproval({
        toolName: "background_job",
        args: { action: "start", command: "npm test" },
        permission,
        workspaceId: "w1",
        approval: { mode: runApproval.mode, macGrants: runApproval.macGrants },
        judgeAvailable: true,
      }).decision.outcome;
      return { permission, gate };
    };
    const asking = await turnUnder({ permission: "ask" });
    const direct = await turnUnder({ permission: "ask", approvalMode: "never", macGrants: { shell: true, files: true } });
    assert.equal(asking.gate, "ask");
    assert.equal(direct.gate, "allow");

    const harness = createPromptPrefixHarness();
    const turn = (permission: ChatSystemPromptPermission, prompt: string) => harness.turn({
      prompt, responses: reply("Done."), ...statefulChat({ permission }),
    });
    const [one] = await turn(asking.permission, "Run the tests.");
    const [two] = await turn(direct.permission, "Run them again.");
    const [three] = await turn(asking.permission, "Once more.");
    // The last statement of the mode each request makes is the mode its gate enforces.
    const lastMode = (request: RecordedPromptRequest) => {
      const statements = [...userTexts(request).join("\n").matchAll(/Permission: (.+)/gu)].map((match) => match[1]);
      return statements[statements.length - 1];
    };
    assert.equal(lastMode(one!), undefined, "turn 1 states its mode in system");
    assert.ok(one!.carries("The user must approve each file write and shell command before it runs."));
    assert.equal(lastMode(two!), "You may make changes and run commands directly.");
    assert.equal(lastMode(three!), "The user must approve each file write and shell command before it runs.");
    assert.deepEqual(comparePromptRequests(one!, two!), {});
    assert.deepEqual(comparePromptRequests(lastOf([two!]), three!), {});
  });

  test("a fourth screenshot leaves earlier messages unchanged", { todo: "phase 7: screenshot trimming in batches" }, async () => {
    screenshotCount = 0;
    const harness = createPromptPrefixHarness();
    const steps = Array.from({ length: 4 }, (_, index) =>
      fauxAssistantMessage(fauxToolCall("computer_use", { action: `look-${index}` }), { stopReason: "toolUse" }));
    const requests = await harness.turn({
      prompt: "Check the screen four times.",
      assembly: await workspaceChat({ tools: [computerUseTool] }),
      responses: [...steps, fauxAssistantMessage("Done.")],
    });
    assert.equal(requests.length, 5);
    const newest = Buffer.from(`png-${screenshotCount}`).toString("base64");
    assert.equal(screenshotCount, 4);
    assert.ok(requests[4]!.carries(newest), "the last request still carries the newest screenshot");
    for (let index = 1; index < requests.length; index += 1) {
      assert.deepEqual(comparePromptRequests(requests[index - 1]!, requests[index]!), {}, `step ${index + 1}`);
    }
  });
});
