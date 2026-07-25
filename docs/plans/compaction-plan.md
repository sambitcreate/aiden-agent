# Best overall approach

I treated **“Py” as Pi**, and I also included **PydanticAI**, because its newer tiered-compaction design captures many of the best ideas in one framework.

The strongest approach is **not** “summarize the entire conversation when the window is full.” The better architecture is a **layered, transactional context-management pipeline**:

1. Keep the complete transcript as the source of truth.
2. Build a smaller, temporary context view for each model request.
3. Remove cheap, disposable bulk before using an LLM.
4. Preserve a recent verbatim working window.
5. Convert older work into a structured checkpoint.
6. Save durable facts separately from the checkpoint.
7. Validate the checkpoint before installing it.
8. Fall back safely when summarization fails.

My recommended design combines:

* **PydanticAI’s tiered orchestration**
* **OpenCode and Pi’s recent-tail and turn-boundary handling**
* **OpenClaw’s memory flush and summary quality audit**
* **Hermes’s configurable context-engine abstraction and dual trigger system**
* **Codex’s provider-native compaction lifecycle when the backend supports it**

---

# What the major agents are doing

| Agent          | Overall strategy                                                                                                                                                                         | Best idea to borrow                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **OpenCode**   | Prunes older tool output, preserves a recent token-bounded tail, summarizes older context into a structured anchored summary, and updates the previous summary during later compactions. | Separate cheap tool pruning from semantic compaction; preserve recent work verbatim.     |
| **Pi**         | Treats compaction as a first-class session entry containing the summary, cut point, token counts, usage, and metadata. Supports split turns and branch summaries.                        | Make compaction an explicit checkpoint event rather than silently rewriting messages.    |
| **Hermes**     | Uses gateway-level emergency compression plus an in-agent compressor, with configurable model-specific thresholds and pluggable context engines.                                         | Separate normal context management from an emergency safety net.                         |
| **OpenClaw**   | Prunes tool results, flushes durable memories before compaction, preserves identifiers and pending asks, audits summary quality, and can create successor transcripts.                   | Validate summaries before committing them and save durable memory separately.            |
| **PydanticAI** | Runs strategies in tiers: clamp oversized messages, deduplicate repeated file reads, clear tool results, then summarize only when still necessary.                                       | Re-measure after every inexpensive transformation and stop as soon as the target is met. |
| **Codex**      | Supports normal checkpoint summaries, provider-side Responses compaction, hooks, telemetry, retained-message budgets, and fresh context windows.                                         | Use provider-native compaction when it operates on the authoritative server-side thread. |

## OpenCode

OpenCode currently uses several distinct mechanisms rather than one destructive summary operation:

* Older completed tool results can be marked compacted while a protected recent tool-output region remains.
* A recent tail is selected by turns and token budget.
* The preserved tail can include part of an oversized turn when necessary.
* Media is stripped and tool output is truncated before asking the compaction model to summarize.
* The previous summary is supplied as an anchor and updated rather than blindly stacking summaries.

Its summary contract is explicitly operational: objective, important details, work state, next move, and relevant files. It also instructs the model to preserve exact paths, commands, symbols, errors, URLs, and identifiers.

**Lesson:** Recent working context and historical task state serve different purposes. Do not compress them the same way.

## Pi

Pi finds a cut point by walking backward until its recent-context budget is filled. It stores the result as a `CompactionEntry`, then rebuilds context from:

```text
system instructions
+ latest compaction summary
+ preserved recent messages
```

The entry records the summary, first retained entry, token count before compaction, model usage, and extensible metadata.

Pi also handles two cases that many simple implementations overlook:

* It avoids separating tool results from their corresponding calls.
* When one enormous turn cannot fit, it supports a split-turn summary rather than discarding the entire turn.

It tracks files read and modified cumulatively across repeated compactions and branch summaries.

**Lesson:** A compaction checkpoint should carry structured metadata in addition to generated prose.

## Hermes

Hermes separates compression into two levels:

* An in-loop compressor for normal context management.
* A higher-threshold gateway safety net that catches sessions which reach the agent already too large.

Its main compressor follows a head-middle-tail architecture:

```text
protected initial context
+ summarized middle
+ verbatim recent tail
```

