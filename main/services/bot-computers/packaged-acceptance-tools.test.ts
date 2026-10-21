// The packaged acceptance's scripted calls, made to the real `computer` and
// `computer_shell` tools. The acceptance core (scripts/bot-computers-packaged-
// acceptance-core.mjs) writes each call's arguments itself and reads the
// tools' result texts back: a capture's size, "Clicked at (x, y).", the
// give-back note, the shell's output. Its own test plays a hand-written guest;
// here pi-ai's real OpenAI-compatible client carries the turns, each call is
// checked by the agent loop's own TypeBox validation and then run by the
// production tools, so a schema or wording change the core doesn't follow
// fails here instead of on the owner's Mac. Only the screen and the guest
// shell are stand-ins (the shell is a real /bin/sh with a fake sw_vers).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type Context, type Message, type Model, type ToolResultMessage } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { createBotComputerShellTool } from "./computer-shell-tool.js";
import { createBotComputerTool, createBotComputerToolState } from "./computer-tool.js";
import { BOT_COMPUTER_GIVE_BACK_NOTE, createBotComputerControl } from "./control.js";
import type { BotComputerConnection, BotComputerGuestCommandResult, BotComputerScreen } from "./types.js";

interface AcceptanceCore {
  ACCEPTANCE_PROMPT: string;
  ACCEPTANCE_FINAL_TEXT: string;
  acceptanceChatCompletionPath(capability: string): string;
  acceptanceResponse(request: unknown, context: { giveBackNote: string; nonce: string }): { chunks: unknown[] };
  acceptanceSharedFileName(nonce: string): string;
  evaluateAcceptanceRequests(
    requests: unknown[],
    context: { giveBackNote: string; nonce: string; sharedFileText: string | undefined },
  ): { ok: boolean; failures: string[]; evidence: Record<string, unknown> };
}

const core = (await import(path.resolve("scripts/bot-computers-packaged-acceptance-core.mjs"))) as AcceptanceCore;
const run = promisify(execFile);
const BOT = "bot-ada";
const NONCE = "0123456789abcdef0123456789abcdef";
const CAPABILITY = "c".repeat(43);
const context = { giveBackNote: BOT_COMPUTER_GIVE_BACK_NOTE, nonce: NONCE };

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** The loopback model, as the owner-Mac script runs it: every request is recorded and answered by the core. */
async function loopbackModel() {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== core.acceptanceChatCompletionPath(CAPABILITY)) {
      response.writeHead(404).end();
      return;
    }
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      const body: unknown = JSON.parse(text);
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of core.acceptanceResponse(body, context).chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A 2560×1600 screen that scales captures to the width asked for, as the RFB screen does. */
function screen(): BotComputerScreen {
  return {
    async capture({ format, maxWidth }) {
      const scale = Math.min(1, maxWidth / 2560);
      return {
        image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        width: Math.round(2560 * scale),
        height: Math.round(1600 * scale),
        framebufferWidth: 2560,
        framebufferHeight: 1600,
      };
    },
    async pointer() {},
    async key() {},
    async close() {},
  };
}

