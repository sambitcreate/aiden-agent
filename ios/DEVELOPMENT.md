# iOS development

Requirements: current Xcode, iOS 26 or newer, and access to this repository's configured Apple development team for signed hardware runs.

Build and test the `AidenOnTheGo` scheme from `AidenOnTheGo.xcodeproj`. Use an explicit physical-device destination for acceptance evidence.

iPhone Duo needs Xcode 27.1 (`/Applications/Xcode.app`, the Xcode CI and TestFlight builds use). Built with the Xcode 27.0 beta, the app runs on the Duo's inner display in a compatibility window with horizontal bars and a bottom tab bar; built with 27.1, the system moves the toolbar to the trailing rail (the closed Duo's tabs are Aiden's own dock along the bottom since 2026-11-25; the open Duo keeps the system sidebar). If `xcode-select` points at the beta, run Duo builds with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. The project must still build with 27.0: 27.1-only API (such as `toolbarVerticalCompressionBehavior`) stays behind an SDK check. Do not place credentials, pairing payloads, LAN addresses, certificates, or generated test-run files in source control.

The mobile client implements only `/api/aiden/v1`. When a wire shape changes, update the OpenAPI contract, shared fixture, desktop parser/tests, Swift parser/tests, and protocol documentation together.

Per-phase evidence belongs under `../docs/testing/aiden-on-the-go/`. See [`AGENTS.md`](AGENTS.md) for the working agreement and safety rules.
