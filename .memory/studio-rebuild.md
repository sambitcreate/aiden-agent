# Design Studio + Create Images rebuild (started 2026-10-07)

Plan: `docs/plans/design-studio-create-images-rebuild-plan.md` (umbrella/orchestration plan).

## History

Two earlier implementations were closed unmerged as stale on 2026-09-29:

- **Design Studio:** PR #85, `feature/stitch-design-studio` @ `577d17af`.
- **Create Images:** PR #37, `feature/create-images-node-banana-parity` @ `1e3b3909`.

Both forked from `c8c09e0d` and were 722 commits behind `main` (`bd232b85`) when the rebuild started.

## Decision: fresh branches from main, port selectively; never merge

The reasons, from read-only audits on 2026-10-07:

- **Design Studio**
  - It is grafted onto ChatPane through `presentation="design"`.
  - `design-workspace.tsx` is 4,761 lines.
  - It relies on Pi's `shouldStopAfterTurn`, which Pi 1.x removed. Use `finishTurn → {action:"end"}` instead.
  - About 660 of its test assertions are source-grep checks.
  - Its sentinel workspace ID `"design-projects"` leaks exclusions into Remote and core modules.
  - It has about 72 IPC channels.
  - A project inherits the per-chat 40-artifact / 8 MiB generative-UI quota.
- **Create Images**
  - It never produced a real Gemini image.
  - It changes the app-wide CSP and adds a global `webRequest` egress guard, both ungated.
  - It calls `registerSchemesAsPrivileged` twice.
  - Every journal append re-parses and re-hashes the whole journal, so appends are quadratic: 114 s for 500 nodes.
  - About 580 of its test assertions are source-grep checks.
  - It hand-rolls a Gemini client even though Pi's `generateImages` exists on main.

## Owner decisions (2026-10-07)

- Use Pi image models for Create Images.
- Fold Designer Mode into Design Studio as DS-4 "Connected app". `designer-mode-plan.md` is marked superseded.
- Land a Studio Foundation PR first. Then the DS and CI tracks run in parallel worktrees.

## Worktrees (under `.claude/worktrees/`)

- `ref-design-studio` and `ref-create-images`: detached, **read-only** port sources at the old tips.
- `design-studio-image-gen-upgrade-74e137`: orchestration (plans and ADRs).
- Track worktrees `studio-foundation`, `design-studio-v2` and `create-images-v2` are created per phase.
