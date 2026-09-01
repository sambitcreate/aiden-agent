# Pi Compaction and Durable Memory Upgrade

Status: Active. Phases 0–7 are implemented; installed/signed and credentialed operator acceptance remains Pending.

## Outcome

Aiden will have one main-owned context lifecycle for ordinary workspace chats, canonical Bot chats, Telegram-originated turns, Telegram manual compaction, and child agents:

1. the complete transcript remains the recoverable source of truth;
2. current-turn pressure is measured before every provider call, including the new user message, static prompt, tools, images, and tool results;
3. Pi semantic compaction handles compressible history and produces durable checkpoints;
4. deterministic request trimming remains only an emergency projection for irreducible single-turn/static-context pressure;
5. every surface uses the authoritative chat's saved provider, model, context window, turn admission, and cancellation boundary;
6. durable memory is a separate, scoped, approval-controlled store, not compaction prose promoted into standing instructions.

This is a follow-on to [Compaction](compaction-plan.md), [Pi-native Compaction](completed/pi-native-compaction-plan.md), and [Pi Compaction Compatibility](completed/compaction-reliability-plan.md). Those plans accurately describe their shipped increments, but they do not close the current-turn, cross-surface, Pi session-format, or durable-memory work below.

## Decision summary

- Fix the known correctness gaps on the pinned Pi `0.80.10` boundary before changing the session format.
- Then upgrade `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` together to an exact audited Pi release through an explicit journal migration.
- Target current Pi `0.84.4` for the initial spike, but re-resolve the latest release and re-audit its changelog immediately before implementation.
- Adopt Pi's self-contained retained-tail checkpoints and v4 session repository, but do not replace Aiden's runtime with Pi's public `AgentHarness` yet. At `0.84.4`, that harness is still a compile-complete scaffold whose prompt, compact, resume, queue, abort, and watch paths reject with `HarnessNotImplemented`.
- Keep Bot collaboration (`message_agent`, rooms, routines) as a separate delivery track. It may consume the canonical chat, compaction, and memory contracts after they ship, but it must not widen this migration.

## Current source findings

### What already works

- Ordinary desktop chats and Bot chats both enter the same `llm-client` and `PiAgentRuntimeHarness`; Bot identity changes prompt/authority preparation, not the transcript or compaction engine.
- Telegram-originated turns call the same `llm-client`, so their normal automatic compaction is not a second agent runtime.
- Pi journals are private, append-only, chat-scoped, crash-reconciled, and removed with chat deletion.
- Post-response threshold compaction, one overflow compact-and-retry, cancellation, provider-failure classification, child-loop compaction, and summary usage accounting are implemented.
- Mac already converges Bot open/create onto one canonical writable chat. Legacy duplicates remain readable and non-canonical writes are rejected. The Hermes note's first suggested Bot slice is therefore already shipped and is not part of this plan.
- Telegram already exposes a confirmed `/compact` action.

### Confirmed gaps

1. **The top-level current prompt misses semantic preflight.** `runManaged()` repairs the previous tail before it appends the new user input. `checkContextPressure()` runs only before another assistant turn inside an existing tool loop. A large new user message can therefore reach the emergency request transform before Pi gets a semantic-compaction opportunity.
2. **Pressure accounting can reuse stale assistant usage.** The preflight path prefers the previous assistant's provider usage and does not add the new user/tool tail or Aiden's static prompt/tool schemas. It deliberately refuses to compact when no valid usage anchor exists. This makes first-turn, restored-history, large-attachment, and newly enlarged tool-inventory behavior incomplete.
3. **Emergency projection and durable checkpoints can diverge.** `generation-context.ts` may truncate tool results or remove history for one outbound request, but the runtime only logs that event. A regression explicitly requires a large tool result not to force a checkpoint. This contradicts the older completion prose claiming every emergency reduction forces a durable semantic checkpoint.
4. **Telegram manual compaction is outside normal admission.** The current helper opens/synchronizes the journal directly, does not acquire the chat turn/busy gate, and resolves the Telegram profile default provider/model. For a Telegram-bound Bot, that can race another surface and compact with a different model or context window than the canonical Bot chat's saved selection.
5. **Child first-turn pressure is incomplete.** Child agents use the shared coordinator after tool turns and responses, but their initial in-memory fork is sent to the provider without an equivalent semantic preflight. An oversized fork relies on emergency projection or provider overflow.
6. **The dependency and journal are four breaking releases behind.** Aiden pins Pi `0.80.10`. Pi `0.81.0` replaced retained-boundary IDs with self-contained `retainedTail` checkpoints and added summary usage; `0.84.0` replaced the legacy session API with a lane-based v4 journal and durable operation records.
7. **Coverage does not prove the surface matrix.** Core compaction coverage is broad, but there is no focused `telegram-session` test file for bound-Bot provider selection/admission, and the existing preflight tests encode the zero-usage no-op rather than the desired current-context projection.

