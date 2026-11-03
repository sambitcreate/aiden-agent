# Workspace artifacts (2026-10-19)

Built in PR #554 on `claude/project-thread-7xf9t3`. The user guide is `docs/workspace-artifacts.md`, and the decisions are in `docs/plans/workspace-artifacts-plan.md` ("As built").

Owner decisions:
- The Artifacts tab shows only once the workspace has a page.
- The workspace owns its pages, and the person deletes them from the tab or by asking Aiden.
- Access follows chat behavior.
- Desktop only (macOS and Linux) for v1: no CLI, Bots, Telegram, phones or Remote protocol change.

Invariants to keep:
- Main runs only commands saved with the artifact. The renderer sends an id, an action name, values and the page digest; main refuses a digest that changed.
- Under Ask, shell commands run only when `approvedDigest === workspaceArtifactDigest(sources, actions)`. File sources run under Ask without approval. None runs nothing.
- The tool's approval card records the digest per stream, and the tool consumes it.
- Action placeholders are standalone unquoted arguments, never the command itself, after a runner (eval/sudo/env/xargs, `RUNS_ARGUMENT`) or in an interpreter's code position (`CODE_ARGUMENTS`: `sh -c`, `python -c`, awk/sed program); text params never where bash reads names or arithmetic (`[[ ]]`, `(( ))`, let/read/declare/printf -v). The scan builds real shell words per top-level command (drops redirections, skips assignments and keywords), so the command name can't hide. A real-shell oracle test runs every accepted candidate with code-running values; extend it with each new bypass. The parser skips comments, tracks `$'…'`, refuses unbalanced quotes and any placeholder it didn't check. Values are bound to read-only `AIDEN_ARG_N` variables (not `set --`, which a template could reset), so the confirmed value is the one that runs. No leading `-`, no negative numbers, and no control or invisible characters.
- A shared refresh is keyed by digest, approval, permission and the resolved folder. A caller cancelling leaves the run going; the run aborts when the last caller leaves. Only the newest live run for a page saves, and results are never saved when the digest changed mid-run.
- The folder is re-verified with realpath before anything runs.
- The `aiden-artifacts` skill is a builtin in `main/services/workspace-artifacts/skill.ts`, not in `resources/aiden-help`, because the CLI copies that folder.
- Removing a workspace, including through the worktree path, removes its artifact files.

Tests: `npm run test:workspace-artifacts`. Each of the five build phases had an Opus medium review, and the blocking findings were fixed with behavioral tests.

## Build-and-check loop (2026-11-02)

Adopted from a review of DeepSeek Creator Mode's plugin skill (Notion: "DeepSeek Creator Mode → Aiden"). The skill teaches list, save a small working page, read the save result, fix, stop. It says not to make mock previews and not to test a button that changes something.

- Each create/update result now ends with a page check (`main/services/workspace-artifacts/check.ts`). It draws the page with the first refresh's data, mirroring `renderNode` in `aiden-ui-block.tsx` (If, Each, node budgets), and reports field reads that miss on every row, member reads on a list (including `.length`), `<Each>` over an object, unknown `$name`s, `run()` calls naming no action or passing the wrong number of values, and sources the page never reads. Reads rooted in a source that did not load, and rows of an empty list, are reported as not checked rather than passing.
- The evaluator gained an optional `scope.onRead` hook, set only by the check. If `renderNode` changes how it walks the tree, update the check's walker too.
- Check limits (after review): it is bounded (250 ms deadline, 10 findings, 3,000 chars) because it runs inside every save. Page-chosen names are JSON-quoted and only shown when they match `[\w$-]{1,40}`, so source data or markup can't inject text into the tool result. Guard reads (If/ternary tests, `!`, left of `&&`/`||`, `== null`) are collected statically and not flagged. Hidden If branches, render-budget cutoffs and time-outs are reported as not checked. Shared helpers moved to `renderer/shared/aiden-ui/props.ts` and the render budget to `AIDEN_UI_RENDER_BUDGET` so the renderer and the check can't drift.

## Agent run (2026-11-02)

- `workspace_artifact` gained `operation: "run"` (`id`, `action`, `args`). It calls the same `runner.runAction` the tab's buttons use, then refreshes and returns the refresh summary.
- Under Ask the card shows `preview: {kind: "command"}` with the resolved command; its digest is `runApprovalDigest(pageDigest, command)`, so an allowed card covers that exact command on that exact page. A save card's digest can't authorize a run. No card when there's no folder, permission is none, or the page's commands were never allowed (the call then refuses). Under Full it runs with no card; "only when asked" is skill guidance only.
- A failed command throws, so the chat shows the call as failed. The card label is "Artifact" and the timeline says "Run artifact action".
- `llm-client.ts` carries the card's preview through `artifactApprovalPreview` next to `artifactApprovalDigest`.
- Planned next: revision history with Restore (built 2026-11-03, below), a New page entry point, then export/import (an imported page arrives with its approval cleared).

## Revision history (2026-11-03)

- `store.replace` (through private `replaceWith`) keeps the version it replaced in `<workspaceId>.history.json`: its own `DataStore` (0600, compact, `preserveCorruptFile: false`, 24 MiB cap, injectable as `historyMaxBytes`). Entries are `WorkspaceArtifactRevisionV1` (`revision, savedAt, description?, visual, sources, actions, refresh`) and never carry `approvedDigest`. The normalizer validates each entry by rebuilding a full artifact and running `parseWorkspaceArtifactV1`, and drops bad entries and non-id keys.
- At most `WORKSPACE_ARTIFACT_HISTORY_LIMIT` (5) per page, sorted by revision. Before each write, `trimHistoryToFit` drops the oldest entries across pages (by `savedAt`) until the JSON fits, so history never fails for size.
- History is written after the page write succeeds. A failed history write goes to `onHistoryError` (main.ts logs it with `logger.error("workspace", …)`; store.ts can't import `platform.js` because tests load it without Electron) and never fails the replace. `create`, `rename`, `approve` and `saveState` record nothing. `delete` drops the page's history; `removeWorkspace` removes the file.
- `restore(ws, id, revision, options)` replaces the page with the entry through `replaceWith`, keeping the current title (read inside the artifacts transaction), so the revision increments, the replaced version goes into history (restore is undoable) and approval follows replace's rule: kept only when the restored digest equals the approved one, or `options.approved`. A dropped revision throws "Revision N of this artifact is no longer kept."
- `history()` returns `WorkspaceArtifactRevisionSummary` newest first; `commandsChanged` compares the entry's digest with the current page's digest (not the approved one). `earlierRevisions(ws)` is the bulk read `list` uses.
- IPC `workspaces:artifacts:history` and `workspaces:artifacts:restore`; restore validates a positive safe integer and always passes `approved: false`, so the renderer can never approve through it.
- Tool `operation: "restore"` (`id`, `revision`). Under Ask a card like update's ("Restore revision N of the artifact …") appears when the restored commands exist and differ from `approvedDigest`; its digest is the restored commands' digest. `assertSourcesRunnable` applies. Create, update and restore share the `afterSave` tail (first refresh + page check). Timeline label "Restore artifact".
- Panel: **Earlier versions…** (lucide `History`) opens a dialog keyed by artifact id like rename/delete. After a restore it calls `refreshAtRevision(n)`; `useArtifactRefresh` re-reads once the view reaches revision n, if the page may run. The row buttons use `aria-disabled` rather than `disabled` while a restore runs. In jsdom, a `waitFor` on a closing Radix dialog in this panel spun forever; the tests settle with `act` + a short timeout instead.
