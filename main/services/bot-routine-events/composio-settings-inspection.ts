import * as fs from "node:fs/promises";
import path from "node:path";
import { createKeyedSerial } from "../bot-routine-notes.js";
import { writeFileAtomic } from "../durable-fs.js";
import { COMPOSIO_SERVICE_SERVER_ID } from "../../../renderer/shared/composio-service.js";
import { mcpServerOffersTools } from "../../../renderer/shared/mcp-exposure.js";
import { isComposioServiceServer } from "../composio-service-tool.js";
import { withBotConnectorForegroundLifetime, withBotConnectorInventoryScope } from "../bot-connector-inventory-scope.js";
import { COMPOSIO_WATCH_INVENTORY_LIMITS } from "../mcp-tool-inventory.js";
import type { BotConnectorMcpClientPort } from "../mcp.js";
import type { McpServer } from "../types.js";
import { inspectComposioWatchSchemas, publicComposioWatchProbeResult, type ComposioWatchProbeResult, type ComposioWatchProbePublicResult } from "./connector-watch-composio-probe.js";

export const COMPOSIO_SETTINGS_INSPECTION_FILE = "composio-watch-inspection.json";
const serialize = createKeyedSerial();

/** Settings-owned evidence never writes a Bot's definition, access binding or session. */
export async function saveComposioSettingsInspection(profileDir: string, result: ComposioWatchProbeResult, current: () => Promise<void>): Promise<void> {
  const directory = await fs.realpath(profileDir);
  await serialize(directory, async () => {
    await current();
    const original = await fs.lstat(directory);
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("Inspection storage is unavailable.");
    const file = path.join(directory, COMPOSIO_SETTINGS_INSPECTION_FILE);
    const data = JSON.stringify({ version: 1, checkedAt: result.checkedAt, status: result.status, code: result.code, ...(result.privateProof ? { privateProof: result.privateProof } : {}) }) + "\n";
    if (Buffer.byteLength(data) > 32 * 1024) throw new Error("Inspection storage is full.");
    const check = async () => {
      await current();
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== original.dev || info.ino !== original.ino) throw new Error("Inspection storage changed.");
      try {
        const target = await fs.lstat(file);
        if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1 || target.size > 32 * 1024) throw new Error("Inspection storage is unavailable.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    await check();
    try {
      const previous = JSON.parse(await fs.readFile(file, "utf8")) as ComposioWatchProbeResult & { version?: unknown };
      const view = publicComposioWatchProbeResult(previous);
      if (previous.version !== 1 || previous.checkedAt !== view.checkedAt || previous.code !== view.code || previous.status !== view.status) throw new Error("Inspection storage is unavailable.");
      if (previous.checkedAt >= result.checkedAt) { await check(); return; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFileAtomic(file, data, { mode: 0o600, beforePublish: check });
  });
}

/** An explicit Settings action uses the person's service allowance, without editing Bot grants. */
export function createComposioSettingsInspection(ports: {
  configured(): Promise<McpServer | undefined>;
  hasExisting(serverId: string): boolean;
  withClient<T>(server: McpServer, signal: AbortSignal, action: (raw: BotConnectorMcpClientPort) => Promise<T>): Promise<T>;
  publish(result: ComposioWatchProbeResult, current: () => Promise<void>): Promise<void>;
  now?(): number;
  timeoutMs?: number;
}) {
  return async (lifetime: { signal: AbortSignal; assertCurrent(): void | Promise<void> }): Promise<ComposioWatchProbePublicResult> => {
    const now = ports.now ?? Date.now, checkedAt = now();
    const timeoutMs = ports.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error("Invalid inspection deadline.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    const current = async () => {
      signal.throwIfAborted(); await lifetime.assertCurrent(); signal.throwIfAborted();
      const server = await ports.configured();
      signal.throwIfAborted();
      if (!server || server.id !== COMPOSIO_SERVICE_SERVER_ID || !isComposioServiceServer(server) || !server.enabled
        || !mcpServerOffersTools(server) || server.hiddenTools?.length || !ports.hasExisting(server.id)) throw new Error("The existing Composio service allowance is unavailable.");
      await lifetime.assertCurrent(); signal.throwIfAborted();
    };
    const work = withBotConnectorForegroundLifetime({ signal, assertCurrent: current }, () =>
      withBotConnectorInventoryScope(COMPOSIO_SERVICE_SERVER_ID, async () => {
        await current();
        const server = (await ports.configured())!;
        await current();
        return ports.withClient(server, signal, async (raw) => {
          const result = await inspectComposioWatchSchemas({
            foreground: true,
            assertCurrent: current,
            listTools: async (cursor) => {
              if (cursor !== undefined) throw new Error("Incomplete tool metadata.");
              await current(); const tools = await raw.list(COMPOSIO_WATCH_INVENTORY_LIMITS); await current();
              return { tools, nextCursor: null };
            },
            call: async (tool, args) => {
              if (tool !== "COMPOSIO_SEARCH_TOOLS" && tool !== "COMPOSIO_GET_TOOL_SCHEMAS") throw new Error("Unsupported inspection operation.");
              await current(); return raw.call(tool, args);
            },
          }, { kind: "both", signal, now });
          await current(); await ports.publish(result, current); await current();
          return publicComposioWatchProbeResult(result);
        });
      }));
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Inspection cancelled."));
      signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
    });
    try { return await Promise.race([work, cancelled]); }
    catch { return publicComposioWatchProbeResult({ available: false, checkedAt, status: "unavailable", code: lifetime.signal.aborted ? "cancelled" : controller.signal.aborted ? "timed_out" : "inspection_failed" }); }
    finally { clearTimeout(timeout); signal.removeEventListener("abort", onAbort); controller.abort(); }
  };
}
