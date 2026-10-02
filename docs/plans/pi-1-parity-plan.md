# Pi 1.0 parity upgrade

Status: implementation active; runtime and CLI 1.0 foundation is implemented in PR #299, with the remaining feature lanes in progress (2026-10-02).

## Baseline and target

Aiden origin/main: `d2197dfef` (0.51.0). Pi checkout `/Users/sambitbiswas/projects/opp/pi` was fast-forwarded to `581e7ba78`. Published target: exact **1.0.0**, release tag `v1.0.0` / `a13d35a742`. Changes in upstream `Unreleased` are tracked separately, not silently shipped as 1.0. Release: https://github.com/earendil-works/pi/releases/tag/v1.0.0.

The audit covers the delta from Aiden's 0.87.1 pins and the complete stable coding-agent surface. Pi's durable, client/server/protocol and virtual-model APIs are explicitly experimental. Aiden's existing remote protocol, native clients, security policy, journals, and subagent supervision stay authoritative. Matching a feature means delivering its user capability with Aiden's permissions, not replacing a stronger existing implementation.

## Feature and integration inventory

| Surface | Existing Aiden | Pi 1.0 requirement / implementation |
| --- | --- | --- |
| Agent loop and provider transport | Core/AI 0.87.1 | Exact 1.0.0 pins; request hooks, requested thinking levels, provider fixes; serialize and replay offline |
| Sessions, history, branches, compaction | Aiden runtime + Pi experimental v4 journal helpers | Core 1.0 deleted these APIs. Isolate frozen 0.87.1 helper alias behind compatibility adapters, keep live Agent/Models on 1.0, preserve journals and existing replay/rollback gates. Experimental pi-durable migration is separate, not required for stable feature parity |
| Provider model catalogs | Chat-only bundled and optional live catalogs | Update release catalog from installed pi; reject/filter image/classifier records from chat inventory, preserve manual-only models.dev/benchmark policy |
| Sign in with ChatGPT | Existing legacy Codex OAuth | Supply stable device identity for new OpenAI provider login; keep Codex accounts working; expose new login through existing provider UI/onboarding discovery |
| Anthropic sign-in | Existing interactive OAuth | Support 1.0 browser/copy-code interaction and revised branding; test callback paths |
| CLI TUI / settings / input / session exports | Rebranded coding-agent 0.87.1, fullscreen already default | Inherit stable 1.0 TUI, header-only quiet startup, palette/input/history/export fixes, preserve Aiden generated themes/config layout |
| CLI extensions / provider hooks | Aiden built-in extensions, worker loaders | Update 1.0 context types and packaging, preserve capability tiers and disabled worker builtins |
| Codemode / nested tool calls / tool search | No desktop codemode; CLI inherits after bump | Package native CLI worker and helpers, exercise real offline nested calls with permission gates. Desktop adoption must route nested execution through current approval/tool lifecycle, preserve transcript and native consumers |
| Images / classifiers | Existing Aiden image/vision surfaces | CLI inherits unified model API and codemode generation/classification. Desktop inventory remains type-aware; expose tools only through approved credential/runtime paths with usage accounting |
| MCP config / transport / resources | Aiden server IDs, encrypted credentials, scoped resources/instructions | CLI legacy array collides with Pi native object mcp.json: migrate Aiden config safely to own file, preserve native config and separate explicit admin commands. Native MCP remains user configured |
| MCP OAuth | Aiden server-scoped OAuth | Bind callback state and issuer, metadata override and scope preservation where supported; test auth failure before token exchange and independent server identities |
| Skills / templates / AGENTS / plugins | Aiden trust, skill discovery, refresh, slash invocation | Preserve existing host semantics; CLI inherits native plugin/resource features without widening worker permissions |
| Queue / steering / abort / subagents | Existing desktop/CLI/remote implementations | Preserve behavior through 1.0 replay, cancellation and subagent regression gates |
| Onboarding / desktop / iOS / Android | Existing data-driven tour and native protocol | Update only for capabilities actually shipped; inspect native consumers and run mobile suites for any shared contract/transcript changes |
| Experimental durable / remote / virtual models | Aiden equivalent or no production consumer | Explicitly excluded from automatic replacement; record API status and follow-up acceptance criteria |
| Post-release HEAD features | Unreleased OAuth copy shortcut/CIMD/Clef/installer changes | Audit only; no unpublished pin or generated catalog import |

## Execution and PR boundaries (maximum three task worktrees)

1. **Runtime foundation PR** — worktree A (coordinator current checkout for plan initially; runtime implementation worktree B): exact core/AI pins, named legacy helper boundary, lockfile, compatible model catalog and branding, replay/compaction/session/provider/subagent tests. No journal format rewrite. PR must clearly name remaining compatibility debt.
2. **CLI parity PR** — worktree C: exact coding-agent/chord 1.0, generated bundle chunks and codemode worker, MCP config migration/coexistence and command routing, TUI/branding, real nested-call permission tests. Stack on runtime foundation once ready so both pin lines match.
3. **Provider and MCP integration PR** — worktree A: new OpenAI login identity and focused MCP OAuth parity/hardening. Independent agents own disjoint files. Stack on runtime foundation if new interfaces require it.
4. **Desktop stable capability parity** — reuse the same three worktrees after earlier work is committed; implement missing codemode/tool discovery/image/classifier surfaces with Aiden permission/transcript/usage integration, updating onboarding and both native clients when shared behavior changes. Keep these acceptance items open until implemented and tested; do not label a dependency upgrade full desktop parity.

Agents audit first, then implement their assigned lane in different worktrees. No fourth task worktree. Existing unrelated worktrees are untouched. Shared PR branches merge origin/main; no rebases/force pushes. Every created PR is attached to this task.

## Validation and completion criteria

- Reproducible root and standalone CLI lockfiles, exact pins, root and CLI TypeScript, focused behavior suites, relevant lint and build checks.
- Existing seven upgrade replay cases, session v3/v4 migrations and retained rollback backups, compaction/VCC, provider serialization, MCP and full subagent suites.
- CLI production bundle starts offline and exercises codemode worker, deferred/nested tool execution and denied capability tiers; MCP migration never drops, overwrites or leaks existing config/credentials.
- OAuth tests use fake local callbacks/tokens, verify stable private identity, state/issuer rejection and cancellation without network/provider credentials.
- Mobile suites mandatory for shared remote/transcript changes; no claim of physical-device or signed-package validation without running it.
- Plan stays active while any stable desktop capability acceptance is missing. Archive only after all required implementation and validation finish. PR descriptions report exact local results, remaining gaps and any CI failures; do not merge unless separately requested.

## Progress

- [x] Pull Aiden origin/main and pi checkout; parallel runtime, CLI, stable-feature audits.
- [x] Record target, feature inventory, architecture decisions and three-worktree PR plan before edits.
- [x] Runtime foundation and replay gates — implemented in PR #299.
- [x] CLI stable 1.0 parity and offline bundle/permission gates — included atomically in PR #299.
- [ ] Provider/MCP integration and focused tests.
- [ ] Desktop codemode/tool search/image/classifier capability acceptance.
- [ ] Integrated validation, reviewable PRs and final status reconciliation.
