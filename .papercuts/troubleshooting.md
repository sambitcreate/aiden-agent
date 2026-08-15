# Troubleshooting

- Pi 0.80.10 can choose the oldest oversized user turn as `firstKeptEntryId`, leaving both summary inputs empty and producing a no-op checkpoint. When the journal has a newer turn, retry `prepareCompaction` with a minimal retained-tail budget; still refuse the checkpoint if both summary inputs remain empty.
- `Session.getEntries()` includes abandoned branches. Synchronization markers must be read from `Session.getBranch()` or a rolled-back partial write can still look committed.
- Child-runtime unit tests load outside Electron. Keep usage accounting behind an injected callback (with a production-only dynamic import) instead of statically importing the Electron-backed singleton into the reusable child registry.
- A compaction model can overflow on the very history it is supposed to summarize. Strip binary images first and map-reduce serialized fragments within a conservative fraction of the model window before the final Pi checkpoint call.
- Renderer-safe truncation markers must be normalized before their length is budgeted, then the truncated value must be sanitized again; NFKC expands `…` to `...` and can otherwise invalidate an exact-length snapshot.
- Packaged builds do not initialize `aiden-dev.log`. For production subagent forensics, correlate the Pi session journal, the V2 run store, aggregate health metrics, and usage records without printing task or report contents.
