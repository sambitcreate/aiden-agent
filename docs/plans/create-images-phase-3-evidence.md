# Create Images Phase 3 Evidence

Status: **GO** — durable local-mock execution and recovery gates are complete; Phase 4 may add the first explicitly connected remote provider
Date: 2026-08-11
Feature gate: `AIDEN_CREATE_IMAGES_ENABLED=1`

## Implemented execution surface

- Main-owned immutable workflow snapshots and exact deterministic plans for **Run all** and **Run from here**. Scoped execution requires either the selected node only or one explicitly chosen, connected source-to-sink path; hidden fan-out and forged rejoining paths fail closed.
- A deterministic device-local mock provider is the only production executor in Phase 3. It produces bounded valid PNGs, costs `$0`, makes no network request, and supports controlled success, delay, failure, rate limit, ambiguity, crash boundaries, duplicate/out-of-order events, and late completion.
- Global run concurrency is capped at four. The local mock retry contract is one initial attempt plus at most two explicitly safe automatic retries; ambiguous or accepted remote-style submissions never auto-resubmit.
- Run confirmation names scope, exact request/output counts, retry ceiling, destination, device/network boundary, and cost. Paid/provider retry remains manual and is not authorized by the Phase 3 consent surface.
- Run/node events are identity-bound, monotonic, and transition-checked. Output asset IDs are durably published before success; duplicate asset IDs remain valid ordered output positions.
- Ambiguous submissions terminalize as `needs_attention`. A separate compare-and-swap acknowledgement records the audit decision, clears admission only after durability, and never retries, reconciles, or resubmits provider work.
- Cancellation intent is durable before abort/provider cancellation. Renderer disconnect and app quit use distinct reasons; late valid outputs stay attached to the same cancelled run without converting it to success.
- App quit is fail-closed: active runs are inspected with a bounded deadline, the user explicitly chooses **Keep Aiden Open** or **Stop Runs and Quit**, cancellation durability failures keep the app open, and abandoned quit paths reopen run admission.

## Run journal and recovery

The main process owns `<userData>/create-images/runs`:

```text
runs/
  run-index.json                         # derived, rebuildable, never execution authority
  <run-id>/
    run.json                             # immutable start checkpoint
    run.last-known-good.json
    run.events.jsonl                     # fsynced hash-chained events
    run.last-known-good.events.jsonl
    run.pending.json                     # present only across a durable mutation boundary
```

- The journal uses bounded JSON checkpoints plus separate hash-chained JSONL event logs, avoiding a new native database dependency while meeting the measured 1,000-run gate.
- Every append persists a compact intent before the current and last-known-good logs. The intent binds run identity, base/target revisions, all four file identities, the exact event bytes, and the target journal SHA-256.
- File authority is bound to device, inode, size, nanosecond modification time, and change time. Reads are identity-bracketed; appends use no-follow descriptors and revalidate path/descriptor identity before and after writes.
- A torn current or last-known-good append is repaired only when the checkpoint and peer log remain the exact trusted base/target, the damaged file is same-inode append growth (or an originally absent newly created log), its original prefix replays to the exact base, its suffix is a strict prefix of the pending event record, and the target digest matches. Repair uses a staged mode-0600 file, fsync, atomic rename, and parent-directory fsync. Arbitrary replacement or digest drift remains recovery-only, and provider execution stays zero.
- Startup and live admission force a bounded on-disk inventory and authoritative checkpoint/log inspection. The derived index is identity-bound, rebuilt/quarantined when safe, and cannot authorize execution, deletion, ambiguity resolution, or reference release.
- Restart reconciliation never resubmits an unknown accepted request. Prepared/ambiguous work becomes `needs_attention`; accepted local-mock jobs reconcile deterministically; lost local/queued work becomes `interrupted` without fabricated cancellation or start provenance.
- History, recovery, retention, ambiguity acknowledgement, and irrecoverable discard are path-free and compare-and-swap guarded. Retention/discard are explicit two-step operations; unresolved ambiguity and recoverable records cannot be silently retired.
- Workflow deletion shares the run-admission fence and forces a fresh bounded run audit. Any active, terminal, recovery, unsafe, newly added unassociated, or otherwise unprovable run authority blocks deletion and preserves workflow/run asset references.

