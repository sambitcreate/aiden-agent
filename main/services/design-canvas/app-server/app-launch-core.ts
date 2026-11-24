/**
 * Pure rules for running a detected web app in design mode (plan 2b D5–D9):
 * the run argv and environment, which port is ready, which sockets are
 * exposed, whether to install, and the launch fingerprint's canonical form.
 * No disk, process or Electron access.
 */
import { createHash } from "node:crypto";
import { agentShellCommandEnvironment } from "../../agent-command-environment.js";
import { isLoopbackAddress } from "../../follow-through/listening-ports.js";
import { nodeCommandEnvironment } from "../../node-toolchain.js";
import {
  runScriptCommand,
  scriptDevCommand,
  scriptTextWords,
  type DetectedApp,
  type FrameworkId,
  type ManagerCommand,
  type PackageManagerName,
} from "./app-server-core.js";

/** The Node inspector and Vite's hot-reload socket: never the app's address. */
const NEVER_READY_PORTS = new Set([9229, 24678]);
const LOOPBACK_HOST = "127.0.0.1";

const TELEMETRY_OFF: ReadonlyArray<readonly [string, string]> = [
  ["NEXT_TELEMETRY_DISABLED", "1"],
  ["ASTRO_TELEMETRY_DISABLED", "1"],
  ["NUXT_TELEMETRY_DISABLED", "1"],
  ["GATSBY_TELEMETRY_DISABLED", "1"],
  ["NG_CLI_ANALYTICS", "false"],
  ["DO_NOT_TRACK", "1"],
];

type FlagStyle = "vite" | "host-port" | "next" | "gatsby" | "env";

/** How a framework CLI takes its host and port, by the dev command the script runs. */
function flagStyle(command: readonly string[]): FlagStyle {
  const key = command.join(" ");
  if (key === "vite" || key === "react-router dev" || key === "remix vite:dev") return "vite";
  if (key === "astro dev" || key === "nuxt dev" || key === "nuxi dev" || key === "ng serve" || key === "vinxi dev") return "host-port";
  if (key === "next dev") return "next";
  if (key === "gatsby develop") return "gatsby";
  // Classic `remix dev`, `react-scripts start` and Remix 3's `node --watch` read HOST and PORT.
  return "env";
}

/** The framework dev command the script runs, when it runs the framework's own CLI. */
export function runsFrameworkCli(scriptText: string, framework: FrameworkId | undefined): readonly string[] | undefined {
  return framework ? scriptDevCommand(scriptText, framework) : undefined;
}

function hasFlag(words: readonly string[], flags: readonly string[]): boolean {
  return words.some((word) => flags.some((flag) => word === flag || word.startsWith(`${flag}=`)));
}

export function scriptSetsHost(scriptText: string): boolean {
  return hasFlag(scriptTextWords(scriptText), ["--host", "--hostname", "-H"]);
}

export function scriptSetsPort(scriptText: string): boolean {
  return hasFlag(scriptTextWords(scriptText), ["--port", "-p", "--strictPort"]);
}

export interface LaunchPlanOptions {
  /** Node's and the manager's bin folders, put first on PATH. */
  binDirs: readonly string[];
  /** Provider key variables to remove (`providerKeyNames`). */
  providerKeys: Iterable<string>;
  platform?: NodeJS.Platform;
}

export interface LaunchPlan {
  /** Arguments appended to the script, only when it runs the framework's own CLI. */
  extraArgs: string[];
  /** `<manager> run <script> [--] <extraArgs…>`. */
  run: ManagerCommand;
  env: NodeJS.ProcessEnv;
}

/** The variables removed from a launch environment, beyond provider keys. */
function scrubbed(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    name === "NODE_ENV" ||
    name === "INIT_CWD" ||
    upper.startsWith("ELECTRON_") ||
    upper.startsWith("AIDEN_") ||
    name.startsWith("npm_") ||
    name.toLowerCase().startsWith("npm_config_")
  );
}

