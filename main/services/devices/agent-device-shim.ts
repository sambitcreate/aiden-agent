/**
 * Adapted from t3code apps/server/src/device/AgentDeviceShim.ts and
 * AgentDeviceTarget.ts @ 1c127066 (MIT)
 *
 * A directory holding an `agent-device` launcher that runs the pinned install
 * with Aiden's bundled Node (Electron in Node mode). `run_command` prepends it
 * to PATH while device tools are attached, so the agent gets the version the
 * `device_open` guidance was written for, whatever is installed globally.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDeviceEndpoint } from "./device-host.js";

const SHIM_DIR = "bin";

const shQuote = (value: string): string => `'${value.split("'").join(`'"'"'`)}'`;

/** The launcher refuses to drive a device without the flags `device_open` returned. */
export function agentDeviceLauncherSource(nodePath: string, entryPath: string): string {
  return `import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const informational = args.length === 1 && ["help", "--help", "-h", "--version", "version"].includes(args[0]);
const hasValue = flag => { const index = args.indexOf(flag); return index >= 0 && !!args[index + 1] && !args[index + 1].startsWith("--"); };
if (!informational && !(hasValue("--config") && hasValue("--session"))) {
  console.error("Call device_open first and include its --config and --session flags.");
  process.exit(1);
}
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" };
delete env.AGENT_DEVICE_DAEMON_BASE_URL;
delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
delete env.AGENT_DEVICE_CONFIG;
const child = spawn(${JSON.stringify(nodePath)}, [${JSON.stringify(entryPath)}, ...args], { stdio: "inherit", env });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
`;
}

export function agentDeviceShimSource(nodePath: string, launcherPath: string): string {
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(nodePath)} ${shQuote(launcherPath)} "$@"\n`;
}

/** Writes `<baseDir>/bin/agent-device` and its launcher; returns the executable path. */
export async function ensureAgentDeviceShim(input: {
  baseDir: string;
  nodePath: string;
  entryPath: string;
}): Promise<{ shimDir: string; command: string }> {
  const shimDir = path.join(input.baseDir, SHIM_DIR);
  await mkdir(shimDir, { recursive: true });
  const launcherPath = path.join(shimDir, "agent-device-launcher.mjs");
  const command = path.join(shimDir, "agent-device");
  await writeIfChanged(launcherPath, agentDeviceLauncherSource(input.nodePath, input.entryPath), 0o644);
  await writeIfChanged(command, agentDeviceShimSource(input.nodePath, launcherPath), 0o755);
  return { shimDir, command };
}

const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** A stable file per host lets the daemon endpoint change without retargeting other commands. */
export const agentDeviceConfigPath = (baseDir: string, hostId: string): string =>
  path.join(baseDir, "hosts", `${key(hostId)}.json`);

/** One agent-device session per chat and device, so chats never share a device session. */
export const agentDeviceSession = (chatId: string, hostId: string, deviceId: string): string =>
  `aiden-${key(JSON.stringify([chatId, hostId, deviceId]))}`;

/** Holds the daemon token, so it is owner-only and replaced atomically. */
export async function writeAgentDeviceConfig(file: string, endpoint: AgentDeviceEndpoint): Promise<void> {
  const content = JSON.stringify({ daemonBaseUrl: endpoint.baseUrl, daemonAuthToken: endpoint.token });
  await writeIfChanged(file, content, 0o600);
}

async function writeIfChanged(file: string, content: string, mode: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  if ((await readFile(file, "utf8").catch(() => null)) === content) {
    await chmod(file, mode);
    return;
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
