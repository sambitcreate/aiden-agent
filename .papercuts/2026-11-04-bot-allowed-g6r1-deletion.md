# Gate 6 deletion correction

- DataStore.update writes even when its callback returns without changing the draft. Quarantined deletion must abort the transaction before publication to preserve the original evidence bytes and path.
- Global command output was truncated while reading several long documents together. Read the D plan in bounded sections and both complete review reports separately from source inspection.
- Behavioral RED before source edits: 2 passed, 9 failed in `/tmp/bot-allowed-g6r1-deletion-red.log`, all quarantine failures reported unreadable receipts from forgetBot. Typed quarantine abort then passed all 11 targeted cases in `/tmp/bot-allowed-g6r1-deletion-green.log`.
- Full owned book/session/settings suites passed 84 tests, no failures or skips in `/tmp/bot-allowed-g6r1-deletion-focused.log`. Three-file ESLint passed in `/tmp/bot-allowed-g6r1-deletion-lint.log`. Other workers' concurrent changes remain untouched.
- Lifecycle evidence uses the real session service, DataStore, allow-list and tallies, with fake cleanup effects for computer/home/record erasure. No production session-service edit, native/physical/live/package/CI or whole-D acceptance claim.
