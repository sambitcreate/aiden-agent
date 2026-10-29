// Durable per-profile transport lease with stale-owner recovery.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { AIDEN_CONFIG_DIR_ENV, AIDEN_DIR_NAME, aidenConfigDir } from "../aiden-config-dir.js";
import { writeFileAtomic } from "../durable-fs.js";

interface OwnershipRecord {
  pid: number;
  generation: string;
  acquiredAt: number;
  heartbeatAt: number;
}

function readRecord(file: string): OwnershipRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<OwnershipRecord>;
    if (typeof value.pid !== "number" || typeof value.generation !== "string" || typeof value.heartbeatAt !== "number" || typeof value.acquiredAt !== "number") return undefined;
    return value as OwnershipRecord;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as { code?: string }).code === "EPERM";
  }
}

export function createTelegramOwnershipLease(options: {
  root(): string;
  profile: string;
  now?: () => number;
  staleMs?: number;
}) {
  const now = options.now ?? Date.now;
  const generation = randomUUID();
  const directory = path.join(options.root(), "telegram-owners");
  const file = path.join(directory, `${options.profile}.json`);
  const staleMs = options.staleMs ?? 10_000;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Bumped on every acquire and release so a heartbeat write that finishes
  // after release can tell that it published a lease nobody holds any more.
  let epoch = 0;
  let refreshing = false;

  function owns(): boolean {
    const record = readRecord(file);
    return record?.pid === process.pid && record.generation === generation;
  }

  function claim(record: OwnershipRecord): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const descriptor = openSync(file, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(record));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  async function refresh(): Promise<void> {
    // Heartbeats never overlap, so a slow disk cannot queue an unbounded backlog.
    if (refreshing) return;
    refreshing = true;
    const startedIn = epoch;
    try {
      const current = readRecord(file);
      if (!current || current.pid !== process.pid || current.generation !== generation) return;
      // A unique staging name per write: a crash-left stage can never wedge
      // later heartbeats, and the heartbeat no longer blocks the main thread.
      // The record is ephemeral liveness state, so it skips fsync.
      await writeFileAtomic(file, JSON.stringify({ ...current, heartbeatAt: now() }), {
        mode: 0o600,
        fsync: false,
      });
      if (epoch !== startedIn && !heartbeat && owns()) unlinkSync(file);
    } catch {
      // A heartbeat must never crash the app. Losing ownership is detected by
      // owns() and the next launch can quarantine a stale or malformed lease.
    } finally {
      refreshing = false;
    }
  }

  return {
    acquire(): { acquired: boolean; recovered: boolean; ownerPid?: number } {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      let recovered = false;
      if (existsSync(file)) {
        const current = readRecord(file);
        const stale = !current || (now() - current.heartbeatAt > staleMs && !processAlive(current.pid));
        if (!stale) return { acquired: false, recovered: false, ownerPid: current?.pid };
        renameSync(file, path.join(directory, `${options.profile}.recovered-${now()}-${randomUUID()}.json`));
        recovered = true;
      }
      const timestamp = now();
      claim({ pid: process.pid, generation, acquiredAt: timestamp, heartbeatAt: timestamp });
      epoch += 1;
      heartbeat = setInterval(() => void refresh(), Math.max(1_000, Math.floor(staleMs / 4)));
      heartbeat.unref?.();
      return { acquired: true, recovered };
    },
    release(): void {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      epoch += 1;
      if (owns()) {
        try {
          unlinkSync(file);
        } catch {
          // Already removed or externally unavailable; this process no longer
          // has a lease to release.
        }
      }
    },
    owns,
  };
}

/** The public numeric bot id that prefixes a Bot API token (`<botId>:<secret>`). */
export function telegramBotIdFromToken(token: string | null | undefined): number | undefined {
  const match = /^(\d{1,15}):\S+$/u.exec(token?.trim() ?? "");
  const id = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Where bot-keyed transport leases live, shared by the desktop app and the CLI
 * so both cannot long-poll the same bot at once.
 *
 * - Desktop: `<aidenConfigDir>` (defaults to `~/.aiden`).
 * - CLI: the same when the agent dir is the default `~/.aiden/agent` or when
 *   `AIDEN_CONFIG_DIR` is set; otherwise the agent dir itself, so sandboxed
 *   and test agent dirs never claim the real shared root.
 */
export function telegramSharedOwnershipRoot(agentDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env[AIDEN_CONFIG_DIR_ENV]?.trim() || agentDir === undefined) return aidenConfigDir(env);
  const home = path.join(os.homedir(), AIDEN_DIR_NAME);
  const canonical = (file: string): string => {
    try {
      return realpathSync.native(file);
    } catch {
      return path.resolve(file);
    }
  };
  const defaultAgent = path.join(home, "agent");
  return path.resolve(agentDir) === defaultAgent || canonical(agentDir) === canonical(defaultAgent)
    ? home
    : path.resolve(agentDir);
}

export interface TelegramTransportClaim {
  acquired: boolean;
  recovered: boolean;
  ownerPid?: number;
  /** Which lease refused: this profile's, or the bot token's shared one. */
  scope?: "profile" | "bot";
}

/**
 * The transport claim a poller holds: its profile lease plus a lease keyed by
 * the token's bot id under the shared root, so a desktop profile and
 * `aiden serve` (or two desktop profiles) never poll the same bot together.
 */
export function createTelegramTransportOwnership(options: {
  profileRoot(): string;
  profile: string;
  sharedRoot(): string;
  getToken(): Promise<string | null>;
  now?: () => number;
  staleMs?: number;
}) {
  const timing = { ...(options.now ? { now: options.now } : {}), ...(options.staleMs ? { staleMs: options.staleMs } : {}) };
  const profileLease = createTelegramOwnershipLease({ root: options.profileRoot, profile: options.profile, ...timing });
  let botLease: ReturnType<typeof createTelegramOwnershipLease> | undefined;

  function release(): void {
    botLease?.release();
    botLease = undefined;
    profileLease.release();
  }

  return {
    async acquire(): Promise<TelegramTransportClaim> {
      const botId = telegramBotIdFromToken(await options.getToken());
      const profile = profileLease.acquire();
      if (!profile.acquired) return { ...profile, scope: "profile" };
      if (botId === undefined) return profile;
      try {
        const lease = createTelegramOwnershipLease({ root: options.sharedRoot, profile: `bot-${botId}`, ...timing });
        const bot = lease.acquire();
        if (!bot.acquired) {
          profileLease.release();
          return { ...bot, scope: "bot" };
        }
        botLease = lease;
        return { acquired: true, recovered: profile.recovered || bot.recovered };
      } catch (cause) {
        profileLease.release();
        throw cause;
      }
    },
    release,
  };
}
