# Aiden Manual Pairing

Status: Implemented; manual LAN/Tailscale UI acceptance remains open

## Objective

Add a human-readable setup-code path beside the existing QR flow without weakening Aiden Remote's certificate-pinned trust bootstrap, one-use credential issuance, or multi-Mac isolation.

## Protocol decision

Aiden will not send a low-entropy numeric bearer password and will not implement a new elliptic-curve PAKE in application code. There is no maintained Swift-native PAKE dependency that interoperates cleanly with Electron without adding a Rust/XCFramework/native-addon supply chain.

The manual path therefore uses a uniformly random 100-bit Crockford Base32 setup code. The code is never sent to the Mac. It locally derives an AES-256-GCM key with HKDF-SHA256 and decrypts the existing canonical QR trust envelope fetched from the selected Mac. An offline attacker receives only an authenticated ciphertext and must search the full 100-bit code space. After decryption, iOS applies the existing strict endpoint, expiry, private-CA/system-trust, SPKI-pin, and 256-bit one-use-secret validation before using the existing pinned pairing exchange.

The QR and setup-code paths share one pairing window and one exchange secret, so exactly one device can win. A code cannot locate a Mac: LAN users select a Bonjour-discovered exact instance, while Tailscale users provide the canonical endpoint.

## Invariants

- Pairing remains off by default and locally initiated on the Mac.
- Setup codes expire after five minutes, are replaced atomically, and never enter logs, persistence, public snapshots, Bonjour TXT records, URLs, query strings, or App Group state.
- The manual bootstrap endpoint returns only a bounded, static encrypted envelope while a pairing window is open.
- The setup code is normalized with an exact ASCII allowlist; Unicode lookalikes are rejected.
- The decrypted envelope must name the exact selected endpoint before any credential exchange.
- QR and manual flows consume the same 256-bit secret synchronously before durable device issuance.
- A device is presented as connected only after its first authenticated callback.
- Failed pairing never replaces or damages an existing installation or credential.

## Phases

1. Align the documented QR envelope, manual-bootstrap schema, errors, threat model, and shared fixtures.
2. Add the in-memory setup-code lifecycle, sealed-envelope creation, bounded unauthenticated route, IPC-only code delivery, and adversarial TypeScript tests.
3. Add Mac scan/copy/manual-code presentation with expiry, regeneration, accessibility, and certificate-check separation.
4. Add iOS Scan, Paste Setup Payload, and Enter Code paths; nearby exact-instance selection; canonical Tailscale endpoint entry; sealed-envelope decryption; and existing pinned exchange reuse.
5. Add Swift contract, cryptographic-vector, endpoint-binding, lifecycle, Keychain rollback, permission, and compatibility coverage.
6. Run focused TypeScript and Swift gates, three fresh-memory reviews, fix every actionable finding, and update project memory and plan status.

## Acceptance

- Existing QR-only clients remain compatible.
- The same pairing window cannot issue two credentials through any QR/manual race.
- Captured manual-bootstrap traffic contains no reusable bearer secret and cannot be modified without authenticated-decryption failure.
- Wrong, malformed, expired, replaced, cancelled, replayed, oversized, and cross-Mac inputs fail with typed behavior and no state corruption.
- LAN private-CA and Tailscale system-trust pairing pass on physical devices.

## Implementation and review result

Implemented 2026-08-21 across Electron main, the authenticated Remote API contract, Remote Access settings, and Aiden On The Go. The Mac creates one five-minute QR/setup-code window; the setup code is displayed only through IPC, while the unauthenticated endpoint returns a bounded AES-256-GCM envelope. iOS can select a discovered Mac or enter an exact Tailscale endpoint, decrypts locally, then reuses the existing pinned one-use exchange.

Three fresh-memory reviews covered server races/security, iOS transport and credential persistence, and cross-platform UX/contracts. Their accepted findings are closed: credential issuance has an in-mutation session fence; iOS stages and authenticates the new installation before promotion; re-pair credentials use versioned Keychain scopes with an atomic registry pointer; bootstrap reads are stream-bounded; ASCII/base64url inputs are canonical; stale discovery selection and pairing-task cancellation fail closed; Tailscale endpoints, expiry, regeneration, and selected-state accessibility are explicit; and both runtimes execute the shared crypto vector under contract revision 3.

Automated verification passes: 216 Aiden Remote tests plus seven transport proofs, TypeScript type-check, lint, iOS release policy, diff check, and the complete physical iPhone 13 Pro XCTest target with 101 passes, five expected environment-gated skips, and zero failures. No simulator was used. A real manual setup-code entry through the shipping UI over LAN and Tailscale, plus physical-iPad acceptance, remains an explicit hands-on acceptance step; no claim is made that those UI checks occurred in this implementation run.
