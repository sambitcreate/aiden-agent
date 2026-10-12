# Default-on: Simulator devices and Aiden Live screen sharing (2026-10-07)

- `AIDEN_EXPERIMENTAL_DEVICES` and `AIDEN_EXPERIMENTAL_GEMINI_LIVE_SCREEN` now default on, matching the voice Live flag: unset means on; `1`/`true` means on; anything else is a kill switch. Devices stay macOS-only; screen sharing still requires the Live gate.
- Both were turned on before their pending acceptance (real-Mac Phases 4–6 for devices, native-picker receipt for screen capture). Track those as follow-ups.
- Design Studio and Create Images (`AIDEN_EXPERIMENTAL_DESIGN_STUDIO`, `AIDEN_EXPERIMENTAL_CREATE_IMAGES`) stay off: their routes are still placeholders.
- Follow-up: onboarding coverage for the Simulator tab (a feature-tour tile needs its own code-drawn art; see `.memory/onboarding-art.md`).
- E2E: `environment-devices-tab.spec.ts` now hides the tab with `AIDEN_EXPERIMENTAL_DEVICES: "0"` instead of an empty environment.
