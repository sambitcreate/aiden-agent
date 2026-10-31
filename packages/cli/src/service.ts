/**
 * `aiden service install|uninstall|status`: run `aiden serve` as a login
 * service, so the server comes back after a reboot or a closed SSH session.
 * Linux uses a systemd user unit, macOS a launchd LaunchAgent. The service
 * runs the same `serve --no-pair` that `serve --daemon` spawns; the network
 * choice (local only, Tailscale, or both) lives in Remote's own state.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RemoteNetwork } from "./remote.ts";

export const LAUNCHD_LABEL = "com.sambitcreate.aiden-agent.serve";
export const SYSTEMD_UNIT = "aiden.service";

export type ServiceRunner = (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

/** The machine the service is installed on. Tests pass a fake. */
export interface ServiceHost {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  user: string;
  xdgConfigHome?: string;
  run: ServiceRunner;
}

/** What the service runs: `<node> <entry> serve --no-pair` with these settings. */
export interface ServiceLaunch {
  node: string;
  entry: string;
  agentDir: string;
  path: string;
}

export function systemHost(): ServiceHost {
  return {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    user: userInfo().username,
    ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
    run: (command, args) => {
      const result = spawnSync(command, args, { encoding: "utf8" });
      return { status: result.error ? null : result.status, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
    },
  };
}

function serveArgs(launch: ServiceLaunch): string[] {
  for (const value of [launch.node, launch.entry, launch.agentDir, launch.path]) {
    if (/[\r\n\0]/u.test(value)) throw new Error("Service paths cannot contain line breaks.");
  }
  return [launch.node, launch.entry, "serve", "--no-pair"];
}

/** systemd unit text. Arguments are quoted and `%`, `$`, `\` and `"` escaped. */
export function systemdUnit(launch: ServiceLaunch): string {
  const quote = (value: string, dollars: boolean) => `"${value.replace(/[\\"]/gu, "\\$&").replace(/%/gu, "%%").replace(/\$/gu, dollars ? "$$$$" : "$")}"`;
  return [
    "[Unit]",
    "Description=Aiden server (aiden serve)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${serveArgs(launch).map((arg) => quote(arg, true)).join(" ")}`,
    `Environment=${quote(`AIDEN_CODING_AGENT_DIR=${launch.agentDir}`, false)}`,
    `Environment=${quote(`PATH=${launch.path}`, false)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** launchd property list. Output goes to the same serve.log as `serve --daemon`. */
export function launchdPlist(launch: ServiceLaunch): string {
  const xml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
  const log = join(launch.agentDir, "serve.log");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...serveArgs(launch).map((arg) => `    <string>${xml(arg)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>AIDEN_CODING_AGENT_DIR</key><string>${xml(launch.agentDir)}</string>`,
    `    <key>PATH</key><string>${xml(launch.path)}</string>`,
    `  </dict>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict><key>SuccessfulExit</key><false/></dict>`,
    `  <key>ThrottleInterval</key><integer>5</integer>`,
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

type Manager = "systemd" | "launchd";

function manager(host: ServiceHost): Manager {
  if (host.platform === "linux") return "systemd";
  if (host.platform === "darwin") return "launchd";
  throw new Error("`aiden service` supports Linux (systemd) and macOS (launchd). Run `aiden serve --daemon` instead.");
}

export function serviceFile(host: ServiceHost): string {
  return manager(host) === "systemd"
    ? join(host.xdgConfigHome ?? join(host.home, ".config"), "systemd", "user", SYSTEMD_UNIT)
    : join(host.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function must(host: ServiceHost, command: string, args: string[], failure: string): string {
  const result = host.run(command, args);
  if (result.status !== 0) throw new Error(`${failure} (${`${command} ${args.join(" ")}`}: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`})`);
  return result.stdout;
}

export interface InstallResult {
  manager: Manager;
  file: string;
  /** Something the person still has to do, such as enabling lingering. */
  warning?: string;
  /** The service file this install replaced, kept until the new server is known to start. */
  previous?: string;
}

/**
 * Put back the service file a failed reinstall replaced, and start it again
 * in place of the replacement. Best effort: the original failure is what the
 * person needs to see.
 */
export function restoreService(host: ServiceHost, previous: string): void {
  const file = serviceFile(host);
  if (manager(host) === "systemd") {
    writeFileSync(file, previous, { mode: 0o644 });
    host.run("systemctl", ["--user", "daemon-reload"]);
    host.run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    return;
  }
  host.run("launchctl", ["bootout", `gui/${host.uid}/${LAUNCHD_LABEL}`]);
  writeFileSync(file, previous, { mode: 0o644 });
  host.run("launchctl", ["bootstrap", `gui/${host.uid}`, file]);
}

/** Write the service file, then (re)start the service so it runs the new file. */
export function installService(host: ServiceHost, launch: ServiceLaunch): InstallResult {
  const kind = manager(host);
  const file = serviceFile(host);
  mkdirSync(dirname(file), { recursive: true });
  // launchd opens serve.log in the agent directory before Node starts, so it must exist.
  mkdirSync(launch.agentDir, { recursive: true, mode: 0o700 });
  // A failed reinstall puts back the service that was there, instead of leaving none.
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (kind === "systemd") {
    writeFileSync(file, systemdUnit(launch), { mode: 0o644 });
    try {
      must(host, "systemctl", ["--user", "daemon-reload"], "systemd user services are not available in this session. Log in as this user over SSH (not with su or sudo), or run `aiden serve --daemon` instead");
      must(host, "systemctl", ["--user", "enable", SYSTEMD_UNIT], "Could not enable the Aiden service");
      must(host, "systemctl", ["--user", "restart", SYSTEMD_UNIT], "Could not start the Aiden service");
    } catch (error) {
      if (previous !== undefined) {
        restoreService(host, previous);
        throw error;
      }
      // Leave nothing half-installed: a later status or boot must not find this unit.
      host.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
      rmSync(file, { force: true });
      host.run("systemctl", ["--user", "daemon-reload"]);
      throw error;
    }
    // Without lingering, user services stop at logout and do not start at boot.
    const linger = host.run("loginctl", ["show-user", host.user, "--property=Linger", "--value"]);
    const kept = previous !== undefined ? { previous } : {};
    if (linger.status === 0 && linger.stdout.trim() === "yes") return { manager: kind, file, ...kept };
    if (host.run("loginctl", ["enable-linger", host.user]).status === 0) return { manager: kind, file, ...kept };
    return { manager: kind, file, ...kept, warning: "The server stops when you log out and does not start at boot until you run `sudo loginctl enable-linger $USER` once." };
  }
  writeFileSync(file, launchdPlist(launch), { mode: 0o644 });
  const target = `gui/${host.uid}`;
  try {
    // A reinstall replaces the loaded job; bootout fails harmlessly when none is loaded.
    host.run("launchctl", ["bootout", `${target}/${LAUNCHD_LABEL}`]);
    // A disabled label stays disabled across boots and refuses to load until enabled.
    must(host, "launchctl", ["enable", `${target}/${LAUNCHD_LABEL}`], "Could not enable the Aiden service");
    must(host, "launchctl", ["bootstrap", target, file], "Could not load the Aiden service. Run `aiden service install` from a session logged in to this Mac's desktop");
  } catch (error) {
    if (previous === undefined) rmSync(file, { force: true });
    else restoreService(host, previous);
    throw error;
  }
  return { manager: kind, file, ...(previous !== undefined ? { previous } : {}), warning: "On a Mac the server runs while you are logged in. For a Mac without a screen, turn on automatic login in System Settings → Users & Groups." };
}

/** The manager's answer when the service is simply not loaded, which uninstall treats as already stopped. */
const NOT_LOADED = /not loaded|not found|does not exist|no such process|could not find/iu;

/**
 * Stop the service and remove its file. Returns false when nothing was
 * installed. When the manager cannot stop a loaded service, the file stays so
 * the uninstall can be retried, and the error says why.
 */
export function uninstallService(host: ServiceHost): boolean {
  const kind = manager(host);
  const file = serviceFile(host);
  if (!existsSync(file)) return false;
  const [command, args] = kind === "systemd"
    ? ["systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]]
    : ["launchctl", ["bootout", `gui/${host.uid}/${LAUNCHD_LABEL}`]];
  const stopped = host.run(command, args);
  const output = `${stopped.stderr}\n${stopped.stdout}`.trim();
  if (stopped.status !== 0 && !(stopped.status !== null && NOT_LOADED.test(output))) {
    throw new Error(`Could not stop the Aiden service (${command} ${args.join(" ")}: ${output || `exit ${stopped.status}`}). It is still installed; fix that and run \`aiden service uninstall\` again.`);
  }
  rmSync(file, { force: true });
  if (kind === "systemd") host.run("systemctl", ["--user", "daemon-reload"]);
  return true;
}

export function serviceStatus(host: ServiceHost): { installed: boolean; manager: Manager; file: string; active: boolean; logs: string } {
  const kind = manager(host);
  const file = serviceFile(host);
  if (kind === "systemd") {
    const active = host.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).stdout.trim() === "active";
    return { installed: existsSync(file), manager: kind, file, active, logs: `journalctl --user -u ${SYSTEMD_UNIT}` };
  }
  const printed = host.run("launchctl", ["print", `gui/${host.uid}/${LAUNCHD_LABEL}`]);
  return { installed: existsSync(file), manager: kind, file, active: printed.status === 0 && /\bstate = running\b/u.test(printed.stdout), logs: "serve.log in the Aiden agent directory" };
}

export const SERVICE_USAGE = "Usage: aiden service install [--network local|tailscale|both] [--no-pair] | uninstall | status";

export function parseInstallFlags(args: readonly string[]): { network?: RemoteNetwork; pair: boolean } {
  let network: RemoteNetwork | undefined;
  let pair = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--no-pair") pair = false;
    else if (arg === "--network" || arg.startsWith("--network=")) {
      const value = arg === "--network" ? args[(index += 1)] : arg.slice("--network=".length);
      if (value !== "local" && value !== "tailscale" && value !== "both") throw new Error("Usage: aiden service install --network local|tailscale|both");
      network = value;
    } else throw new Error(SERVICE_USAGE);
  }
  return { ...(network ? { network } : {}), pair };
}

async function askNetwork(): Promise<RemoteNetwork> {
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write([
      "Who should be able to reach this server?",
      "  1) Local network only: phones on the same Wi-Fi or LAN",
      "  2) Tailscale only: your devices from anywhere (needs Tailscale on this server)",
      "  3) Both",
      "",
    ].join("\n"));
    for (;;) {
      const answer = (await prompt.question("Choose 1, 2 or 3 [1]: ")).trim();
      if (answer === "" || answer === "1") return "local";
      if (answer === "2") return "tailscale";
      if (answer === "3") return "both";
    }
  } finally {
    prompt.close();
  }
}

const NETWORK_LABEL: Record<RemoteNetwork, string> = { local: "the local network only", tailscale: "Tailscale only", both: "the local network and Tailscale" };

async function waitForServer(agentDir: string, timeoutMs = 30_000): Promise<boolean> {
  const { daemonStatus } = await import("./serve-lifecycle.ts");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemonStatus(agentDir).running) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

/** `aiden service ...`. Prints its own output. */
export async function serviceCommand(agentDir: string, args: string[], host: ServiceHost = systemHost(), options: { readyTimeoutMs?: number } = {}): Promise<void> {
  const [action, ...rest] = args;
  const out = (line: string) => process.stdout.write(`${line}\n`);
  if (action === "status" && rest.length === 0) {
    const { daemonStatus } = await import("./serve-lifecycle.ts");
    process.stdout.write(JSON.stringify({ ...serviceStatus(host), server: daemonStatus(agentDir) }, null, 2) + "\n");
    return;
  }
  if (action === "uninstall" && rest.length === 0) {
    out(uninstallService(host) ? "Removed the Aiden service. The server no longer starts on its own." : "The Aiden service was not installed.");
    return;
  }
  if (action !== "install") throw new Error(SERVICE_USAGE);
  const flags = parseInstallFlags(rest);
  manager(host);
  const entry = realpathSync(process.env.AIDEN_CLI_ENTRY || process.argv[1] || "");
  if (!entry.endsWith(".js")) throw new Error("Build the CLI first (`npm run cli:build`); the service runs the built dist/app/cli.js.");
  const network = flags.network ?? (process.stdin.isTTY && process.stdout.isTTY ? await askNetwork() : "local");

  // The service takes over the server's lease, so stop a server started by hand.
  const { daemonStatus, stopDaemon } = await import("./serve-lifecycle.ts");
  const stopped = daemonStatus(agentDir).running;
  if (stopped) {
    await stopDaemon(agentDir);
    out("Stopped the server that was already running; the service runs it from now on.");
  }
  let installed: InstallResult | undefined;
  try {
    installed = installService(host, { node: process.execPath, entry, agentDir: resolve(agentDir), path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" });
    out(`Installed ${installed.file}.`);
    const logs = installed.manager === "systemd" ? `journalctl --user -u ${SYSTEMD_UNIT}` : join(agentDir, "serve.log");
    const readyMs = options.readyTimeoutMs ?? 30_000;
    if (!await waitForServer(agentDir, readyMs)) throw new Error(`The service did not start the server within ${Math.round(readyMs / 1000)}s. See ${logs}.`);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\.*$/u, ".");
    // The replacement never served: put back the service it replaced (installService already did when the manager refused).
    if (installed?.previous !== undefined) {
      restoreService(host, installed.previous);
      throw new Error(`${message} Put back the service that was installed before.`, { cause: error });
    }
    // Say how to get back the server this install stopped, unless something is already serving again.
    if (!stopped || daemonStatus(agentDir).running) throw error;
    throw new Error(`${message} The server that was running before is stopped; start it again with \`aiden serve --daemon\`.`, { cause: error });
  }
  const logs = installed.manager === "systemd" ? `journalctl --user -u ${SYSTEMD_UNIT}` : join(agentDir, "serve.log");

  const { remoteDaemonCommand } = await import("./daemon-control.ts");
  let reachable: RemoteNetwork = network;
  try {
    await remoteDaemonCommand(agentDir, "remote", ["network", network]);
  } catch (error) {
    const status = await remoteDaemonCommand(agentDir, "remote", ["status"]).catch(() => undefined) as { connectionMode?: string } | undefined;
    reachable = status?.connectionMode === "tailscale" ? "tailscale" : status?.connectionMode === "both" ? "both" : "local";
    process.stderr.write(`aiden: Could not set up ${NETWORK_LABEL[network]}. ${error instanceof Error ? error.message : String(error)}\n`);
    out(`For now the server is reachable over ${NETWORK_LABEL[reachable]}. Change it later with \`aiden remote network local|tailscale|both\`.`);
  }
  // Without lingering a Linux user service does not start at boot; the warning says so instead.
  const boot = installed.manager === "systemd" && installed.warning ? "" : installed.manager === "systemd" ? " It starts again after a reboot." : " It starts again when you log in.";
  out(`The Aiden server is running as a service and reachable over ${NETWORK_LABEL[reachable]}.${boot}`);
  if (installed.warning) out(installed.warning);
  out(`Logs: ${logs}. Stop it for good with \`aiden service uninstall\`.`);

  if (!flags.pair || !process.stdout.isTTY) {
    out(`Pair a phone with \`aiden remote pair ${reachable === "local" ? "lan" : "tailscale"}\`.`);
    return;
  }
  out("Scan this code with Aiden on your phone. Press Ctrl+C to skip; the server keeps running.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try {
    const { showStartupPairing } = await import("./serve-command.ts");
    await showStartupPairing(agentDir, reachable === "local" ? "lan" : "tailscale", controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
  }
}
