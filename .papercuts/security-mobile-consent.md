# Mobile security remediation papercuts

- 2026-10-27: Native layout differs across platforms. Locate paths with `rg --files`: no `android/README.md`; the iOS durable outbox is declared in `AidenBotSessionModel.swift`, and navigation/archive stores are not separate persistence files.
- 2026-10-27: Xcode 27 beta printed `SwiftCompile ... failed with exit code 0` during a successful build-for-testing run. Check the process exit status and test execution rather than that isolated diagnostic.
- 2026-10-27: Android capabilities live under `protocol`, not `models`; compilation caught and corrected the wrong import. One edit command also used the Android subdirectory instead of the repository root; no files changed before correcting its working directory.