/** The Bot's two computer tools over a fake screen and a guest home that is a real /bin/sh. */
async function botComputer({ takeOverOnWait }: { takeOverOnWait: number }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-bc-acceptance-tools-"));
  roots.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await Promise.all([mkdir(path.join(home, "Shared"), { recursive: true }), mkdir(bin)]);
  await writeFile(path.join(bin, "sw_vers"), '#!/bin/sh\n[ "$1" = -productVersion ] && echo 26.6.2\n');
  await chmod(path.join(bin, "sw_vers"), 0o755);

  const control = createBotComputerControl();
  const connection: BotComputerConnection = {
    vmName: "aiden-bot-ada",
    ip: "192.168.64.5",
    vnc: { host: "127.0.0.1", port: 5901, password: "vnc-secret-1234" },
    ssh: { host: "192.168.64.5", user: "lume" },
  };
  const host = {
    ensureRunning: async () => connection,
    touch: () => {},
    async runGuestCommand(_botId: string, command: string): Promise<BotComputerGuestCommandResult> {
      const { stdout, stderr } = await run("/bin/sh", ["-c", command], { cwd: home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
      return { exitCode: 0, stdout, stderr, truncated: false, timedOut: false };
    },
  };
  let waits = 0;
  // The operator presses Take over during one wait, and Give back a moment later.
  const sleep = (ms: number, signal: AbortSignal) => {
    if (ms < 30_000) return Promise.resolve();
    waits += 1;
    if (waits !== takeOverOnWait) return Promise.resolve();
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      control.takeOver(BOT, "viewer");
      setTimeout(() => control.giveBack(BOT), 20);
    });
  };
  const botName = async () => "Ada";
  const computer = createBotComputerTool(
    BOT,
    {
      host,
      sessions: { screen: async () => screen(), recordPointer: () => {}, setActivity: () => {} },
      control,
      state: createBotComputerToolState(control),
      botName,
      sleep,
    },
    { routine: false },
  );
  const shell = createBotComputerShellTool(BOT, { host, control, botName }, { routine: false });
  return { tools: [computer, shell] as AgentTool[], sharedFolder: path.join(home, "Shared") };
}

/** The Bot's turn loop: pi-ai's OpenAI-compatible client, the agent loop's argument check, then the real tool. */
async function playBot(port: number, tools: AgentTool[]) {
  const model: Model<"openai-completions"> = {
    id: "aiden-bot-computers-acceptance",
    name: "aiden-bot-computers-acceptance",
    api: "openai-completions",
    provider: "bot-computers-acceptance",
    baseUrl: `http://127.0.0.1:${port}/${CAPABILITY}/v1`,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
  const messages: Message[] = [{ role: "user", content: core.ACCEPTANCE_PROMPT, timestamp: 0 }];
  const llmContext: Context = { systemPrompt: "You are Ada.", messages, tools };
  const calls: Array<{ name: string; isError: boolean }> = [];
  for (let turn = 0; turn < 20; turn += 1) {
    const reply = await complete(model, llmContext, { apiKey: "loopback" });
    assert.equal(reply.errorMessage, undefined);
    messages.push(reply);
    const toolCalls = reply.content.filter((part) => part.type === "toolCall");
    if (toolCalls.length === 0) return { calls, reply: reply.content.map((part) => (part.type === "text" ? part.text : "")).join("") };
    for (const call of toolCalls) {
      const tool = tools.find((candidate) => candidate.name === call.name);
      assert.ok(tool, `the acceptance called a tool the Bot has: ${call.name}`);
      // Throws when the arguments don't match the tool's schema, as the agent loop would.
      const args: unknown = validateToolArguments(tool, call);
      const result = await tool.execute(call.id, args as never);
      calls.push({ name: call.name, isError: result.isError === true });
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError === true,
        timestamp: 0,
      };
      messages.push(toolResult);
    }
  }
  throw new Error("The acceptance never ended.");
}

test("the packaged acceptance's calls are valid for the real computer tools, and it reads their results as they are written", async () => {
  const model = await loopbackModel();
  try {
    const computer = await botComputer({ takeOverOnWait: 2 });
    const { calls, reply } = await playBot(model.port, computer.tools);
    assert.equal(reply, core.ACCEPTANCE_FINAL_TEXT);
    assert.deepEqual(
      calls.filter((call) => call.isError),
      [],
      "no call came back as an error",
    );
    const sharedFileText = await readFile(path.join(computer.sharedFolder, core.acceptanceSharedFileName(NONCE)), "utf8");
    assert.deepEqual(core.evaluateAcceptanceRequests(model.requests, { ...context, sharedFileText }), {
      ok: true,
      failures: [],
      evidence: { captureSize: { width: 1280, height: 800 }, waits: 2, interrupted: "wait", macosVersion: "26.6.2" },
    });
  } finally {
    await model.close();
  }
});
