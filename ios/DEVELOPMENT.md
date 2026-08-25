# iOS development

Requirements: current Xcode, iOS 18 or newer, and access to this repository's configured Apple development team for signed hardware runs.

Build and test the `AidenOnTheGo` scheme from `AidenOnTheGo.xcodeproj`. Use an explicit physical-device destination for acceptance evidence. Do not place credentials, pairing payloads, LAN addresses, certificates, or generated test-run files in source control.

The mobile client implements only `/api/aiden/v1`. When a wire shape changes, update the OpenAPI contract, shared fixture, desktop parser/tests, Swift parser/tests, and protocol documentation together.

Per-phase evidence belongs under `../docs/testing/aiden-on-the-go/`. See [`AGENTS.md`](AGENTS.md) for the working agreement and safety rules.
