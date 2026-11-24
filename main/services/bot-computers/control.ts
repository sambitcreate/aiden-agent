import { BotComputerError, BotComputerTakenOverError, type BotComputerControl, type BotComputerTakeOverSource } from "./types.js";

/** The tool-result note P10 adds once the person gives the computer back (plan §8.5). */
export const BOT_COMPUTER_GIVE_BACK_NOTE = "The person used the computer; take a fresh capture first.";

/**
 * How long a routine or Telegram turn waits, in all, for the person to give
 * the computer back. Nobody answers on those turns, so its calls give up
 * rather than holding the run open for as long as the person keeps the computer.
 */
export const BOT_COMPUTER_UNATTENDED_WAIT_MS = 5 * 60_000;

/**
 * What is left of one unattended turn's wait for Give back. The turn's
 * `computer` and `computer_shell` share it, so a Bot that calls again after
 * giving up doesn't wait the whole time over.
 */
export interface BotComputerGiveBackBudget {
  remainingMs: number;
}

/** What a computer call on an unattended turn tells the Bot once it stopped waiting for the person. */
export function botComputerUnattendedGaveUp(possessive: string): string {
  return `The person is still using ${possessive} computer, so this run stopped waiting for it. Don't use the computer again on this run; say in your reply what's left to do.`;
}

/**
 * Waits until the Bot has its computer again. With a `budget` (a turn nobody
 * watches), it waits at most what is left of it, spends what it waited, and
 * resolves false once it is used up; the person keeps the computer. The
 * caller's own cancellation still rejects.
 */
export async function waitForBotWithin(
  control: Pick<BotComputerControl, "waitForBot">,
  botId: string,
  signal: AbortSignal | undefined,
  budget?: BotComputerGiveBackBudget,
): Promise<boolean> {
  if (budget === undefined) {
    await control.waitForBot(botId, signal);
    return true;
  }
  const giveUp = new AbortController();
  // Used up: a computer the Bot has back still resolves at once; one the person holds doesn't wait.
  if (budget.remainingMs <= 0) giveUp.abort();
  const timer = budget.remainingMs > 0 ? setTimeout(() => giveUp.abort(), budget.remainingMs) : undefined;
  timer?.unref?.();
  const started = performance.now();
  try {
    await control.waitForBot(botId, signal ? AbortSignal.any([signal, giveUp.signal]) : giveUp.signal);
    return true;
  } catch (error) {
    if (giveUp.signal.aborted && !signal?.aborted) return false;
    throw error;
  } finally {
    clearTimeout(timer);
    budget.remainingMs = giveUp.signal.aborted ? 0 : Math.max(0, budget.remainingMs - (performance.now() - started));
  }
}

