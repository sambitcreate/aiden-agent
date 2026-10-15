// A Bot's memory files: validated reads and serialized, atomic writes
// (spec 2026-10-09 §6).
//
// - Reads validate every time (§6.3). An unreadable file (bad UTF-8, I/O
//   error) makes the whole memory unreadable: the prompt block is empty, the
//   tool reports `unreadable` and the person can only erase.
// - Writes are serialized per Bot and published with `writeFileAtomic`. A
//   batch applies to an in-memory copy, checks the budget on the final result
//   and entry count only, and writes once; any failing operation aborts the
//   whole batch.
// - Writes rewrite the file from its validated entries, so a blocked or
//   oversize entry the shell planted is cleaned out by the next save.
// - The `memory/` directory is created on the first write, but never its
//   parent: a write for a Bot whose session directory is gone (deleted) fails
//   instead of resurrecting it. `forgetBot` refuses every later write.
// - The Bot's own batches carry their writer's fence (`assertCurrent`): it is
//   checked once the batch holds the write lock and again right before the
//   atomic rename, so access revoked while a batch waited or read never
//   publishes. A person's edits carry none.

import * as fs from "node:fs/promises";
import {
  BOT_MEMORY_LIMITS,
  type BotMemoryEdit,
  type BotMemoryEditErrorCode,
  type BotMemoryStoreView,
  type BotMemoryTarget,
  type BotMemoryView,
} from "../../../renderer/shared/bot-memory.js";
import { writeFileAtomic } from "../durable-fs.js";
import {
  BOT_MEMORY_TARGETS,
  botMemoryDirectory,
  botMemoryFile,
  cleanEntryText,
  entryProblem,
  memoryEntryId,
  memoryLimit,
  memoryRevision,
  normalizeForMatch,
  readMemoryFile,
  serializeEntries,
  splitEntries,
  toEntries,
  usedChars,
  validateEntries,
  type RawMemoryFile,
} from "./files.js";
import { BOT_MEMORY_BLOCKED_MESSAGE } from "./scan.js";

export interface LoadedMemoryStore {
  /** Validated entries, in file order. */
  texts: string[];
  /** Entries the read scan dropped. */
  blockedCount: number;
}

export interface LoadedBotMemory {
  botId: string;
  readable: boolean;
  revision: string;
  /** Epoch ms of the newest file write, or null when neither file exists. */
  updatedAt: number | null;
  stores: Record<BotMemoryTarget, LoadedMemoryStore>;
}

export type BotMemoryOperation =
  | { action: "add"; content: string }
  | { action: "replace"; match: string; content: string }
  | { action: "remove"; match: string };

export type BotMemoryApplyErrorCode =
  | "over_budget"
  | "no_match"
  | "ambiguous_match"
  | "blocked"
  | "too_long"
  | "empty"
  | "invalid"
  | "unreadable";

export interface BotMemoryApplyOptions {
  /** Background review and compaction flush: only `add` is allowed. */
  addOnly?: boolean;
  /**
   * The writer's authority fence. Awaited once the batch holds the Bot's
   * write lock and again immediately before the file is published; a
   * rejection aborts the batch without writing and is rethrown as is.
   */
  assertCurrent?: () => Promise<void>;
}

export type BotMemoryApplyResult =
  | { ok: true; target: BotMemoryTarget; changed: number; texts: string[]; loaded: LoadedBotMemory }
  | {
      ok: false;
      code: BotMemoryApplyErrorCode;
      target: BotMemoryTarget;
      error: string;
      /** The store's current entries (unchanged), so the model can consolidate. */
      texts: string[];
      /** For a match error: the candidates (ambiguous) or the closest entries (no match). */
      candidates?: string[];
      loaded: LoadedBotMemory;
    };

export type BotMemoryEditOutcome =
  | { ok: true; changed: boolean; loaded: LoadedBotMemory }
  | { ok: false; code: BotMemoryEditErrorCode; message: string; loaded: LoadedBotMemory };

export class BotMemoryDeletedError extends Error {
  constructor(readonly botId: string) {
    super("This Bot no longer exists.");
    this.name = "BotMemoryDeletedError";
  }
}

