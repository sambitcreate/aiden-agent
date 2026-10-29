# Bot chat: no "Sent" flash on a later visit (2026-10-29)

Phones match a taken Bot message to its transcript entry by `submissionId`, but a snapshot carries only the latest 200 entries. After a long absence, a message taken on an earlier visit had no entry and no Queued bubble, so FR-m5 marked it unheld and it sat at the bottom as "Sent" for the 10 s grace before going.

- Fix (iOS `AidenBotSessionModel.swift`, Android `AidenBotOutbox.kt` + `AidenBotSessionController.kt`): `adopted()` sets a run-only `takenBeforeVisit` when the message already has a submission id; `outgoing` leaves out a message that is `takenBeforeVisit` and unheld. Messages sent on this visit keep the grace unchanged. Before the first snapshot an adopted message still shows (a quick revisit keeps its bubble until the Mac's entry replaces it).
- No protocol revision. The plan's alternative (a receipt sequence in the snapshot, Remote rev) was not needed.
- Tests: `testAMessageTakenOnAnEarlierVisitThatTheMacNoLongerShowsDoesNotFlashBack` (iOS) and `aMessageTakenOnAnEarlierVisitThatTheMacNoLongerShowsDoesNotFlashBack` (Android).
- Inspired by t3code #26739 (sent message reappearing on phones).
