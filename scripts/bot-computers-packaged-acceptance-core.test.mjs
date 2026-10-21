// The packaged Bot computers acceptance, played against itself: pi-ai's real
// OpenAI-compatible client stands in for the Bot (it is what sends the Bot's
// turns to a custom provider), a loopback server answers with the core's
// responses, and a fake guest runs each call. The guest's shell is a real
// /bin/sh, so the command the acceptance sends is checked by running it.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  ACCEPTANCE_FINAL_TEXT,
  ACCEPTANCE_MAX_WAITS,
  ACCEPTANCE_MODEL,
  ACCEPTANCE_PROMPT,
  acceptanceChatCompletionPath,
  acceptanceFixture,
  acceptanceResponse,
  acceptanceSharedFileName,
  acceptanceToolCall,
  evaluateAcceptanceRequests,
  evaluateComputerTimeline,
  isAcceptanceRequest,
  pausedBy,
} from "./bot-computers-packaged-acceptance-core.mjs";

const run = promisify(execFile);
const GIVE_BACK_NOTE = "The person used the computer; take a fresh capture first.";
const NONCE = "0123456789abcdef0123456789abcdef";
const CAPABILITY = "c".repeat(43);
const BASE_VM = "aiden-base";
const SCREENSHOT = "Screenshot of Ada's computer, 1280×800 pixels. Coordinates are pixels of this image.";

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** The loopback model, as the script runs it: every request is recorded and answered by the core. */
async function loopbackModel() {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== acceptanceChatCompletionPath(CAPABILITY)) {
      response.writeHead(404).end();
      return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of acceptanceResponse(body, { giveBackNote: GIVE_BACK_NOTE, nonce: NONCE }).chunks) {
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { port, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A guest whose home has a ~/Shared (the Bot's Computer folder) and a `sw_vers`, for the real shell. */
async function guest({ takeOverOnWait } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-bc-acceptance-"));
  roots.push(root);
  const home = path.join(root, "home");
  const computerFolder = path.join(home, "Shared");
  const bin = path.join(root, "bin");
  await Promise.all([mkdir(computerFolder, { recursive: true }), mkdir(bin)]);
  await writeFile(path.join(bin, "sw_vers"), "#!/bin/sh\n[ \"$1\" = -productVersion ] && echo 26.6.2\n");
  await chmod(path.join(bin, "sw_vers"), 0o755);
  let waits = 0;
  return {
    computerFolder,
    /** What the Bot's tool returns for a call: text, and a screenshot for captures. */
    async call(name, args) {
      if (name === "computer_shell") {
        const { stdout } = await run("/bin/sh", ["-c", args.command], {
          cwd: home,
          env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
        });
        return { text: stdout.trim() };
      }
      switch (args.action) {
        case "capture":
          return { text: SCREENSHOT, image: true };
        case "click":
          return { text: `Clicked at (${args.coordinate[0]}, ${args.coordinate[1]}).` };
        case "wait":
          waits += 1;
          return { text: waits === takeOverOnWait ? GIVE_BACK_NOTE : `Waited ${args.seconds} s.` };
        default:
          throw new Error(`The acceptance sent an action it never scripts: ${args.action}`);
      }
    },
  };
}

/** The Bot: its turn loop over pi-ai's OpenAI-compatible client, until the model stops calling tools. */
async function playBot(model, computer, { vision = true, prompt = ACCEPTANCE_PROMPT } = {}) {
  const provider = {
    id: ACCEPTANCE_MODEL,
    name: ACCEPTANCE_MODEL,
    api: "openai-completions",
    provider: "bot-computers-acceptance",
    baseUrl: `http://127.0.0.1:${model.port}/${CAPABILITY}/v1`,
    reasoning: false,
    input: vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
  const tools = [
    { name: "computer", description: "Use your own computer.", parameters: Type.Object({}, { additionalProperties: true }) },
    { name: "computer_shell", description: "Run a shell command.", parameters: Type.Object({}, { additionalProperties: true }) },
  ];
  const messages = [{ role: "user", content: prompt, timestamp: 0 }];
  const calls = [];
  for (let turn = 0; turn < 20; turn += 1) {
    const reply = await complete(provider, { systemPrompt: "You are Ada.", messages, tools }, { apiKey: "loopback" });
    assert.equal(reply.errorMessage, undefined);
    messages.push(reply);
    const toolCalls = reply.content.filter((part) => part.type === "toolCall");
    if (toolCalls.length === 0) {
      return { calls, reply: reply.content.map((part) => (part.type === "text" ? part.text : "")).join("") };
    }
    for (const call of toolCalls) {
      calls.push({ name: call.name, args: call.arguments });
      const result = await computer.call(call.name, call.arguments);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          { type: "text", text: result.text },
          ...(result.image ? [{ type: "image", data: "/9j/2wBD", mimeType: "image/jpeg" }] : []),
        ],
        isError: false,
        timestamp: 0,
      });
    }
  }
  throw new Error("The acceptance never ended.");
}

const context = { giveBackNote: GIVE_BACK_NOTE, nonce: NONCE };

test("the scripted Bot captures, clicks the capture's centre, waits for Take over, captures again and uses its shell", async () => {
  const model = await loopbackModel();
  try {
    const computer = await guest({ takeOverOnWait: 2 });
    const { calls, reply } = await playBot(model, computer);
    assert.deepEqual(calls, [
      { name: "computer", args: { action: "capture" } },
      { name: "computer", args: { action: "click", coordinate: [640, 400], intent: "Click an empty spot on the desktop" } },
      { name: "computer", args: { action: "wait", seconds: 30 } },
      { name: "computer", args: { action: "wait", seconds: 30 } },
      { name: "computer", args: { action: "capture" } },
      { name: "computer_shell", args: calls[5].args },
    ]);
    assert.equal(reply, ACCEPTANCE_FINAL_TEXT);
    // The shell step really wrote the file into the folder the person's Mac shares.
    const sharedFileText = await readFile(path.join(computer.computerFolder, acceptanceSharedFileName(NONCE)), "utf8");
    assert.equal(sharedFileText, `${NONCE}\n`);

    const verdict = evaluateAcceptanceRequests(model.requests, { ...context, sharedFileText });
    assert.deepEqual(verdict, {
      ok: true,
      failures: [],
      evidence: { captureSize: { width: 1280, height: 800 }, waits: 2, interrupted: "wait", macosVersion: "26.6.2" },
    });
  } finally {
    await model.close();
  }
});

test("without Take over the sequence gives up after its waits and fails", async () => {
  const model = await loopbackModel();
  try {
    const computer = await guest();
    const { calls } = await playBot(model, computer);
    assert.equal(calls.filter((call) => call.args.action === "wait").length, ACCEPTANCE_MAX_WAITS);
    assert.equal(calls.some((call) => call.name === "computer_shell"), false);
    const { ok, failures } = evaluateAcceptanceRequests(model.requests, { ...context, sharedFileText: undefined });
    assert.equal(ok, false);
    assert.ok(failures.includes("No call was interrupted by Take over and returned the give-back note after Give back."));
    assert.ok(failures.includes("The acceptance sequence did not reach its end."));
  } finally {
    await model.close();
  }
});

test("a model without image input never sees the screenshot, so the sequence stops at the first capture", async () => {
  const model = await loopbackModel();
  try {
    const { calls } = await playBot(model, await guest({ takeOverOnWait: 1 }), { vision: false });
    assert.deepEqual(calls, [{ name: "computer", args: { action: "capture" } }]);
    const { failures } = evaluateAcceptanceRequests(model.requests, { ...context, sharedFileText: `${NONCE}\n` });
    assert.ok(failures.includes("The first capture did not return a screenshot of the Bot's computer."));
  } finally {
    await model.close();
  }
});

test("a shared file that never reached the Computer folder fails the run", async () => {
  const model = await loopbackModel();
  try {
    await playBot(model, await guest({ takeOverOnWait: 1 }));
    const { ok, failures } = evaluateAcceptanceRequests(model.requests, { ...context, sharedFileText: "something else" });
    assert.equal(ok, false);
    assert.deepEqual(failures, ["The file the Bot wrote to ~/Shared did not reach its Computer folder."]);
  } finally {
    await model.close();
  }
});

test("only the acceptance prompt with the computer tools advances the sequence", async () => {
  const model = await loopbackModel();
  try {
    const title = await playBot(model, await guest(), { prompt: "Name this chat." });
    assert.deepEqual(title.calls, []);
    assert.match(title.reply, /^Send exactly: Run the Bot computers acceptance sequence/u);
    const noTools = acceptanceResponse({ messages: [{ role: "user", content: ACCEPTANCE_PROMPT }] }, context);
    assert.equal(noTools.kind, "other");
    assert.equal(isAcceptanceRequest(model.requests[0]), false);
  } finally {
    await model.close();
  }
});

test("a retried request is answered with the same call", () => {
  const request = {
    tools: [{ type: "function", function: { name: "computer" } }],
    messages: [
      { role: "user", content: ACCEPTANCE_PROMPT },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "aiden-bc-call-0", type: "function", function: { name: "computer", arguments: '{"action":"capture"}' } }],
      },
      { role: "tool", tool_call_id: "aiden-bc-call-0", content: "Screenshot of Ada's computer, 1024×640 pixels." },
      { role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } }] },
    ],
  };
  const first = acceptanceResponse(request, context);
  assert.deepEqual(first.call, {
    name: "computer",
    arguments: { action: "click", coordinate: [512, 320], intent: "Click an empty spot on the desktop" },
  });
  assert.deepEqual(acceptanceResponse(request, context), first);
});

