import * as fs from "node:fs/promises";
import path from "node:path";
import { COMPOSIO_SERVICE_SERVER_ID } from "../../../renderer/shared/composio-service.js";
import { mcpServerOffersTools } from "../../../renderer/shared/mcp-exposure.js";
import { withBotConnectorForegroundLifetime, withBotConnectorInventoryScope } from "../bot-connector-inventory-scope.js";
import { createKeyedSerial } from "../bot-routine-notes.js";
import { isComposioServiceServer } from "../composio-service-tool.js";
import { writeFileAtomic } from "../durable-fs.js";
import type { ForegroundComposioSettingsClientPort } from "../foreground-composio-settings-client.js";
import type { McpServer } from "../types.js";
import { checkComposioCalendarRead, publicComposioCalendarReadCheckResult, type ComposioCalendarReadCheckResult } from "./composio-calendar-read-check.js";

export const COMPOSIO_CALENDAR_READ_CHECK_FILE = "composio-calendar-read-check.json";
const serialize = createKeyedSerial();

/** Bounded private diagnostics only. No account identities or runtime authority. */
export async function saveComposioCalendarReadCheck(profileDir: string, result: ComposioCalendarReadCheckResult, current: () => Promise<void>): Promise<void> {
  const directory = await fs.realpath(profileDir);
  await serialize(directory, async () => {
    await current();
    const original = await fs.lstat(directory);
    if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("Calendar check storage is unavailable.");
    const file = path.join(directory, COMPOSIO_CALENDAR_READ_CHECK_FILE);
    const view = publicComposioCalendarReadCheckResult(result);
    const data = JSON.stringify({ version: 1, checkedAt: view.checkedAt, status: view.status, code: view.code, privateProof: result.privateProof }) + "\n";
    if (Buffer.byteLength(data) > 32 * 1024) throw new Error("Calendar check storage is full.");
    const check = async () => {
      await current();
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== original.dev || info.ino !== original.ino) throw new Error("Calendar check storage changed.");
      try {
        const target = await fs.lstat(file);
        if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1 || target.size > 32 * 1024) throw new Error("Calendar check storage is unavailable.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await current();
    };
    await check();
    try {
      const previous = JSON.parse(await fs.readFile(file, "utf8")) as ComposioCalendarReadCheckResult & { version?: unknown };
      const previousView = publicComposioCalendarReadCheckResult(previous);
      if (previous.version !== 1 || previous.checkedAt !== previousView.checkedAt || previous.status !== previousView.status || previous.code !== previousView.code) throw new Error("Calendar check storage is unavailable.");
      if (previous.checkedAt >= result.checkedAt) { await check(); return; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFileAtomic(file, data, { mode: 0o600, beforePublish: check });
  });
}

/** Separate explicit Settings action: metadata, invalid-account refusal and bounded reads. */
export function createComposioSettingsCalendarReadCheck(ports: {
  configured(): Promise<McpServer | undefined>;
  withClient<T>(server: McpServer, signal: AbortSignal, action: (raw: ForegroundComposioSettingsClientPort) => Promise<T>): Promise<T>;
  publish(result: ComposioCalendarReadCheckResult, current: () => Promise<void>): Promise<void>;
  now?(): number;
  timeoutMs?: number;
}) {
  return async (lifetime: { signal: AbortSignal; assertCurrent(): void | Promise<void> }): Promise<{ message: string }> => {
    const timeoutMs = ports.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error("Invalid Calendar check deadline.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    const current = async () => {
      signal.throwIfAborted(); await lifetime.assertCurrent(); signal.throwIfAborted();
      const server = await ports.configured(); signal.throwIfAborted();
      if (!server || server.id !== COMPOSIO_SERVICE_SERVER_ID || !isComposioServiceServer(server) || !server.enabled || !mcpServerOffersTools(server) || server.hiddenTools?.length) throw new Error("The existing Composio service allowance is unavailable.");
      await lifetime.assertCurrent(); signal.throwIfAborted();
    };
    const work = withBotConnectorForegroundLifetime({ signal, assertCurrent: current }, () => withBotConnectorInventoryScope(COMPOSIO_SERVICE_SERVER_ID, async () => {
      await current();
      const server = (await ports.configured())!;
      await current();
      return ports.withClient(server, signal, async (raw) => {
        const connectedCurrent = async () => { await current(); await raw.assertCurrent(); await current(); };
        const result = await checkComposioCalendarRead(raw, { signal, current: connectedCurrent, now: ports.now, timeoutMs });
        await connectedCurrent(); await ports.publish(result, connectedCurrent); await connectedCurrent();
        return { message: publicComposioCalendarReadCheckResult(result).message };
      });
    }));
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Calendar check cancelled."));
      signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
    });
    try { return await Promise.race([work, cancelled]); }
    catch { return { message: "The Calendar read check could not finish. Review the existing connection and try again." }; }
    finally { clearTimeout(timeout); signal.removeEventListener("abort", onAbort); controller.abort(); }
  };
}
