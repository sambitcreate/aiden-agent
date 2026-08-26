# Aiden Remote Multi-Instance Hardening

Status: Complete

This plan is the authoritative delivery contract for pairing-completion UX, multiple mobile devices, multiple Aiden installations on iOS, multiple Macs, and multiple Aiden runtime profiles on one Mac. It extends the active [Aiden On The Go plan](../aiden-on-the-go-plan.md) without weakening its protocol, credential, TLS, approved-root, or Tailscale ownership guarantees.

## Product decisions

1. Pairing is complete only after the newly issued device successfully authenticates back to the Mac. Issuing a credential alone is not shown as “connected.”
2. A successful pairing dismisses the one-time QR, closes the pairing window, announces the connected device, and immediately renders the device as active.
3. Multiple phones and iPads may connect to one Aiden installation with independent credentials, activity, streams, approvals, and revocation.
4. Aiden On The Go treats multiple Macs as first-class installations keyed by the server’s stable `instanceId`; display names are labels, never identity.
5. Fresh unpaired Aiden profiles on one Mac may choose a different stable LAN/loopback port pair. A paired profile never silently changes its endpoint.
6. One physical Mac may publish only one canonical `/api/aiden/v1` Tailscale Serve route at a time. Other profiles remain available over LAN. Aiden never silently steals or resets a route.
7. A stale Aiden-owned route may be taken over only through an explicit, reviewed action that removes exactly the canonical Aiden handler and preserves every unrelated Serve/Funnel configuration.

## Security and correctness invariants

- Pairing remains five-minute, one-use, 256-bit, pinned-identity bootstrap authentication.
- Device bearer credentials remain digest-only on the Mac, instance-scoped in the iOS Keychain, absent from renderer state, logs, discovery, and notifications.
- The renderer consumes allowlisted projections and typed IPC only; UI state is never treated as authorization.
- Device-connected UI is driven by a successful authenticated request observed by Electron main, not by optimistic renderer state.
- `instanceId` scopes credentials, caches, App Intents, workspaces, streams, and installation switching.
- Port selection is bounded, deterministic after persistence, and fails closed on exhaustion or paired-endpoint collision.
- Tailscale ownership is exact-path and exact-target. Funnel and unrelated routes are never modified.
- An old profile cannot disconnect or overwrite a route that has since been claimed by another profile.
- Bonjour exposes only the protocol version, public instance identifier, service port, and a bounded display label.
- Existing v1 clients remain compatible; any additive projection field is optional until both TypeScript and Swift fixtures prove parity.

## Phase 1 — Authoritative pairing completion

### Implementation

- Separate credential issuance from first authenticated contact in the device state model.
- Persist a new device as pending without falsely advancing `lastSeenAt`.
- On the first successful bearer-authenticated request, atomically mark the device connected, persist its real `lastSeenAt`, and broadcast the existing bounded remote-state invalidation.
- In Remote Access settings, correlate the open one-time pairing window with the newly issued device while ignoring unrelated device activity and settings changes.
- After first authentication, close the pairing window, dismiss the QR, show “<device> connected,” focus/highlight its row, and expose it as Active.
- Keep the QR visible for incomplete exchange, Keychain persistence failure, offline first load, cancellation, and expiry. Expose “Finishing connection” without calling it Active.

### Tests and gate

- Pairing issue → pending → first authentication → active transition.
- First authenticated request emits one durable transition even when concurrent requests arrive.
- Unrelated device activity, route changes, and approved-root changes never dismiss the QR.
- Expired, cancelled, failed, duplicate, and already-used pairing windows remain honest.
- Focused main/renderer tests, type-check, lint, and React Doctor pass before review.
- Two fresh-memory GPT-5.6 Sol medium reviews must be resolved before Phase 2.

### Accepted result — 2026-08-21

- Credential issuance now persists a pending device (`lastSeenAt = 0`); the first successful authenticated request atomically records the real contact and concurrent requests produce one durable transition.
- A main-owned, non-secret pairing session identifier correlates the exact pairing window and issued device. Conditional close prevents one Settings window from closing another, including unmount and in-flight begin races.
- The desktop keeps the QR visibly disabled during finishing/failure/expiry, dismisses it only after authenticated contact, announces and focuses the Active row, and renders pending devices honestly in Settings and the global connection popover.
- Save-failure retry, authentication/revocation interleaving, post-deadline first contact, replacement/closure, revoked pending, and lifecycle presentation tests are registered in `test:aiden-remote`.
- Gate accepted after three independent two-review passes and targeted re-checks. `test:aiden-remote` passes 138 tests plus seven transport proofs; type-check and lint pass; React Doctor has no new pairing-specific correctness diagnostic.

## Phase 2 — Stable Mac identity and multi-installation UX

### Implementation

- Add a bounded persisted server display name, defaulting to the macOS computer name with a safe fallback.
- Project that name through `/server`, pairing/install metadata, Bonjour presentation, Remote Access settings, and the iOS installation switcher without changing identity semantics.
- Disambiguate identical Bonjour labels with a stable short public instance suffix.
- Show each iOS installation’s display name, reachability state, endpoint type, and last successful connection.
- Audit all iOS caches, navigation requests, streams, Live Activities, and App Intent catalog entries for exact `instanceId` scoping and stale-generation cancellation during installation switches.

