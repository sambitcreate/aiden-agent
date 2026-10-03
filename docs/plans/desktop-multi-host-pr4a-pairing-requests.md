# Desktop multi-host PR 4a: host-side pairing requests

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Another desktop can ask this host to pair without a QR code or setup code. The host shows "<device> wants to control this Mac" with a six-digit match code that both screens display. If the person clicks Allow, the host issues the same credential and grants that `/pairing/exchange` would give a desktop, sealed to the requester's key. Deny, expiry and cancellation issue nothing.

**Architecture:**
- `AidenRemotePairingRequestService` (`main/services/aiden-remote-pairing-requests.ts`) owns a bounded in-memory set of requests. It handles admission and rate limits, the commit/reveal exchange, the 25 s long-poll, the approval state machine with exactly-once resolution, credential issuance through `AidenRemoteStateRegistry.issueDevice`, and rollback through `revokeDevice`.
- `main/services/aiden-remote-sealed-envelope.ts` is a pure module with the shared primitives: AES-256-GCM seal/open, HKDF-SHA256 and X25519. It also holds the pairing-request match code, the host commitment and the grant envelope seal/open. The manual-bootstrap seal (`aiden-remote-pairing.ts`) and its client open (`peer-pairing.ts`) now use the same AES-GCM/HKDF helpers.
- The router adds four unauthenticated routes under `/pairing/requests`. The listener tells the service which transport a request arrived on: the Tailscale loopback listener (`acceptStrippedBasePath`) means `tailscale`, and anything else means `lan`.
- `AidenRemoteService` extracts the endpoint and SPKI resolution out of `beginPairingInternal` into `resolvePairingTransport(transport)`. Pairing requests reuse it, with the Tailscale pin cached for 60 s.
- Host UI:
  - a global approval sheet mounted in `root-view.tsx`
  - a system notification raised from the main process
  - an "Accept connection requests" switch in Settings → Remote access

**Tech stack:** TypeScript, `node:crypto` (X25519, HKDF, AES-GCM), `node:test` through `tsx --test`, React with `renderToStaticMarkup` for the UI tests.

**Spec:** `docs/plans/desktop-multi-host-control-plan.md` §1 (pairing) and §7 (Settings), delivery row 4. The host half is here; the client half is PR 4b.

## Wire contract (summary)

