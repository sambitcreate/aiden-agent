import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, getCurrentTools, type ImageContent, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import type { ResolvedModelRuntime } from "../model-runtime.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import { buildSkillTools } from "../skill-tools.js";
import { createBotApprovals, type BotApprovalPrompt } from "./bot-approvals.js";
import { createBotRegistry, type BotExtensionDeps, type BotRegistry } from "./bot-extension.js";
import { BOT_SHARED_IMAGE_ENTRY_KIND, botImageReference } from "./bot-images.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import { shareImageCandidate, visionCandidate } from "./bot-tool-candidates.js";
import { createBotHarnessHost, type BotHarnessHost } from "./harness-host.js";
import {
  assemblyDeps,
  assemblyState,
  CUSTOM_NONE,
  FULL_GRANTS,
  MAIL_SERVER,
  NOTES_SKILL_TOOL,
  PNG_1X1,
  READ_INBOX_TOOL,
  SEND_EMAIL_TOOL,
  testAuthority,
  type AssemblyState,
} from "./test-support/assembly-fixtures.js";
import { spawnHarnessChild } from "./test-support/child.js";
import { countingTool } from "./test-support/fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor, type FauxModels } from "./test-support/faux.js";

const ctx = BACKGROUND_CONTEXT;
const scenarioFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-support", "assembly-scenario.ts");
const roots: string[] = [];
function tempDir(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A Bot folder holding `photo.png`. */
function botHome(): string {
  const home = tempDir("aiden-bot-home-");
  writeFileSync(path.join(home, "photo.png"), PNG_1X1);
  return home;
}

const full = (home: string) => testAuthority({ mode: "full", home, ...FULL_GRANTS });
const customNone = (home: string) => testAuthority({ mode: "custom", home, ...CUSTOM_NONE });

type ToolResultModel = { isError: boolean; toolName: string; content: Array<{ text?: string }> };

async function toolResults(conversation: Conversation): Promise<ToolResultModel[]> {
  const view = await conversation.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === ToolResultEntry.kind)
    .map((entry) => (entry as unknown as { model: ToolResultModel[] }).model[0]!);
}

async function sharedImages(conversation: Conversation): Promise<Array<{ name: string; data: string }>> {
  const view = await conversation.context(ctx);
  return view.entries
    .filter((entry) => entry.kind === BOT_SHARED_IMAGE_ENTRY_KIND)
    .map((entry) => entry.data as unknown as { name: string; data: string });
}

const resultText = (result: ToolResultModel | undefined) => result?.content.map((part) => part.text ?? "").join("") ?? "";

async function memoryHarness(deps: BotExtensionDeps, fauxModels: FauxModels) {
  const registry = createBotRegistry("bot-1", deps);
  await registry.refresh();
  const harness = await Harness.open(new MemoryStorage(), { models: fauxModels.models, registry }, ctx);
  registry.attachHarness(harness);
  const root = await harness.root(ctx, { agent: { model: FAUX_MODEL_REF } });
  return { harness, root, registry };
}

/** A faux runtime for the companion vision model. */
function visionRuntime(answer: string) {
  const vision = createFauxModels([fauxAssistantMessage(answer)], { provider: "vision", modelId: "vision-model" });
  const runtime = {
    model: vision.models.getModel("vision", "vision-model")!,
    streams: vision.models,
    provider: { id: "vision", label: "Vision" },
  } as unknown as ResolvedModelRuntime;
  return { vision, runtime };
}

/**
 * Every ported group, as the legacy factories (or stand-ins named like the
 * tools they discover) would build it. The assembly decides what is offered.
 */
