// Prefix stability across turns of one chat, measured on the rendered
// provider payload. Cases a later phase of docs/plans/prompt-cache-hit-rate.md
// fixes are marked `todo` (they run and report, but do not fail the suite);
// the phase that fixes a cause removes its `todo`.

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
import { buildSystemPrompt } from "./chat-system-prompt.js";
import { formatAlwaysOnMemory } from "./memory-context.js";
import type { MemoryFact } from "./memory-store.js";
import {
  comparePromptRequests,
  createPromptPrefixHarness,
  type PromptPrefixHarnessOptions,
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
const browserOpenTool = textTool("browser_open", "Open a page in the browser.");
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

function workspacePrompt(options: { branch?: string; permission?: "ask" | "full" } = {}) {
  return buildSystemPrompt("/workspace/project", options.branch ?? "main", options.permission ?? "ask", false, false);
}

const lastOf = (requests: readonly RecordedPromptRequest[]) => requests[requests.length - 1]!;

/** Two user turns; returns turn 1's last request and turn 2's first. */
async function twoTurns(
  options: PromptPrefixHarnessOptions,
  turns: {
    first: { systemPrompt: string; tools?: AgentTool[] };
    second: { systemPrompt: string; tools?: AgentTool[] };
  },
) {
  const harness = createPromptPrefixHarness(options);
  const first = await harness.turn({
    prompt: "Summarize the project.",
    systemPrompt: turns.first.systemPrompt,
    tools: turns.first.tools ?? workspaceTools,
    responses: reply("It is a small project."),
  });
  const second = await harness.turn({
    prompt: "Now list the files.",
    systemPrompt: turns.second.systemPrompt,
    tools: turns.second.tools ?? workspaceTools,
    responses: reply("Here they are."),
  });
  assert.equal(harness.networkCalls, 0);
  return { previous: lastOf(first), current: second[0]!, harness };
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

async function mcpTwoTurns(options: PromptPrefixHarnessOptions) {
  const section = "<mcp_servers>\nlinear: issue tracker tools.\n</mcp_servers>";
  const systemPrompt = await workspacePrompt();
  return twoTurns({ ...options, mcpServersSection: () => section }, {
    first: { systemPrompt },
    second: { systemPrompt },
  });
}

const wires: { wire: PromptPrefixWire; midConversationSystem: boolean; label: string }[] = [
  { wire: "anthropic-messages", midConversationSystem: false, label: "Anthropic Messages" },
  { wire: "openai-responses", midConversationSystem: true, label: "OpenAI Responses with in-place system messages" },
];

describe("prompt prefix stability: already stable", () => {
  for (const { wire, midConversationSystem, label } of wires) {
    test(`a second turn extends the first turn's request (${label})`, async () => {
      const systemPrompt = await workspacePrompt();
      const { previous, current } = await twoTurns({ wire, midConversationSystem }, {
        first: { systemPrompt },
        second: { systemPrompt },
      });
      assert.deepEqual(comparePromptRequests(previous, current), {});
      assert.ok(current.wire.length > previous.wire.length, "turn 2 appends to the prefix");
    });
  }

  test("each step of a tool loop extends the step before it", async () => {
    const harness = createPromptPrefixHarness();
    const requests = await harness.turn({
      prompt: "Read both files.",
      systemPrompt: await workspacePrompt(),
      tools: workspaceTools,
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

  test("a workspace without AGENTS.md adds no section, so turns stay stable", async () => {
    const roots = await agentsRoots("");
    const systemPrompt = await workspacePrompt();
    const { previous, current } = await twoTurns({ agentsInstructions: roots }, {
      first: { systemPrompt },
      second: { systemPrompt },
    });
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("an unchanged MCP section keeps the merged system bytes (Anthropic Messages)", async () => {
    // The adapter folds every system patch into one system block, so the unjournaled
    // patch moving to the end of the transcript does not change the rendered prompt.
    const { previous, current } = await mcpTwoTurns({ wire: "anthropic-messages", midConversationSystem: false });
    assert.equal(comparePromptRequests(previous, current).wire, undefined);
  });

  test("the harness names a changed base prompt as the first difference", async () => {
    // The oracle the todo cases rely on: a real change is reported, at the system segment.
    const { previous, current } = await twoTurns({}, {
      first: { systemPrompt: "Base prompt, version one." },
      second: { systemPrompt: "Base prompt, version two." },
    });
    const comparison = comparePromptRequests(previous, current);
    assert.equal(comparison.wire?.kind, "system");
    assert.equal(comparison.transcript?.source, "system:base");
  });
});

describe("prompt prefix stability: causes fixed by later phases", () => {
  for (const { wire, midConversationSystem, label } of wires) {
    test(`AGENTS.md section is identical across turns (${label})`, { todo: "phase 1: stable nonce, journaled section" }, async () => {
      const roots = await agentsRoots("Use tabs for indentation.\n");
      const systemPrompt = await workspacePrompt();
      const { previous, current } = await twoTurns({ wire, midConversationSystem, agentsInstructions: roots }, {
        first: { systemPrompt },
        second: { systemPrompt },
      });
      assert.deepEqual(comparePromptRequests(previous, current), {});
    });

  }

  test("MCP section is identical across turns (OpenAI Responses with in-place system messages)", { todo: "phase 1: journaled mcp_servers section" }, async () => {
    const { previous, current } = await mcpTwoTurns({ wire: "openai-responses", midConversationSystem: true });
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("tool list identical across turns after a tool is discovered", { todo: "phase 2: fixed tool list per chat" }, async () => {
    // Browser discovery and on-demand tools put a tool found in turn 1 into turn 2's head.
    const systemPrompt = await workspacePrompt();
    const { previous, current } = await twoTurns({}, {
      first: { systemPrompt, tools: workspaceTools },
      second: { systemPrompt, tools: [...workspaceTools, browserOpenTool] },
    });
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("Bot open work changing between turns does not change system", { todo: "phase 2: Bots append open work" }, async () => {
    const item = (id: string, title: string): BotOpenWorkItem => ({
      id, revision: "r1", title, note: "", state: "open", createdAt: 1, updatedAt: 1,
      source: { kind: "person" }, links: [], execution: { state: "idle", canStop: false },
    });
    const snapshot = (items: BotOpenWorkItem[]): BotOpenWorkSnapshot => ({ botId: "bot-1", revision: String(items.length), items, undo: [] });
    const base = await buildSystemPrompt("/bots/bot-1", undefined, "full", false, false);
    const { previous, current } = await twoTurns({}, {
      first: { systemPrompt: `${base}\n\n${renderBotOpenWork(snapshot([item("w1", "Draft the weekly note")]))}` },
      second: { systemPrompt: `${base}\n\n${renderBotOpenWork(snapshot([item("w1", "Draft the weekly note"), item("w2", "File the receipt")]))}` },
    });
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("branch switch does not change system", { todo: "phase 3: frozen per-chat state" }, async () => {
    const { previous, current } = await twoTurns({}, {
      first: { systemPrompt: await workspacePrompt({ branch: "main" }) },
      second: { systemPrompt: await workspacePrompt({ branch: "feature/login" }) },
    });
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("permission mode change does not change system", { todo: "phase 3: frozen per-chat state" }, async () => {
    const { previous, current } = await twoTurns({}, {
      first: { systemPrompt: await workspacePrompt({ permission: "ask" }) },
      second: { systemPrompt: await workspacePrompt({ permission: "full" }) },
    });
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("memory edit does not change system", { todo: "phase 3: frozen per-chat state" }, async () => {
    const scope = { kind: "workspace" as const, id: "workspace-1" };
    const fact = (id: string, text: string): MemoryFact => ({
      id, scope, text, provenance: { kind: "user_edit", sourceId: id }, createdAt: 1, updatedAt: 1,
      confidence: 1, reviewState: "approved", state: "active", alwaysOn: true,
    });
    const base = await workspacePrompt();
    const { previous, current } = await twoTurns({}, {
      first: { systemPrompt: `${base}\n\n${formatAlwaysOnMemory(scope, [fact("m1", "Prefers short answers.")])}` },
      second: { systemPrompt: `${base}\n\n${formatAlwaysOnMemory(scope, [fact("m1", "Prefers short answers."), fact("m2", "Uses pnpm.")])}` },
    });
    assert.deepEqual(comparePromptRequests(previous, current), {});
  });

  test("a fourth screenshot leaves earlier messages unchanged", { todo: "phase 7: screenshot trimming in batches" }, async () => {
    screenshotCount = 0;
    const harness = createPromptPrefixHarness();
    const steps = Array.from({ length: 4 }, (_, index) =>
      fauxAssistantMessage(fauxToolCall("computer_use", { action: `look-${index}` }), { stopReason: "toolUse" }));
    const requests = await harness.turn({
      prompt: "Check the screen four times.",
      systemPrompt: await workspacePrompt(),
      tools: [computerUseTool],
      responses: [...steps, fauxAssistantMessage("Done.")],
    });
    assert.equal(requests.length, 5);
    for (let index = 1; index < requests.length; index += 1) {
      assert.deepEqual(comparePromptRequests(requests[index - 1]!, requests[index]!), {}, `step ${index + 1}`);
    }
  });
});
