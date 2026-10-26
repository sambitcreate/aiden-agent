// One Pi Durable harness per Bot, hosted in Electron main.
//
// Each Bot owns `<profile>/bots/<botId>/session.sqlite`; its conversation is
// the harness's root conversation, so the storage path derived from the Bot
// id is the conversation's whole identity. Harnesses open lazily, close after
// an idle period with no live work, and are all owned under one exclusive
// profile lock (see profile-lock.ts).
//
// Recovery is explicit. Opening and inspecting a harness never starts its
// task scheduler: this module never calls `resume()`, `submit()`, `wait*()`
// or anything else that asks for progress, except `abort()` while destroying
// a Bot. Interrupted work stays paused until the user chooses Resume.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  Harness,
  type Conversation,
  type HarnessInspection,
  type HarnessSettings,
  type Registry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acquireBotProfileLock, BOT_PROFILE_LOCK_FILE, BOT_PROFILE_GUARD_FILE } from "./profile-lock.js";
import { AIDEN_PI_CLIENT_IDENTITY } from "../pi-client-identity.js";

export const BOT_SESSION_FILE = "session.sqlite";
/**
 * Recovered work never runs until the person chooses Resume, so the person
 * already decides whether a task a crash cut off runs again. Pi Durable's
 * crash-loop guard (default 5, counted at each open) would instead park the
 * task, and nothing in Aiden runs a parked task again.
 */
export const BOT_HARNESS_SETTINGS: HarnessSettings = Object.freeze({ restartLimit: Infinity });
export const DEFAULT_BOT_IDLE_CLOSE_MS = 600_000;
const DESTROY_ABORT_TIMEOUT_MS = 10_000;
/** How long `suspend` waits for a harness to close: the same budget as quit. */
export const DEFAULT_BOT_SUSPEND_TIMEOUT_MS = 5_000;
const MAX_BOT_ID_LENGTH = 200;
const PLAIN_DIRECTORY_CHARACTER = /^[A-Za-z0-9_-]$/u;
const ENCODED_DIRECTORY_NAME = /^(?:[A-Za-z0-9_-]|~[0-9a-f]{2})+$/u;

export interface BotHarnessHostOptions {
  /** Host-owned native helper; CLI bundles it beside its entry point. */
  leaseHelperPath?: string;
  /** The profile directory; Bot sessions live under `<profileDir>/bots/`. */
  profileDir: string;
  /**
   * Installed on every open, before anything can run (`createBotRegistry`).
   * A registry with `attachHarness` is bound to the harness it serves.
   */
  buildRegistry(botId: string): Registry & { attachHarness?(harness: Harness): void };
  /** pi-ai model access for generation: one view for every Bot, or each Bot's own. */
  models: Models | ((botId: string) => Models);
  settings?: HarnessSettings;
  idleCloseMs?: number;
  now?: () => number;
  /** Receives extension failures that do not fail an operation. */
  onReport?(botId: string, error: unknown): void;
}

export interface BotHarnessOpenResult {
  harness: Harness;
  /** The Bot's one conversation: the harness root. */
  conversation: Conversation;
  /**
   * Set once, on the open that replaced an unreadable `session.sqlite`: the
   * name it was moved aside to. The caller shows a one-time notice.
   */
  recoveredCorruptFile?: string;
}

export interface BotInterruption {
  botId: string;
  /** Unfinished input submission, as a decimal string. */
  submissionId: string;
}

export interface BotHarnessHost {
  open(botId: string): Promise<BotHarnessOpenResult>;
  /** Restart the idle timer, for example on every submit. */
  touch(botId: string): void;
  /** Inspect an open (or openable) Bot without scheduling anything. */
  inspect(botId: string): Promise<HarnessInspection>;
  /** Startup scan: every Bot with unfinished work. Never resumes anything. */
  interruptedBots(): Promise<BotInterruption[]>;
  close(botId: string): Promise<void>;
  /**
   * Pause support: close the Bot's harness even while a turn is live, bounded
   * like quit. Closing signals every task and joins it without writing, so a
   * running turn stays placed and is reported `interrupted` once reopened;
   * nothing is aborted or dismissed. `timed_out`: a task ignored its signal;
   * the close keeps running, and later opens of this Bot wait behind it.
   * Unlike `destroy`, the Bot can be reopened at once.
   */
  suspend(botId: string, timeoutMs?: number): Promise<"closed" | "timed_out" | "not_open">;
  /** Abort the live submission, close, and remove `bots/<id>/`. */
  destroy(botId: string): Promise<void>;
  /** Remove Bot directories with no known Bot record. Returns the removed directory names. */
  sweepOrphans(knownBotIds: ReadonlySet<string>): Promise<string[]>;
  isOpen(botId: string): boolean;
  shutdown(): Promise<void>;
}

