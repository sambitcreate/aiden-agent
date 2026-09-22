# Durable multi-file Designer Action transactions

Status: Implemented. The production no-follow workspace adapter, durable IPC/review UI, project
authority binding, pre/post-write source-graph proof, deletion preflight, restart rollback, Apply,
and Undo are integrated.

## Decision

A multi-file Designer Action is one main-owned logical transaction. It is not a loop over the existing in-memory single-file action API. Before any write, main records the exact before and proposed after byte images, their SHA-256 digests, deterministic file order, and three idempotent effect identities per file: apply, rollback, and undo.

The journal is the durable authority for recovery. A renderer may request preparation, review, Apply, or Undo, but it never owns transaction progress and cannot mark an effect complete.

Startup recovery lists only records that already crossed a durable Apply, rollback, or Undo intent. A `prepared` record is still waiting for explicit review and is never auto-applied; a `recoverable` record is inert until a new reviewed transaction is created.

## Bounds

- 16 regular files per action.
- 192 KiB per before or after file image.
- 4 MiB across all before and after images in one action.
- 32 journal records, with oldest terminal records evicted before active or recoverable records.
- 20 MiB logical journal ceiling and 24 MiB physical read ceiling.
- Canonical NFC, portable, workspace-relative paths only.
- Duplicate paths and case- or NFKC-equivalent path collisions fail before inspection.

The journal file is `source-designer-multifile-actions.json` under Electron `userData`. `DataStore` publishes it atomically with mode `0600`, reloads before writes, rejects stale compare-and-swap revisions, and refuses corrupt or unsafe backing files.

## File authority port

The core deliberately does not resolve filesystem paths. Its injected production port must prove all of these facts for every inspection and replacement:

1. the workspace ID still names an authorized workspace;
2. the requested path is the same canonical workspace-relative path returned;
3. every retained ancestor and the opened target are contained under the pinned workspace root;
4. traversal and replacement use no-follow semantics and reject symbolic links;
5. the target is an existing regular file;
6. returned bytes, byte length, and SHA-256 agree;
7. replacement is atomic and compare-and-swaps the expected digest;
8. repeated calls with one effect ID are idempotent and cannot create a second effect.

Containment booleans are necessary evidence, not authority by themselves. A production adapter must derive them from safe descriptor-based traversal or an equivalently race-resistant primitive; it must not set them after a lexical `path.resolve` check.

## State machine

```text
prepared
  -> applying
       -> applying (one file: pending -> write-intent -> verifying -> verified)
       -> verifying
            -> committed
            -> rolling-back
       -> rolling-back
  -> recoverable

rolling-back
  -> rolling-back (reverse file order, exact after -> before)
  -> rolled-back
  -> recoverable

committed
  -> undoing
       -> undoing (reverse file order, exact after -> before)
       -> undone
       -> recoverable
```

Every journal replacement increments one compare-and-swap revision. A same-stage replacement may advance exactly one file effect by exactly one phase. A stage change cannot also change file progress. File paths, byte images, and effect identities are immutable after preparation.

The coordinator writes `write-intent` before asking the file port to replace bytes. It writes `verifying` after the port returns and `verified` only after a fresh inspection proves the exact postimage. A crash in any gap is unambiguous on resume:

- current bytes equal the expected source image: issue or retry the idempotent effect;
- current bytes equal the expected target image: the effect crossed the crash boundary, so continue verification;
- current bytes equal neither image: preserve a conflict for review.

A catchable adapter error is not treated as a process crash. The coordinator immediately reinspects after a failed replacement: an exact target image continues verification, an exact source image starts audited rollback, and an unavailable or third-state inspection becomes `recoverable`. Only actual process loss leaves an active intent for startup recovery.

After every file is individually verified, Apply performs a second full postimage pass before `committed`. Undo and automatic rollback traverse the deterministic file list in reverse.

## Conflict and rollback rules

A stale preimage before the first intent causes no write and becomes `recoverable`. If a later file conflicts after earlier writes, the coordinator durably records the rollback cause before attempting reversal. A third-state file is never overwritten. If reversal encounters one, mutation stops, remaining files are inspected for conflict review, and the exact partial state is preserved rather than widening the race window.

`rolled-back` and `undone` are written only after every file's original SHA-256 is freshly proven. A `rolled-back` record retains the bounded audit that explains why automatic rollback began, while active conflicts are tracked separately during reversal. If any proof is still missing, the journal remains `recoverable` with expected and observed digests and byte sizes. The record therefore never claims rollback merely because a write call returned.

Recovery records are terminal for automatic mutation. A later review workflow must present the conflict and create a new exact transaction; it must not force-resume an ambiguous record.

## Scope boundary

This transaction changes only the explicitly reviewed, workspace-authorized regular files. It does not run commands, execute package code, create files, follow links, operate on directories, or acquire repository authority. It never stages, commits, resets, pushes, creates a branch or pull request, or otherwise invokes Git.

Production integration must continue to apply the normal Designer Action permission and exact-review gate. Full permission does not bypass that review.
