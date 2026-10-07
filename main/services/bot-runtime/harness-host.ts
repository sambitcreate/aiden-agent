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
import { acquireBotProfileLock, BOT_PROFILE_LOCK_FILE } from "./profile-lock.js";

export const BOT_SESSION_FILE = "session.sqlite";
export const DEFAULT_BOT_IDLE_CLOSE_MS = 600_000;
const DESTROY_ABORT_TIMEOUT_MS = 10_000;
const MAX_BOT_ID_LENGTH = 200;
const PLAIN_DIRECTORY_CHARACTER = /^[A-Za-z0-9_-]$/u;
const ENCODED_DIRECTORY_NAME = /^(?:[A-Za-z0-9_-]|~[0-9a-f]{2})+$/u;

export interface BotHarnessHostOptions {
  /** The profile directory; Bot sessions live under `<profileDir>/bots/`. */
  profileDir: string;
  /**
   * Installed on every open, before anything can run (`createBotRegistry`).
   * A registry with `attachHarness` is bound to the harness it serves.
   */
  buildRegistry(botId: string): Registry & { attachHarness?(harness: Harness): void };
  /** pi-ai model access for generation. */
  models: Models;
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
  const lock = await acquireBotProfileLock(botsDir);
  if (!lock.ok) return { unavailable: lock.reason, pid: lock.pid };

  const ctx: Context = BACKGROUND_CONTEXT;
  const idleCloseMs = opts.idleCloseMs ?? DEFAULT_BOT_IDLE_CLOSE_MS;
  const now = opts.now ?? Date.now;
  const opening = new Map<string, Promise<OpenEntry>>();
  const open = new Map<string, OpenEntry>();
  const deleted = new Set<string>();
  /** Per-Bot serialization of open/close/destroy. */
  const lifecycle = new Map<string, Promise<unknown>>();
  let shutDown = false;

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
          models: opts.models,
          registry,
          ...(opts.settings === undefined ? {} : { settings: opts.settings }),
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
      void closeIfIdle(botId, entry);
    }, idleCloseMs);
    entry.idleTimer.unref?.();
  }

  async function closeIfIdle(botId: string, entry: OpenEntry): Promise<void> {
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
    await host.close(botId).catch(() => undefined);
  }

  async function ensureOpen(botId: string): Promise<OpenEntry> {
    assertBotId(botId);
    if (shutDown) throw new BotHarnessHostClosedError();
    if (deleted.has(botId)) throw new BotDeletedError(botId);
    const existing = open.get(botId);
    if (existing !== undefined) {
      scheduleIdle(botId, existing);
      return existing;
    }
    const pending = opening.get(botId);
    if (pending !== undefined) return pending;
    const promise = serialize(botId, async () => {
      if (shutDown) throw new BotHarnessHostClosedError();
      if (deleted.has(botId)) throw new BotDeletedError(botId);
      const already = open.get(botId);
      if (already !== undefined) return already;
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
      scheduleIdle(botId, entry);
      return entry;
    });
    opening.set(botId, promise);
    try {
      return await promise;
    } finally {
      if (opening.get(botId) === promise) opening.delete(botId);
    }
  }

  async function closeEntry(botId: string): Promise<void> {
    const entry = open.get(botId);
    if (entry === undefined) return;
    open.delete(botId);
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    await entry.harness.close(ctx);
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
      if (name === BOT_PROFILE_LOCK_FILE || name.startsWith(".")) continue;
      const stat = await fs.lstat(path.join(botsDir, name)).catch(() => null);
      if (stat?.isDirectory()) result.push(name);
    }
    return result;
  }

  const host: BotHarnessHost = {
    async open(botId) {
      const entry = await ensureOpen(botId);
      const notice = entry.pendingNotice;
      delete entry.pendingNotice;
      return {
        harness: entry.harness,
        conversation: entry.conversation,
        ...(notice === undefined ? {} : { recoveredCorruptFile: notice }),
      };
    },

    touch(botId) {
      const entry = open.get(botId);
      if (entry !== undefined) scheduleIdle(botId, entry);
    },

    async inspect(botId) {
      const entry = await ensureOpen(botId);
      return entry.harness.inspect(ctx);
    },

    async interruptedBots() {
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
          await host.close(botId);
        }
      }
      return result;
    },

    close(botId) {
      return serialize(botId, () => closeEntry(botId));
    },

    async destroy(botId) {
      assertBotId(botId);
      deleted.add(botId);
      const pending = opening.get(botId);
      if (pending !== undefined) await pending.catch(() => undefined);
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
    },

    async sweepOrphans(knownBotIds) {
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
    },

    isOpen(botId) {
      return open.has(botId);
    },

    async shutdown() {
      if (shutDown) return;
      shutDown = true;
      await Promise.allSettled([...opening.values()]);
      await Promise.allSettled([...open.keys()].map((botId) => serialize(botId, () => closeEntry(botId))));
      await lock.release();
    },
  };
  return host;
}