function allCandidates(authority: BotRuntimeEffectiveAuthority, state: AssemblyState): BotToolCandidate[] {
  const candidates: BotToolCandidate[] = [
    { tool: countingTool(SEND_EMAIL_TOOL), mcp: true },
    { tool: countingTool(READ_INBOX_TOOL), mcp: true },
    ...buildSkillTools(state.skillSnapshot).map((tool) => ({ tool })),
    { tool: countingTool("web_search") },
    { tool: countingTool("subagent") },
    { tool: countingTool("computer_use") },
  ];
  if (authority.files.botHome) candidates.push(shareImageCandidate(authority));
  const vision = visionCandidate(authority, {
    revalidateBeforeEffect: async () => undefined,
    dependencies: { resolveRuntime: async () => visionRuntime("a red square").runtime, recordUsage: async () => undefined },
  });
  if (vision) candidates.push(vision);
  return candidates;
}

interface Group {
  label: string;
  tool: string;
  args: Parameters<typeof fauxToolCall>[1];
}

const GROUPS: Group[] = [
  { label: "an MCP connection tool", tool: SEND_EMAIL_TOOL, args: { text: "hi" } },
  { label: "a skill", tool: NOTES_SKILL_TOOL, args: {} },
  { label: "web search", tool: "web_search", args: { text: "news" } },
  { label: "subagents", tool: "subagent", args: { text: "delegate" } },
  { label: "Computer Use", tool: "computer_use", args: { text: "click" } },
  { label: "companion vision", tool: "inspect_image", args: { imageRef: "image_x", question: "what?" } },
  { label: "sharing an image", tool: "share_image", args: { path: "photo.png" } },
];

async function offeredUnder(authority: (home: string) => BotRuntimeEffectiveAuthority): Promise<string[]> {
  const home = botHome();
  const state = assemblyState(authority(home), false);
  let offered: string[] = [];
  const fauxModels = createFauxModels([
    (context) => {
      offered = getCurrentTools(context.messages).map((tool) => tool.name);
      return fauxAssistantMessage("ok");
    },
  ]);
  const deps = assemblyDeps(state, { candidates: (current) => allCandidates(current, state) });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    return offered;
  } finally {
    await harness.close(ctx);
  }
}

test("Full Access offers every ported group; Custom Access without those grants offers none of them", async () => {
  const underFull = await offeredUnder(full);
  const underCustom = await offeredUnder(customNone);
  for (const group of GROUPS) {
    assert.ok(underFull.includes(group.tool), `${group.label} is offered under Full Access (${underFull.join(", ")})`);
    assert.ok(!underCustom.includes(group.tool), `${group.label} is withheld under Custom Access`);
  }
  assert.ok(underFull.includes(READ_INBOX_TOOL));
});

for (const group of GROUPS) {
  test(`${group.label}: access removed after the offer is re-checked at call time and blocks the call`, async () => {
    const home = botHome();
    const state = assemblyState(full(home), false);
    const candidates = allCandidates(state.authority, state);
    const fauxModels = createFauxModels([
      (context) => {
        assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === group.tool));
        // The person switches the Bot to Custom Access while the model answers.
        state.authority = customNone(home);
        return fauxAssistantMessage([fauxToolCall(group.tool, group.args)], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("understood"),
    ]);
    const deps = assemblyDeps(state, { candidates: () => candidates });
    const { harness, root } = await memoryHarness(deps, fauxModels);
    try {
      await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
      const [result] = await toolResults(root);
      assert.equal(result!.isError, true);
      assert.match(resultText(result), /blocked/u);
      const counted = candidates.find((candidate) => candidate.tool.name === group.tool)?.tool as { executions?: unknown[] };
      if (counted.executions) assert.deepEqual(counted.executions, [], "the tool never ran");
      assert.deepEqual(await sharedImages(root), []);
      assert.deepEqual(deps.approvals, [], "nothing was asked for a blocked call");
    } finally {
      await harness.close(ctx);
    }
  });
}