interface ControlEntry {
  controller: "bot" | "person";
  by?: BotComputerTakeOverSource;
  actions: Set<{ botId: string; controller: AbortController }>;
  waiters: Set<{ botId: string; resolve(): void }>;
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
  /** In-flight Bot actions for a specific VM scope. */
  activeActionsForScope(scope: string): number;
  /** Controller for a specific VM scope (`"bot"` or `"person"`). */
  controllerForScope(scope: string): "bot" | "person";
  /** Who took over a specific VM scope. */
  takenOverByScope(scope: string): BotComputerTakeOverSource | undefined;
  /** Give a specific VM scope back to Bots. */
  giveBackScope(scope: string): void;
  /**
   * Map a `botId` to its shared/dedicated VM scope so Take over and sign-in
   * handoff on a shared VM block every Bot assigned to that VM together.
   */
  setScopeResolver(
    resolveScope: (botId: string) => string,
    membersForScope?: (scope: string) => readonly string[],
  ): void;
  forget(botId: string): void;
  forgetScope(scope: string): void;
} {
  const entries = new Map<string, ControlEntry>();
  const listeners = new Set<(botId: string) => void>();
  let resolveScope: (botId: string) => string = (botId) => botId;
  let membersForScope: (scope: string) => readonly string[] = () => [];
  const entry = (scope: string): ControlEntry => {
    let found = entries.get(scope);
    if (!found) {
      found = { controller: "bot", actions: new Set(), waiters: new Set() };
      entries.set(scope, found);
    }
    return found;
  };
  const emitScope = (scope: string, originBotId?: string) => {
    const targets = new Set<string>(membersForScope(scope));
    if (originBotId) targets.add(originBotId);
    if (targets.size === 0) targets.add(scope);
    for (const botId of targets) {
      for (const listener of listeners) {
        try {
          listener(botId);
        } catch {
          // A failing listener never blocks Take over.
        }
      }
    }
  };

  const giveBackScope = (scope: string, originBotId?: string) => {
    const current = entries.get(scope);
    if (!current || current.controller === "bot") return;
    current.controller = "bot";
    current.by = undefined;
    const waiters = [...current.waiters];
    current.waiters.clear();
    for (const waiter of waiters) waiter.resolve();
    emitScope(scope, originBotId);
  };

  const forgetScope = (scope: string) => {
    const current = entries.get(scope);
    if (!current) return;
    for (const action of current.actions) action.controller.abort(new BotComputerError("cancelled", "The Bot's computer was removed."));
    for (const waiter of current.waiters) waiter.resolve();
    entries.delete(scope);
  };

  return {
    controller: (botId) => entries.get(resolveScope(botId))?.controller ?? "bot",
    takenOverBy: (botId) => {
      const current = entries.get(resolveScope(botId));
      return current?.controller === "person" ? current.by : undefined;
    },
    activeActions: (botId) => entries.get(resolveScope(botId))?.actions.size ?? 0,
    activeActionsForScope: (scope) => entries.get(scope)?.actions.size ?? 0,
    controllerForScope: (scope) => entries.get(scope)?.controller ?? "bot",
    takenOverByScope: (scope) => {
      const current = entries.get(scope);
      return current?.controller === "person" ? current.by : undefined;
    },
    giveBackScope: (scope) => giveBackScope(scope),
    setScopeResolver(nextResolve, nextMembers) {
      resolveScope = nextResolve;
      membersForScope = nextMembers ?? (() => []);
    },

    takeOver(botId, by) {
      const scope = resolveScope(botId);
      const current = entry(scope);
      const changed = current.controller !== "person";
      current.controller = "person";
      current.by = by;
      for (const action of current.actions) action.controller.abort(new BotComputerTakenOverError());
      if (changed) emitScope(scope, botId);
    },

    giveBack(botId) {
      giveBackScope(resolveScope(botId), botId);
    },

    async run(botId, signal, action) {
      const current = entry(resolveScope(botId));
      if (current.controller === "person") throw new BotComputerTakenOverError();
      if (signal?.aborted) throw new BotComputerError("cancelled", "The computer action was cancelled.");
      const controller = new AbortController();
      const forward = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", forward, { once: true });
      const tracked = { botId, controller };
      current.actions.add(tracked);
      try {
        const result = await action(controller.signal);
        if (controller.signal.reason instanceof BotComputerTakenOverError) throw controller.signal.reason;
        return result;
      } catch (error) {
        if (controller.signal.reason instanceof BotComputerTakenOverError) throw controller.signal.reason;
        throw error;
      } finally {
        current.actions.delete(tracked);
        signal?.removeEventListener("abort", forward);
      }
    },

    waitForBot(botId, signal) {
      const current = entry(resolveScope(botId));
      if (current.controller === "bot") return Promise.resolve();
      if (signal?.aborted) return Promise.reject(new BotComputerError("cancelled", "Waiting for the computer was cancelled."));
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          botId,
          resolve: () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          },
        };
        const abort = () => {
          current.waiters.delete(waiter);
          reject(new BotComputerError("cancelled", "Waiting for the computer was cancelled."));
        };
        current.waiters.add(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    forget(botId) {
      const scope = resolveScope(botId);
      if (scope === botId) {
        forgetScope(scope);
        return;
      }
      const current = entries.get(scope);
      if (!current) return;
      for (const action of [...current.actions]) {
        if (action.botId === botId) {
          current.actions.delete(action);
          action.controller.abort(new BotComputerError("cancelled", "The Bot's computer was removed."));
        }
      }
      for (const waiter of [...current.waiters]) {
        if (waiter.botId === botId) {
          current.waiters.delete(waiter);
          waiter.resolve();
        }
      }
    },

    forgetScope,
  };
}

export type BotComputerControlRegistry = ReturnType<typeof createBotComputerControl>;
