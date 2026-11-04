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
