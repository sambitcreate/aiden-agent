# Bot-First Aiden On The Go — Phase 4 evidence

Date: August 23, 2026
Status: Complete — authenticated Bot application routes, bounded inbox/search, favorites, notice acknowledgement, managed-home files, canonical avatars, cache notifications, lifecycle races, and independent reviews passed.

## Delivered boundary

Phase 4 exposes the enforced Mac-owned Bot runtime from Phase 3 to authenticated Aiden On The Go clients. It does not yet add the production Swift product shell or Bots inbox; those begin in Phase 5.

- Remote Bot CRUD, archive/restore, Full/Custom access, chat reductions, notice acknowledgement, Bot-chat creation, favorites/order, and Bot conversation projection use the main-owned Bot application and authority services.
- Empty Full-mode chat creation resolves the exact current Mac provider/model. Explicit and Custom selections resolve opaque mobile IDs to exact private runtime identities without fallback, and inventory leases remain current through final policy/chat publication.
- The inbox uses stable keyset paging and bounded search over Bot identity, title, and one precomputed visible-message preview. Production performs one indexed metadata read and one bounded activity batch rather than loading histories per row.
- Favorites use one durable process-wide list and mutation lane shared by Remote updates and desktop archive removal. Multi-Bot locks are acquired in stable order.
- Canonical photos are independently decoded, center-cropped, resized, and re-encoded as private 512 × 512 PNG assets. First upload compares the Bot revision; replacement and removal compare the current asset revision.
- Managed-home file handles are opaque and bound to the device, Bot, chat, policy, home incarnation, and file identity. Active reads/writes re-enter runtime authority; archived Bots have a separate read-only authority and reject writes.
- Device revocation, Bot/archive state, policy drift, managed-home replacement, provider inventory changes, stale revisions, and cross-Bot references fail closed. Upload bodies are bounded before authorization leases are acquired, so a stalled sender cannot delay revocation.
- Bot and chat change broadcasts invalidate the desktop Bot roster, details, conversations, Telegram views, and dependent caches.

## Review and remediation

Independent acceptance, lifecycle, provider-race, and security reviews ran between fix loops. Closed findings included deny-only mobile approval escalation, avatar compare-and-swap ambiguity, provider/model inventory time-of-check/time-of-use windows, durable policy publication after lease invalidation, and archived-file authority isolation. Final reviewers reported no remaining P0, P1, or P2 findings.

## Verification

```text
npm run type-check
PASS

npm run lint
PASS

npm run test:bots
PASS — 376/376

npm run test:aiden-service-boundary
PASS — 70/70

npm run test:aiden-remote
PASS — 302 passed, 1 environment-only skip; LAN transport spike 7/7

Focused Bot-file, publication-race, inbox, avatar, renderer-invalidation, provider, and favorites suites
PASS

git diff --check
PASS
```

### Physical iPhone 13 Pro

Phase 4 changes only the Mac-side application, storage, and Remote service. The Swift fixtures verified on the physical iPhone 13 Pro in Phase 2 were unchanged, so this phase did not reinstall the app. Physical-device verification resumes in Phase 5 when the Swift domain and product shell change, and continues through the Phase 6 bottom Search and New Conversation controls.

## Gate result

Phase 4 is complete. Phase 5 can build the typed Swift Bot domain, installation-scoped cache, Workspaces/Bots shell, Aiden-logo switcher, versioned Full Access notice, and Bot-aware deep-link routing on this authenticated service.
