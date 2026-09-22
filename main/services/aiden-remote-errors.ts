import type { AidenRemoteErrorCode } from "./aiden-remote-protocol.js";

export class AidenRemoteServiceError extends Error {
  constructor(
    readonly code: AidenRemoteErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly details?: {
      currentRevision?: string;
      retryAfterSeconds?: number;
      chatId?: string;
      minimumClientVersion?: string;
      limit?: number;
      field?: string;
    },
  ) {
    super(message);
    this.name = "AidenRemoteServiceError";
  }
}

export function asAidenRemoteServiceError(error: unknown): AidenRemoteServiceError {
  if (error instanceof AidenRemoteServiceError) return error;
  return new AidenRemoteServiceError(
    "internal_error",
    "Aiden could not complete this remote request.",
    500,
  );
}
