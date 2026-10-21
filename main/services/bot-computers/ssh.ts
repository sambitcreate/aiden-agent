import { chmod, lstat, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import { writeFileAtomic } from "../durable-fs.js";
import { runBoundedProcess, type BoundedProcessResult } from "./bounded-process.js";
import { BotComputerError, type BotComputerGuestCommandResult } from "./types.js";

/** Every clone keeps the base's host key, so one alias covers every Bot computer. */
export const BOT_COMPUTER_HOST_KEY_ALIAS = "aiden-bot-computer";
export const BOT_COMPUTER_GUEST_USER = "lume";

export interface GuestSshPaths {
  privateKey: string;
  publicKey: string;
  knownHosts: string;
  /** Isolated HOME for ssh and ssh-keygen, so `~/.ssh` is never read or written. */
  home: string;
}

/** `<userData>/bot-computers/id_ed25519` (0600), `id_ed25519.pub` and `known_hosts`. */
export function guestSshPaths(root: string): GuestSshPaths {
  return {
    privateKey: path.join(root, "id_ed25519"),
    publicKey: path.join(root, "id_ed25519.pub"),
    knownHosts: path.join(root, "known_hosts"),
    home: path.join(root, "home"),
  };
}

function configPath(value: string): string {
  // ssh splits list options such as UserKnownHostsFile at whitespace, and
  // userData lives under "Application Support"; quote, and refuse what can't be quoted.
  if (!path.isAbsolute(value) || /["\\\0\n]/u.test(value)) {
    throw new BotComputerError("invalid", "The SSH file path can't be used.");
  }
  return `"${value}"`;
}

export interface GuestSshTarget {
  host: string;
  user: "lume";
}

/**
 * System ssh options for the guest: no user config, only Aiden's key, only
 * Aiden's known_hosts entry under a fixed alias (no trust on first use here),
 * no agent, no forwarding, no password prompts.
 */
export function guestSshArgs(target: GuestSshTarget, paths: GuestSshPaths, connectTimeoutSeconds = 10): string[] {
  if (isIP(target.host) === 0) throw new BotComputerError("invalid", "The computer's address is not an IP address.");
  if (target.user !== BOT_COMPUTER_GUEST_USER) throw new BotComputerError("invalid", "Unexpected guest user.");
  return [
    "-F",
    "/dev/null",
    "-i",
    paths.privateKey,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `UserKnownHostsFile=${configPath(paths.knownHosts)}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `HostKeyAlias=${BOT_COMPUTER_HOST_KEY_ALIAS}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "LogLevel=ERROR",
    "-l",
    target.user,
    "--",
    target.host,
  ];
}

/** ssh's environment: a fixed PATH and isolated HOME; no SSH_AUTH_SOCK, so no agent. */
export function guestSshEnvironment(base: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home };
  for (const [key, value] of Object.entries(base)) {
    if (!(key === "LANG" || key === "TMPDIR" || key === "USER" || /^LC_[A-Z]+$/u.test(key))) continue;
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) env[key] = value;
  }
  return env;
}

/**
 * The remote side: `perl -e 'alarm N; exec @ARGV' /bin/sh -c '<command>'`, so
 * the guest ends the command itself even if the connection hangs.
 */
export function guestRemoteCommand(command: string, timeoutMs: number): string {
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    throw new BotComputerError("invalid", "A guest command is required.");
  }
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `perl -e ${quoteRemoteArg(`alarm ${seconds}; exec @ARGV`)} /bin/sh -c ${quoteRemoteArg(command)}`;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof runBoundedProcess>[2],
) => Promise<BoundedProcessResult>;

export interface GuestSshDependencies {
  paths: GuestSshPaths;
  env: Record<string, string>;
  /** `/usr/bin/ssh`; tests point it at a fake. */
  sshCommand?: string;
  run?: ProcessRunner;
}

