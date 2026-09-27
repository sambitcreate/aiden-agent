# Dictation Secure Input Warning

Status: Implemented for review (`feature/dictation-secure-input`).

Source: Handy parity tracker, P0 — "dictation paste silently fails while macOS
Secure Event Input is active".

## Problem

macOS Secure Event Input (password fields, a terminal's Secure Keyboard Entry,
some password managers) drops synthetic keystrokes from other processes. The
atomic dictation paste (`main/services/dictation-paste.ts`) still reported
`pasted`, so the pill said "Pasted" while nothing arrived.

## Detection

- Carbon `IsSecureEventInput` is neither bridged to JXA nor exported by the
  current macOS SDK (the symbol is absent at link and `dlsym` time on macOS 27).
- WindowServer publishes `kCGSSessionSecureInputPID` in the current CoreGraphics
  session dictionary only while some process holds Secure Input. Aiden reads it
  with a one-line JXA probe (`CGSessionCopyCurrentDictionary`), about 50 ms, with
  no native helper or new entitlement. The same key appears in
  `ioreg -n Root -d1` `IOConsoleUsers`, but that route needs multi-session
  matching and old-style plist parsing.
- The owning PID is not used to name an app: in testing it pointed at the
  frontmost app rather than the process that enabled Secure Input.

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