/**
 * The environment a design job's install and server run with (D7): Aiden's
 * agent shell environment, Node's and the manager's folders first on PATH,
 * then scrubbed of `NODE_ENV`, Electron's, Aiden's and npm's own variables,
 * `INIT_CWD` and every provider key pi-ai knows. Tooling tokens stay.
 */
export function launchEnvironment(env: NodeJS.ProcessEnv, options: LaunchPlanOptions): NodeJS.ProcessEnv {
  const base = nodeCommandEnvironment(agentShellCommandEnvironment(env, options.platform ?? process.platform), options.binDirs);
  const providerKeys = new Set(options.providerKeys);
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || scrubbed(name) || providerKeys.has(name)) continue;
    result[name] = value;
  }
  result.BROWSER = "none";
  result.FORCE_COLOR = "0";
  result.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  for (const [name, value] of TELEMETRY_OFF) {
    if (result[name] === undefined) result[name] = value;
  }
  return result;
}

/**
 * The run argv and environment (D7). Flags go to the framework's own CLI
 * only, never twice: a script that names its own host or port keeps it.
 * Everything else gets `HOST` and `PORT`.
 */
export function launchPlan(
  app: Pick<DetectedApp, "framework" | "script" | "packageManager">,
  scripts: Readonly<Record<string, string | undefined>>,
  port: number,
  env: NodeJS.ProcessEnv,
  options: LaunchPlanOptions,
): LaunchPlan {
  const script = app.script;
  if (!script) throw new Error("This app has no dev script to run.");
  const text = scripts[script] ?? "";
  const command = runsFrameworkCli(text, app.framework);
  const style = command ? flagStyle(command) : "env";
  const setsHost = scriptSetsHost(text);
  const setsPort = scriptSetsPort(text);
  const portText = String(port);
  const extraArgs: string[] = [];
  const launchEnv = launchEnvironment(env, options);
  switch (style) {
    case "vite":
      if (!setsHost) extraArgs.push("--host", LOOPBACK_HOST);
      if (!setsPort) extraArgs.push("--port", portText, "--strictPort");
      break;
    case "host-port":
      if (!setsHost) extraArgs.push("--host", LOOPBACK_HOST);
      if (!setsPort) extraArgs.push("--port", portText);
      break;
    case "next":
      if (!setsHost) extraArgs.push("--hostname", LOOPBACK_HOST);
      if (!setsPort) extraArgs.push("--port", portText);
      launchEnv.PORT = portText;
      break;
    case "gatsby":
      if (!setsHost) extraArgs.push("-H", LOOPBACK_HOST);
      if (!setsPort) extraArgs.push("-p", portText);
      break;
    case "env":
      launchEnv.HOST = LOOPBACK_HOST;
      launchEnv.PORT = portText;
      break;
  }
  return { extraArgs, run: runScriptCommand(app.packageManager, script, extraArgs), env: launchEnv };
}

/** Every provider key variable pi-ai knows that is set in `env`. */
export function providerKeyNames(
  env: NodeJS.ProcessEnv,
  providers: readonly string[],
  findEnvKeys: (provider: string, env: Record<string, string | undefined>) => string[] | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const provider of providers) {
    for (const name of findEnvKeys(provider, env) ?? []) names.add(name);
  }
  return names;
}

/**
 * The port the server is ready on (D8): a printed loopback URL's port the job
 * holds, else the planned port when held, else its only held port. A port no
 * process of the job holds never counts.
 */
export function readyPort(input: { owned: readonly number[]; printed: readonly number[]; planned: number }): number | undefined {
  const owned = [...new Set(input.owned)].filter((port) => !NEVER_READY_PORTS.has(port));
  const printed = input.printed.find((port) => owned.includes(port));
  if (printed !== undefined) return printed;
  if (owned.includes(input.planned)) return input.planned;
  return owned.length === 1 ? owned[0] : undefined;
}

/** The sockets not on loopback (D9): wildcards, LAN and any other address. */
export function exposedSockets<T extends { address: string }>(sockets: readonly T[]): T[] {
  return sockets.filter((socket) => !isLoopbackAddress(socket.address));
}

