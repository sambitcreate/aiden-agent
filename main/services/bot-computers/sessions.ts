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
  host: Pick<BotComputerHost, "ensureRunning" | "computer" | "onChange">;
  control: BotComputerControlRegistry;
  activity?: BotComputerActivity;
  /** The Bot's display name, for "Ada's computer screen isn't available…". */
  botName?(botId: string): string | Promise<string>;
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
  const screens = new Map<string, { key: string; screen: Promise<BotComputerScreen> }>();
  const pointers = new Map<string, BotComputerPointer>();
  const activity = deps.activity ?? createBotComputerActivity();

  const drop = (botId: string) => {
    const cached = screens.get(botId);
    if (!cached) return;
    screens.delete(botId);
    void cached.screen.then((screen) => screen.close()).catch(() => undefined);
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
      if (!factory) {
        const name = (await deps.botName?.(botId)) ?? "The Bot";
        throw new BotComputerError("unsupported", `${name}'s computer screen isn't available in this build.`);
      }
      const connection = await deps.host.ensureRunning(botId, { reason: options.reason ?? "tool", signal });
      const key = connectionKey(connection);
      const cached = screens.get(botId);
      if (cached?.key === key) return cached.screen;
      if (cached) drop(botId);
      const opening = factory(connection, signal);
      screens.set(botId, { key, screen: opening });
      opening.catch(() => {
        if (screens.get(botId)?.screen === opening) screens.delete(botId);
      });
      return opening;
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
