import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SpendingLedger, emptySpendingDocument, parseSpendingDocument, spendingBlockMessage } from "../../../main/services/spending-core.js";
import { responseCostUsd, spendCounts } from "../../../main/services/spending-service.js";
import { parseSpendingLimitsSettings } from "../../../renderer/shared/spending.js";
import { botRoutineTaskIdOf } from "../../../main/services/scheduled-bot-routines.js";
import { JsonStore } from "./state.ts";

/** Local-only spending checks. A broken file refuses admission rather than hiding a limit. */
export function createCliBotSpending(profileDir: string) {
  const document = new JsonStore<unknown>(join(profileDir, "spending.json"), emptySpendingDocument());
  const settings = new JsonStore<{ spendingLimits?: unknown }>(join(profileDir, "aiden.json"), {});
  const runtimes = new Map<string, Parameters<typeof spendCounts>[0]>();
  const owner = (id: string, ids: readonly (string | undefined)[] = []) => {
    const run = ids.find((requestId) => botRoutineTaskIdOf(requestId) !== undefined);
    return { kind: "bot" as const, id, ...(run ? { run } : {}) };
  };
  const limits = async () => {
    const value = (await settings.load()).spendingLimits;
    if (value === undefined) return {};
    const parsed = parseSpendingLimitsSettings(value);
    if (!parsed) throw new Error("Bot spending settings are unreadable.");
    return parsed;
  };
  const ledger = (value: unknown) => {
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("Bot spending ledger is unreadable.");
    return new SpendingLedger(parseSpendingDocument(value));
  };
  return {
    register: (id: string, runtime: Parameters<typeof spendCounts>[0]) => { runtimes.set(id, runtime); },
    async refusal(id: string, name?: string, requestIds?: readonly (string | undefined)[]) {
      const block = ledger(await document.load()).block(owner(id, requestIds), await limits(), Date.now());
      return block ? spendingBlockMessage(block, name) : undefined;
    },
    async record(id: string, requestIds: readonly (string | undefined)[], message: AssistantMessage) {
      const runtime = runtimes.get(id), usd = responseCostUsd(message);
      if (!runtime || usd <= 0 || !await spendCounts(runtime)) return;
      const currentLimits = await limits();
      await document.update((value) => {
        const current = ledger(value);
        current.record(owner(id, requestIds), usd, currentLimits, Date.now());
        return current.snapshot();
      }, undefined, true);
    },
    async forgetBot(id: string) {
      runtimes.delete(id);
      await document.update((value) => { const current = ledger(value); current.forgetBot(id); return current.snapshot(); }, undefined, true);
    },
  };
}
