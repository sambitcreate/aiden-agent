import { BotComputerError, BotComputerTakenOverError, type BotComputerControl, type BotComputerTakeOverSource } from "./types.js";

/** The tool-result note P10 adds once the person gives the computer back (plan §8.5). */
export const BOT_COMPUTER_GIVE_BACK_NOTE = "The person used the computer; take a fresh capture first.";

/**
 * How long a routine or Telegram turn waits for the person to give the
 * computer back. Nobody answers on those turns, so the call gives up rather
 * than holding the run open for as long as the person keeps the computer.
 */
export const BOT_COMPUTER_UNATTENDED_WAIT_MS = 5 * 60_000;

/** What a computer call on an unattended turn tells the Bot once it stopped waiting for the person. */
export function botComputerUnattendedGaveUp(possessive: string): string {
  return `The person is still using ${possessive} computer, so this run stopped waiting for it. Don't use the computer again on this run; say in your reply what's left to do.`;
}

/**
 * Waits until the Bot has its computer again. With `limitMs` (a turn nobody
 * watches), it stops waiting after that long and resolves false; the person
 * keeps the computer. The caller's own cancellation still rejects.
 */
export async function waitForBotWithin(
  control: Pick<BotComputerControl, "waitForBot">,
  botId: string,
  signal: AbortSignal | undefined,
  limitMs?: number,
): Promise<boolean> {
  if (limitMs === undefined) {
    await control.waitForBot(botId, signal);
    return true;
  }
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), limitMs);
  timer.unref?.();
  try {
    await control.waitForBot(botId, signal ? AbortSignal.any([signal, giveUp.signal]) : giveUp.signal);
    return true;
  } catch (error) {
    if (giveUp.signal.aborted && !signal?.aborted) return false;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

interface ControlEntry {
  controller: "bot" | "person";
  by?: BotComputerTakeOverSource;
  actions: Set<AbortController>;
  waiters: Set<() => void>;
}

/**
 * Who drives each Bot's computer. Take over aborts the Bot's in-flight action
 * (the turn stays alive and can wait), and every later action is refused
 * until Give back, so the model never sees the screen while the person has it.
 */
export function createBotComputerControl(): BotComputerControl & {
  /** Who took over, while the person has control. */
  takenOverBy(botId: string): BotComputerTakeOverSource | undefined;
  /** In-flight Bot actions; a computer with any is never idle. */
  activeActions(botId: string): number;
  forget(botId: string): void;
} {
  const entries = new Map<string, ControlEntry>();
  const listeners = new Set<(botId: string) => void>();
  const entry = (botId: string): ControlEntry => {
    let found = entries.get(botId);
    if (!found) {
      found = { controller: "bot", actions: new Set(), waiters: new Set() };
      entries.set(botId, found);
    }
    return found;
  };
  const emit = (botId: string) => {
    for (const listener of listeners) {
      try {
        listener(botId);
      } catch {
        // A failing listener never blocks Take over.
      }
    }
  };

  return {
    controller: (botId) => entries.get(botId)?.controller ?? "bot",
    takenOverBy: (botId) => (entries.get(botId)?.controller === "person" ? entries.get(botId)?.by : undefined),
    activeActions: (botId) => entries.get(botId)?.actions.size ?? 0,

    takeOver(botId, by) {
      const current = entry(botId);
      const changed = current.controller !== "person";
      current.controller = "person";
      current.by = by;
      for (const action of current.actions) action.abort(new BotComputerTakenOverError());
      if (changed) emit(botId);
    },

    giveBack(botId) {
      const current = entries.get(botId);
      if (!current || current.controller === "bot") return;
      current.controller = "bot";
      current.by = undefined;
      const waiters = [...current.waiters];
      current.waiters.clear();
      for (const resolve of waiters) resolve();
      emit(botId);
    },

    async run(botId, signal, action) {
      const current = entry(botId);
      if (current.controller === "person") throw new BotComputerTakenOverError();
      if (signal?.aborted) throw new BotComputerError("cancelled", "The computer action was cancelled.");
      const controller = new AbortController();
      const forward = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", forward, { once: true });
      current.actions.add(controller);
      try {
        const result = await action(controller.signal);
        if (controller.signal.reason instanceof BotComputerTakenOverError) throw controller.signal.reason;
        return result;
      } catch (error) {
        if (controller.signal.reason instanceof BotComputerTakenOverError) throw controller.signal.reason;
        throw error;
      } finally {
        current.actions.delete(controller);
        signal?.removeEventListener("abort", forward);
      }
    },

    waitForBot(botId, signal) {
      const current = entry(botId);
      if (current.controller === "bot") return Promise.resolve();
      if (signal?.aborted) return Promise.reject(new BotComputerError("cancelled", "Waiting for the computer was cancelled."));
      return new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          current.waiters.delete(done);
          reject(new BotComputerError("cancelled", "Waiting for the computer was cancelled."));
        };
        current.waiters.add(done);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    forget(botId) {
      const current = entries.get(botId);
      if (!current) return;
      for (const action of current.actions) action.abort(new BotComputerError("cancelled", "The Bot's computer was removed."));
      for (const resolve of current.waiters) resolve();
      entries.delete(botId);
    },
  };
}

export type BotComputerControlRegistry = ReturnType<typeof createBotComputerControl>;
