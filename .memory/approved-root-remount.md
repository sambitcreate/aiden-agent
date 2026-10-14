# Approved-root remount drift (Bots: "A selected Bot file location changed")

2026-10-13. After a Mac reboot, every turn on a full-access Bot failed with
"A selected Bot file location changed and must be reviewed." Live data: the
approved Remote root `/Users/<user>` was persisted with `device` 16777231 while
`stat` now reported 16777234 (same path, same inode). macOS assigns APFS
`st_dev` at mount time, and `resolveBotRuntimeApprovedRoots` required an exact
device match. The phone folder browser (`aiden-remote-workspace-browser.ts`)
had the same exact pin, so `listRoots` also failed closed. Issue 201
(`issue-201-bot-home-remount.md`) fixed this only for the Bot managed home and
left these pins unchanged.

Fix: `verifyApprovedRootIdentity` in `aiden-remote-approved-roots.ts` is the
single check for persisted approved roots. It requires the canonical path,
directory type, and inode, and accepts a device change only when the root
shares a device with its parent, so it is not a mount point where another
volume could present the same root inode. It returns the live device. Bot
runtime roots pass that live device to the file-tool pin. The grant's
`scopeFingerprint` still hashes the persisted device, which stays consistent
with the catalog, so no stored-state rewrite and no Bot re-review is needed.

Accepted boundary: same as `sameHomeByInode`. Follow-up for both is a
remount-stable volume identity (`f_fsid` or the APFS volume UUID).

Diagnostics note: `bots-degraded` fingerprints hash only
errorType/code/cause/status, so the log cannot tell which
`BotRuntimeAuthorityError` classification fired.
