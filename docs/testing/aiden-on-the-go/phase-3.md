# Aiden On The Go — Phase 3 evidence

Date: 2026-08-19
Status: Complete — The authenticated remote API supports safe workspace-registry CRUD and approved-root folder selection without exposing or accepting Mac paths.

## Implementation boundary

- Workspace list/get/create/update/remove routes use allowlisted path-free DTOs, strict request schemas, scoped durable idempotency, exact revision preconditions, the shared workspace mutation registry, default-workspace recovery, and immediate Electron invalidation.
- Folderless and managed-scratch creation are supported. Folder-backed creation accepts only a short-lived one-use selection token issued by the server-controlled browser; it never accepts an absolute or relative client path.
- Approved-root navigation is directory-only, nonrecursive, deterministic, paginated, depth-bounded, and excludes hidden/system entries and symlinks. Location handles, cursors, and selections are opaque and bound to the instance, device, root policy, canonical directory identity, and expiry.
- Registration revalidates root approval, policy revision, real path, directory device/inode identity, and duplicate state inside the serialized workspace commit. Removing a workspace never deletes its folder, while generic deletion refuses managed worktrees.

## Review outcome

The between-phase review was performed locally, following the user's direction not to use subagents. It checked DTO secrecy, parser aliases, cursor isolation, replay, expiry, symlink and root replacement, root-policy removal, selected-folder TOCTOU, stale revisions, deletion side effects, idempotency restart behavior, operation snapshot secrecy, desktop reconciliation, and disabled-start side effects.

Review fixes moved revision checks and directory revalidation inside authoritative mutation leases, prevented stale removal requests from closing a workspace terminal, sanitized control characters from browser labels, and made the idempotency store persist the in-flight admission before mutation and terminal response afterward. No production failure remains at the Phase 3 gate.

## Tests

```text
npm run test:aiden-remote
PASS — 88 TypeScript tests plus 4 transport spike tests

npm run test:aiden-service-boundary
PASS — 12 tests

npx playwright test tests/e2e/remote-access-lifecycle.spec.ts --config=playwright.config.ts
PASS — 1 test

npm run lint
PASS

npm run type-check
PASS

npm run type-check:e2e
PASS

npm run build
PASS

npm test
PASS — complete TypeScript/JavaScript, native helper, Git safety, and Rust lifecycle gate
```

The real HTTP integration test browses an approved root, exchanges the opaque directory handle for a selection, creates a workspace, patches it with its revision, removes it, verifies default-workspace preservation, and asserts that no raw path appears in the response. `git diff --check` also passes for the completed Phase 3 state.