export interface BotMemoryStore {
  load(botId: string): Promise<LoadedBotMemory>;
  /** The Bot's own batch (tool, review, flush). */
  apply(
    botId: string,
    target: BotMemoryTarget,
    operations: readonly BotMemoryOperation[],
    options?: BotMemoryApplyOptions,
  ): Promise<BotMemoryApplyResult>;
  /** A person's edit from the Profile. */
  edit(botId: string, edit: BotMemoryEdit): Promise<BotMemoryEditOutcome>;
  /** Refuse every later write for this Bot (it is being deleted). */
  forgetBot(botId: string): void;
}

export function storeView(loaded: LoadedBotMemory, target: BotMemoryTarget): BotMemoryStoreView {
  const texts = loaded.stores[target].texts;
  const limitChars = memoryLimit(target);
  const used = usedChars(texts);
  return { entries: toEntries(target, texts), usedChars: used, limitChars, overBudget: used > limitChars };
}

export function memoryView(loaded: LoadedBotMemory): BotMemoryView {
  return {
    botId: loaded.botId,
    revision: loaded.revision,
    readable: loaded.readable,
    memory: storeView(loaded, "memory"),
    user: storeView(loaded, "user"),
    updatedAt: loaded.updatedAt,
  };
}

const STORE_LABEL: Readonly<Record<BotMemoryTarget, string>> = { memory: "MEMORY.md", user: "USER.md" };

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Words shared with `match`, for "closest entries" on a miss. */
function closeness(text: string, match: string): number {
  const words = new Set(normalizeForMatch(match).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2));
  if (words.size === 0) return 0;
  let shared = 0;
  for (const word of new Set(normalizeForMatch(text).split(/[^\p{L}\p{N}]+/u))) if (words.has(word)) shared += 1;
  return shared / words.size;
}

type Located = { ok: true; index: number } | { ok: false; code: "no_match" | "ambiguous_match"; candidates: string[] };

/** Exactly one entry: an exact whole-entry match wins, otherwise a unique normalized substring. */
export function locateEntry(texts: readonly string[], rawMatch: string): Located {
  const match = cleanEntryText(rawMatch);
  const exact = texts.indexOf(match);
  if (exact >= 0) return { ok: true, index: exact };
  const needle = normalizeForMatch(match);
  const hits = needle.length === 0 ? [] : texts.flatMap((text, index) => (normalizeForMatch(text).includes(needle) ? [index] : []));
  if (hits.length === 1) return { ok: true, index: hits[0]! };
  if (hits.length > 1) return { ok: false, code: "ambiguous_match", candidates: hits.map((index) => texts[index]!) };
  const closest = texts
    .map((text) => ({ text, score: closeness(text, match) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ text }) => text);
  return { ok: false, code: "no_match", candidates: closest };
}

const PROBLEM_TEXT: Readonly<Record<"empty" | "too_long" | "invalid" | "blocked", string>> = {
  empty: "The entry is empty.",
  too_long: "Each entry can be at most 500 characters.",
  invalid: "An entry cannot contain a line holding only §.",
  blocked: BOT_MEMORY_BLOCKED_MESSAGE,
};

/** A keyed promise chain: one write per Bot at a time. */
function keyedQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const next = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}

export interface BotMemoryStoreOptions {
  /** The profile directory; memory lives under `<profileDir>/bots/<dir>/memory/`. */
  profileDir: string;
}

