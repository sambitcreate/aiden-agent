import type {
  RendererDiagnosticKind,
  RendererDiagnosticPolicy,
  RendererDiagnosticReport,
  RendererErrorDetails,
} from "../shared/diagnostics";
import {
  MAX_RENDERER_ERROR_MESSAGE_LENGTH,
  MAX_RENDERER_ERROR_NAME_LENGTH,
  MAX_RENDERER_ERROR_STACK_LENGTH,
  RENDERER_CRASH_KINDS,
  normalizeDiagnosticErrorType,
  stackWithoutMessage,
} from "../shared/diagnostics";
import { diagnosticsApi, onNotification } from "./ipc";

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
// Set only by main. While false the report is exactly its content-free form.
let errorDetailsAllowed = false;
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

// Reads only strings and sends them as they are: deciding what is safe to keep
// is main's job, never this process's.
function errorDetails(kind: RendererDiagnosticKind, error: unknown): RendererErrorDetails | undefined {
  if (!errorDetailsAllowed || !RENDERER_CRASH_KINDS.includes(kind)) return undefined;
  try {
    if (typeof error === "string") return { message: error.slice(0, MAX_RENDERER_ERROR_MESSAGE_LENGTH) };
    if (!(error instanceof Error)) return {};
    return {
      name: String(error.name).slice(0, MAX_RENDERER_ERROR_NAME_LENGTH),
      message: String(error.message).slice(0, MAX_RENDERER_ERROR_MESSAGE_LENGTH),
      ...(typeof error.stack === "string"
        ? { stack: stackWithoutMessage(error.stack, error.message).slice(0, MAX_RENDERER_ERROR_STACK_LENGTH) }
        : {}),
    };
  } catch {
    return {};
  }
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
    // The old window's timer would otherwise flush the new window early.
    if (state?.timer != null) window.clearTimeout(state.timer);
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
    const details = errorDetails(kind, error);
    send(details ? { ...state.sample, error: details } : state.sample);
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
  onNotification<{ sending?: unknown }>("analytics:sending-changed", (status) => {
    errorDetailsAllowed = status?.sending === true;
  });
  try {
    policy = await diagnosticsApi.policy();
  } catch {
    policy = FALLBACK_POLICY;
  }
  errorDetailsAllowed = policy.errorDetails === true;
  policyResolved = true;
  for (const report of pending.splice(0)) {
    reportRendererDiagnostic(report.kind, report.error, report.context);
  }
}