test("a connection whose tool fingerprint changed after the offer is refused at call time", async () => {
  const state = assemblyState(full(botHome()));
  const send = countingTool(READ_INBOX_TOOL);
  const fauxModels = createFauxModels([
    () => {
      state.catalog.connections[0]!.tools[1]!.inputSchemaFingerprint = "in-read-v2";
      return fauxAssistantMessage([fauxToolCall(READ_INBOX_TOOL, { text: "x" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("ok"),
  ]);
  const deps = assemblyDeps(state, { candidates: () => [{ tool: send, mcp: true }] });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    const [result] = await toolResults(root);
    assert.match(resultText(result), /blocked: A selected Bot connection tool changed/u);
    assert.deepEqual(send.executions, []);
  } finally {
    await harness.close(ctx);
  }
});

test("a skill whose content fingerprint changed after the offer is refused at call time", async () => {
  const state = assemblyState(full(botHome()));
  const fauxModels = createFauxModels([
    () => {
      state.catalog.skills[0] = { ...state.catalog.skills[0]!, contentFingerprint: "edited" };
      return fauxAssistantMessage([fauxToolCall(NOTES_SKILL_TOOL, {})], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("ok"),
  ]);
  const deps = assemblyDeps(state, { candidates: () => buildSkillTools(state.skillSnapshot).map((tool) => ({ tool })) });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    const [result] = await toolResults(root);
    assert.match(resultText(result), /blocked: A selected Bot skill changed/u);
    assert.doesNotMatch(resultText(result), /Plan meals/u, "the skill's instructions were not returned");
  } finally {
    await harness.close(ctx);
  }
});

test("MCP server instructions reach the prompt only for offered connection tools", async () => {
  const guidance = [
    { serverId: MAIL_SERVER.id, serverName: MAIL_SERVER.name, toolNames: [SEND_EMAIL_TOOL], instructions: "Sign every email." },
  ];
  async function promptUnder(authority: BotRuntimeEffectiveAuthority): Promise<string> {
    const state = assemblyState(authority);
    let prompt = "";
    const fauxModels = createFauxModels([
      (context) => {
        prompt = getCurrentSystemPrompt(context.messages) ?? "";
        return fauxAssistantMessage("ok");
      },
    ]);
    const deps = assemblyDeps(state, { candidates: () => [{ tool: countingTool(SEND_EMAIL_TOOL), mcp: true }], guidance });
    const { harness, root } = await memoryHarness(deps, fauxModels);
    try {
      await (await root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
      return prompt;
    } finally {
      await harness.close(ctx);
    }
  }
  const home = botHome();
  const fullPrompt = await promptUnder(full(home));
  assert.match(fullPrompt, /MCP service guidance/u);
  assert.match(fullPrompt, /Sign every email\./u);
  assert.ok(fullPrompt.indexOf("AUTHORITY") < fullPrompt.indexOf("Sign every email."), "guidance follows the authority section");
  assert.doesNotMatch(await promptUnder(customNone(home)), /Sign every email/u);
});

async function shareTurn(decision: "allow" | "deny") {
  const home = botHome();
  const state = assemblyState(full(home));
  const published: BotApprovalPrompt[] = [];
  const bridge = createBotApprovals({
    publish: (prompt) => {
      published.push(prompt);
      // Answer from "another window" by waitId, as `bots:approve` does.
      queueMicrotask(() => assert.equal(bridge.decide(prompt.waitId, decision), true));
    },
  });
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("share_image", { path: "photo.png" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const deps = assemblyDeps(state, { candidates: (authority) => [shareImageCandidate(authority)] });
  deps.requestApproval = (request) => bridge.request(request);
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "send me the photo" }, ctx)).wait(ctx);
    return { published, shared: await sharedImages(root), results: await toolResults(root), pending: bridge.pending() };
  } finally {
    await harness.close(ctx);
  }
}

test("sharing an image asks for approval; Allow by waitId shares it into the conversation", async () => {
  const { published, shared, results, pending } = await shareTurn("allow");
  assert.equal(published.length, 1);
  assert.equal(published[0]!.summary, "Share image in chat: photo.png");
  assert.equal(published[0]!.botId, "bot-1");
  assert.deepEqual(shared.map((image) => [image.name, image.data]), [["photo.png", PNG_1X1.toString("base64")]]);
  assert.equal(results[0]!.isError, false);
  assert.deepEqual(pending, [], "the prompt is withdrawn once answered");
});

test("Deny by waitId blocks the share and adds nothing to the conversation", async () => {
  const { published, shared, results } = await shareTurn("deny");
  assert.equal(published.length, 1);
  assert.deepEqual(shared, []);
  assert.equal(results[0]!.isError, true);
  assert.match(resultText(results[0]), /declined/u);
});

test("a mutating connection tool asks for approval and a read-only one does not", async () => {
  const state = assemblyState(full(botHome()));
  const send = countingTool(SEND_EMAIL_TOOL);
  const read = countingTool(READ_INBOX_TOOL);
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall(READ_INBOX_TOOL, { text: "r" }), fauxToolCall(SEND_EMAIL_TOOL, { text: "s" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  const deps = assemblyDeps(state, {
    candidates: () => [
      { tool: send, mcp: true },
      { tool: read, mcp: true },
    ],
  });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    assert.deepEqual(deps.approvals.map((request) => request.toolName), [SEND_EMAIL_TOOL]);
    assert.equal(send.executions.length, 1);
    assert.equal(read.executions.length, 1);
  } finally {
    await harness.close(ctx);
  }
});

test("Computer Use asks with its live summary and binds the grant to the exact call that runs", async () => {
  const state = assemblyState(full(botHome()));
  const authorized: string[] = [];
  const ran: string[] = [];
  const computer = countingTool("computer_use");
  const tool = {
    ...computer,
    execute: (toolCallId: string, ...rest: Parameters<typeof computer.execute> extends [unknown, ...infer R] ? R : never) => {
      ran.push(toolCallId);
      return computer.execute(toolCallId, ...rest);
    },
  };
  const fauxModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("computer_use", { text: "click" }, { id: "call-cu" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const deps = assemblyDeps(state, {
    candidates: () => [{ tool }],
    approvalFor: async (toolName, call) =>
      toolName === "computer_use"
        ? { summary: "Click Save — TextEdit", onAllow: () => void authorized.push(call.callId) }
        : undefined,
  });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    assert.deepEqual(deps.approvals.map((request) => request.summary), ["Click Save — TextEdit"]);
    assert.deepEqual(authorized, ["call-cu"]);
    assert.deepEqual(ran, ["call-cu"]);
  } finally {
    await harness.close(ctx);
  }
});

test("a model without image input sees references; inspect_image answers from the conversation's own image", async () => {
  const image = PNG_1X1.toString("base64");
  const reference = botImageReference(image);
  const state = assemblyState(full(botHome()), false);
  const { vision, runtime } = visionRuntime("A tiny red square.");
  const seenByBot: Message[][] = [];
  const fauxModels = createFauxModels([
    (context) => {
      seenByBot.push([...context.messages]);
      return fauxAssistantMessage([fauxToolCall("inspect_image", { imageRef: reference, question: "What is it?" })], {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("It is a red square."),
  ]);
  let visionImages: ImageContent[] = [];
  const deps = assemblyDeps(state, {
    candidates: (authority) => [
      visionCandidate(authority, {
        revalidateBeforeEffect: async () => undefined,
        dependencies: {
          resolveRuntime: async () => runtime,
          recordUsage: async () => undefined,
        },
      })!,
    ],
  });
  vision.faux.setResponses([
    (context) => {
      visionImages = context.messages.flatMap((message) =>
        message.role === "user" && typeof message.content !== "string"
          ? message.content.filter((part): part is ImageContent => part.type === "image")
          : [],
      );
      return fauxAssistantMessage("A tiny red square.");
    },
  ]);
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (
      await root.submit(
        { type: "input", content: [{ type: "text", text: "what is this?" }, { type: "image", mimeType: "image/png", data: image }] },
        ctx,
      )
    ).wait(ctx);
    const userMessage = seenByBot[0]!.find((message) => message.role === "user")!;
    const parts = typeof userMessage.content === "string" ? [] : userMessage.content;
    assert.ok(parts.every((part) => part.type === "text"), "no image part reaches a text-only model");
    assert.match(parts.map((part) => (part.type === "text" ? part.text : "")).join(""), new RegExp(`Attached image reference: ${reference}`, "u"));
    assert.deepEqual(visionImages.map((part) => part.data), [image], "the companion model received the stored image");
    const [result] = await toolResults(root);
    assert.equal(resultText(result), "A tiny red square.");
    const view = await root.context(ctx);
    const stored = view.entries.find((entry) => entry.kind === "pi.user")!.model![0]!;
    assert.ok(
      typeof stored.content !== "string" && stored.content.some((part) => part.type === "image"),
      "the stored entry keeps the native image",
    );
  } finally {
    await harness.close(ctx);
  }
});

test("a model with image input receives the person's image natively", async () => {
  const image = PNG_1X1.toString("base64");
  const state = assemblyState(full(botHome()), true);
  const seen: Message[][] = [];
  const fauxModels = createFauxModels([
    (context) => {
      seen.push([...context.messages]);
      return fauxAssistantMessage("a square");
    },
  ]);
  const deps = assemblyDeps(state, { candidates: () => [] });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (
      await root.submit({ type: "input", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: image }] }, ctx)
    ).wait(ctx);
    const user = seen[0]!.find((message) => message.role === "user")!;
    assert.ok(typeof user.content !== "string" && user.content.some((part) => part.type === "image" && part.data === image));
  } finally {
    await harness.close(ctx);
  }
});

async function reopen(profileDir: string, botId: string, deps: BotExtensionDeps, fauxModels: FauxModels) {
  let registry: BotRegistry | undefined;
  const host = (await createBotHarnessHost({
    profileDir,
    models: fauxModels.models,
    buildRegistry: (id) => (registry = createBotRegistry(id, deps)),
  })) as BotHarnessHost;
  const { harness, conversation } = await host.open(botId);
  await registry!.refresh();
  return { host, harness, conversation };
}

test("SIGKILL while a real share_image waits for approval: Resume re-asks with the same waitId and shares once after Allow", async () => {
  const profile = tempDir("aiden-bot-assembly-");
  const home = botHome();
  const child = spawnHarnessChild("scenario", [
    scenarioFile,
    JSON.stringify({ profileDir: profile, home, botId: "bot-share", kind: "share-approval" }),
  ]);
  const childWaitId = await child.waitFor("APPROVAL");
  await child.kill();

  const state = assemblyState(full(home));
  const published: BotApprovalPrompt[] = [];
  const bridge = createBotApprovals({
    publish: (prompt) => {
      published.push(prompt);
      queueMicrotask(() => bridge.decide(prompt.waitId, "allow"));
    },
  });
  const deps = assemblyDeps(state, { candidates: (authority) => [shareImageCandidate(authority)] });
  deps.requestApproval = (request) => bridge.request(request);
  const fauxModels = createFauxModels([fauxAssistantMessage("Here it is.")]);
  const { host, harness, conversation } = await reopen(profile, "bot-share", deps, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    assert.equal((await (await harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");
    assert.deepEqual(published.map((prompt) => prompt.waitId), [childWaitId], "re-asked once, under the original waitId");
    assert.equal((await sharedImages(conversation)).length, 1, "the image is shared exactly once");
    assert.equal(fauxModels.calls(), 1, "only the follow-up answer is requested");
  } finally {
    await host.shutdown();
  }
});

test("a parent killed while its subagent runs never relaunches it on Resume, even if the tool calls itself replay-safe", async () => {
  const profile = tempDir("aiden-bot-assembly-");
  const home = botHome();
  const child = spawnHarnessChild("scenario", [
    scenarioFile,
    JSON.stringify({ profileDir: profile, home, botId: "bot-sub", kind: "subagent" }),
  ]);
  await child.waitFor("TOOL_RUNNING");
  await child.kill();

  const subagent = countingTool("subagent");
  const state = assemblyState(full(home));
  const deps = assemblyDeps(state, {
    candidates: () => [{ tool: declarePiRuntimeReplay(subagent, "safe") }],
  });
  const fauxModels = createFauxModels([fauxAssistantMessage("The delegated work was interrupted.")]);
  const { host, harness, conversation } = await reopen(profile, "bot-sub", deps, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    harness.resume();
    assert.equal((await (await harness.submission(placed!.id, ctx))!.wait(ctx)).status, "done");
    assert.deepEqual(subagent.executions, [], "no child is relaunched");
    const [result] = await toolResults(conversation);
    assert.equal(result!.isError, true);
    assert.match(resultText(result), /interrupted/u);
  } finally {
    await host.shutdown();
  }
});

test("revoked access fails the call check closed instead of throwing", async () => {
  const state = assemblyState(full(botHome()));
  const read = countingTool(READ_INBOX_TOOL);
  const fauxModels = createFauxModels([
    () => {
      state.revoked = true;
      return fauxAssistantMessage([fauxToolCall(READ_INBOX_TOOL, { text: "x" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("ok"),
  ]);
  const deps = assemblyDeps(state, { candidates: () => [{ tool: read, mcp: true }] });
  const { harness, root } = await memoryHarness(deps, fauxModels);
  try {
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    const [result] = await toolResults(root);
    assert.match(resultText(result), /blocked: This Bot's access changed/u);
    assert.deepEqual(read.executions, []);
  } finally {
    await harness.close(ctx);
  }
});

async function sharedImagesAt(profile: string, botId: string) {
  const deps = assemblyDeps(assemblyState(full(botHome())), { candidates: () => [] });
  const { host, conversation } = await reopen(profile, botId, deps, createFauxModels());
  try {
    return await sharedImages(conversation);
  } finally {
    await host.shutdown();
  }
}

test("quitting while an approval waits withdraws the prompt; Resume re-asks it under the same waitId", async () => {
  const profile = tempDir("aiden-bot-assembly-");
  const home = botHome();
  const state = assemblyState(full(home));
  const first: BotApprovalPrompt[] = [];
  const withdrawn: string[] = [];
  const quitting = createBotApprovals({
    publish: (prompt) => void first.push(prompt),
    withdraw: (prompt) => void withdrawn.push(prompt.waitId),
  });
  const deps = assemblyDeps(state, { candidates: (authority) => [shareImageCandidate(authority)] });
  deps.requestApproval = (request) => quitting.request(request);
  const firstModels = createFauxModels([
    fauxAssistantMessage([fauxToolCall("share_image", { path: "photo.png" })], { stopReason: "toolUse" }),
  ]);
  const opened = await reopen(profile, "bot-quit", deps, firstModels);
  await opened.conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  await opened.conversation.submit({ type: "input", content: "share it", requestId: "quit-1" }, ctx);
  await waitFor(() => first.length === 1, { what: "the approval prompt" });
  await opened.host.shutdown();
  assert.deepEqual(withdrawn, [first[0]!.waitId], "the prompt is withdrawn on quit");
  assert.deepEqual(await sharedImagesAt(profile, "bot-quit"), [], "nothing was shared on quit");

  const second: BotApprovalPrompt[] = [];
  const restarted = createBotApprovals({
    publish: (prompt) => {
      second.push(prompt);
      queueMicrotask(() => restarted.decide(prompt.waitId, "allow"));
    },
  });
  const nextDeps = assemblyDeps(state, { candidates: (authority) => [shareImageCandidate(authority)] });
  nextDeps.requestApproval = (request) => restarted.request(request);
  const fauxModels = createFauxModels([fauxAssistantMessage("Shared.")]);
  const { host, harness, conversation } = await reopen(profile, "bot-quit", nextDeps, fauxModels);
  try {
    const [placed] = (await harness.inspect(ctx)).submissions;
    assert.ok(placed, "the turn is still unfinished after quit");
    harness.resume();
    assert.equal((await (await harness.submission(placed.id, ctx))!.wait(ctx)).status, "done");
    assert.deepEqual(second.map((prompt) => prompt.waitId), [first[0]!.waitId]);
    assert.equal((await sharedImages(conversation)).length, 1);
    const results = await toolResults(conversation);
    assert.equal(results.length, 1, "no declined result was recorded before the quit");
    assert.equal(results[0]!.isError, false);
  } finally {
    await host.shutdown();
  }
});
