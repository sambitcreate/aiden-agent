import type { BotConnectorWatchCondition, BotConnectorWatchSourceChoice, BotConnectorWatchView } from "../../../renderer/shared/bot-connector-watches.js";
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
import type { BotRuntimeConnectionAuthority, BotRuntimeMcpToolAuthority } from "../bot-runtime-authority.js";
import type { ConnectorWatchBaseline } from "./connector-watch-imcp.js";

/** Private, persisted exact binding. No field in this type is accepted over IPC/Remote. */
export interface BotConnectorWatchBinding {
  adapter: "imcp-mail-v1";
  serverId: string;
  connection: BotRuntimeConnectionAuthority;
  tools: BotRuntimeMcpToolAuthority[];
  mailbox: string;
  account: string;
  labels: Pick<BotConnectorWatchSourceChoice, "providerLabel" | "accountLabel" | "resourceLabel">;
}
export interface BotConnectorWatchMutation {
  id: string;
  digest: string;
  at: number;
  result: BotConnectorWatchView | { id: string; revision: string; admitted: boolean };
}
export interface BotConnectorWatchPrivate {
  binding: BotConnectorWatchBinding;
  condition: BotConnectorWatchCondition;
  createDigest: string;
  mutations: BotConnectorWatchMutation[];
  deletedAt?: number;
}
export function parseConnectorPrivate(value: unknown): BotConnectorWatchPrivate | undefined {
  const clean = copyBoundedJson(value, { maxNodes: 20_000, maxDepth: 16, maxSize: 2 * 1024 * 1024, measure: utf8Size });
  if (!clean || typeof clean !== "object" || Array.isArray(clean)) return undefined;
  const record = clean as unknown as BotConnectorWatchPrivate;
  if (record.binding?.adapter !== "imcp-mail-v1" || typeof record.binding.serverId !== "string" || !record.binding.connection ||
    !Array.isArray(record.binding.tools) || record.binding.tools.length !== 2 || typeof record.binding.account !== "string" ||
    typeof record.binding.mailbox !== "string" || !record.binding.labels || record.condition?.kind !== "email" ||
    typeof record.createDigest !== "string" || Object.keys(record.binding.labels).sort().join(",") !== "accountLabel,providerLabel,resourceLabel" || Object.values(record.binding.labels).some((label) => typeof label !== "string" || label.length > 500 || !label) || typeof record.condition.unreadOnly !== "boolean" || !Array.isArray(record.mutations) || record.mutations.length > 128) return undefined;
  const viewKeys = new Set(["id", "botId", "revision", "name", "prompt", "templateId", "condition", "everyMinutes", "source", "enabled", "state", "lastCheckAt", "nextCheckAt", "lastRunAt", "lastError"]);
  for (const mutation of record.mutations) {
    if (!mutation || typeof mutation.id !== "string" || typeof mutation.digest !== "string" || !Number.isSafeInteger(mutation.at) || !mutation.result || typeof mutation.result !== "object") return undefined;
    const result = mutation.result;
    if ("admitted" in result) { if (Object.keys(result).some((key) => !["id", "revision", "admitted"].includes(key)) || typeof result.admitted !== "boolean") return undefined; }
    else if (Object.keys(result).some((key) => !viewKeys.has(key)) || typeof result.prompt !== "string" || result.prompt.length > 32_768 || !result.source || Object.keys(result.source).sort().join(",") !== "accountLabel,providerLabel,resourceLabel") return undefined;
    if (typeof result.id !== "string" || typeof result.revision !== "string") return undefined;
  }
  return record;
}
export function parseConnectorBaseline(value: unknown): ConnectorWatchBaseline | undefined {
  const clean = copyBoundedJson(value, { maxNodes: 4_000, maxDepth: 6, maxSize: 4 * 1024 * 1024, measure: utf8Size });
  if (!clean || typeof clean !== "object" || Array.isArray(clean)) return undefined;
  const record = clean as unknown as ConnectorWatchBaseline;
  if (record.kind !== "email" || !Array.isArray(record.items) || record.items.length > 250 || new Set(record.items.map((item) => item?.id)).size !== record.items.length) return undefined;
  if (record.items.some((item) => !item || typeof item.id !== "string" || item.id.length > 500 || typeof item.title !== "string" || item.title.length > 500 || typeof item.signature !== "string" || item.signature.length > 10_000)) return undefined;
  return record;
}
