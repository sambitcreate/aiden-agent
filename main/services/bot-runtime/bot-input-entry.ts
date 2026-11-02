/** Pi places this kind on the input itself only when the host admits a routine. */
export const BOT_ROUTINE_INPUT_KIND = "aiden.routine-input";

export function isBotInputEntryKind(kind: string): boolean {
  return kind === "pi.user" || kind === BOT_ROUTINE_INPUT_KIND;
}
