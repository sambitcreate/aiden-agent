import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

import { createDeviceAgentTools } from "../devices/device-tools.js";
import { createTodoExtensionRuntime } from "../rpiv-todo/extension.js";
import { buildChildEnvironment } from "./environment.js";
import { redactSecrets } from "./errors.js";
import { AcpMcpBridge, sanitizeSchema } from "./mcp-bridge.js";
import { AcpPidLedger } from "./pid-ledger.js";
import { AcpProcess } from "./process.js";
import { AcpSessionStore } from "./session-store.js";
import { tempDir } from "./test-support.js";

test("child environment keeps PATH but strips credentials, Electron switches and Aiden state", () => {
  const env = buildChildEnvironment(
    { strip: ["GEMINI_API_KEY"], set: { GEMINI_HOME: "/state" } },
    {
      PATH: "/usr/bin",
      HOME: "/home/me",
      gemini_api_key: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect",
      AIDEN_TOKEN: "x",
      GEMINI_HOME: "/wrong",
    },
    "linux",
  );
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/me");
  assert.equal(env.GEMINI_HOME, "/state");
  for (const name of ["gemini_api_key", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "AIDEN_TOKEN"]) {
    assert.equal(env[name], undefined, name);
  }
});

test("redaction removes tokens, keys and OAuth parameters", () => {
  const redacted = redactSecrets(
    "Bearer abcdefghijklmnop ya29.a0AbC AIzaSyD-abcdefghijklmnopqrstu https://x/?code=4/abc&state=xyz refresh_token\":\"1//0gAbCdEfGhIjKlMnOpQrStUv",
  );
  assert.doesNotMatch(redacted, /abcdefghijklmnop|ya29\.a0|AIzaSyD|4\/abc|state=xyz|1\/\/0gAb/u);
});

test("the process wrapper keeps protocol lines, drops stdout noise, and reports stderr lines", async () => {
  const lines: string[] = [];
  const noise: string[] = [];
  const child = new AcpProcess({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('Opening in existing browser session.\\n{\"jsonrpc\":\"2.0\"}\\n');process.stderr.write('first\\nsecond');",
    ],
    cwd: tempDir(),
    env: { PATH: process.env.PATH ?? "" },
    onStderrLine: (line) => lines.push(line),
    onStdoutNoise: (line) => noise.push(line),
  });
  const reader = child.input.getReader();
  const chunks: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value).toString("utf8"));
  }
  const exit = await child.exited;
  assert.equal(chunks.join(""), '{"jsonrpc":"2.0"}\n');
  assert.deepEqual(noise, ["Opening in existing browser session."]);
  assert.deepEqual(lines, ["first", "second"]);
  assert.equal(exit.code, 0);
  assert.equal(child.ignoredStdoutLines, 1);
});

