# Aiden On The Go — Phase 0 evidence

Date: 2026-08-18
Status: Complete — contract, transport, signing, threat model, parser parity, durability, and physical-device gates pass.

## Contract and threat model

- Normative prose: `docs/aiden-remote-api-v1.md`
- Machine-readable schema: `protocol/aiden-remote/v1/openapi.json`
- Shared fixture: `protocol/aiden-remote/v1/fixtures/contract.json`
- Threat model: `docs/security/aiden-remote-threat-model.md`
- iOS implementation contract: `ios/PROJECT_SPEC.md`

Automated desktop proof:

```text
npm run type-check
PASS

npm run test:aiden-remote
PASS — 43 protocol/security-semantics tests and 4 LAN transport/restart tests
```

The LAN spike generates a local P-256 CA plus server-only leaves (`CA:FALSE`, digital-signature key usage, server-auth EKU) and proves normal hostname/chain validation, stable installation-key restart, same-key certificate renewal, changed-key rejection and explicit re-pair recovery, wrong-pin rejection, wrong-host rejection, and expired-certificate rejection. Private keys remain in a temporary directory and are removed by the spike.

## Swift contract and transport proof

Current generic-hardware compile command:

```text
xcodebuild build-for-testing -project ios/AidenOnTheGo.xcodeproj \
  -scheme AidenOnTheGo \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO
```

Result: PASS. The deterministic Swift contract suite and its environment-gated trust/Keychain cases are now run on explicitly selected physical iOS devices; hosted CI performs only the signing-disabled generic-hardware compile. The TypeScript and Swift tests decode the same checked-in fixture. The privacy tests assert that the built host declares a non-empty `NSLocalNetworkUsageDescription` and the canonical `_aiden-agent._tcp` Bonjour service while shipping no insecure HTTP or arbitrary-load ATS exception. Swift and TypeScript enforce the same known payload/error bounds using Unicode-scalar counts, exact Health allowlisting, strict full-string RFC 3339 timestamps, safe-integer stream sequences, non-null schema members, canonical encoded paths and ASCII host authorities, required unknown-event payload, forbidden wire fields, duplicate-key and unpaired-surrogate rejection, finite JSON numbers, aligned raw/parsed extensible-envelope limits, and a 1 MiB JSON/SSE body ceiling.

Physical-device setup is non-secret and reproducible:

1. Run `scripts/aiden-remote-physical-device-spike-server.mjs --host <Mac LAN address>`.
2. Build for testing with automatic signing and the approved Aiden identifiers.
3. Copy the generated `.xctestrun` beside its `Build/Products` payload (or preserve/rewrite its relative `__TESTROOT__` paths), then add the ephemeral canonical pairing-bootstrap JSON as a test-process environment variable, modeling the QR transfer.
4. Run only `AidenRemotePhase0Tests/testPhysicalDevicePinnedURLSessionWhenConfigured` on the connected iPhone.

The test makes a real request through `AidenPinnedServerSessionDelegate`, verifies the health response, then proves that the same endpoint is rejected with a wrong SPKI pin. No private key, endpoint, LAN address, or fingerprint is committed.

Physical result: PASS on `Smbt16ProMax` (iPhone 16 Pro Max, iOS 27.0) — one test executed with zero failures in 0.652 seconds. The first hardware attempt usefully exposed missing Local Network/Bonjour declarations, which were added and locked by `testLocalNetworkPrivacyAndBonjourContractIsDeclared`. A second attempt exposed an incorrect hard-coded Mac interface; the successful run derived the active interface from the default route and advertised that LAN address. The final run admitted the correctly pinned health request and rejected the wrong pin through the real device URLSession trust stack.

Signed Keychain result: PASS on the same device — the approved `sbtbiswas.AidenOnTheGo.pairing` service resolved from the signed application plist, an ephemeral probe completed write/read/delete, and the same account remained absent from a distinct service. Cleanup ran in-test and no credential or probe value was logged or committed.

Expanded physical lifecycle result: PASS on `Sambit’s iPhone` (iPhone 13 Pro, iOS 27.0). A fresh signed payload first repeated the correct-pin health request and wrong-pin rejection, then completed this six-case matrix with one focused XCTest and zero failures per case:

| Case | Separate server process | Expected result | Result |
| --- | --- | --- | --- |
| Original pairing | Yes | Current pin accepted; deliberately wrong pin rejected | PASS |
| Process restart | Yes | Persisted installation key remains accepted; wrong pin rejected | PASS |
| Same-key renewal | Yes | Renewed certificate remains accepted; wrong pin rejected | PASS |
| Key rotation / repair | Yes | New pin accepted only after explicit repair; original pin rejected | PASS |
| Wrong hostname | Yes | Normal hostname validation fails closed | PASS |
| Expired certificate | Yes | Normal validity validation fails closed | PASS |

The matrix used one private installation-identity directory across genuinely separate Node processes. Every process issued a new ephemeral pairing secret and port, while only the intended key/certificate lifecycle property persisted. After the final duplicate-key/ATS remediation, a new signed payload repeated the signed Keychain proof and the complete six-case matrix with the same passing results. That exact built app reported the approved team/bundle/Keychain identity and no `NSAppTransportSecurity` exception dictionary. Injected test-run files, pairing bootstraps, private keys, certificates, build products, and logs were kept under private temporary paths and removed after the summarized result was recorded.

## Tailscale Serve proof

Initial `tailscale serve status --json`: `{}`.

An ephemeral HTTP health service was bound to loopback. A single path-scoped, non-Funnel HTTPS handler was added with the equivalent of:

