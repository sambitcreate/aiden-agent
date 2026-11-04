// Reviewed composition candidate only. Nothing installs this transport or derives
// authority from a saved diagnostic. Host installation remains a separate gate.
import type { ComposioCalendarHostTransport } from "./composio-calendar-host-port.js";
import { boundedCalendarContractJson, verifyCalendarContract } from "./composio-calendar-contract.js";

export function createComposioCalendarTransport(): ComposioCalendarHostTransport {
  return {
    async prepare(context, expected) {
      if (context.phase === "background" && !expected) throw new Error("This Calendar source has no accepted read contract.");
      const startedAt = Date.now();
      let total = 0;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
      const current = async (active = signal) => { active.throwIfAborted(); if (Date.now() - startedAt >= 15_000) throw new Error("Calendar read timed out."); await context.assertCurrent(); active.throwIfAborted(); };
      const guarded = async <T>(operation: () => Promise<T>, callSignal = signal): Promise<T> => {
        const active = AbortSignal.any([signal, callSignal]);
        let onAbort!: () => void;
        const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(active.reason); active.addEventListener("abort", onAbort, { once: true }); if (active.aborted) onAbort(); });
        try {
          return await Promise.race([Promise.resolve().then(async () => { await current(active); active.throwIfAborted(); const result = await operation(); await current(active); return result; }), cancelled]);
        } finally { active.removeEventListener("abort", onAbort); }
      };
      const bounded = (value: unknown) => {
        const copy = boundedCalendarContractJson(value); total += Buffer.byteLength(JSON.stringify(copy), "utf8");
        if (total > 1024 * 1024) throw new Error("Calendar read exceeded its response budget."); return copy;
      };
      const first = await guarded(() => context.getSchemas());
      const accepted = verifyCalendarContract(context.metadata, bounded(first), expected);
      return {
        contract: accepted.contract,
        port: {
          async assertCurrent(read, callSignal) {
            callSignal.throwIfAborted(); await guarded(async () => { accepted.request(read); }, callSignal); callSignal.throwIfAborted();
          },
          async read(read, callSignal) {
            callSignal.throwIfAborted();
            // Refresh only these three fixed schemas, never Search or inventory.
            // A previously accepted hash is data; current admission and schemas
            // must both survive immediately before each individual page/effect.
            const fresh = await guarded(() => context.getSchemas(), callSignal);
            const verified = verifyCalendarContract(context.metadata, bounded(fresh), accepted.contract);
            verified.request(read);
            callSignal.throwIfAborted();
            const result = await guarded(() => context.execute(read), callSignal);
            callSignal.throwIfAborted(); const response = bounded(result); verified.response(read, response); return response;
          },
        },
      };
    },
  };
}
