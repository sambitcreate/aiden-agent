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
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { BotOpenWorkItem, BotOpenWorkSnapshot } from "../../renderer/shared/bot-open-work.js";
import { renderBotOpenWork } from "./bot-open-work/prompt.js";
import { composeBotSystemSections } from "./bot-system-prompt.js";
import { assembleChatPrompt, buildWorkspaceChatBasePrompt, type ChatPromptAssembly } from "./chat-prompt-assembly.js";
import { buildSystemPrompt, type ChatSystemPromptPermission } from "./chat-system-prompt.js";
import { createMemoryExtension } from "./memory-context.js";
import type { MemoryFact, MemoryScope, MemoryStore } from "./memory-store.js";
import { LOAD_TOOLS_TOOL_NAME } from "./on-demand-tools.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import {
  comparePromptRequests,
  createPromptPrefixHarness,
  type PromptPrefixHarnessOptions,
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
  await Promise.all([mkdir(globalRoot), mkdir(workspaceRoot)]);
  await writeFile(path.join(workspaceRoot, "AGENTS.md"), contents);
  return {
    globalRoot,
    workspaceRoot,
    // The production reader is a native helper; this reads the same anchored file directly.
    read: async (anchored: { canonicalPath: string }) => readFile(path.join(anchored.canonicalPath, "AGENTS.md"), "utf8"),
  };
}

const mcpSection = () => "<mcp_servers>\nlinear: issue tracker tools.\n</mcp_servers>";

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

/** A Bot turn's fixed sections as the Bot runtime composes them, joined in key order. */
async function botTurn(items: BotOpenWorkItem[]): Promise<TurnHead> {
  const offeredToolNames = new Set(["read_file", "list_files", "open_work"]);
  const base = await buildSystemPrompt(botWorkspace.homePath, undefined, "full", false, true, undefined, offeredToolNames);
  const sections = composeBotSystemSections({
    base,
    bot,
    workspace: botWorkspace,
    fileAuthority: { mode: "full_mac", botHome: true },
    rules: "",
    offeredToolNames,
    openWork: renderBotOpenWork(openWork(items)),
    toolGuidance: "",
    lessons: "",
  });
  return { systemPrompt: sections.filter(Boolean).join("\n\n"), tools: workspaceTools };
}

describe("prompt prefix stability: already stable", () => {
  for (const { wire, midConversationSystem, label } of wires) {
    test(`a second turn extends the first turn's request (${label})`, async () => {
      const { previous, current } = await twoTurns({ wire, midConversationSystem }, { assembly: await workspaceChat() });
      assert.deepEqual(comparePromptRequests(previous, current), {});
      assert.ok(current.wire.length > previous.wire.length, "turn 2 appends to the prefix");
    });

    test(`an unchanged MCP section keeps the prefix (${label})`, async () => {
      // The refresher's section patch is folded into the head before each run,
      // like every system message the journal does not keep.
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

describe("prompt prefix stability: causes fixed by later phases", () => {
  for (const { wire, midConversationSystem, label } of wires) {
    test(`AGENTS.md section is identical across turns (${label})`, { todo: "phase 1: stable nonce, journaled section" }, async () => {
      const roots = await agentsRoots("Use tabs for indentation.\n");
      const { previous, current } = await twoTurns(
        { wire, midConversationSystem, agentsInstructions: roots },
        { assembly: await workspaceChat() },
      );
      assert.ok(current.carries("Use tabs for indentation."), "the instructions still reach turn 2");
      assert.deepEqual(comparePromptRequests(previous, current), {});
    });
  }

  test("loading a tool mid-turn leaves the next step's prefix unchanged", { todo: "phase 2: fixed tool list per chat" }, async () => {
    const harness = createPromptPrefixHarness();
    const requests = await harness.turn({
      prompt: "Classify the attachment.",
      assembly: await workspaceChat({ tools: [...workspaceTools, codemodeTool, classifyTool] }),
      responses: [
        fauxAssistantMessage(fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["classify"] }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Loaded."),
      ],
    });
    assert.equal(requests.length, 2);
    assert.ok(!requests[0]!.carries("Returns one label from the configured set."), "held back before loading");
    assert.ok(requests[1]!.carries("Returns one label from the configured set."), "declared once loaded");
    assert.deepEqual(comparePromptRequests(requests[0]!, requests[1]!), {});
  });

  test("Bot open work changing between turns does not change system", { todo: "phase 2: Bots append open work" }, async () => {
    const { previous, current } = await twoTurns(
      {},
      await botTurn([openWorkItem("w1", "Draft the weekly note")]),
      await botTurn([openWorkItem("w1", "Draft the weekly note"), openWorkItem("w2", "File the receipt")]),
    );
    assert.ok(current.carries("File the receipt"), "the new item still reaches turn 2");
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
    for (let index = 1; index < requests.length; index += 1) {
      assert.deepEqual(comparePromptRequests(requests[index - 1]!, requests[index]!), {}, `step ${index + 1}`);
    }
  });
});
