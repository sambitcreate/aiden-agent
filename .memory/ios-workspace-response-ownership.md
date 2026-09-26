# iOS workspace response ownership

Isolated branch feature/ios-workspace-response-ownership atop PR2330f94027e. PR217 cursor correction62fa352d is separately published and must be composed by integration; this branch does not duplicate it.

## Workspace list slice

A held workspace GET previously published its raw response before cache admission, allowing a newer detail transcript/title or newly created omitted row to disappear. The request already reserves before HTTP; saveChats now returns admission and merges newer admitted detail owners by that original token. A namespaced admitted workspace snapshot is retained before disk IO, and the model publishes that current snapshot after its awaits. Newer list requests still authoritatively remove omitted older rows. Per-chat removal filters memory and purge clears it. A purge-generation guard rejects stale disk fallback when deletion fails; fresh post-purge lists are admitted normally.

Two compiled XCTest methods cover six real held-HTTP schedules (newer detail, omitted newer detail, failed list write, removal, purge, newer list) and failed purge deletion with actual stale disk plus fresh re-admission. These are source/compiled regressions, not executed iOS negatives. Generic app/XCTest build-for-testing passes /tmp/aiden-ios-workspace-response-build.log. Fresh Android177 JVM tests/lint/instrumentation compilation pass /tmp/aiden-ios-workspace-response-android.log; policy31Node+20Ruby42 pass /tmp/aiden-ios-workspace-response-policy.log. Both independent GPT-5.6 Sol medium reviews are clear after the failed-purge fallback correction. Physical tests remain unexecuted; shared iPhone locked.

## Remaining assigned scope

Rename is separate and not claimed fixed here. Preserve successful PATCH title as a field-specific overlay, canonical transcript/revision unchanged; reserve before PATCH and all detail GETs, refresh via read-only GET and retire overlay only after a later-requested admitted snapshot. Require a coherent refresh before another revisioned rename/remove. Persist overlay separately if restart retention is promised. Never replay mutations. Cover both PATCH/GET orders, refresh failure, next mutation, deletion/purge, disk failure and valid navigation. iOS Home summary response ownership also needs the Android225-equivalent acceptance audit; cache deletion fencing alone does not establish request-versus-detail ownership.
