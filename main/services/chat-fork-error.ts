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
