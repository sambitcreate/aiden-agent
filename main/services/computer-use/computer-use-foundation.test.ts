import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import { createConnection } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codesignVerifyArguments, resolveCuaDriverInstallation } from "./binary.js";
import {
  CUA_DRIVER_ALLOWED_TOOLS,
  CuaDriverError,
  buildCuaDriverEnvironment,
  cuaDriverToolDeclaresSession,
  parseCuaDriverTools,
} from "./contract.js";
import {
  TestCuaDriverHost,
  type CuaDriverHostTestHooks,
} from "./host.testing.js";
import { CuaDriverHost, type CuaDriverHostOptions } from "./host.js";
import { runCuaDriverCommand } from "./process.js";
import {
  CUA_DRIVER_MAX_CLIENT_MESSAGE_BYTES,
  CUA_DRIVER_MAX_SERVER_MESSAGE_BYTES,
  AuthenticatedBridgeTransport,
  CuaDriverSession,
} from "./session.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-cua-driver.mjs", import.meta.url));
const SESSION_LESS_TOOLS = new Set([
  "health_report",
  "check_permissions",
  "list_apps",
  "list_windows",
  "get_screen_size",
  "get_accessibility_tree",
  "bring_to_front",
]);

function fragmentedImageBridge(imageBytes: number, fragmentBytes: number): {
  bridge: ChildProcess;
  destroy: () => void;
  fragmentWrites: () => number;
  imageData: string;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const imageData = "a".repeat(imageBytes);
  let requestInput = "";
  let writes = 0;
  const bridge = Object.assign(new EventEmitter(), {
    connected: false,
    exitCode: null,
    kill: () => false,
    pid: undefined,
    signalCode: null,
    stderr: diagnostics,
    stdin: input,
    stdio: [input, output, diagnostics, null, null],
    stdout: output,
  }) as unknown as ChildProcess;
  const tools = [...CUA_DRIVER_ALLOWED_TOOLS].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: SESSION_LESS_TOOLS.has(name) ? {} : { session: { type: "string" } },
    },
    capabilities: [],
  }));
  const send = (message: Record<string, unknown>, fragmented = false) => {
    const payload = `${JSON.stringify(message)}\n`;
    if (!fragmented) {
      output.write(payload);
      return;
    }
    for (let offset = 0; offset < payload.length; offset += fragmentBytes) {
      writes += 1;
      output.write(payload.slice(offset, offset + fragmentBytes));
    }
  };
  input.on("data", (chunk: Buffer) => {
    requestInput += chunk.toString("utf8");
    while (true) {
      const newline = requestInput.indexOf("\n");
      if (newline < 0) return;
      const line = requestInput.slice(0, newline);
      requestInput = requestInput.slice(newline + 1);
      const message = JSON.parse(line) as {
        id?: number | string | null;
        method?: string;
        params?: { name?: string; protocolVersion?: string };
      };
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: {
            protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fragmented-image-bridge", version: "0.8.3" },
          },
        });
      } else if (message.method === "tools/list") {
        send({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result: { tools, schema_version: "1", capability_version: "1" },
        });
      } else if (message.method === "tools/call") {
        const imageResult = message.params?.name === "get_window_state";
        send(
          {
            jsonrpc: "2.0",
            id: message.id ?? null,
            result: imageResult
              ? {
                  content: [{ type: "image", data: imageData, mimeType: "image/png" }],
                  structuredContent: { fragmented: true },
                }
              : { content: [{ type: "text", text: "ok" }] },
          },
          imageResult,
        );
      }
    }
  });
  return {
    bridge,
    destroy: () => {
      input.destroy();
      output.destroy();
      diagnostics.destroy();
    },
    fragmentWrites: () => writes,
    imageData,
  };
}

async function readEvents(logPath: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(logPath, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForEvent(
  logPath: string,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 4_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const match = (await readEvents(logPath)).find(predicate);
      if (match) return match;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for a fake Computer Use event.");
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for a Computer Use lifecycle condition.");
}

function assertProcessExited(pid: number): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
}

function assertProcessRunning(pid: number): void {
  assert.doesNotThrow(() => process.kill(pid, 0));
}

function pendingMcpResponseHandlers(session: CuaDriverSession): number {
  const client = (
    session as unknown as {
      client: { _responseHandlers: Map<number, unknown> } | null;
    }
  ).client;
  assert.ok(client, "the ready Computer Use session should retain its MCP client");
  return client._responseHandlers.size;
}

async function killExactProcess(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitForCondition(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  });
}

