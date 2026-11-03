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
- Planned next: revision history with Restore, a New page entry point, then export/import (an imported page arrives with its approval cleared).
