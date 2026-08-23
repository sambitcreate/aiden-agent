# Bot-First Aiden On The Go — Phase 6 evidence

Date: August 23, 2026
Status: Complete — Bot inbox/profile/lifecycle, guided editor, adaptive split navigation, shared-chat access/files, physical-device verification, and independent P0/P1 review passed.

## Delivered boundary

- The Bots home is a message-first inbox with favorites, active and archived identities, honest conversation activity, bounded search, and the requested bottom Search capsule plus separate New Chat button.
- A contact-style Bot profile supports New Chat, Edit, Access, favorites ordering, archive/restore, readable archived conversations, and confirmed deletion using the authoritative chat revision.
- The editor presents plain-language identity and “How it helps,” optional Advanced behavior, Full or progressively reduced Custom access, a shared semantic-avatar designer, and a final accessible Review. Dirty cancellation confirms before discarding.
- Semantic avatars render consistently in the editor, favorites, Bot lists, conversation rows, and profile. Generated raster avatars remain the Phase 7 layer over this universal fallback.
- Regular-width iPad/Stage Manager layouts use `NavigationSplitView`; selected Bot identity persists and reconciles by exact Mac installation plus paired-device identity. Compact iPhone presentation remains native and independent.
- New Chat is offered only for ready Bots. Degraded, unavailable, archived, queued, running, reconciling, failed, and approval-waiting states remain visible with honest actions and accessibility text.
- Bot chats reuse `AidenChatDetailView`. The added Bot presentation exposes effective access, Bot defaults versus per-chat reductions, Connections and Skills first, and a dedicated Files entry without workspace selection, Git/branch, Review, or terminal chrome.
- Per-chat access cannot exceed its Bot. File reads/writes use dedicated Bot conversation routes and exact chat, Bot, policy, catalog, revision, connection, and device grants. Narrowing blocks the next tool effect even during an active reply; widening waits until the next turn.
- Bot chat create/edit/open flows retain exact idempotency attempts across ambiguous outcomes, reject response identity mismatches, reconcile authoritative state after lost responses, and forward direct credential revocation into installation purge.
- Ordinary UI does not reveal the managed Bot workspace/folder. The implementation remains available to the Bot only through the authoritative Mac-owned system instructions and Files surface.

## Review and remediation

Separate product-shell, client/chat-tools, and independent domain reviewers iterated on the shared tree. Closed findings covered stale load completions, lifecycle/favorites reconciliation, canonical chat deletion revisions, archived-only reachability, split-view dismissal and restoration, semantic avatar visibility, dirty dismissals, health/activity honesty, nontechnical editor ordering, hidden-workspace copy, create idempotency, open-chat affinity, Bot-only files, read-only editing, per-chat policy ceilings, active-run narrowing copy, revocation, and stale file grants. The final independent review reported no actionable P0/P1 findings.

## Verification

```text
node --test scripts/check-ios-shipping-target.test.mjs
PASS — 10/10

git diff --check
PASS

Signed build-for-testing, physical iPhone 13 Pro (iOS 27.0)
PASS — TEST BUILD SUCCEEDED

Physical iPhone 13 Pro selected Bot contract/product-shell/remote-client/shared-chat suites
PASS — 152 passed, 3 expected environment-only skips, 0 failures

Post-review focused physical iPhone suite
PASS — editor ambiguity classification, product navigation/health/activity,
lost-create retry, and chat response-affinity tests

Independent final Phase 6 P0/P1 review
PASS — clean
```

The target and tests compile for the declared universal iPhone/iPad device families. A physical iPad was not connected, so Stage Manager, pointer/keyboard, rotation, and physical-iPad visual/accessibility acceptance remain an explicit Phase 8 release gate rather than a claimed result here.

## Gate result

Phase 6 is complete. Phase 7 proceeds from the semantic-avatar fallback and existing authenticated avatar asset/cache contract to Apple Image Playground, accepted-image normalization, paired-Mac canonical upload, replace/revert, and unsupported iPhone 13 Pro fallback.