function fakeHost(
  root: string,
  logPath: string,
  flags: string[] = [],
  overrides: Partial<CuaDriverHostOptions> &
    Pick<CuaDriverHostTestHooks, "verifyBridgeProcess"> = {},
): CuaDriverHost {
  const invocation = {
    command: process.execPath,
    prefixArgs: [fixture, "--log", logPath, ...flags],
  };
  const { verifyBridgeProcess, ...hostOverrides } = overrides;
  return new TestCuaDriverHost(
    {
      invocation,
      broker: { appPath: "/test/CuaDriver.app" },
      tempRoot: root,
      ...hostOverrides,
    },
    { brokerInvocation: invocation, verifyBridgeProcess },
  );
}

test("buildCuaDriverEnvironment strips secrets and disables telemetry and updates", () => {
  const env = buildCuaDriverEnvironment({
    HOME: "/Users/test",
    LANG: "en_US.UTF-8",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    NODE_OPTIONS: "--require evil.js",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    HTTPS_PROXY: "https://token@example.test",
  });
  assert.equal(env.HOME, "/Users/test");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.CUA_DRIVER_RS_TELEMETRY_ENABLED, "0");
  assert.equal(env.CUA_TELEMETRY_ENABLED, "0");
  assert.equal(env.CUA_DRIVER_RS_UPDATE_CHECK, "false");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
});

test("tool catalog parsing retains pinned versions, exact schemas, and capabilities", () => {
  const schemaFor = (name: string) => ({
    type: "object",
    additionalProperties: name === "start_session" || name === "end_session",
    properties: SESSION_LESS_TOOLS.has(name) ? {} : { session: { type: "string" } },
  });
  const tools = [...CUA_DRIVER_ALLOWED_TOOLS].map((name) => ({
    name,
    input_schema: schemaFor(name),
    read_only: name === "get_window_state",
    destructive: false,
    idempotent: false,
    open_world: false,
    capabilities: name === "get_window_state" ? ["accessibility.element_tokens"] : [],
  }));
  const forbiddenTools = ["launch_app", "kill_app", "move_cursor"].map((name) => ({
    name,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    capabilities: ["forbidden.test"],
  }));
  const catalog = parseCuaDriverTools({
    tools: [...tools, ...forbiddenTools],
    schema_version: "1",
    capability_version: "1",
  });
  assert.equal(catalog.schemaVersion, "1");
  assert.equal(catalog.capabilityVersion, "1");
  assert.deepEqual(catalog.tools.get("get_window_state")?.inputSchema, schemaFor("get_window_state"));
  assert.equal(catalog.tools.get("get_window_state")?.readOnly, true);
  assert.equal(cuaDriverToolDeclaresSession(catalog.tools.get("get_window_state")!), true);
  assert.equal(cuaDriverToolDeclaresSession(catalog.tools.get("list_apps")!), false);
  assert.deepEqual(new Set(catalog.tools.keys()), new Set(CUA_DRIVER_ALLOWED_TOOLS));
  for (const name of ["launch_app", "kill_app", "move_cursor"]) {
    assert.equal(catalog.tools.has(name), false);
  }
  assert.deepEqual(
    [...(catalog.tools.get("get_window_state")?.capabilities ?? [])],
    ["accessibility.element_tokens"],
  );

  for (const invalid of [
    { tools, capability_version: "1" },
    { tools, schema_version: "1" },
    { tools, schema_version: "1", capability_version: 1 },
    { tools, schema_version: "1", capability_version: "2" },
    {
      tools: tools.map((tool, index) => (index === 0 ? { ...tool, capabilities: [1] } : tool)),
      schema_version: "1",
      capability_version: "1",
    },
    {
      tools: tools.map((tool, index) =>
        index === 0 ? { ...tool, input_schema: { type: "object" } } : tool,
      ),
      schema_version: "1",
      capability_version: "1",
    },
    {
      tools: tools.map((tool, index) =>
        index === 0
          ? {
              ...tool,
              input_schema: {
                type: "object",
                additionalProperties: false,
                properties: { session: { type: "number" } },
              },
            }
          : tool,
      ),
      schema_version: "1",
      capability_version: "1",
    },
  ]) {
    assert.throws(
      () => parseCuaDriverTools(invalid),
      (error: unknown) => error instanceof CuaDriverError,
    );
  }
});