export type BotHarnessHostUnavailable = { unavailable: "held_by_live_process"; pid: number };

export class BotDeletedError extends Error {
  constructor(readonly botId: string) {
    super(`Bot ${botId} was deleted`);
    this.name = "BotDeletedError";
  }
}

export class BotHarnessHostClosedError extends Error {
  constructor() {
    super("The Bot runtime is shut down");
    this.name = "BotHarnessHostClosedError";
  }
}

export function isBotHarnessHostUnavailable(
  value: BotHarnessHost | BotHarnessHostUnavailable,
): value is BotHarnessHostUnavailable {
  return "unavailable" in value;
}

export function assertBotId(botId: string): void {
  // Bot ids look like `bot:<uuid>`; anything else must still be one printable token.
  const unsafe = [...botId].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f || character === "/" || character === "\\";
  });
  if (botId.length === 0 || botId.length > MAX_BOT_ID_LENGTH || unsafe) {
    throw new Error(`Invalid Bot id: ${JSON.stringify(botId)}`);
  }
}

/**
 * The directory name of a Bot: its id with every character outside
 * `[A-Za-z0-9_-]` written as `~xx` UTF-8 bytes (`bot:1` -> `bot~3a1`). It is
 * a single safe path segment on every platform and never collides with the
 * lock file or hidden staging names, which contain a dot.
 */
export function botDirectoryName(botId: string): string {
  assertBotId(botId);
  let name = "";
  for (const character of botId) {
    if (PLAIN_DIRECTORY_CHARACTER.test(character)) {
      name += character;
      continue;
    }
    for (const byte of Buffer.from(character, "utf8")) name += `~${byte.toString(16).padStart(2, "0")}`;
  }
  return name;
}

/** Inverse of `botDirectoryName`, or `null` for a name it never produces. */
export function botIdFromDirectoryName(name: string): string | null {
  if (!ENCODED_DIRECTORY_NAME.test(name)) return null;
  const bytes: number[] = [];
  for (let index = 0; index < name.length; ) {
    if (name[index] === "~") {
      bytes.push(Number.parseInt(name.slice(index + 1, index + 3), 16));
      index += 3;
    } else {
      bytes.push(name.charCodeAt(index));
      index += 1;
    }
  }
  const botId = Buffer.from(bytes).toString("utf8");
  try {
    return botDirectoryName(botId) === name ? botId : null;
  } catch {
    return null;
  }
}

/** SQLite's own verdict that the file is not (or no longer) a database. */
function isCorruptDatabaseError(error: unknown): boolean {
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  if (candidate === null || typeof candidate !== "object") return false;
  if (candidate.code === "ERR_SQLITE_ERROR" && (candidate.errcode === 26 || candidate.errcode === 11)) {
    return true;
  }
  return typeof candidate.message === "string" && /file is not a database|database disk image is malformed/iu.test(candidate.message);
}

interface OpenEntry {
  harness: Harness;
  conversation: Conversation;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pendingNotice?: string;
}

