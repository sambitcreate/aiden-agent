# External transcript images

- 2026-10-27: zsh rejects unmatched globs before rg runs. Use rg --glob filters and verified paths for cross-surface searches.
- 2026-10-27: The nearest SSRF transport returns decoded text and truncates large bodies. Image loading needs its bounded byte path, with oversized images rejected rather than decoded from a prefix.
- 2026-10-27: Playwright resolves as CommonJS in this repo. Import test/expect through the existing fixtures adapter; direct named imports fail collection.
- 2026-10-27: The installed Playwright browser revisions do not match the lockfile. Use Electron's existing Chromium in the isolated test harness, matching the app and avoiding a second browser dependency in the Electron CI lane.
- 2026-10-27: The standalone renderer bundle traverses lazy KaTeX CSS. Its unused stylesheet needs the empty CSS loader in this behavior-only harness; app stylesheet/themed visual acceptance remains separate.
- 2026-10-27: CoreSimulator reports iOS 27.1 available, but rejects iPhone 17 creation as incompatible. Select a runtime/device pair from its supportedDeviceTypes inventory instead of guessing from version alone.
