# Aiden Live on Linux

Live could not start on Linux for two reasons (confirmed on a real Linux run, 2026-11-19):

1. `setupComplete` in `renderer/components/assistant/use-assistant-live.ts` required Computer Use ready and enabled, and Computer Use is macOS-only.
2. Main's `aiden:media:status` returns `"unknown"` off macOS, which the hook mapped to `"unavailable"`, so both `setupComplete` and `start()` refused.

Fix:

- `normalizeMicrophonePermission(status, platform)` maps Linux `"unknown"` to `"granted"`; a missing or busy input still fails at Start with its own error. macOS `"unknown"` still blocks.
- `setupComplete` is now Google availability + microphone only. Computer Use is optional everywhere (on a Mac it adds the `computer_use` tool; main and the Live system instruction already handled sessions without it).
- The setup dialog hides Screen and Accessibility where Computer Use status is `unsupported` (`computerUseOffered`) and calls it optional on a Mac. Settings → Aiden Live shows Microphone Ready with no Allow on Linux.
- Screen share stays Mac-only in this change via `hostPlatformCapabilities().liveScreenShare`: the display-media guard's non-picker handler denies, so Choose… silently did nothing on Linux. A Linux picker is the follow-up PR.
- Live still can't act in other apps on Linux (no Computer Use).
