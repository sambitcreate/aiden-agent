// Production ports for chat tasks that run when a connected app has news
// (scheduled-task-connector-trigger.ts). They reuse the Bot connector hosts:
// the trusted iMCP and Composio checks, the existing-connection-only clients
// and the bounded readers. Nothing here connects, signs in or reconnects: a
// read goes through a connection the person already opened in Settings.

import { randomUUID } from "node:crypto";
import { mcpToolsOfferedToModel, mcpServerOffersTools } from "../../renderer/shared/mcp-exposure.js";
import type { BotConnectorWatchCondition } from "../../renderer/shared/bot-connector-watches.js";
import { createComposioCalendarHost } from "./bot-routine-events/composio-calendar-host.js";
import { composioCalendarHostTransport } from "./bot-routine-events/composio-calendar-host-port.js";
import { sourceFingerprint, trustedComposioServer, trustedServer } from "./bot-routine-events/connector-host-main.js";
import { BotConnectorWatchError } from "./bot-routine-events/connector-service.js";
import { composioSourceConnection, imcpSourceConnection, type BotConnectorSourceAdmission } from "./bot-routine-events/connector-source-admission.js";
import type { BotConnectorWatchBaseline, BotConnectorWatchBinding } from "./bot-routine-events/connector-types.js";
import { createImcpMailHost } from "./bot-routine-events/imcp-mail-host.js";
import { readComposioCalendarWatch, type ComposioCalendarBaseline } from "./bot-routine-events/connector-watch-composio.js";
import { compareImcpWatch, readImcpWatch, type ConnectorWatchBaseline } from "./bot-routine-events/connector-watch-imcp.js";
import { isComposioServiceServer } from "./composio-service-tool.js";
import { configStore } from "./config-store.js";
import { mcpConfigurationLeases } from "./mcp-config-lease.js";
import { withBotConnectorMcpClient } from "./mcp.js";
import { scheduleService } from "./schedule-service.js";
import { scheduleStore } from "./schedule-store.js";
import { createTaskConnectorTriggers } from "./scheduled-task-connector-trigger.js";

const fail = (message: string): never => { throw new BotConnectorWatchError("unavailable", message); };

/** `task:<id>` for a task's background check, `find:<nonce>` for the foreground Find sources step. */
const taskOf = (owner: string) => (owner.startsWith("task:") ? owner.slice("task:".length) : undefined);

async function taskMayRead(owner: string): Promise<void> {
  if ((await configStore.getSettings()).scheduledTasksEnabled === false) fail("Turn on Schedules first.");
  const taskId = taskOf(owner);
  if (taskId === undefined) return;
  const task = await scheduleStore.get(taskId);
  if (!task || !task.enabled || task.trigger?.kind !== "connector") fail("This task is off or no longer watches a connected app.");
}

/** A task's admission: the connector's configuration epoch, Schedules on and, for a check, the task still on. */
async function admit(owner: string, serverId: string): Promise<BotConnectorSourceAdmission> {
  const lease = mcpConfigurationLeases.acquire(serverId);
  const current = async () => { lease.assertCurrent(); await taskMayRead(owner); lease.assertCurrent(); };
  await current();
  return { signal: lease.signal, assertCurrent: () => lease.assertCurrent(), revalidateBeforeEffect: current, release: () => {} };
}

async function isPaused(owner: string): Promise<boolean> {
  const taskId = taskOf(owner);
  if (taskId === undefined) return false;
  if (!scheduleService.isActive()) return true;
  const task = await scheduleStore.get(taskId);
  return !task?.enabled;
}

const mail = createImcpMailHost({
  server: trustedServer,
  admit,
  withClient: withBotConnectorMcpClient,
  isPaused,
  assertConnection: async (admission, server, raw, foreground) => { await sourceFingerprint(admission, server.id, raw, foreground); },
  connection: async (admission, server, raw, metadata, foreground) =>
    imcpSourceConnection(server.id, await sourceFingerprint(admission, server.id, raw, foreground), mcpToolsOfferedToModel(server, metadata, (tool) => tool.name)),
});

