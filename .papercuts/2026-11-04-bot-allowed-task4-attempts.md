# Task 4 approval attempts

- Initial RED: `/tmp/bot-allowed-d-task4-red.log`, 47 pass, 7 fail, 5 cancelled. Missing lookup behavior left test waits unresolved; cancellations are API-gap evidence, not claimed behavioral failures.
- Restart fixture setup initially missed the existing authority helper's real home directory requirement (ENOENT); repaired the fixture, not authority checks. Transform/setup failures are excluded from behavioral RED evidence.
- Behavioral RED `/tmp/bot-allowed-d-task4-unnamed-red.log`: unnamed input D eligibility accidentally depended on the optional C port. Map durable input identities for every approval check instead; no coverage reservation is involved.
- Behavioral RED `/tmp/bot-allowed-d-task4-retransmit-red.log`: same-pair retransmission could replace an already answered in-flight request before receipt bookkeeping. Share its in-flight structured result; keep changed-fingerprint replacement separate.
- Behavioral RED `/tmp/bot-allowed-d-task4-projection-red.log`: spreading the optional public offer could copy extra private fields. Project its key/count explicitly, including nested offer data.
- Parent audit behavioral RED `/tmp/bot-allowed-d-task4-publication-red.log`: pending Always after page/Ask-rule drift published to the real book before the post-settlement fingerprint check. Preflight exact current evidence; pass a separate revocable pure publication guard for the atomic first-publication boundary.
- Follow-up test typing: project lib excludes Object.hasOwn despite current Node support; used hasOwnProperty.call. The focused behavioral run was already green; this was a test compatibility error.
