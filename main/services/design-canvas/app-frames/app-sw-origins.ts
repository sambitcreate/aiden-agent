// App service workers don't outlive design mode (design mode v2 Phase 3a,
// S76). Main keeps a device-local list of admitted app origins (origins only,
// at most 64) and clears their service workers when design mode ends for the
// workspace and at every start, flag on or off, then empties the list.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const APP_SW_ORIGINS_MAX = 64;

const ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/u;

export type AppServiceWorkerOrigins = {
  /** Adds an origin (kept to the newest 64). */
  remember(origin: string): Promise<void>;
  /** Clears service workers for the given origins (all remembered ones when omitted) and forgets them. */
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
      return origins.filter((origin): origin is string => typeof origin === "string" && ORIGIN.test(origin)).slice(-APP_SW_ORIGINS_MAX);
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
        await write(origins.slice(-APP_SW_ORIGINS_MAX));
      }),
    clear: (only) =>
      serial(async () => {
        const origins = await read();
        const targets = only ? origins.filter((origin) => only.includes(origin)) : origins;
        for (const origin of targets) {
          try {
            await options.session.clearStorageData({ origin, storages: ["serviceworkers"] });
          } catch (error) {
            options.log?.("design-live-sw-clear-failed", { error: error instanceof Error ? error.name : "unknown" });
          }
        }
        if (targets.length > 0 || origins.length > 0) await write(origins.filter((origin) => !targets.includes(origin)));
      }),
    list: () => serial(read),
  };
}
