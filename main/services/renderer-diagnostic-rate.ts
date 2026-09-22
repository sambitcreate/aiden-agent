import type { RendererDiagnosticReport } from "../../renderer/shared/diagnostics.js";

interface RateState {
  startedAt: number;
  total: number;
  keys: Map<string, { sent: number; aggregateSent: boolean }>;
}

export function createRendererDiagnosticRateLimiter(
  windowMs = 60_000,
  maxPerKey = 3,
  maxPerWindow = 60,
) {
  const states = new Map<string, RateState>();
  return {
    admit(documentId: string, report: RendererDiagnosticReport, now = Date.now()): boolean {
      let state = states.get(documentId);
      if (!state || now - state.startedAt >= windowMs) {
        state = { startedAt: now, total: 0, keys: new Map() };
        states.set(documentId, state);
      }
      if (state.total >= maxPerWindow) return false;
      const key = `${report.kind}:${report.errorType}:${report.context}`;
      const keyState = state.keys.get(key) ?? { sent: 0, aggregateSent: false };
      if (report.suppressed) {
        if (keyState.aggregateSent) return false;
        keyState.aggregateSent = true;
      } else {
        if (keyState.sent >= maxPerKey) return false;
        keyState.sent += 1;
      }
      state.keys.set(key, keyState);
      state.total += 1;
      return true;
    },
    clear(documentId: string): void {
      states.delete(documentId);
    },
  };
}