The full contract is in `docs/aiden-remote-api-v1.md` § "Pairing requests". Every route is unauthenticated (no bearer token) and refuses any `Origin` header.

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /pairing/requests` | none | Create a request. Body `{deviceName, deviceType, publicKey, clientVersion?}`. Returns `201 {requestId, pollSecret, expiresAt, hostCommitment}`. |
| `POST /pairing/requests/{requestId}/reveal` | `Aiden-Pairing-Secret` | One-shot exchange of the requester nonce for the host nonce. Body `{requesterNonce}`, returns `{hostNonce}`. The host prompt appears only after this call. |
| `GET /pairing/requests/{requestId}` | `Aiden-Pairing-Secret` | Long-poll for at most 25 s. Returns `{requestId, state, expiresAt, envelope?}`. |
| `DELETE /pairing/requests/{requestId}` | `Aiden-Pairing-Secret` | Requester cancel. Returns `{requestId, state}`. |

States are `pending`, `approved`, `denied`, `expired` and `cancelled`. Only `approved` carries `envelope`.

## Decisions taken in this PR

Where the brief left something open, this PR takes the conservative option:

1. **Commit/reveal match code (deviation, a superset of the brief's inputs).** A code computed only from SHA-256(publicKey ‖ SPKI ‖ requestId) can be ground by an active LAN attacker: it controls the requestId and key it forwards, so it can make both screens show the same six digits in about 10⁶ hashes. This PR binds the code to two nonces, using the numeric-comparison pattern from Bluetooth Secure Simple Pairing:
   - The host commits to a 32-byte `hostNonce` in the create response.
   - The requester then sends its own 32-byte `requesterNonce`.
   - Only after that does the host reveal `hostNonce`.

   Each attempt by an attacker in the middle therefore costs one visible host prompt and succeeds with probability 10⁻⁶. The exact derivation is:

   ```
   hostCommitment = SHA-256("aiden-pairing-commit-v1" ‖ 0x00 ‖ requestId(ASCII) ‖ hostNonce)
   digest         = SHA-256("aiden-pairing-match-v1" ‖ 0x00 ‖ requesterPublicKey(32 raw)
                            ‖ serverSpki(32 raw, from "sha256/…") ‖ requestId(ASCII)
                            ‖ requesterNonce(32) ‖ hostNonce(32))
   matchCode      = (big-endian uint64(digest[0..8]) mod 1_000_000), zero-padded to 6 digits
   ```

   The test vectors are in the shared contract fixture. Restricting requests to Tailscale was considered and rejected, because LAN discovery is the main use case.
2. **The poll secret travels only in a header** (`Aiden-Pairing-Secret`), never in a URL, so it never appears in access logs. An unknown `requestId` and a wrong secret both return `404 not_found`. The secret is compared as a SHA-256 digest with `timingSafeEqual`.
3. **Errors reuse existing codes, so native decoders need no new enum cases:**
   - setting off or Remote stopped → `403 pairing_closed`
   - `iphone`/`ipad` → `403 capability_denied`
   - a malformed body or unknown `deviceType` → `400 invalid_request`
   - rate limit or full pending set → `429 rate_limited`, retryable, with `details.retryAfterSeconds`
   - a second reveal → `409 pairing_already_used`
   - an unknown or retired request → `404 not_found`
4. **Limits:**
   - 5 creates per source per minute, and 20 per minute across all sources
   - at most 8 open requests in total and 2 per source, where "open" means pending or approving
   - a 2-minute TTL, measured from creation
   - terminal records kept for 60 s so the requester can learn the outcome, then `404`

   The source is the socket's remote address, and forwarded headers are never trusted. Every Tailscale request therefore shares the loopback bucket, which is conservative.
5. **Display names are sanitized before anything is shown.** `deviceName` is trimmed, limited to 80 characters, and rejected if it contains control characters or bidirectional overrides. It is always presented as the requester's claim and is never authenticated.
6. **The request may carry an optional `clientVersion`** (up to 40 printable characters, default `"unknown"`). Device records require one.
7. **Allow issues exactly the desktop exchange grants.** These are the legacy capabilities, plus the Bot grants (when the host supports Bots), plus the progress grants, plus `host:events`/`runs:observe`/`runs:control` when the host serves them. It is the same as an exchange with `acceptsBotCapabilities`, `acceptsProgressCapabilities` and `acceptsDisplayName` all set to true.
8. **The approval state machine resolves exactly once.** `pending` moves synchronously to `approving`, then to `approved`, `cancelled` or `expired`. Allow and Deny on a request that is not `pending` report the current state without acting.
   - `authorizeCommit` re-checks that the request is still `approving` and unexpired inside the state mutation lane.
   - The envelope is published only after the device record is durable.
   - A seal failure, or a cancellation that lands after commit, revokes the new device and reports `cancelled`.
   - If an approved envelope is never collected before its record retires, or the service stops first, the device is also revoked. The credential never reached anyone.
9. **The envelope is sealed to the requester's X25519 key with a fresh host ephemeral key.**

   ```
   shared = X25519(hostEphemeral, requesterPublicKey)   // an all-zero result is rejected
   key    = HKDF-SHA256(shared, salt(16),
              "aiden-pairing-request-v1\n" + requestId + "\n" + requesterPublicKey + "\n" + hostPublicKey, 32)
   AAD    = "aiden-pairing-request-v1\n" + requestId + "\n" + expiresAt
   ```

   The plaintext is `{kind:"aiden-pairing-grant-v1", requestId, trust, exchange}` with at most 8 KiB. `exchange` is the `/pairing/exchange` response. `trust` is the same object the QR payload carries: `{mode:"private-ca", caCertificateDerBase64}` for LAN, or `{mode:"system"}` for Tailscale.
   - While the record is retained, the envelope can be delivered again to the holder of the poll secret.
   - The client helper `openPeerPairingRequestGrant` in `main/services/peer-pairing.ts` is exported for PR 4b, and its round trip is covered here.
10. **The long-poll keeps one waiter per request.** A new poll replaces the old one, which answers immediately with the current state. A poll returns early on any state change. It is also released when the response closes or the service stops.
11. **The host prompt appears only after the reveal.** This keeps the host from showing a match code the requester cannot reproduce. A request that is never revealed expires silently.
12. **Turning the setting off, stopping Remote access or disabling it cancels every open request.** Approved records are kept, and any that were never delivered are revoked.
13. **`acceptPairingRequests` is persisted in the Remote state document and defaults to on.** If the key is absent, the setting reads as on and nothing is migrated. `/health?detail=host` reports `pairingRequests: true` only while the service runs and the setting is on.
14. **Feature flag `pairing-requests-v1`.** It is added under contract revision 19 and advertised in `/server` to desktop devices while the request service is wired. A requester discovers support through `/health?detail=host` `pairingRequests`, because it holds no credential yet. A rev-19 host built before this PR answers the routes with `404 not_found`, and clients treat that as "unsupported". **If #313 (rev 19) merges to main before this PR, this PR must claim revision 20 at merge time** and update the iOS, Android and fixture contracts together.
15. **The Settings "Connections" segment restructure from master plan §7 is deferred to PR 4b.** This PR adds the switch to the existing Remote access section, which keeps its `remoteAccess` id.
16. **The system notification carries the device name but not the match code.** The code is compared only in the app. Clicking the notification brings Aiden to the front, where the sheet is already showing.
17. **No onboarding step**, as the brief specifies. The feature is host-side and on by default.

## Global constraints

- Phones are untouched: no change to `/pairing/exchange`, the manual bootstrap wire format, or the legacy fixture arrays. The two fixtures stay byte-identical.
- Requests never carry or return secrets other than the requester's own poll secret and the sealed envelope. `/health` stays secret-free.
- Tests are behavioural: register-and-invoke for routes, real services with fixtures, and `renderToStaticMarkup` for UI. No source-grep tests.
- New tests are registered in `test:aiden-remote` (or `test:settings-design`) and in `scripts/ci-test-registry.json`.

## Tasks

- [ ] **Task 1 — Envelope primitives.** Create `aiden-remote-sealed-envelope.ts` and its test (match-code vectors, commitment, seal/open round trip, tamper rejection). Refactor the manual-bootstrap seal and open to the shared AES-GCM/HKDF helpers.
- [ ] **Task 2 — Request service.** Create `aiden-remote-pairing-requests.ts` and its test:
  - rate limits, TTL, deny, cancel, a wrong secret, a phone requester, the setting off
  - rollback when the state write fails
  - a concurrent Allow and Deny
  - an envelope round trip
- [ ] **Task 3 — Router.** Add the routes, labels and templates, the health wiring and the `/server` feature. Router test: register-and-invoke round trip in which the opened credential authenticates `/server`.
- [ ] **Task 4 — State and service.** Persist `acceptPairingRequests`, extract the transport resolver, wire the request service into `startConfigured`, and cancel on stop.
- [ ] **Task 5 — Main and IPC.** Add the `remote:setAcceptPairingRequests`, `remote:listPairingRequests` and `remote:respondPairingRequest` channels and the `remote:pairing-requests-changed` broadcast, plus the system notification.
- [ ] **Task 6 — Renderer.** Add the approval sheet with its presentational body, mount it globally, and add the Settings switch. Rendered UI tests.
- [ ] **Task 7 — Contract.** Update the API doc, OpenAPI, protocol constants and both fixtures (including the match-code vectors). Check the iOS and Android decoders and run their suites where the toolchains exist.

## Client contract handed to PR 4b

1. Generate an X25519 key pair (`generatePairingRequestKeyPair`) and `POST /pairing/requests`.
2. Store `requestId`, `pollSecret` and `hostCommitment`.
3. `POST …/reveal` with 32 random bytes.
4. Verify `hostCommitment` against the returned `hostNonce` (`pairingRequestCommitment`). If it does not match, abort.
5. Compute `pairingRequestMatchCode` using the SPKI observed on the TLS connection, and display it.
6. Long-poll `GET …` until the state is terminal.
7. On `approved`, call `openPeerPairingRequestGrant`. It verifies the envelope and checks that the endpoint and SPKI match the connection.
8. On exit, `DELETE …`.
