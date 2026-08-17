# Pi Thinking Disclosure

Status: Complete

## Objective

Match Pi's provider-neutral thinking presentation in Aiden while preserving Aiden's
main-process privacy boundary. Every non-empty, non-redacted Pi `thinking` block
may be inspected in the transcript regardless of provider. Opaque signatures,
encrypted replay payloads, provider diagnostics, and subagent reasoning remain
private.

The interaction should make the capability discoverable without leaving a long
stream open: the first readable thinking content briefly previews for one second,
then collapses while generation continues. A user action always wins over that
automatic transition, and the completed disclosure remains available for later
inspection.

Local deployments also receive a persisted `Show reasoning` presentation toggle,
mirroring Pi's global hide/show setting without changing reasoning effort or the
private canonical Pi journal.

## Compatibility baseline

- Pi source: `/Users/sambitbiswas/projects/opp/pi`
- Audited Pi commit: `b1efcf7d7c5d7394fbb12ede0174e04d39ee7004`
- Aiden runtime dependency: `@earendil-works/pi-ai@0.80.10`
- Pi's canonical contract is ordered `ThinkingContent` plus
  `thinking_start` / `thinking_delta` / `thinking_end` events.
- Pi displays every non-empty normalized thinking block and allows the user to
  hide/show thinking globally. Provider capability metadata controls effort; it
  does not decide whether readable returned content is renderable.

## Invariants

1. Presentation is provider-neutral. No hosted provider allowlist may suppress a
   readable, non-redacted Pi thinking block.
2. Redacted thinking, signatures, encrypted payloads, diagnostics, and raw errors
   never cross renderer IPC.
3. Hiding local reasoning affects only visible projection. The complete canonical
   Pi message remains main-process/private for safe same-model continuation.
4. Reasoning timing remains available even when local text is hidden.
5. Subagent public events continue to omit reasoning text.
6. Automatic collapse never overrides explicit user expansion/collapse.
7. Existing Google, Anthropic, and Codex effort controls retain their current
   provider-specific semantics.

## Phase 1 — Shared policy and settings contract

- Replace the provider-ID visibility allowlist with a provider-neutral policy:
  hosted responses are displayable; local responses follow a persisted boolean
  preference that defaults to Pi-compatible visible.
- Add the local display preference to main/renderer settings types, IPC validation,
  tolerant persistence, and config tests.
- Keep effort selection separate from display visibility.
- Review gate: type-check, focused settings/runtime tests, privacy-path inspection.

## Phase 2 — Main-process projection parity

- Feed the resolved deployment and local visibility preference into generation.
- Continue projecting only readable, non-redacted Pi thinking text.
- Stream and terminal-reconcile readable thinking for Anthropic, Codex, OpenAI,
  Vertex, Bedrock, Mistral, gateways, and compatible providers exactly as Pi
  normalizes it.
- Preserve timing milestones and canonical private Pi storage.
- Review gate: provider/API-family projection tests, terminal-only response tests,
  redaction/signature privacy tests, retry/reset inspection.

## Phase 3 — Transcript interaction and local control

- Add a compact local-only `Show reasoning` switch beside model controls using
  Aiden semantic tokens and existing composer geometry.
- Update `ReasoningBlock` to preview the first readable stream for 1,000 ms, then
  collapse. Explicit interaction cancels the pending automatic collapse.
- Keep the disclosure keyboard accessible, bounded, scrollable, and available
  after completion/reload.
- Review gate: component/accessibility tests, reduced-motion and focus review,
  React-specific diagnostics.

## Phase 4 — Integration, documentation, and release gate

- Add an end-to-end contract matrix covering hosted display, local show/hide,
  redacted suppression, timing preservation, and durable/private separation.
- Register every new test in repository scripts.
- Update project memory and this plan's status.
- Run type-check, lint, focused suites, full repository tests, and Electron build.
- Review the final diff for Pi parity, privacy, cancellation, persistence, and UI
  completeness before publishing.
- Open a draft pull request, monitor GitHub Actions, fix actionable failures, and
  finish only when the PR is green and mergeable.

## Deliberate non-goals

- Exposing raw chain-of-thought a provider does not return.
- Rendering opaque/encrypted/redacted reasoning payloads.
- Exposing subagent reasoning.
- Replacing provider-specific reasoning-effort request semantics in this change.
- Persisting per-message disclosure open/closed state.

## Completion

Completed on 2026-08-17. Aiden now follows Pi's provider-neutral readable
thinking contract, keeps redacted and opaque reasoning private, gives local
deployments a durable presentation-only visibility switch, and briefly previews
new streaming reasoning before collapsing it without overriding user intent.

Release gates passed: focused settings/runtime/privacy/component tests, 181/181
compaction tests, 1,323/1,323 repository JavaScript tests, native worktree-remover
tests, 41/41 Rust broker tests with clippy, lint, type-check, React Doctor, and the
Electron production build.