Before summarizing, it clears older large tool results. It then aligns boundaries around tool-call groups, generates a structured summary, sanitizes orphaned tool calls/results, and updates the previous summary on subsequent passes.

Hermes also exposes context management through a pluggable `ContextEngine` abstraction, allowing alternative compressors or more lossless engines.

One important warning from Hermes’s implementation is that a summarizer with an insufficient context window can fail to consume the material it is supposed to compress. That should never result in the original context being silently deleted.

**Lesson:** Compression failure must be non-destructive.

## OpenClaw

OpenClaw has one of the most complete context-management designs.

It keeps the original transcript on disk while compaction changes only the context reconstructed for future turns. It also preserves tool call/result pairings around the boundary.

Before compaction, it can run a silent **memory flush** that asks the agent to write durable information to long-term or working-memory files.

Its pruning system is cache-aware:

* It can delay pruning while a provider prompt cache is still useful.
* It first soft-trims large tool outputs.
* It hard-clears them only when pressure remains high and enough tokens will actually be reclaimed.
* It protects recent assistant turns and bootstrap context.

Most importantly, OpenClaw treats summary generation as an output requiring verification. Its safeguard contract requires sections for:

* decisions,
* open work,
* constraints,
* pending user asks,
* exact identifiers.

It checks that required sections exist, opaque identifiers survived, and the latest user request is represented.

**Lesson:** A summary should pass a continuity test before becoming authoritative context.

## PydanticAI

PydanticAI’s current compaction framework is especially useful as an implementation model because it expresses context management as a configurable strategy pipeline:

1. Clamp a single oversized message.
2. Deduplicate repeated file reads.
3. Clear or trim older tool results.
4. Apply a sliding window where appropriate.
5. Use summarization only if the context is still above target.
6. Re-measure between strategies and stop once enough space has been recovered.

Its `TieredCompaction` design explicitly moves from cheap deterministic operations to more expensive semantic ones. ([Pydantic][1])

**Lesson:** Never pay for an LLM summary when deterministic reduction already solves the problem.

## Codex

Codex now supports multiple compaction paths, including remote/provider-side compaction and fresh context-window creation.

Its checkpoint prompt is deliberately framed as a handoff to another model, covering progress, decisions, constraints, remaining work, and critical references.

The current remote compaction path has lifecycle hooks, analytics, retries, model fallback, and a retained-message budget.

The compacted history shape keeps selected user, developer, and system messages within a bounded retained budget and installs the compaction output alongside them.

**Lesson:** When the provider owns the authoritative conversation thread, use its native compaction mechanism rather than merely shortening a local transcript mirror.

---

# Recommended architecture

The system should have four separate forms of state.

```text
┌────────────────────────────────────────────────────────┐
│ 1. Immutable transcript                                │
│ Every user message, response, tool call and result     │
└───────────────────────┬────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────┐
│ 2. Active context projection                           │
│ The bounded context assembled for the next model call  │
└─────────────┬─────────────────────────────┬────────────┘
              │                             │
              ▼                             ▼
┌────────────────────────────┐  ┌─────────────────────────┐
│ 3. Compaction checkpoints  │  │ 4. Durable memory      │
│ Task-state handoffs        │  │ Facts and decisions    │
└────────────────────────────┘  └─────────────────────────┘
```

## 1. Immutable transcript

The full event history should remain recoverable.

Do not replace the original transcript with the summary. Instead, append a compaction checkpoint containing:

* checkpoint ID,
* transcript range covered,
* retained-tail boundary,
* summary,
* token counts before and after,
* model and prompt version,
* validation result,
* relevant structured metadata.

This makes compaction reversible, debuggable, and auditable.

## 2. Active context projection

Before every model request, construct context from the underlying state rather than sending the raw transcript.

A normal projection would contain:

```text
stable system/developer context
+ selected durable memory
+ latest validated checkpoint
+ recent verbatim working tail
+ current user input
```

Large artifacts should generally be represented by references and fetched when needed, rather than permanently injected into every turn.

## 3. Compaction checkpoints

A checkpoint is a **task handoff**, not a generic chat summary.

Its purpose is to let the next model continue the work correctly. It should communicate:

* current objective,
* current task state,
* decisions already made,
* unresolved work,
* important constraints,
* active blockers,
* exact references needed for continuity,
* immediate next action.

