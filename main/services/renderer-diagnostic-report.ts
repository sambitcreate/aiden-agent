import {
  MAX_RENDERER_ERROR_MESSAGE_LENGTH,
  MAX_RENDERER_ERROR_NAME_LENGTH,
  MAX_RENDERER_ERROR_STACK_LENGTH,
  RENDERER_DIAGNOSTIC_KINDS,
  normalizeDiagnosticErrorType,
  type RendererDiagnosticKind,
  type RendererDiagnosticReport,
  type RendererErrorDetails,
} from "../../renderer/shared/diagnostics.js";

const RENDERER_CONTEXTS = new Set(["root", "router", "subtree", "window"]);
const SAFE_REFERENCE = /^RD-[A-Za-z0-9-]{8,80}$/u;

export interface ParsedRendererReport {
  // Only the content-free fields, which is all the journal ever sees.
  readonly report: Omit<RendererDiagnosticReport, "error">;
  // Raw and untrusted: for the analytics sanitizer, never for disk or a log.
  readonly errorDetails?: RendererErrorDetails;
}

function bounded(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

// A malformed `error` never rejects the report: the content-free part is what
// the journal has always recorded, so it stands alone.
function parseErrorDetails(value: unknown): RendererErrorDetails | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const name = bounded(input.name, MAX_RENDERER_ERROR_NAME_LENGTH);
  const message = bounded(input.message, MAX_RENDERER_ERROR_MESSAGE_LENGTH);
  const stack = bounded(input.stack, MAX_RENDERER_ERROR_STACK_LENGTH);
  return {
    ...(name === undefined ? {} : { name }),
    ...(message === undefined ? {} : { message }),
    ...(stack === undefined ? {} : { stack }),
  };
}

export function parseRendererReport(value: unknown): ParsedRendererReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid renderer diagnostic report.");
  }
  const input = value as Record<string, unknown>;
  if (!RENDERER_DIAGNOSTIC_KINDS.includes(input.kind as RendererDiagnosticKind)) {
    throw new Error("Invalid renderer diagnostic kind.");
  }
  if (typeof input.errorType !== "string" || normalizeDiagnosticErrorType(input.errorType) !== input.errorType) {
    throw new Error("Invalid renderer diagnostic error type.");
  }
  if (typeof input.context !== "string" || !RENDERER_CONTEXTS.has(input.context)) {
    throw new Error("Invalid renderer diagnostic context.");
  }
  if (typeof input.referenceId !== "string" || !SAFE_REFERENCE.test(input.referenceId)) {
    throw new Error("Invalid renderer diagnostic reference.");
  }
  if (
    input.suppressed !== undefined &&
    (!Number.isSafeInteger(input.suppressed) || Number(input.suppressed) < 1 || Number(input.suppressed) > 10_000)
  ) {
    throw new Error("Invalid renderer diagnostic suppression count.");
  }
  const report: ParsedRendererReport["report"] = {
    kind: input.kind as RendererDiagnosticKind,
    errorType: input.errorType,
    context: input.context as RendererDiagnosticReport["context"],
    referenceId: input.referenceId,
    ...(input.suppressed === undefined ? {} : { suppressed: input.suppressed as number }),
  };
  // A suppression summary counts repeats of one sample and describes no error.
  const errorDetails = input.suppressed === undefined ? parseErrorDetails(input.error) : undefined;
  return errorDetails ? { report, errorDetails } : { report };
}
