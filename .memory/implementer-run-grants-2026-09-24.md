# Implementer subagent and run grants

Started 2026-09-24 from freshly fetched `origin/main` in the
`feature/implementer-run-grants` worktree. The user-provided P0 policy makes
`implementer` a coding role on the existing host-managed Pi child runtime.

- Task omission uses role defaults: implementer requests read/write/shell,
  read roles stay read-only when the batch root is omitted, and web/MCP/delegation
  default off. An explicit root retains legacy behavior for existing read roles;
  an inferred mixed root pins their omitted tasks to read-only. Explicit roots
  narrow implementer defaults. Flags and parent authority intersect again at
  mint. No child runtime dependency was added.
- The Mac-owned in-memory write and shell grants are separate per run. Full is
  implicit only within effective Full permission; Ask prompts once on first
  use per lane. Grants bind the authority digest (including run, workspace and
  authority revision), are invalid after stop/revoke/drift, and are never
  persisted as project-wide permission. Existing exact-call preparation,
  journals, preimage/root checks, and terminal handling remain on every call.
- A new renderer card states whole-run scope; remote projection treats it as
  host-only. The public implementer role is decoded by both native clients.
- The existing onboarding Subagents tile now describes coding and permission
  behavior; its existing dedicated illustration remains the tile asset.
- Per-task child model override, worktree collision warning, and continuation
  are deferred to P1 in the active subagent expansion plan. Children continue
  inheriting the parent runtime at launch.
- Validation: TypeScript type check, ESLint, aggregate subagent suite, aggregate
  remote suite, onboarding suite, Android focused unit tests, and iOS generic
  device build-for-testing passed. Physical iPhone test execution was attempted
  but the device was locked, so tests could not start on that device.
