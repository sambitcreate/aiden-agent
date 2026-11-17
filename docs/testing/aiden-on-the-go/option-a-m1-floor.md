# Option A M1: iOS 26 floor

Evidence for Task 5 (`2d7b79341`, "require iOS 26"). Compare with `option-a-baseline.md`.

## Results

| Runtime | Scope | Passed | Skipped | Failed |
| --- | --- | --- | --- | --- |
| iOS 27.0, iPhone 18 Pro (Xcode 27.1) | full run, `AidenOnTheGoTests` | 1,334 | 7 | 0 |
| iOS 26.5, iPhone 17 Pro (Xcode 27.1) | `-only-testing:AidenOnTheGoTests` | 1,334 | 7 | 0 |

The baseline at the 18.0 floor was 1,333 passed and 7 skipped. The one extra test is the chrome glass mode test added in Task 5.

The UI target also passed: 3 tests in the full run on iOS 27.0, and the shell launch smoke test (`testShellLaunchesForEveryScenario`) on iOS 26.5.

## Not verified

The Xcode 26.6 compile (iOS 26.5 SDK, the version CI's `ios` job and releases use) has not been run. Everything here was built with Xcode 27.1. The code uses no API newer than the 26.5 SDK, and the one call newer than 26.0 (`imagePlaygroundOptions`, 26.4) is behind `#available`, but this is unverified until a PR runs CI.
