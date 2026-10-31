import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BoundedProcessOptions, BoundedProcessResult } from "./bounded-process.js";
import {
  BOT_COMPUTER_HOST_KEY_ALIAS,
  ensureKeyPair,
  guestRemoteCommand,
  guestSshArgs,
  guestSshEnvironment,
  guestSshPaths,
  parsePublicKey,
  runGuestCommand,
  writeKnownHost,
} from "./ssh.js";
import { BotComputerError } from "./types.js";

const root = "/Users/person/Library/Application Support/Aiden Agent/bot-computers";
const paths = guestSshPaths(root);
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfakeHostKeyForAidenBotComputerTests0123456789";

function options(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-o") {
      const [key, ...value] = (args[index + 1] ?? "").split("=");
      result.set(key ?? "", value.join("="));
    }
  }
  return result;
}

test("system ssh ignores user config and agents and trusts only the pinned host key", () => {
  const args = guestSshArgs({ host: "192.168.64.7", user: "lume" }, paths);
  assert.deepEqual(args.slice(0, 2), ["-F", "/dev/null"]);
  assert.equal(args[args.indexOf("-i") + 1], paths.privateKey);
  const set = options(args);
  assert.equal(set.get("UserKnownHostsFile"), `"${paths.knownHosts}"`, "quoted: userData has a space");
  assert.equal(set.get("GlobalKnownHostsFile"), "/dev/null");
  assert.equal(set.get("StrictHostKeyChecking"), "yes");
  assert.equal(set.get("HostKeyAlias"), BOT_COMPUTER_HOST_KEY_ALIAS);
  assert.equal(set.get("BatchMode"), "yes");
  assert.equal(set.get("PasswordAuthentication"), "no");
  assert.equal(set.get("ForwardAgent"), "no");
  assert.equal(set.get("ClearAllForwardings"), "yes");
  assert.equal(set.get("IdentitiesOnly"), "yes");
  assert.deepEqual(args.slice(-2), ["--", "192.168.64.7"]);
  assert.throws(() => guestSshArgs({ host: "evil.example -oProxyCommand=x", user: "lume" }, paths), BotComputerError);
});

test("the ssh environment drops the agent socket", () => {
  const env = guestSshEnvironment({ SSH_AUTH_SOCK: "/tmp/agent", HOME: "/Users/person", LANG: "C", PATH: "/opt/bin" }, path.join(root, "home"));
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.HOME, path.join(root, "home"));
  assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(env.LANG, "C");
});

test("the remote side runs under a perl alarm and survives hostile quoting", () => {
  const command = `echo 'it'"'"'s'; rm -rf "$HOME/x" && printf '%s' "$(id)"`;
  const remote = guestRemoteCommand(command, 2_500);
  assert.match(remote, /^perl -e 'alarm 3; exec @ARGV' \/bin\/sh -c '/u);
  // A POSIX shell (what sshd runs the command with) must hand sh the command unchanged.
  const echoed = execFileSync("/bin/sh", ["-c", remote.replace(/^perl -e '[^']*' \/bin\/sh -c /u, "printf %s ")]).toString();
  assert.equal(echoed, command);
});

test("a guest command passes secrets on stdin, bounds output, and reports the remote alarm as a timeout", async () => {
  const calls: { command: string; args: readonly string[]; options: BoundedProcessOptions }[] = [];
  const run = async (command: string, args: readonly string[], runOptions: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    calls.push({ command, args, options: runOptions });
    // The guest's alarm ends the command once its time is up.
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { exitCode: 142, signal: null, stdout: "partial", stderr: "", truncated: true, timedOut: false };
  };
  const result = await runGuestCommand(
    { host: "192.168.64.7", user: "lume" },
    "sleep 100",
    { timeoutMs: 40, maxOutputBytes: 64, stdin: "secret\n" },
    { paths, env: { PATH: "/usr/bin" }, run },
  );
  assert.deepEqual(result, { exitCode: 142, stdout: "partial", stderr: "", truncated: true, timedOut: true });
  const [call] = calls;
  assert.equal(call?.command, "/usr/bin/ssh");
  assert.equal(call?.options.stdin, "secret\n");
  assert.equal(call?.options.maxStdoutBytes, 64);
  assert.equal(call?.options.overflow, "truncate");
  assert.equal(call?.args.some((arg) => arg.includes("secret")), false);
  await assert.rejects(
    runGuestCommand({ host: "192.168.64.7", user: "lume" }, "true", { timeoutMs: 0, maxOutputBytes: 64 }, { paths, env: {}, run }),
    BotComputerError,
  );
});

test("whether a guest command timed out comes from Aiden's own clock, whatever exit status ssh reports", async () => {
  const target = { host: "192.168.64.7", user: "lume" } as const;
  const ending = (afterMs: number, exitCode: number | null) => async (): Promise<BoundedProcessResult> => {
    await new Promise((resolve) => setTimeout(resolve, afterMs));
    return { exitCode, signal: exitCode === null ? "SIGALRM" : null, stdout: "", stderr: "", truncated: false, timedOut: false };
  };
  const timedOut = async (afterMs: number, exitCode: number | null) =>
    (await runGuestCommand(target, "sleep 100", { timeoutMs: 40, maxOutputBytes: 64 }, { paths, env: {}, run: ending(afterMs, exitCode) })).timedOut;
  // The alarm's SIGALRM can surface as OpenSSH's 255 (the login shell exec'd perl) or as no exit status.
  assert.equal(await timedOut(60, 255), true);
  assert.equal(await timedOut(60, null), true);
  assert.equal(await timedOut(60, 142), true);
  // An ordinary failure within the time is never a timeout, even one whose status happens to be 142.
  assert.equal(await timedOut(0, 255), false);
  assert.equal(await timedOut(0, 142), false);
  assert.equal(await timedOut(0, 1), false);
  // A command that finished well, if late, did not time out.
  assert.equal(await timedOut(60, 0), false);
});

test("the key pair is made once with ssh-keygen and kept owner-only", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p8-keys-"));
  const local = guestSshPaths(dir);
  let made = 0;
  const run = async (command: string, args: readonly string[]): Promise<BoundedProcessResult> => {
    made += 1;
    assert.equal(command, "/usr/bin/ssh-keygen");
    assert.deepEqual(args.slice(0, 5), ["-q", "-t", "ed25519", "-N", ""]);
    const file = args[args.indexOf("-f") + 1] ?? "";
    writeFileSync(file, "PRIVATE", { mode: 0o644 });
    writeFileSync(`${file}.pub`, `${KEY} aiden-bot-computer\n`);
    return { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false };
  };
  assert.equal(await ensureKeyPair(local, { env: {}, run }), KEY);
  assert.equal(await ensureKeyPair(local, { env: {}, run }), KEY);
  assert.equal(made, 1);
  assert.equal(statSync(local.privateKey).mode & 0o777, 0o600);

  await writeKnownHost(local, `${KEY} root@guest`);
  assert.equal(readFileSync(local.knownHosts, "utf8"), `${BOT_COMPUTER_HOST_KEY_ALIAS} ${KEY}\n`);
  assert.equal(statSync(local.knownHosts).mode & 0o777, 0o600);
  assert.throws(() => parsePublicKey("ssh-rsa AAAA"), BotComputerError);
});
