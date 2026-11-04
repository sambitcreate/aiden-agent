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

- Task6: the planned saved-consent toast would claim publication on a choice-only IPC acknowledgement. Use “Always allow requested.” and refresh the authoritative list on host change events.
- Task6 main RED initially stopped at missing planned parser/module exports. The separate real application observer RED reproduced the missing saved-access notification; GREEN covers save, folder removal, refusal, observer failure and teardown.
- Explicit staging must force ignored .memory/.papercuts paths separately. The normal Task5 add returned 1 for ignored directories after staging tracked files; inspected the index and forced only the intended notes before commit.

- Task6 registry first run caught the worker’s new list test before its registration. Added it to test:bot-allowed and the CI lane; no production or test assertion was weakened.

- Task6 whole types caught the new root approval-handler fixture omitting required signal. Added explicit undefined; runtime behavior assertions were unchanged. Task6 keeps Remove rows disabled until host response per the task contract, with inline failure, rather than an optimistic list disappearance.

- Task6 Cua first run passed Always, truthful toast, Manage, list and rule removal, then timed out on Settings because 600px collapses the sidebar. Screenshot confirmed the intended narrow layout. Corrected the test to reopen navigation before Settings; no timeout/retry/production change. /tmp/bot-allowed-d-task6-cua.log retains the first run.

- Task6 second Cua navigation failure revealed Bots uses a separate sidebar even when expanded. The screenshot and BotSidebar showed its Back to Aiden action; added that real navigation step before Settings. This was a second test setup correction, not a passing rerun/flakiness classification. Preserve /tmp/bot-allowed-d-task6-cua-final.log.

- Task7 prep found B’s public count was being spread into a strict legacy Remote parser. Host worker captured an actual RED and owns explicit projection/capability gating; native Task8 will consume the stable optional count under both capabilities.

- Task7 CLI inspection found desktop-only exclusion covered tool names but not D’s capability or list route. Extended the existing real CLI HTTPS/messaging test with server-capability and unavailable-route assertions. Initial edit used a root-relative path under the CLI workdir and failed before mutation; its unmodified targeted run is not final evidence. Corrected the workdir before editing and validating.

- Task7 targeted CLI messaging run failed before D’s new assertions: recipient submission was acknowledged after the test’s 10-second reply-poll window, with no recipient inference yet. /tmp/bot-allowed-d-task7-cli-exclusion.log retains the ledger/request trace. Full rebuilt CLI had183pass/3existing skips earlier. One diagnostic rerun is allowed, unchanged limits; a passing rerun still must be reported as a timing flake in the PR.

- The one permitted CLI rerun passed with new real HTTPS D-capability/route assertions, unchanged deadlines. Keep the original missed-reply run as a timing flake and report both logs in the PR. Final rerun /tmp/bot-allowed-d-task7-cli-exclusion-rerun.log; no extra reruns or timeout increases.

- Task8 native final handoff verified against machine summaries:406iOS+5existing skips,225Android+22navigation, no failures. New Swift sources/tests explicitly registered. All workers stopped before root staging.
- Review catalog search treats a combined model query literally and returned no models. Individual exact model searches returned requested Opus5.5 medium and OpenCode Go DeepSeekV4.1 Flash high options; no fallback model used.

- Task8 explicit git add returned1 for the ignored .memory directory after staging the tracked/native paths. Inspected the index, then force-added only the intended project memory and two papercut files.

- Gate6 first whole-D review rejected5c43f4a81: Opus live-folder hint/replay/deletion plus bridge/title Lows; DeepSeek independently confirmed deletion. Separate bounded workers own settlement and quarantined deletion. Root owns approval-bridge isolation and docs/status.
- DeepSeek ordering Low appears to misread the existing combined sort. Will independently exercise interleaved rows and record evidence before disposition.

- Root bridge actual corrupted-ledger RED2fail/13pass became15pass; scopedlint0. Saved-lookup test fixtures now carry real eligible metadata so their recovery claims apply to classes that actually persist tally receipts.
- Initial ordering probe reused a folder object, so a later mutation altered the earlier logged date. Its ordering assertions passed. A second immutable-row probe records both independently expected sorted orders, no production change.

- Deletion worker isolated quarantine with a typed private error, preserving original evidence bytes/path and retaining transient write failure behavior. Root inspected production diff and real lifecycle tests; full84 worker tests pass.

- Settlement review uncovered a missing production-clock oracle and a crash-at-threshold case. Worker captured9behavioral failures plus realSIGKILL failure, then192focused/27finalservice pass. Root broaderchecks run only after both workers froze.

- Corrected integration first-run green: allowed113/runtime480/access101/plans144/rules66/messaging89/Bots1012/types0/registry15/scopedlint12files0/fullRemote1300+2existing skips/Cua2retries0/rebuiltCLI183+3existing skips+CLItypes0. Earlier standaloneCLI timingflake remains carried. No mobile DTO/source changes warranted another native run.
