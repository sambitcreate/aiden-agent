import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import { createBotRegistry, type BotExtensionDeps, type BotRegistry } from "./bot-extension.js";
import { createBotHarnessHost, type BotHarnessHost } from "./harness-host.js";
import { spawnHarnessChild } from "./test-support/child.js";
import { countingTool, recordingDeps } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, type FauxModels } from "./test-support/faux.js";

const ctx = BACKGROUND_CONTEXT;
const scenarioFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-support", "extension-scenario.ts");
const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-ext-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type ToolResultModel = { isError: boolean; toolName: string; content: Array<{ text?: string }> };

async function toolResults(root: Conversation): Promise<ToolResultModel[]> {
  const view = await root.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!);
}

async function memoryHarness(deps: BotExtensionDeps, fauxModels: FauxModels) {
  const registry = createBotRegistry("bot-1", deps);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root, registry };
}

/** Reopen a profile that a killed child left behind, with parent-side deps. */
async function reopenAfterKill(profileDir: string, botId: string, deps: BotExtensionDeps, fauxModels: FauxModels) {
  let registry: BotRegistry | undefined;
  const host = (await createBotHarnessHost({
    profileDir,
    models: fauxModels.models,
    buildRegistry: (id) => (registry = createBotRegistry(id, deps)),
  })) as BotHarnessHost;
  const { harness, conversation } = await host.open(botId);
  await registry!.refresh();
  return { host, harness, conversation, registry: registry! };
}

test("(a) the provider receives the sections in the order base, persona, authority", async () => {
  const prompts: string[] = [];
  const fauxModels = createFauxModels([
    (context) => {
      prompts.push(getCurrentSystemPrompt(context.messages) ?? "");
      return fauxAssistantMessage("ok");
    },
  ]);
  const deps = recordingDeps({ sections: ["<base>B</base>", "<persona>P</persona>", "<authority>A</authority>"] });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    assert.equal(prompts.length, 1);
    const prompt = prompts[0]!;
    const base = prompt.indexOf("<base>B</base>");
    const persona = prompt.indexOf("<persona>P</persona>");
    const authority = prompt.indexOf("<authority>A</authority>");
    assert.ok(base >= 0 && persona > base && authority > persona, `unexpected order in ${prompt}`);
  } finally {
    await harness.close(ctx);
  }
});

test("(a2) refresh re-reads the Bot so the next turn uses current sections and tools", async () => {
  const offered: string[][] = [];
  const fauxModels = createFauxModels([
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage("one");
    },
    (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
      return fauxAssistantMessage("two");
    },
  ]);
  let tools = [{ tool: countingTool("first_tool"), replay: "unsafe" as const }];
  const deps: BotExtensionDeps = { ...recordingDeps(), currentTools: async () => tools };
  const { harness, root, registry } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "1" }, ctx)).wait(ctx);
    tools = [{ tool: countingTool("second_tool"), replay: "unsafe" }];
    await registry.refresh();
    await (await root.submit({ type: "input", content: "2" }, ctx)).wait(ctx);
    assert.deepEqual(offered, [["first_tool"], ["second_tool"]]);
  } finally {
    await harness.close(ctx);
  }
});

test("(b) a tool the current policy forbids is blocked without running", async () => {
  const forbidden = countingTool("forbidden");
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("forbidden", { text: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("understood"),
  ]);
  const deps = recordingDeps({
    tools: [{ tool: forbidden, replay: "unsafe" }],
    policy: () => ({ allowed: false, reason: "Files are off for this Bot." }),
  });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    assert.equal((await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx)).status, "done");
    assert.deepEqual(forbidden.executions, []);
    const [result] = await toolResults(root);
    assert.equal(result!.isError, true);
    assert.match(result!.content[0]!.text ?? "", /blocked: Files are off for this Bot\./u);
  } finally {
    await harness.close(ctx);
  }
});

test("(c) an approval-gated tool asks once and runs after allow", async () => {
  const gated = countingTool("gated");
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("gated", { text: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const deps = recordingDeps({
    tools: [{ tool: gated, replay: "unsafe" }],
    policy: () => ({ allowed: true, approval: { summary: "Send the email" } }),
  });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    assert.equal(deps.approvals.length, 1);
    assert.equal(deps.approvals[0]!.summary, "Send the email");
    assert.equal(deps.approvals[0]!.toolName, "gated");
    assert.match(deps.approvals[0]!.waitId, /^[0-9a-f-]{36}$/u);
    assert.equal(gated.executions.length, 1);
  } finally {
    await harness.close(ctx);
  }
});

test("(c2) a denied approval blocks the tool", async () => {
  const gated = countingTool("gated");
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("gated", { text: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("ok, not doing it"),
  ]);
  const deps = recordingDeps({
    tools: [{ tool: gated, replay: "unsafe" }],
    policy: () => ({ allowed: true, approval: { summary: "Delete files" } }),
    approve: async () => "deny",
  });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    assert.deepEqual(gated.executions, []);
    const [result] = await toolResults(root);
    assert.equal(result!.isError, true);
  } finally {
    await harness.close(ctx);
  }
});