```text
tailscale serve --yes --bg --https=443 \
  --set-path=/aiden-phase0-spike http://127.0.0.1:42731
```

The stable tailnet HTTPS URL returned the expected JSON health payload. The handler was removed with the matching path-specific command:

```text
tailscale serve --yes --https=443 --set-path=/aiden-phase0-spike off
```

Final `tailscale serve status --json`: `{}`. Funnel was never invoked and `serve reset` was never invoked. A second live proof first installed an unrelated exact-path handler, added the Aiden handler, removed only the Aiden handler, and compared the remaining status: the unrelated handler and its target were byte-for-byte unchanged. The unrelated proof handler was then removed with its own exact-path `off`, restoring `{}`. The temporary TLS certificate/key requested by the local Tailscale CLI for the proof were deleted after validation. A checked-in pure planner test additionally covers unowned matching-target conflicts, persisted Aiden ownership, idempotent reconnect/disconnect, preservation of unrelated handlers, and preservation of Funnel state.

## Automatic-signing preflight

The connected-device `build-for-testing` command used:

```text
DEVELOPMENT_TEAM=5WP229CBB8
APP_BUNDLE_IDENTIFIER=sbtbiswas.AidenOnTheGo
APP_GROUP_IDENTIFIER=group.sbtbiswas.AidenOnTheGo
CODE_SIGN_STYLE=Automatic
-allowProvisioningUpdates
-allowProvisioningDeviceRegistration
```

Result: PASS. Xcode provisioned the main app, test bundle, existing share target, and Live Activity widget. Inspection of the signed main app, test bundle, and Live Activity widget reports:

```text
Identifier=sbtbiswas.AidenOnTheGo
TeamIdentifier=5WP229CBB8
application-identifier=5WP229CBB8.sbtbiswas.AidenOnTheGo
com.apple.security.application-groups=[group.sbtbiswas.AidenOnTheGo]

Identifier=sbtbiswas.AidenOnTheGoTests
TeamIdentifier=5WP229CBB8

Identifier=sbtbiswas.AidenOnTheGo.LiveActivityWidget
TeamIdentifier=5WP229CBB8
```

This resolves the Phase 0 team mismatch at the built-product/provisioning boundary. Permanent target renaming and identity cleanup remain Phase 5 work.

After the final trust-delegate remediation, a fresh generic iOS `build-for-testing` also passed. Its current `.xctestrun`, signed application, and signed test bundle were generated together; the application still reports `Identifier=sbtbiswas.AidenOnTheGo`, `TeamIdentifier=5WP229CBB8`, and App Group `group.sbtbiswas.AidenOnTheGo`, while the test bundle reports `Identifier=sbtbiswas.AidenOnTheGoTests` and the same team. The build was regenerated after adding the Local Network/Bonjour declarations and was the payload used for the passing physical run.

## Review outcome

The post-hardware review rounds reported no P0 and identified concrete P1 contract/lifecycle gaps. Remediation binds file handles to workspace identity, keeps selection nonces consumed after mutation errors, persists and authoritatively finalizes stable in-flight operation references, validates expected SSE stream identity, constrains Tailscale to a server-owned loopback HTTP target, rejects endpoint userinfo, aligns bounded Swift/TypeScript decoding, configures the approved Keychain service, and persists transport identity across real process restarts. Later passes closed parser parity, Release ATS, Health/timestamp/Unicode, restart, and Tailscale-capability edges. Phase 12 real-tailnet acceptance further requires that the target restore the exact canonical Aiden API base stripped by `--set-path`. The final hardening rejects duplicate/escaped-equivalent keys, non-finite values, unpaired surrogates, null schema members, unsafe stream integers, encoded endpoint variants, numeric-final-label DNS aliases, and noncanonical/ambiguous Tailscale listener authorities. OpenAPI, TypeScript, and Swift now share the same endpoint vectors and JSON-safe sequence maximum.

Persisted idempotency envelopes and state-specific entries are exact allowlists; durable-operation arrays reject every non-dense own key. Replay values have depth, node, key, array, string, per-result, and aggregate-snapshot limits. The live operation registry is capped at 10,000 owners with owner-checked capacity release. If an action has run but its result or rejection cannot be persisted within the exact schema and byte budget, its stable operation reference remains indefinitely `in_flight` for authoritative reconciliation instead of expiring into a duplicate retry.

At the user's direction, the final post-remediation gate was completed locally without further subagents. It included targeted adversarial restore/settlement tests, a 20,000-authority OpenAPI/runtime parity fuzz with zero mismatches, lint, schema parsing, diff checks, type-check, all 43 focused protocol/security tests, all 4 transport tests, and the complete repository lifecycle. The current signed source also ran directly on `Sambit’s iPhone` (iPhone 13 Pro): all 21 deterministic Phase 0 tests passed and the two environment-injected live transport/Keychain cases skipped as designed. Earlier signed evidence remains valid for Keychain isolation and all six certificate-lifecycle cases; the iPhone 16 Pro Max was untouched.

## Full applicable test gate

```text
npm run test
PASS
```

The repository's complete desktop test lifecycle passed after the final reviewer remediations, including the new pretest contract/transport suite, all JavaScript/TypeScript suites, native worktree-remover tests, and 41 Rust computer-use-broker tests plus formatting/clippy. The focused Aiden Remote suite, desktop type-check, and focused Swift suite were also rerun after the final contract, redirect, idempotency, selection-transaction, and Tailscale changes and passed.
