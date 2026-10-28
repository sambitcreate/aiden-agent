// The learning history per Bot, `<profile>/bots/<dir>/learning-history.json`.
// Undo restores a change's "before" only while the current state still equals
// its "after"; otherwise it reports a conflict and changes nothing.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BOT_LEARNING_HISTORY_LIMITS,
  type BotLearningChange,
  type BotLearningTarget,
} from "../../../renderer/shared/bot-learning.js";
import { botSessionDirectory, createKeyedSerial } from "../bot-routine-notes.js";
import { writeJsonAtomic } from "../durable-fs.js";

export const BOT_LEARNING_HISTORY_FILE = "learning-history.json";

export interface BotLearningHistory {
  record(change: Omit<BotLearningChange, "id" | "at" | "fingerprintBefore" | "fingerprintAfter"> & { fingerprintBefore?: string }): Promise<BotLearningChange>;
  list(botId: string): Promise<BotLearningChange[]>;
  undo(botId: string, changeId: string): Promise<{ ok: true; change: BotLearningChange } | { ok: false; code: "conflict" | "not_found" | "already_undone" }>;
}

export function createBotLearningHistory(deps: {
  profileDir(): string;
  /** The target's state now, in the same text form the change stored. */
  current(botId: string, target: BotLearningTarget): Promise<string | null>;
  /**
   * Put the target back to `content` (null: remove it), only while it still
   * equals `expected`. Returns false, changing nothing, when it moved: the
   * check must sit inside the target's own write boundary.
   */
  apply(botId: string, target: BotLearningTarget, content: string | null, expected: string | null): Promise<boolean>;
  fingerprint(botId: string): Promise<string>;
  now?(): number;
}): BotLearningHistory {
  const now = deps.now ?? Date.now;
  const serial = createKeyedSerial();
  const fileOf = (botId: string) => path.join(botSessionDirectory(deps.profileDir(), botId), BOT_LEARNING_HISTORY_FILE);

  async function load(botId: string): Promise<BotLearningChange[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(fileOf(botId), "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as BotLearningChange[]).filter((change) => change?.botId === botId && typeof change.id === "string") : [];
    } catch {
      return [];
    }
  }

  /** Newest last; over the caps the oldest go first, undone ones before live ones. */
  function bounded(changes: BotLearningChange[]): BotLearningChange[] {
    let kept = [...changes];
    const size = () => Buffer.byteLength(JSON.stringify(kept), "utf8");
    while (kept.length > BOT_LEARNING_HISTORY_LIMITS.changes || (kept.length > 1 && size() > BOT_LEARNING_HISTORY_LIMITS.bytes)) {
      const undone = kept.findIndex((change) => change.undoneAt !== undefined || change.undoOf !== undefined);
      kept.splice(undone >= 0 ? undone : 0, 1);
    }
    return kept;
  }

  async function save(botId: string, changes: BotLearningChange[]): Promise<void> {
    await writeJsonAtomic(fileOf(botId), bounded(changes), { mode: 0o600, mkdirMode: 0o700 });
  }

  return {
    async record(input) {
      const fingerprintAfter = await deps.fingerprint(input.botId);
      return serial(input.botId, async () => {
        const change: BotLearningChange = {
          ...input,
          id: randomUUID(),
          at: now(),
          summary: [...input.summary].slice(0, BOT_LEARNING_HISTORY_LIMITS.summaryChars).join(""),
          fingerprintBefore: input.fingerprintBefore ?? fingerprintAfter,
          fingerprintAfter,
        };
        await save(input.botId, [...(await load(input.botId)), change]);
        return change;
      });
    },

    async list(botId) {
      return (await load(botId)).reverse();
    },

    undo(botId, changeId) {
      return serial(botId, async () => {
        const changes = await load(botId);
        const index = changes.findIndex((change) => change.id === changeId);
        const change = changes[index];
        if (!change) return { ok: false, code: "not_found" };
        if (change.undoneAt !== undefined) return { ok: false, code: "already_undone" };
        if ((await deps.current(botId, change.target)) !== change.after) return { ok: false, code: "conflict" };
        const before = await deps.fingerprint(botId);
        if (!(await deps.apply(botId, change.target, change.before, change.after))) return { ok: false, code: "conflict" };
        const at = now();
        changes[index] = { ...change, undoneAt: at };
        changes.push({
          id: randomUUID(),
          botId,
          at,
          kind: change.kind,
          summary: `Undid: ${change.summary}`.slice(0, BOT_LEARNING_HISTORY_LIMITS.summaryChars),
          target: change.target,
          before: change.after,
          after: change.before,
          fingerprintBefore: before,
          fingerprintAfter: await deps.fingerprint(botId),
          undoOf: change.id,
        });
        await save(botId, changes);
        return { ok: true, change: changes[index]! };
      });
    },
  };
}