export interface InstallRecordLike {
  state: "started" | "done";
  manager: PackageManagerName;
  lockHash: string;
}

/**
 * D6. Never installs in a parent repo. Otherwise installs for a missing
 * `node_modules`, an unfinished or stale Aiden install, or on request; a
 * `node_modules` the person made, with no record, is kept.
 */
export function needsInstall(input: {
  installed: boolean;
  lockfileLevelsUp: number;
  record: InstallRecordLike | undefined;
  lockHash: string;
  manager: PackageManagerName;
  forced: boolean;
}): "install" | "skip" | "outside-workspace" {
  if (input.lockfileLevelsUp >= 1) return input.installed ? "skip" : "outside-workspace";
  if (input.forced || !input.installed) return "install";
  const record = input.record;
  if (!record) return "skip";
  if (record.state === "started") return "install";
  return record.lockHash !== input.lockHash || record.manager !== input.manager ? "install" : "skip";
}

/** What a launch consent covers (D5); every value comes from disk and detection, read now. */
export interface LaunchSurface {
  appRoot: string;
  installRoot: string;
  lockfileLevelsUp: number;
  manager: PackageManagerName | null;
  yarn?: "classic" | "berry";
  script: string;
  /** `app:<name>` and `install:<name>` script texts; `null` for a script that isn't there. */
  scripts: Readonly<Record<string, string | null>>;
  packageManager: { app: unknown; install: unknown };
  devEngines: { app: unknown; install: unknown };
  /** The install argv by manager name, or null when none applies. */
  installArgv: readonly string[] | null;
  /** The run argv by manager name, without the port and host arguments. */
  runArgv: readonly string[];
  /** `[relative name, sha256 | "missing"]`. */
  files: ReadonlyArray<readonly [string, string]>;
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

const rawJson = (value: unknown) => (value === undefined ? null : JSON.stringify(canonical(value)));

/** The canonical object the fingerprint hashes: names sorted, absent values `null`. */
export function launchFingerprintInput(surface: LaunchSurface): Record<string, unknown> {
  return {
    v: 2,
    appRoot: surface.appRoot,
    installRoot: surface.installRoot,
    lockfileLevelsUp: surface.lockfileLevelsUp,
    manager: surface.manager,
    yarn: surface.yarn ?? null,
    script: surface.script,
    scripts: Object.keys(surface.scripts)
      .sort()
      .map((name) => [name, surface.scripts[name] ?? null]),
    packageManager: { app: rawJson(surface.packageManager.app), install: rawJson(surface.packageManager.install) },
    devEngines: { app: rawJson(surface.devEngines.app), install: rawJson(surface.devEngines.install) },
    installArgv: surface.installArgv ? [...surface.installArgv] : null,
    runArgv: [...surface.runArgv],
    files: [...surface.files].map(([name, hash]) => [name, hash]).sort(([left], [right]) => (left! < right! ? -1 : left! > right! ? 1 : 0)),
  };
}

export function launchFingerprint(surface: LaunchSurface): string {
  return createHash("sha256").update(JSON.stringify(canonical(launchFingerprintInput(surface)))).digest("hex");
}

/** Node's EADDRINUSE, Vite's "Port … is already in use", CRA's "Something is already running on port". */
export function isAddressInUse(tail: string): boolean {
  return /EADDRINUSE|address already in use|is already in use|Something is already running on port/iu.test(tail);
}

/** The hint for a crash that looks like missing dependencies. */
export function missingModuleHint(tail: string): string | undefined {
  return /Cannot find module|ERR_MODULE_NOT_FOUND|Module not found|Failed to resolve import/u.test(tail)
    ? "Try design_app restart with install: true."
    : undefined;
}

/** The last `lines` lines, then at most the last `maxChars` characters. */
export function lastLines(text: string, lines: number, maxChars: number): string {
  const kept = text.replace(/\s+$/u, "").split("\n").slice(-Math.max(0, lines)).join("\n");
  return kept.length > maxChars ? kept.slice(-maxChars) : kept;
}
