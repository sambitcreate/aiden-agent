# Renderer display clocks

Running Bot status lines, subagent groups and details, and image-generation placeholders share the display-only `renderer/lib/second-clock.ts` store. One timeout updates them on wall-clock second boundaries. Subscribers keep a cached snapshot between ticks; the first subscription after an idle period refreshes it immediately. Fixed previews and inactive work do not subscribe, and the last unsubscribe cancels the timeout.

Request deadlines, credential expiry, animation cadence, and recording timers keep their existing clocks. This store does not enforce deadlines or trigger network requests.

## Measurement and verification

On 2026-10-21, a mounted fixture using ten production `BotStatusLine` components registered ten one-second intervals before this change and one shared timeout afterward. Components mounted at different times join that same timeout. This counts scheduled display wakeups in Happy DOM; it is not an Electron CPU, energy, or frame-rate benchmark.

The mounted Bot status-line test checks a common tick, staggered mounting, partial unmounting, fixed previews, resuming after idle, and final timer cleanup. Existing subagent and image-placeholder suites check elapsed labels, completed durations, persistence handoff aging, and image arrival behavior.
