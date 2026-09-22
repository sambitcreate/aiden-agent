# Aiden On The Go — Phase 1 evidence

Date: 2026-08-18
Status: Complete — shared chat/workspace application services preserve the Electron ownership and mutation contracts.

## Implementation boundary

- `main/services/chat-application-service.ts` owns chat list/get/wait/create/rename/empty-move/delete semantics and keeps inactive-renderer reconciliation, atomic create guards, Assistant identity rejection, workspace admission, and privacy-first durable deletion ordering.
- `main/services/workspace-application-service.ts` owns workspace registry list/get/create/folder-create/scratch-create/update/remove semantics and keeps canonical folder validation, renderer path-mutation rejection, mutation/operation drains, generation/schedule settlement, permission restoration, and managed-worktree deletion refusal.
- The corresponding `*-main.ts` files bind Electron-backed singletons; the core services import singleton shapes only as types and remain directly unit-testable.
- `ChatGenerationOwner` is a shared narrow interface. Remote owners retain only digests of bounded device/stream identities and survive network subscriber loss until explicit invalidation. Existing renderer owners still come from `rendererDocumentOwner`.
- `main/handlers/chats.ts` and `main/handlers/workspaces.ts` delegate matching CRUD operations. Renderer-only Assistant creation, dialogs, append/copy/export, Git/files, and approval-facing operations remain in IPC-specific handlers.

## Review outcome

The requested between-phase review was completed locally because the user directed that no further subagents be used. The review compared the extracted services with the removed handler implementations and checked authority lifetime, cancellation/drain order, schedule restoration, deletion durability, Assistant isolation, dialog ownership, and IPC validation.

Two test-only issues were found: source-contract assertions still expected mutation logic inline in `chats.ts`. They were updated to prove both sides of the new boundary: the IPC handler must acquire a renderer owner and delegate, while the application service must retain the mutation and operation gates. No production issue remained after review.

## Tests

```text
npm run type-check
PASS

npm run test:aiden-service-boundary
PASS — 9 tests

npx tsx --test main/handlers/chat-create-params.test.ts main/handlers/ipc-contract.test.ts main/handlers/chat.parse.test.ts main/services/chat-deletion-gate.test.ts main/services/chat-workspace-mutation-gate.test.ts main/services/workspace-mutation-gate.test.ts main/services/workspace-operation-registry.test.ts main/services/workspace-record-removal.test.ts main/services/workspace-schedule-restoration.test.ts
PASS — 43 tests

npm run test
PASS — complete pretest, TypeScript/JavaScript, Telegram, native worktree-remover, and Rust computer-use lifecycle. One initial parallel Git-suite run reported a single transient failure; the isolated 97-test Git suite and the complete retained-log rerun both passed.

npm run build
PASS

npx playwright test tests/e2e/chat-shell-interactions.spec.ts --config=playwright.config.ts
PASS — 1 isolated Electron smoke test
```

Targeted ESLint and `git diff --check` also pass for the Phase 1 files.
