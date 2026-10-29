// File-change triggers: one recursive watch per enabled routine, on a folder
// inside its Bot's home. Changes are coalesced for 30 seconds into one event
// listing up to 50 paths. The Bot's own `.aiden/` state never triggers it.
//
// While the routine's own run is going (several may overlap), changes are
// held. Once the last run has ended and a short settle has passed, the files
// that run wrote with its file tools are dropped (a Bot writing a summary into
// the folder it watches would otherwise fire itself) and every other held
// change goes on as a normal event, so a file the person drops in mid-run is
// not lost. A late watch notice for a file the Bot wrote is dropped while the
// file is still exactly as the Bot left it.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BOT_ROUTINE_EVENT_LIMITS, matchesTriggerPattern } from "../../../renderer/shared/bot-routine-trigger.js";
import type { BotRoutineEventDispatcher } from "./dispatcher.js";
import type { BotEventRoutine } from "./store.js";

export const BOT_FOLDER_EVENT_MAX_PATHS = 50;
/** After the last run ends: notices the OS delivers late still count as held. */
export const BOT_FOLDER_OWN_RUN_SETTLE_MS = 5_000;
/** How long a late notice for a file the Bot wrote is checked against its saved size and time. */
const OWN_WRITE_ECHO_MS = 60_000;

type Fingerprint = { mtimeMs: number; size: number } | undefined;

export interface BotFolderWatchDependencies {
  routines(): Promise<BotEventRoutine[]>;
  homePath(botId: string): Promise<string>;
  /** `onError`: the watch died (folder deleted or replaced); it is re-armed on the next rearm. */
  watch(folder: string, listener: (file: string | null) => void, onError: () => void): { close(): void };
  dispatcher: Pick<BotRoutineEventDispatcher, "emit">;
  /** True when this routine's Bot wrote `absolutePath` with its file tools at or after `since`. */
  wroteSince?(routine: BotEventRoutine, absolutePath: string, since: number): boolean;
  /** Size and modified time, or undefined when the file is gone. */
  stat?(absolutePath: string): Promise<Fingerprint>;
  /** A routine whose folder is outside the Bot's home, or can't be watched: tell the person once. */
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
  const watches = new Map<string, { key: string; folder: string; close(): void }>();
  /** Runs in progress per routine (refcounted), and the changes held meanwhile. */
  const runs = new Map<string, { count: number; since: number; held: Set<string>; settle?: { cancel(): void } }>();
  /** Files the Bot wrote, as it left them: a late notice for one is not a new event. */
  const echoes = new Map<string, { fingerprint: Fingerprint; until: number }>();
  const releasing = new Set<Promise<void>>();
  const stat = dependencies.stat;
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

  function add(routine: BotEventRoutine, relative: string): void {
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

  function track(work: Promise<void>): void {
    const tracked = work.catch(() => undefined).finally(() => releasing.delete(tracked));
    releasing.add(tracked);
  }

  function noticed(routine: BotEventRoutine, folder: string, file: string | null): void {
    if (!file) return;
    const relative = file.replace(/\\/gu, "/");
    if (relative.split("/").includes(".aiden")) return;
    if (routine.trigger.kind !== "file_change") return;
    if (!matchesTriggerPattern(path.posix.basename(relative), routine.trigger.pattern)) return;
    const run = runs.get(routine.id);
    if (run) {
      if (run.held.size < BOT_FOLDER_EVENT_MAX_PATHS + 1_000) run.held.add(relative);
      return;
    }
    const echoKey = `${routine.id}\0${path.join(folder, relative)}`;
    const echo = echoes.get(echoKey);
    if (!echo || !stat || dependencies.now() > echo.until) {
      echoes.delete(echoKey);
      add(routine, relative);
      return;
    }
    track(stat(path.join(folder, relative)).catch(() => undefined).then((current) => {
      if (sameFile(current, echo.fingerprint)) return;
      echoes.delete(echoKey);
      add(routine, relative);
    }));
  }

  /** The last run ended and the settle passed: drop the Bot's own files, pass on the rest. */
  async function release(routine: BotEventRoutine, run: { since: number; held: Set<string> }): Promise<void> {
    const folder = watches.get(routine.id)?.folder;
    if (!folder) return;
    for (const relative of run.held) {
      const absolute = path.join(folder, relative);
      if (dependencies.wroteSince?.(routine, absolute, run.since)) {
        if (stat) {
          const fingerprint = await stat(absolute).catch(() => undefined);
          echoes.set(`${routine.id}\0${absolute}`, { fingerprint, until: dependencies.now() + OWN_WRITE_ECHO_MS });
        }
        continue;
      }
      if (watches.get(routine.id)?.folder !== folder) return;
      add(routine, relative);
    }
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
  /** Bumped by dispose(): a rearm still awaiting must not reopen watches. */
  let generation = 0;

  async function rearmOnce(armedFor: number): Promise<void> {
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
        if (armedFor !== generation) return;
        if (!folder) {
          dependencies.refused(routine);
          continue;
        }
        const key = JSON.stringify(routine.trigger);
        let handle: { close(): void };
        try {
          handle = dependencies.watch(folder, (file) => noticed(routine, folder, file), () => {
            // A dead watch leaves the map, so the next rearm makes a fresh one.
            if (watches.get(id)?.key === key) watches.delete(id);
            handle.close();
          });
        } catch {
          // Removed between the check and the watch, or out of watch handles:
          // this routine is reported, and the others still get their watches.
          dependencies.refused(routine);
          continue;
        }
        watches.set(id, { key, folder, close: () => handle.close() });
        dependencies.accepted?.(routine);
      }
  }

  return {
    /** Serialized: overlapping rearms never open two watches for one routine. */
    rearm(): Promise<void> {
      const armedFor = generation;
      const next = rearming.catch(() => undefined).then(() => rearmOnce(armedFor));
      rearming = next;
      return next;
    },
    /** One of this routine's runs started: hold its folder's changes until the last one ends. */
    runStarted(routine: BotEventRoutine): void {
      const run = runs.get(routine.id);
      if (run) {
        run.count += 1;
        run.settle?.cancel();
        run.settle = undefined;
        return;
      }
      runs.set(routine.id, { count: 1, since: dependencies.now(), held: new Set() });
    },
    runEnded(routine: BotEventRoutine): void {
      const run = runs.get(routine.id);
      if (!run) return;
      run.count = Math.max(0, run.count - 1);
      if (run.count > 0 || run.settle) return;
      run.settle = dependencies.setTimer(() => {
        if (runs.get(routine.id) !== run || run.count > 0) return;
        runs.delete(routine.id);
        track(release(routine, run));
      }, BOT_FOLDER_OWN_RUN_SETTLE_MS);
    },
    dispose(): void {
      generation += 1;
      for (const watch of watches.values()) watch.close();
      watches.clear();
      for (const window of windows.values()) window.timer.cancel();
      windows.clear();
      for (const run of runs.values()) run.settle?.cancel();
      runs.clear();
      echoes.clear();
    },
    /** Resolves once a rearm or a release still in progress has finished. */
    async idle(): Promise<void> {
      await rearming.catch(() => undefined);
      while (releasing.size) await Promise.allSettled([...releasing]);
    },
  };
}

function sameFile(a: Fingerprint, b: Fingerprint): boolean {
  if (!a || !b) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}
