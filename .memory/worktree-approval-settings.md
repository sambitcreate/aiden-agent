# Worktrees keep the workspace's approval settings — 2026-11-22

- Part of `docs/plans/proactive-aiden-plan.md` Phase 1 ("Fix: worktrees keep the workspace's approval settings").
- `workspace-worktree-application-service.ts` copies `approvalMode` and `macGrants` (through `parseApprovalMode` / `parseWorkspaceMacGrants`, only when present) into the new workspace on both creation and snapshot restore, next to `permission` and `workspaceCapabilityFields`.
- An uncustomized workspace copies neither field, so its worktree keeps following the global mode.
- `validateBeforeSave` now also rejects the create when the source's approval mode or Mac grants changed mid-create (it compared only `permission` before).
- Covers desktop New worktree and phone new-worktree (same service); later B7 and D5 reuse it.
- Tests: `workspace-worktree-application-service.test.ts` (lane `test:aiden-service-boundary`).