Use a fixed schema rather than unstructured prose. A JSON object can be stored internally and rendered to Markdown for models that respond better to natural text.

## 4. Durable memory

Durable memory should be separate from the compaction summary.

A compaction checkpoint answers:

> “Where is this particular task right now?”

Durable memory answers:

> “What should this agent continue to know across tasks and sessions?”

Examples include persistent user preferences, project conventions, standing decisions, established environment facts, and action-sensitive constraints. OpenClaw similarly separates curated long-term memory from more detailed working notes.

---

# What to preserve, condense, externalize, and discard

The exact policy should be configurable, but this is a strong default.

## Preserve verbatim

These should survive without paraphrasing whenever feasible:

* System, developer, safety, and permission instructions
* The most recent unresolved user request
* Recent working turns
* Exact IDs, paths, hashes, ports, URLs, dates, commands, and error strings
* Tool-call and tool-result relationships
* User corrections and explicit reversals
* Approval status and action boundaries
* Current active artifact references
* Any information whose wording has contractual or operational significance

## Preserve semantically

These can be converted into structured state:

* Goal and desired outcome
* Completed work
* Current work
* Decisions and rationale
* Constraints and preferences
* Known blockers
* Failed approaches worth avoiding
* Tests run and high-level results
* Next actions

## Externalize

These should normally move out of the prompt and remain retrievable:

* Full source files
* Long shell output
* Search-result dumps
* Large API responses
* Generated patches
* Images and audio already processed
* Detailed reports and documents
* Old execution traces

The checkpoint should retain a reference plus a short statement of why the artifact matters.

## Remove from the active context

These are usually safe to eliminate from the prompt view:

* Duplicate file reads
* Repeated tool results
* Superseded plans
* Retries containing identical user input
* Routine acknowledgements
* Successful low-value command output
* Old reasoning that produced a decision already recorded
* Previous summaries that have been incorporated into a newer validated summary
* Stale speculative branches

The original records should still remain in the transcript or artifact store.

---

# Trigger strategy

Avoid one fixed percentage for every model.

Use a **budget equation**:

```text
available input budget =
    model context window
  - expected response budget
  - expected tool-loop budget
  - provider safety margin
  - fixed system/context overhead
```

Then run a trigger ladder.

## Level 1: Preventative cleanup

Run inexpensive cleanup before significant pressure develops:

* deduplicate repeated reads,
* remove stale media payloads,
* clamp abnormal single messages,
* trim large old tool outputs.

This can run per request, but only apply mutations when the token savings justify invalidating provider caches.

## Level 2: Memory flush

When the session approaches semantic compaction, extract durable information first.

This should happen once per compaction cycle, not repeatedly on every attempted run. OpenClaw explicitly tracks whether the current cycle has already been flushed.

## Level 3: Semantic compaction

Generate a checkpoint when the projected next request would cross the safe input budget.

Prefer a reserve-based trigger over:

```text
tokens > arbitrary percentage
```

because response sizes, tool loops, and provider behavior differ substantially.

## Level 4: Emergency recovery

If the provider returns a context-overflow error:

1. Recalculate using the provider-reported limit.
2. Apply aggressive deterministic pruning.
3. Compact using staged summarization.
4. Rebuild the request.
5. Retry once under an explicit recovery path.
6. Do not loop indefinitely.

Keep this distinct from normal compaction so you can measure how often your regular trigger failed.

---

# Compaction pipeline

## Stage A: Measure

Calculate token usage for each category:

* stable instructions,
* memory,
* checkpoint,
* recent messages,
* tool schemas,
* tool calls/results,
* attachments,
* expected response.

Use the active model’s tokenizer when available. Character estimates are acceptable only as a fallback.

## Stage B: Normalize

Before selecting boundaries:

* repair malformed tool pairs,
* normalize message roles,
* replace stale binary/media content with references,
* mark duplicate retry messages,
* identify previous compaction checkpoints,
* classify messages by source and authority.

This prevents the summarizer from receiving an invalid or misleading transcript.

## Stage C: Apply deterministic tiers

Run transformations from least destructive to most destructive:

```text
clamp pathological item
        ↓
deduplicate repeated content
        ↓
soft-trim old tool output
        ↓
clear disposable tool output
        ↓
re-measure
```

Stop immediately when the projected context fits.

## Stage D: Select the boundary