## Latest Pi baseline

Research sources:

- [npm package: `@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
- [Pi agent-core changelog at `v0.84.4`](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/CHANGELOG.md)
- [Pi `v0.84.4` compaction implementation](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/harness/compaction/compaction.ts)
- [Pi `v0.84.4` session contracts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/harness/session/types.ts)
- [Pi `v0.84.4` public harness scaffold](https://github.com/earendil-works/pi/blob/v0.84.4/packages/agent/src/harness/agent-harness.ts)

The relevant changes from Aiden's `0.80.10` baseline are:

| Pi release | Relevant change | Aiden consequence |
| --- | --- | --- |
| `0.81.0` | Compaction entries store `retainedTail` directly and include summary usage. | Old `firstKeptEntryId` journals need a materializing migration; usage accounting can stop inferring hidden summary cost. |
| `0.81.1`–`0.82.0` | Compaction gained retry/lifecycle support and isolated routing identities with prompt caching disabled. | Replace Aiden's proxy retry wrapper with the audited Pi retry API after parity fixtures pass. |
| `0.84.0` | v4 lane-based sessions, durable operation records, bounded branch queries, and atomic JSONL publication. | Introduce a session port and a one-time migration; do not change the package underneath existing journals. |
| `0.84.4` | `prepareNextTurn*` runs only when another assistant turn will actually start. | Move end-of-run work to `agent_end`; retain between-tool pressure checks only on true continuations. |

## Reference extension/plugin audit rule

Before implementing any phase, re-check the latest default branch/release of every reference that overlaps the files or behavior being changed. Record the resolved commit/tag, inspected files, applicable ideas, rejected ideas, and compatibility decision in that phase's implementation notes. A previous clone or plan summary is not current evidence.

The standing reference inventory is:

| Reference | Re-check when changing | Current relevance to this plan |
| --- | --- | --- |
| [`mksglu/context-mode`](https://github.com/mksglu/context-mode) | context projection, tool-output shaping, session recall, compaction hooks | Direct. Compare sandboxed bulk results, FTS5/BM25 on-demand recall, clean-session semantics, purge/diagnostics, and pre-compaction capture. Keep these main-owned rather than adding a parallel MCP authority path. |
| [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) | child context, artifacts, truncation, session sharing, background lifecycle | Direct. Compare initial-fork shaping, bounded artifacts, child/parent continuity, and observability while preserving Aiden's existing immutable authority ceilings. |
| [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono) | any installed `rpiv-*` integration or shared Pi hook/runtime change | Compatibility. Re-run the affected Aiden integration contracts whenever the Pi runtime/session surface changes. |
| [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access) | web-result persistence, citations, or context shaping | Conditional. Compare bounded extracted content and durable source references if web output enters memory or compaction fixtures. |
| [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) | MCP lifecycle, result shaping, schemas, or session sharing | Direct for tool bulk. Compare compact result rendering and explicit unsupported-content failures; do not create a second MCP server/session owner. |
| [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail) | autonomous simplification or code-change minimization | Conditional. Use only as a workflow/simplicity reference, never as memory authority. |
| [`@gotgenes/pi-permission-system`](https://pi.dev/packages/@gotgenes/pi-permission-system) | approvals, memory writes, child asks, external paths, or capability policy | Direct. Compare deterministic allow/ask/deny, fail-closed gates, bounded approval presentation, and child-to-owner forwarding. Do not assume its still-open durable-approval semantics are settled. |
| [`MattDevy/pi-extensions`](https://github.com/MattDevy/pi-extensions) and [`pi-simplify`](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify) | learning/memory suggestions, review, or simplification | Direct for `pi-continuous-learning` confidence/feedback ideas; `pi-simplify` itself is code-review workflow, not context compaction, so it is only a delivery-quality reference here. |
| [`narumiruna/pi-extensions`](https://github.com/narumiruna/pi-extensions) | provider-native compaction, side-context, or Pi extension compatibility | Direct. Compare `pi-codex-compact`'s bounded opaque checkpoint plus Pi-native fallback before Phase 7 provider-native work. |
| [`injaneity/pi-computer-use`](https://github.com/injaneity/pi-computer-use) | screenshot/image history, computer-use tool output, or resumed visual turns | Conditional. Compare media/result bounding when extending the image-heavy replay matrix. |

Research from these repositories informs contracts and tests; it does not authorize installing, vendoring, or exposing a third-party extension in Aiden. Aiden keeps its existing main-process authority, encrypted credentials, workspace fences, and private journal ownership.

## Architecture boundary

```text
ChatStore visible transcript
          |
          v
main-owned ContextLifecycleService
  - exact chat / Bot / Telegram admission
  - authoritative provider + model + limits
  - projected next-request budget
  - manual and automatic compaction
          |
          v
PiSessionPort
  - legacy 0.80 reader during migration
  - v4 session / lane repository after promotion
  - checkpoint projection and rollback
          |
          +---------------------> provider request projection
          |
          +---------------------> scoped MemoryService (separate store)
```

`ContextLifecycleService` is the only surface allowed to compact a persistent chat. Telegram controls, desktop commands, Bot conversations, remote clients, schedules, and future `message_agent` delivery call this service instead of opening a Pi session themselves.

## Phase 0 — Freeze compatibility evidence

- Run the standing reference audit above for the compaction, child, approval, MCP-result, and memory domains; pin the inspected SHAs in the implementation notes.
- Record the exact current Pi package versions, tarball integrity, upstream tag/commit, exported compaction/session API, and relevant source hashes.
- Add golden fixtures for:
  - uncompacted legacy journals;
  - repeated and split-turn checkpoints;
  - abandoned overflow/provider attempts;
  - custom transaction and visible-chat sync markers;
  - tool calls/results, images, provider/model switches, and corrupt/torn tails.
- Capture the expected provider context for ordinary workspace, canonical Bot, ordinary Telegram, Bot-bound Telegram, and child sessions.
- Add a read-only migration verifier that reports what would change without writing a journal.

Gate: the fixtures reconstruct the same provider messages as the pinned production code, byte-for-byte where Pi owns serialization and semantically where Aiden projects model-specific images.

## Phase 1 — Close current `0.80.10` correctness gaps

### 1A. One projected pressure calculation

- Introduce a pure `projectNextContextUsage()` contract that accounts for:
  - the latest durable journal projection;
  - the current new user/queued message before provider I/O;
  - new tool results before a tool-loop continuation;
  - system prompt, Bot persona, memory projection, tool schemas, images, and model modality projection;
  - provider usage when it is valid, plus a conservative estimate for everything added after that anchor.
- Use it for top-level turns, between-tool turns, restored chats with zero usage, and child first turns.
- Never create a no-op semantic checkpoint when there is no compressible history. If only the active payload/static context is too large, return the bounded existing remediation instead of spending a summary call that cannot free space.
- Preserve the rule that runtime limits come only from the authoritative provider/model binding and validated local metadata. Do not add startup/background models.dev traffic.

### 1B. Make emergency trimming observable and recoverable

- Return a typed emergency-projection result from the provider boundary instead of only logging it.
- If compressible history was removed, schedule one durable semantic checkpoint at the next safe idle boundary and record why.
- If only an irreducible current payload was replaced by the fail-safe notice, do not create a misleading checkpoint; keep the transcript intact and return a stable user-facing category.
- Add an invariant: a successful hidden reduction cannot silently become the only representation of history used by subsequent turns.

### 1C. Unify manual compaction

- Add a main-owned `compactChat(chatId, audience, source)` operation with normal chat-turn admission, idle/busy behavior, cancellation, authoritative provider/model resolution, Bot canonical-chat enforcement, and usage accounting.
- Route Telegram `/compact` through it.
- Expose the same operation as a deliberate desktop command for ordinary workspace and canonical Bot chats; legacy Bot duplicates remain read-only.
- Return closed reasons such as `already_compact`, `busy`, `archived`, `not_canonical`, `provider_unavailable`, `context_metadata_invalid`, `cancelled`, and `compaction_failed` without raw provider text.

Gate: focused tests prove current-prompt preflight, between-tool pressure, first-turn/zero-usage behavior, no-op prevention, emergency/checkpoint reconciliation, exact Bot provider selection, and cross-surface exclusion.

## Phase 2 — Create the Pi session migration seam

- Hide direct Pi `Session` use behind a narrow `PiSessionPort` used by the coordinator, visible-chat synchronization, deletion, Telegram controls, and child sessions.
- Keep Aiden's chat IDs, permissions, private file modes, transaction envelopes, corrupt-journal quarantine, deletion cleanup, and renderer-safe activity contracts outside Pi.
- Define an Aiden-owned migration receipt containing old format, new format, source hash, promoted path, backup path, counts, and validation result—never transcript content.
- Implement read-only legacy decoding independently of whichever Pi version is installed so a package bump cannot make old journals unreadable.

Gate: current `0.80.10` behavior passes through the port with no context or durability change.

## Phase 3 — Upgrade Pi and migrate journals

- Re-check npm/GitHub and pin both Pi packages to the same exact audited release; do not use ranges.
- Build an isolated compile spike first. Treat TypeBox, telemetry, provider transport, `uuidv7`, session exports, and `prepareNextTurn*` changes as explicit migration items.
- Convert each legacy active branch to v4:
  - preserve every message/custom entry and parent relationship;
  - materialize each old `firstKeptEntryId` tail into the new checkpoint's `retainedTail`;
  - preserve checkpoint summary, tokens-before, details, and any available usage;
  - translate Aiden sync/transaction markers without exposing them to provider context;
  - retain abandoned branches needed for recovery evidence;
  - create the v4 lane and operation state required by the new repository.
- Write beside the old journal, validate reconstructed context and invariants, then atomically promote. Keep the owner-only legacy backup until installed rollback acceptance passes.
- On failure, leave the legacy journal authoritative and fail closed for that chat; never partially mix formats.

Gate: fixture migration, randomized branch/repeated-compaction tests, torn-write recovery, downgrade/rollback rehearsal, and installed app restart tests all pass.

## Phase 4 — Port semantic compaction to retained-tail Pi

- Use Pi's new `retainedTail`, summary usage, retry policy, and callback contracts directly.
- Remove the legacy `firstKeptEntryId` translation and Aiden's summary-request proxy only after parity tests show identical accepted outputs, retry limits, cache isolation, and abort precedence.
- Keep `PiAgentRuntimeHarness` as Aiden's runtime owner because it still supplies Electron chat persistence, effect durability, sequential tool policy, authority leases, provider hooks, renderer activity, and child supervision.
- Adapt to `0.84.4` loop semantics: between-turn compaction runs only before a real continuation, while post-response/idle work runs from the terminal lifecycle.
- Consider Pi telemetry only through Aiden's existing device-local redacted diagnostics. Do not add remote telemetry or transcript-bearing events.

Gate: upstream parity fixtures plus Aiden lifecycle, provider, deletion, corruption, cancellation, and packaging suites pass with no old-format runtime writes.

## Phase 5 — Prove every conversation surface

| Surface | Required behavior |
| --- | --- |
| Ordinary workspace chat | Current prompt and static tools are budgeted; automatic and manual compaction use the saved provider/model. |
| Canonical Bot chat on Mac | Same lifecycle as workspace chat plus Bot authority/persona; no new conversation is minted to escape pressure. |
| Telegram-bound Bot | Uses the canonical backing chat and Bot-saved model, acquires the same turn gate, and shares checkpoints with Mac/iOS. |
| Ordinary Telegram chat | Uses its own persistent backing chat and exact profile/workspace selection without inheriting Bot memory. |
| iOS/Android Bot chat | Continues through the existing one-chat-per-Bot server contract; clients render state but never author checkpoint/memory contents. |
| Child agent | Compacts an oversized initial fork before first provider I/O and between later turns, while preserving its existing bounded authority and parent reporting. |
| Scheduled/remote turn | Uses the same lifecycle only where that surface already has generation authority; this plan does not grant new unattended tools or Bot identity. |

Gate: one shared contract matrix runs against every adapter, with credentialed Telegram and packaged multi-surface concurrency retained as explicit operator gates.

## Phase 6 — Durable memory, separate from compaction

### 6A. Scope and schema

- Support distinct scopes: `bot`, `workspace`, and optionally `user`; never infer or merge scopes from a chat title.
- A Bot-bound Telegram turn resolves the same Bot memory as the canonical Mac/iOS chat. An ordinary Telegram workspace chat resolves workspace memory only.
- Store bounded fact records with stable ID, normalized text, provenance pointer, created/updated timestamps, confidence, expiry/review state, and explicit scope. Do not store secrets, credentials, raw reasoning, full tool payloads, or compaction summaries as facts.
- Keep always-on facts small and deterministically ordered. Everything else is on-demand recall through a bounded search service.

### 6B. Read path first

- Add a cache-stable prompt split: stable identity/authority/tool contract, then a bounded volatile memory block.
- Start with a device-local FTS5/BM25 index over approved facts and transcript/artifact metadata, following context-mode's useful retrieve-on-demand shape rather than dumping the index back into every prompt. Apply strict scope filters, result caps, citations back to local provenance, and no network dependency.
- Inject memory only after turn admission and before final context budgeting so its cost is visible to compaction.

### 6C. Approval-controlled writes

- Explicit user edits may write immediately through the owning main process.
- Model-proposed memories are suggestions only. Show the exact fact, scope, provenance, replacement/expiry behavior, and require owner approval before commit.
- Use Aiden's own bounded, fail-closed approval contract. Mirror the permission-system lesson that child-originated asks must forward to the owning attended surface; never let a headless child or Telegram transport silently convert `ask` into `allow`.
- A compaction cycle may produce memory suggestions once, after a successful checkpoint, but summary success never implies memory approval. Failure or cancellation commits neither a checkpoint nor suggestions.
- Identity, Bot persona, AGENTS instructions, skills, and permissions are not memory and cannot be rewritten through this path.

### 6D. Retrieval quality and maintenance

- Add deduplication, contradiction/supersession, expiry, delete/export, and source-chat deletion policy.
- Evaluate whether an FTS5-backed device-local index is sufficient before adding embeddings. Any embedding path must be local or an explicit user-authorized provider action with the same privacy boundaries as generation.

Gate: scope-isolation, prompt-injection, approval, provenance, deletion/export, compaction-cancellation, and prompt-budget tests pass across workspace, Bot, and Telegram adapters.

## Phase 7 — Evaluation, rollout, and optional native providers

- Build replay cases for long coding chats, tool-heavy turns, attachment-heavy first prompts, repeated compaction, provider/model switches, Bot Mac↔Telegram alternation, and child forks.
- Measure continuation correctness, pending-request/identifier retention, token reduction, time/cost, cache impact, re-compaction interval, emergency-projection frequency, no-op attempts, and migration failures.
- Roll out behind a device-local format/behavior gate: internal fixtures, developer installs, new chats, migrated low-risk chats, then existing long chats.
- Add provider-native compaction only as a later adapter when the provider owns the authoritative thread and Aiden can prove local/server reconciliation and deletion semantics. Local Pi checkpoints remain the cross-provider baseline.

Gate: defined quality thresholds and installed rollback receipts pass before the v4 journal becomes the only write format.

## Required regression matrix

- New top-level prompt crosses the threshold before provider I/O.
- Restored history with zero usage compacts from a conservative full projection.
- Static prompt/tools plus a small transcript cannot trigger a useless summary.
- Large tool output compacts before a real continuation without separating call/result pairs.
- Emergency projection cannot silently erase continuity on the next turn.
- Repeated and split-turn compaction preserves pending asks and exact identifiers.
- Bound Bot Telegram `/compact` uses the Bot chat's provider/model and refuses while Mac/iOS owns the turn.
- Ordinary Telegram and Bot-bound Telegram never share journals or memory scopes accidentally.
- Legacy Bot duplicate chats remain readable but cannot be compacted/written as canonical.
- Child initial fork, tool continuation, overflow retry, cancellation, and summary failure are non-destructive.
- Legacy journal migration is idempotent, crash-safe, privacy-preserving, and reversible during the rollout window.
- Memory suggestions cannot write without approval or widen Bot/workspace/tool authority.

## Verification gates

- migration fixture and fuzz/conformance suites
- `npm run test:compaction`
- focused `telegram-session`, Telegram turn, Bot canonical-chat, chat deletion, provider/model, and child-agent suites
- iOS and Android shared-contract tests for checkpoint/activity DTO changes
- `npm run test:telegram`
- `npm run test:bots`
- `npm run type-check`
- `npm run lint`
- `npm run test`
- `npm run build:electron`
- package verification and signed-install restart/rollback rehearsal
- credentialed Telegram Mac↔mobile concurrency smoke
- `git diff --check`

## Non-goals

- Replacing the recoverable transcript with a summary.
- Treating compaction output as trusted durable memory.
- Automatically rewriting Bot identity, workspace instructions, skills, permissions, or tool grants.
- Adopting Pi's incomplete public `AgentHarness` before its required operations are implemented and independently re-audited.
- Adding background models.dev, Artificial Analysis, OpenRouter benchmark, or other catalog traffic during generation.
- Shipping `message_agent`, group rooms, Bot routines, cross-machine Bot handles, or independent Bot processes in this plan.

## Completion criteria

This plan is complete only when:

1. current-turn semantic preflight works on every required surface;
2. Telegram manual compaction uses the shared admission and authoritative Bot/workspace model;
3. old journals migrate safely to the retained-tail Pi format with installed rollback evidence;
4. Aiden runs the audited current Pi compaction primitives without legacy checkpoint translation;
5. durable memory is scoped, bounded, searchable, approval-controlled, and demonstrably separate from compaction;
6. automated gates and the credentialed/installed operator matrix pass without an unresolved P0/P1 review finding.
