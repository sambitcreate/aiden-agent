# Phase D Task 1 papercuts

- Required combined context reads exceeded the tool output budget. Re-read individual files and bounded plan sections without line truncation.
- Existing DataStore tolerates malformed JSON as defaults. Bot publication must consult its optional corrupt-load health port and persist a fail-closed marker through workspace writes so replay protection cannot silently reset.
- Receipt retention shares the existing 512 KiB document ceiling. Admission must reserve future revocation growth and refuse new receipts when full; no receipt pruning is safe before authoritative task-settlement GC.
- Quarantining malformed receipts must not duplicate the whole valid receipt prefix alongside raw evidence. That can unnecessarily exhaust the shared document budget and block workspace approvals. Retain the original array once as evidence while Bot access fails closed.
