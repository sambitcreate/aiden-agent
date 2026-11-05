# Settings → Storage (2026-11-05)

PR #731 (Cursor's branch `cursor/settings-storage-9f2b`) added the page; it was reworked on `claude/project-thread-68t03f` after the owner chose a full rework (1a) with chats deleted one at a time only (2a). Guide: `docs/storage.md`; plan: `docs/plans/storage-plan.md`.

- The scan walks every top-level profile entry; `STORAGE_PROFILE_LAYOUT` only picks the category, and unnamed entries are "Other app data". Bytes are allocated blocks (sparse Bot computer disks), hard links count once, each worktree is measured once and last. Budget: 1M entries / 20 s; every worktree and chat is still listed when it runs out (`bytesComplete: false`, "At least").
- A chat's size = transcript + pictures no other chat references (refcount by sha256 in `chats/images/xx/<sha>`).
- Worktrees are kept for unknown Git state, unreadable scheduled tasks, active chat, changing, uncommitted, unpushed, or a scheduled task in them. Chats are kept when owned, active or pinned (unreadable pins keep all).
- `delete-threads` must name exactly one chat (parser and service both enforce it). No bulk sweep.
- Clear cache goes through Electron sessions (default session, workspace browser profiles, each Bot's partition): `clearCache`, `clearCodeCaches`, shader cache. Cookies and site storage stay.
- Worktree removal deletes the branch only when it still points at `createdFromHead`; the first proposal wrongly said it always deletes the branch.
- The CI failure-digest reporter changes that were on #731 were left out of the rework; they are still on `cursor/settings-storage-9f2b`.
- Test gotcha: in node:test + happy-dom, `waitFor(() => assert.equal(el, null))` can OOM the runner; use `assert.ok(!el)`.
- Review fixes (2026-11-05): a skipped folder no longer stops a category's walk and marks the report a minimum; root Cache/Code Cache/GPUCache show under Browser data; cache bytes count only aiden-browser-*/aiden-bot-* partitions, and Clear cache also visits those left on disk by deleted profiles or Bots; the default session's shader cache is cleared too.
