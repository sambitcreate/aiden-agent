# Aiden On The Go — Phase 9 evidence

Date: 2026-08-19
Status: Complete on the available physical-iPhone and desktop gates.

The desktop now exposes workspace Files and Git through shared application services used by both Electron IPC and authenticated Aiden Remote routes. File identities and Git snapshots are opaque, device/workspace bound, bounded, and path-free on the wire. File writes use version preconditions. Git commit, push, checkout, branch creation, managed-worktree creation, and managed-worktree deletion require explicit foreground confirmation and durable idempotency; managed worktrees retain Aiden's mutation, rollback, ownership, terminal, generation, and scheduled-task safety gates.

The Swift app provides native Files and Git destinations from Workspace Settings. It supports bounded file search/read/edit, offline cache reads, stale-write reconciliation, Git review/diff/compare/branches/commit/push/worktrees, destructive confirmation, and retry of ambiguous Git outcomes with the original idempotency key. It does not accept or reveal Mac paths or Git administration metadata.

Verification:

- TypeScript type-check passes.
- Shared application-service boundary tests pass 15/15.
- Aiden Remote tests pass 107/107 plus 4/4 LAN transport proofs.
- The complete subagent and workspace-mutation regression suite passes after its source-contract assertions were updated to follow the shared worktree application service.
- The complete signed physical iPhone 13 Pro XCTest suite passes, including opaque Files/Git DTO validation, cache isolation, canonical routes and mutation preconditions, and exact idempotency-key reuse after an ambiguous disconnect. Four explicit environment-gated transport/Keychain tests remain expected skips in the ordinary run.
- The installed app launches successfully on the iPhone 13 Pro.
- No simulator was used and the iPhone 16 Pro Max was untouched.

The physical-iPad and real-Tailscale gates belong to Phases 6 and 8 and were not claimed by this phase. Phase 12 later closes real-Tailscale pairing and authenticated workspace transport on the physical iPhone; physical-iPad acceptance remains open.
