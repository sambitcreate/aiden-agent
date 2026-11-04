# Phase D Task 5 storage recovery papercuts

- A consent read before grant is not atomic with Remove. First publication must compare the original digest inside the same store update, then await the pure live guard before mutation.
- Recovery reads must distinguish a retained decision from a publication entitlement. Legacy receipts remain acknowledgeable but cannot acquire invented context or cause startup grants.
- Read-only publication guards run inside the store transaction. Keep them on DataStore.load-backed reads; a queued mutation/reload would deadlock the transaction.
- The first RED gate waited forever when the pre-change implementation ignored the guard. Race guard entry against unexpected grant completion, asserting failure immediately. This captures behavioral RED without adding a timeout or skip.
- Parent found an awaited knownBot check after live validation, allowing Stop/deadline drift before mutation. Gate that final identity lookup in real DataStore tests; make the live proof the last awaited authorization and retain a synchronous forgotten-Bot intent fence afterward.
