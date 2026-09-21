# Issue 201: Bot managed-home remount

2026-09-21. The stored manifest and private receipt still require exact
agreement, including device and inode. During live inspection, `st_dev` is
treated as mount-volatile only when the inode matches and the home, receipt,
homes anchor, receipts anchor, and private root remain on one owned volume.
The live incarnation is returned to the caller, so revalidation of an
already-resolved handle still detects a directory swap. No metadata rewrite
or private userData migration is required.

Journal reconciliation publishes the receipt's durable incarnation even
when the live device differs, then returns a freshly inspected live token.
This avoids a partially provisioned home becoming permanently inconsistent
after a remount.

Tests synthesize prior mount-device metadata, then confirm restart, list,
resolve, and revalidation, plus rejection of mismatched persisted copies
and the existing real directory-replacement cases. A separate test covers
receipt-before-manifest crash recovery after remount. Scope is the Bot managed
home only; unrelated device pins are unchanged.

Validation: 447 Bot TypeScript tests via `npm --ignore-scripts run test:bots`,
type-check, lint, and diff whitespace pass. The ordinary pretest cannot build
its native inbox writer on this host's mismatched CLT SDK; native-dependent
pretests remain unverified.
