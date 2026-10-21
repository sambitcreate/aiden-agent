import path from "node:path";
import { runBoundedProcess } from "./bounded-process.js";
import { BotComputerError } from "./types.js";
import { isLumeVmNameSafe } from "./vm-names.js";

/** How to start Lume: the vendored binary, or `node lume-fake.mjs` in tests. Never a PATH lookup. */
export interface LumeInvocation {
  command: string;
  prefixArgs?: readonly string[];
}

/**
 * Every Lume operation Aiden runs. There is deliberately no `serve` (an
 * unauthenticated HTTP API on localhost:7777), `pull`, `update`, `push`,
 * `ipsw` or `setup`: none of them can be expressed.
 */
export type LumeCommand =
  | { op: "create"; name: string; ipsw: string; unattended: "tahoe" }
  | { op: "clone"; source: string; target: string }
  | { op: "run"; name: string; vncPassword: string; sharedDir: string; logFile?: string }
  | { op: "get"; name: string }
  | { op: "list" }
  | { op: "stop"; name: string; force?: boolean; timeoutSeconds?: number }
  | { op: "delete"; name: string }
  | { op: "ssh"; name: string; command: string; timeoutSeconds?: number };

function requireAbsolute(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new BotComputerError("invalid", `${what} must be an absolute path.`);
  }
  return value;
}

function requireName(name: string): string {
  // `lume run name:tag` pulls from a registry when no local VM matches, so
  // only Aiden's own fixed-shape names may reach argv.
  if (!isLumeVmNameSafe(name)) throw new BotComputerError("invalid", "That is not one of Aiden's computers.");
  return name;
}

function requireSeconds(value: number | undefined, fallback: number): string {
  const seconds = value ?? fallback;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 3_600) {
    throw new BotComputerError("invalid", "A Lume timeout must be whole seconds.");
  }
  return String(seconds);
}

/**
 * The argv for one operation. Every command names Aiden's storage directory
 * (clone names it twice, as `--source-storage` and `--dest-storage`), so the
 * person's own `~/.lume` VMs are never touched.
 */
export function lumeArgs(command: LumeCommand, storage: string): string[] {
  requireAbsolute(storage, "Aiden's VM storage");
  switch (command.op) {
    case "create": {
      const ipsw = requireAbsolute(command.ipsw, "The restore image");
      if (command.unattended !== "tahoe") throw new BotComputerError("invalid", "Unknown unattended preset.");
      return [
        "create",
        requireName(command.name),
        "--os",
        "macOS",
        "--ipsw",
        ipsw,
        "--unattended",
        command.unattended,
        "--storage",
        storage,
      ];
    }
    case "clone":
      return [
        "clone",
        requireName(command.source),
        requireName(command.target),
        "--source-storage",
        storage,
        "--dest-storage",
        storage,
      ];
    case "run": {
      const sharedDir = requireAbsolute(command.sharedDir, "The shared folder");
      // Lume splits `--shared-dir` at the first ':' to read the ro/rw tag.
      if (sharedDir.includes(":")) {
        throw new BotComputerError("invalid", "The shared folder path can't contain a colon.");
      }
      if (!/^[A-Za-z0-9-]{8,64}$/u.test(command.vncPassword)) {
        throw new BotComputerError("invalid", "The VNC password has an unexpected shape.");
      }
      const args = [
        "run",
        requireName(command.name),
        "--detach",
        "--display",
        "none",
        "--vnc-password",
        command.vncPassword,
        "--shared-dir",
        `${sharedDir}:rw`,
        "--storage",
        storage,
      ];
      if (command.logFile !== undefined) args.push("--log-file", requireAbsolute(command.logFile, "The Lume log"));
      return args;
    }
    case "get":
      return ["get", requireName(command.name), "--format", "json", "--storage", storage];
    case "list":
      return ["ls", "--format", "json", "--storage", storage];
    case "stop": {
      const args = ["stop", requireName(command.name), "--storage", storage, "--timeout", requireSeconds(command.timeoutSeconds, 30)];
      if (command.force) args.push("--force");
      return args;
    }
    case "delete":
      // Without --force Lume asks on stdin, which Aiden never answers.
      return ["delete", requireName(command.name), "--force", "--storage", storage];
    case "ssh":
      if (typeof command.command !== "string" || command.command.length === 0 || command.command.includes("\0")) {
        throw new BotComputerError("invalid", "A guest command is required.");
      }
      // Options precede the name: everything after it is the remote command.
      return [
        "ssh",
        "--storage",
        storage,
        "--timeout",
        requireSeconds(command.timeoutSeconds, 60),
        requireName(command.name),
        command.command,
      ];
    default: {
      const unknown: never = command;
      throw new BotComputerError("invalid", `Unknown Lume operation: ${String((unknown as { op?: unknown }).op)}`);
    }
  }
}

/** Environment every Lume child gets. Telemetry and update checks are off. */
export const LUME_PRIVACY_ENVIRONMENT = Object.freeze({
  LUME_TELEMETRY_ENABLED: "false",
  LUME_UPDATE_CHECK: "false",
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
});

const PASSED_THROUGH = new Set(["LANG", "TMPDIR", "USER", "__CF_USER_TEXT_ENCODING"]);

/**
 * A fixed environment: a system PATH, the privacy switches, and an isolated
 * home under Aiden's userData so Lume's config, caches, telemetry id and logs
 * never land in the person's `~/.lume` or `~/.config/lume`. Only the locale,
 * TMPDIR and USER come from the parent.
 */
export function lumeEnvironment(base: NodeJS.ProcessEnv, home: string): Record<string, string> {
  requireAbsolute(home, "Lume's isolated home");
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    ...LUME_PRIVACY_ENVIRONMENT,
    // Lume's logger prints to stdout; keep it to errors so JSON stays parseable.
    LUME_LOG_LEVEL: "error",
    HOME: home,
    // Foundation resolves `~` from the account record, not $HOME, unless this
    // is set (assumed, confirm on the owner Mac that ~/.lume stays untouched).
    CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    LUME_HOME: path.join(home, ".lume"),
  };
  for (const [key, value] of Object.entries(base)) {
    if (!(PASSED_THROUGH.has(key) || /^LC_[A-Z]+$/u.test(key))) continue;
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) env[key] = value;
  }
  return env;
}

export interface LumeRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run one Lume operation, bounded in time and output. A non-zero exit is a result, not a throw. */
export async function runLume(
  invocation: LumeInvocation,
  command: LumeCommand,
  options: {
    storage: string;
    env: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs: number;
    maxStdoutBytes?: number;
  },
): Promise<LumeRunResult> {
  if (options.env.LUME_TELEMETRY_ENABLED !== "false" || options.env.LUME_UPDATE_CHECK !== "false") {
    throw new BotComputerError("invalid", "Lume must run with telemetry and update checks off.");
  }
  const args = [...(invocation.prefixArgs ?? []), ...lumeArgs(command, options.storage)];
  const result = await runBoundedProcess(invocation.command, args, {
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: options.maxStdoutBytes ?? 1024 * 1024,
    maxStderrBytes: 64 * 1024,
    overflow: "fail",
  });
  if (result.timedOut) {
    throw new BotComputerError("lume_failed", `Lume did not finish ${command.op} in time.`);
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
