import {
  performanceDiagnosticsEnabled,
  recordDiagnosticCounter,
  recordDiagnosticGauge,
} from "./performance-diagnostics.js";

export type DiagnosticMcpClientKind =
  | "generation"
  | "status"
  | "isolated"
  | "oauth"
  | "oauth-verify";

export function diagnosticMcpStartedAt(): number {
  return performanceDiagnosticsEnabled ? performance.now() : 0;
}

const liveByKind = new Map<DiagnosticMcpClientKind, number>();
let liveTotal = 0;

function publishGauges(kind: DiagnosticMcpClientKind): void {
  recordDiagnosticGauge("live:mcp-client", liveTotal);
  recordDiagnosticGauge(`live:mcp-client:${kind}`, liveByKind.get(kind) ?? 0);
}

/** Charge one actual SDK client object until its idempotent release is called. */
export function acquireDiagnosticMcpClient(kind: DiagnosticMcpClientKind): () => void {
  if (!performanceDiagnosticsEnabled) return () => {};
  liveTotal += 1;
  liveByKind.set(kind, (liveByKind.get(kind) ?? 0) + 1);
  recordDiagnosticCounter(`resource:mcp-client-open:${kind}`);
  publishGauges(kind);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    liveTotal = Math.max(0, liveTotal - 1);
    liveByKind.set(kind, Math.max(0, (liveByKind.get(kind) ?? 1) - 1));
    recordDiagnosticCounter(`resource:mcp-client-close:${kind}`);
    publishGauges(kind);
  };
}

export function recordDiagnosticMcpOperation(
  operation: "connect" | "close",
  kind: DiagnosticMcpClientKind,
  startedAt: number,
  failed = false,
): void {
  if (!performanceDiagnosticsEnabled) return;
  recordDiagnosticCounter(`resource:mcp-${operation}:${kind}`, {
    ...(failed ? { errors: 1 } : {}),
    durationMs: Math.max(0, performance.now() - startedAt),
  });
}

/** Test-only reset; production lifecycles must release their own capabilities. */
export function resetDiagnosticMcpClientTrackingForTest(): void {
  liveByKind.clear();
  liveTotal = 0;
}
