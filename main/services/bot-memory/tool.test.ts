import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import { type BotExtensionDeps } from "../bot-runtime/bot-extension.js";
import { botIngressAllowsTool, botIngressRefusal } from "../bot-runtime/bot-tool-policy.js";
import { holdNextRead, recordingDeps } from "../bot-runtime/test-support/fixtures.js";
import { botToolResults, openBotHarness } from "../bot-runtime/test-support/harness.js";
import { createFauxModels, type FauxModels } from "../bot-runtime/test-support/faux.js";
import { createBotMemoryService } from "./service.js";
import { createBotMemoryStore } from "./store.js";
import { botRecallToolEntry } from "./recall.js";
import { BOT_MEMORY_TOOL_NAME, botMemoryAllowed, botMemoryToolEntry, createBotMemoryTool, withBotMemoryIngress } from "./tool.js";

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
    turnRefusal: botIngressRefusal,
  };
  const { harness, root } = await openBotHarness({ botId: BOT, deps, fauxModels, ctx });
  return { harness, root };
}

async function memoryResults(root: Conversation): Promise<Array<{ isError: boolean; json: Record<string, unknown> }>> {
  return (await botToolResults(root, ctx))
    .filter((result) => result.toolName === BOT_MEMORY_TOOL_NAME)
    .map((result) => ({ isError: result.isError, json: JSON.parse(result.content[0]!.text ?? "{}") as Record<string, unknown> }));
}

const filler = Array.from({ length: 10 }, (_, index) => `${String.fromCharCode(65 + index)} ${"x".repeat(435)}`);
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

test("a routine turn lists bot_memory like a person turn but its call is refused with the reason", async () => {
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
    // One tool list for every turn, so routine and person turns share the
    // provider prompt cache; ingress refuses the call instead.
    assert.deepEqual(offered, [[BOT_MEMORY_TOOL_NAME], [BOT_MEMORY_TOOL_NAME], [BOT_MEMORY_TOOL_NAME]]);
    const view = await root.context(ctx);
    const results = view.entries
      .filter((entry) => entry.kind === ToolResultEntry.kind)
      .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, true, "a forced call on a routine turn is blocked");
    assert.match(results[0]!.content[0]!.text ?? "", /not available on this turn: memory is saved only on turns that answer the person/u);
    assert.throws(() => readFileSync(memoryFile, "utf8"), /ENOENT/u, "nothing reached memory");
  } finally {
    await harness.close(ctx);
  }
});

test("a call aborted while its save reads memory is not published", async () => {
  const { memory, memoryFile } = memoryFor();
  const hold = holdNextRead(path.dirname(memoryFile));
  try {
    const controller = new AbortController();
    hold.arm();
    const call = createBotMemoryTool(BOT, memory).execute(
      "call-1",
      { target: "memory", operations: [{ action: "add", content: "Prefers short answers." }] },
      controller.signal,
    );
    await hold.reached;
    controller.abort(new Error("The turn stopped."));
    hold.resume();
    await assert.rejects(call, /The turn stopped/u);
    assert.throws(() => readFileSync(memoryFile, "utf8"), /ENOENT/u, "nothing reached memory");
  } finally {
    hold.restore();
  }
});

test('Bot-message inputs cannot write memory', async () => {
 const {botMemoryAllowed} = await import('./tool.js');
 assert.equal(botMemoryAllowed(['bot:J:1:00112233-4455-4677-8899-aabbccddeeff']),false);
 assert.equal(botMemoryAllowed(['botreply:00112233-4455-4677-8899-aabbccddeeff']),false);
});

test("recall defers to base ingress except for unknown inputs and Bot-message prefixes", () => {
  const baseCalls: Array<readonly (string | undefined)[]> = [];
  const ingress = withBotMemoryIngress((_name, requestIds) => {
    baseCalls.push(requestIds);
    return false;
  });
  assert.equal(ingress("bot_recall", ["routine:brief:1"]), false, "the wrapper must not bypass a base refusal");
  assert.deepEqual(baseCalls, [["routine:brief:1"]]);
  for (const requestIds of [[], ["bot:"], ["botreply:"], [undefined, "bot:malformed"], ["botreply:malformed"]]) {
    assert.equal(withBotMemoryIngress(() => true)("bot_recall", requestIds), false);
    assert.equal(botMemoryAllowed(requestIds), false);
  }
  assert.equal(botMemoryAllowed([undefined]), true, "one unnamed person input is known provenance");
  assert.equal(withBotMemoryIngress(botIngressAllowsTool)("bot_recall", ["intro:hello"]), false);
});

