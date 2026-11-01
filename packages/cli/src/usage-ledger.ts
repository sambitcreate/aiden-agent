import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createUsageStore, createEmptyUsageDatabase, type UsageRequestSource, type UsageRequestRecord } from "../../../main/services/usage-store-core.js";
import { reportedTokens } from "../../../main/services/usage-accounting.js";
import { MAX_ADVISOR_ATTEMPTS } from "../../../main/services/advisor-attempt-store.js";
import { acquireLease, atomicJson, readJson } from "./state.ts";

function ledger(agentDir: string) {
  const file = join(agentDir, "usage.json");
  return createUsageStore({ load: async () => readJson(file, createEmptyUsageDatabase()), save: async (value) => atomicJson(file, value) });
}
const tails = new Map<string, Promise<unknown>>();
/**
 * Attempt ids only guard against recording an advisor attempt's usage twice.
 * The advisor keeps at most MAX_ADVISOR_ATTEMPTS attempts, so a window several
 * times larger covers every attempt that can still be replayed while keeping
 * each write small and never refusing new usage.
 */
const ACCOUNTED_ATTEMPT_WINDOW = MAX_ADVISOR_ATTEMPTS * 8;
export async function recordUsage(agentDir: string, source: UsageRequestSource, message: AssistantMessage, attemptId?: string) {
  const usage = message.usage;
  const tokens = reportedTokens(usage);
  return recordUsageRecord(agentDir, { timestamp: message.timestamp, source, providerId: message.provider, providerLabel: message.provider,
    modelId: message.model, modelLabel: message.model, local: /^(ollama|lmstudio)$/.test(message.provider),
    status: message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" || message.stopReason === "length" ? "failed" : "completed",
    tokens,
    costStatus: usage?.cost && (tokens !== null || usage.cost.total > 0) ? "reported" : "unavailable",
    ...(usage?.cost && (tokens !== null || usage.cost.total > 0) ? { costUsd: usage.cost.total } : {}) }, attemptId);
}
export async function recordUsageRecord(agentDir: string, record: UsageRequestRecord, attemptId?: string) {
  const operation = (tails.get(agentDir) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const release = acquireLease(join(agentDir, "usage-writer"));
    try {
      const file = join(agentDir, "usage.json");
      const database = await readJson(file, { ...createEmptyUsageDatabase(), accountedAttempts: [] as string[] });
      const accounted = Array.isArray(database.accountedAttempts) ? database.accountedAttempts.filter((id): id is string => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) : [];
      const key = attemptId === undefined ? undefined : createHash("sha256").update(`${record.source}\0${attemptId}`).digest("hex");
      if (key && accounted.includes(key)) return;
      await createUsageStore({ load: async () => database, save: async (value) => atomicJson(file, {
        ...value, accountedAttempts: (key ? [...accounted, key] : accounted).slice(-ACCOUNTED_ATTEMPT_WINDOW),
      }) }).record(record);
    } finally { release(); }
  });
  tails.set(agentDir, operation);
  return operation;
}
export const usageSummary = (agentDir: string) => ledger(agentDir).summary("all");