Walk backward from the newest message using a token budget.

Boundary rules:

* Prefer complete user turns.
* Never separate a tool result from the call that created it.
* Preserve a minimum number of recent turns.
* Allow a controlled split-turn mode for a single enormous agent run.
* Record the exact first retained event ID.
* Use token budgets rather than message counts as the primary mechanism.

## Stage E: Build the summary input

Give the summarizer:

```text
previous validated checkpoint
+ newly compacted transcript range
+ structured compaction schema
+ optional project-specific context
```

Do not give it the entire unbounded session on every compaction.

For very large ranges, use staged summarization:

```text
chunk summaries
      ↓
merge into task-state summary
      ↓
reconcile with previous checkpoint
```

The final pass should remove stale or superseded information rather than concatenate all previous summaries.

## Stage F: Generate a candidate checkpoint

Generate into temporary state. Nothing should be removed yet.

A dedicated summarization model can be used, but it must:

* have enough context for the selected input,
* reliably follow the schema,
* preserve literal identifiers,
* cost less only when quality remains acceptable.

A smaller model is not automatically a good summarizer.

## Stage G: Validate

Validation should be partly deterministic.

Check:

* required sections or schema fields exist,
* summary is non-empty,
* latest unresolved user request is represented,
* required exact identifiers remain,
* current objective exists,
* open work exists when the task is unfinished,
* summary does not introduce unknown files or completed actions,
* tool and artifact references remain valid,
* compacted context is actually smaller,
* expected next request now fits.

A second model can provide an optional semantic audit, but it should not replace deterministic checks.

## Stage H: Repair or fall back

When validation fails:

1. Retry once with explicit missing-field feedback.
2. Try a stronger or fallback summarization model.
3. Use staged summarization if the input was too large.
4. Retain the previous valid checkpoint if the new one is worse.
5. Fall back to deterministic pruning without deleting semantic history.
6. As a last resort, start a new successor context while keeping the original transcript recoverable.

Never commit an empty summary.

## Stage I: Commit atomically

Only after validation:

* append the checkpoint,
* mark the covered event range,
* update the active context boundary,
* record token and quality metrics,
* preserve the old transcript,
* increment the compaction generation.

The session should either use the old valid context or the new valid context—never a half-written mixture.

---

# Context-engine interface

Make compaction pluggable from the beginning.

```text
ContextEngine
├── measure()
├── shouldCompact()
├── plan()
├── compact()
├── validate()
├── assembleContext()
└── recordOutcome()
```

Possible implementations:

* `TieredSummaryEngine`
* `ProviderNativeEngine`
* `SlidingWindowEngine`
* `RetrievalBackedEngine`
* `TokenBudgetResetEngine`
* future lossless or hierarchical engines

The provider adapter should tell the engine:

* context-window size,
* maximum output,
* tokenizer,
* prompt-cache behavior,
* native compaction support,
* supported message/tool structure,
* overflow error patterns.

This resembles Hermes’s configurable context-engine approach while avoiding provider-specific logic inside the main agent loop.

---

# Prompt-cache considerations

Compaction can reduce token use while simultaneously destroying cache reuse.

Treat cache behavior as part of the planner:

* Keep the stable system prefix unchanged.
* Avoid modifying old messages on every turn.
* Perform pruning in meaningful batches.
* Require a minimum expected token reduction before invalidating a cached prefix.
* Prefer append-only checkpoints.
* Track cache read and write tokens independently from ordinary input tokens.
* Use provider-native context editing when it preserves server-side state more efficiently.

OpenClaw’s pruning system explicitly delays edits around cache TTLs, while Hermes notes that changes in the middle of the prompt invalidate the later cache prefix.

---

# Testing and evaluation plan

Do not evaluate compaction only by token reduction.

## Continuation tests

Create long synthetic agent runs containing:

* multiple user corrections,
* exact IDs and paths,
* a current unresolved ask,
* several completed and incomplete tasks,
* large tool outputs,
* failed commands,
* branching plans,
* permission-sensitive instructions.

After compaction, give the agent a continuation task and measure whether it behaves correctly.

## Core metrics

Track:

