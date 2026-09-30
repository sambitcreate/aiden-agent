# Softened simulator device-tool guidance — 2026-09-27

Branch `feature/device-tool-guidance`. Source: T3 Code #13908 (Notion research digest 09-27).

The always-on `DEVICE_AGENT_GUIDANCE` block and the `device_open` quick start (`agentDeviceQuickStart`) in `main/services/devices/device-tools.ts` used to forbid raw `simctl`, `xcrun`, and `serve-sim` while a device was attached. That blocked legitimate shell work such as `xcodebuild` builds, `simctl` log streaming, and port forwarding.

Decision: the agent now *prefers* the `device_*` tools and `agent-device` for anything on the device the user is watching in the Environment Simulator tab. Shell `xcrun simctl`, `xcodebuild`, and `adb` are allowed for builds, installs, logs, port forwarding, and diagnostics the device tools do not cover. Both the always-on block and the quick start keep one hard rule: do not shut down or erase the watched device or stop `serve-sim` (unless the user asks), because the Simulator tab stream depends on them. The always-on copy matters because the prompt is loaded before any `device_open` (Pullfrog review on PR #263). The quick start stays iOS-only (no adb/Android lines), and the always-on block stays at 5 lines or fewer.

Tests: `device-tools.test.ts` builds the real chat system prompt through `buildSystemPrompt` with and without `device_open`, and calls `agentDeviceQuickStart`. It checks the preference wording, that no "do not call/use/run simctl|xcrun|adb" ban remains, that every allowed shell tool and purpose is named, and that the teardown rule survives. Docs updated: `docs/devices.md` and `docs/plans/simulator-devices-plan.md`.
