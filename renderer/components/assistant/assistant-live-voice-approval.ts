export function assistantLiveVoiceApprovalDecision(
  transcript: string,
): "allow" | "deny" | null {
  // "Allow once?" asks about the answer; it does not give it.
  if (/[?？]\s*$/u.test(transcript)) return null;
  const normalized = transcript
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[.,!?;:'’“”"-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized === "allow once") return "allow";
  if (normalized === "deny") return "deny";
  return null;
}
