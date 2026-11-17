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
  "BotAccessChangedError",
  "BotApplicationUnavailableError",
  "BotAvatarInputError",
  "BotAvatarReplayError",
  "BotAvatarRevisionConflictError",
  "BotAvatarStateError",
  "BotAvatarUnavailableError",
  "BotCapabilityBindingDriftError",
  "BotCapabilityCatalogConflictError",
  "BotCapabilityCommitUncertainError",
  "BotCapabilityNoticeRequiredError",
  "BotCapabilityRevisionConflictError",
  "BotCapabilitySubsetError",
  "BotCapabilityUnavailableError",
  "BotCapabilityValidationError",
  "BotDeletedError",
  "BotHarnessHostClosedError",
  "BotHistoricalChatReadOnlyError",
  "BotIdentityRevisionConflictError",
  "BotInboxProjectionError",
  "BotLifecycleJournalConflictError",
  "BotLifecycleJournalStateError",
  "BotManagedWorkspaceConflictError",
  "BotManagedWorkspaceNotProvisionedError",
  "BotManagedWorkspaceRollbackError",
  "BotManagedWorkspaceStateError",
  "BotPersistentChatDeletionError",
  "BotRuntimeAuthorityError",
  "BotRuntimeInventoryLeaseInvalidError",
  "BotSessionError",
  "DOMException",
  "Error",
  "EvalError",
  "InvalidStateError",
  "McpAuthRequiredError",
  "McpConnectionClosedError",
  "McpError",
  "McpFieldSecretMissingError",
  "McpHttpError",
  "McpOAuthAuthorizationRequiredError",
  "McpOAuthCallbackError",
  "McpOAuthCancelledError",
  "McpOAuthCredentialStorageError",
  "McpOAuthRefreshUnavailableError",
  "McpOAuthSignInRequiredError",
  "McpOAuthVerificationRejectedError",
  "McpSessionExpiredError",
  "McpStdioApprovalRequiredError",
  "McpTimeoutError",
  "NetworkError",
  "NotAllowedError",
  "NotFoundError",
  "OAuthError",
  "OAuthInsecureEndpointError",
  "OAuthIssuerMismatchError",
  "OAuthRegistrationError",
  "RangeError",
  "ReferenceError",
  "SecurityError",
  "SubagentTreeBudgetExhaustedError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
  "UnknownError",
] as const;

// Bot and MCP error classes are fixed, content-free names. Listing them keeps
// those failures distinguishable in production logs instead of all "UnknownError".
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
  /** Main is sending crash reports, so uncaught errors may carry `error`. */
  errorDetails?: boolean;
}

/** Only these kinds are crash reports. The others are caught and stay local. */
export const RENDERER_CRASH_KINDS: readonly RendererDiagnosticKind[] = [
  "global-error",
  "unhandled-rejection",
  "react-uncaught",
];

export const MAX_RENDERER_ERROR_NAME_LENGTH = 128;
export const MAX_RENDERER_ERROR_MESSAGE_LENGTH = 2_048;
export const MAX_RENDERER_ERROR_STACK_LENGTH = 8_192;

/**
 * An uncaught error as the renderer saw it, sent only while main says crash
 * reports are on. It can hold anything: main sanitizes it and never stores it.
 */
/**
 * V8 starts a stack with the message, which can span lines and quote anything,
 * so frames are read only from what follows it. Only a match on the first line
 * is that header: a short message can also turn up by chance among the frames.
 */
export function stackWithoutMessage(stack: string, message: unknown): string {
  if (typeof message !== "string" || message.length === 0) return stack;
  const header = stack.indexOf(message);
  if (header < 0 || stack.slice(0, header).includes("\n")) return stack;
  return stack.slice(header + message.length);
}

export interface RendererErrorDetails {
  name?: string;
  message?: string;
  stack?: string;
}

export interface RendererDiagnosticReport {
  kind: RendererDiagnosticKind;
  errorType: string;
  context: "root" | "router" | "subtree" | "window";
  referenceId: string;
  suppressed?: number;
  error?: RendererErrorDetails;
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
  /** Unreadable chat files moved aside, bytes intact, in the chats folder. */
  quarantinedChats?: number;
}

/** Plain-language notice for chat files Aiden could not read and set aside. */
export function quarantinedChatsNotice(count: number | undefined): string | null {
  if (!count || count < 1) return null;
  return count === 1
    ? "1 damaged chat file could not be opened. Aiden set it aside unchanged in the chats folder instead of deleting it."
    : `${count} damaged chat files could not be opened. Aiden set them aside unchanged in the chats folder instead of deleting them.`;
}
