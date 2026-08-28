export const RENDERER_DIAGNOSTIC_KINDS = [
  "global-error",
  "unhandled-rejection",
  "react-uncaught",
  "react-caught",
  "react-recoverable",
  "route-error",
] as const;

export type RendererDiagnosticKind = (typeof RENDERER_DIAGNOSTIC_KINDS)[number];

export const DIAGNOSTIC_ERROR_TYPES = [
  "AbortError",
  "AggregateError",
  "DOMException",
  "Error",
  "EvalError",
  "InvalidStateError",
  "NetworkError",
  "NotAllowedError",
  "NotFoundError",
  "RangeError",
  "ReferenceError",
  "SecurityError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
  "UnknownError",
] as const;

export type DiagnosticErrorType = (typeof DIAGNOSTIC_ERROR_TYPES)[number];

export function normalizeDiagnosticErrorType(value: unknown): DiagnosticErrorType {
  return typeof value === "string" && DIAGNOSTIC_ERROR_TYPES.includes(value as DiagnosticErrorType)
    ? (value as DiagnosticErrorType)
    : "UnknownError";
}

export interface RendererDiagnosticPolicy {
  enabled: boolean;
  runtimeProfile: "development" | "production";
  windowMs: number;
  maxPerKey: number;
}

export interface RendererDiagnosticReport {
  kind: RendererDiagnosticKind;
  errorType: string;
  context: "root" | "router" | "subtree" | "window";
  referenceId: string;
  suppressed?: number;
}

export interface DiagnosticSupportStatusView {
  retainedBytes: number;
  fileCount: number;
  oldestAt: string | null;
  newestAt: string | null;
  sinkFailed: boolean;
  droppedWrites: number;
  diagnosticMode: {
    enabled: boolean;
    expiresAt: string | null;
    disablesOnRestart: boolean;
    crashDumpCount: number;
  };
}
