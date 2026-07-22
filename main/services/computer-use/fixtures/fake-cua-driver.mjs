/* global Buffer, clearTimeout, process, setInterval, setTimeout */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import readline from "node:readline";

const argv = process.argv.slice(2);
function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const logPath = option("--log");
const omittedTool = option("--omit-tool");
const startSessionDelayMs = Number(option("--start-session-delay-ms") ?? 0);
const toolDelayMs = Number(option("--tool-delay-ms") ?? 0);
const readyDelayMs = Number(option("--ready-delay-ms") ?? 0);
const failStartSession = argv.includes("--fail-start-session");
const rejectCaller = argv.includes("--reject-caller");
const stderrWarning = argv.includes("--stderr-warning");
const malformedToolCatalog = argv.includes("--malformed-tool-catalog");
const hangTree = argv.includes("--tree-close-on-term");
const descendantPidFile = option("--descendant-pid-file");
const controlPath = option("--control-socket");
const launchLeasePath = option("--launch-lease-socket");
const explicitCommands = new Set(["hold-stdio", "ignore-term", "tree-close-on-term"]);
const MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;
const command = argv.includes("--bridge")
  ? "bridge"
  : controlPath
    ? "broker"
    : argv.find((value) => explicitCommands.has(value)) ?? "unknown";

const ALLOWED_TOOLS = [
  "start_session",
  "end_session",
  "health_report",
  "check_permissions",
  "list_apps",
  "list_windows",
  "get_screen_size",
  "get_accessibility_tree",
  "get_desktop_state",
  "get_window_state",
  "bring_to_front",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
];

const TOOL_PROPERTIES = {
  start_session: ["session"],
  end_session: ["session"],
  health_report: ["include", "skip"],
  check_permissions: ["prompt"],
  list_apps: [],
  list_windows: ["on_screen_only", "pid"],
  get_screen_size: [],
  get_accessibility_tree: [],
  get_desktop_state: ["screenshot_out_file", "session"],
  get_window_state: [
    "capture_mode",
    "include_screenshot",
    "max_depth",
    "max_elements",
    "pid",
    "query",
    "screenshot_out_file",
    "session",
    "window_id",
  ],
  bring_to_front: ["pid", "window_id"],
  click: [
    "action",
    "button",
    "count",
    "debug_image_out",
    "delivery_mode",
    "element_index",
    "element_token",
    "from_zoom",
    "modifier",
    "pid",
    "scope",
    "session",
    "window_id",
    "x",
    "y",
  ],
  double_click: [
    "delivery_mode",
    "element_index",
    "element_token",
    "pid",
    "session",
    "window_id",
    "x",
    "y",
  ],
  right_click: [
    "delivery_mode",
    "element_index",
    "element_token",
    "modifier",
    "pid",
    "session",
    "window_id",
    "x",
    "y",
  ],
  drag: [
    "button",
    "delivery_mode",
    "duration_ms",
    "from_x",
    "from_y",
    "from_zoom",
    "modifier",
    "pid",
    "session",
    "steps",
    "to_x",
    "to_y",
    "window_id",
  ],
  scroll: [
    "amount",
    "by",
    "delivery_mode",
    "direction",
    "element_index",
    "element_token",
    "pid",
    "session",
    "window_id",
    "x",
    "y",
  ],
  type_text: [
    "delay_ms",
    "delivery_mode",
    "element_index",
    "element_token",
    "pid",
    "session",
    "text",
    "window_id",
    "x",
    "y",
  ],
  press_key: [
    "delivery_mode",
    "element_index",
    "element_token",
    "key",
    "modifiers",
    "pid",
    "session",
    "window_id",
    "x",
    "y",
  ],
  hotkey: ["delivery_mode", "keys", "pid", "session", "window_id", "x", "y"],
  set_value: ["element_index", "element_token", "pid", "session", "value", "window_id"],
};

const TOOL_REQUIRED = {
  start_session: ["session"],
  end_session: ["session"],
  get_window_state: ["pid", "window_id"],
  bring_to_front: ["pid"],
  double_click: ["pid"],
  right_click: ["pid"],
  drag: ["pid", "from_x", "from_y", "to_x", "to_y"],
  scroll: ["direction"],
  type_text: ["pid", "text"],
  press_key: ["pid", "key"],
  hotkey: ["pid", "keys"],
  set_value: ["pid", "value"],
};

