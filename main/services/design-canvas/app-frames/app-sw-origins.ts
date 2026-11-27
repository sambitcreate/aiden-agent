// App service workers don't outlive design mode (design mode v2 Phase 3a,
// S76). Main keeps a device-local list of the loopback origins app frames
// reached (origins only) and clears their service workers when design mode
// ends for the workspace and at every start, flag on or off. An origin leaves
// the list only once its clear succeeded: past 64, the oldest are cleared
// before they are dropped, and one whose clear failed stays for the next try.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const APP_SW_ORIGINS_MAX = 64;

// The URL serializer drops the default port, so a page on :80 is `http://localhost`.
const ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/u;

export type AppServiceWorkerOrigins = {
  /** Adds an origin; past 64, the oldest are cleared first and dropped once cleared. */
  remember(origin: string): Promise<void>;
  /**
   * Clears service workers for the given origins (all remembered ones when
   * omitted) and forgets those cleared. `keep` is asked for each origin at the
   * moment it would be cleared, in the queue, and again once its clear is
   * done: an origin it keeps is left alone and listed, so an owner that
   * appeared while the clear waited still has its worker and its record.
   */
  clear(origins?: readonly string[], keep?: (origin: string) => boolean): Promise<void>;
  /** The remembered origins. */
  list(): Promise<string[]>;
  /**
   * With a clear that covers `origin` queued or running, a promise for when
   * those clears are done that says whether one of them cleared it; null
   * with none pending.
   */
  whenCleared(origin: string): Promise<boolean> | null;
};

export function createAppServiceWorkerOrigins(options: {
  file: string;
  session: { clearStorageData(options: { origin: string; storages: Array<"serviceworkers"> }): Promise<void> };
  log?: (event: string, fields: Record<string, unknown>) => void;
}): AppServiceWorkerOrigins {
  let queue: Promise<unknown> = Promise.resolve();
  /** Clears queued or running, with the origins each actually cleared. */
  const pending = new Set<{ only: string[] | null; cleared: Set<string>; done: Promise<void> }>();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const read = async (): Promise<string[]> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(options.file, "utf8"));
      const origins = (parsed as { origins?: unknown })?.origins;
      if (!Array.isArray(origins)) throw new Error("corrupt");
      // Never cut here: an origin past the cap is one whose clear failed, kept for the next try.
      return origins.filter((origin): origin is string => typeof origin === "string" && ORIGIN.test(origin));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      // A corrupt list clears nothing and is reset.
      await write([]).catch(() => undefined);
      return [];
    }
  };
  const write = async (origins: string[]): Promise<void> => {
    await mkdir(path.dirname(options.file), { recursive: true });
    const temporary = `${options.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ origins })}\n`, { mode: 0o600 });
    await rename(temporary, options.file);
  };

  /** Clears each origin's service workers; returns those that stay listed (failed, or kept). */
  const clearEach = async (origins: readonly string[], keep?: (origin: string) => boolean, cleared?: Set<string>): Promise<Set<string>> => {
    const failed = new Set<string>();
    for (const origin of origins) {
      if (keep?.(origin)) {
        failed.add(origin);
        continue;
      }
      try {
        await options.session.clearStorageData({ origin, storages: ["serviceworkers"] });
        cleared?.add(origin);
        if (keep?.(origin)) failed.add(origin);
      } catch (error) {
        failed.add(origin);
        options.log?.("design-live-sw-clear-failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    }
    return failed;
  };

  return {
    remember: (origin) =>
      serial(async () => {
        let canonical: string;
        try {
          canonical = new URL(origin).origin;
        } catch {
          return;
        }
        if (!ORIGIN.test(canonical)) return;
        const origins = (await read()).filter((known) => known !== canonical);
        origins.push(canonical);
        const evicted = origins.slice(0, Math.max(0, origins.length - APP_SW_ORIGINS_MAX));
        const failed = await clearEach(evicted);
        await write(origins.filter((origin) => !evicted.includes(origin) || failed.has(origin)));
      }),
    clear: (only, keep) => {
      const entry = {
        only: only ? [...only] : null,
        cleared: new Set<string>(),
        done: Promise.resolve(),
      };
      entry.done = serial(async () => {
        const origins = await read();
        const targets = entry.only ? origins.filter((origin) => entry.only!.includes(origin)) : origins;
        const failed = await clearEach(targets, keep, entry.cleared);
        if (targets.length > 0 || origins.length > 0) await write(origins.filter((origin) => !targets.includes(origin) || failed.has(origin)));
      });
      pending.add(entry);
      const drop = () => void pending.delete(entry);
      entry.done.then(drop, drop);
      return entry.done;
    },
    list: () => serial(read),
    whenCleared: (origin) => {
      const covering = [...pending].filter((entry) => entry.only === null || entry.only.includes(origin));
      if (covering.length === 0) return null;
      return Promise.all(covering.map((entry) => entry.done.catch(() => undefined))).then(() =>
        covering.some((entry) => entry.cleared.has(origin)),
      );
    },
  };
}
