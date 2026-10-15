# Devices: live acceptance on real simulators (2026-10-08)

Results are in `docs/plans/simulator-devices-t3-parity-plan.md` under "Live acceptance 2026-10-08".

## How it was driven
- A scratch Node driver launched `build/` with Playwright `_electron`, the e2e bootstrap (`tests/e2e/electron-test-bootstrap.cjs`) for the LM Studio redirect, a tiny mock LM Studio, an isolated `--user-data-dir`, and the **real** HOME (simctl and adb need it). It copied the dev profile's `devices/tools` into that user-data folder, so "Set up simulator streaming" granted consent without npm. Commands were posted to a loopback control server one at a time.
- Do not pass the e2e fixture's `--disable-gpu` or `--force-prefers-reduced-motion`; 3D needs WebGL.
- Native save dialogs were stubbed in main with `app.evaluate(({ dialog }) => { dialog.showSaveDialog = … })`.

## Hazards on this Mac
- Other sessions use the same simulators. One launched an app on the booted iPhone Duo, one shut down and rebooted an iPhone 17 Pro, and the Claude app's simulator panel attaches to whichever simulator was booted last. Use throwaway simulators with unique names (`simctl create`), and never give a throwaway the same name as an existing device.
- Another process quit the "Aiden Agent Dev" app mid-run. Relaunch and continue.
- A second consumer of a helper's `stream.avcc` (a probe script) can starve the app's stream.

## Findings worth remembering
- serve-sim keeps a stream helper per UDID and `grid/api/start` reuses it, even after the simulator restarts. Its status routes (`/vendor/serve-sim/readyz`, `/api`, `/ax`, …) call `W4()`, which closes helpers of simulators that are not booted. `grid/api/shutdown` also closes the helper, but it shuts the simulator down.
- The hub's Android boot calls `listDevices` → `avdmanager list avd` (needs Java) before allocating a console port.
- HID Cmd+V pastes on iOS 27 with the hardware keyboard state as is, but the four key events need small gaps.
- The Duo cover's camera hole is at (1255, 143), radius 55, in the 1398 × 2034 cover framebuffer (`simctl io <udid> screenshot --mask=black --display=<cover display>`). The mask is square along the hinge.
