# Dictation Secure Input Warning

Status: Complete — merged in [PR #267](https://github.com/sambitcreate/aiden-agent/pull/267) on 2026-09-30; on main after 0.51.0, not yet released.

Source: Handy parity tracker, P0 — "dictation paste silently fails while macOS
Secure Event Input is active".

## Problem

macOS Secure Event Input (password fields, a terminal's Secure Keyboard Entry,
some password managers) drops synthetic keystrokes from other processes. The
atomic dictation paste (`main/services/dictation-paste.ts`) still reported
`pasted`, so the pill said "Pasted" while nothing arrived.

## Detection

- The documented Carbon `IsSecureEventInputEnabled()` API is exported and callable
  through JXA. The original investigation used the incorrect `IsSecureEventInput`
  symbol and fell back to an undocumented session dictionary key.
- Detection now uses Carbon with a bounded timeout. A live test enables and disables
  a process-owned Secure Input claim, verifying the probe follows both transitions.
- Clipboard restoration requires AXValue evidence of insertion, keeping the transcript
  copied if Secure Input changes during focus revalidation or delivery is uncertain.

## Behavior

1. Accessibility missing → existing "allow Accessibility" copy (probe skipped).
2. Secure Input active → transcript written to the clipboard, no keystroke, and a
   `copied` result with reason `secure-input`.
3. Probe failure or unexpected output → logged; transcript stays copied.
4. Clipboard restoration requires AXValue evidence of insertion; uncertain
   delivery leaves the transcript available for manual paste.

The pill shows a warning-tone shield icon, "Secure Input blocked paste", and
"Transcript copied — press ⌘V to paste." A screen-reader-only sentence explains
the cause. The result stays visible for 4 s instead of 1.2 s.

## Tests

- `main/services/dictation-paste.test.ts`: injectable detector (active, failing,
  precedence), probe output mapping, live darwin probe.
- `main/services/dictation-coordinator.test.ts`: reason reaches the pill and the
  hide delay outlasts a normal paste.
- `renderer/pill/pill-copied-notice.test.tsx`: rendered warning and fallbacks.

## Follow-ups

- Physical acceptance on supported macOS releases remains useful; the atomic
  transaction now preserves transcripts when insertion cannot be confirmed.
- Optionally surface the condition in Settings → Dictation diagnostics.

Review refinement: a missing/non-string AXValue does not prevent a paste attempt after focus validation. If delivery cannot be confirmed (including text normalization), the pill asks the user to check the field and preserves the transcript rather than instructing a second paste.
