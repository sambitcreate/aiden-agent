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
import { renderBotMemorySection } from "./bot-memory/prompt.js";
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
import { fingerprintPromptPrefix } from "./pi-cache-telemetry.js";
import type { MemoryFact, MemoryScope, MemoryStore } from "./memory-store.js";
import { markMcpAgentTool } from "./mcp-tool-identity.js";
import { createPiCodemodeTool } from "./pi-codemode.js";
import { forgetPromptSectionDeviceKeys } from "./prompt-section-secret.js";
import { LOAD_TOOLS_TOOL_NAME } from "./on-demand-tools.js";
import { createAidenAppTools } from "./aiden-app-tools.js";
import type { AppControlContext, AppControlsService } from "./app-controls-core.js";
import { chatToolOffers, chatTurnToolRefusal, type ChatToolSurface, type ChatTurnAudience } from "./chat-turn-tool-policy.js";
import { remoteGenerationSurface } from "./conversation-surface-generation.js";
import { UNATTENDED_FOLLOW_UP_GENERATION } from "./follow-through/notice-delivery.js";
import { createGenerativeUiExtension, shouldEnableGenerativeUiExtension } from "./generative-ui-extension.js";
import { ROUTINE_NOTES_TOOL } from "./bot-runtime/bot-tool-policy.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import {
  comparePromptRequests,
  createPromptPrefixHarness,
  createPromptRequestRecorder,
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

type TurnHead = { assembly: ChatPromptAssembly } | { systemPrompt: string; tools: AgentTool[] };

const lastOf = (requests: readonly RecordedPromptRequest[]) => requests[requests.length - 1]!;

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