test("driver installation resolution rejects unsupported platforms and symlinked helper apps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-path-"));
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      resolveCuaDriverInstallation(
        {
          appPath: root,
          isPackaged: false,
          platform: "darwin",
          resourcesPath: root,
        },
        cancelled.signal,
      ),
      (error: unknown) => error instanceof CuaDriverError && error.code === "cancelled",
    );
    await assert.rejects(
      resolveCuaDriverInstallation({
        appPath: root,
        isPackaged: false,
        platform: "linux",
        resourcesPath: root,
      }),
      (error: unknown) => error instanceof CuaDriverError && error.code === "unsupported_platform",
    );
    const helperParent = path.join(root, "build", "computer-use");
    await mkdir(helperParent, { recursive: true });
    const actualApp = path.join(root, "actual.app");
    await mkdir(actualApp);
    await symlink(actualApp, path.join(helperParent, "CuaDriver.app"));
    await assert.rejects(
      resolveCuaDriverInstallation({
        appPath: root,
        isPackaged: false,
        platform: "darwin",
        resourcesPath: root,
      }),
      (error: unknown) => error instanceof CuaDriverError && error.code === "driver_missing",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live codesign verification avoids unsupported strict process requirements", () => {
  assert.deepEqual(codesignVerifyArguments("+4242", "identifier test"), [
    "--verify",
    "+4242",
  ]);
  assert.deepEqual(codesignVerifyArguments("/tmp/Test.app", "identifier test"), [
    "--verify",
    "--strict",
    "--verbose=2",
    "-R=identifier test",
    "/tmp/Test.app",
  ]);
});

test("production host rejects a direct test broker launcher", () => {
  const invocation = { command: process.execPath, prefixArgs: [fixture] };
  const legacyTestOptions = {
    invocation,
    testOnly: true,
    broker: { appPath: "/test/CuaDriver.app", testInvocation: invocation },
  } as unknown as CuaDriverHostOptions;
  assert.throws(
    () => new CuaDriverHost(legacyTestOptions),
    (error: unknown) => error instanceof CuaDriverError && error.code === "broker_required",
  );
});

test("each session owns an authenticated broker bridge and preserves MCP multimodal results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-host-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, ["--tool-delay-ms", "80"], {
    baseEnv: {
      HOME: os.homedir(),
      OPENAI_API_KEY: "must-not-leak",
      NODE_OPTIONS: "--inspect",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    },
  });
  try {
    const first = await host.createSession();
    const second = await host.createSession();
    assert.notEqual(first.id, second.id);
    assert.equal(first.supports("get_window_state", "accessibility.element_tokens"), true);
    assert.equal(first.toolCatalog.get("get_window_state")?.readOnly, true);
    assert.equal(first.toolCatalog.get("click")?.destructive, true);
    assert.equal(first.toolCatalog.size, 20);
    assert.deepEqual(new Set(first.toolCatalog.keys()), new Set(CUA_DRIVER_ALLOWED_TOOLS));
    assert.equal(first.toolCatalog.has("echo"), false);
    assert.equal(first.schemaVersion, "1");
    assert.equal(first.capabilityVersion, "1");

    const slowFirst = first.callTool("health_report", { include: ["binary_version"] });
    const fastSecond = first.callTool("list_apps");
    await Promise.all([slowFirst, fastSecond]);
    const image = (await second.callTool("get_window_state", {
      pid: 42,
      window_id: 7,
      include_screenshot: true,
    })) as {
      content?: Array<{ type?: string; data?: string; mimeType?: string }>;
      structuredContent?: { width?: number };
    };
    assert.equal(image.content?.[1]?.type, "image");
    assert.equal(image.content?.[1]?.data, "aGVsbG8=");
    assert.equal(image.content?.[1]?.mimeType, "image/png");
    assert.equal(image.structuredContent?.width, 10);
    await first.close();
    await second.close();
  } finally {
    await host.shutdown();
  }

  const events = await readEvents(logPath);
  const spawns = events.filter((event) => event.event === "spawn");
  assert.equal(spawns.filter((event) => event.command === "broker").length, 2);
  assert.equal(spawns.filter((event) => event.command === "bridge").length, 2);
  const commandsBySessionDirectory = new Map<string, Set<unknown>>();
  for (const spawnEvent of spawns) {
    const env = spawnEvent.env as Record<string, unknown>;
    assert.equal(env.telemetry, "0");
    assert.equal(env.legacyTelemetry, "0");
    assert.equal(env.updateCheck, "false");
    assert.equal(env.hasOpenAiKey, false);
    assert.equal(env.hasNodeOptions, false);
    assert.equal(env.hasDyldInjection, false);
    const argv = spawnEvent.argv as string[];
    const leaseIndex = argv.indexOf("--launch-lease-socket");
    assert.equal(leaseIndex >= 0, true);
    const leasePath = argv[leaseIndex + 1] ?? "";
    assert.match(leasePath, /\/acu-[^/]+\/lease\.sock$/);
    const sessionDirectory = path.dirname(leasePath);
    const commands = commandsBySessionDirectory.get(sessionDirectory) ?? new Set();
    commands.add(spawnEvent.command);
    commandsBySessionDirectory.set(sessionDirectory, commands);
  }
  assert.equal(commandsBySessionDirectory.size, 2);
  for (const commands of commandsBySessionDirectory.values()) {
    assert.deepEqual(commands, new Set(["broker", "bridge"]));
  }
  const calls = events.filter((event) => event.event === "tool-call");
  assert.deepEqual(
    events
      .filter(
        (event) =>
          (event.event === "tool-call" || event.event === "tool-result") &&
          (event.name === "health_report" || event.name === "list_apps"),
      )
      .map((event) => `${String(event.event)}:${String(event.name)}`),
    [
      "tool-call:health_report",
      "tool-result:health_report",
      "tool-call:list_apps",
      "tool-result:list_apps",
    ],
  );
  const starts = calls.filter((event) => event.name === "start_session");
  const ends = calls.filter((event) => event.name === "end_session");
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.deepEqual(
    new Set(starts.map((event) => (event.args as { session?: string }).session)),
    new Set(ends.map((event) => (event.args as { session?: string }).session)),
  );
  assert.equal(events.filter((event) => event.event === "broker-bridge-authenticated").length, 2);
  assert.equal(events.filter((event) => event.event === "broker-launch-lease-connected").length, 2);
  assert.equal(events.every((event) => event.hadCallerAuth !== true), true);
  assert.equal(JSON.stringify(events).includes("authorizationToken"), false);
  await rm(root, { recursive: true, force: true });
});

