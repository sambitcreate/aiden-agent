# Aiden Live on Linux

Live could not start on Linux for two reasons (confirmed on a real Linux run, 2026-11-19):

1. `setupComplete` in `renderer/components/assistant/use-assistant-live.ts` required Computer Use ready and enabled, and Computer Use is macOS-only.
2. Main's `aiden:media:status` returns `"unknown"` off macOS, which the hook mapped to `"unavailable"`, so both `setupComplete` and `start()` refused.

Fix:

- `normalizeMicrophonePermission(status, platform)` maps Linux `"unknown"` to `"granted"`; a missing or busy input still fails at Start with its own error. macOS `"unknown"` still blocks.
- `setupComplete` is now Google availability + microphone only. Computer Use is optional everywhere (on a Mac it adds the `computer_use` tool; main and the Live system instruction already handled sessions without it).
- The setup dialog hides Screen and Accessibility where Computer Use status is `unsupported` (`computerUseOffered`) and calls it optional on a Mac. Settings → Aiden Live shows Microphone Ready with no Allow on Linux.
- Screen share on Linux (follow-up PR): `hostPlatformCapabilities().liveScreenShare` is macOS + Linux. `assistant-live:display-sources` returns `portal` on Wayland (`liveDisplayPickerMode`, `--ozone-platform=x11` forces `list`) or `list` with up to 24 screens/windows (screens first, PNG thumbnails) on X11. The renderer shows `LiveScreenSourcePicker` for `list` and binds with `{ sourceId }`; the guard's display handler (Linux only gets a resolver) resolves that id, or lets the portal choose, and re-checks the binding after the async lookup. macOS keeps the system picker and never reaches the handler.
- Live still can't act in other apps on Linux (no Computer Use).