const calendar = createComposioCalendarHost({
  transport: composioCalendarHostTransport,
  server: trustedComposioServer,
  preflight: async (_owner, server, signal) => {
    signal.throwIfAborted();
    await trustedComposioServer(server.id);
    if ((await configStore.getSettings()).scheduledTasksEnabled === false) fail("Turn on Schedules first.");
    signal.throwIfAborted();
  },
  admit,
  connection: async (admission, serverId, raw, foreground) => composioSourceConnection(serverId, await sourceFingerprint(admission, serverId, raw, foreground)),
  isPaused,
  now: Date.now,
  withClient: (server, signal, _foreground, action) => withBotConnectorMcpClient(server, signal, action),
});

async function discover(signal: AbortSignal) {
  const owner = `find:${randomUUID()}`;
  const assertActive = async () => { signal.throwIfAborted(); };
  const configured = await configStore.listMcpServers();
  const mailServers = configured.filter((server) => process.platform === "darwin" && server.presetId === "imcp" && server.enabled && mcpServerOffersTools(server));
  const composioServers = configured.filter((server) => server.enabled && mcpServerOffersTools(server) && isComposioServiceServer(server));
  const bindings: BotConnectorWatchBinding[] = [];
  const unavailableReasons: string[] = [];
  for (const server of mailServers) {
    try { bindings.push(...await mail.discover(owner, server.id, signal, assertActive)); }
    catch (error) {
      if (signal.aborted) throw error;
      unavailableReasons.push(error instanceof BotConnectorWatchError ? error.message : "Mail sources are unavailable. Finish existing access in Settings → Connectors.");
    }
  }
  if (calendar.available()) {
    for (const server of composioServers) {
      try { bindings.push(...await calendar.discover(owner, server.id, signal, assertActive)); }
      catch (error) {
        if (signal.aborted) throw error;
        unavailableReasons.push(error instanceof BotConnectorWatchError ? error.message : "Calendar sources are unavailable. Review Composio in Settings → Connectors.");
      }
    }
  } else if (composioServers.length) {
    unavailableReasons.push("Calendar sources aren't available on this computer yet.");
  }
  if (!mailServers.length && !composioServers.length) {
    unavailableReasons.push(process.platform === "darwin"
      ? "Connect iMCP or Composio in Settings → Connectors first."
      : "Connect Composio in Settings → Connectors first.");
  }
  return { bindings, unavailableReasons };
}

async function read(taskId: string, binding: BotConnectorWatchBinding, condition: BotConnectorWatchCondition, baseline: BotConnectorWatchBaseline | undefined, signal: AbortSignal) {
  const owner = `task:${taskId}`;
  if (binding.adapter === "composio-calendar-v1") {
    if (condition.kind !== "calendar") return fail("This task's source doesn't match what it watches.");
    if (!calendar.available()) return fail("Calendar checks aren't available on this computer yet.");
    if (baseline && !("version" in baseline)) return fail("This task's saved Calendar history is invalid. Find its source again.");
    return calendar.withPort(owner, binding, signal, (port) => readComposioCalendarWatch(
      { accountId: binding.accountId, calendarId: binding.calendarId, labels: binding.labels },
      { lookAheadMinutes: condition.lookAheadMinutes, timezone: condition.timezone },
      baseline as ComposioCalendarBaseline | undefined, port, Date.now(), signal,
    ));
  }
  if (condition.kind !== "email") return fail("This task's source doesn't match what it watches.");
  if (process.platform !== "darwin") return fail("Mail checks run on a Mac only.");
  if (baseline && "version" in baseline) return fail("This task's saved Mail history is invalid. Find its source again.");
  const items = await mail.withPort(owner, binding, signal, (port) => readImcpWatch({
    kind: "email", mailbox: binding.mailbox, account: binding.account,
    ...(condition.sender ? { sender: condition.sender } : {}), ...(condition.subject ? { subject: condition.subject } : {}), unreadOnly: condition.unreadOnly,
  }, port, Date.now(), signal));
  return { items, ...compareImcpWatch("email", baseline as ConnectorWatchBaseline | undefined, items, Date.now()) };
}

export const taskConnectorTriggers = createTaskConnectorTriggers({
  discover,
  read,
  server: async (serverId) => (await configStore.listMcpServers()).find((server) => server.id === serverId),
  now: Date.now,
});
