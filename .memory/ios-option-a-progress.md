# iOS Option A, M0 safety net (2026-11-05)

Branch `ios/option-a`, measured at `a6836c507`. Baseline numbers are in `docs/testing/aiden-on-the-go/option-a-baseline.md`.

`AidenDemoHosts.swift` (DEBUG only) runs the real shell against fake machines on `*.demo.invalid`, chosen by `-AidenDemoScenario`. The `AidenOnTheGoUITests` target holds one CI smoke test; the screenshot matrix stays local. The unit run skips that target with `-skip-testing:AidenOnTheGoUITests`.

The `ios-27` CI job is non-blocking and runs the same simulator steps on the `xcode-27` image. Release builds stay on Xcode 26.6. `scripts/ios-live-activity-process-proof.mjs` finds the unit target in the xctestrun by `BlueprintName`, not by index.

## M1 (iOS 26 floor, 2026-11-05)

`IPHONEOS_DEPLOYMENT_TARGET` is `26.0` on all 8 build configurations, so the `#available(iOS 26, *)` and `#available(iOS 18.4, *)` branches and their material fallbacks are gone. Only `imagePlaygroundOptions(_:)` (26.4) keeps an `#available` branch. Evidence is in `docs/testing/aiden-on-the-go/option-a-m1-floor.md`. The Xcode 26.6 compile is unverified until a PR runs CI.
