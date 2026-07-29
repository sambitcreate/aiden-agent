# Aiden-Native Subagents

Status: Complete. All five delivery phases are implemented and passed their final gates.

Spec date: 2026-07-27.

## Goal

Add safe, inspectable foreground delegation to Aiden by creating fresh embedded Pi
`Agent` children inside Electron main. Do not install or embed the `pi-subagents`
CLI/TUI extension.

## Fixed V1 boundaries

- The model-facing tool accepts one to four `scout`, `planner`, or `reviewer` tasks.
- Children inherit the persisted parent workspace and resolved provider/model.
- Children receive only `read_file`, `list_dir`, `glob`, and `grep`.
- Children cannot write, run commands, use Computer Use, schedule, call MCP/web,
  load skills, or create more subagents.
- Runs are foreground-only, fresh-context, bounded, revisioned, and cancelled with
  the parent tree.
- Renderer state is owner-bound and sanitized. It never includes credentials,
  hidden prompts/reasoning, raw tool payloads, commands, absolute paths,
  environment values, or Pi artifact/session paths.
- The feature shipped behind `AIDEN_SUBAGENTS_ENABLED=1` through internal soak
  and is enabled by default after the completed Phase 5 gate.

## Delivery phases

| Phase                                    | State       | Gate                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Integration and compatibility         | Complete    | Embedded Agents share Aiden's resolved transport, keep generated unique sessions, enforce hosted concurrency two and local concurrency one, cancel queued and active work, clean up on shutdown, and register no tool while disabled. Two fresh reviewers returned clean verdicts after the final correction cycle.                |
| 1. Fail-closed capabilities              | Complete    | Positive read/search allowlist with strict profile intersection, credential-safe bounded tools, cancellation and race hardening, deterministic caps, and parent-tool compatibility. The final requested review findings were fixed and the focused gate passed.                                                                    |
| 2. Supervisor and tool                   | Complete    | Bounded supervisor, child runner, roles, atomic budgets, ordering, cancellation, usage attribution, strict foreground authority, shared privacy sanitization, and parent synthesis contract. Two fresh post-fix reviewers returned clean verdicts.                                                                                 |
| 3. State, persistence, IPC, cancellation | Complete    | Versioned safe snapshots, atomic private store, owner-bound IPC, restart reconciliation, full tree cancellation, crash-safe managed-worktree cleanup, native capture hardening, and fail-closed deletion tombstones. The user advanced after the corrected focused gates passed and explicitly waived the final fresh review pair. |
| 4. Inspector UI                          | Complete    | Accessible chips and one responsive Subagents destination in the existing right work surface. The user explicitly accepted the single-user build without further local-at-rest redaction hardening; non-privacy FIFO cleanup availability protection remains covered. |
| 5. Verification and rollout              | Complete    | Focused regressions, strict package verification, privacy-safe aggregate metrics, a 3-cycle smoke, and the default 100-cycle packaged lifecycle soak passed. Two fresh final reviewers found the receipt/lifecycle and per-cycle artifact gates clean. |

Each phase is blocked on two fresh-context adversarial reviews. Any validated
blocking issue is fixed and reviewed by two new reviewers before the next phase
starts.

Phase 4 exception: on 2026-07-28, the user explicitly directed the project to
advance to Phase 5 for this single-user app rather than extend the local-at-rest
redaction review loop. This is a scope decision, not evidence that the deferred
hardening is unnecessary for a multi-user or shared-device release.

## Completion evidence

- The package is verified with the release verifier before soak execution and
  again before every launched cycle, binding the fully verified payload to the
  originally staged artifact.
- The fixed packaged lifecycle drives Send, Stop, Settings navigation, and
  normal quit. Receipt publication is staged and revocable, so a timed-out
  finalization cannot later publish accepted clean evidence; failed packaged
  finalization exits nonzero before unrelated cleanup.
- Focused contracts, the aggregate Subagents suite, type-check, lint, strict
  package verification, a 3-cycle smoke, and the default 100-cycle packaged
  soak all passed. Two fresh final adversarial reviewers returned clean verdicts.
- Native subagents are enabled by default after that gate. Setting
  `AIDEN_SUBAGENTS_ENABLED=0` remains an emergency rollback switch that removes
  both the model-facing tool and renderer capability.

## Integration base decision

The user selected `feature/aiden-assistant-plan-777723` in the existing isolated
worktree `.claude/worktrees/aiden-assistant-plan-777723`. It was clean and exactly
matched its upstream when this implementation began, while the canonical checkout
and the other registered worktree were preserved unchanged. This assistant feature
branch intentionally remains the integration base; no Pi dependency upgrade or
nested worktree was introduced.

## Deliberately deferred

Background work, restart resume, nesting, writer agents, shell/MCP/web/skills/
Computer Use/scheduling, child steering/retry/stop UI, child approvals, worktree
creation, model overrides, raw artifact browsing, Fleet TUI, and parent/child
turn-by-turn transcript interleaving.