test("fragmented multi-megabyte MCP image results are assembled once and preserved", async () => {
  const fake = fragmentedImageBridge(3 * 1024 * 1024, 1_021);
  const session = new CuaDriverSession({ bridge: fake.bridge });
  try {
    await session.connect();
    const result = (await session.callTool("get_window_state", {
      pid: 42,
      window_id: 7,
      include_screenshot: true,
    })) as {
      content?: Array<{ type?: string; data?: string; mimeType?: string }>;
      structuredContent?: { fragmented?: boolean };
    };
    assert.equal(result.content?.[0]?.type, "image");
    assert.equal(result.content?.[0]?.data, fake.imageData);
    assert.equal(result.content?.[0]?.mimeType, "image/png");
    assert.equal(result.structuredContent?.fragmented, true);
    assert.equal(fake.fragmentWrites() > 3_000, true);
  } finally {
    await session.close();
    fake.destroy();
  }
});

test("inbound MCP framing accepts the exact 64 MiB contract boundary and poisons on one byte more", async () => {
  assert.equal(CUA_DRIVER_MAX_SERVER_MESSAGE_BYTES, 64 * 1024 * 1024);

  const fake = fragmentedImageBridge(1, 1);
  const testLimit = 128;
  const transport = new AuthenticatedBridgeTransport(fake.bridge, testLimit);
  const messages: unknown[] = [];
  const errors: Error[] = [];
  let closeNotifications = 0;
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  transport.onclose = () => {
    closeNotifications += 1;
  };

  try {
    await transport.start();
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
    const output = fake.bridge.stdout as PassThrough;
    const exactFrame = Buffer.from(`${message}${" ".repeat(testLimit - Buffer.byteLength(message))}\n`);
    assert.equal(exactFrame.byteLength - 1, testLimit);
    output.write(exactFrame);
    assert.equal(messages.length, 1);
    assert.equal(errors.length, 0);
    assert.equal(closeNotifications, 0);

    const oversizedFrame = Buffer.from(
      `${message}${" ".repeat(testLimit + 1 - Buffer.byteLength(message))}\n`,
    );
    assert.equal(oversizedFrame.byteLength - 1, testLimit + 1);
    output.write(oversizedFrame);
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0] instanceof CuaDriverError && (errors[0] as CuaDriverError).code,
      "response_too_large",
    );
    assert.equal(closeNotifications, 1);
  } finally {
    await transport.close();
    fake.destroy();
  }
});

