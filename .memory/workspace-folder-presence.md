# Missing workspace folder notice — 2026-10-29

Adopted from Pi #11511 (deleted working directory) as part of the "six upstream changes" plan, step 1.

- `main/services/workspace-folder-presence.ts`: `workspaceFolderPresence` (`present` / `missing` / `unknown`; ENOENT and ENOTDIR are missing, permission errors are `unknown` and never block) and `assertWorkspaceFolderPresent`, called before `assertManagedWorktreeAdmission` in `prepareGeneration` (llm-client) and in both scheduled-task paths. The refusal message is shared with the renderer (`renderer/shared/workspace-folder-presence.ts`) so desktop, phones and paired Macs read the same sentence.
- IPC `workspaces:folderPresence`; ChatPane queries it (10 s stale, refetch on focus), shows `WorkspaceFolderMissingNotice` above the composer, and refuses a send before append so the text stays in the composer. A send that drains from the queue instead fails at main and pauses the queue (existing behavior).
- Workspace folders stay fixed by design (`workspaces:update` refuses `folderPath`), so there is no "Locate folder" action; workspace memory is keyed by the folder path too.
- CLI: `runCli` checks `process.cwd()` first and prints one line, exit 1. Pi's own fix (#11511) is not in a Pi release yet and Aiden reads the cwd before Pi anyway.
- Tests: `main/services/workspace-folder-presence.test.ts` (test:workspace-intake, core lane in ci-test-registry.json), `tests/e2e/workspace-folder-missing.spec.ts`, CLI `tests/runtime.test.mjs` (fails with `uv_cwd` without the fix).
