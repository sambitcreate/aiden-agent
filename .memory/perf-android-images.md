# Android image preparation (AND-03)

Selected URI metadata/read/validation/decode/scaling/compression/Base64 preparation now runs on a serial shared IO worker. Each chat serializes selected batches; a Main-owned batch counter reserves Send before dispatch and remains owned by other selections when one is cancelled. The screen starts preparation undispatched and observes both preparation and upload state. Cancellation is rethrown, and identity checks prevent stale prepared/uploaded results being attached after the client changes.

Conversion samples toward the existing largest 3072-pixel edge before exact scaling and recycles owned bitmaps. Original validated <=8 MiB PNG/JPEG bytes remain untouched; converted output applies native EXIF orientation, preserves alpha with PNG, and retains existing validation limits and JPEG qualities. No new dependency, wire contract, transcript layout, durable feature or onboarding change.

No draft/cache redesign. Existing post-upload cache write remains on its owner to avoid new purge races; its Base64 decode runs on IO before the upload request, with a client recheck before upload. Native codec/provider blocking operations cancel at stage/chunk boundaries, not midway through native work.

Evidence and physical-device limits: `docs/performance/android-image-preparation.md`. Existing JVM `AidenChatTest` and instrumented `AidenImageCarouselUiTest` extended; no new test registration needed. Controlled mutation restoring Main execution fails the held-preparation regression; restored background dispatch passes.

Validation: initial full run 251 JVM tests passed (zero failed/skipped), lintDebug and compileDebugAndroidTestKotlin passed. Three codec instrumented tests executed and passed on the existing Medium_Phone_API_36.1 ARM64 Android 16 emulator. No physical-device performance claim. Baseline worker-dispatch mutation failed as expected; no new test files or registration changes.

Final full rerun hit a pre-attachment initial-load timeout in existing `heldTurnReceiptPreservesOtherOwnerAndCannotCrossRemoval` (250/251; new regression passed). Failure retained in the performance ledger and reported to coordinator for shared papercut tracking. No timeout/retry changes.

The one targeted rerun passed 2/2 (existing failed case and new preparation regression), with lint and instrumentation compilation passing. The failing initial-load path and init are unchanged and precede any changed Send logic; the test does not prepare/upload attachments. Timeout root cause is unproven, and no repeated retries were used to conceal it.
