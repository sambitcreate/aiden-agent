# Phase D root papercuts, 2026-11-04

- The approved D plan still reserved Remote54 from the pre-A stack. At phase start updated its active provisional references to57 after A54/B55/C56; merge-time recheck remains mandatory.
- Existing ToolApprovalRuleBook uses a512KiB DataStore ceiling. New Bot entries/receipts must not commit a document that becomes unreadable at the next load; worker must address the concrete byte-budget and receipt-retention seam before publishing.

- Task1 inspection found a fresh publication operation on an existing target changed consent revision but emitted no Bot change event. Extended the existing API test, captured event RED, then emit once for every new publication receipt while exact transport replay stays silent. /tmp/bot-allowed-d-task1-parent-event-red.log.

- Read-only D runtime prep exposed a cross-file recovery gap: B Always can publish before the tally commit, then lose its prompt/owner. Task5 needs original tally fingerprint/offer/time in the existing committed folder journal, plus idempotent event-time reset. Counting incoming retry choices or replaying forget() would create a false decline or erase later history. Coordinated before Task2 API freeze.

- Task2 parent suite passed38, but inspection found completion retained its own Always event, allowing a new offer after only two later Once decisions. Sent a bounded behavioral RED/GREEN follow-up to remove only that known event while retaining ambiguous equal-time and later history. Task3 stays held until correction and commit.

- Task2 follow-up used aligned private receipt IDs rather than subtracting an ambiguous timestamp. Registered suite48pass, types/lint/diff0. New files are not live-wired, so no migration of shipped tally data is required.

- Task2 staging reported ignored .memory/.papercuts paths after staging the tracked files; the unique worker log needed explicit force-add. Included it in the local unpublished task commit before releasing Task3.

- Task3 changed-book fallback must recompute ordinary rules without another C reservation. Worker actual REDs caught stale Ask and hand-off execution; fresh ordinary fallback and initial browser verdict now pass. Registered target test with existing tallies, official51 and registry15 pass.

- Task4 parent inspection found settlement precedes the post-answer current-requirements comparison. Requested behavioral proof and a bounded fix so a stale Always card cannot publish through Task5 before the runtime re-asks; Task5 needs a live validation hook at first publication in addition to atomic consent generation. Registration/commit remains held.

- Task4 stale publication concern reproduced two real-book REDs, then focused275/runtime474 green with preflight and revocable live publication guard. Registered bridge/tally/target suite64 and registry15 pass; root current type-check0. Initial follow-up types log was the earlier ES2020 Object.hasOwn failure; later types-final and current root run confirm the corrected tree.

- Task5 application/journal RED4 covered missing historical receipt/list/removal behavior and strict optional D context. Green74 includes original B cases. A separate mutation RED proved grantBotFolder copied caller tally context after its first await; snapshot now precedes initialization. A schema RED caught RegExp coercing an array fingerprint to a valid hash; explicit string type now refuses it without poisoning the journal. Logs /tmp/bot-allowed-d-task5-root-{storage-red,snapshot-red,schema-red,storage-green3,storage-lint,types1}.log.
- Root application folder inventory lock is reentrant, Bot mutation gate is not. Folder Remove holds the established inventory lock and calls the existing policy save once, avoiding a nested Bot mutation queue. Shared roots and other Bot selections stay intact in real service tests.
- Store parent audit requested final live publication validation after the last awaited known-Bot read, with a synchronous deletion-intent check. Otherwise owner expiry/Stop during that final read could occur after the live guard but before mutation.

- Task5 integrated parent official95allowed/109storage/15registry/types0 pass. Root storage and both workers are source-frozen. Acknowledgement failures keep current one-time authority; future consent is reported only from historical/current proofs, never from an incoming retry choice.