test("an oversized protocol line fails the input stream and closes the agent without an uncaught error", async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    // A fake agent without a pid, so closing it signals only this object.
    const fake = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      signals: [] as NodeJS.Signals[],
      kill(signal: NodeJS.Signals) {
        fake.signals.push(signal);
        // The agent writes the rest of its line, then dies on TERM.
        setImmediate(() => {
          fake.stdout.write('"}\n{"jsonrpc":"2.0","id":2}\n');
          fake.stdout.end();
          fake.signalCode = signal;
          setImmediate(() => fake.emit("exit", null, signal));
        });
        return true;
      },
    });
    const child = new AcpProcess({
      command: "agent",
      args: [],
      cwd: tempDir(),
      env: {},
      platform: "linux",
      spawnImpl: (() => fake) as never,
    });
    const reader = child.input.getReader();
    const read = reader.read();
    fake.stdout.write(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'), Buffer.alloc(17 * 1024 * 1024, 0x61)]));
    await assert.rejects(read, /oversized protocol line/u);
    const exit = await child.exited;
    assert.equal(exit.signal, "SIGTERM");
    assert.deepEqual(fake.signals, ["SIGTERM"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

test("closing a process stops its whole group, including children that ignore TERM", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, "grandchild.pid");
  const child = new AcpProcess({
    command: process.execPath,
    args: [
      "-e",
      `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
    ],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
  });
  const { readFileSync, existsSync } = await import("node:fs");
  for (let attempt = 0; attempt < 50 && !existsSync(pidFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  await child.close();
  assert.equal(child.alive, false);
  // A killed process can linger briefly as a zombie until it is reaped; it
  // no longer runs, so treat that state as stopped.
  const stopped = () => {
    try {
      process.kill(grandchild, 0);
    } catch {
      return true;
    }
    try {
      return execFileSync("ps", ["-o", "stat=", "-p", String(grandchild)], { encoding: "utf8" }).trim().startsWith("Z");
    } catch {
      return true;
    }
  };
  for (let attempt = 0; attempt < 150 && !stopped(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(stopped(), "the grandchild that ignored TERM was killed with its group");
});

test("an agent still running when Aiden exits is killed with the app", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const script = path.join(dir, "app.mts");
  const processModule = new URL("./process.ts", import.meta.url).href;
  // The app starts an agent that ignores TERM and exits before any async teardown runs.
  writeFileSync(
    script,
    `import { AcpProcess } from ${JSON.stringify(processModule)};
const agent = new AcpProcess({
  command: process.execPath,
  args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  cwd: ${JSON.stringify(dir)},
  env: { PATH: process.env.PATH ?? "" },
});
process.stdout.write(String(agent.pid));
setTimeout(() => process.exit(0), 200);
`,
  );
  const agentPid = Number(
    execFileSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 30_000 }).trim(),
  );
  assert.ok(Number.isSafeInteger(agentPid) && agentPid > 1);
  const running = () => {
    try {
      process.kill(agentPid, 0);
    } catch {
      return false;
    }
    try {
      return !execFileSync("ps", ["-o", "stat=", "-p", String(agentPid)], { encoding: "utf8" }).trim().startsWith("Z");
    } catch {
      return false;
    }
  };
  try {
    for (let attempt = 0; attempt < 100 && running(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(running(), false, "the agent did not outlive the app");
  } finally {
    try {
      process.kill(agentPid, "SIGKILL");
    } catch {
      // Already stopped.
    }
  }
});

function fakeLedgerSystem(processes: Record<number, { group: number; command: string; env?: string[] }>) {
  const killed: number[] = [];
  const alive = new Set(Object.keys(processes).map(Number));
  const dependencies = {
    isAlive: (pid: number) => alive.has(pid),
    commandOf: async (pid: number) => (alive.has(pid) ? processes[pid]!.command : undefined),
    killGroup: (pgid: number) => {
      killed.push(pgid);
      for (const pid of [...alive]) if (processes[pid]!.group === pgid && !processes[pid]!.env?.includes("IGNORES_KILL=1")) alive.delete(pid);
    },
    groupExists: (pgid: number) => [...alive].some((pid) => processes[pid]!.group === pgid),
    groupMembers: async (pgid: number) => [...alive].filter((pid) => processes[pid]!.group === pgid),
    hasEnvironment: async (pid: number, entry: string) => alive.has(pid) && !!processes[pid]!.env?.includes(entry),
  };
  return { dependencies, killed };
}

const MARKER_A = "a".repeat(32);
const MARKER_B = "b".repeat(32);

test("the pid ledger only stops survivors still running the recorded binary", async () => {
  const file = path.join(tempDir(), "processes.json");
  const { dependencies, killed } = fakeLedgerSystem({
    10: { group: 10, command: "/runtime/agy_acp_server.par --uid=" },
    20: { group: 20, command: "/usr/bin/unrelated" },
  });
  const ledger = new AcpPidLedger(file, dependencies);
  ledger.record(10, "/runtime/agy_acp_server.par");
  ledger.record(20, "/runtime/agy_acp_server.par");
  ledger.record(30, "/runtime/agy_acp_server.par");
  ledger.release(30);
  ledger.record(30, "/runtime/agy_acp_server.par");
  await ledger.flush();

  const reopened = new AcpPidLedger(file, dependencies);
  assert.equal(await reopened.sweep(), 1);
  assert.deepEqual(killed, [10]);
  assert.deepEqual(reopened.snapshot(), []);
});

test("the pid ledger stops tools an agent left behind when the agent itself is gone", async () => {
  const file = path.join(tempDir(), "processes.json");
  const { dependencies, killed } = fakeLedgerSystem({
    // The agent (pid 10) died with Aiden; its shell tool and a dev server kept running.
    11: { group: 10, command: "/bin/zsh -c npm run dev" },
    12: { group: 10, command: "node server.js", env: [`AIDEN_ACP_RUN=${MARKER_A}`] },
    // The agent's own helper, recognised by its runtime directory.
    21: { group: 20, command: "/runtime/helpers/indexer --watch" },
    // Group 30 ended and its id now belongs to an unrelated program's children.
    31: { group: 30, command: "/usr/libexec/unrelated-worker", env: [`AIDEN_ACP_RUN=${MARKER_B}`] },
  });
  const ledger = new AcpPidLedger(file, dependencies);
  ledger.record(10, "/runtime/agy_acp_server.par", MARKER_A);
  ledger.record(20, "/runtime/agy_acp_server.par");
  ledger.record(30, "/runtime/agy_acp_server.par", MARKER_A);
  await ledger.flush();

  const reopened = new AcpPidLedger(file, dependencies);
  assert.equal(await reopened.sweep(), 2);
  assert.deepEqual(killed, [10, 20]);
  assert.equal(dependencies.groupExists(10), false, "the tools went with their group");
  assert.equal(dependencies.groupExists(30), true, "a recycled group id is left alone");
  assert.deepEqual(reopened.snapshot(), []);
});

test("the pid ledger keeps a group that outlived the kill for the next sweep", async () => {
  const file = path.join(tempDir(), "processes.json");
  const { dependencies } = fakeLedgerSystem({
    11: { group: 10, command: "node server.js", env: [`AIDEN_ACP_RUN=${MARKER_A}`, "IGNORES_KILL=1"] },
  });
  const ledger = new AcpPidLedger(file, dependencies);
  ledger.record(10, "/runtime/agy_acp_server.par", MARKER_A);
  await ledger.flush();
  const reopened = new AcpPidLedger(file, dependencies);
  assert.equal(await reopened.sweep(), 1);
  assert.deepEqual(reopened.snapshot().map((entry) => entry.pid), [10]);
  assert.equal(new AcpPidLedger(file, dependencies).snapshot()[0]?.marker, MARKER_A);
});

test("a crash sweep stops a real tool process whose agent already exited", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const pidFile = path.join(dir, "tool.pid");
  const marker = "c".repeat(32);
  const { spawn } = await import("node:child_process");
  const { existsSync, readFileSync } = await import("node:fs");
  // The agent starts a long-running tool in its own group, then exits as if
  // Aiden had crashed underneath it.
  const agent = spawn(
    process.execPath,
    [
      "-e",
      `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.exit(0);`,
    ],
    { detached: true, stdio: "ignore", env: { PATH: process.env.PATH ?? "", AIDEN_ACP_RUN: marker } },
  );
  const agentPid = agent.pid!;
  await new Promise((resolve) => agent.once("exit", resolve));
  for (let attempt = 0; attempt < 50 && !existsSync(pidFile); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const tool = Number(readFileSync(pidFile, "utf8"));
  const running = () => {
    try {
      process.kill(tool, 0);
    } catch {
      return false;
    }
    try {
      return !execFileSync("ps", ["-o", "stat=", "-p", String(tool)], { encoding: "utf8" }).trim().startsWith("Z");
    } catch {
      return false;
    }
  };
  try {
    assert.ok(running(), "the tool outlived its agent");
    const file = path.join(dir, "processes.json");
    const ledger = new AcpPidLedger(file);
    ledger.record(agentPid, "/nonexistent/runtime/agent", marker);
    await ledger.flush();
    assert.equal(await new AcpPidLedger(file).sweep(), 1);
    for (let attempt = 0; attempt < 100 && running(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(running(), false, "the orphaned tool was stopped with its group");
  } finally {
    try {
      process.kill(tool, "SIGKILL");
    } catch {
      // Already stopped.
    }
  }
});

test("session records persist, expire, and ignore corrupt files", async () => {
  const dir = tempDir();
  const file = path.join(dir, "sessions.json");
  let now = 1_000;
  const store = new AcpSessionStore(file, () => now);
  store.save({ chatId: "c", sessionId: "s", cwd: "/w", messageCount: 2, historyFingerprint: "f" });
  await store.flush();
  assert.equal(new AcpSessionStore(file, () => now).get("c")?.sessionId, "s");
  now += 31 * 24 * 60 * 60 * 1000;
  assert.equal(new AcpSessionStore(file, () => now).get("c"), undefined);
  writeFileSync(file, "{not json");
  assert.equal(new AcpSessionStore(file).get("c"), undefined);
});

test("schema sanitizing keeps the callable subset and drops unknown keywords", () => {
  const schema = sanitizeSchema({
    type: "object",
    properties: { name: { type: "string", minLength: 1, $id: "x", patternProperties: {} } },
    required: ["name"],
    $schema: "draft",
  });
  assert.deepEqual(schema, {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", minLength: 1 } },
  });
});

type JsonSchema = Record<string, any>;

/** The values a sanitized schema lets the agent choose: each variant's enum, flattened. */
const advertisedValues = (schema: JsonSchema | undefined): unknown[] =>
  (schema?.anyOf ?? [schema]).flatMap((variant: JsonSchema | undefined) => variant?.enum ?? []);

/** Every object node of a schema, so each one's `required` can be checked against its `properties`. */
function objectNodes(schema: unknown, found: JsonSchema[] = []): JsonSchema[] {
  if (!schema || typeof schema !== "object") return found;
  const node = schema as JsonSchema;
  if (node.properties) found.push(node);
  for (const child of [
    ...Object.values(node.properties ?? {}),
    node.items,
    node.additionalProperties,
    ...(node.anyOf ?? []),
    ...(node.oneOf ?? []),
    ...(node.allOf ?? []),
  ]) {
    objectNodes(child, found);
  }
  return found;
}

test("schema sanitizing keeps literal values, so bridged tools advertise the arguments they accept", () => {
  const todo = createTodoExtensionRuntime({ tasks: [], nextId: 1 }).extension.tools![0]!;
  const original = todo.parameters as JsonSchema;
  const sanitized = sanitizeSchema(todo.parameters)!;
  for (const property of ["action", "status"]) {
    const literals = original.properties[property].anyOf.map((variant: JsonSchema) => variant.const);
    assert.deepEqual(advertisedValues((sanitized.properties as JsonSchema)[property]), literals, property);
  }
  for (const action of advertisedValues((sanitized.properties as JsonSchema).action)) {
    assert.equal(Value.Check(todo.parameters, { action }), true, `${String(action)} is accepted`);
  }

  const deviceOpen = createDeviceAgentTools({
    chatId: "chat-1",
    signal: new AbortController().signal,
    supportsImages: true,
    port: {} as never,
  }).find((tool) => tool.name === "device_open")!;
  const platforms = advertisedValues((sanitizeSchema(deviceOpen.parameters)!.properties as JsonSchema).platform);
  assert.deepEqual(platforms, ["ios", "android"]);
  for (const platform of platforms) assert.equal(Value.Check(deviceOpen.parameters, { platform }), true);

  // Object variants told apart only by a literal `kind` keep it.
  const target = sanitizeSchema(
    Type.Union([
      Type.Object({ kind: Type.Literal("url"), url: Type.String() }),
      Type.Object({ kind: Type.Literal("environment-port"), port: Type.Integer() }),
    ]),
  )!;
  assert.deepEqual(
    (target.anyOf as JsonSchema[]).map((variant) => variant.properties.kind.enum),
    [["url"], ["environment-port"]],
  );
});

test("schema sanitizing never requires a property it does not describe", () => {
  const sanitized = sanitizeSchema(Type.Object({ payload: Type.Unknown(), name: Type.String() }))!;
  const todo = createTodoExtensionRuntime({ tasks: [], nextId: 1 }).extension.tools![0]!;
  for (const node of [...objectNodes(sanitized), ...objectNodes(sanitizeSchema(todo.parameters))]) {
    for (const name of (node.required ?? []) as string[]) {
      assert.ok(Object.prototype.hasOwnProperty.call(node.properties, name), `${name} is required and described`);
    }
  }
  assert.deepEqual((sanitized.required as string[]).sort(), ["name", "payload"]);
});

test("the tool bridge requires its bearer token and validates arguments against the original schema", async () => {
  const calls: unknown[] = [];
  const bridge = new AcpMcpBridge({
    tools: [{ name: "lookup", description: "d", parameters: Type.Object({ value: Type.String() }) }],
    onCall: async (invocation) => {
      calls.push(invocation);
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const descriptor = await bridge.start();
  assert.equal((descriptor as { type?: string }).type, "http");
  const url = (descriptor as { url: string }).url;
  const auth = (descriptor as { headers: Array<{ value: string }> }).headers[0]!.value;
  const unauthenticated = await fetch(url, { method: "POST", body: "{}" });
  assert.equal(unauthenticated.status, 401);

  const call = async (args: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "aiden_lookup", arguments: args } }),
    });
    return response.text();
  };
  assert.match(await call({ value: 3 }), /do not match/u);
  assert.equal(calls.length, 0);
  assert.match(await call({ value: "x" }), /"ok"/u);
  assert.equal(calls.length, 1);
  bridge.setTools([]);
  assert.match(await call({ value: "x" }), /not available/u);
  await bridge.close();
});
