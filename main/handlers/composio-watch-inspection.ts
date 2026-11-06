import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import type { ComposioWatchProbePublicResult } from "../services/bot-routine-events/connector-watch-composio-probe.js";

export function registerComposioWatchInspection<Event>(ports: {
  handle(channel: string, handler: (event: Event, value?: unknown) => Promise<unknown>): void;
  owner(event: Event): Pick<RendererDocumentOwner, "isDestroyed" | "onInvalidated">;
  inspect(lifetime: { signal: AbortSignal; assertCurrent(): void }): Promise<ComposioWatchProbePublicResult>;
  checkCalendarReads?(lifetime: { signal: AbortSignal; assertCurrent(): void }): Promise<{ message: string }>;
}) {
  ports.handle("mcp:composioWatch:inspect", async (event, value) => {
    const owner = ports.owner(event);
    const current = () => { if (owner.isDestroyed()) throw new Error("The application document is no longer active."); };
    current();
    const calendarRead = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && Object.keys(value)[0] === "calendarRead" && (value as { calendarRead?: unknown }).calendarRead === true;
    if (!calendarRead && value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length)) throw new Error("Invalid inspection request.");
    if (calendarRead && !ports.checkCalendarReads) throw new Error("Calendar read checking is unavailable.");
    const abort = new AbortController(); const detach = owner.onInvalidated(() => abort.abort());
    try {
      current();
      const lifetime = { signal: abort.signal, assertCurrent: current };
      const result = calendarRead ? await ports.checkCalendarReads!(lifetime) : await ports.inspect(lifetime);
      abort.signal.throwIfAborted(); current(); return result;
    } finally { detach(); abort.abort(); }
  });
}
