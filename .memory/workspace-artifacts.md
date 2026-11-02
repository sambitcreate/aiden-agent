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
- Planned next: add `operation: "run"` to `workspace_artifact` with a per-call approval card (the per-press confirm under Ask lives in the renderer, not in `runner.runAction`); then revision history with Restore.