test("a routine can recall person history while memory writes remain withheld", async () => {
  const { memory } = memoryFor();
  const offered: string[][] = [];
  const faux = createFauxModels([
    fauxAssistantMessage("I will remember the Lisbon trip."),
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage([fauxToolCall("bot_recall", { query: "Lisbon" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Here is your brief."),
  ]);
  const { harness, root } = await openBotHarness({
    botId: BOT,
    deps: {
      ...recordingDeps(),
      currentTools: async () => [botMemoryToolEntry(BOT, memory), botRecallToolEntry()],
      turnAllows: withBotMemoryIngress(botIngressAllowsTool),
    },
    fauxModels: faux,
    ctx,
  });
  try {
    await (await root.submit({ type: "input", content: "My Lisbon trip is next week." }, ctx)).wait(ctx);
    await (
      await root.submit({ type: "input", content: "Prepare my brief", requestId: "routine:brief:1" }, ctx)
    ).wait(ctx);
    assert.equal(offered.length, 1);
    assert.ok(offered[0]!.includes("bot_recall"));
    assert.ok(offered[0]!.includes("bot_memory"), "memory stays declared; ingress refuses its calls");
    const results = (await root.context(ctx)).entries
      .filter((entry) => entry.kind === ToolResultEntry.kind)
      .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.toolName, "bot_recall");
    assert.equal(results[0]!.isError, false);
    const recalled = JSON.parse(results[0]!.content[0]!.text!) as {
      ok: boolean;
      results: Array<{ from: string; excerpt: string }>;
    };
    assert.equal(recalled.ok, true);
    assert.ok(
      recalled.results.some(
        (result) => result.from === "person" && result.excerpt.includes("My Lisbon trip is next week."),
      ),
    );
  } finally {
    await harness.close(ctx);
  }
});

test("while the Bot has routines, a note saying it can't schedule or message first is refused", async () => {
  const { memory, memoryFile } = memoryFor();
  let asked = 0;
  const tool = createBotMemoryTool(BOT, memory, { canSchedule: async () => { asked += 1; return true; } });
  const save = async (target: "memory" | "user", content: string) => {
    const result = await tool.execute("call", { target, operations: [{ action: "add", content }] }, undefined);
    return { isError: result.isError === true, json: JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown> };
  };

  // The note a Chief of Staff Bot really kept, and the ways small models word it.
  for (const note of [
    "I cannot self-schedule; ask the person to set a calendar nudge instead.",
    "I can’t start a conversation on my own.",
    "Cannot self-schedule or run on a timer.",
    "I'm unable to message you first.",
    "The bot doesn't have the ability to schedule future check-ins.",
  ]) {
    const refused = await save("memory", note);
    assert.equal(refused.isError, true, note);
    assert.match(String(refused.json.error), /routines tool/u, note);
  }
  assert.equal((await save("user", "I can't reach out first, so the person messages me each morning.")).isError, true);
  assert.throws(() => readFileSync(memoryFile, "utf8"), /ENOENT/u, "nothing was saved");
  const askedForClaims = asked;

  // Facts about the person, and true notes about other limits, still save without asking.
  assert.equal((await save("user", "Can't start conversations at work before 10 AM.")).isError, false);
  assert.equal((await save("memory", "I can't see their Outlook calendar yet.")).isError, false);
  assert.equal(asked, askedForClaims, "only an entry that makes the claim asks about routines");

  // Replacing an entry with the claim is refused too; removing the claim works.
  const replaced = await tool.execute("call", { target: "memory", operations: [{ action: "replace", match: "Outlook", content: "I can't schedule follow-up messages." }] }, undefined);
  assert.equal(replaced.isError, true);
  assert.match(readFileSync(memoryFile, "utf8"), /Outlook/u);
});

test("a note that it can't schedule is refused when Aiden can't tell whether the Bot has routines", async () => {
  const { memory, memoryFile } = memoryFor();
  const tool = createBotMemoryTool(BOT, memory, { canSchedule: async () => { throw new Error("access unavailable"); } });
  const result = await tool.execute("call", { target: "memory", operations: [{ action: "add", content: "I cannot self-schedule." }] }, undefined);
  assert.equal(result.isError, true);
  assert.throws(() => readFileSync(memoryFile, "utf8"), /ENOENT/u);
});

test("a Bot without routines may keep a note that it can't schedule", async () => {
  const { memory, memoryFile } = memoryFor();
  const tool = createBotMemoryTool(BOT, memory, { canSchedule: async () => false });
  const result = await tool.execute("call", { target: "memory", operations: [{ action: "add", content: "I cannot self-schedule." }] }, undefined);
  assert.equal(result.isError, undefined);
  assert.match(readFileSync(memoryFile, "utf8"), /cannot self-schedule/u);
});
