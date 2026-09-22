import type {
  RendererDiagnosticKind,
  RendererDiagnosticPolicy,
  RendererDiagnosticReport,
} from "../shared/diagnostics";
import { normalizeDiagnosticErrorType } from "../shared/diagnostics";
import { diagnosticsApi } from "./ipc";

const FALLBACK_POLICY: RendererDiagnosticPolicy = {
  enabled: false,
  runtimeProfile: "production",
  windowMs: 60_000,
  maxPerKey: 3,
};

interface RateState {
  startedAt: number;
  sent: number;
  suppressed: number;
  referenceId: string;
  timer: number | null;
  sample: Omit<RendererDiagnosticReport, "suppressed">;
}

let policy = FALLBACK_POLICY;
let installed = false;
let policyResolved = false;
const rates = new Map<string, RateState>();
const pending: Array<{
  kind: RendererDiagnosticKind;
  error: unknown;
  context: RendererDiagnosticReport["context"];
}> = [];

function errorType(error: unknown): string {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  return normalizeDiagnosticErrorType(candidate);
}

function createReferenceId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto?.getRandomValues(bytes);
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `RD-${suffix || Math.random().toString(36).slice(2, 18)}`;
}

function send(report: RendererDiagnosticReport): void {
  void diagnosticsApi.reportRendererEvent(report).catch(() => undefined);
}

function flushSuppressed(key: string): void {
  const state = rates.get(key);
  if (!state || state.suppressed < 1) return;
  send({ ...state.sample, suppressed: Math.min(10_000, state.suppressed) });
  state.suppressed = 0;
  state.timer = null;
}

export function reportRendererDiagnostic(
  kind: RendererDiagnosticKind,
  error: unknown,
  context: RendererDiagnosticReport["context"],
): string | null {
  const type = errorType(error);
  const key = `${kind}:${type}:${context}`;
  const currentTime = Date.now();
  let state = rates.get(key);
  if (!state || currentTime - state.startedAt >= policy.windowMs) {
    if (state?.suppressed) flushSuppressed(key);
    const referenceId = createReferenceId();
    const sample = { kind, errorType: type, context, referenceId };
    state = { startedAt: currentTime, sent: 0, suppressed: 0, referenceId, timer: null, sample };
    rates.set(key, state);
  }
  if (!policyResolved) {
    if (pending.length < 16) pending.push({ kind, error, context });
    return null;
  }
  if (!policy.enabled) return null;
  if (state.sent < policy.maxPerKey) {
    state.sent += 1;
    send(state.sample);
  } else {
    state.suppressed += 1;
    if (state.timer === null) {
      state.timer = window.setTimeout(() => flushSuppressed(key), policy.windowMs);
    }
  }
  return state.referenceId;
}

export async function installRendererDiagnostics(): Promise<void> {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    reportRendererDiagnostic("global-error", event.error, "window");
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportRendererDiagnostic("unhandled-rejection", event.reason, "window");
  });
  try {
    policy = await diagnosticsApi.policy();
  } catch {
    policy = FALLBACK_POLICY;
  }
  policyResolved = true;
  for (const report of pending.splice(0)) {
    reportRendererDiagnostic(report.kind, report.error, report.context);
  }
}

export function rendererDiagnosticPolicyForTest(): RendererDiagnosticPolicy {
  return policy;
}