test("outbound MCP messages enforce the exact native byte limit without poisoning the session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-client-frame-limit-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath);
  try {
    const session = await host.createSession();
    const requestId = 3;
    const emptyRequest = {
      method: "tools/call",
      params: {
        name: "type_text",
        arguments: { pid: 42, text: "", session: session.id },
      },
      jsonrpc: "2.0",
      id: requestId,
    };
    const fixedBytes = Buffer.byteLength(JSON.stringify(emptyRequest), "utf8");
    const exactText = "a".repeat(CUA_DRIVER_MAX_CLIENT_MESSAGE_BYTES - fixedBytes);
    assert.equal(
      Buffer.byteLength(
        JSON.stringify({
          ...emptyRequest,
          params: {
            ...emptyRequest.params,
            arguments: { ...emptyRequest.params.arguments, text: exactText },
          },
        }),
        "utf8",
      ),
      CUA_DRIVER_MAX_CLIENT_MESSAGE_BYTES,
    );

    await session.callTool("type_text", { pid: 42, text: exactText });
    assert.equal(pendingMcpResponseHandlers(session), 0);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        session.callTool("type_text", { pid: 42, text: `${exactText}a` }),
        (error: unknown) =>
          error instanceof CuaDriverError &&
          error.code === "request_too_large" &&
          error.retryable === false,
      );
      assert.equal(
        pendingMcpResponseHandlers(session),
        0,
        "a locally rejected frame must consume its MCP response handler",
      );
    }
    assert.equal(session.ready, true);
    await session.callTool("list_apps");

    const exactCall = (await readEvents(logPath)).find(
      (event) => event.event === "tool-call" && event.name === "type_text",
    );
    assert.equal(exactCall?.wireBytes, CUA_DRIVER_MAX_CLIENT_MESSAGE_BYTES);
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("successful MCP calls do not retain listeners on a caller-owned abort signal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-signal-listeners-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath);
  try {
    const session = await host.createSession();
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;
    for (let index = 0; index < 24; index += 1) {
      await session.callTool("list_apps", {}, { signal: controller.signal });
      assert.equal(getEventListeners(controller.signal, "abort").length, before);
    }
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("the broker lease is one-shot and Aiden exposes no reusable pathname authentication oracle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-one-shot-lease-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath);
  try {
    const session = await host.createSession();
    const broker = (await readEvents(logPath)).find(
      (event) => event.event === "spawn" && event.command === "broker",
    );
    assert.ok(broker);
    const argv = broker?.argv as string[];
    const leasePath = argv[argv.indexOf("--launch-lease-socket") + 1];
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const socket = createConnection(leasePath);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      }),
      (error: unknown) =>
        ["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""),
    );
    await session.close();
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("session rejects non-allowlisted tools and private broker arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-allow-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath);
  try {
    const session = await host.createSession();
    for (const name of ["launch_app", "kill_app", "move_cursor", "echo"]) {
      await assert.rejects(
        session.callTool(name),
        (error: unknown) => error instanceof CuaDriverError && error.code === "unsupported_tool",
      );
    }
    await assert.rejects(
      session.callTool("click", { _aiden_auth: "attacker" }),
      (error: unknown) => error instanceof CuaDriverError && error.code === "reserved_argument",
    );
  } finally {
    await host.shutdown();
  }
  const events = await readEvents(logPath);
  assert.equal(
    events.some(
      (event) =>
        event.event === "tool-call" &&
        ["launch_app", "kill_app", "move_cursor", "echo"].includes(String(event.name)),
    ),
    false,
  );
  await rm(root, { recursive: true, force: true });
});

test("schema-driven session injection leaves every session-less tool strict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-session-schema-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath);
  let sessionId = "";
  try {
    const session = await host.createSession();
    sessionId = session.id;
    await session.callTool("click", { x: 10, y: 20 });
    const sessionLessCalls: Array<[string, Record<string, unknown>]> = [
      ["health_report", { include: ["binary_version"] }],
      ["check_permissions", { prompt: false }],
      ["list_apps", {}],
      ["list_windows", { on_screen_only: true }],
      ["get_screen_size", {}],
      ["get_accessibility_tree", {}],
      ["bring_to_front", { pid: 42 }],
    ];
    for (const [name, args] of sessionLessCalls) await session.callTool(name, args);
    await assert.rejects(
      session.callTool("list_apps", { session: "caller-controlled" }),
      (error: unknown) =>
        error instanceof CuaDriverError && error.code === "unsupported_argument",
    );
  } finally {
    await host.shutdown();
  }
  const events = await readEvents(logPath);
  const toolCalls = events.filter((event) => event.event === "tool-call");
  const click = toolCalls.find((event) => event.name === "click");
  assert.equal((click?.args as { session?: string }).session, sessionId);
  for (const name of SESSION_LESS_TOOLS) {
    const matching = toolCalls.filter((event) => event.name === name);
    assert.equal(matching.length, 1, `${name} should reach the bridge exactly once`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(matching[0].args as object, "session"),
      false,
      `${name} must not receive a generated session argument`,
    );
  }
  assert.equal(
    events.some((event) => event.event === "bridge-rejected-arguments"),
    false,
    "all calls must satisfy the strict fake schemas",
  );
  await rm(root, { recursive: true, force: true });
});

