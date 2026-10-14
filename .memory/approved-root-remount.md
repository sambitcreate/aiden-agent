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

Fix: `verifyApprovedRootIdentity(root, approvalStore)` in
`aiden-remote-approved-roots.ts` is the single check for persisted approved
roots, used by the desktop Bot runtime, the phone folder browser, and the CLI
Bot runner and browser. It requires the canonical path, directory type, and
inode. It accepts a device change only when the root now lives on the same
volume as `approvalStore`, the directory holding the approval records
(Electron `userData` on desktop, `agentDir` in the CLI). It returns the live
device, which Bot runtime roots pass to the file-tool pin. The grant's
`scopeFingerprint` still hashes the persisted device, consistent with the
catalog, so no stored-state rewrite or Bot re-review is needed.

Review (Pullfrog, PR #474): the first version accepted drift whenever the
root shared a device with its parent. That let a replacement external drive
holding a same-inode folder at `/Volumes/X/Project` inherit the approval. The
approval-store anchor closes that: substituting that volume already means
controlling the approval records, the `sameHomeByInode` rationale. Roots on
any other volume keep the exact device check, so after a reboot they still
need re-approval. The follow-up for both checks is a remount-stable volume
identity (`f_fsid` or the APFS volume UUID).

Diagnostics note: `bots-degraded` fingerprints hash only
errorType/code/cause/status, so the log cannot tell which
`BotRuntimeAuthorityError` classification fired.