## Renderer authority and accessibility

- Main publishes complete subscription snapshots with monotonic per-subscription sequence numbers. Full authoritative lists enter renderer state only through that sequenced subscription path.
- Start/stop/ambiguity acknowledgements are partial mutation results and use a separate reconciler that cannot add, remove, or reinterpret history/recovery state.
- A bounded causal tombstone set prevents delayed mutations from resurrecting recovered, pruned, or discarded runs. Same-run sequences never regress; terminal-to-active, active-to-terminal, retention fallback, and empty-state handoffs require authoritative evidence and update output-preview ownership atomically.
- Selected history loading, recovery, ambiguity acknowledgement, discard, and prune use mount/request generations plus exact selection, candidate, membership, and tombstone checks. Delayed or post-unmount responses cannot change cache, detail, previews, toast, or focus. Unrelated run notifications do not strand selected detail requests.
- Run controls, path chooser, confirmations, progress, node/run badges, actionable errors, terminal history, recovery, retention, ambiguity, and discard surfaces use semantic text/glyphs rather than color alone; dialogs preserve controlled focus, keyboard behavior, reduced motion, forced colors, and responsive layouts.

## Verification

- Last complete registered aggregate before the final renderer-only causal fixes: `npm run test:create-images` **353/353** (8 pretests, 331 functional tests, 2 performance tests, 12 Node/script checks).
- Final changed-scope renderer gate after all causal/lifecycle fixes: **47/47**; the exact sequence-advance acknowledgement regression is included.
- `npm run type-check`: pass after the final fix.
- Full and scoped ESLint, `oxfmt --check`, and `git diff --check`: pass.
- `npm run build`: pass; Create Images remains behind its lazy route at 335.87 kB JS / 100.11 kB gzip and 44.60 kB CSS / 6.93 kB gzip, with acceptance code in a separate main-process chunk.
- 500-node successful journal: 1,502 events, 635,757-byte current log, 119.34 s append, 183 ms cold replay (all under enforced gates).
- 1,000 output-rich terminal journals × 250 asset IDs: 4.58 s restart, 4.94 s authoritative admission audit, 22.24 s full modeled product path, 81 ms retention lookup, 355,073-byte derived index; caches remained bounded at 32 journals / 1,123,456 bytes and 128 tails / 57,472 bytes.
- Product Electron canvas: 100/250 nodes passed with 2 mounted DOM nodes, zero visible overlaps, bounded scrollable long prompts, edit/announcement checks, and 15,750,875-byte heap growth. The independent spike also passed with 14,316,472-byte heap growth.
- React Doctor completed after each final React wiring change. Because the Create Images tree is untracked in this worktree, changed-scope detection fell back to the repository-wide baseline; no new high-confidence diagnostic was tied to the Phase 3 wiring.

No package, signing, notarization, packaged acceptance, network request, real provider call, or paid work was performed for Phase 3. Phase 2's signed artifact remains its own frozen evidence. Phase 4 owns the explicit user-supplied Gemini connection and real-provider opt-in acceptance; Phase 5 owns the final signed/notarized distribution and migration gates.

## Review outcome

Fresh read-only correctness and reliability rounds repeatedly exercised crash boundaries, same-process authority changes, cancellation, ambiguity, retention/discard/delete, subscriptions, and renderer async ordering. Every actionable finding was repaired and regression-covered. The final user-directed wrap accepted the frozen Phase 3 source after the reliability lane returned unconditional GO and the last correctness finding (same-run acknowledgement notification arriving before its reply) was fixed with a 47/47 focused gate and full static verification.
