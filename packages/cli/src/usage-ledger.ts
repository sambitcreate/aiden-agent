import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createUsageStore, createEmptyUsageDatabase, type UsageRequestSource, type UsageRequestRecord } from "../../../main/services/usage-store-core.js";
import { acquireLease, atomicJson, readJson } from "./state.ts";

function ledger(agentDir: string) {
  const file = join(agentDir, "usage.json");
  return createUsageStore({ load: async () => readJson(file, createEmptyUsageDatabase()), save: async (value) => atomicJson(file, value) });
}
const tails = new Map<string, Promise<unknown>>();
export async function recordUsage(agentDir: string, source: UsageRequestSource, message: AssistantMessage) {
  const usage = message.usage;
  return recordUsageRecord(agentDir, { timestamp: message.timestamp, source, providerId: message.provider, providerLabel: message.provider,
    modelId: message.model, modelLabel: message.model, local: /^(ollama|lmstudio)$/.test(message.provider),
    status: message.stopReason === "aborted" ? "cancelled" : message.stopReason === "error" ? "failed" : "completed",
    tokens: usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, reasoning: 0, total: usage.totalTokens } : null,
    costStatus: usage?.cost ? "reported" : "unavailable", costUsd: usage?.cost?.total });
}
export async function recordUsageRecord(agentDir: string, record: UsageRequestRecord) {
  const operation = (tails.get(agentDir) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const release = acquireLease(join(agentDir, "usage-writer"));
    try {
      await ledger(agentDir).record(record);
    } finally { release(); }
  });
  tails.set(agentDir, operation);
  return operation;
}
export const usageSummary = (agentDir: string) => ledger(agentDir).summary("all");
