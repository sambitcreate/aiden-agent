# Bot managed-home remount recovery — 2026-09-21

Production 0.42.0 stopped initializing Bots after the APFS Data volume's live `st_dev` changed while the private home inode and paired receipt/manifest retained their original identity. The Keychain rollback anchor, state digest, and Bot identity/policy inventory still matched. No production profile was edited.

The filesystem adapter now proves the live home, private homes directory, receipts directory, and Bot-service root share one current filesystem. Its durable receipt comparison uses the home inode because a recorded `st_dev` is a mount-session number; manifest and receipt must still match exactly. A returned runtime token captures the current device and inode, and revalidation compares both so a swap between resolution and effect still fails closed. Replaced directories, symlinks, foreign mounts, and mismatched receipts remain rejected. No persisted schema or remote/native contract changed.

The existing managed-workspace test file covers remount recovery, unchanged on-disk records, mismatched records, and strict live revalidation. Installed app data and Keychain records were only read, never repaired or reset; a merged/released update and app restart are needed for production acceptance.

Validation: managed-workspace tests 10/10; registered Bot TypeScript suite 446/446 (with npm lifecycle pretest suppressed); type-check, lint, and diff check pass. The native Bot pretest cannot link against the locally selected Command Line Tools macOS 27 SDK because its `libSystem.tbd` has an architecture unknown to Xcode 26.6. This is a local toolchain gate, not a hosted CI or production acceptance result.
