import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { withBotRuntimeInstructions } from "./bot-system-prompt.js";
import { assembleChatPrompt, type ChatPromptAssemblyInput } from "./chat-prompt-assembly.js";
import { createMemoryExtension } from "./memory-context.js";
import type { MemoryFact, MemoryScope, MemoryStore } from "./memory-store.js";
import { LOAD_TOOLS_TOOL_NAME } from "./on-demand-tools.js";

function tool(name: string, description = `The ${name} tool.`): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
  };
}

const basePrompt = "Base host policy.";
const everyday = [tool("read_file"), tool("list_files")];
const withCodemode = [...everyday, tool("codemode"), tool("classify")];

function assemble(input: Partial<ChatPromptAssemblyInput> = {}) {
  return assembleChatPrompt({
    basePrompt,
    tools: everyday,
    resources: {},
    extensions: [],
    allowOnDemandTools: true,
    ...input,
  });
}

const names = (tools: readonly AgentTool[]) => tools.map((entry) => entry.name);

const bot = {
  id: "bot-1",
  revision: "botrev:bot-1",
  name: "Bookkeeper",
  description: "Keeps the receipts in order",
  instructions: "Answer in one line.",
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

describe("chat prompt assembly", () => {
  test("an ordinary chat sends its base prompt unchanged and reports no Bot instructions", () => {
    const assembly = assemble();
    assert.equal(assembly.systemPrompt, basePrompt);
    assert.equal(assembly.promptSections["bot-instructions"], "");
  });

  test("a Bot chat adds the runtime contract after the base prompt and reports it as Bot instructions", () => {
    const assembly = assemble({
      withBotInstructions: (base) => withBotRuntimeInstructions(base, bot, botWorkspace, { mode: "full_mac", botHome: true }),
    });
    assert.ok(assembly.systemPrompt.startsWith(basePrompt), "the host policy stays first");
    assert.ok(assembly.systemPrompt.includes("Answer in one line."), "the persona reaches the prompt");
    assert.ok(assembly.systemPrompt.includes(botWorkspace.homePath), "the managed home reaches the prompt");
    assert.ok(assembly.promptSections["bot-instructions"].includes("Answer in one line."));
    assert.ok(!assembly.promptSections["bot-instructions"].includes(basePrompt), "the host policy is not counted as Bot instructions");
  });

  test("the memory extension's facts reach the prompt and are reported as the memory section", async () => {
    const scope: MemoryScope = { kind: "workspace", id: "workspace-1" };
    const fact: MemoryFact = {
      id: "m1", scope, text: "Uses pnpm.", provenance: { kind: "user_edit", sourceId: "m1" }, createdAt: 1, updatedAt: 1,
      confidence: 1, reviewState: "approved", state: "active", alwaysOn: true,
    };
    const store = { alwaysOn: async () => [fact], recall: async () => [] } as unknown as MemoryStore;
    const assembly = assemble({ extensions: [await createMemoryExtension({ store, scope })] });
    assert.ok(assembly.promptSections.memory.includes("Uses pnpm."));
    assert.ok(assembly.systemPrompt.includes("Uses pnpm."));
    assert.equal(assemble().promptSections.memory, "");
  });

  test("with codemode, rarely used tools are held back until the chat loads them, and then stay declared", () => {
    const assembly = assemble({ tools: withCodemode });
    const fresh = names(assembly.toolsFor([]));
    assert.ok(fresh.includes(LOAD_TOOLS_TOOL_NAME));
    assert.ok(!fresh.includes("classify"));
    assert.ok(fresh.includes("read_file"));

    const loaded: AgentMessage[] = [{
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: LOAD_TOOLS_TOOL_NAME, arguments: { names: ["classify"] } }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: 1,
    }];
    const later = names(assembly.toolsFor(loaded));
    assert.ok(later.includes("classify"), "a loaded tool is declared from the start of the next run");
    assert.deepEqual(later.slice(0, fresh.length), fresh, "loaded tools are appended, so the earlier list is a prefix");
  });

  test("a chat that may not use on-demand tools declares every admitted tool and no loader", () => {
    const assembly = assemble({ tools: withCodemode, allowOnDemandTools: false });
    const declared = names(assembly.toolsFor([]));
    assert.ok(declared.includes("classify"));
    assert.ok(!declared.includes(LOAD_TOOLS_TOOL_NAME));
    assert.equal(assembly.onDemandTools, undefined);
  });

  test("without codemode nothing is held back", () => {
    const declared = names(assemble({ tools: [...everyday, tool("classify")] }).toolsFor([]));
    assert.ok(declared.includes("classify"));
    assert.ok(!declared.includes(LOAD_TOOLS_TOOL_NAME));
  });
});
