export const DICTATION_CLEANUP_SYSTEM_PROMPT =
  "You clean dictated text. Fix punctuation and casing, remove filler such as um and uh, and keep the speaker's meaning and language. Return only the cleaned transcript.";

export const DICTATION_CLEANUP_TIMEOUT_MS = 12_000;
export const DICTATION_CLEANUP_MAX_CHARS = 100_000;

export function buildDictationCleanupUserPrompt(transcript: string): string {
  return `Clean this dictation:\n\n${transcript}`;
}

/** Keep the original transcript when the model returns empty or runaway text. */
export function sanitizeDictationCleanupOutput(
  raw: unknown,
  original: string,
): string {
  if (typeof raw !== "string") return original;
  let text = raw.trim();
  if (!text) return original;
  const fence = text.match(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/);
  if (fence) text = (fence[1] ?? "").trim();
  if (!text) return original;
  if (text.length > Math.max(original.length * 4, 8_000)) return original;
  return text.slice(0, DICTATION_CLEANUP_MAX_CHARS);
}
