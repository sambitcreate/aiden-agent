import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createBotComputerControl } from "./control.js";
import {
  BOT_COMPUTER_SHELL_OUTPUT_BYTES,
  BOT_COMPUTER_SHELL_TOOL_DESCRIPTION,
  botComputerShellCommand,
  botComputerShellToolDescription,
  createBotComputerShellTool,
} from "./computer-shell-tool.js";
import {
  BOT_COMPUTER_LINUX_SHELL_USER,
  BotComputerError,
  type BotComputerConnection,
  type BotComputerGuestCommandResult,
  type BotComputerStartReason,
} from "./types.js";

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
  options: { routine?: boolean; unattended?: boolean; unattendedWaitMs?: number } = {},
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
      ...(options.unattendedWaitMs === undefined ? {} : { unattendedWaitMs: options.unattendedWaitMs }),
    },
    {
      routine: options.routine === true,
      ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
    },
  );
  const run = (command: string, signal?: AbortSignal) =>
    tool.execute("call", { command, description: "List the home folder" }, signal) as Promise<AgentToolResult<null>>;
  return { tool, control, calls, reasons, touches: () => touches, run };
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
  assert.equal(h.calls[0]?.command, botComputerShellCommand("ls ~", BOT_COMPUTER_LINUX_SHELL_USER, { botDir: "ada" }));
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

test("on a routine or Telegram turn, a command waits for the person only so long", async () => {
  for (const turn of [{ routine: true }, { unattended: true }]) {
    const h = harness(async () => ok("done"), { ...turn, unattendedWaitMs: 40 });
    h.control.takeOver("ada", "viewer");
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      h.run("echo done"),
      new Promise<"still waiting">((resolve) => {
        timer = setTimeout(() => resolve("still waiting"), 2_000);
      }),
    ]);
    clearTimeout(timer);
    assert.notEqual(result, "still waiting", JSON.stringify(turn));
    if (result === "still waiting") continue;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /still using Ada's computer.*say in your reply/u);
    assert.equal(h.calls.length, 0, "the command never ran");

    // Taken over in the middle of a command: the call says it may still be running, and gives up too.
    const running = harness(
      (call) => new Promise((_, reject) => call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true })),
      { ...turn, unattendedWaitMs: 40 },
    );
    const pending = running.run("brew install ffmpeg");
    await new Promise((resolve) => setImmediate(resolve));
    running.control.takeOver("ada", "input");
    const interrupted = await Promise.race([
      pending,
      new Promise<"still waiting">((resolve) => {
        timer = setTimeout(() => resolve("still waiting"), 2_000);
      }),
    ]);
    clearTimeout(timer);
    assert.notEqual(interrupted, "still waiting", `${JSON.stringify(turn)}: a command the person interrupted`);
    if (interrupted === "still waiting") continue;
    assert.equal(interrupted.isError, true);
    assert.match(textOf(interrupted), /still be running.*still using Ada's computer/su);
  }
});

test("Linux computer_shell runs commands as the separate aiden-bot user and describes Linux", async () => {
  const linuxDesc = botComputerShellToolDescription();
  assert.equal(linuxDesc, BOT_COMPUTER_SHELL_TOOL_DESCRIPTION);
  assert.match(linuxDesc, /Linux virtual machine/u);
  assert.match(linuxDesc, new RegExp(`separate ${BOT_COMPUTER_LINUX_SHELL_USER} user`, "u"));
  assert.match(linuxDesc, /~\/Shared/u);
  assert.doesNotMatch(linuxDesc, /macOS|\/Volumes\/My Shared Files/u);

  const h = harness(async () => ok("aiden-bot\n"));
  assert.equal(h.tool.description, linuxDesc);
  const tricky = "printf '%s\\n' 'a'\"b\" && false || echo ok";
  const result = await h.run(tricky);
  assert.equal(result.isError, undefined);
  assert.equal(h.calls[0]?.command, botComputerShellCommand(tricky, BOT_COMPUTER_LINUX_SHELL_USER, { botDir: "ada" }));
  assert.match(h.calls[0]!.command, /^cd \/ && exec \/usr\/bin\/sudo -n -H -u 'aiden-bot' -- \/bin\/sh -c /u);

  // Quoting keeps shell metacharacters intact inside the inner /bin/sh -c argument.
  const inspectArgv = h.calls[0]!.command.replace(/^cd \/ && exec \/usr\/bin\/sudo /u, "printf '%s\\0' ");
  const argv = execFileSync("/bin/sh", ["-c", inspectArgv], { encoding: "utf8" }).split("\0").slice(0, -1);
  assert.deepEqual(argv.slice(0, 6), ["-n", "-H", "-u", BOT_COMPUTER_LINUX_SHELL_USER, "--", "/bin/sh"]);
  assert.equal(argv[6], "-c");
  assert.equal(argv[7], `d="$HOME/bots/ada"; mkdir -p "$d" 2>/dev/null; cd "$d" 2>/dev/null || cd "$HOME" || exit 1\n${tricky}`);

  // Reject invalid usernames and unsafe workspace directory names fail-closed.
  assert.throws(() => botComputerShellCommand("id", "aiden-bot; id"), /invalid/iu);
  assert.throws(() => botComputerShellCommand("id", BOT_COMPUTER_LINUX_SHELL_USER, { botDir: "../escape" }), /invalid/iu);
  assert.throws(() => botComputerShellCommand("id", BOT_COMPUTER_LINUX_SHELL_USER, { botDir: "a;rm -rf /" }), /invalid/iu);
});

