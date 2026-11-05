# iOS Option A, M0 safety net (2026-11-05)

Branch `ios/option-a`, measured at `a6836c507`. Baseline numbers are in `docs/testing/aiden-on-the-go/option-a-baseline.md`.

`AidenDemoHosts.swift` (DEBUG only) runs the real shell against fake machines on `*.demo.invalid`, chosen by `-AidenDemoScenario`. The `AidenOnTheGoUITests` target holds one CI smoke test; the screenshot matrix stays local. The unit run skips that target with `-skip-testing:AidenOnTheGoUITests`.

The `ios-27` CI job is non-blocking and runs the same simulator steps on the `xcode-27` image. Release builds stay on Xcode 26.6. `scripts/ios-live-activity-process-proof.mjs` finds the unit target in the xctestrun by `BlueprintName`, not by index.
