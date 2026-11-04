import type { BotMessageCourier } from "./courier.js";

/** Keep quit closed even when a late tool asks for the process-wide service. */
export function createBotMessageLifecycle(deps: {
  create(): BotMessageCourier;
  report(error: unknown): void;
}): BotMessageCourier {
  let current: BotMessageCourier | undefined;
  let closed = false;
  const requireCurrent = () => {
    if (closed) throw new Error("Bot messaging is shut down.");
    return (current ??= deps.create());
  };
  return {
    post: (input) =>
      closed
        ? Promise.resolve({ status: "refused", code: "unavailable", message: "Bot messaging is shut down." })
        : requireCurrent().post(input),
    async start() {
      // Only explicit runtime initialization may open a new lifecycle.
      if (closed) {
        current = undefined;
        closed = false;
      }
      try {
        await requireCurrent().start();
      } catch (error) {
        deps.report(error);
      }
    },
    announceWaiting: (...args) => requireCurrent().announceWaiting(...args),
    forgetBot: (id) => requireCurrent().forgetBot(id),
    async dispose() {
      closed = true;
      await current?.dispose();
    },
  };
}
