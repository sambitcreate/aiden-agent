# Phase D Task 2 papercuts

- Hint cooldown and recent denials cannot rely only on the 100-class cache: forget/eviction would otherwise allow a repeated hint or suppress a recent denial. Retained decision receipts must remain the safety authority for both.
- Per-instance serialization would lose decisions when two factories reopen the same profile concurrently. Use one process-wide serial keyed by the actual per-Bot file, under the existing host profile lease.
- A shell glob matched no helper filename during read-only inspection. Used rg --files to locate regular-file-read.ts instead.
- Whole-root types found TS18046 because property narrowing of c.allowed did not survive a callback. A local narrowed array reference preserves the same validation and compiles.
- Historical B Always recovery needs an immutable original decidedAt plus durable first-completion state. Replaying public forget() would erase newer choices. Publication resets retain equal-time events and use the latest completed original consent as a cutoff for later-arriving historical receipts.
- Parent found a reset gap: the publishing Always receipt remained counted, so two later Once approvals reached the three-approval nudge. Timestamp-only caches cannot identify its presence after same-time events, caps or eviction. Add private aligned receipt IDs and exclude published receipts by identity on every read and reset.
