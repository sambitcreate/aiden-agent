# Android image preparation (AND-03)

Selected URI metadata/read/validation/decode/scaling/compression/Base64 preparation now runs on a serial shared IO worker. Each chat serializes selected batches; a Main-owned batch counter reserves Send before dispatch and remains owned by other selections when one is cancelled. The screen starts preparation undispatched and observes both preparation and upload state. Cancellation is rethrown, and identity checks prevent stale prepared/uploaded results being attached after the client changes.

Conversion samples toward the existing largest 3072-pixel edge before exact scaling and recycles owned bitmaps. Original validated <=8 MiB PNG/JPEG bytes remain untouched; converted output applies native EXIF orientation, preserves alpha with PNG, and retains existing validation limits and JPEG qualities. No new dependency, wire contract, transcript layout, durable feature or onboarding change.

No draft/cache redesign. Existing post-upload cache write remains on its owner to avoid new purge races; its Base64 decode runs on IO before the upload request, with a client recheck before upload. Native codec/provider blocking operations cancel at stage/chunk boundaries, not midway through native work.

Evidence and physical-device limits: `docs/performance/android-image-preparation.md`. Existing JVM `AidenChatTest` and instrumented `AidenImageCarouselUiTest` extended; no new test registration needed. Controlled mutation restoring Main execution fails the held-preparation regression; restored background dispatch passes.

Validation: initial full run 251 JVM tests passed (zero failed/skipped), lintDebug and compileDebugAndroidTestKotlin passed. Three codec instrumented tests executed and passed on the existing Medium_Phone_API_36.1 ARM64 Android 16 emulator. No physical-device performance claim. Baseline worker-dispatch mutation failed as expected; no new test files or registration changes.

Final full rerun hit a pre-attachment initial-load timeout in existing `heldTurnReceiptPreservesOtherOwnerAndCannotCrossRemoval` (250/251; new regression passed). Failure retained in the performance ledger and reported to coordinator for shared papercut tracking. No timeout/retry changes.

The one targeted rerun passed 2/2 (existing failed case and new preparation regression), with lint and instrumentation compilation passing. The failing initial-load path and init are unchanged and precede any changed Send logic; the test does not prepare/upload attachments. Timeout root cause is unproven, and no repeated retries were used to conceal it.

PR #284 follow-up proved a separate pre-existing test lifetime defect: ViewModelStore.clear only requests cancellation, allowing children to resume after Main reset. AidenChatTest now joins stored ViewModel jobs after clear and joins its live coordinator scope. Held-finalizer regression fails when joining is removed, passes restored; focused 3/3 passes. The single full run on changed source remains 251/252: same initial-load timeout (line 403 after added regression), with no missing-Main exception in XML. Do not claim the timeout fixed or full validation green. No repeated unchanged runs. Detailed evidence in the performance ledger.

A temporary diagnostic change traced all held-turn modes through a successful ~0.38s execution in a full run, but that run failed another setup wait: lateStopAcknowledgementCannotUndoTerminalEvent waiting for coordinator.serverInfo before ViewModel creation (251/252). Diagnostic source restored; outputs preserved under /tmp/aiden-lifetime-diagnostic*. No proven HTTP/scheduler root cause.

Final bounded HTTP diagnostic run passed 252/252 with request/response/parse probes and no coordinator errors. Failure-only request/queue/thread dumps did not trigger. All probes restored; no cause established and no further rerun. Evidence /tmp/aiden-http-diagnostic.log and .xml; the clean-source full-run timeout remains unresolved.

PR #284 hosted review caught cancellation of the cleanup caller itself: join could abort after store.clear. The helper now runs its complete barrier in NonCancellable, with active/cancelled caller variants of the held-finalizer regression. Removing NonCancellable fails the cancelled variant deterministically; restored focused five tests pass. Coordinator cancelAndJoin is already in a fresh outer runBlocking and does not inherit test cancellation. Initial HTTP setup flake remains unresolved; no full rerun, production change, or timeout weakening. Evidence /tmp/aiden-cancelled-cleanup-{mutation,restored}.{log,xml}.