export async function createBotHarnessHost(
  opts: BotHarnessHostOptions,
): Promise<BotHarnessHost | BotHarnessHostUnavailable> {
  const botsDir = path.join(opts.profileDir, "bots");
  const lock = await acquireBotProfileLock(botsDir, opts.leaseHelperPath);
  if (!lock.ok) return { unavailable: lock.reason, pid: lock.pid };

  const ctx: Context = BACKGROUND_CONTEXT;
  const idleCloseMs = opts.idleCloseMs ?? DEFAULT_BOT_IDLE_CLOSE_MS;
  const now = opts.now ?? Date.now;
  const open = new Map<string, OpenEntry>();
  /** Keep failed teardowns out of the reusable-entry path. */
  const closing = new Set<string>();
  const deleted = new Set<string>();
  /** Per-Bot serialization of open/close/destroy. */
  const lifecycle = new Map<string, Promise<unknown>>();
  const admittedOperations = new Set<Promise<unknown>>();
  let shutDown = false;
  let shutdownPromise: Promise<void> | null = null;

  function admit<T>(action: () => Promise<T>): Promise<T> {
    if (shutDown) return Promise.reject(new BotHarnessHostClosedError());
    const operation = action();
    admittedOperations.add(operation);
    void operation.finally(() => admittedOperations.delete(operation)).catch(() => undefined);
    return operation;
  }

  const botDir = (botId: string) => path.join(botsDir, botDirectoryName(botId));
  const sessionFile = (botId: string) => path.join(botDir(botId), BOT_SESSION_FILE);

  function serialize<T>(botId: string, action: () => Promise<T>): Promise<T> {
    const previous = lifecycle.get(botId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const tail = next.catch(() => undefined);
    lifecycle.set(botId, tail);
    void tail.then(() => {
      if (lifecycle.get(botId) === tail) lifecycle.delete(botId);
    });
    return next;
  }

  async function openHarness(botId: string): Promise<{ harness: Harness; conversation: Conversation }> {
    const storage = await openNodeSqliteStorage(sessionFile(botId));
    let harness: Harness | undefined;
    try {
      const registry = opts.buildRegistry(botId);
      harness = await Harness.open(
        storage,
        {
          models: typeof opts.models === "function" ? opts.models(botId) : opts.models,
          identity: AIDEN_PI_CLIENT_IDENTITY,
          registry,
          settings: { ...BOT_HARNESS_SETTINGS, ...opts.settings },
          now,
          onReport: (error) => opts.onReport?.(botId, error),
        },
        ctx,
      );
      registry.attachHarness?.(harness);
      const conversation = await harness.root(ctx);
      return { harness, conversation };
    } catch (error) {
      if (harness !== undefined) await harness.close(ctx).catch(() => undefined);
      else await storage.close(ctx).catch(() => undefined);
      throw error;
    }
  }

  async function moveCorruptAside(botId: string): Promise<string> {
    const stamp = `${now()}`;
    const moved = `${BOT_SESSION_FILE}.corrupt-${stamp}`;
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs
        .rename(`${sessionFile(botId)}${suffix}`, path.join(botDir(botId), `${moved}${suffix}`))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
    return moved;
  }

  function scheduleIdle(botId: string, entry: OpenEntry): void {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      void admit(() => closeIfIdle(botId, entry)).catch(() => undefined);
    }, idleCloseMs);
    entry.idleTimer.unref?.();
  }

  async function closeIfIdle(botId: string, entry: OpenEntry): Promise<void> {
    if (shutDown) return;
    if (open.get(botId) !== entry) return;
    try {
      const inspection = await entry.harness.inspect(ctx);
      if (inspection.tasks.length > 0 || inspection.submissions.length > 0) {
        scheduleIdle(botId, entry);
        return;
      }
    } catch {
      // A harness that cannot be inspected is closed below.
    }
    if (!shutDown) {
      await serialize(botId, () => open.get(botId) === entry ? closeEntry(botId) : Promise.resolve()).catch(() => undefined);
    }
  }

  async function ensureOpen(botId: string): Promise<OpenEntry> {
    assertBotId(botId);
    if (shutDown) throw new BotHarnessHostClosedError();
    if (deleted.has(botId)) throw new BotDeletedError(botId);
    return serialize(botId, async () => {
      if (shutDown) throw new BotHarnessHostClosedError();
      if (deleted.has(botId)) throw new BotDeletedError(botId);
      const already = open.get(botId);
      if (already !== undefined) {
        if (closing.has(botId)) await closeEntry(botId);
        else {
          scheduleIdle(botId, already);
          return already;
        }
      }
      await fs.mkdir(botDir(botId), { recursive: true, mode: 0o700 });
      let opened: { harness: Harness; conversation: Conversation };
      let notice: string | undefined;
      try {
        opened = await openHarness(botId);
      } catch (error) {
        if (!isCorruptDatabaseError(error)) throw error;
        notice = await moveCorruptAside(botId);
        opened = await openHarness(botId);
      }
      const entry: OpenEntry = { ...opened, idleTimer: null, ...(notice === undefined ? {} : { pendingNotice: notice }) };
      open.set(botId, entry);
      closing.delete(botId);
      scheduleIdle(botId, entry);
      // pi-durable 1.2 closes a Session for good when any Storage call fails;
      // drop it so the next open reopens and recovers from what was committed.
      void entry.harness.closed.then((end) => {
        if (end.reason !== "failed" || open.get(botId) !== entry) return;
        open.delete(botId);
        if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
        opts.onReport?.(botId, end.error);
      });
      return entry;
    });
  }

  async function closeEntry(botId: string): Promise<void> {
    const entry = open.get(botId);
    if (entry === undefined) {
      closing.delete(botId);
      return;
    }
    closing.add(botId);
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    await entry.harness.close(ctx);
    if (open.get(botId) === entry) open.delete(botId);
    closing.delete(botId);
  }

  async function listBotDirectories(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(botsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: string[] = [];
    for (const name of names) {
      if (name === BOT_PROFILE_LOCK_FILE || name === BOT_PROFILE_GUARD_FILE || name.startsWith(".")) continue;
      const stat = await fs.lstat(path.join(botsDir, name)).catch(() => null);
      if (stat?.isDirectory()) result.push(name);
    }
    return result;
  }

  const host: BotHarnessHost = {
    open(botId) { return admit(async () => {
      const entry = await ensureOpen(botId);
      const notice = entry.pendingNotice;
      delete entry.pendingNotice;
      return {
        harness: entry.harness,
        conversation: entry.conversation,
        ...(notice === undefined ? {} : { recoveredCorruptFile: notice }),
      };
    }); },

    touch(botId) {
      if (shutDown) throw new BotHarnessHostClosedError();
      const entry = open.get(botId);
      if (entry !== undefined) scheduleIdle(botId, entry);
    },

    inspect(botId) { return admit(async () => {
      const entry = await ensureOpen(botId);
      return entry.harness.inspect(ctx);
    }); },

    interruptedBots() { return admit(async () => {
      const result: BotInterruption[] = [];
      for (const name of await listBotDirectories()) {
        const botId = botIdFromDirectoryName(name);
        if (botId === null || deleted.has(botId)) continue;
        const hasSession = await fs
          .stat(sessionFile(botId))
          .then(() => true)
          .catch(() => false);
        if (!hasSession) continue;
        const entry = await ensureOpen(botId);
        const inspection = await entry.harness.inspect(ctx);
        const unfinished = inspection.submissions.find((submission) => submission.type === "input");
        if (unfinished !== undefined) {
          result.push({ botId, submissionId: String(unfinished.id) });
        } else if (inspection.tasks.length === 0 && inspection.submissions.length === 0) {
          // Nothing to recover: do not keep this Bot's database open.
          await serialize(botId, () => closeEntry(botId));
        }
      }
      return result;
    }); },

    close(botId) {
      return admit(() => serialize(botId, () => closeEntry(botId)));
    },

    suspend(botId, timeoutMs = DEFAULT_BOT_SUSPEND_TIMEOUT_MS) { return admit(async () => {
      assertBotId(botId);
      const closing = serialize(botId, async () => {
        if (!open.has(botId)) return "not_open" as const;
        await closeEntry(botId);
        return "closed" as const;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), timeoutMs);
      });
      try {
        const outcome = await Promise.race([closing, timedOut]);
        if (outcome === "timed_out") {
          opts.onReport?.(botId, new Error(`The Bot's session did not close within ${timeoutMs} ms; it keeps closing.`));
          void closing.catch((error: unknown) => opts.onReport?.(botId, error));
        }
        return outcome;
      } finally {
        clearTimeout(timer);
      }
    }); },

    destroy(botId) { return admit(async () => {
      assertBotId(botId);
      deleted.add(botId);
      await serialize(botId, async () => {
        const entry = open.get(botId);
        if (entry !== undefined) {
          // Abort the live run (provider stream, tools) before closing, bounded
          // so a tool that ignores its signal cannot block deletion.
          const { context: abortCtx, cancel } = withCancel(ctx);
          const timer = setTimeout(() => cancel(new Error("abort timed out")), DESTROY_ABORT_TIMEOUT_MS);
          try {
            await entry.conversation.abort(abortCtx, { background: true });
          } catch {
            // Closing below still stops scheduling.
          } finally {
            clearTimeout(timer);
          }
          await closeEntry(botId).catch(() => undefined);
        }
        await fs.rm(botDir(botId), { recursive: true, force: true });
      });
    }); },

    sweepOrphans(knownBotIds) { return admit(async () => {
      const removed: string[] = [];
      for (const name of await listBotDirectories()) {
        const botId = botIdFromDirectoryName(name);
        if (botId !== null && knownBotIds.has(botId)) continue;
        if (botId !== null) {
          await serialize(botId, () => closeEntry(botId)).catch(() => undefined);
        }
        await fs.rm(path.join(botsDir, name), { recursive: true, force: true });
        removed.push(name);
      }
      return removed;
    }); },

    isOpen(botId) {
      return open.has(botId);
    },

    async shutdown() {
      if (shutdownPromise === null) {
        shutDown = true;
        shutdownPromise = (async () => {
          await Promise.allSettled([...admittedOperations]);
          const closes = await Promise.allSettled([...open.keys()].map((botId) => serialize(botId, () => closeEntry(botId))));
          const failed = closes.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failed) throw failed.reason;
          await Promise.all([...lifecycle.values()]);
          await lock.release();
        })();
      }
      return shutdownPromise;
    },
  };
  return host;
}
