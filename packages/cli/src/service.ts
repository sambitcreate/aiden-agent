/**
 * `aiden service install|uninstall|status`: run `aiden serve` as a login
 * service, so the server comes back after a reboot or a closed SSH session.
 * Linux uses a systemd user unit, macOS a launchd LaunchAgent. The service
 * runs the same `serve --no-pair` that `serve --daemon` spawns; the network
 * choice (local only, Tailscale, or both) lives in Remote's own state.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { acquireLease } from "./state.ts";
import type { RemoteNetwork } from "./remote.ts";
import type { TailscaleFacts } from "./reachability.ts";
import type { AidenTailscaleCommandRunner } from "../../../main/services/aiden-remote-tailscale.js";
import type { AidenTailscaleOwnership } from "../../../main/services/aiden-remote-tailscale-route.js";

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
  /** Stable account home for the service-wide lease, independent of profile and HOME overrides. */
  leaseHome?: string;
  run: ServiceRunner;
  readProcessEnvironment?: (pid: number) => string;
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
    leaseHome: userInfo().homedir,
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

type ServiceIdentity = { loaded: boolean; profile?: string; fileContents?: string };
const PROFILE_KEY = "AIDEN_CODING_AGENT_DIR";

function checkedProfile(value: string): string {
  if (!isAbsolute(value) || /[\r\n\0]/u.test(value) || resolve(value) !== value) {
    throw new Error("The installed Aiden service has an unrecognized profile; it was not changed.");
  }
  return value;
}

