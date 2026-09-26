// A stand-in for agent-device in the Simulator agent E2E. The spec seeds it as
// the pinned "installed" entry, so Aiden's real local host starts its daemon and
// the real PATH shim runs it for `run_command`. It never touches Xcode.
//
// - `devices --json` starts a detached daemon that writes daemon.json and
//   answers /health, like the real CLI's first command.
// - `daemon stop --state-dir <dir>` stops that daemon.
// - `--version` prints a marker; every other command is logged and echoed.
//
// Every CLI call is appended as a JSON line to AIDEN_E2E_FAKE_AGENT_LOG.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const logPath = process.env.AIDEN_E2E_FAKE_AGENT_LOG;
const log = (entry) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
};
const stateDirFrom = (list) => {
  const index = list.indexOf("--state-dir");
  return index >= 0 ? list[index + 1] : process.env.AGENT_DEVICE_STATE_DIR;
};

if (args[0] === "__daemon") {
  const stateDir = args[1];
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    response.end("{}");
  });
  server.listen(0, "127.0.0.1", () => {
    mkdirSync(stateDir, { recursive: true });
    const { port } = server.address();
    writeFileSync(
      path.join(stateDir, "daemon.json"),
      JSON.stringify({ httpPort: port, token: randomUUID(), pid: process.pid }),
    );
  });
  process.on("SIGTERM", () => process.exit(0));
  // A failed run must not leave the daemon behind.
  setTimeout(() => process.exit(0), 10 * 60_000).unref();
} else if (args[0] === "devices") {
  const stateDir = stateDirFrom(args);
  log({ kind: "cli", args, daemonEnv: Boolean(process.env.AGENT_DEVICE_DAEMON_BASE_URL) });
  if (stateDir) {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "__daemon", stateDir], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    }).unref();
  }
  process.stdout.write(`${JSON.stringify({ devices: [] })}\n`);
} else if (args[0] === "daemon" && args[1] === "stop") {
  const stateDir = stateDirFrom(args);
  log({ kind: "cli", args });
  try {
    const daemonPath = path.join(stateDir, "daemon.json");
    const { pid } = JSON.parse(readFileSync(daemonPath, "utf8"));
    rmSync(daemonPath, { force: true });
    process.kill(pid, "SIGTERM");
  } catch {
    // Already stopped.
  }
} else if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("agent-device 0.21.12 (aiden e2e fake)\n");
} else {
  log({
    kind: "cli",
    args,
    daemonEnv: Boolean(process.env.AGENT_DEVICE_DAEMON_BASE_URL || process.env.AGENT_DEVICE_CONFIG),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, args })}\n`);
}
