# Pi-native compaction delivery plan

## Status

Complete. Aiden now uses Pi's native semantic compaction lifecycle for primary chats and child agents. The broader comparative design and deliberately deferred follow-on tracks remain in [compaction-plan.md](../compaction-plan.md).

## Outcome

Aiden will compact conversations the way Pi `0.80.10` does:

- keep an append-only session journal as the reconstruction source of truth;
- trigger at `contextWindow - reserveTokens`, using Pi's defaults and accounting;
- summarize older history into a structured compaction entry;
- retain a recent verbatim tail without splitting tool calls from results;
- support split-turn summaries for oversized turns;
- update the prior summary on subsequent compactions;
- compact after a successful near-limit response without replaying it;
- compact and retry exactly once after a context-overflow response;
- leave the original session intact when summary generation fails.

The existing `generation-context` transform remains as Aiden's last-resort request safety layer for static prompt/tool overhead and pathological single payloads. It is not the normal compaction mechanism.

## Source contract

Parity is pinned to the same `@earendil-works/pi-agent-core@0.80.10` version Aiden already ships. The implementation delegates cut-point selection, token estimation, summary prompting, retained-tail reconstruction, and compaction entry shape to Pi core rather than maintaining Aiden forks of those algorithms.

Pi's coding-agent session wrapper adds orchestration around those core primitives. Aiden must reproduce that orchestration at its own runtime boundary because it uses `Agent` directly and has its own provider, chat, lifecycle, and privacy stores.

## State model

```text
visible chat JSON                     private Pi session JSONL
user/assistant conversation           user/assistant/tool messages
renderer-facing metadata              compaction entries + cut boundaries
              \                       /
               next generation context
          latest checkpoint + retained tail
```

The Pi journal lives below Electron `userData`, is keyed by chat ID, and is never renderer-authored. Existing chats are seeded from the authoritative main-process chat payload on first use. Deleting a chat removes its private Pi journal before the visible chat disappears.

All four delivery phases and their verification gates completed on 2026-08-06.

## Reliability hardening — 2026-08-14

A follow-up audit closed lifecycle gaps around the shipped boundary:

- the exact enriched slash-skill user turn is now journaled before provider I/O;
- pre-prompt pressure includes the current user turn and zero-usage rehydrated history;
- deterministic emergency reduction forces a durable semantic checkpoint afterward;
- failed overflow attempts, including silent `length` overflows, are moved off the active journal branch before retry;
- journal message/marker batches roll back atomically on partial append failure;
- child prompts are journaled once and receive the same pre-prompt pressure check;
- empty summaries are rejected, small context windows receive bounded reserve/tail settings, and semantic checkpoints survive emergency pruning;
- overflow retries reset streamed renderer text, and terminal chat snapshots reach cache before animation handoff.

The focused `test:compaction` gate now covers the core coordinator, emergency projection, child runtime, renderer stream reset, and terminal cache handoff.

## Phases

### Phase 1 — Native session and compaction controller

- Add a durable chat-scoped Pi session store using Pi's JSONL repository.
- Seed and reconcile visible chat messages with stable, context-invisible sync markers.
- Wrap Pi's `prepareCompaction`, `compact`, `shouldCompact`, and `Session.buildContext` APIs.
- Adapt Aiden's already-resolved model runtime to the Pi summarizer without new credentials, provider calls, or model selection.
- Cover first compaction, repeated compaction, tool-pair boundaries, failure preservation, and existing-chat seeding.

Gate: focused unit tests prove that reconstructed context is Pi-produced and the original journal remains append-only.

### Phase 2 — Primary chat lifecycle

- Construct each primary `Agent` from the private session projection rather than renderer-supplied history.
- Persist streamed assistant/tool messages to the journal in Pi order.
- Run the pre-prompt threshold check.
- Run post-response compaction without retry when the response succeeds near the limit.
- On a context-overflow response, omit that error from the rebuilt active context, compact, and retry once.
- Ignore stale pre-compaction usage and fall back to the latest valid usage when terminal usage is absent.

Gate: lifecycle tests cover normal completion, proactive compaction, overflow recovery, retry exhaustion, cancellation, and summary failure.

### Phase 3 — Child agents, privacy, and activity

- Apply the same Pi orchestration to child agents with child-owned in-memory sessions.
- Expose Pi's compaction start/end lifecycle as a bounded, renderer-safe activity step.
- Remove durable chat journals transactionally with private subagent history during chat deletion.
- Reconcile orphaned journals at startup without weakening generation admission or deletion recovery.

Gate: child runtime, timeline projection, and deletion tests pass; no compaction prose, tool payload, secret, or absolute path crosses into renderer activity.

### Phase 4 — Verification and rollout closeout

- Run focused tests after each phase, then the package test/type/lint gates.
- Review parity against Pi `0.80.10`, failure atomicity, privacy boundaries, concurrency, and backward compatibility.
- Update the broader compaction plan, project memory, and plan index with the exact shipped boundary.
- Archive this delivery plan only after every funded phase and review gate passes.

## Non-goals

- Replacing visible chat JSON with Pi JSONL.
- Adding provider-native compaction APIs.
- Automatically writing durable project/user memories from a compaction summary.
- Sending Artificial Analysis or models.dev traffic during generation.
- Surfacing generated summary contents in the renderer.

## Review checklist

- Pi owns summary schema, cut points, token accounting, and retained-tail reconstruction.
- A summary failure cannot delete or hide original history.
- A context overflow can cause at most one automatic retry.
- A successful answer is never duplicated during post-response compaction.
- Tool call/result pairs remain valid at every boundary.
- Journal writes are serialized per chat and isolated across chats/workspaces.
- Chat deletion cannot leave a readable private compaction journal behind.
- Renderer activity contains state only, never private summary or tool content.
- Existing chats continue without manual migration.