/** A store holding only always-on facts, read through the real memory extension. */
function memoryStore(facts: MemoryFact[]): MemoryStore {
  return {
    alwaysOn: async () => facts,
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
async function botChat(options: { userMemory: string; openWork?: BotOpenWorkItem[]; extraTools?: AgentTool[] }) {
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
    // Open work as bot-session-main appends it: after the person's input.
    promptTail: (_botId, offered) => botOpenWorkPromptTail(offered.toolNames, async () => openWork(state.openWork)),
    memorySection: async (botId, offer) => renderBotMemorySection(await memory.snapshot(botId), offer),
  };
  const fauxModels = createFauxModels();
  const recorder = createPromptRequestRecorder({ model: fauxModels.faux.getModel() });
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
  const attended: ChatTurnAudience = { unattended: false, remoteAudience: false, visualize: false };
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
      return createGenerativeUiExtension({
        workspaceRoot: undefined, onArtifact: () => undefined, onUiVisual: () => undefined, onRequest: true, preferArtifactThisTurn: visualize,
      });
    };
    const { previous, current } = await twoTurns(
      {},
      { assembly: await workspaceChat({ tools: chatTools(workspaceSurface), extensions: [visuals(false)] }) },
      { assembly: await workspaceChat({ tools: chatTools(workspaceSurface), extensions: [visuals(true)] }) },
    );
    assert.deepEqual(toolsOf(current), toolsOf(previous));
    assert.ok(current.carries("render_artifact"), "the drawing tools stay declared");
    const plain = chatTurnToolRefusal(workspaceSurface, { ...attended, inlineVisuals: "on_request" });
    assert.match(plain("render_artifact") ?? "", /not available in this turn.*\/visualize/su);
    assert.equal(chatTurnToolRefusal(workspaceSurface, { ...attended, inlineVisuals: "on_request", visualize: true })("render_artifact"), undefined);
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

  test("an unattended follow-up declares the chat's tools and refuses what nobody can approve", async () => {
    assert.notEqual((UNATTENDED_FOLLOW_UP_GENERATION as { allowComputerUse?: boolean }).allowComputerUse, false, "Computer Use is not withheld");
    const followUp: ChatTurnAudience = { ...attended, unattended: UNATTENDED_FOLLOW_UP_GENERATION.unattended };
    const surface: ChatToolSurface = { ...workspaceSurface, usageSource: UNATTENDED_FOLLOW_UP_GENERATION.usageSource };
    const { previous, current } = await twoTurns(
      {},
      { assembly: await workspaceChat({ tools: chatTools(workspaceSurface) }) },
      { assembly: await workspaceChat({ tools: chatTools(surface) }) },
    );
    assert.deepEqual(comparePromptRequests(previous, current), {});
    assert.ok(current.carries("List, propose and test this chat's hooks."), "hooks stays declared");
    const refuse = chatTurnToolRefusal(surface, followUp);
    assert.match(refuse("hooks") ?? "", /not available in this turn.*follow-up/su);
    assert.match(refuse("computer_use") ?? "", /not available in this turn.*follow-up/su);
    assert.equal(refuse("read_file"), undefined);
    const refuseAttended = chatTurnToolRefusal(workspaceSurface, attended);
    assert.equal(refuseAttended("hooks"), undefined);
    assert.equal(refuseAttended("computer_use"), undefined);
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
      const head = async (fromPhone: boolean) => workspaceChat({
        tools: [...chatTools(workspaceSurface), ...appTools(fromPhone)],
        extensions: [createGenerativeUiExtension({
          workspaceRoot: undefined, onArtifact: () => undefined, ...(fromPhone ? { audience: remote.options.visualAudience } : {}),
        })],
      });
      const { previous, current } = await twoTurns({ wire, midConversationSystem }, { assembly: await head(false) }, { assembly: await head(true) });
      assert.deepEqual(toolsOf(current), toolsOf(previous));
      const fromPhone = chatTurnToolRefusal(workspaceSurface, { ...attended, remoteAudience: remote.options.visualAudience === "remote" });
      assert.match(fromPhone("workspace_artifact") ?? "", /not available in this turn.*paired device/su);
      assert.match(fromPhone("hooks") ?? "", /paired device/u);
      assert.equal(chatTurnToolRefusal(workspaceSurface, attended)("workspace_artifact"), undefined);
    });
  }
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

  test("a person's Bot memory edit does not change system", { todo: "phase 3: Bot memory as a turn update" }, async () => {
    const chat = await botChat({ userMemory: "Prefers short answers." });
    const { previous, current } = await twoBotTurns(chat, async () => {
      const entry = (await chat.memory.view(bot.id)).user.entries.find(({ text }) => text === "Prefers short answers.")!;
      const edited = await chat.memory.edit({ botId: bot.id, edit: { kind: "replace", target: "user", entryId: entry.id, text: "Prefers detailed answers." } });
      assert.equal(edited.ok, true);
    });
    assert.ok(current.carries("Prefers detailed answers."), "the edit still reaches turn 2");
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("branch switch does not change system", { todo: "phase 3: frozen per-chat state" }, async () => {
    const { previous, current } = await twoTurns(
      {},
      { assembly: await workspaceChat({ branch: "main" }) },
      { assembly: await workspaceChat({ branch: "feature/login" }) },
    );
    assert.ok(current.carries("feature/login"), "the new branch still reaches turn 2");
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("permission mode change does not change system", { todo: "phase 3: frozen per-chat state" }, async () => {
    const { previous, current } = await twoTurns(
      {},
      { assembly: await workspaceChat({ permission: "ask" }) },
      { assembly: await workspaceChat({ permission: "full" }) },
    );
    assert.ok(current.carries("run commands directly"), "the new permission still reaches turn 2");
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("memory edit does not change system", { todo: "phase 3: frozen per-chat state" }, async () => {
    const memory = async (facts: MemoryFact[]) => workspaceChat({
      extensions: [await createMemoryExtension({ store: memoryStore(facts), scope: memoryScope })],
    });
    const { previous, current } = await twoTurns(
      {},
      { assembly: await memory([memoryFact("m1", "Prefers short answers.")]) },
      { assembly: await memory([memoryFact("m1", "Prefers short answers."), memoryFact("m2", "Uses pnpm.")]) },
    );
    assert.ok(current.carries("Uses pnpm."), "the new fact still reaches turn 2");
    assert.deepEqual(comparePromptRequests(previous, current), {});
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
