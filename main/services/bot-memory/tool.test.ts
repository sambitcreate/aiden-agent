import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import { createBotRegistry, type BotExtensionDeps } from "../bot-runtime/bot-extension.js";
import { botIngressAllowsTool } from "../bot-runtime/bot-tool-policy.js";
import { recordingDeps } from "../bot-runtime/test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, type FauxModels } from "../bot-runtime/test-support/faux.js";
import { createBotMemoryService } from "./service.js";
import { createBotMemoryStore } from "./store.js";
import { BOT_MEMORY_TOOL_NAME, botMemoryToolEntry, withBotMemoryIngress } from "./tool.js";

const ctx = BACKGROUND_CONTEXT;
const BOT = "bot-1";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function memoryFor() {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-memory-tool-"));
  roots.push(root);
  const memoryDir = path.join(root, "bots", BOT, "memory");
  mkdirSync(memoryDir, { recursive: true });
  const memory = createBotMemoryService({ store: createBotMemoryStore({ profileDir: root }) });
  return { memory, memoryFile: path.join(memoryDir, "MEMORY.md") };
}

async function harnessWith(memory: ReturnType<typeof memoryFor>["memory"], fauxModels: FauxModels) {
  const deps: BotExtensionDeps = {
    ...recordingDeps(),
    currentTools: async () => [botMemoryToolEntry(BOT, memory)],
    checkPolicy: async () => ({ allowed: true }),
    turnAllows: withBotMemoryIngress(botIngressAllowsTool),
  };
  const registry = createBotRegistry(BOT, deps);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root };
}

type ToolResultModel = { isError: boolean; toolName: string; content: Array<{ text?: string }> };

async function memoryResults(root: Conversation): Promise<Array<{ isError: boolean; json: Record<string, unknown> }>> {
  const view = await root.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!)
    .filter((result) => result.toolName === BOT_MEMORY_TOOL_NAME)
    .map((result) => ({ isError: result.isError, json: JSON.parse(result.content[0]!.text ?? "{}") as Record<string, unknown> }));
}

const filler = Array.from({ length: 5 }, (_, index) => `${String.fromCharCode(65 + index)} ${"x".repeat(430)}`);
const NEW_FACT = "Weekly meal plan is vegetarian except Fridays.";

test("one batch frees space and adds in a single call", async () => {
  const { memory, memoryFile } = memoryFor();
  writeFileSync(memoryFile, filler.join("\n§\n"));
  const fauxModels = createFauxModels([
    fauxAssistantMessage(
      [
        fauxToolCall(BOT_MEMORY_TOOL_NAME, {
          target: "memory",
          operations: [
            { action: "remove", match: `A ${"x".repeat(12)}` },
            { action: "add", content: NEW_FACT },
          ],
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Saved."),
  ]);
  const { harness, root } = await harnessWith(memory, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "Remember the meal plan." }, ctx)).wait(ctx);
    const [result] = await memoryResults(root);
    assert.equal(result!.isError, false);
    assert.equal(result!.json.ok, true);
    assert.equal(result!.json.changed, 2);
    assert.deepEqual(readFileSync(memoryFile, "utf8").split("\n§\n"), [...filler.slice(1), NEW_FACT]);
  } finally {
    await harness.close(ctx);
  }
});

test("an add that would overflow is refused with the store's entries", async () => {
  const { memory, memoryFile } = memoryFor();
  writeFileSync(memoryFile, filler.join("\n§\n"));
  const fauxModels = createFauxModels([
    fauxAssistantMessage(
      [fauxToolCall(BOT_MEMORY_TOOL_NAME, { target: "memory", operations: [{ action: "add", content: NEW_FACT }] })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("It is full."),
  ]);
  const { harness, root } = await harnessWith(memory, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "Remember the meal plan." }, ctx)).wait(ctx);
    const [result] = await memoryResults(root);
    assert.equal(result!.isError, true);
    assert.equal(result!.json.code, "over_budget");
    assert.deepEqual(result!.json.entries, filler);
    assert.match(String(result!.json.error), /Retry as ONE call/u);
    assert.equal(readFileSync(memoryFile, "utf8"), filler.join("\n§\n"), "nothing was written");
  } finally {
    await harness.close(ctx);
  }
});

test("a routine turn is never offered bot_memory and cannot call it", async () => {
  const { memory, memoryFile } = memoryFor();
  const offered: string[][] = [];
  const fauxModels = createFauxModels([
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage("Morning brief.");
    },
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage(
        [fauxToolCall(BOT_MEMORY_TOOL_NAME, { target: "memory", operations: [{ action: "add", content: "Injected." }] })],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Done."),
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage("Hi!");
    },
  ]);
  const { harness, root } = await harnessWith(memory, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "Run the brief.", requestId: "routine:task-1:1000" }, ctx)).wait(ctx);
    await (await root.submit({ type: "input", content: "Run again.", requestId: "routine:task-1:2000" }, ctx)).wait(ctx);
    await (await root.submit({ type: "input", content: "Hello", requestId: "desktop-1" }, ctx)).wait(ctx);
    assert.deepEqual(offered, [[], [], [BOT_MEMORY_TOOL_NAME]]);
    const view = await root.context(ctx);
    const results = view.entries
      .filter((entry) => entry.kind === ToolResultEntry.kind)
      .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, true, "a forced call on a routine turn is blocked");
    assert.match(results[0]!.content[0]!.text ?? "", /not available on this turn/u);
    assert.throws(() => readFileSync(memoryFile, "utf8"), /ENOENT/u, "nothing reached memory");
  } finally {
    await harness.close(ctx);
  }
});