test("direct bridge and broker teardown returns promptly after child reap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-direct-reap-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath);
  try {
    const session = await host.createSession();
    const processes = (await readEvents(logPath)).filter(
      (event) => event.event === "spawn" &&
        (event.command === "broker" || event.command === "bridge"),
    );
    const startedAt = Date.now();
    await session.close();
    await host.shutdown();
    assert.equal(Date.now() - startedAt < 750, true, "direct-child teardown should not wait to escalate a reaped child");
    for (const child of processes) assertProcessExited(child.pid as number);
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded commands settle after supervising only the exact direct child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-tree-"));
  const logPath = path.join(root, "events.jsonl");
  const descendantPidFile = path.join(root, "descendant.pid");
  const controller = new AbortController();
  let descendantPid: number | undefined;
  try {
    const pending = runCuaDriverCommand(
      {
        command: process.execPath,
        prefixArgs: [fixture, "--log", logPath, "--descendant-pid-file", descendantPidFile],
      },
      ["hold-stdio"],
      {
        env: buildCuaDriverEnvironment(process.env),
        signal: controller.signal,
        timeoutMs: 5_000,
      },
    );
    const ready = await waitForEvent(logPath, (event) => event.event === "descendant-ready");
    descendantPid = ready.descendantPid as number;
    const startedAt = Date.now();
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof CuaDriverError && error.code === "cancelled",
    );
    assert.equal(Date.now() - startedAt < 750, true, "inherited stdio must not delay settlement");
    assertProcessExited(ready.pid as number);
    assertProcessRunning(descendantPid);
  } finally {
    await killExactProcess(descendantPid);
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded command timeout escalates and reaps the exact stubborn child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-direct-kill-"));
  const logPath = path.join(root, "events.jsonl");
  let childPid: number | undefined;
  try {
    const pending = runCuaDriverCommand(
      { command: process.execPath, prefixArgs: [fixture, "--log", logPath] },
      ["ignore-term"],
      {
        env: buildCuaDriverEnvironment(process.env),
        timeoutMs: 200,
      },
    );
    const ready = await waitForEvent(logPath, (event) => event.event === "direct-child-ready");
    childPid = ready.pid as number;
    const startedAt = Date.now();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof CuaDriverError && error.code === "timeout",
    );
    assert.equal(Date.now() - startedAt < 1_500, true, "direct-child escalation must be bounded");
    assertProcessExited(childPid);
  } finally {
    await killExactProcess(childPid);
    await rm(root, { recursive: true, force: true });
  }
});

