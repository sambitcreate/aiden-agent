import assert from "node:assert/strict";
import test from "node:test";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createBotComputerControl } from "./control.js";
import { BOT_COMPUTER_SHELL_OUTPUT_BYTES, createBotComputerShellTool } from "./computer-shell-tool.js";
import type { BotComputerConnection, BotComputerGuestCommandResult, BotComputerStartReason } from "./types.js";

const connection: BotComputerConnection = {
  vmName: "aiden-bot-ada",
  ip: "192.168.64.5",
  vnc: { host: "127.0.0.1", port: 5901, password: "vnc-secret-1234" },
  ssh: { host: "192.168.64.5", user: "lume" },
};

interface GuestCall {
  command: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

function harness(
  respond: (call: GuestCall) => Promise<BotComputerGuestCommandResult>,
  options: { routine?: boolean } = {},
) {
  const control = createBotComputerControl();
  const calls: GuestCall[] = [];
  const reasons: BotComputerStartReason[] = [];
  let touches = 0;
  const tool = createBotComputerShellTool(
    "ada",
    {
      host: {
        async ensureRunning(_botId, opts) {
          reasons.push(opts.reason);
          return connection;
        },
        async runGuestCommand(_botId, command, opts) {
          const call = { command, ...opts };
          calls.push(call);
          return respond(call);
        },
        touch() {
          touches += 1;
        },
      },
      control,
      botName: async () => "Ada",
    },
    { routine: options.routine === true },
  );
  const run = (command: string, signal?: AbortSignal) =>
    tool.execute("call", { command, description: "List the home folder" }, signal) as Promise<AgentToolResult<null>>;
  return { control, calls, reasons, touches: () => touches, run };
}

const ok = (stdout: string, extra: Partial<BotComputerGuestCommandResult> = {}): BotComputerGuestCommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  truncated: false,
  timedOut: false,
  ...extra,
});

function textOf(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

test("a command runs in the Bot's computer within 120 seconds and 64 KiB", async () => {
  const h = harness(async () => ok("Desktop\nShared\n", { stderr: "warning: slow disk" }));
  const result = await h.run("ls ~");
  assert.equal(result.isError, undefined);
  assert.equal(textOf(result), "Desktop\nShared\n\nwarning: slow disk");
  assert.equal(h.calls[0]?.command, "ls ~");
  assert.equal(h.calls[0]?.timeoutMs, 120_000);
  assert.equal(h.calls[0]?.maxOutputBytes, 64 * 1024);
  assert.deepEqual(h.reasons, ["tool"]);
  assert.equal(h.touches(), 1);
  assert.equal(textOf(await harness(async () => ok("")).run("true")), "[no output]");
});

test("a timeout, a failure and cut output each say so", async () => {
  const timedOut = await harness(async () => ok("partial", { exitCode: 142, timedOut: true })).run("sleep 999");
  assert.equal(timedOut.isError, true);
  assert.equal(textOf(timedOut), "Command timed out after 120 seconds.\npartial");

  const failed = await harness(async () => ({ ...ok(""), exitCode: 2, stderr: "ls: nope: No such file" })).run("ls nope");
  assert.equal(failed.isError, true);
  assert.equal(textOf(failed), "Command exited with error (code 2).\nls: nope: No such file");

  const cut = await harness(async () => ok("x".repeat(100), { truncated: true })).run("yes | head -c 1000000");
  assert.equal(cut.isError, undefined, "the command itself finished");
  assert.match(textOf(cut), new RegExp(`\\[Output cut at ${BOT_COMPUTER_SHELL_OUTPUT_BYTES / 1024} KiB\\.\\]$`, "u"));
});

test("long output keeps its start and end for the model", async () => {
  const output = `START${"m".repeat(60_000)}END`;
  const result = await harness(async () => ok(output)).run("cat big.log");
  const text = textOf(result);
  assert.ok(text.length <= 20_000, `${text.length} characters`);
  assert.ok(text.startsWith("START") && text.endsWith("END"));
  assert.match(text, /Output truncated/u);
});

test("Take over stops a running command; the call reports it after Give back", async () => {
  const h = harness(
    (call) =>
      new Promise((_, reject) => call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true })),
  );
  let settled = false;
  const pending = h.run("brew install ffmpeg").finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  h.control.takeOver("ada", "viewer");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls[0]?.signal?.aborted, true, "the wait on the guest command ends");
  assert.equal(settled, false, "the turn waits for the person");
  h.control.giveBack("ada");
  const result = await pending;
  assert.equal(result.isError, true);
  // Without a terminal the guest side keeps running, so the Bot must check before a rerun.
  assert.match(textOf(result), /took over the computer.*still be running.*check before running it again/u);
});

test("while the person has the computer a command waits, then runs after Give back", async () => {
  const h = harness(async () => ok("done"));
  h.control.takeOver("ada", "sign_in");
  const pending = h.run("echo done");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 0);
  h.control.giveBack("ada");
  assert.equal(textOf(await pending), "done");
  assert.equal(h.calls.length, 1);
});

test("a routine starts the computer for the routine", async () => {
  const h = harness(async () => ok("ok"), { routine: true });
  await h.run("date");
  assert.deepEqual(h.reasons, ["routine"]);
});
