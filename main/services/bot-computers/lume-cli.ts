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
 *
 * `ssh` and `cp` use Lume's default preset credentials without ever placing a
 * rotated secret on argv, so they apply only before guest SSH hardening turns
 * off password login; post-hardening commands and file copies use Aiden's own
 * key-authenticated, host-key-pinned `/usr/bin/ssh`.
 */
export type LumeCommand =
  | {
      op: "create";
      os: "linux";
      name: string;
      cpu?: number;
      memoryGb?: number;
      diskSizeGb?: number;
      display?: string;
    }
  | { op: "clone"; source: string; target: string }
  | {
      op: "run";
      name: string;
      vncPassword: string;
      sharedDir: string;
      logFile?: string;
      /** For Linux VMs only: read-only disk image / ISO to attach (e.g. cloud-init `cidata` ISO). */
      mount?: string;
      /** Optional override path to the primary disk image file (`--disk-path`). */
      diskPath?: string;
    }
  | { op: "get"; name: string }
  | { op: "list" }
  | { op: "stop"; name: string; force?: boolean; timeoutSeconds?: number }
  | { op: "delete"; name: string }
  | { op: "ssh"; name: string; command: string; timeoutSeconds?: number }
  | {
      op: "cp";
      name: string;
      direction: "to_guest" | "from_guest";
      localPath: string;
      remotePath: string;
      recursive?: boolean;
      timeoutSeconds?: number;
    };

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
      if (command.os !== "linux") {
        throw new BotComputerError("invalid", "Only Linux Bot computers can be created.");
      }
      const args = ["create", requireName(command.name), "--os", "linux"];
      if (command.cpu !== undefined) {
        if (!Number.isSafeInteger(command.cpu) || command.cpu < 1 || command.cpu > 32) {
          throw new BotComputerError("invalid", "Linux VM CPU count must be a whole number between 1 and 32.");
        }
        args.push("--cpu", String(command.cpu));
      }
      if (command.memoryGb !== undefined) {
        if (!Number.isSafeInteger(command.memoryGb) || command.memoryGb < 2 || command.memoryGb > 128) {
          throw new BotComputerError("invalid", "Linux VM memory must be a whole number of GB (at least 2 GB).");
        }
        args.push("--memory", `${command.memoryGb}GB`);
      }
      if (command.diskSizeGb !== undefined) {
        // Lume 0.8.0 enforces a 10 GB minimum for Linux VMs (Create.swift).
        if (!Number.isSafeInteger(command.diskSizeGb) || command.diskSizeGb < 10 || command.diskSizeGb > 1024) {
          throw new BotComputerError("invalid", "Linux VM disk size must be a whole number of GB (at least 10 GB).");
        }
        args.push("--disk-size", `${command.diskSizeGb}GB`);
      }
      if (command.display !== undefined) {
        if (!/^\d{3,4}x\d{3,4}$/u.test(command.display)) {
          throw new BotComputerError("invalid", "VM display resolution must be WIDTHxHEIGHT.");
        }
        args.push("--display", command.display);
      }
      args.push("--storage", storage);
      return args;
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
        "--no-audio-device",
        "--no-clipboard-device",
        "--vnc-password",
        command.vncPassword,
        "--shared-dir",
        `${sharedDir}:rw`,
        "--storage",
        storage,
      ];
      if (command.mount !== undefined) args.push("--mount", requireAbsolute(command.mount, "The mount image"));
      if (command.diskPath !== undefined) args.push("--disk-path", requireAbsolute(command.diskPath, "The disk image"));
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
    case "cp": {
      const localPath = requireAbsolute(command.localPath, "The host path");
      if (typeof command.remotePath !== "string" || command.remotePath.length === 0 || /[\0\r\n]/u.test(command.remotePath)) {
        throw new BotComputerError("invalid", "A guest path is required.");
      }
      if (command.direction !== "to_guest" && command.direction !== "from_guest") {
        throw new BotComputerError("invalid", "Unknown copy direction.");
      }
      const remoteEndpoint = `${requireName(command.name)}:${command.remotePath}`;
      const [source, destination] = command.direction === "to_guest" ? [localPath, remoteEndpoint] : [remoteEndpoint, localPath];
      const args = ["cp", "--storage", storage, "--timeout", requireSeconds(command.timeoutSeconds, 600)];
      if (command.recursive) args.push("--recursive");
      args.push(source, destination);
      return args;
    }
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
    /** Lume has started (it never runs when it can't be started at all). */
    onSpawn?: () => void;
    /** A cancel ends Lume at once (SIGKILL), so it does nothing more. */
    killOnAbort?: boolean;
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
    onSpawn: options.onSpawn,
    killOnAbort: options.killOnAbort,
  });
  if (result.timedOut) {
    throw new BotComputerError("lume_failed", `Lume did not finish ${command.op} in time.`);
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
