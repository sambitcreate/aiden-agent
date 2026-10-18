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

test("the pid ledger only stops survivors still running the recorded binary", async () => {
  const file = path.join(tempDir(), "processes.json");
  const killed: number[] = [];
  const ledger = new AcpPidLedger(file, {
    isAlive: (pid) => pid !== 30,
    commandOf: async (pid) => (pid === 10 ? "/runtime/agy_acp_server.par --uid=" : "/usr/bin/unrelated"),
    killGroup: (pid) => killed.push(pid),
  });
  ledger.record(10, "/runtime/agy_acp_server.par");
  ledger.record(20, "/runtime/agy_acp_server.par");
  ledger.record(30, "/runtime/agy_acp_server.par");
  ledger.release(30);
  ledger.record(30, "/runtime/agy_acp_server.par");
  await ledger.flush();

  const reopened = new AcpPidLedger(file, {
    isAlive: (pid) => pid !== 30,
    commandOf: async (pid) => (pid === 10 ? "/runtime/agy_acp_server.par --uid=" : "/usr/bin/unrelated"),
    killGroup: (pid) => killed.push(pid),
  });
  assert.equal(await reopened.sweep(), 1);
  assert.deepEqual(killed, [10]);
  assert.deepEqual(reopened.snapshot(), []);
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
