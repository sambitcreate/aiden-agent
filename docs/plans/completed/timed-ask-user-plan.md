# Timed ask-user waits with late-reply handling

Status: Complete — merged in [PR #270](https://github.com/sambitcreate/aiden-agent/pull/270) on 2026-09-29 and shipped in 0.51.0. CLI timeout policy and native late-answer prefill remain follow-ups.

Source: the DeepSeek harness comparison page and the 2026-09-24..27 digests. They point out that an `ask_user_question` wait can block an unattended run forever, and that an answer arriving after the agent has moved on is silently dropped.

## Contract

- `ask_user_question` accepts an optional `timeoutSeconds` (integer, clamped to 30–3600 s).
- The main-owned `AskUserQuestionCoordinator` owns the deadline. It stamps `expiresAt` (ISO 8601) on the prompt and settles the wait itself when the deadline passes. A response that arrives after the deadline is also settled as a timeout, even if the timer has not fired yet.
- A timed-out response is `{ cancelled: true, answers: [], timedOut: true }`. `timedOut` is main-only: owner responses cannot set it. Because it is also `cancelled`, existing consumers such as the vendored advisor picker fall back to their default without code changes.
- The tool result tells the agent that no answer was received. It says to proceed with its best judgement or any default it stated, to name the assumption it made, and not to ask the same question again.
- Deadline policy (`resolveAskUserQuestionTimeoutMs`):
  - Attended desktop owners have no deadline unless the tool asks for one.
  - Unattended (Remote-owned) runs always get one, capped at 300 s, which is the existing Remote question lifetime. The wire contract is unchanged, so there is no protocol revision bump.
- `chat:answerQuestionnaire` returns `{ status: "answered" | "expired" }`. A prompt that expired recently (the last 64 are remembered) returns `expired` instead of an error.

## Surfaces

- Desktop:
  - Once `expiresAt` passes, the composer shows an "expired" notice.
  - If the agent finishes after that deadline, the expired question remains visible in the composer so the user can still answer it.
  - An answer submitted after expiry is not lost. It becomes a "late answer" notice that offers **Send as follow-up**, or **Queue follow-up** while a response is streaming, plus **Discard**.
  - The follow-up text restates each question with its answer.
- Remote: the stream uses the prompt's `expiresAt`, capped at the Remote lifetime, for `question_required` and the pending-question snapshot, so clients see the real agent deadline.
- iOS and Android: when the local expiry trips, the question is no longer dropped silently. Both clients show that Aiden continued with its best judgement and suggest sending the answer as a message.
- CLI TUI: one timeout covers the entire questionnaire, including all steps of a multi-select question. Each terminal selection receives the remaining time and the tool-call cancellation signal.

## Follow-ups

- Native late-answer follow-up UX (composer prefill) and a live-expiry card state on iOS and Android.
- An optional deadline for detached or background desktop renderer runs, for example scheduled tasks rendered in a window.
