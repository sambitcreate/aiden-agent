# Dictation Secure Input warning — 2026-09-27

Branch `feature/dictation-secure-input`; plan `docs/plans/dictation-secure-input-plan.md`.

- `pasteTranscript` (main/services/dictation-paste.ts) takes an injectable
  `isSecureInputActive`. Order: Accessibility check → Secure Input probe → atomic
  paste. Active → clipboard + `{ outcome: "copied", reason: "secure-input" }`.
  Probe errors preserve the transcript and skip synthetic paste.
- Live detector uses documented Carbon `IsSecureEventInputEnabled()` through
  JXA. The prior investigation used the incorrect `IsSecureEventInput` symbol.
  Verified the documented API is exported in the installed SDK and callable.
- The atomic transaction checks the target AXValue after the keystroke; absent
  evidence of insertion, it reports copied and retains the transcript. This
  covers Secure Input activation during the focus-check delay.
- The detector reports only the boolean condition; the UI does not attribute it to an app.
- `DictationCopiedReason` lives in `renderer/shared/dictation.ts`. The pill's copied
  result renders through `renderer/pill/pill-copied-notice.tsx`. The coordinator
  holds a secure-input result for `WARNING_HIDE_DELAY_MS` (4 s).
- No Remote protocol, iOS, or Android impact: the pill state is desktop-only IPC.

Review validation: 15 focused paste/pill tests pass, including a process-owned enable/disable cycle, live Carbon probe, and AppleScript compilation. CI test inventory now registers the pill test.

The JXA probe explicitly binds `IsSecureEventInputEnabled` as a no-argument boolean function, avoiding reliance on OS BridgeSupport metadata. The plan index and PR description now match the Carbon detector and conservative copy fallback.

Independent review: reading the original AXValue is optional, so text controls without an accessible value still receive a guarded paste attempt. An unconfirmed result or transport error says “Check the field — transcript copied.” It never instructs a second paste after a possibly successful attempt; the prior clipboard is restored only after confirmed delivery.
