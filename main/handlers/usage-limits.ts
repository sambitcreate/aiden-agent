import type { UsageLimitWaitView } from "../../renderer/shared/usage-limits.js";
import type { UsageLimitOwner } from "../services/usage-limit-core.js";

/** The replies waiting for a usage limit, and the person's Retry now on one chat or Bot. */
export function registerUsageLimitHandlers<Event>(dependencies: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  limits: {
    ready(): Promise<void>;
    waits(): UsageLimitWaitView[];
    retryNow(owner: UsageLimitOwner): boolean;
  };
}): void {
  dependencies.handle("usageLimits:list", async () => {
    await dependencies.limits.ready();
    return dependencies.limits.waits();
  });
  dependencies.handle("usageLimits:retryNow", (_event, kind, id) => {
    if ((kind !== "chat" && kind !== "bot") || typeof id !== "string" || !id || id.length > 200) {
      throw new Error("Invalid Retry now request.");
    }
    return dependencies.limits.retryNow({ kind, id });
  });
}
