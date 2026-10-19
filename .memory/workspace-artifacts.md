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
- Action placeholders are standalone unquoted words. Values go through `set --` with `"${N}"`. No leading `-`, no negative numbers, and no control or invisible characters.
- A shared refresh is keyed by digest, approval, permission and the resolved folder. A caller cancelling leaves the run going; the run aborts when the last caller leaves. Only the newest live run for a page saves, and results are never saved when the digest changed mid-run.
- The folder is re-verified with realpath before anything runs.
- The `aiden-artifacts` skill is a builtin in `main/services/workspace-artifacts/skill.ts`, not in `resources/aiden-help`, because the CLI copies that folder.
- Removing a workspace, including through the worktree path, removes its artifact files.

Tests: `npm run test:workspace-artifacts`. Each of the five build phases had an Opus medium review, and the blocking findings were fixed with behavioral tests.