export async function runGuestCommand(
  target: GuestSshTarget,
  command: string,
  options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; stdin?: string; stdinFile?: string },
  deps: GuestSshDependencies,
): Promise<BotComputerGuestCommandResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new BotComputerError("invalid", "A guest command needs a timeout.");
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    throw new BotComputerError("invalid", "A guest command needs an output limit.");
  }
  const args = [...guestSshArgs(target, deps.paths), guestRemoteCommand(command, options.timeoutMs)];
  const run = deps.run ?? runBoundedProcess;
  const started = performance.now();
  const result = await run(deps.sshCommand ?? "/usr/bin/ssh", args, {
    env: deps.env,
    signal: options.signal,
    // The guest's alarm fires first; this local bound covers a dead connection.
    timeoutMs: options.timeoutMs + 5_000,
    maxStdoutBytes: options.maxOutputBytes,
    maxStderrBytes: Math.min(options.maxOutputBytes, 64 * 1024),
    overflow: "truncate",
    stdin: options.stdin,
    stdinFile: options.stdinFile,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    // Aiden's own clock decides. The guest's alarm starts after the connection does, so it
    // never fires before `timeoutMs` here. How its SIGALRM reaches ssh's exit status varies
    // (sh's 142, OpenSSH's 255 when the login shell exec'd perl, or no status at all), and a
    // command may exit 142 by itself; a failure once the time is up is the timeout.
    timedOut: result.timedOut || (result.exitCode !== 0 && performance.now() - started >= options.timeoutMs),
  };
}

async function regularFile(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Make Aiden's guest key once (`ssh-keygen -t ed25519 -N ""`), bounded, and
 * return the public key line. A half-written pair is replaced.
 */
export async function ensureKeyPair(
  paths: GuestSshPaths,
  options: { env: Record<string, string>; run?: ProcessRunner; keygenCommand?: string; signal?: AbortSignal },
): Promise<string> {
  if ((await regularFile(paths.privateKey)) && (await regularFile(paths.publicKey))) {
    await chmod(paths.privateKey, 0o600);
    return parsePublicKey(await readFile(paths.publicKey, "utf8"));
  }
  await rm(paths.privateKey, { force: true });
  await rm(paths.publicKey, { force: true });
  const run = options.run ?? runBoundedProcess;
  const result = await run(
    options.keygenCommand ?? "/usr/bin/ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", BOT_COMPUTER_HOST_KEY_ALIAS, "-f", paths.privateKey],
    { env: options.env, signal: options.signal, timeoutMs: 15_000, maxStdoutBytes: 16 * 1024, overflow: "fail" },
  );
  if (result.exitCode !== 0 || result.timedOut) {
    throw new BotComputerError("start_failed", "Aiden couldn't make the key for Bot computers.");
  }
  await chmod(paths.privateKey, 0o600);
  return parsePublicKey(await readFile(paths.publicKey, "utf8"));
}

/** One `ssh-ed25519 AAAA… [comment]` line, or a throw. */
export function parsePublicKey(text: string): string {
  const line = text.trim().split(/\r?\n/u)[0] ?? "";
  const match = /^(ssh-ed25519) ([A-Za-z0-9+/]{60,100}={0,2})(?: [\x20-\x7e]{0,100})?$/u.exec(line);
  if (!match) throw new BotComputerError("start_failed", "The Bot computer key is unreadable.");
  return `${match[1]} ${match[2]}`;
}

/**
 * Pin a base's host key under the alias. Every clone presents its base's key,
 * and a new base (Update base) is a fresh install with a key of its own, so
 * the keys already pinned stay: the Bot computers made from an older base, and
 * the working base while a newer one is built beside it, must stay reachable.
 * Remove everything deletes the file.
 */
export async function writeKnownHost(paths: GuestSshPaths, hostPublicKey: string): Promise<void> {
  const prefix = `${BOT_COMPUTER_HOST_KEY_ALIAS} `;
  const line = `${prefix}${parsePublicKey(hostPublicKey)}`;
  let pinned: string[] = [];
  try {
    pinned = (await readFile(paths.knownHosts, "utf8")).split(/\r?\n/u).filter((entry) => {
      if (!entry.startsWith(prefix)) return false;
      try {
        return `${prefix}${parsePublicKey(entry.slice(prefix.length))}` === entry;
      } catch {
        return false;
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = pinned.includes(line) ? pinned : [...pinned, line];
  await writeFileAtomic(paths.knownHosts, `${lines.join("\n")}\n`, { mode: 0o600, mkdirMode: 0o700 });
}
