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
  /** Clears service workers for the given origins (all remembered ones when omitted) and forgets those cleared. */
  clear(origins?: readonly string[]): Promise<void>;
  /** The remembered origins. */
  list(): Promise<string[]>;
};

export function createAppServiceWorkerOrigins(options: {
  file: string;
  session: { clearStorageData(options: { origin: string; storages: Array<"serviceworkers"> }): Promise<void> };
  log?: (event: string, fields: Record<string, unknown>) => void;
}): AppServiceWorkerOrigins {
  let queue: Promise<unknown> = Promise.resolve();
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

  /** Clears each origin's service workers; returns those that failed. */
  const clearEach = async (origins: readonly string[]): Promise<Set<string>> => {
    const failed = new Set<string>();
    for (const origin of origins) {
      try {
        await options.session.clearStorageData({ origin, storages: ["serviceworkers"] });
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
    clear: (only) =>
      serial(async () => {
        const origins = await read();
        const targets = only ? origins.filter((origin) => only.includes(origin)) : origins;
        const failed = await clearEach(targets);
        if (targets.length > 0 || origins.length > 0) await write(origins.filter((origin) => !targets.includes(origin) || failed.has(origin)));
      }),
    list: () => serial(read),
  };
}
