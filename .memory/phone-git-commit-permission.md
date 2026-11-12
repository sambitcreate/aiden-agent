# Phone Git commit permission

Issue #546: both native clients already decode the top-level Git review `capability`. Android discarded it only at the UI; iOS also failed to retain it in `AidenWorkspaceGitModel`.

Both clients now require `capability.allowed == true`, visible files and a snapshot before starting a commit. They show the host reason or a local fallback when permission is missing, and check permission again in commit review and confirmation. Android retains its fresh-read requirement. iOS guards the model entry point without changing retry semantics for an already attempted operation. No wire revision or host behavior changes.

Coverage extends existing WorkspaceEnvironment suites and Android Git action rendering tests. Local validation passed: 13 iOS Workspace Environment tests on iPhone 18 Pro / iOS 27 simulator, 14 Android Workspace Environment JVM tests, four Android rendered Git tests on Pixel 10 API 36 emulator, Android lint, and iOS policy checks. Physical-device and release acceptance were not run.
