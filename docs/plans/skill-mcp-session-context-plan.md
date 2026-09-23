# Skill and MCP session context

Status: Partial — invocation-policy slice implemented in PR #214, with hosted CI and review passed on implementation head 5ab368c1. Physical iOS execution remains blocked by a locked device; broader MCP scope remains deferred.

## Bounded implementation

Honor `disable-model-invocation` and `user-invocable` boolean SKILL.md frontmatter as independent positive `modelInvocable` / `userInvocable` policies. Omitted legacy metadata allows both. Malformed values reject that file without expanding YAML aliases. Configured skills retain existing behavior.

- Model tools, model skill summaries and Pi resources exclude model-disabled skills; direct skill tool execution checks the same policy.
- Desktop and Telegram user catalogs exclude user-disabled skills; fresh resolution and formatting reject forged or stale selections.
- Registry fingerprints include both flags. The existing single winner across source/name/tool collisions remains authoritative: disabling a winner never reveals a shadowed skill.
- Bot automatic bindings project model eligibility through the existing `available` field. Eligible skills precede unavailable entries at the inventory bound; unavailable saved selections remain representable where capacity permits.
- Bodies remain absent from initial model summaries and tool schemas; invocation returns the captured body. Disk discovery still reads bounded bodies to validate content and establish fingerprints. This is lazy model-context loading, not lazy filesystem loading.
- Global Skills opt-out, per-chat disabled tool selection, workspace access boundaries, and immutable in-flight tool snapshots remain unchanged. Policy edits apply to refreshed snapshots and expire old user selection IDs.
- Onboarding reuses the existing Skills tile and illustration, with copy explaining invocation options.

## Deferred scope

MCP advertised capabilities in status, scoped resources, server instructions, and model-request-boundary global instruction/tool refresh are not implemented by this slice. They need explicit scope/provenance, refresh timing and stale-client/lease tests before extending the generation boundary. MCP result spill storage belongs to the deliverables lane. Provider dependency upgrades are excluded.

## Evidence

Research: Notion DeepSeek→Aiden page `3d980314a1c4814eb829c8afb8edbb79`, September 11 digest `3d880314a1c481c8bd12fba17c339ade`, September 15 digest `3dc80314a1c48122bf00c0c28eefb4d8`. These are dated recommendations, checked against Aiden `c8c09e0d2` and current primary DeepSeek skill subsystem/source documentation. No source copied.

Validation and review details: `.memory/skill-invocation-policy.md`.
