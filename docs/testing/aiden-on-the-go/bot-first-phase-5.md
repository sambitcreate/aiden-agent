# Bot-First Aiden On The Go — Phase 5 evidence

Date: August 23, 2026
Status: Complete — typed Swift Bot domain, exact-device cache, Bots/Workspaces product shell, access gate, deep-link routing, message-first inbox foundation, and independent review passed.

## Delivered boundary

- The Aiden logo opens exactly Bots and Workspaces and preserves an independent navigation stack for each paired Mac installation and device pairing.
- Bots become the message-first mobile surface without introducing a second chat engine. Bot chats reuse `AidenChatDetailView`, including streaming, approvals, attachments, recovery, and draft persistence.
- The versioned Full Access notice gates action. Customize First opens the same guided Bot editor and can create the first Custom Bot without an intermediate unrestricted record.
- Bot creation exposes plain-language identity, semantic avatar, Full/Custom access, providers/models, Files, shell, Connections, Skills, and other projected capabilities. The Mac remains authoritative and every write carries exact context, revision, inventory, and idempotency fences.
- Bot and conversation snapshots are scoped by both Mac installation and paired device. Re-pair, revocation, and Mac A → B → A completion races cannot publish stale data.
- The inbox keeps archived Bots solely as identity owners for readable archived chats while excluding them from favorites and new-chat controls.
- The Bots page includes the requested bottom Search capsule and separate New Chat compose button. Search uses the bounded server query and pagination contract.
- Credential revocation from any Bot or shared-chat request immediately enters the coordinator's pairing purge path.

## Review and remediation

Independent product-shell, client-boundary, architecture, and domain reviews ran between fix loops. Closed findings included empty Customize First navigation, restorable exact-device paths, direct-chat mutation authority, draft merge races, stale re-pair caches, credential-revocation propagation, paginated search, and archived-chat identity validation. The final physical build and focused regression suite were green.

## Verification

```text
node --test scripts/check-ios-shipping-target.test.mjs
PASS — 10/10

git diff --check
PASS

Signed physical iPhone 13 Pro build-for-testing
PASS — TEST BUILD SUCCEEDED

Physical iPhone 13 Pro selected Bot/cache/product-shell/client/chat/contract suites
PASS — 146 executed, 3 environment-only skips, 0 failures

Physical iPhone 13 Pro archived-Bot cache/product-shell follow-up
PASS
```

## Gate result

Phase 5 is complete. Phase 6 continues from the already-shipping inbox, bottom dock, and creation editor with Bot profile, edit/archive/restore, favorites management, chat-level access reductions, managed files, and accessibility/manual UI acceptance.
