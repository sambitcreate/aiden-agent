# Aiden Remote Multi-Instance Hardening

Status: Active

This plan is the authoritative delivery contract for pairing-completion UX, multiple mobile devices, multiple Aiden installations on iOS, multiple Macs, and multiple Aiden runtime profiles on one Mac. It extends the active [Aiden On The Go plan](aiden-on-the-go-plan.md) without weakening its protocol, credential, TLS, approved-root, or Tailscale ownership guarantees.

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

## Phase review protocol

Every implementation phase uses the same mandatory gate:

1. Implement only the current phase and its tests.
2. Run focused tests plus type-check/lint appropriate to the diff.
3. Give two fresh-memory GPT-5.6 Sol medium reviewers the authoritative plan, current phase scope, and exact diff.
4. Resolve every correctness, security, privacy, lifecycle, concurrency, accessibility, and test-coverage finding.
5. Re-run the phase gates and record the accepted result in this plan and `.memory/aiden-on-the-go.md`.
6. Advance only after both reviews are clean or all actionable findings are fixed and re-reviewed.