test("a pre-aborted startup never launches a broker or bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-preabort-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      host.createSession(controller.signal),
      (error: unknown) => error instanceof CuaDriverError && error.code === "cancelled",
    );
    await assert.rejects(readFile(logPath, "utf8"), { code: "ENOENT" });
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge readiness fails closed when caller authentication is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-caller-auth-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, ["--reject-caller"]);
  try {
    await assert.rejects(
      host.createSession(),
      (error: unknown) =>
        error instanceof CuaDriverError &&
        ["bridge_closed", "bridge_failed"].includes(error.code),
    );
    await waitForEvent(logPath, (event) => event.event === "bridge-rejected-caller");
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting readiness kills the bridge and broker without an orphan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-ready-abort-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, ["--ready-delay-ms", "1000"]);
  const controller = new AbortController();
  try {
    const creating = host.createSession(controller.signal);
    const bridge = await waitForEvent(logPath, (event) => event.event === "bridge-authenticated");
    const broker = (await readEvents(logPath)).find(
      (event) => event.event === "spawn" && event.command === "broker",
    );
    controller.abort();
    await assert.rejects(
      creating,
      (error: unknown) => error instanceof CuaDriverError && error.code === "cancelled",
    );
    assertProcessExited(bridge.pid as number);
    assertProcessExited(broker?.pid as number);
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("one startup deadline aborts bridge verification and cleans up the launch lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-verifier-deadline-"));
  const logPath = path.join(root, "events.jsonl");
  let bridgePid: number | undefined;
  let verifierObservedAbort = false;
  const host = fakeHost(root, logPath, [], {
    startupTimeoutMs: 120,
    verifyBridgeProcess: async (pid, _expectedExecutable, signal) => {
      bridgePid = pid;
      await new Promise<void>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("verification must receive the startup signal"));
          return;
        }
        const aborted = () => {
          verifierObservedAbort = true;
          signal.removeEventListener("abort", aborted);
          reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
    },
  });
  const startedAt = Date.now();
  try {
    await assert.rejects(
      host.createSession(),
      (error: unknown) => error instanceof CuaDriverError && error.code === "startup_timeout",
    );
    assert.equal(verifierObservedAbort, true);
    assert.equal(Date.now() - startedAt < 1_000, true, "deadline cleanup should be prompt");
    assert.ok(bridgePid);
    assertProcessExited(bridgePid);
    const events = await readEvents(logPath);
    const broker = events.find((event) => event.event === "spawn" && event.command === "broker");
    assert.equal(typeof broker?.pid, "number");
    assertProcessExited(broker?.pid as number);
    const leftovers = (await readdir(root)).filter((name) => name !== path.basename(logPath));
    assert.deepEqual(leftovers, [], "deadline cleanup should remove the launch lease directory");
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown racing session startup cannot return an orphan session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-race-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, ["--start-session-delay-ms", "500"]);
  try {
    const creating = host.createSession();
    await waitForEvent(
      logPath,
      (event) => event.event === "tool-call" && event.name === "start_session",
    );
    const shuttingDown = host.shutdown();
    await assert.rejects(
      creating,
      (error: unknown) => error instanceof CuaDriverError && error.code === "host_closed",
    );
    await shuttingDown;
    assert.equal(host.running, false);
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("an MCP request timeout poisons one process session and the next session is fresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-timeout-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, ["--tool-delay-ms", "2000"]);
  try {
    const session = await host.createSession();
    const slow = session.callTool(
      "health_report",
      { include: ["binary_version"] },
      { timeoutMs: 40 },
    );
    const queued = session.callTool("list_apps");
    await assert.rejects(
      slow,
      (error: unknown) => error instanceof CuaDriverError && error.code === "timeout",
    );
    await assert.rejects(
      queued,
      (error: unknown) => error instanceof CuaDriverError && error.code === "session_unavailable",
    );
    await waitForEvent(logPath, (event) => event.event === "broker-stopped");
    const restarted = await host.createSession();
    assert.notEqual(restarted.id, session.id);
    assert.equal(restarted.ready, true);
    await restarted.close();
  } finally {
    await host.shutdown();
  }
  const events = await readEvents(logPath);
  assert.equal(
    events.some((event) => event.event === "tool-call" && event.name === "list_apps"),
    false,
  );
  assert.equal(events.filter((event) => event.event === "spawn" && event.command === "broker").length, 2);
  await rm(root, { recursive: true, force: true });
});