test("(d) after SIGKILL while waiting for approval, Resume re-asks with the same waitId", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("scenario", [
    scenarioFile,
    JSON.stringify({ profileDir: profile, botId: "bot-approval", kind: "approval" }),
  ]);
  const childWaitId = await child.waitFor("APPROVAL");
  await child.kill();

  const gated = countingTool("gated");
  const fauxModels = createFauxModels([fauxAssistantMessage("all done")]);
  const deps = recordingDeps({
    tools: [{ tool: gated, replay: "unsafe" }],
    policy: () => ({ allowed: true, approval: { summary: "Run gated" } }),
  });
  const { host, harness } = await reopenAfterKill(profile, "bot-approval", deps, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    const settled = await (await harness.submission(placed!.id, ctx))!.wait(ctx);
    assert.equal(settled.status, "done");
    assert.deepEqual(
      deps.approvals.map((request) => request.waitId),
      [childWaitId],
      "the approval is re-asked once, under the original waitId",
    );
    assert.equal(gated.executions.length, 1);
    assert.equal(fauxModels.calls(), 1, "only the follow-up answer is requested");
  } finally {
    await host.shutdown();
  }
});

test("(e) Resume after an access change makes no provider request and reports access_changed", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("stream", [profile, "bot-drift", "req-drift"]);
  await child.waitFor("STREAMING");
  await child.kill();

  const fauxModels = createFauxModels([fauxAssistantMessage("must not be requested")]);
  const deps = recordingDeps({ readmit: () => ({ ok: false, reason: "access_changed" }) });
  const { host, harness, registry } = await reopenAfterKill(profile, "bot-drift", deps, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    const settled = await (await harness.submission(placed!.id, ctx))!.wait(ctx);
    assert.equal(settled.status, "unanswered");
    assert.equal(fauxModels.calls(), 0);
    assert.deepEqual(registry.admissionFailure(), { ok: false, reason: "access_changed" });
  } finally {
    await host.shutdown();
  }
});

test("(e2) the first request after open re-admits once; later requests do not", async () => {
  const fauxModels = createFauxModels([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  const deps = recordingDeps();
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "1" }, ctx)).wait(ctx);
    await (await root.submit({ type: "input", content: "2" }, ctx)).wait(ctx);
    assert.equal(deps.readmissions, 1);
    assert.equal(fauxModels.calls(), 2);
  } finally {
    await harness.close(ctx);
  }
});

test("(f) after SIGKILL mid-tool an unsafe tool becomes an interrupted error and a safe tool reruns", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("scenario", [
    scenarioFile,
    JSON.stringify({ profileDir: profile, botId: "bot-tools", kind: "tools" }),
  ]);
  await child.waitFor("TOOL_RUNNING", 20_000, ["unsafe_op", "safe_op"]);
  await child.kill();

  const unsafeOp = countingTool("unsafe_op");
  const safeOp = countingTool("safe_op");
  const fauxModels = createFauxModels([fauxAssistantMessage("recovered")]);
  const deps = recordingDeps({
    tools: [
      { tool: unsafeOp, replay: "unsafe" },
      { tool: safeOp, replay: "safe" },
    ],
  });
  const { host, harness, conversation } = await reopenAfterKill(profile, "bot-tools", deps, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    assert.equal((await (await harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");
    assert.deepEqual(unsafeOp.executions, [], "an unsafe tool never reruns");
    assert.deepEqual(safeOp.executions, [{ text: "s" }], "a safe tool reruns once");
    const results = await toolResults(conversation);
    const unsafeResult = results.find((result) => result.toolName === "unsafe_op")!;
    const safeResult = results.find((result) => result.toolName === "safe_op")!;
    assert.equal(unsafeResult.isError, true);
    assert.match(unsafeResult.content.map((part) => part.text ?? "").join(""), /interrupted/u);
    assert.equal(safeResult.isError, false);
  } finally {
    await host.shutdown();
  }
});

test("MCP tools are never replay-safe, whatever the caller declares", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("scenario", [
    scenarioFile,
    JSON.stringify({ profileDir: profile, botId: "bot-mcp", kind: "tools" }),
  ]);
  await child.waitFor("TOOL_RUNNING", 20_000, ["unsafe_op", "safe_op"]);
  await child.kill();

  const unsafeOp = countingTool("unsafe_op");
  const mcpOp = countingTool("safe_op");
  const fauxModels = createFauxModels([fauxAssistantMessage("recovered")]);
  const deps = recordingDeps({
    tools: [
      { tool: unsafeOp, replay: "unsafe" },
      { tool: mcpOp, replay: "safe", mcp: true },
    ],
  });
  const { host, harness } = await reopenAfterKill(profile, "bot-mcp", deps, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    await (await harness.submission(placed!.id, ctx))!.wait(ctx);
    assert.deepEqual(mcpOp.executions, [], "an interrupted MCP call is not rerun");
  } finally {
    await host.shutdown();
  }
});
