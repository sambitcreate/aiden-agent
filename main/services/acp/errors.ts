/**
 * Shared failure vocabulary for ACP harness providers. Messages are written
 * for people; every message that may carry agent stderr or protocol data is
 * redacted before it leaves this layer.
 */

export type AcpHarnessErrorCode =
  | "aborted"
  | "auth"
  | "install"
  | "invalid_input"
  | "process_exit"
  | "protocol"
  | "spawn"
  | "timeout"
  | "unavailable";

export class AcpHarnessError extends Error {
  constructor(
    readonly code: AcpHarnessErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "AcpHarnessError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "$1 [redacted]"],
  [/\bya29\.[A-Za-z0-9._-]+/gu, "[redacted-token]"],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/gu, "[redacted-token]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/gu, "[redacted-key]"],
  [/("?(?:access_token|refresh_token|id_token|api[-_]?key|client_secret)"?\s*[:=]\s*"?)[^"\s,&]+/giu, "$1[redacted]"],
  [/([?&](?:code|state|code_challenge|code_verifier|client_id)=)[^&\s"]+/giu, "$1[redacted]"],
];

/** Remove credential-shaped substrings from text that may be shown or logged. */
export function redactSecrets(text: string): string {
  let output = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

export function abortError(message = "The request was cancelled."): AcpHarnessError {
  return new AcpHarnessError("aborted", message);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AcpHarnessError) return error.code === "aborted";
  return error instanceof Error && error.name === "AbortError";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; data?: unknown };
    const data = record.data as { message?: unknown } | undefined;
    if (typeof data?.message === "string") return redactSecrets(data.message);
    if (typeof record.message === "string") return redactSecrets(record.message);
  }
  return redactSecrets(String(error));
}

/** JSON-RPC error code, when the failure came from the agent. */
export function rpcErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}
