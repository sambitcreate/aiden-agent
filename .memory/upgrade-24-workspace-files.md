# Workspace editor bounded reads — 2026-09-19

## Finding and change

`readWorkspaceFile` checked pathname size before unbounded `fs.readFile`. An external append after that check bypassed the 1,500,000-byte editor limit. It now reuses Aiden's existing `readRegularFile` with the editor byte cap: descriptor validation, at most cap + 1 bytes, and guaranteed descriptor closure. Overflow keeps a readable editor error. Stable in-root symlinks are resolved before the no-follow descriptor open.

No renderer, shared DTO, write behavior, or selectable capabilities changed. No plan status or onboarding change is needed for this bug fix. This is not a comprehensive fix for directory-component races or an external-file watcher.

## Alternatives inspected

- Stale loads on workspace switch: FilesPanel already invalidates read/save request revisions in its layout effect; not selected.
- External save overwrite: version hashes, recovery displacement checks and atomic no-replace installation already cover tested races; not selected.

## Read-only source lessons

No third-party source copied.

- Waku `6d433e875d57091906ec0770d8bb9ffc9aa29b83`, GPL-3.0, `src/app/file_search.rs`: cap editor work and invalidate derived state when the active file changes.
- OpenCode v2 `7a6ce05d0939826aa6c8e1c481489a713b2d633f`, MIT, `packages/app/src/context/file/content-cache.ts`, `packages/opencode/src/file/index.ts`: explicit content byte budgets protect editor memory; source ingestion also needs bounding. Studied the pinned `opencode-v2-aiden-study` checkout only.
- OMP `f97fa5c95010b62ac34c7357f9a1cae6975e12d6`, MIT, `packages/coding-agent/src/tools/read.ts`: distinguish bounded buffered reads from streaming for large files. Implementation reuses original Aiden infrastructure.

## Validation

- New post-pathname-stat growth regression failed on unchanged baseline with `Missing expected rejection`.
- 19 focused tests passed across `workspace-files.test.ts`, `aiden-remote-files.test.ts`, and `aiden-remote-bot-files.test.ts`.
- New tests cover growth after both size checks, byte-count limit, descriptor closure on overflow, exact UTF-8 byte cap, and stable in-root symlink compatibility. Existing test file is already in `test` and `test:coverage` scripts.
- TypeScript and scoped ESLint passed; diff whitespace check passed.
- Android `AidenWorkspaceEnvironmentTest`: 4 tests passed. Inspected both native workspace-file DTO validators and client reads; existing success/error shapes are preserved.
- iOS isolated unsigned build-for-testing passed; runtime XCTest is not claimed. The campaign coordinator confirmed that physical installation is unnecessary for this change. No simulator or physical app installation performed.
- Exact-head hosted CI and central independent/Pullfrog review remain separate gates.
