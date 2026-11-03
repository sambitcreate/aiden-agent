import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import type { ComposioWatchProbePublicResult } from "../services/bot-routine-events/connector-watch-composio-probe.js";

export function registerComposioWatchInspection<Event>(ports: {
  handle(channel: string, handler: (event: Event, value?: unknown) => Promise<unknown>): void;
  owner(event: Event): Pick<RendererDocumentOwner, "isDestroyed" | "onInvalidated">;
  inspect(lifetime: { signal: AbortSignal; assertCurrent(): void }): Promise<ComposioWatchProbePublicResult>;
}) {
  ports.handle("mcp:composioWatch:inspect", async (event, value) => {
    const owner = ports.owner(event);
    const current = () => { if (owner.isDestroyed()) throw new Error("The application document is no longer active."); };
    current();
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length)) throw new Error("Invalid inspection request.");
    const abort = new AbortController(); const detach = owner.onInvalidated(() => abort.abort());
    try {
      current();
      const result = await ports.inspect({ signal: abort.signal, assertCurrent: current });
      abort.signal.throwIfAborted(); current(); return result;
    } finally { detach(); abort.abort(); }
  });
}
