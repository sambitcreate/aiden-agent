// File-change triggers: one recursive watch per enabled routine, on a folder
// inside its Bot's home. Changes are coalesced for 30 seconds into one event
// listing up to 50 paths. The Bot's own `.aiden/` state never triggers it.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BOT_ROUTINE_EVENT_LIMITS, matchesTriggerPattern } from "../../../renderer/shared/bot-routine-trigger.js";
import type { BotRoutineEventDispatcher } from "./dispatcher.js";
import type { BotEventRoutine } from "./store.js";

export const BOT_FOLDER_EVENT_MAX_PATHS = 50;

export interface BotFolderWatchDependencies {
  routines(): Promise<BotEventRoutine[]>;
  homePath(botId: string): Promise<string>;
  /** `onError`: the watch died (folder deleted or replaced); it is re-armed on the next rearm. */
  watch(folder: string, listener: (file: string | null) => void, onError: () => void): { close(): void };
  dispatcher: Pick<BotRoutineEventDispatcher, "emit">;
  /** A routine whose folder is outside the Bot's home: tell the person once. */
  refused(routine: BotEventRoutine): void;
  /** Its folder is watched now: a "can't watch" card for it is fixed. */
  accepted?(routine: BotEventRoutine): void;
  now(): number;
  setTimer(fn: () => void, ms: number): { cancel(): void };
  realpath?(target: string): Promise<string>;
}

/** The event payload: up to 50 sorted paths, then "and N more". */
export function folderEventPayload(paths: readonly string[]): string {
  const sorted = [...new Set(paths)].sort();
  const shown = sorted.slice(0, BOT_FOLDER_EVENT_MAX_PATHS);
  const more = sorted.length - shown.length;
  return [...shown, ...(more > 0 ? [`and ${more} more`] : [])].join("\n");
}

export function createBotFolderWatches(dependencies: BotFolderWatchDependencies) {
  const realpath = dependencies.realpath ?? ((target: string) => fs.realpath(target));
  const watches = new Map<string, { key: string; close(): void }>();
  const windows = new Map<string, { paths: Set<string>; startedAt: number; timer: { cancel(): void } }>();

  function flush(routine: BotEventRoutine): void {
    const window = windows.get(routine.id);
    if (!window) return;
    windows.delete(routine.id);
    const paths = [...window.paths];
    if (!paths.length) return;
    const eventId = createHash("sha256").update(`${window.startedAt}\0${[...paths].sort().join("\0")}`).digest("hex").slice(0, 32);
    void dependencies.dispatcher.emit(routine.botId, routine.id, { eventId, payload: folderEventPayload(paths) }).catch(() => undefined);
  }

  function noticed(routine: BotEventRoutine, file: string | null): void {
    if (!file) return;
    const relative = file.replace(/\\/gu, "/");
    if (relative.split("/").includes(".aiden")) return;
    if (routine.trigger.kind !== "file_change") return;
    if (!matchesTriggerPattern(path.posix.basename(relative), routine.trigger.pattern)) return;
    let window = windows.get(routine.id);
    if (!window) {
      window = {
        paths: new Set(),
        startedAt: dependencies.now(),
        timer: dependencies.setTimer(() => flush(routine), BOT_ROUTINE_EVENT_LIMITS.coalesceMs),
      };
      windows.set(routine.id, window);
    }
    // Bounded during a storm: the payload shows 50 paths and a count anyway.
    if (window.paths.size < BOT_FOLDER_EVENT_MAX_PATHS + 1_000) window.paths.add(relative);
  }

  async function folderOf(routine: BotEventRoutine): Promise<string | undefined> {
    if (routine.trigger.kind !== "file_change") return undefined;
    const home = await realpath(await dependencies.homePath(routine.botId));
    const target = await realpath(path.join(home, routine.trigger.folder)).catch(() => undefined);
    if (!target) return undefined;
    const inside = path.relative(home, target);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
    return target;
  }

  let rearming: Promise<void> = Promise.resolve();

  async function rearmOnce(): Promise<void> {
      const wanted = new Map<string, BotEventRoutine>();
      for (const routine of await dependencies.routines()) {
        if (routine.enabled && routine.trigger.kind === "file_change") wanted.set(routine.id, routine);
      }
      for (const [id, watch] of watches) {
        const routine = wanted.get(id);
        if (!routine || watch.key !== JSON.stringify(routine.trigger)) {
          watch.close();
          watches.delete(id);
        }
      }
      for (const [id, routine] of wanted) {
        if (watches.has(id)) continue;
        const folder = await folderOf(routine).catch(() => undefined);
        if (!folder) {
          dependencies.refused(routine);
          continue;
        }
        const key = JSON.stringify(routine.trigger);
        const handle = dependencies.watch(folder, (file) => noticed(routine, file), () => {
          // A dead watch leaves the map, so the next rearm makes a fresh one.
          if (watches.get(id)?.key === key) watches.delete(id);
          handle.close();
        });
        watches.set(id, { key, close: () => handle.close() });
        dependencies.accepted?.(routine);
      }
  }

  return {
    /** Serialized: overlapping rearms never open two watches for one routine. */
    rearm(): Promise<void> {
      const next = rearming.catch(() => undefined).then(rearmOnce);
      rearming = next;
      return next;
    },
    dispose(): void {
      for (const watch of watches.values()) watch.close();
      watches.clear();
      for (const window of windows.values()) window.timer.cancel();
      windows.clear();
    },
  };
}
