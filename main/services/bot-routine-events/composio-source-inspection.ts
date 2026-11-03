import { COMPOSIO_SERVICE_TOOL_NAME, composioServiceToolDescriptor, isComposioServiceServer } from "../composio-service-tool.js";
import { botMcpLiveToolMatchesGrant } from "../bot-tool-authority.js";
import type { BotRuntimeAuthorityAdmission, BotRuntimeConnectionAuthority } from "../bot-runtime-authority.js";
import type { BotConnectorMcpClientPort } from "../mcp.js";
import type { McpServer } from "../types.js";
import { COMPOSIO_WATCH_INVENTORY_LIMITS } from "../mcp-tool-inventory.js";
import { withBotConnectorForegroundLifetime } from "../bot-connector-inventory-scope.js";
import { BotConnectorWatchError } from "./connector-service.js";
import { inspectComposioWatchSchemas, publicComposioWatchProbeResult, type ComposioWatchProbeResult } from "./connector-watch-composio-probe.js";

interface ComposioSourceInspectionPorts {
  hasExistingConnector(serverId: string): boolean;
  preflight(botId: string, server: McpServer, signal: AbortSignal): Promise<void>;
  admit(botId: string, serverId: string): Promise<BotRuntimeAuthorityAdmission>;
  connection(admission: BotRuntimeAuthorityAdmission, serverId: string): Promise<BotRuntimeConnectionAuthority>;
  withClient<T>(server: McpServer, signal: AbortSignal, action: (raw: BotConnectorMcpClientPort) => Promise<T>): Promise<T>;
  /** The host serializes publication with Bot mutation/deletion and writes only structural evidence. */
  publish(botId: string, result: ComposioWatchProbeResult, assertCurrent: () => Promise<void>): Promise<void>;
  now?(): number;
  /** Tests may shorten, never extend, the whole-operation deadline. */
  timeoutMs?: number;
}

/** Construct only in the host's explicit Find sources path; never in a watch read adapter. */
export function createComposioSourceInspection(ports: ComposioSourceInspectionPorts) {
  return async (botId: string, server: McpServer, signal: AbortSignal, assertActive: () => Promise<void>): Promise<string> => {
    const timeoutMs = ports.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new BotConnectorWatchError("invalid_request", "Invalid Composio inspection deadline.");
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new BotConnectorWatchError("unavailable", "Composio inspection timed out. Try again in the foreground.")), timeoutMs);
    const operationSignal = AbortSignal.any([signal, deadline.signal]);
    let admission: BotRuntimeAuthorityAdmission | undefined; let released = false;
    const release = () => { if (admission && !released) { released = true; admission.release(); } };
    const foreground = async () => {
      operationSignal.throwIfAborted(); await assertActive();
      await ports.preflight(botId, server, operationSignal);
      operationSignal.throwIfAborted();
    };
    const work = withBotConnectorForegroundLifetime({ signal: operationSignal, assertCurrent: foreground }, async () => {
      if (!isComposioServiceServer(server)) throw new BotConnectorWatchError("unavailable", "Restore the catalog Composio connection in Settings → Connectors.");
      if (!ports.hasExistingConnector(server.id)) throw new BotConnectorWatchError("unavailable", "Connect Composio in Settings → Connectors, then find sources again.");
      await foreground();
      admission = await ports.admit(botId, server.id);
      if (operationSignal.aborted) { release(); operationSignal.throwIfAborted(); }
      const held = admission;
      const combined = AbortSignal.any([operationSignal, held.signal]);
      try {
        const grant = await ports.connection(held, server.id);
        combined.throwIfAborted(); await foreground();
        const service = grant.tools.find((tool) => tool.name === COMPOSIO_SERVICE_TOOL_NAME);
        if (!service || !botMcpLiveToolMatchesGrant(service, composioServiceToolDescriptor())) {
          throw new BotConnectorWatchError("capability_denied", "Allow Composio once in this Bot’s Access settings, then find sources again.");
        }
        const current = async (callSignal = combined) => {
          callSignal.throwIfAborted(); combined.throwIfAborted(); await foreground();
          await held.revalidateBeforeEffect();
          await foreground(); callSignal.throwIfAborted(); combined.throwIfAborted();
        };
        return await ports.withClient(server, combined, async (raw) => {
          const result = await inspectComposioWatchSchemas({
            foreground: true,
            assertCurrent: current,
            listTools: async (cursor, callSignal) => {
              if (cursor !== undefined) throw new BotConnectorWatchError("unavailable", "Composio’s tool information was incomplete.");
              await current(callSignal);
              const tools = await raw.list(COMPOSIO_WATCH_INVENTORY_LIMITS); await current(callSignal);
              return { tools, nextCursor: null };
            },
            call: async (tool, args, callSignal) => {
              // Keep the send boundary closed independently of vendor plans and
              // future changes to the schema probe's implementation.
              if (tool !== "COMPOSIO_SEARCH_TOOLS" && tool !== "COMPOSIO_GET_TOOL_SCHEMAS") throw new BotConnectorWatchError("unavailable", "This inspection only reads Composio’s watch setup information.");
              await current(callSignal);
              return raw.call(tool, args);
            },
          }, { kind: "both", signal: combined, now: ports.now });
          await current();
          await ports.publish(botId, result, current);
          return publicComposioWatchProbeResult(result).message;
        });
      } finally { release(); }
    });
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(operationSignal.reason);
      operationSignal.addEventListener("abort", onAbort, { once: true });
      if (operationSignal.aborted) onAbort();
    });
    try { return await Promise.race([work, cancelled]); }
    finally { clearTimeout(timeout); operationSignal.removeEventListener("abort", onAbort); deadline.abort(); release(); }
  };
}