function log(event) {
  if (!logPath) return;
  appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...event })}\n`, "utf8");
}

log({
  event: "spawn",
  pid: process.pid,
  command,
  argv,
  env: {
    hostBundleId: process.env.CUA_DRIVER_HOST_BUNDLE_ID,
    telemetry: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED,
    legacyTelemetry: process.env.CUA_TELEMETRY_ENABLED,
    updateCheck: process.env.CUA_DRIVER_RS_UPDATE_CHECK,
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasNodeOptions: Boolean(process.env.NODE_OPTIONS),
    hasDyldInjection: Boolean(process.env.DYLD_INSERT_LIBRARIES),
  },
});

if (stderrWarning) process.stderr.write("Fake Computer Use diagnostic warning.\n");

if (command === "hold-stdio") {
  const descendant = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{});process.send?.('ready');setInterval(()=>process.stdout.write(''),1000)",
    ],
    { stdio: ["ignore", process.stdout, process.stderr, "ipc"] },
  );
  descendant.once("message", () => {
    if (descendantPidFile) writeFileSync(descendantPidFile, String(descendant.pid), "utf8");
    log({ event: "descendant-ready", pid: process.pid, descendantPid: descendant.pid });
    process.exit(0);
  });
} else if (command === "ignore-term") {
  log({ event: "direct-child-ready", pid: process.pid });
  process.on("SIGTERM", () => log({ event: "direct-child-ignored-term", pid: process.pid }));
  setInterval(() => {}, 1_000);
} else if (command === "tree-close-on-term" || hangTree) {
  const descendant = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});process.send?.('ready');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  descendant.once("message", () => {
    if (descendantPidFile) writeFileSync(descendantPidFile, String(descendant.pid), "utf8");
    log({ event: "silent-descendant-ready", pid: process.pid, descendantPid: descendant.pid });
  });
  process.on("SIGTERM", () => {
    log({ event: "leader-exited-on-sigterm", pid: process.pid, descendantPid: descendant.pid });
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else if (command === "broker") {
  if (!controlPath || !launchLeasePath) process.exit(2);
  if (existsSync(controlPath)) unlinkSync(controlPath);
  let accepted = false;
  let leaseAccepted = false;
  let shuttingDown = false;
  let launchLease = null;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ event: "broker-stopped" });
    launchLease?.destroy();
    if (server.listening) server.close();
    if (leaseServer.listening) leaseServer.close();
    setTimeout(() => process.exit(0), 0);
  };
  const server = net.createServer((socket) => {
    if (accepted) {
      log({ event: "broker-rejected-extra-bridge" });
      socket.destroy();
      return;
    }
    accepted = true;
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (!input.includes("\n")) return;
      if (input.trim() !== "AIDEN-BRIDGE-2") {
        log({ event: "broker-rejected-bridge" });
        socket.destroy();
        return;
      }
      socket.write("AIDEN-BROKER-2\n");
      log({ event: "broker-bridge-authenticated" });
    });
    socket.once("end", shutdown);
    socket.once("close", shutdown);
  });
  const leaseServer = net.createServer((socket) => {
    if (leaseAccepted) {
      socket.destroy();
      return;
    }
    leaseAccepted = true;
    launchLease = socket;
    leaseServer.close();
    log({ event: "broker-launch-lease-connected" });
    server.listen(controlPath, () => log({ event: "broker-ready", controlPath }));
    socket.once("close", () => {
      if (!shuttingDown) log({ event: "broker-launch-lease-lost" });
      shutdown();
    });
  });
  leaseServer.listen(launchLeasePath, () => log({ event: "broker-launch-lease-ready" }));
  leaseServer.once("error", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else if (command === "bridge") {
  if (!controlPath || !launchLeasePath) process.exit(2);
  if (!process.connected || rejectCaller) {
    log({ event: "bridge-rejected-caller", hasCallerIpc: process.connected });
    process.exit(4);
  }
  let control = null;
  let launchLease = null;
  let bridgeStopping = false;
  let handshake = "";
  let authenticated = false;
  const handshakeTimeout = setTimeout(() => {
    process.stderr.write("Fake bridge authentication timed out.\n");
    process.exit(4);
  }, 1_000);
  const stopBridge = (event) => {
    if (bridgeStopping) return;
    bridgeStopping = true;
    clearTimeout(handshakeTimeout);
    if (event) log({ event });
    control?.destroy();
    launchLease?.destroy();
    setTimeout(() => process.exit(0), 0);
  };
  const connectWithRetry = (socketPath, connected) => {
    const deadline = Date.now() + 1_000;
    const attempt = () => {
      if (bridgeStopping) return;
      const socket = net.createConnection(socketPath);
      const failed = (error) => {
        socket.destroy();
        if (
          Date.now() < deadline &&
          (error.code === "ENOENT" || error.code === "ECONNREFUSED")
        ) {
          setTimeout(attempt, 10);
          return;
        }
        clearTimeout(handshakeTimeout);
        process.stderr.write(`Fake bridge could not connect to broker: ${error.message}\n`);
        process.exit(4);
      };
      socket.once("connect", () => {
        socket.removeListener("error", failed);
        connected(socket);
      });
      socket.once("error", failed);
    };
    attempt();
  };
  connectWithRetry(launchLeasePath, (socket) => {
    launchLease = socket;
    log({ event: "bridge-launch-lease-connected", pid: process.pid });
    launchLease.once("error", () => stopBridge("bridge-launch-lease-error"));
    launchLease.once("close", () => stopBridge("bridge-lost-launch-lease"));
    connectWithRetry(controlPath, (connectedControl) => {
      control = connectedControl;
      control.once("error", () => stopBridge("bridge-control-error"));
      control.write("AIDEN-BRIDGE-2\n");
      control.on("data", (chunk) => {
        if (authenticated) return;
        handshake += chunk.toString("utf8");
        if (!handshake.includes("AIDEN-BROKER-2\n")) return;
        authenticated = true;
        clearTimeout(handshakeTimeout);
        log({ event: "bridge-authenticated", pid: process.pid, hasCallerIpc: process.connected });
        setTimeout(() => {
          writeFileSync(4, `${JSON.stringify({ type: "ready", protocolVersion: 2 })}\n`, "utf8");
          closeSync(4);
          startMcp();
        }, Math.max(0, readyDelayMs));
      });
      control.once("close", () => stopBridge("bridge-lost-broker"));
    });
  });
  process.once("disconnect", () => {
    stopBridge("bridge-lost-aiden-parent");
  });

  function startMcp() {
    const tools = ALLOWED_TOOLS.filter((name) => name !== omittedTool).map((name) => ({
      name,
      description: `Fake ${name}`,
      inputSchema: {
        type: "object",
        additionalProperties: name === "start_session" || name === "end_session",
        properties: Object.fromEntries(
          TOOL_PROPERTIES[name].map((property) => [
            property,
            property === "session" ? { type: "string" } : {},
          ]),
        ),
        required: TOOL_REQUIRED[name] ?? [],
      },
      annotations: {
        readOnlyHint: [
          "health_report",
          "check_permissions",
          "list_apps",
          "list_windows",
          "get_screen_size",
          "get_accessibility_tree",
          "get_desktop_state",
          "get_window_state",
        ].includes(name),
        destructiveHint: ![
          "health_report",
          "check_permissions",
          "list_apps",
          "list_windows",
          "get_screen_size",
          "get_accessibility_tree",
          "get_desktop_state",
          "get_window_state",
        ].includes(name),
        idempotentHint: false,
        openWorldHint: false,
      },
      capabilities: name === "get_window_state" ? ["accessibility.element_tokens"] : [],
    }));
    const pending = new Map();
    const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
    let inputLineBytes = 0;
    process.stdin.on("data", (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? chunk.length : newline;
        inputLineBytes += end - offset;
        if (inputLineBytes > MAX_CLIENT_MESSAGE_BYTES) {
          log({ event: "bridge-rejected-oversized-client-frame", inputLineBytes });
          process.exit(5);
        }
        if (newline < 0) return;
        inputLineBytes = 0;
        offset = newline + 1;
      }
    });
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const wireBytes = Buffer.byteLength(line, "utf8");
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log({ event: "bridge-rejected-malformed-json" });
        process.exit(5);
      }
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-aiden-cua-bridge", version: "0.8.3" },
          },
        });
      } else if (message.method === "notifications/initialized") {
        log({ event: "mcp-initialized" });
      } else if (message.method === "tools/list") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: malformedToolCatalog ? "corrupt-tool-catalog" : tools,
            capability_version: "1",
            schema_version: "1",
            tool_observation_owner: "daemon",
          },
        });
      } else if (message.method === "tools/call") {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        if (!ALLOWED_TOOLS.includes(name) || name === omittedTool || "_aiden_auth" in args) {
          log({ event: "bridge-rejected-tool", name, hadCallerAuth: "_aiden_auth" in args });
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "tool is not allowed" },
          });
          return;
        }
        const allowedArguments = new Set(TOOL_PROPERTIES[name]);
        const unlistedArguments = Object.keys(args).filter((key) => !allowedArguments.has(key));
        const missingArguments = (TOOL_REQUIRED[name] ?? []).filter(
          (key) => !Object.hasOwn(args, key),
        );
        if (unlistedArguments.length > 0 || missingArguments.length > 0) {
          log({ event: "bridge-rejected-arguments", name, unlistedArguments, missingArguments });
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: "tool arguments did not match the strict schema" },
          });
          return;
        }
        log({ event: "tool-call", name, args, hadCallerAuth: false, wireBytes });
        const finish = () => {
          pending.delete(message.id);
          log({ event: "tool-result", name, args });
          if (name === "start_session" && failStartSession) {
            send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                isError: true,
                content: [{ type: "text", text: "fake start_session failure" }],
              },
            });
          } else if (name === "get_window_state" && args.include_screenshot === true) {
            send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [
                  { type: "text", text: "capture summary" },
                  { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
                ],
                structuredContent: { width: 10, height: 10 },
              },
            });
          } else {
            send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ name, args }) }],
                structuredContent: { name, args },
              },
            });
          }
        };
        const delay =
          name === "start_session" ? startSessionDelayMs : name === "health_report" ? toolDelayMs : 0;
        const timer = setTimeout(finish, Math.max(0, delay));
        pending.set(message.id, timer);
      } else if (message.method === "notifications/cancelled") {
        const timer = pending.get(message.params?.requestId);
        if (timer) clearTimeout(timer);
        pending.delete(message.params?.requestId);
      } else if (message.method === "ping") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
      } else {
        log({ event: "bridge-rejected-method", method: message.method });
        if (message.id !== undefined) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "method is not allowed" },
          });
        }
      }
    });
    lines.once("close", () => {
      stopBridge();
    });
  }
} else {
  process.stderr.write("Unknown fake Computer Use command.\n");
  process.exit(2);
}
