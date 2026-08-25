# Aiden On The Go — Project Intent

Aiden On The Go lets a user securely control their own Aiden Agent Mac from iPhone or iPad. It is a client, not an agent runtime or hosted service.

Core boundaries:

- Pair explicitly with a Mac using a short-lived QR bootstrap and per-device revocable credential.
- Connect over pinned local HTTPS or the Mac's explicitly configured Tailscale route.
- Match Aiden's chat and workspace behavior without widening permissions or exposing private Mac paths.
- Keep credentials in Keychain and bounded offline presentation state on device.
- Use native SwiftUI controls and adaptive Apple navigation.

The normative scope is in [`PROJECT_SPEC.md`](PROJECT_SPEC.md).