/** Parse only the profile syntax written by this CLI, never an arbitrary service file. */
function fileProfile(host: ServiceHost, content: string): string {
  if (manager(host) === "launchd") {
    if (!content.includes(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`) || !content.includes("<key>ProgramArguments</key>") || !content.includes("<string>serve</string>\n    <string>--no-pair</string>") || !content.includes("<key>EnvironmentVariables</key>")) throw new Error("Unrecognized installed service profile.");
    const matches = [...content.matchAll(/<key>AIDEN_CODING_AGENT_DIR<\/key><string>([^<]*)<\/string>/gu)];
    if (matches.length !== 1 || (content.match(/<key>AIDEN_CODING_AGENT_DIR<\/key>/gu) ?? []).length !== 1) throw new Error("Unrecognized installed service profile.");
    const encoded = matches[0]![1]!;
    if (/&(?!amp;|lt;|gt;|quot;)/u.test(encoded)) throw new Error("Unrecognized installed service profile.");
    return checkedProfile(encoded.replace(/&(amp|lt|gt|quot);/gu, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[name]!));
  }
  if (!content.startsWith("[Unit]\nDescription=Aiden server (aiden serve)\n\n[Service]\nType=simple\n") || !content.includes(' "serve" "--no-pair"\n') || !content.includes("\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n")) throw new Error("Unrecognized installed service profile.");
  const assignments = content.split("\n").filter((line) => /^\s*Environment\s*=/u.test(line));
  const lines = assignments.filter((line) => line.startsWith(`Environment="${PROFILE_KEY}=`));
  if (assignments.length !== 2 || lines.length !== 1 || !assignments.some((line) => line.startsWith('Environment="PATH=')) || /^\s*(?:EnvironmentFile|UnsetEnvironment)\s*=/mu.test(content)) throw new Error("Unrecognized installed service profile.");
  const match = /^Environment="AIDEN_CODING_AGENT_DIR=((?:[^"\\]|\\["\\])*)"$/u.exec(lines[0]!);
  if (!match || match[1]!.replace(/%%/gu, "").includes("%")) throw new Error("Unrecognized installed service profile.");
  return checkedProfile(match[1]!.replace(/\\(["\\])/gu, "$1").replace(/%%/gu, "%"));
}

function managerProperty(host: ServiceHost, property: string): { type: string; data: unknown } {
  const result = host.run("busctl", ["--user", "--json=short", "get-property", "org.freedesktop.systemd1", "/org/freedesktop/systemd1/unit/aiden_2eservice", "org.freedesktop.systemd1.Service", property]);
  if (result.status !== 0) throw new Error("Cannot inspect the installed Aiden service; it was not changed.");
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string" && "data" in parsed) return parsed as { type: string; data: unknown };
  } catch { /* fail closed below */ }
  throw new Error("Cannot inspect the installed Aiden service; it was not changed.");
}

/** Resolve the loaded manager definition first; only an absent job permits file fallback. */
function serviceIdentity(host: ServiceHost): ServiceIdentity {
  const file = serviceFile(host);
  const fileContents = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (manager(host) === "launchd") {
    const target = `gui/${host.uid}/${LAUNCHD_LABEL}`;
    const result = host.run("launchctl", ["print", target]);
    if (result.status === 0) {
      const blocks = [...result.stdout.matchAll(/^\tenvironment = \{\n([\s\S]*?)^\t\}/gmu)];
      if (blocks.length !== 1) throw new Error("Cannot identify the loaded Aiden service profile; it was not changed.");
      const lines = blocks[0]![1]!.split("\n").filter((line) => line.startsWith(`\t\t${PROFILE_KEY} => `));
      if (lines.length !== 1) throw new Error("Cannot identify the loaded Aiden service profile; it was not changed.");
      return { loaded: true, profile: checkedProfile(lines[0]!.slice(`\t\t${PROFILE_KEY} => `.length)), fileContents };
    }
    if (result.status !== 113 || !result.stderr.includes(`Could not find service "${LAUNCHD_LABEL}"`)) throw new Error("Cannot inspect the installed Aiden service; it was not changed.");
  } else {
    const state = host.run("systemctl", ["--user", "show", SYSTEMD_UNIT, "--property=LoadState", "--value"]);
    if (state.status !== 0) throw new Error("Cannot inspect the installed Aiden service; it was not changed.");
    const loadState = state.stdout.trim();
    if (loadState === "loaded") {
      const fragment = host.run("systemctl", ["--user", "show", SYSTEMD_UNIT, "--property=FragmentPath", "--value"]);
      const fragmentPath = fragment.stdout.replace(/\n$/u, "");
      if (fragment.status !== 0 || fragmentPath !== file) throw new Error("The loaded Aiden service has an unrecognized service file; it was not changed.");
      const env = managerProperty(host, "Environment");
      const files = managerProperty(host, "EnvironmentFiles");
      const unset = managerProperty(host, "UnsetEnvironment");
      if (env.type !== "as" || !Array.isArray(env.data) || !env.data.every((x) => typeof x === "string") || files.type !== "a(sb)" || !Array.isArray(files.data) || files.data.length !== 0 || unset.type !== "as" || !Array.isArray(unset.data) || unset.data.length !== 0) throw new Error("Cannot identify the loaded Aiden service profile; it was not changed.");
      const matches = (env.data as string[]).filter((x) => x.startsWith(`${PROFILE_KEY}=`));
      if (matches.length !== 1) throw new Error("Cannot identify the loaded Aiden service profile; it was not changed.");
      const profile = checkedProfile(matches[0]!.slice(PROFILE_KEY.length + 1));
      const pid = managerProperty(host, "MainPID");
      if (pid.type !== "u" || typeof pid.data !== "number" || !Number.isSafeInteger(pid.data) || pid.data < 0) throw new Error("Cannot inspect the running Aiden service; it was not changed.");
      if (pid.data > 0) {
        let processEnvironment: string;
        try { processEnvironment = host.readProcessEnvironment?.(pid.data) ?? readFileSync(`/proc/${pid.data}/environ`, "utf8"); }
        catch { throw new Error("Cannot inspect the running Aiden service; it was not changed."); }
        const actual = processEnvironment.split("\0").filter((x) => x.startsWith(`${PROFILE_KEY}=`));
        if (actual.length !== 1 || actual[0]!.slice(PROFILE_KEY.length + 1) !== profile) throw new Error("The running Aiden service differs from its loaded profile; it was not changed.");
      }
      return { loaded: true, profile, fileContents };
    }
    if (loadState !== "not-found") throw new Error("Cannot inspect the installed Aiden service; it was not changed.");
  }
  if (fileContents !== undefined && manager(host) === "systemd") {
    const dirs = [join(dirname(file), `${SYSTEMD_UNIT}.d`), "/etc/systemd/user/aiden.service.d", "/run/systemd/user/aiden.service.d", "/usr/local/lib/systemd/user/aiden.service.d", "/usr/lib/systemd/user/aiden.service.d"];
    if (dirs.some((dir) => existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".conf")))) throw new Error("Cannot identify the installed Aiden service profile with overrides; it was not changed.");
  }
  return { loaded: false, ...(fileContents === undefined ? {} : { profile: fileProfile(host, fileContents), fileContents }) };
}

function sameIdentity(a: ServiceIdentity, b: ServiceIdentity): boolean {
  return a.loaded === b.loaded && a.profile === b.profile && a.fileContents === b.fileContents;
}

/**
 * Stop the service and remove its file. Returns false when nothing was
 * installed. When the manager cannot stop a loaded service, the file stays so
 * the uninstall can be retried, and the error says why.
 */
export function uninstallService(host: ServiceHost, loaded = false): boolean {
  const kind = manager(host);
  const file = serviceFile(host);
  if (!existsSync(file) && !loaded) return false;
  const [command, args] = kind === "systemd"
    ? ["systemctl", ["--user", "stop", SYSTEMD_UNIT]]
    : ["launchctl", ["bootout", `gui/${host.uid}/${LAUNCHD_LABEL}`]];
  const stopped = host.run(command, args);
  const output = `${stopped.stderr}\n${stopped.stdout}`.trim();
  if (stopped.status !== 0 && !(stopped.status !== null && !loaded && NOT_LOADED.test(output))) {
    throw new Error(`Could not stop the Aiden service (${command} ${args.join(" ")}: ${output || `exit ${stopped.status}`}). It is still installed; fix that and run \`aiden service uninstall\` again.`);
  }
  if (kind === "systemd") {
    const disabled = host.run("systemctl", ["--user", "disable", SYSTEMD_UNIT]);
    const output = `${disabled.stderr}\n${disabled.stdout}`.trim();
    if (disabled.status !== 0 && !(disabled.status !== null && !existsSync(file) && /unit file .* does not exist/iu.test(output))) {
      throw new Error(`Could not disable the Aiden service (${output || `exit ${disabled.status}`}). Its file and route were left in place.`);
    }
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

const CHOICE: Record<RemoteNetwork, string> = { local: "1", tailscale: "2", both: "3" };

async function askNetwork(question: { text: string; recommended: RemoteNetwork }): Promise<RemoteNetwork> {
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(question.text);
    for (;;) {
      const answer = (await prompt.question(`Choose 1, 2 or 3 [${CHOICE[question.recommended]}]: `)).trim() || CHOICE[question.recommended];
      if (answer === "1") return "local";
      if (answer === "2") return "tailscale";
      if (answer === "3") return "both";
    }
  } finally {
    prompt.close();
  }
}

/** Ask what is ready on this machine, then the person (or, without a terminal, use Tailscale only when it is ready). */
export interface NetworkChoiceSources {
  facts?: () => Promise<TailscaleFacts>;
  cloud?: () => Promise<boolean>;
  ask?: (question: { text: string; recommended: RemoteNetwork }) => Promise<RemoteNetwork>;
}

/**
 * The install's network: asked in a terminal with the suggestion as the
 * default; without one, the suggestion only when Tailscale is ready, so an
 * unattended install never picks a network that cannot work yet.
 */
export async function chooseNetwork(host: ServiceHost, interactive: boolean, sources: NetworkChoiceSources = {}): Promise<RemoteNetwork> {
  const { looksLikeCloudServer, networkQuestion, readSystemTailscaleFacts, tailscaleReady } = await import("./reachability.ts");
  const readFacts = sources.facts ?? (() => readSystemTailscaleFacts({ platform: host.platform, uid: host.uid, user: host.user }));
  const [facts, cloud] = await Promise.all([readFacts(), (sources.cloud ?? (() => looksLikeCloudServer()))()]);
  const question = networkQuestion(facts, cloud, host.platform);
  if (interactive) return (sources.ask ?? askNetwork)(question);
  return tailscaleReady(facts) ? question.recommended : "local";
}

export interface OfflineRouteRelease {
  runner?: AidenTailscaleCommandRunner | null;
  withRouteLock?: <T>(action: () => Promise<T>) => Promise<T>;
}

const ROUTE_REMOVED = "Removed Aiden's Tailscale route. `aiden remote network tailscale` (or `both`) adds it back later.";
const ROUTE_BY_HAND = "Remove it by hand with `tailscale serve --https=443 --set-path=/api/aiden/v1 off`.";
const UNFINISHED_CHANGE = `Aiden's Tailscale route may have an unfinished change, so it was left alone. ${ROUTE_BY_HAND}`;

/**
 * Before the service goes away, take Aiden's Tailscale Serve route down with
 * it, so the tailnet name does not keep pointing at a server that no longer
 * runs. A running server removes its own route; for a stopped one, the route
 * it saved as its own is removed through Tailscale directly. Returns the line
 * to print, if any.
 */
export async function releaseTailscaleRoute(agentDir: string, offline: OfflineRouteRelease = {}): Promise<string | undefined> {
  const { remoteServerStatus } = await import("./reachability.ts");
  const status = await remoteServerStatus(agentDir);
  // A server that does not answer is handled like a stopped one: the controller takes the same route lock.
  if (status && !status.remoteOff && !status.unanswered) {
    if (status.tailscaleRouteState === "reconciliation_required") return UNFINISHED_CHANGE;
    if (!status.tailscaleConnected) return undefined;
    const { remoteDaemonCommand } = await import("./daemon-control.ts");
    try {
      await remoteDaemonCommand(agentDir, "remote", ["tailscale-disconnect"]);
      return ROUTE_REMOVED;
    } catch (error) {
      return `Could not remove Aiden's Tailscale route (${error instanceof Error ? error.message : String(error)}). ${ROUTE_BY_HAND}`;
    }
  }
  const { JsonStore } = await import("./state.ts");
  const store = new JsonStore<{ tailscaleOwnership?: AidenTailscaleOwnership; tailscalePendingOutcome?: unknown }>(join(agentDir, "remote.json"), {});
  const saved = await store.load().catch(() => undefined);
  // A first connect or takeover that did not report back leaves a pending outcome before any saved ownership.
  if (saved?.tailscalePendingOutcome) return UNFINISHED_CHANGE;
  const ownership = saved?.tailscaleOwnership;
  if (!ownership?.target) return undefined;
  try {
    const { AidenRemoteTailscaleController, createSystemTailscaleCommandRunner } = await import("../../../main/services/aiden-remote-tailscale.js");
    const runner = offline.runner === undefined ? await createSystemTailscaleCommandRunner() : offline.runner;
    const controller = new AidenRemoteTailscaleController(runner, offline.withRouteLock ? { withRouteLock: offline.withRouteLock } : {});
    await controller.disconnect(ownership.target, ownership, () => store.update((draft) => { delete draft.tailscaleOwnership; }));
    return ROUTE_REMOVED;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Could not remove Aiden's Tailscale route (${tailscaleReason(reason)}). ${ROUTE_BY_HAND}`;
  }
}

function tailscaleReason(code: string): string {
  return code === "tailscale_route_conflict" ? "the route there is no longer Aiden's" : code === "tailscale_not_installed" ? "Tailscale is not installed" : code;
}

/** The Tailscale network a server already uses, read from its saved Remote settings; a reinstall keeps it instead of falling back to local. */
export function savedNetwork(agentDir: string): RemoteNetwork | undefined {
  try {
    const mode: unknown = JSON.parse(readFileSync(join(agentDir, "remote.json"), "utf8"))?.connectionMode;
    return mode === "tailscale" || mode === "both" ? mode : undefined;
  } catch {
    return undefined;
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

/** Which networks really reach the server: none while Remote is off or not listening, the local network in LAN modes, Tailscale only while its route is connected. */
export function reachableNetwork(status: { enabled?: boolean; running?: boolean; connectionMode?: string; tailscaleConnected?: boolean; tailscaleRouteState?: string } | undefined): RemoteNetwork | undefined {
  if (status?.enabled === false || status?.running === false) return undefined;
  // An unfinished route change may have left Aiden's old Serve route live, so the server's reach is unknown.
  if (status?.tailscaleRouteState === "reconciliation_required") return undefined;
  const lan = status?.connectionMode === "lan" || status?.connectionMode === "both";
  const tailscale = (status?.connectionMode === "tailscale" || status?.connectionMode === "both") && status.tailscaleConnected === true;
  return lan && tailscale ? "both" : lan ? "local" : tailscale ? "tailscale" : undefined;
}

/** What `serviceCommand` talks to once the service is installed; tests swap these for fakes. */
export interface ServiceCommandOptions {
  readyTimeoutMs?: number;
  /** Resolves true once the service's server answers on the control socket. */
  ready?: (agentDir: string, timeoutMs: number) => Promise<boolean>;
  /** Sends a `remote` command to the running server. */
  remote?: (args: string[]) => Promise<unknown>;
  /** Shows the pairing code for `transport` until it is used, expires or `signal` aborts; resolves the window's session id when one opened. */
  pair?: (transport: "lan" | "tailscale", signal: AbortSignal) => Promise<string | undefined>;
  /** Whether stdout is a terminal that can show a pairing code. */
  tty?: boolean;
  /** Releases the stopped service profile's owned route. */
  releaseRoute?: (agentDir: string) => Promise<string | undefined>;
}

/** `aiden service ...`. Prints its own output. */
export async function serviceCommand(agentDir: string, args: string[], host: ServiceHost = systemHost(), options: ServiceCommandOptions = {}): Promise<void> {
  if (args[0] !== "install" && args[0] !== "uninstall") return serviceCommandUnlocked(agentDir, args, host, options);
  const release = acquireLease(join(host.leaseHome ?? host.home, ".aiden", "service-manager"));
  try { await serviceCommandUnlocked(agentDir, args, host, options, release); }
  finally { release(); }
}

async function serviceCommandUnlocked(agentDir: string, args: string[], host: ServiceHost, options: ServiceCommandOptions, releaseLease?: () => void): Promise<void> {
  const [action, ...rest] = args;
  const out = (line: string) => process.stdout.write(`${line}\n`);
  if (action === "status" && rest.length === 0) {
    const { daemonStatus } = await import("./serve-lifecycle.ts");
    process.stdout.write(JSON.stringify({ ...serviceStatus(host), server: daemonStatus(agentDir) }, null, 2) + "\n");
    return;
  }
  if (action === "uninstall" && rest.length === 0) {
    const identity = serviceIdentity(host);
    if (!identity.profile) { out("The Aiden service was not installed."); return; }
    if (!sameIdentity(identity, serviceIdentity(host))) throw new Error("The installed Aiden service changed while inspecting it; it was not changed.");
    // Stop the service first: if the manager refuses, the running server keeps its route and a retry can still remove it.
    if (!uninstallService(host, identity.loaded)) {
      out("The Aiden service was not installed.");
      return;
    }
    out("Removed the Aiden service. The server no longer starts on its own.");
    const released = await (options.releaseRoute ?? releaseTailscaleRoute)(identity.profile);
    if (released) out(released);
    return;
  }
  if (action !== "install") throw new Error(SERVICE_USAGE);
  const flags = parseInstallFlags(rest);
  manager(host);
  const entry = realpathSync(process.env.AIDEN_CLI_ENTRY || process.argv[1] || "");
  if (!entry.endsWith(".js")) throw new Error("Build the CLI first (`npm run cli:build`); the service runs the built dist/app/cli.js.");
  const kept = flags.network ? undefined : savedNetwork(agentDir);
  if (kept) out(`Keeping the server's network: ${NETWORK_LABEL[kept]}. Choose another with \`--network\` or \`aiden remote network\`.`);
  const network = flags.network ?? kept ?? await chooseNetwork(host, !!(process.stdin.isTTY && process.stdout.isTTY));

  const identity = serviceIdentity(host);
  if (identity.loaded && (!identity.fileContents || fileProfile(host, identity.fileContents) !== identity.profile)) throw new Error("The loaded Aiden service differs from its installed file; it was not changed.");
  if (!sameIdentity(identity, serviceIdentity(host))) throw new Error("The installed Aiden service changed while inspecting it; it was not changed.");

  // The service takes over the server's lease, so stop a server started by hand.
  const { daemonStatus, stopDaemon } = await import("./serve-lifecycle.ts");
  const stopped = daemonStatus(agentDir).running;
  if (stopped) {
    await stopDaemon(agentDir);
    out("Stopped the server that was already running; the service runs it from now on.");
  }
  let installed: InstallResult | undefined;
  try {
    if (!sameIdentity(identity, serviceIdentity(host))) throw new Error("The installed Aiden service changed while inspecting it; it was not changed.");
    installed = installService(host, { node: process.execPath, entry, agentDir: resolve(agentDir), path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" });
    out(`Installed ${installed.file}.`);
    const logs = installed.manager === "systemd" ? `journalctl --user -u ${SYSTEMD_UNIT}` : join(agentDir, "serve.log");
    const readyMs = options.readyTimeoutMs ?? 30_000;
    if (!await (options.ready ?? waitForServer)(agentDir, readyMs)) throw new Error(`The service did not start the server within ${Math.round(readyMs / 1000)}s. See ${logs}.`);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\.*$/u, ".");
    // The replacement never served: put back the service it replaced (installService already did when the manager refused).
    if (installed?.previous !== undefined) {
      restoreService(host, installed.previous);
      throw new Error(`${message} Put back the service that was installed before.`, { cause: error });
    }
    // A first install that never served is removed, so it can't keep restarting next to a server started by hand.
    if (installed) {
      try {
        uninstallService(host);
      } catch (removeError) {
        throw new Error(`${message} ${removeError instanceof Error ? removeError.message : String(removeError)}`, { cause: error });
      }
      const restart = stopped && !daemonStatus(agentDir).running ? " The server that was running before is stopped; start it again with `aiden serve --daemon`." : "";
      throw new Error(`${message} Removed the service it installed.${restart}`, { cause: error });
    }
    // Say how to get back the server this install stopped, unless something is already serving again.
    if (!stopped || daemonStatus(agentDir).running) throw error;
    throw new Error(`${message} The server that was running before is stopped; start it again with \`aiden serve --daemon\`.`, { cause: error });
  }
  const logs = installed.manager === "systemd" ? `journalctl --user -u ${SYSTEMD_UNIT}` : join(agentDir, "serve.log");

  const remote = options.remote ?? (async (remoteArgs: string[]) => (await import("./daemon-control.ts")).remoteDaemonCommand(agentDir, "remote", remoteArgs));
  let reachable: RemoteNetwork | undefined = network;
  try {
    await remote(["network", network]);
  } catch (error) {
    const status = await remote(["status"]).catch(() => undefined) as Parameters<typeof reachableNetwork>[0];
    reachable = reachableNetwork(status);
    process.stderr.write(`aiden: Could not set up ${NETWORK_LABEL[network]}. ${error instanceof Error ? error.message : String(error)}\n`);
    out(reachable
      ? `For now the server is reachable over ${NETWORK_LABEL[reachable]}. Change it later with \`aiden remote network local|tailscale|both\`.`
      : status?.tailscaleRouteState === "reconciliation_required"
        ? "Aiden's Tailscale route may have an unfinished change, so it is unclear which networks reach the server. Run `aiden remote tailscale-reconcile`, then `aiden remote network local|tailscale|both`."
        : "For now no phone can reach the server. Fix the step above, or use the local network with `aiden remote network local`.");
  }
  // Without lingering a Linux user service does not start at boot; the warning says so instead.
  const boot = installed.manager === "systemd" && installed.warning ? "" : installed.manager === "systemd" ? " It starts again after a reboot." : " It starts again when you log in.";
  out(`The Aiden server is running as a service${reachable ? ` and reachable over ${NETWORK_LABEL[reachable]}` : ""}.${boot}`);
  if (installed.warning) out(installed.warning);
  out(`Logs: ${logs}. Stop it for good with \`aiden service uninstall\`.`);

  releaseLease?.();

  if (!reachable) return;
  if (!flags.pair || !(options.tty ?? process.stdout.isTTY)) {
    out(`Pair a phone with \`aiden remote pair ${reachable === "local" ? "lan" : "tailscale"}\`.`);
    return;
  }
  out("Scan this code with Aiden on your phone. Press Ctrl+C to skip; the server keeps running.");
  const controller = new AbortController();
  const stop = () => controller.abort();
  // Ctrl+C, a dropped SSH session (SIGHUP) or a kill all close the code, since the server keeps running.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, stop);
  try {
    const pair = options.pair ?? (async (transport: "lan" | "tailscale", signal: AbortSignal) => (await import("./serve-command.ts")).showStartupPairing(agentDir, transport, signal));
    const session = await pair(reachable === "local" ? "lan" : "tailscale", controller.signal);
    // Unlike foreground `serve`, the server keeps running after Ctrl+C here, so close the code it was showing.
    if (controller.signal.aborted && session) {
      await remote(["pair-cancel", session]).then(() => out("Closed the pairing code."), () => undefined);
    }
  } finally {
    for (const signal of signals) process.removeListener(signal, stop);
  }
}
