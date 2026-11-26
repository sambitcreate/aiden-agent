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
  /** Screens keyed by VM name so multiple Bots sharing a VM reuse one RFB connection. */
  const screens = new Map<string, CachedScreen>();
  /** Tracks which Bots last opened each VM name, for clean teardown on VM stop. */
  const botToVm = new Map<string, string>();
  const vmBots = new Map<string, Set<string>>();
  const pointers = new Map<string, BotComputerPointer>();
  const activity = deps.activity ?? createBotComputerActivity();

  const trackBotVm = (botId: string, vmName: string) => {
    const previous = botToVm.get(botId);
    if (previous && previous !== vmName) {
      const oldSet = vmBots.get(previous);
      oldSet?.delete(botId);
      if (oldSet && oldSet.size === 0) vmBots.delete(previous);
    }
    botToVm.set(botId, vmName);
    let set = vmBots.get(vmName);
    if (!set) {
      set = new Set();
      vmBots.set(vmName, set);
    }
    set.add(botId);
  };

  const drop = (vmName: string) => {
    const cached = screens.get(vmName);
    if (!cached) return;
    screens.delete(vmName);
    void cached.screen.then((screen) => screen.close()).catch(() => undefined);
  };

  /**
   * One caller's wait on a shared open. The open runs on its own signal, so a
   * caller that gives up (the Computer tab closing) never cancels it for the
   * others (the Bot's `computer` call); it is cancelled only once every caller
   * that was waiting has gone.
   */
  const join = (vmName: string, cached: CachedScreen, signal?: AbortSignal): Promise<BotComputerScreen> => {
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
          if (screens.get(vmName) === cached) screens.delete(vmName);
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
    const vmName = connection.vmName;
    trackBotVm(botId, vmName);
    const key = connectionKey(connection);
    const cached = screens.get(vmName);
    if (cached?.key === key) return join(vmName, cached, signal);
    if (cached) drop(vmName);
    if (signal?.aborted) return Promise.reject(screenOpenCancelled());
    const cancel = new AbortController();
    const opening = open(connection, cancel.signal);
    const entry: CachedScreen = { key, screen: opening, cancel, waiters: 0, settled: false, abandoned: false };
    screens.set(vmName, entry);
    opening.then(
      (screen) => {
        entry.settled = true;
        // Every caller left just as it opened: nobody holds this screen.
        if (entry.abandoned) void screen.close().catch(() => undefined);
      },
      () => {
        entry.settled = true;
        if (screens.get(vmName) === entry) screens.delete(vmName);
      },
    );
    return join(vmName, entry, signal);
  };

  const opener = async (botId: string) => {
    const open = factory;
    if (!open) {
      const name = (await deps.botName?.(botId)) ?? "The Bot";
      throw new BotComputerError("unsupported", `${name}'s computer screen isn't available in this build.`);
    }
    return (connection: BotComputerConnection, signal?: AbortSignal) => openFor(open, botId, connection, signal);
  };

  const checkVmScreen = async (vmName: string) => {
    const bots = [...(vmBots.get(vmName) ?? [])];
    if (bots.length === 0) {
      drop(vmName);
      return;
    }
    let anyRunning = false;
    for (const id of bots) {
      const computer = await deps.host.computer(id).catch(() => undefined);
      if (!computer || computer.state !== "running") {
        pointers.delete(id);
      }
      if (computer && computer.vmName === vmName && computer.state === "running") {
        anyRunning = true;
      }
    }
    if (!anyRunning) drop(vmName);
  };

  deps.host.onChange((botId) => {
    if (botId === undefined) {
      for (const vmName of [...screens.keys()]) void checkVmScreen(vmName);
      for (const id of [...pointers.keys()]) {
        if (!botToVm.has(id)) {
          void deps.host
            .computer(id)
            .then((computer) => {
              if (!computer || computer.state !== "running") pointers.delete(id);
            })
            .catch(() => pointers.delete(id));
        }
      }
      return;
    }
    const vmName = botToVm.get(botId);
    if (vmName) {
      void checkVmScreen(vmName);
    } else {
      void deps.host
        .computer(botId)
        .then((computer) => {
          if (!computer || computer.state !== "running") pointers.delete(botId);
        })
        .catch(() => pointers.delete(botId));
    }
  });

  return {
    control: deps.control,

    setScreenFactory(next) {
      factory = next;
      for (const vmName of [...screens.keys()]) drop(vmName);
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
