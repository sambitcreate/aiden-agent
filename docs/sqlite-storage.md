# SQLite storage maintenance

New Aiden-owned SQLite stores use incremental auto-vacuum, configured before their first tables are created. This covers workspace Memory, the durable-job ledger, studio asset metadata, image run history, and Pi Durable Bot sessions. The standalone CLI uses the same workspace Memory implementation.

Opening a store reclaims at most 128 unused pages. Memory, durable jobs, studio assets, and image run history also reclaim at most 128 pages when closing. Bot sessions receive their next pass when they reopen after an idle close. Maintenance is best effort and does not run on every write. SQLite checkpoints determine when changes in WAL mode reach the main database file; other live connections can delay that checkpoint.

Existing databases retain their current auto-vacuum mode and data. A database created without auto-vacuum continues to reuse freed pages internally but does not shrink through these passes. Converting that format requires a full rewrite, extra disk space, and exclusive maintenance, so Aiden does not convert it during startup. There is no new doctor command or background timer.

This policy does not modify imported browser databases, external files, JSON stores, or native-client caches. It changes disk allocation only and does not change retention or delete additional records.