export function createBotMemoryStore(options: BotMemoryStoreOptions): BotMemoryStore {
  const serialize = keyedQueue();
  const forgotten = new Set<string>();

  async function load(botId: string): Promise<LoadedBotMemory> {
    const files = {} as Record<BotMemoryTarget, RawMemoryFile>;
    for (const target of BOT_MEMORY_TARGETS) files[target] = await readMemoryFile(botMemoryFile(options.profileDir, botId, target));
    const readable = BOT_MEMORY_TARGETS.every((target) => files[target].kind !== "unreadable");
    const stores = {} as Record<BotMemoryTarget, LoadedMemoryStore>;
    let updatedAt: number | null = null;
    for (const target of BOT_MEMORY_TARGETS) {
      const file = files[target];
      if (file.kind === "ok") updatedAt = Math.max(updatedAt ?? 0, Math.floor(file.mtimeMs));
      if (!readable || file.kind !== "ok") {
        stores[target] = { texts: [], blockedCount: 0 };
        continue;
      }
      const validated = validateEntries(splitEntries(file.content));
      stores[target] = { texts: validated.texts, blockedCount: validated.blockedCount };
    }
    return { botId, readable, revision: memoryRevision(files), updatedAt, stores };
  }

  async function writeStore(
    botId: string,
    target: BotMemoryTarget,
    texts: readonly string[],
    assertCurrent?: () => Promise<void>,
  ): Promise<void> {
    if (forgotten.has(botId)) throw new BotMemoryDeletedError(botId);
    const directory = botMemoryDirectory(options.profileDir, botId);
    try {
      // Never recursive: the Bot's session directory must already exist.
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new BotMemoryDeletedError(botId);
      if (code !== "EEXIST") throw error;
    }
    await writeFileAtomic(botMemoryFile(options.profileDir, botId, target), serializeEntries(texts), {
      mode: 0o600,
      // The last moment a revoked writer or a deleted Bot can still be refused.
      beforePublish: async () => {
        guard(botId);
        await assertCurrent?.();
      },
    });
  }

  function guard(botId: string): void {
    if (forgotten.has(botId)) throw new BotMemoryDeletedError(botId);
  }

  return {
    load,

    apply(botId, target, operations, applyOptions = {}) {
      return serialize(botId, async (): Promise<BotMemoryApplyResult> => {
        guard(botId);
        // The batch may have waited behind other writes: is its writer still admitted?
        await applyOptions.assertCurrent?.();
        const loaded = await load(botId);
        const current = loaded.stores[target].texts;
        const fail = (
          code: BotMemoryApplyErrorCode,
          error: string,
          candidates?: string[],
        ): BotMemoryApplyResult => ({
          ok: false,
          code,
          target,
          error,
          texts: [...current],
          ...(candidates === undefined ? {} : { candidates }),
          loaded,
        });
        if (!loaded.readable) return fail("unreadable", "Memory couldn't be read. The person can erase it from the Bot's Profile.");
        if (operations.length === 0) return fail("invalid", "Give at least one operation.");

        const texts = [...current];
        let changed = 0;
        let added = 0;
        for (const [position, operation] of operations.entries()) {
          const label = `Operation ${position + 1} (${operation.action})`;
          if (applyOptions.addOnly && operation.action !== "add") return fail("invalid", "Only adding is allowed here.");
          if (operation.action === "add" || operation.action === "replace") {
            const content = cleanEntryText(operation.content);
            const problem = entryProblem(content);
            if (problem !== null) return fail(problem, `${label}: ${PROBLEM_TEXT[problem]}`);
          }
          if (operation.action === "add") {
            const content = cleanEntryText(operation.content);
            const key = normalizeForMatch(content);
            if (texts.some((text) => normalizeForMatch(text) === key)) continue;
            texts.push(content);
            changed += 1;
            added += 1;
            continue;
          }
          const located = locateEntry(texts, operation.match);
          if (!located.ok) {
            const message =
              located.code === "ambiguous_match"
                ? `${label}: "${operation.match}" matches ${located.candidates.length} entries. Quote more of the one you mean.`
                : `${label}: no entry matches "${operation.match}".`;
            return fail(located.code, message, located.candidates);
          }
          if (operation.action === "remove") {
            texts.splice(located.index, 1);
            changed += 1;
            continue;
          }
          const content = cleanEntryText(operation.content);
          if (texts[located.index] === content) continue;
          const key = normalizeForMatch(content);
          const duplicate = texts.findIndex((text, index) => index !== located.index && normalizeForMatch(text) === key);
          if (duplicate >= 0) texts.splice(located.index, 1);
          else texts[located.index] = content;
          changed += 1;
        }
        if (changed === 0) return { ok: true, target, changed: 0, texts, loaded };

        const limit = memoryLimit(target);
        const before = usedChars(current);
        const after = usedChars(texts);
        if (after > limit && (added > 0 || after > before)) {
          return fail(
            "over_budget",
            `${STORE_LABEL[target]} would be ${formatCount(after - limit)} characters over its ${formatCount(limit)} limit. ` +
              "Retry as ONE call that removes or shortens stale entries and adds this one.",
          );
        }
        if (texts.length > BOT_MEMORY_LIMITS.maxEntries && texts.length > current.length) {
          return fail(
            "over_budget",
            `${STORE_LABEL[target]} would hold ${texts.length} entries; it can hold at most ${BOT_MEMORY_LIMITS.maxEntries}. ` +
              "Retry as ONE call that removes or merges stale entries and adds this one.",
          );
        }
        await writeStore(botId, target, texts, applyOptions.assertCurrent);
        return { ok: true, target, changed, texts, loaded: await load(botId) };
      });
    },

    edit(botId, edit) {
      return serialize(botId, async (): Promise<BotMemoryEditOutcome> => {
        guard(botId);
        const loaded = await load(botId);
        const fail = (code: BotMemoryEditErrorCode, message: string): BotMemoryEditOutcome => ({ ok: false, code, message, loaded });

        if (edit.kind === "clear") {
          const files = await Promise.all(
            BOT_MEMORY_TARGETS.map(async (target) => ({
              target,
              file: await readMemoryFile(botMemoryFile(options.profileDir, botId, target)),
            })),
          );
          const toClear = files.filter(({ file }) => file.kind === "unreadable" || (file.kind === "ok" && file.content.length > 0));
          for (const { target } of toClear) await writeStore(botId, target, []);
          return { ok: true, changed: toClear.length > 0, loaded: toClear.length > 0 ? await load(botId) : loaded };
        }

        if (!loaded.readable) return fail("invalid", "Memory couldn't be read. Erase it to start over.");
        const target = edit.target;
        const current = loaded.stores[target].texts;
        const index = current.findIndex((text) => memoryEntryId(target, text) === edit.entryId);

        if (edit.kind === "remove") {
          if (index < 0) return fail("entry_not_found", "That memory changed or was already removed.");
          const texts = current.filter((_, position) => position !== index);
          await writeStore(botId, target, texts);
          return { ok: true, changed: true, loaded: await load(botId) };
        }

        const text = cleanEntryText(edit.text);
        const problem = entryProblem(text);
        if (problem === "blocked") return fail("blocked", BOT_MEMORY_BLOCKED_MESSAGE);
        if (problem !== null) return fail("invalid", PROBLEM_TEXT[problem]);
        let texts: string[];
        if (index >= 0) {
          if (current[index] === text) return { ok: true, changed: false, loaded };
          const key = normalizeForMatch(text);
          const duplicate = current.findIndex((other, position) => position !== index && normalizeForMatch(other) === key);
          texts = duplicate >= 0 ? current.filter((_, position) => position !== index) : current.map((other, position) => (position === index ? text : other));
        } else if (memoryEntryId(target, text) === edit.entryId) {
          // Restoring an entry under its own id (Undo after Delete) re-adds it.
          if (current.some((other) => normalizeForMatch(other) === normalizeForMatch(text))) return { ok: true, changed: false, loaded };
          texts = [...current, text];
        } else {
          return fail("entry_not_found", "That memory changed or was already removed.");
        }
        const limit = memoryLimit(target);
        const after = usedChars(texts);
        const tooMany = texts.length > BOT_MEMORY_LIMITS.maxEntries && texts.length > current.length;
        if ((after > limit && after > usedChars(current)) || tooMany) {
          return fail("over_budget", "That's more than this memory can hold. Shorten it or delete something first.");
        }
        await writeStore(botId, target, texts);
        return { ok: true, changed: true, loaded: await load(botId) };
      });
    },

    forgetBot(botId) {
      forgotten.add(botId);
    },
  };
}
