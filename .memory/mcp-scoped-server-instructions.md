# Scoped MCP server guidance — 2026-09-22

Baseline `origin/main` c8c09e0d2, branch `feature/mcp-scoped-server-instructions`, isolated worktree `mcp-server-instructions`. Green #214 and independent #226 are unchanged.

Capture SDK initialize instructions only with successful selected-server tool discovery inside configured identity admission. An immutable generation-owned record binds text to exact hashed server/tool names. After per-chat exclusions, Bot positive grants, runtime contributions and custom-model tool policy, append JSON-quoted external guidance for only records with a surviving tool. Text cannot grant tools, read resources, authorize writes, or override host/user/approval constraints. No new MCP method, polling or in-flight tool mutation.

Bounds: 8 KiB text/server, 16 captured servers, 256 bounded tool names/server, 32 KiB appended prompt budget. Empty/oversized/unusable/over-budget records are omitted whole. Instructions are best effort and follow the existing initialized-client lifetime; reconnect to receive changed initialize metadata. Same server display names cannot alias the generated dispatch identity. No transport URLs/headers/credentials enter records.

Onboarding's existing MCP tile now discloses service-provided tool guidance with unchanged art/layout. Internal main-process types only; inspected iOS/Android/protocol for consumers and found no shared wire or transcript change, so native suites are not applicable to this slice. Bot and scheduled permission suites cover unchanged authority paths.

Validation: MCP90, onboarding56, Bot447, scheduled151 passed. Full type-check, ESLint and whitespace checks passed after test-fixture fixes. New mcp-server-instructions.test.ts is registered in test:mcp. Both requested independent GPT-5.6 Sol medium reviews (blast radius; adversarial/edge cases) clear. Reviewers confirmed exact tool/server identity, final filtering, immutable lifetime, context budget and fail-closed bounds. Hosted checks and review remain PR follow-through gates.

Original scope remains partial: scoped MCP resource operations and trusted AGENTS loading/request-boundary prompt refresh remain concrete deliverables. Capability status is separate #226, skill policy #214, result spills another owner's work. This change claims no resource access, provider upgrade or native acceptance.
