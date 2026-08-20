# Aiden On The Go — Phase 2 evidence

Date: 2026-08-19
Status: Complete — Remote Access is an explicit, off-by-default desktop capability with authenticated LAN/Tailscale transports, pairing, revocation, approved roots, Settings, onboarding, and documentation.

## Implementation boundary

- `AidenRemoteService` owns the app-lifetime listeners. Disabled startup creates no TLS identity, listener, Bonjour advertisement, or Tailscale route. LAN uses dual-stack HTTPS and `_aiden-agent._tcp`; Tailscale fronts a loopback-only HTTP listener at the exact `/api/aiden/v1` route.
- Installation-local P-256 CA/server identities are persisted owner-only. LAN pairing carries the private CA certificate plus the leaf SPKI pin; Tailscale pairing verifies and pins the actual system-trusted peer identity.
- Pairing opens only after a local desktop action, expires after five minutes, consumes a 256-bit secret once, stores only credential digests, and supports durable per-device revocation and capability checks.
- The HTTP router uses exact paths, bounded duplicate-key-safe JSON, strict protocol and bearer headers, no CORS/browser origin, safe error envelopes, request IDs, connection/time limits, and redacted logging. Health is the only unauthenticated endpoint.
- Tailscale Connect/Disconnect previews and owns only Aiden's exact non-Funnel Serve route. It detects conflicts, verifies the installed route, never runs `serve reset`, and preserves unrelated routes.
- Settings exposes enable/mode, endpoints, route preview, Connect/Disconnect, QR pairing, approved roots, paired devices, and revocation using existing Aiden primitives and semantic tokens. The onboarding tour includes a dedicated transparent 1024×1024 Aiden On The Go illustration.

## Review outcome

The between-phase review was performed locally, per the user's direction to use no subagents. It checked disabled-start side effects, TLS trust semantics, IPv4/IPv6 reachability, one-time pairing, route ownership/cleanup, authentication boundaries, QR secrecy, renderer IPC validation, window-close lifetime, quit cleanup, onboarding accessibility, and documentation.

Review fixes included dual-stack LAN binding for Bonjour/IPv6, a versioned IPC-only QR trust envelope for the private LAN CA, targeted ESLint globals for transport spike scripts, and updates to source-contract tests after the Phase 1 application-service extraction. No production failure remains at the Phase 2 gate.

## Tests

```text
npm run test:aiden-remote
PASS — 76 TypeScript tests plus 4 transport spike tests

npm run test:onboarding
PASS — 18 tests, including tile/asset/alpha contracts

npm run type-check
PASS

npm run type-check:e2e
PASS

npm run lint
PASS

npm run build
PASS

npx playwright test tests/e2e/remote-access-lifecycle.spec.ts --config=playwright.config.ts
PASS — off by default, enable, authenticated HTTPS health, service survives main-window close

npx playwright test tests/e2e/settings-model-picker.spec.ts --config=playwright.config.ts
PASS — Remote Access destination renders Off and unchecked by default

npm test
PASS — complete TypeScript/JavaScript, native helper, Git safety, and Rust lifecycle gate
```

`git diff --check` also passes for the completed Phase 2 state.
