# Proactive Aiden C1–C3 review fixes — 2026-11-22

Decisions from the Phase 1 review (docs/plans/proactive-aiden-plan.md):

- Timers never exceed an hour: check-backs (`MAX_TIMER_MS`) and keep-awake rechecks (`KEEP_AWAKE_MAX_RECHECK_MS`). A delay past 2^31-1 ms would fire at once, and a backward clock jump made that a busy loop.
- Check-backs: a failed read of the setting re-arms a minute later instead of waiting for resume or unlock. A record still `claimed` at launch gets an "interrupted" card ("may not have finished, check before redoing"), not "Missed". Quitting awaits notices already being posted (at most 2 s) before the final save. Restored notes are trimmed to 500 code points.
- Keep-awake: check-back and wake-up holds are exempt from the 4-hour idle cap; other work still lets go.
- Remote settings revision covers only the six phone-visible fields (`remoteScheduledSettingsRevision`, passed to `updateSettings` as `revisionOf`), so a desktop-only toggle never fails a phone edit; the desktop keeps its full revision.
- An owed turn whose prompt is the person's own queued message (`answersPerson`, checked against the chat's message by `screenedPrompt.messageId`, notices excluded) may set a check-back; woken turns, owed turns answering a notice and goal rounds still may not.
