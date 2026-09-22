# Contributing to Aiden On The Go

Follow [`AGENTS.md`](AGENTS.md), the phase plan, the normative remote API, and the repository-wide test requirements. Preserve the imported MIT license and bundled third-party notices.

Do not commit personal signing overrides. Put local identity overrides in `Config/Local.xcconfig`, which is ignored. Do not add a third-party dependency or a new remote endpoint without explicit approval and corresponding contract coverage.

Every behavior change needs focused XCTest coverage and physical-device verification proportional to risk. Never use a simulator as a substitute for signed Keychain, Local Network, Bonjour, or production trust evidence.
