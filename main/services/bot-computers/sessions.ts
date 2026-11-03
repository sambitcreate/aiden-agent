import type { BotComputerControlRegistry } from "./control.js";
import {
  BotComputerError,
  type BotComputerConnection,
  type BotComputerHost,
  type BotComputerPointer,
  type BotComputerScreen,
  type BotComputerScreenFactory,
  type BotComputerSessions,
  type BotComputerStartReason,
} from "./types.js";

/** "Ada is using Safari": the status line under the Computer tab and in the profile. */
export interface BotComputerActivity {
  get(botId: string): string | undefined;
  set(botId: string, text: string | undefined): void;
  onChange(listener: (botId: string) => void): () => void;
}

export function createBotComputerActivity(): BotComputerActivity {
  const activity = new Map<string, string>();
  const listeners = new Set<(botId: string) => void>();
  return {
    get: (botId) => activity.get(botId),
    set(botId, text) {
      const next = typeof text === "string" ? text.trim().slice(0, 200) : "";
      const previous = activity.get(botId);
      if (next) activity.set(botId, next);
      else activity.delete(botId);
      if ((previous ?? "") === next) return;
      for (const listener of listeners) {
        try {
          listener(botId);
        } catch {
          // Advisory only.
        }
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export interface BotComputerSessionsDependencies {
  host: Pick<BotComputerHost, "ensureRunning" | "runningConnection" | "computer" | "onChange">;
  control: BotComputerControlRegistry;
  activity?: BotComputerActivity;
  /** The Bot's display name, for "Ada's computer screen isn't available…". */
  botName?(botId: string): string | Promise<string>;
}

interface CachedScreen {
  key: string;
  screen: Promise<BotComputerScreen>;
  /** Cancels the open itself, once no caller is waiting for it. */
  cancel: AbortController;
  /** Callers still waiting with a signal; infinite once one waits without a signal. */
  waiters: number;
  settled: boolean;
  /** Every waiting caller left before it opened; whatever opens is closed. */
  abandoned: boolean;
}

function screenOpenCancelled(): BotComputerError {
  return new BotComputerError("cancelled", "Opening the computer's screen was cancelled.");
}

function connectionKey(connection: BotComputerConnection): string {
  return `${connection.vmName}\u0000${connection.vnc.port}\u0000${connection.vnc.password}`;
}

/**
 * The per-Bot screen registry P9 and P10 share. `screen()` starts the computer
 * when needed and opens one screen per run through the factory P9 installs;
 * a stopped or restarted computer drops its cached screen. Pointer and
 * activity are what the viewer draws (the Bot's avatar at its last action).
 */
export function createBotComputerSessions(
  deps: BotComputerSessionsDependencies,
): BotComputerSessions & { screen(botId: string, signal?: AbortSignal, options?: { reason?: BotComputerStartReason }): Promise<BotComputerScreen> } {
  let factory: BotComputerScreenFactory | undefined;
  const screens = new Map<string, CachedScreen>();
  const pointers = new Map<string, BotComputerPointer>();
  const activity = deps.activity ?? createBotComputerActivity();

  const drop = (botId: string) => {
    const cached = screens.get(botId);
    if (!cached) return;
    screens.delete(botId);
    void cached.screen.then((screen) => screen.close()).catch(() => undefined);
  };

  /**
   * One caller's wait on a shared open. The open runs on its own signal, so a
   * caller that gives up (the Computer tab closing) never cancels it for the
   * others (the Bot's `computer` call); it is cancelled only once every caller
   * that was waiting has gone.
   */
  const join = (botId: string, cached: CachedScreen, signal?: AbortSignal): Promise<BotComputerScreen> => {
    if (cached.settled) return cached.screen;
    if (!signal) {
      cached.waiters = Number.POSITIVE_INFINITY;
      return cached.screen;
    }
    if (signal.aborted) return Promise.reject(screenOpenCancelled());
    cached.waiters += 1;
    return new Promise<BotComputerScreen>((resolve, reject) => {
      const leave = () => {
        cached.waiters -= 1;
        if (!cached.settled && cached.waiters <= 0) {
          cached.abandoned = true;
          cached.cancel.abort();
          if (screens.get(botId) === cached) screens.delete(botId);
        }
        reject(screenOpenCancelled());
      };
      signal.addEventListener("abort", leave, { once: true });
      cached.screen.then(
        (screen) => {
          signal.removeEventListener("abort", leave);
          resolve(screen);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", leave);
          reject(error);
        },
      );
    });
  };

  /** This run's cached screen, or a new one through the factory. */
  const openFor = (
    open: BotComputerScreenFactory,
    botId: string,
    connection: BotComputerConnection,
    signal?: AbortSignal,
  ): Promise<BotComputerScreen> => {
    const key = connectionKey(connection);
    const cached = screens.get(botId);
    if (cached?.key === key) return join(botId, cached, signal);
    if (cached) drop(botId);
    if (signal?.aborted) return Promise.reject(screenOpenCancelled());
    const cancel = new AbortController();
    const opening = open(connection, cancel.signal);
    const entry: CachedScreen = { key, screen: opening, cancel, waiters: 0, settled: false, abandoned: false };
    screens.set(botId, entry);
    opening.then(
      (screen) => {
        entry.settled = true;
        // Every caller left just as it opened: nobody holds this screen.
        if (entry.abandoned) void screen.close().catch(() => undefined);
      },
      () => {
        entry.settled = true;
        if (screens.get(botId) === entry) screens.delete(botId);
      },
    );
    return join(botId, entry, signal);
  };

  const opener = async (botId: string) => {
    const open = factory;
    if (!open) {
      const name = (await deps.botName?.(botId)) ?? "The Bot";
      throw new BotComputerError("unsupported", `${name}'s computer screen isn't available in this build.`);
    }
    return (connection: BotComputerConnection, signal?: AbortSignal) => openFor(open, botId, connection, signal);
  };

  deps.host.onChange((botId) => {
    const ids = botId === undefined ? [...screens.keys()] : [botId];
    for (const id of ids) {
      void deps.host
        .computer(id)
        .then((computer) => {
          if (!computer || computer.state !== "running") {
            drop(id);
            pointers.delete(id);
          }
        })
        .catch(() => drop(id));
    }
  });

  return {
    control: deps.control,

    setScreenFactory(next) {
      factory = next;
      for (const botId of [...screens.keys()]) drop(botId);
    },

    async screen(botId: string, signal?: AbortSignal, options: { reason?: BotComputerStartReason } = {}) {
      const open = await opener(botId);
      return open(await deps.host.ensureRunning(botId, { reason: options.reason ?? "tool", signal }), signal);
    },

    async runningScreen(botId, signal) {
      const open = await opener(botId);
      // Read with no await before the open: a stop can't land between the check and the use.
      const connection = deps.host.runningConnection(botId);
      if (!connection) throw new BotComputerError("cancelled", "The computer isn't running.");
      return open(connection, signal);
    },

    recordPointer(botId, pointer) {
      const valid =
        [pointer.x, pointer.y, pointer.width, pointer.height].every((value) => Number.isFinite(value)) &&
        pointer.width > 0 &&
        pointer.height > 0;
      if (valid) pointers.set(botId, { ...pointer });
    },

    lastPointer: (botId) => {
      const pointer = pointers.get(botId);
      return pointer ? { ...pointer } : undefined;
    },

    setActivity: (botId, text) => activity.set(botId, text),
  };
}
