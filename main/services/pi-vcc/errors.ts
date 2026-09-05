/** Only fixed failure codes cross the worker boundary; exception text may contain history. */
export type VccOperation = "compile" | "recall";

const compileMessages = {
  history_limit: "VCC history exceeds its bounded processing limit.",
  unsafe_boundary: "VCC could not establish a safe history boundary.",
  empty_summary: "VCC produced no usable summary.",
  insufficient_reduction:
    "VCC could not reduce context enough. Try /compact-LLM or a larger-context model.",
  missing_query: "Missing recall query.",
  busy: "Local compaction is busy. Try again shortly.",
  cancelled: "Compaction cancelled.",
  timeout: "VCC compilation timed out.",
  worker_failed: "VCC compilation worker failed. Try again or choose /compact-LLM.",
  worker_exited: "VCC compilation worker exited.",
  cleanup_failed: "VCC compilation worker cleanup failed.",
} as const;
export type VccFailureCode = keyof typeof compileMessages;

const recallMessages: Partial<Record<VccFailureCode, string>> = {
  history_limit: "Chat history exceeds the bounded local recall processing limit.",
  missing_query: "Missing recall query. Provide keywords or a history reference.",
  busy: "Local history recall is busy. Try again shortly.",
  cancelled: "History recall cancelled.",
  timeout: "History recall timed out. Try a narrower query or try again.",
  worker_failed: "History recall worker failed. Try again.",
  worker_exited: "History recall worker exited. Try again.",
  cleanup_failed: "History recall worker cleanup failed.",
};

export function vccErrorMessage(operation: VccOperation, code: unknown): string {
  const known =
    typeof code === "string" && Object.prototype.hasOwnProperty.call(compileMessages, code)
      ? (code as VccFailureCode)
      : "worker_failed";
  return operation === "recall"
    ? (recallMessages[known] ?? recallMessages.worker_failed!)
    : compileMessages[known];
}

export class VccError extends Error {
  constructor(readonly code: VccFailureCode) {
    super(vccErrorMessage("compile", code));
    this.name = "VccError";
  }
}

export function vccFailureCode(error: unknown): VccFailureCode {
  return error instanceof VccError ? error.code : "worker_failed";
}
