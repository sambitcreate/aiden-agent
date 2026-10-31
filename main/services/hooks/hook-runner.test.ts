// Runs real shell scripts through the hook runner to check the Claude Code
// exit-code and output protocol end to end.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { interpretHookRun, runHookCommand } from "./hook-runner.js";
import type { HookCommandHandler, HookEvent, HookPayload } from "./hook-types.js";

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiden-hook-runner-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function script(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function payload(event: HookEvent, cwd: string, extra: Partial<HookPayload> = {}): HookPayload {
  return { hook_event_name: event, session_id: "session-1", cwd, ...extra };
}

async function run(event: HookEvent, handler: Omit<HookCommandHandler, "type">, cwd: string, extra: Partial<HookPayload> = {}, baseEnv?: NodeJS.ProcessEnv) {
  const fullHandler: HookCommandHandler = { type: "command", ...handler };
  const raw = await runHookCommand({ hook: { event, handler: fullHandler }, payload: payload(event, cwd, extra), cwd, sessionId: "session-1", baseEnv });
  return { raw, result: interpretHookRun(event, raw, fullHandler) };
}

test("the payload arrives as JSON on stdin", async (t) => {
  const dir = await tempDir(t);
  const hook = await script(dir, "capture.sh", `cat > "${path.join(dir, "stdin.json")}"`);
  const { result } = await run("PreToolUse", { command: hook }, dir, { tool_name: "Bash", tool_input: { command: "ls -la" } });
  assert.equal(result.result, "ok");
  const received = JSON.parse(await fs.readFile(path.join(dir, "stdin.json"), "utf8")) as HookPayload;
  assert.equal(received.hook_event_name, "PreToolUse");
  assert.equal(received.tool_name, "Bash");
  assert.deepEqual(received.tool_input, { command: "ls -la" });
});

test("exit 0 with JSON can allow, deny or ask", async (t) => {
  const dir = await tempDir(t);
  for (const decision of ["allow", "deny", "ask"] as const) {
    const hook = await script(
      dir,
      `${decision}.sh`,
      `cat >/dev/null\necho '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"${decision}","permissionDecisionReason":"because ${decision}"}}'`,
    );
    const { result } = await run("PreToolUse", { command: hook }, dir);
    assert.equal(result.decision, decision);
    assert.equal(result.reason, `because ${decision}`);
  }
});

test("exit 2 blocks with stderr as the reason", async (t) => {
  const dir = await tempDir(t);
  const hook = await script(dir, "block.sh", `cat >/dev/null\necho "rm -rf is not allowed here" >&2\nexit 2`);
  const pre = await run("PreToolUse", { command: hook }, dir);
  assert.equal(pre.result.decision, "deny");
  assert.equal(pre.result.reason, "rm -rf is not allowed here");
  const stop = await run("Stop", { command: hook }, dir);
  assert.equal(stop.result.block, true);
  assert.equal(stop.result.reason, "rm -rf is not allowed here");
});

test("any other exit code fails open unless the hook is set to fail closed", async (t) => {
  const dir = await tempDir(t);
  const hook = await script(dir, "crash.sh", `cat >/dev/null\necho oops >&2\nexit 1`);
  const open = await run("PreToolUse", { command: hook }, dir);
  assert.equal(open.result.result, "error");
  assert.equal(open.result.decision, undefined, "a crash does not block by default");
  const closed = await run("PreToolUse", { command: hook, failClosed: true }, dir);
  assert.equal(closed.result.decision, "deny");
});

test("a timeout on a fail-closed hook blocks the tool", async (t) => {
  const dir = await tempDir(t);
  const hook = await script(dir, "slow.sh", `sleep 5`);
  const started = Date.now();
  const { raw, result } = await run("PreToolUse", { command: hook, timeout: 0.3, failClosed: true }, dir);
  assert.equal(raw.timedOut, true);
  assert.ok(Date.now() - started < 4_000, "the hook was stopped at its timeout");
  assert.equal(result.result, "error");
  assert.equal(result.decision, "deny");
});

test("the hook gets a minimal environment plus Aiden's variables and its allowlist", async (t) => {
  const dir = await tempDir(t);
  const hook = await script(dir, "env.sh", `cat >/dev/null\nenv`);
  const baseEnv = { ...process.env, AIDEN_TEST_PLANTED_SECRET: "planted-secret-value", AIDEN_TEST_ALLOWED: "allowed-value" };
  const { raw } = await run("PreToolUse", { command: hook, envAllow: ["AIDEN_TEST_ALLOWED"] }, dir, { tool_input: { path: "src/a.ts" } }, baseEnv);
  assert.doesNotMatch(raw.stdout, /planted-secret-value/u);
  assert.match(raw.stdout, /^AIDEN_TEST_ALLOWED=allowed-value$/mu);
  assert.match(raw.stdout, /^AIDEN_HOOK_EVENT=PreToolUse$/mu);
  assert.match(raw.stdout, /^AIDEN_SESSION_ID=session-1$/mu);
  assert.ok(raw.stdout.includes(`AIDEN_PROJECT_DIR=${dir}\n`));
  assert.ok(raw.stdout.includes(`CLAUDE_PROJECT_DIR=${dir}\n`));
  assert.ok(raw.stdout.includes(`AIDEN_HOOK_FILE=${path.join(dir, "src/a.ts")}\n`));
});

test("plain stdout becomes context only for events that take it", async (t) => {
  const dir = await tempDir(t);
  const hook = await script(dir, "say.sh", `cat >/dev/null\necho "Branch: main, 3 files changed"`);
  assert.equal((await run("SessionStart", { command: hook }, dir)).result.additionalContext, "Branch: main, 3 files changed");
  assert.equal((await run("PostToolUse", { command: hook }, dir)).result.additionalContext, undefined);
});

test("continue false asks Aiden to stop the turn", async (t) => {
  const dir = await tempDir(t);
  const hook = await script(dir, "halt.sh", `cat >/dev/null\necho '{"continue":false,"stopReason":"Spending limit reached","systemMessage":"Stopped by budget hook"}'`);
  const { result } = await run("PostToolUse", { command: hook }, dir);
  assert.equal(result.stopTurn, true);
  assert.equal(result.stopReason, "Spending limit reached");
  assert.equal(result.systemMessage, "Stopped by budget hook");
});

test("a hook that ignores its stdin still finishes cleanly", async (t) => {
  const dir = await tempDir(t);
  const { result } = await run("PreToolUse", { command: "true" }, dir, { tool_input: { content: "x".repeat(512 * 1024) } });
  assert.equal(result.result, "ok");
});
