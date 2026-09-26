# MCP advertised status — 2026-09-22

Baseline origin/main `c8c09e0d2`. Separate worktree/branch `feature/mcp-advertised-status`; green skill-policy PR #214 remains untouched.

`mcp:status` now projects the initialized SDK capability snapshot, including extension maps, independently of tool discovery. Tools/list failure preserves metadata with the existing connected:false/error result. Resources/prompts-only servers avoid unsupported tools/list. Connection/initialization failure and superseded attempts return null metadata through the existing manager failure path. Capabilities are cloned per client and are diagnostic only: no resource, server-instruction, tool-selection or prompt authority is granted.

Shared TypeScript status definition is desktop-only. Confirmed no McpStatus/mcp:status consumer in protocol, iOS or Android; native suites not applicable to this slice. No first-run or core runtime capability change, so onboarding/gallery remain unchanged. SDK/dependencies unchanged.

Validation: registered `test:mcp` includes six new status tests; 88 total pass. Real in-memory SDK servers cover success, discovery failure, opaque extension metadata, empty/resource-only capability sets and independent clients. Controlled barriers cover document/connection revocation and generation-bound replacement. Full type-check, ESLint and whitespace checks pass. Independent GPT-5.6 Sol medium blast-radius/adversarial reviews requested.

Original assignment completion remains partial: docs/plans/mcp-session-context-audit.md classifies every item. Resources, scoped server instructions and per-model-request AGENTS refresh are concrete remaining deliverables, not external blockers. Pi compaction owner confirms no live AGENTS/MCP hook overlap. No native test blocker is claimed for this desktop-only diagnostic slice; the prior #214 physical iOS lock remains that slice's limitation.