test("computer_shell acquires and releases the host FIFO lease around command execution", async () => {
  const control = createBotComputerControl();
  const events: string[] = [];
  const tool = createBotComputerShellTool(
    "ada",
    {
      host: {
        async acquireLease(botId) {
          events.push(`acquire:${botId}`);
          return () => events.push(`release:${botId}`);
        },
        async ensureRunning() {
          events.push("ensureRunning");
          return connection;
        },
        async runGuestCommand() {
          events.push("runGuestCommand");
          return ok("done");
        },
        touch() {
          events.push("touch");
        },
      },
      control,
      botName: async () => "Ada",
    },
    { routine: false },
  );
  const result = (await tool.execute("call-1", { command: "pwd" })) as AgentToolResult<null>;
  assert.equal(textOf(result), "done");
  assert.deepEqual(events, ["acquire:ada", "ensureRunning", "runGuestCommand", "release:ada", "touch"]);
});

test("waiting for human Give back releases the FIFO lease so unattended Bots time out cleanly, and reassignment cancels the wait", async () => {
  const control = createBotComputerControl();
  control.setScopeResolver(
    (botId) => (botId === "ada" || botId === "ben" ? "shared" : botId),
    (scope) => (scope === "shared" ? ["ada", "ben"] : []),
  );
  // Real single-slot FIFO lease on the shared VM.
  let active: string | undefined;
  const waiters: Array<() => void> = [];
  const acquireLease = async (botId: string) => {
    if (active !== undefined && active !== botId) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active = botId;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = undefined;
      waiters.shift()?.();
    };
  };
  let ranCommands = 0;
  const host = {
    acquireLease,
    ensureRunning: async () => connection,
    runGuestCommand: async (_botId: string, _command: string, opts: { signal?: AbortSignal }) => {
      ranCommands += 1;
      return await new Promise<BotComputerGuestCommandResult>((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
      });
    },
    touch: () => undefined,
  };
  const adaTool = createBotComputerShellTool("ada", { host, control, botName: async () => "Ada" }, { routine: false });
  const benTool = createBotComputerShellTool(
    "ben",
    { host, control, botName: async () => "Ben", unattendedWaitMs: 40 },
    { routine: true },
  );

  // Ada starts running, then person takes over mid-command: Ada releases the FIFO lease while waiting.
  const adaRun = adaTool.execute("ada-1", { command: "sleep 30" }) as Promise<AgentToolResult<null>>;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, "ada");
  control.takeOver("ada", "viewer");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, undefined, "FIFO lease released before Ada waits for Give back");

  // Unattended Ben calls while Ada is still waiting for Give back: Ben must time out in ~40ms, not hang.
  // Keep a ref'd timeout on the event loop so waitForBotWithin's unref'd budget timer can fire in isolation.
  let guard: NodeJS.Timeout | undefined;
  const benRace = await Promise.race([
    benTool.execute("ben-1", { command: "echo hi" }) as Promise<AgentToolResult<null>>,
    new Promise<"hung">((resolve) => {
      guard = setTimeout(() => resolve("hung"), 2_000);
    }),
  ]);
  clearTimeout(guard);
  assert.notEqual(benRace, "hung");
  if (benRace === "hung") return;
  assert.equal(benRace.isError, true);
  assert.match(textOf(benRace), /still using Ben's computer/u);

  // Give back lets Ada finish with the takeover message.
  control.giveBack("ada");
  const adaResult = await adaRun;
  assert.equal(adaResult.isError, true);
  assert.match(textOf(adaResult), /took over the computer/u);

  // Reassigning/forgetting Ada while she waits for Give back rejects the wait and never runs the command.
  const beforeCalls = ranCommands;
  control.takeOver("ada", "viewer");
  const reassignedWait = adaTool.execute("ada-2", { command: "echo must-not-run" }) as Promise<AgentToolResult<null>>;
  await new Promise((resolve) => setImmediate(resolve));
  control.forget("ada");
  const reassignedResult = await reassignedWait;
  assert.equal(reassignedResult.isError, true);
  assert.match(textOf(reassignedResult), /changed or removed/u);
  assert.equal(ranCommands, beforeCalls, "command never ran after reassignment");
});

test("computer_shell marks co-tenant captures stale via state.noteVmMutation and aborts when its lease is revoked", async () => {
  const control = createBotComputerControl();
  const mutated: Array<{ vmName: string; botId: string }> = [];
  const leaseAbort = new AbortController();
  let runSignal: AbortSignal | undefined;
  const tool = createBotComputerShellTool(
    "ben",
    {
      host: {
        async acquireLease() {
          return Object.assign(() => undefined, { signal: leaseAbort.signal });
        },
        async ensureRunning() {
          return { ...connection, vmName: "aiden-vm-shared" };
        },
        async runGuestCommand(_botId, command, opts) {
          runSignal = opts.signal;
          if (command.includes("block")) {
            return await new Promise<BotComputerGuestCommandResult>((_resolve, reject) => {
              opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
            });
          }
          return ok("ok");
        },
        touch() {},
      },
      control,
      state: {
        noteVmMutation(vmName, actorBotId) {
          mutated.push({ vmName, botId: actorBotId });
        },
      },
      botName: async () => "Ben",
    },
    { routine: false },
  );

  const ran = (await tool.execute("shell-mutate", { command: "echo hi" })) as AgentToolResult<null>;
  assert.equal(ran.isError, undefined);
  assert.deepEqual(mutated, [{ vmName: "aiden-vm-shared", botId: "ben" }]);

  // Revoking the active lease signal aborts the in-flight command and returns an error tool result.
  const pending = tool.execute("shell-revoke", { command: "block" }) as Promise<AgentToolResult<null>>;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runSignal?.aborted, false);
  leaseAbort.abort(new BotComputerError("cancelled", "The Bot was reassigned to another computer."));
  const revoked = await pending;
  assert.equal(runSignal?.aborted, true);
  assert.equal(revoked.isError, true);
  assert.match(textOf(revoked), /reassigned/u);
});
