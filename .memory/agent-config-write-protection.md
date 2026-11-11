# Agent config write protection — 2026-10-31

Phase 0 of `docs/plans/aiden-hooks-plan.md` (§8.4).

`main/services/protected-agent-config-paths.ts` is the one shared rule.
`isProtectedAgentConfigPath` returns true when a protected directory is followed
by a protected child, at any depth: `.aiden/{hooks.json,hooks}`,
`.claude/{settings.json,settings.local.json,hooks,plugins}` and
`.codex/{config.toml,hooks.json,hooks}`. Everything beneath those children is
protected too. Before matching, each segment is folded with NFKC, has
default-ignorable code points stripped and is lowercased. Raw `.` and `..` are
resolved lexically. Callers pass both the model-supplied path and the canonical
absolute target, so a symlinked folder, and a workspace opened inside
`~/.claude`, are caught too. Reads are never fenced.

Call sites:
- `coding-tools.ts` `makeWriteFile`/`makeEditFile`: parent tools, and through
  them the Bot router.
- `subagents/subagent-workspace-write.ts` `beforeToolCall`: before approval,
  and again after `pinSubagentWorkspaceRoot`.
- `acp/client-files.ts` `writeClientTextFile`: before open, and again on the
  verified path.

Correction to the plan's premise: `SAFE_HIDDEN_DIRECTORY_NAMES` only governs
what subagents may read. The real gap was that parent `write_file`/`edit_file`
had no protected-path check at all.

Not covered:
- `run_command`, which the hook digest check handles.
- `.git/hooks`, `.git/config`, `.mcp.json`, `.vscode/tasks.json` and `.husky/`.
- Third-party MCP filesystem servers.
- Aiden's future `<userData>` hooks profile store, which should join the Bot
  protected roots when it lands.