test("session startup fails closed when start_session returns an MCP tool error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-start-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, ["--fail-start-session"]);
  try {
    await assert.rejects(
      host.createSession(),
      (error: unknown) => error instanceof CuaDriverError && error.code === "session_start_failed",
    );
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("an aborted MCP request poisons and closes its process session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-abort-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, ["--tool-delay-ms", "2000"]);
  try {
    const session = await host.createSession();
    const controller = new AbortController();
    const pending = session.callTool(
      "health_report",
      { include: ["binary_version"] },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof CuaDriverError && error.code === "cancelled",
    );
    assert.equal(session.ready, false);
    await assert.rejects(
      session.callTool("list_apps"),
      (error: unknown) => error instanceof CuaDriverError && error.code === "session_unavailable",
    );
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("aborting a queued MCP request rejects promptly, poisons the session, and never dispatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-queued-abort-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, ["--tool-delay-ms", "2000"]);
  try {
    const session = await host.createSession();
    const active = session.callTool("health_report", { include: ["binary_version"] });
    const activeRejected = assert.rejects(
      active,
      (error: unknown) =>
        error instanceof CuaDriverError && error.code === "transport_closed",
    );
    await waitForEvent(
      logPath,
      (event) => event.event === "tool-call" && event.name === "health_report",
    );

    const controller = new AbortController();
    const listenerBaseline = getEventListeners(controller.signal, "abort").length;
    const queued = session.callTool("list_apps", {}, { signal: controller.signal });
    const startedAt = Date.now();
    controller.abort();
    await assert.rejects(
      queued,
      (error: unknown) => error instanceof CuaDriverError && error.code === "cancelled",
    );
    assert.equal(Date.now() - startedAt < 500, true, "queued cancellation should reject promptly");
    assert.equal(session.ready, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, listenerBaseline);
    await activeRejected;
    await waitForEvent(logPath, (event) => event.event === "broker-stopped");
  } finally {
    await host.shutdown();
  }

  const events = await readEvents(logPath);
  assert.equal(
    events.some((event) => event.event === "tool-call" && event.name === "list_apps"),
    false,
  );
  await rm(root, { recursive: true, force: true });
});

test("readiness fails closed when the pinned driver omits a required tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-tools-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, [
    "--omit-tool",
    "health_report",
    "--stderr-warning",
  ]);
  try {
    await assert.rejects(
      host.createSession(),
      (error: unknown) =>
        error instanceof CuaDriverError &&
        error.code === "incompatible_driver" &&
        error.retryable === false &&
        error.message.includes("Fake Computer Use diagnostic warning."),
    );
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed tools/list data is a permanent incompatibility with bounded diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-malformed-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath, ["--malformed-tool-catalog", "--stderr-warning"]);
  try {
    await assert.rejects(
      host.createSession(),
      (error: unknown) =>
        error instanceof CuaDriverError &&
        error.code === "incompatible_driver" &&
        error.retryable === false &&
        error.message.includes("Fake Computer Use diagnostic warning."),
    );
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("an idle bridge death immediately invalidates its session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-bridge-death-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath);
  try {
    const session = await host.createSession();
    const bridge = (await readEvents(logPath)).find(
      (event) => event.event === "spawn" && event.command === "bridge",
    );
    process.kill(bridge?.pid as number, "SIGKILL");
    await waitForCondition(() => !session.ready);
    await assert.rejects(
      session.callTool("list_apps"),
      (error: unknown) => error instanceof CuaDriverError && error.code === "session_unavailable",
    );
    await session.close();
    await session.close();
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("broker death invalidates its session and a later session launches a fresh pair", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acu-broker-death-"));
  const logPath = path.join(root, "events.jsonl");
  const host = fakeHost(root, logPath);
  try {
    const session = await host.createSession();
    const broker = (await readEvents(logPath)).find(
      (event) => event.event === "spawn" && event.command === "broker",
    );
    process.kill(broker?.pid as number, "SIGKILL");
    await waitForCondition(() => !session.ready);
    const restarted = await host.createSession();
    assert.notEqual(restarted.id, session.id);
    assert.equal(restarted.ready, true);
    await restarted.close();
  } finally {
    await host.shutdown();
  }
  const events = await readEvents(logPath);
  assert.equal(events.filter((event) => event.event === "spawn" && event.command === "bridge").length, 2);
  await rm(root, { recursive: true, force: true });
});

test("shutdown retries cleanup that failed after an unexpected bridge exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-cleanup-"));
  const logPath = path.join(root, "events.jsonl");
  let attempts = 0;
  const host = fakeHost(root, logPath, [], {
    removeDirectory: async (directory, options) => {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated cleanup failure");
      await rm(directory, options);
    },
  });
  try {
    await host.createSession();
    const bridge = (await readEvents(logPath)).find(
      (event) => event.event === "spawn" && event.command === "bridge",
    );
    process.kill(bridge?.pid as number, "SIGKILL");
    await waitForCondition(() => !host.running);
    await host.shutdown();
    assert.equal(attempts >= 2, true);
  } finally {
    await host.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
