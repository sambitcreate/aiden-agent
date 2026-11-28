# Agent config write protection — 2026-10-31

Phase 0 of `docs/plans/aiden-hooks-plan.md` (§8.4).

`main/services/protected-agent-config-paths.ts` is the one shared rule.
`isProtectedAgentConfigPath` returns true when a protected directory is followed
by a protected child, at any depth: `.aiden/{hooks.json,hooks}`,
`.claude/{settings.json,settings.local.json,hooks,plugins}`,
`.codex/{config.toml,hooks.json,hooks}`, and `.git/{config,hooks}`, or when an
absolute path lies beneath a host-registered protected root (`<userData>/hooks/`,
`<agentDir>/hooks/`). Everything beneath those children is protected too. Before
matching, each segment is folded with NFKC, has default-ignorable code points
stripped and is lowercased. Raw `.` and `..` are resolved lexically. Callers
pass both the lexical/supplied path and the canonical absolute target, so a
symlinked file or folder, and a workspace opened inside `~/.claude`, are caught
too. Reads of project config files stay allowed, while `.git` entries of any
file type (including worktree/submodule `.git` pointer files and symlinks) are
omitted from `listWorkspaceFiles` and `native/worktree-file-io` `list_directory`
and rejected across `readWorkspaceFile`, `writeWorkspaceFileInstalling`, and
`editor_file`.

Call sites:
- `coding-tools.ts` `makeWriteFile`/`makeEditFile`: parent tools, and through
  them the Bot router.
- `subagents/subagent-workspace-write.ts` `beforeToolCall`: before approval,
  and again after `pinSubagentWorkspaceRoot`.
- `acp/client-files.ts` `writeClientTextFile`: before open, and again on the
  verified path.
- `aiden-remote-files.ts` `AidenRemoteFileService.write` and
  `aiden-remote-bot-files.ts` `AidenRemoteBotFileService.write`: validate both
  lexical `displayPath` and canonical target path before reserving save handles
  or writing bytes, failing closed with `403 capability_denied` and a path-free
  error envelope. Local desktop IPC editing (`main/handlers/workspaces.ts`
  `workspaces:writeFile`) remains unguarded for non-`.git` config files so the
  computer owner can still edit `.aiden/hooks.json` or `.claude/settings.json`
  by hand in the local Files panel.

Correction to the plan's premise: `SAFE_HIDDEN_DIRECTORY_NAMES` only governs
what subagents may read. The real gap was that parent `write_file`/`edit_file`
and remote `files:write` routes had no protected-path check.

Not covered:
- `run_command`, which the hook digest check handles.
- `.mcp.json`, `.vscode/tasks.json` and `.husky/`.
- Third-party MCP filesystem servers.
