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

## Review resolution: the remount boundary is an approved assumption

Pullfrog (head `3caae7d3`) required either a remount-stable volume identity or
an explicitly documented and tested trust assumption. The documented assumption
is the reviewed choice for this patch: `sameHomeByInode` in
`bot-managed-workspace.ts` and `sameHomeAcrossRemount` in
`bot-managed-workspace-core.ts` now state it in code, and the remount
regression names it.

- Accepted by design: a different private volume mounted at the private root
  that presents the persisted home inode, because the durable manifest and
  receipt that identify the home live inside that same root, so a substituting
  actor already controls every record that could identify it.
- Still rejected, each with coverage: inode changes, symlinked roots, foreign
  or unowned directories, non-canonical home paths, mismatched persisted
  copies, and resolve-to-effect directory swaps. Widened modes on owned
  directories and metadata files are repaired to private permissions before
  use; resolution fails if that repair fails.
- Follow-up to restore detection: a remount-stable volume identity, i.e. the
  `statfs` `f_fsid` field or the APFS volume UUID. Node's `fs.statfs` exposes
  only type/bsize/blocks/bfree/bavail/files/ffree, so this needs a native probe
  following the existing helper pattern, or a `diskutil info -plist`
  subprocess; both exceed a patch release's intended scope.
- Code-path review only: a freshly acquired `BotInboundAttachmentHomeLease`
  carries the live device/inode token to the native inbox writer, and the inbox
  flow revalidates before invoking and after completing that writer. A remount
  after lease acquisition changes that live token and fails closed; the caller
  must acquire a fresh lease. TypeScript tests synthesize prior-mount metadata,
  but native-dependent pretests and a real remount end-to-end remain unverified
  on this host.