### Tests and gate

- Two installations with the same display name remain distinct.
- Renaming a display label does not rotate credentials or instance identity.
- Switching while requests/streams are in flight cannot leak results into the newly active installation.
- TypeScript/Swift fixture parity and focused iOS tests pass.
- Two fresh-memory GPT-5.6 Sol medium reviews must be resolved before Phase 3.

### Accepted result — 2026-08-21

- A bounded persisted Mac label now defaults from macOS Computer Name and projects through `/server`, Settings, Bonjour, and the iOS installation registry without replacing stable `instanceId` identity. Same-name Bonjour and switcher rows use a stable public suffix.
- Pairing display metadata is opt-in so strict legacy v1 clients remain compatible; current iOS retries the frozen four-field request only after an early-v1 exact-shape rejection. Production-shaped state initialization durably seeds missing files and migrates legacy labels without rewriting current profiles.
- iOS activation-generation leases now scope workspace browsing, chats, Git, files, schedules, navigation, App Intents, cache fallbacks, and Live Activity reconciliation. A→B and A→B→A requests cannot apply stale state or send opaque handles to another Mac; accepted background turns retain their instance-scoped resumable stream handle.
- Scheduled Tasks binds its entire retained modal/model lifecycle to one activation lease, dismisses on installation changes, persists deletion/settings changes, and prevents delayed history writes from restoring removed run summaries.
- Gate accepted after repeated independent two-review passes. `test:aiden-remote` passes 146 tests plus seven transport proofs, type-check and diff checks pass, and a generic physical-iOS compile-only test build succeeds without using a simulator.

## Phase 3 — Same-Mac listener and port hardening

### Implementation

- Introduce a bounded Aiden port-pair allocator for a fresh profile and persist the selected LAN port only after both required listeners bind successfully.
- Retain the persisted port across restarts.
- Auto-select another pair only when the profile has no active or previous device credentials and no externally established endpoint ownership.
- Fail a paired profile closed with a typed `remote_port_in_use` error and remediation instead of moving its endpoint.
- Make listener startup transactional so partial LAN/loopback/Bonjour state is always rolled back.
- Present the selected port and collision remediation through progressive disclosure rather than raw `EADDRINUSE` text.

### Tests and gate

- Two fresh profiles race to enable and receive distinct stable pairs.
- Restart retains the pair; exhaustion fails closed; partial bind rolls back.
- Paired profiles never silently move.
- Bonjour advertises the actual committed port only after successful startup.
- Two fresh-memory GPT-5.6 Sol medium reviews must be resolved before Phase 4.

### Accepted result — 2026-08-21

- Fresh profiles now choose a bounded even LAN/loopback port pair, commit it only after both listeners and Bonjour are healthy, and retain that pair across restarts and connection-mode changes. Inactive transports remain leased but reject new work, and existing keep-alive/SSE sockets are destroyed when their transport becomes inactive.
- Paired or externally owned profiles never move silently. Port exhaustion and committed-endpoint collisions fail closed with typed, bounded remediation; legacy committed odd ports and `65535` remain restart-compatible.
- Candidate allocation excludes every exact canonical or legacy Aiden Tailscale handler target, including ambiguous multi-authority Serve status. Startup and persistence failures roll back listeners, sockets, Bonjour, and state without leaking a half-bound pair.
- The final gate passes 170 TypeScript remote tests plus seven transport proofs, type-check, lint, and diff checks. Two fresh-memory GPT-5.6 Sol medium reviewers found no remaining Phase 3 correctness, security, lifecycle, concurrency, or coverage issue.

## Phase 4 — Tailscale ownership and explicit takeover

### Implementation

- Classify Serve state as owned by this profile, owned by another live Aiden target, stale Aiden target, unrelated conflict, Funnel conflict, or available.
- Keep the canonical public path `/api/aiden/v1` and one-owner-per-Mac policy.
- Replace raw `tailscale_route_conflict` renderer errors with typed, bounded, actionable status.
- Block takeover while the incumbent loopback target is healthy.
- Offer an explicit Take Over action only after a bounded loopback health check proves the incumbent target stale; re-check immediately before mutation.
- Remove and replace only the exact Aiden handler. Persist new ownership only after post-command verification.
- Preserve old-owner safety: disconnect remains exact target + exact ownership and cannot clear a successor’s route.

### Tests and gate

- Live owner blocks takeover; stale owner permits confirmed takeover.
- TOCTOU changes between review and mutation fail closed.
- Unrelated handlers and Funnel state are byte-for-byte preserved.
- Old owners cannot disconnect new owners; failed commands never persist false ownership.
- Two fresh-memory GPT-5.6 Sol medium reviews must be resolved before Phase 5.

### Accepted result — 2026-08-21