| Metric                   | What it tells you                                            |
| ------------------------ | ------------------------------------------------------------ |
| Token reduction          | Whether compaction saves meaningful space                    |
| Continuation success     | Whether the agent can finish the task                        |
| Pending-ask recall       | Whether unresolved user requests survived                    |
| Identifier retention     | Whether exact operational values survived                    |
| Decision consistency     | Whether prior choices remain respected                       |
| Hallucinated state       | Whether the summary claims work not performed                |
| Re-compaction interval   | Whether summaries are too large or thresholds too aggressive |
| Emergency overflow rate  | Whether normal triggers work                                 |
| Tool-pair repair rate    | Whether boundaries are structurally safe                     |
| Cache read/write changes | Whether savings are offset by cache invalidation             |
| Latency and cost         | Operational impact of the compaction pipeline                |

## Rollout sequence

1. **Offline replay:** Compact recorded sessions and compare continuation behavior.
2. **Shadow mode:** Generate checkpoints but continue using uncompressed context.
3. **Advisory mode:** Use deterministic pruning, but not semantic replacement.
4. **Limited rollout:** Enable semantic compaction for long, low-risk sessions.
5. **General rollout:** Expand only after continuity metrics are stable.
6. **Ongoing regression suite:** Run whenever prompts, models, tools, or schemas change.

---

# Practical implementation roadmap

## Phase 1 — Context accounting

Build:

* provider-aware token measurement,
* per-message and per-category usage,
* projected next-turn budget,
* overflow detection,
* compaction telemetry.

**Exit condition:** You can explain exactly why a session compacted.

## Phase 2 — Immutable session model

Introduce:

* append-only transcript events,
* compaction checkpoint events,
* retained-boundary IDs,
* checkpoint generations,
* active-context reconstruction.

**Exit condition:** Every compacted session can be reconstructed or rolled back.

## Phase 3 — Deterministic reduction

Implement:

* oversized-message clamping,
* repeated-read deduplication,
* stale media replacement,
* soft and hard tool-result trimming,
* tool-pair repair.

**Exit condition:** Large tool-heavy sessions survive longer without semantic summarization.

## Phase 4 — Structured checkpoints

Add:

* fixed summary schema,
* previous-checkpoint reconciliation,
* recent-tail selection,
* split-turn support,
* staged summarization,
* optional dedicated summarizer.

**Exit condition:** Checkpoints consistently let a fresh model continue the task.

## Phase 5 — Memory separation

Add:

* pre-compaction memory extraction,
* durable versus working memory,
* provenance and expiration metadata,
* retrieval of externalized artifacts,
* once-per-cycle flush tracking.

**Exit condition:** Long-term facts do not depend on a task summary surviving forever.

## Phase 6 — Quality guard

Implement:

* structural validation,
* identifier checking,
* pending-ask coverage,
* contradiction checks,
* minimum token-reduction check,
* repair retry,
* model fallback,
* non-destructive failure.

**Exit condition:** No failed or empty summary can replace valid context.

## Phase 7 — Provider-native paths

Add adapters for:

* native Responses compaction,
* server-side context editing,
* provider prompt caching,
* model-specific thresholds,
* local transcript reconciliation.

**Exit condition:** Local and server-side context cannot silently diverge.

## Phase 8 — Evaluation and tuning

Build:

* replay benchmark,
* long-horizon task suite,
* compaction dashboard,
* per-model policy configuration,
* gradual rollout controls.

**Exit condition:** Threshold and model choices are based on measured continuation quality, not intuition.

---

# The design I would build

For a new general-purpose coding or computer-use agent, I would use this default pipeline:

```text
Immutable transcript
      ↓
Budget projection
      ↓
Clamp + dedupe + tool-output pruning
      ↓
Re-measure
      ↓
Pre-compaction durable-memory flush
      ↓
Select recent token-bounded verbatim tail
      ↓
Update structured task checkpoint
      ↓
Audit pending asks + identifiers + state
      ↓
Atomically install:
instructions + memory + checkpoint + recent tail
```

The most important design principle is:

> **Compaction should produce a validated checkpoint while preserving a recoverable source of truth—not replace history with an unchecked summary.**

That gives you the efficiency of PydanticAI’s tiered strategy, the continuity of OpenCode and Pi, the safety of OpenClaw, the configurability of Hermes, and the provider integration model used by Codex.

[1]: https://pydantic.dev/docs/ai/harness/compaction/?utm_source=chatgpt.com "Compaction | Pydantic Docs"
