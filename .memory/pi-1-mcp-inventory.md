# Pi 1.0 complete MCP inventory — 2026-10-02

Branch codex/pi-1-mcp-inventory, based on integrations53161ba13, reuses CLI worktree. Desktop foreground, child, Bot metadata and Settings status previously issued only one SDK listTools request. Shared listMcpToolInventory now follows opaque cursors with 64-page,512-tool,30-second total limits; duplicate names/cursor cycles/malformed pages/overflow fail closed. Each page checks current configuration/cancellation, with child credential revision checks before accepting it. No partial inventory escapes on later failure.

SDK listTools clears its internal output/task cache per page. createMcpToolCallGuard compiles full-inventory output schemas via the public SDK Ajv provider and rejects unsupported required tasks before request dispatch. Foreground plus child regular/raw call wrappers keep these independent contracts; private SDK state is untouched.

Provider-auth lane is parallel: its operation-scoped inspect(client,signal) must call the helper using combined operation/lease signal and owner/config freshness. Preserve scoped clients rather than restoring the old shared client during merge.

Validation Node22.22.3: MCP140, focused inventory/status/child28, CI policy/registry25, root types and touched ESLint. New helper tests registered in test:mcp and core-git CI lane. Existing child suite covers both dispatch paths. Desktop-only inventory/Settings metadata, no shared native protocol/transcript or new onboarding capability.
