# Scoped MCP resources

Status: Implemented for PR review; local validation and both independent Sol reviews clear.

Separate branch from origin/main; PR214/226/229 remain untouched. No SDK/dependency or MCP tool-result spill changes.

Expose one resource list/read tool per selected, enabled server advertising resources. Tool identity uses a separate hash domain from remote tools, so Bot exact remote-tool grants cannot admit resource operations. Bot resource grants/catalog support remain absent; no implicit Full or Custom Bot widening. Scheduled and assistant generations retain existing exact selected-server/binding gates. Subagent capability construction remains separate.

The first explicit list captures a generation-owned inventory of static resources and templates, traversing at most four pages per endpoint and 128 total records. Each entry receives a random handle scoped to its closure. Reads accept only those handles; templates accept only plain {name} expressions with ASCII identifier names, require exactly their declared string variables, and expand with strict percent encoding. Unsupported operators/modifiers are rejected during discovery before handles publish. No arbitrary URI/network dispatcher exists. Response URI metadata is bounded and remains data; only listed handles authorize dispatch. Binary content is reported as unsupported, and text/list JSON is capped at 32,000 UTF-8 bytes. Over-limit inventories fail closed, never silently claim completeness. Missing optional discovery methods yield empty lists only for typed MCP MethodNotFound; other errors propagate.

Configuration leases and abort checks fence requests and discard late responses. The immutable inventory is not refreshed in flight; another generation obtains a new one. No notifications, subscriptions or automatic resource reads are added.

Validation: real SDK resource-only server integration; pagination, templates, cross-server/generation handles, remote identity separation, mutable remote metadata, revocation/cancellation, oversized responses and derived-response URI non-dispatch tests. Run MCP, Bots, scheduled, onboarding, type/lint; both independent Sol reviews. Onboarding reuses the existing MCP tile/artwork with resource disclosure. Generic text tool results use existing desktop/native activity representation; no shared remote DTO or transcript changes.

Integration: PR229 renames agentToolsFor to agentContextFor; when both land, resource tools must be included in the final returned tool list before scoped instruction intersection. PR226 status metadata is independent. Broader trusted AGENTS request-boundary refresh remains outstanding.

Local validation: MCP93, Bots448, scheduled151, onboarding56 pass; type-check, ESLint and whitespace checks pass. Review fixes cover retry after concurrent discovery cancellation, repeated RFC6570 variables, and legal derived/multiple content URIs without granting follow-up authority. Native consumers inspected: iOS AidenChat uses generic tool labels/status fallback, Android AidenChatViewModel uses the same label projection; no contract or UI behavior changed, so native suite reruns are not required. Physical iOS remains untouched.

## SDK template authority correction
Pullfrog identified that pinned SDK1.30.0 concatenates multi-variable expressions without percent-encoding their values. These expressions now fail closed before expansion/readResource dispatch, across all operators. Single-variable expressions retain exact-variable and UTF-8 length gates and encoded-value behavior. MCP95 includes the reported authority escape plus all-operator no-dispatch and single-variable encoding controls. No SDK/dependency change; both reviews and latest-head CI remain required.

## Constrained template syntax correction
A follow-up review found SDK1.30 also misinterprets single-variable operators/modifiers. Discovery now rejects every form except plain {name} expressions with ASCII identifier names, before any inventory handles are published. Operators, prefix/explode modifiers, comma-separated names, dotted/percent-encoded names and malformed braces fail closed. Accepted plain scalar values use strict RFC6570 percent encoding (including !'()*), without SDK expansion. Repeated separate expressions still work. An unsupported template makes that inventory fail closed; no partial inventory is presented as complete. MCP97 covers the requested single-variable forms, unpublished-handle denial and Unicode/reserved encoding.