test("the shell step refuses a nonce that could change its command", () => {
  const history = [
    { name: "computer", args: { action: "capture" }, result: { text: SCREENSHOT, images: 1 } },
    { name: "computer", args: { action: "click", coordinate: [640, 400] }, result: { text: GIVE_BACK_NOTE, images: 0 } },
    { name: "computer", args: { action: "capture" }, result: { text: SCREENSHOT, images: 1 } },
  ];
  assert.equal(acceptanceToolCall(history, context).name, "computer_shell");
  assert.throws(() => acceptanceToolCall(history, { ...context, nonce: "x'; rm -rf ~; echo '" }), /32 lowercase hex/u);
  assert.throws(() => acceptanceToolCall([], { nonce: NONCE }), /give-back note/u);
});

const goodTimeline = () => ({
  given: {
    baseBuild: "25G83",
    computers: [{ botId: "bot-1", vmName: "aiden-bot-1" }],
    vms: [
      { name: BASE_VM, state: "stopped" },
      { name: "aiden-bot-1", state: "stopped" },
    ],
  },
  working: { vms: [{ name: BASE_VM, state: "stopped" }, { name: "aiden-bot-1", state: "running" }] },
  paused: { pausedBy: "mac", vmProcesses: 0, vms: [{ name: BASE_VM, state: "stopped" }, { name: "aiden-bot-1", state: "stopped" }] },
  deleted: { computers: [], vms: [{ name: BASE_VM, state: "stopped" }] },
  removed: { vms: [], baseBuild: undefined },
  afterQuit: { lumeProcesses: 0 },
});

