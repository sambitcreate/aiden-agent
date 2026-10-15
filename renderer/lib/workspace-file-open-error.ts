/**
 * Classifies a failed workspace-file open so the Files panel only offers
 * "Try again" when retrying can help. Text-editor limits (binary content,
 * size, line count, encoding, non-file paths) do not change on retry.
 */
export interface WorkspaceFileOpenErrorPresentation {
  retryable: boolean;
  guidance: string | null;
}

const PERMANENT_OPEN_ERRORS: ReadonlyArray<{ pattern: RegExp; guidance: string }> = [
  {
    pattern: /is binary and cannot be edited as text\.?$/,
    guidance: "Aiden edits text files only. Open it in Browser or another app instead.",
  },
  {
    pattern: /is too large to edit in Aiden(?: \([^)]*\))?\.?$/,
    guidance: "Open this file in another editor, or ask the agent to work with it.",
  },
  {
    pattern: /has too many lines to edit safely in Aiden\.?$/,
    guidance: "Open this file in another editor, or ask the agent to work with it.",
  },
  {
    pattern: /is not valid UTF-8 text\.?$/,
    guidance: "Convert the file to UTF-8, or open it in another editor.",
  },
  {
    pattern: /is not a file\.?$/,
    guidance: "Choose a file from the list instead.",
  },
];

export function workspaceFileOpenErrorPresentation(message: string): WorkspaceFileOpenErrorPresentation {
  const trimmed = message.trim();
  const match = PERMANENT_OPEN_ERRORS.find(({ pattern }) => pattern.test(trimmed));
  return match ? { retryable: false, guidance: match.guidance } : { retryable: true, guidance: null };
}
