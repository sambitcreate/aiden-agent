# Scoped MCP server instructions

Status: Implemented for review, 2026-09-22. Baseline origin/main `c8c09e0d2`. This is a separate slice from green skill-policy PR #214 and capability-status PR #226.

## Behavior and authority

Capture the MCP SDK's initialize instructions only alongside successful tool discovery for the selected, enabled, current configured server. Store the exact generated tool names and bounded text in a generation-owned immutable snapshot. After per-chat exclusions, Bot positive grants, runtime composition and custom-model tool policy, include only records that intersect the final tool set. Expose only the surviving tool names in the guidance record.

Guidance is JSON-quoted external service data, explicitly subordinate to host/user instructions, approvals and access limits. It cannot enable a tool, connect another server, read resources, widen a scheduled task, or alter a Bot grant. No URI/resource mechanism is introduced. MCP tools continue through existing configured-server identity/fingerprint and Bot/scheduled admission paths. Direct child/subagent MCP is unchanged and does not consume this parent-generation guidance.

Text is bounded to 8 KiB per server and 32 KiB for the complete appended prompt section; capture holds at most 16 server records, each with at most 256 bounded tool identities. Empty, oversized, unusable or over-budget records are omitted whole rather than truncated. Guidance is best effort and cannot prevent tool use. No endpoints, transport options, headers or credentials are added to prompt records.

Existing in-flight tools and guidance stay captured. New generations reconstruct their guidance from admitted clients; MCP initialize instructions change when the client reconnects, not via a new background refresh. No live tool mutation, network polling, or new MCP request is added to fetch instructions.

The existing MCP onboarding tile explains that connected services may provide tool guidance, using its current optimized artwork, layout and interaction behavior.

## Validation boundary

Registered `test:mcp` exercises actual SDK initialize instructions, same-label/different-ID isolation, selected-server routing, final positive tool intersection, custom-model tool opt-out, immutable/cross-generation snapshots, UTF-8/aggregate bounds, delimiter/control escaping and production wiring. Existing Bot/scheduled suites validate retained authority paths. No shared REST/SSE or native-client DTO, transcript/activity layout, or provider dependency changes; native consumer inspection confirms this is main-process prompt assembly only.

## Remaining original scope

Scoped MCP resource list/template/read operations and a trusted AGENTS loader with model-request-boundary prompt refresh remain concrete deliverables. They are not implemented or externally blocked by this slice. Capability metadata status is PR #226; model/user skill policy is PR #214. Lazy skill model-context loading and between-generation tool reconstruction already exist. In-place active-tool mutation, MCP spill storage (separate owner), and provider upgrades remain excluded.
