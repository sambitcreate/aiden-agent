/**
 * Why a fork could not be created. The message is safe to show; the code lets
 * Remote map the failure to an HTTP status without matching message text.
 */
export type ChatForkErrorCode =
  | "busy"
  | "not_found"
  | "message_not_found"
  | "ineligible"
  | "too_large"
  | "unavailable";

export class ChatForkError extends Error {
  constructor(
    readonly code: ChatForkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatForkError";
  }
}

export function isChatForkError(error: unknown): error is ChatForkError {
  return error instanceof ChatForkError;
}

/** A summary action found the summary in another state (finished, retried or cancelled elsewhere). */
export class ForkSummaryStateError extends Error {}

/** Failure text Aiden writes itself. */
export const FORK_SUMMARY_FAILURES = {
  generic: "The summary could not be generated.",
  cancelled: "Summary cancelled.",
  interrupted: "Summarizing stopped before it finished.",
  sourceGone: "The original chat is no longer available.",
  noModel: "The original chat has no model to summarize with.",
  cutGone: "The fork point is no longer in the original chat.",
  nothingAfter: "Nothing happened after this point to summarize.",
  modelUnavailable: "The original chat's model is unavailable.",
  empty: "The model returned an empty summary.",
} as const;

/**
 * The failures a paired device may see. Anything else on a failed summary
 * came from a provider and stays on this Mac.
 */
export const FORK_SUMMARY_AIDEN_ERRORS: ReadonlySet<string> = new Set(
  Object.values(FORK_SUMMARY_FAILURES),
);
