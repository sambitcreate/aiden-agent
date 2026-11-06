import { matchLiveVoicePhrase } from "../../shared/live-voice-phrases";

/**
 * A spoken answer to one of Live's own approvals: only a whole-utterance allow
 * or deny phrase, in any of Live's phrase languages. Voice allow is allow once.
 */
export function assistantLiveVoiceApprovalDecision(
  transcript: string,
): "allow" | "deny" | null {
  // "Allow once?" asks about the answer; it does not give it.
  if (/[?？]\s*$/u.test(transcript)) return null;
  const phrase = matchLiveVoicePhrase(transcript);
  return phrase?.kind === "allow" || phrase?.kind === "deny" ? phrase.kind : null;
}