test("the computer's life from Give to Remove everything passes only when every step is as the person drove it", () => {
  assert.deepEqual(evaluateComputerTimeline(goodTimeline(), { baseVm: BASE_VM }), { ok: true, failures: [], vmName: "aiden-bot-1" });
  const cases = [
    [(t) => (t.given.vms[1].state = "running"), "Giving the Bot a computer started it."],
    [(t) => (t.given.vms = [t.given.vms[0]]), "Give did not clone a VM for the Bot."],
    [(t) => delete t.given.baseBuild, "Set up did not finish a base."],
    [(t) => (t.working.vms[1].state = "stopped"), "The Bot's capture did not start its computer."],
    [(t) => (t.paused.vms[1].state = "running"), "Pause did not stop the Bot's computer."],
    [(t) => (t.paused.pausedBy = undefined), "The Bot was not paused from this Mac."],
    [(t) => (t.paused.vmProcesses = 1), "The paused computer's Lume process kept running."],
    [(t) => t.deleted.vms.push({ name: "aiden-bot-1", state: "stopped" }), "Deleting the Bot left its VM in Lume."],
    [(t) => (t.deleted.computers = [{ botId: "bot-1", vmName: "aiden-bot-1" }]), "Deleting the Bot left its computer in Aiden's state."],
    [(t) => (t.deleted.vms = []), "Deleting the Bot removed the shared base."],
    [(t) => (t.removed.vms = [{ name: BASE_VM, state: "stopped" }]), "Remove everything left a VM or a base behind."],
    [(t) => (t.afterQuit.lumeProcesses = 1), "A Lume process outlived Aiden's quit."],
  ];
  for (const [mutate, failure] of cases) {
    const timeline = goodTimeline();
    mutate(timeline);
    assert.deepEqual(evaluateComputerTimeline(timeline, { baseVm: BASE_VM }).failures, [failure]);
  }
});

test("a Bot's pause is read from Aiden's pause file", () => {
  const document = { version: 1, bots: { "bot-1": { since: 1_700_000_000_000, by: "mac" } } };
  assert.equal(pausedBy(document, "bot-1"), "mac");
  assert.equal(pausedBy(document, "bot-2"), undefined);
  assert.equal(pausedBy({ version: 1, bots: { "bot-1": { by: "mac" } } }, "bot-1"), undefined);
  assert.equal(pausedBy(null, "bot-1"), undefined);
});

test("the seeded provider is the loopback model, with image input and tool calls", () => {
  const { config } = acceptanceFixture(4123, CAPABILITY);
  assert.equal(config.providers.length, 1);
  const [provider] = config.providers;
  assert.equal(provider.baseUrl, `http://127.0.0.1:4123/${CAPABILITY}/v1`);
  assert.deepEqual(provider.modelMetadata[provider.defaultModel], { source: "provider", vision: true, toolCall: true });
  assert.throws(() => acceptanceFixture(4123, "short"), /256 bits/u);
});