- Tailscale Serve state is classified by exact canonical path, exact loopback target, explicit TCP 443 HTTPS state, Funnel state, persisted profile ownership, and bounded health checks. Live owners cannot be taken over; stale owners require a one-use reviewed token and an immediate pre-mutation re-check.
- Every mutation is serialized across local Aiden processes with a kernel-owned exclusive UDP loopback mutex, preserving compatibility with every retained TCP listener port. Aiden fingerprints and verifies all non-Aiden Serve state, permits listener scaffolding changes only for the first/final Aiden handler, and never resets Funnel or unrelated routes.
- Route ownership is persisted only after verified mutation. Persistence failures conditionally restore the exact predecessor without overwriting a successor. Ambiguous CLI outcomes use bounded status retries and one durable pending-outcome record written before mutation; pairing and all ordinary route actions remain blocked until the explicit Verify update action proves an unchanged not-applied state or an exact applied state and atomically commits the result.
- Malformed HTTPS listeners, delayed daemon visibility, external interleavings between verification reads, process crashes, concurrent takeovers, retained legacy ports, legacy origin-only migration, and old-owner disconnects have focused regressions.
- The accepted gate passes 199 TypeScript remote tests plus seven transport proofs, type-check, and lint. Two fresh-memory GPT-5.6 Sol medium reviewers independently report no remaining Phase 4 correctness, security, lifecycle, concurrency, or coverage finding.

## Phase 5 — Multiple-device and multi-Mac acceptance

### Implementation

- Verify independent lifecycle ownership for simultaneous devices, streams, approvals, attachment uploads, scheduled tasks, and revocation.
- Improve desktop/mobile connection summaries for multiple active and inactive devices without exposing secrets or private paths.
- Exercise multiple saved Mac installations, failover, removal, re-pair, App Intents, and cache isolation.
- Update Remote Access operator documentation, project memory, onboarding/feature-tour copy only where first-run behavior materially changed.

### Tests and completion gate

- Two phones concurrently use one Mac; revoking one leaves the other unaffected.
- One phone pairs with two Macs and switches repeatedly over LAN and Tailscale.
- Same-name and offline-Mac cases remain understandable.
- Full `test:aiden-remote`, service-boundary, onboarding, iOS, type-check, lint, build, and relevant physical-device gates pass.
- React Doctor reports no new correctness findings in changed React code.
- Two final fresh-memory GPT-5.6 Sol medium reviews are resolved.
- The plan moves to `docs/plans/completed/` only after every phase and gate above is complete.

### Accepted result — 2026-08-21

- Device authorization now has a synchronous admission fence and mutation drain. Revocation is durably persisted before admitted mutations drain, then retries device-owned chat attachments, workspace operations, streams, and approvals without affecting another device.
- Stream revocation is durably journaled, surfaces persistence failures, retries safely, and filters revoked-device records during startup. A production-shaped restart test proves one device stays revoked while another device's streams and credential remain usable.
- iOS retains every request, cache, active stream, Live Activity, App Intent projection, and removal/re-pair transition under exact `instanceId` plus `deviceId` identity. An installation data gate serializes accepted writes against removal so a late response cannot recreate purged data.
- Installation-scoped chat, scheduled-task, archive, and workspace-environment caches purge only the removed Mac. Legacy flat workspace cache migration deletes only records attributable to that installation and preserves another Mac's data.
- The final gate passes 209 TypeScript remote tests plus seven transport proofs, 18 service-boundary tests, 30 onboarding tests, 20 Ruby release-policy tests with 42 assertions plus 24 Node release tests, type-check, lint, build, and diff checks. The connected physical iPhone 13 Pro passes 100 XCTest cases with five configuration-only skips and zero failures; no simulator was used.
- Two final fresh-memory GPT-5.6 Sol medium reviewers independently found no remaining server or iOS correctness, security, privacy, lifecycle, concurrency, or coverage issue after the repair rounds. React Doctor completed with no new hardening-specific correctness finding.

## Phase review protocol

Every implementation phase uses the same mandatory gate:

1. Implement only the current phase and its tests.
2. Run focused tests plus type-check/lint appropriate to the diff.
3. Give two fresh-memory GPT-5.6 Sol medium reviewers the authoritative plan, current phase scope, and exact diff.
4. Resolve every correctness, security, privacy, lifecycle, concurrency, accessibility, and test-coverage finding.
5. Re-run the phase gates and record the accepted result in this plan and `.memory/aiden-on-the-go.md`.
6. Advance only after both reviews are clean or all actionable findings are fixed and re-reviewed.

## Post-completion repair — 2026-08-26

- A saved endpoint collision remains typed and fail-closed during ordinary startup; paired profiles are never relocated implicitly.
- Settings now offers an explicit, confirmed **Use another port** recovery. It selects a complete available HTTPS/HTTP listener pair, persists it atomically, retains device credentials, and warns that LAN rediscovery may be required.
- Recovery refuses to move while a Tailscale route mutation is pending or this profile still owns a Serve route, preventing an exact-path route from being orphaned.
- The Tailscale companion target remains HTTP loopback behind Tailnet HTTPS. Separately, OpenAI-compatible model servers on private Tailnet addresses accept either HTTP or HTTPS and the setup UI now advertises HTTP directly.
