# Durable chat pull requests

Status: Implemented and independently reviewed; hosted CI acceptance is tracked on PR #184.

## Scope

Preserve the existing PR #184 desktop workflow: many durable links per chat, canonical host/repository/number identities, cached snapshots, current-PR resolution, explicit link/unlink/create actions, and crash recovery. Exclude managed-worktree lifecycle and stack mutations.

## Research verification

The 2026-09-14 Notion T3 notes describe an earlier Aiden baseline. Current main already has workspace PR reads; #184 adds durable chat relationships. Verified upstream T3 #10839 merged as `afb84898be3bf9b83bd4cb98c608b79c433579cc` on 2026-09-09, with multi-link persistence, dismissal and legacy capability behavior. Upstream #10875 exists and describes explicit guarded stack actions. Neither source establishes an Aiden-native stack API contract: no speculative stack endpoints or mutations are introduced.

## Implementation

- Validate supplied expected-head SHA at IPC, service and durable-intent boundaries; invalid input never becomes an absent expectation.
- Save a created link and settle its intent in one atomic store publication. Keep unknown/empty/advanced-head outcomes unresolved; block repeat creates for the same unresolved target. A confirmed manual-resolution action lets the user clear a pending attempt after checking GitHub; unverifiable candidates cannot be auto-adopted.
- Pin recovery to the recorded repository, and pin post-push operations to the credential-free identity of the actual frozen push endpoint. Unsupported endpoint shapes offer manual URL linking. The creation dialog names its exact destination repository; cross-fork PRs into a different upstream base remain a manual GitHub workflow.
- Canonicalize stored URLs from validated identity. Persist unlink dismissals so current-PR discovery cannot restore a removed association; explicit relinking clears dismissal.
- Preserve event-driven refresh and branch-derived current selection without changing chat identity or worktree ownership. Correct post-push source transport.

## Compatibility and onboarding

All additions are local Electron IPC and a separate per-chat store. Existing chats and V1 files lacking dismissal state read as empty dismissal lists. There are no Remote HTTP/SSE/OpenAPI or transcript/activity changes. Inspected iOS `AidenChat.swift` and Android `models/AidenChat.kt`: neither consumes desktop GitHub/PR IPC, so no mobile model migration or new server capability is required. Native multi-PR surfaces remain future work and are not advertised.

The existing #184 onboarding Git workflows tile already introduces multiple PR links and keeps its optimized illustration and asset contract. No new core feature tile is added by this hardening pass.

## Validation

Focused regression suite: `npm run test:chat-pull-requests`. Build and TypeScript checks; full `npm test` (including Remote contracts, onboarding, Git and IPC tests). Independent GPT-5.6 Sol medium blast-radius and adversarial reviews; follow-up reviews after remediation. React Doctor reported 78/100 with three pre-existing render-ref findings in Composer/Environment/Chat pane; those lines are unchanged by this PR and out of scope. Local full suite: 6,825 pass, 1 skipped, 0 failures; focused final store suite: 87 pass; IPC: 14 pass. TypeScript and production build pass. Future schema versions and malformed durable pending expectations are write-protected with byte-preservation regressions. Exact-head hosted checks and review-thread audit are tracked on PR #184.

## Automated review follow-up

Deletion revokes admission before draining queued PR-store writes and removing the file; late provider responses cannot recreate state. Every completed create attempt notifies the renderer after its durable outcome, including unknown and ambiguous outcomes. Delayed link/create deletion and pending-notification regressions pass. Focused PR tests: 91; service-boundary tests: 103; TypeScript and Electron build pass. Both bounded Sol follow-up reviews are clean. Hosted verify and Electron E2E passed on 9d8928a4; the follow-up commit requires its own hosted checks.
