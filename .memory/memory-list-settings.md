# Settings → Memory: What Aiden remembers (2026-10-27)

From the tool audit (owner choice 5a): people could ask Aiden to remember or forget a fact in chat, but had no way to see what was saved.

- `main/services/workspace-memory-facts.ts` maps a workspace to the same memory scope chats recall from (shared folder hash, else `persistedChatWorkspaceId`), lists active unexpired facts newest first, and deletes one by id inside that scope only. Superseded and expired rows are hidden.
- IPC: `workspaces:memoryFacts` and `workspaces:deleteMemoryFact` (under the existing `workspaces:` invoke prefix). Renderer: `memory-facts-section.tsx` under the Workspaces group in Memory settings, with a workspace picker, per-fact Delete, and a destructive confirmation.
- Delete is permanent (`MemoryStore.remove`). There is no add or edit; Bot memory stays on each Bot's page. Phones do not show this list.
- Tests: `main/services/workspace-memory-facts.test.ts` (real SQLite store, in `test:compaction`) and `tests/e2e/memory-list.spec.ts` (approve `remember_fact` in chat → see it in Settings → delete → gone after relaunch).
