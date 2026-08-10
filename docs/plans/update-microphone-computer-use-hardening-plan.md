# Update, Microphone, and Computer Use Hardening

Status: Partial

## Goal

Restore automatic updates from the 0.27 beta line, make microphone capture reliable in signed macOS builds, and remove the provider-schema failure blocking Computer Use.

## Phase 1 — Independent triage (complete)

- Confirmed the public `latest-mac.yml` named a ZIP that GitHub did not publish under that name.
- Confirmed signed app and Renderer helper entitlements omitted macOS audio-input access.
- Confirmed tuple coordinates emitted array-valued JSON Schema `items`, rejected by Moonshot-flavored validators.
- Kept missing provider `finish_reason` fail-closed because accepting a truncated stream could make an incomplete tool call actionable.

## Phase 2 — Release and runtime fixes (complete)

- Use stable, space-free macOS ZIP and DMG artifact names.
- Bind update metadata to one exact version, ZIP basename, and recomputed SHA-512 before release promotion; keep assets draft-only until the complete set uploads.
- Prevent stale updater-state reads from replacing newer notifications and display only bounded semantic versions.
- Add audio-input entitlement to the main app and inherited Electron helper entitlements.
- Verify every signed Electron helper has the exact enabled entitlement set and prepare the development runtime with microphone usage copy.
- Preserve actionable microphone permission, missing-device, busy-device, and interruption errors.
- Cancel stale microphone starts and release streams and audio contexts across failures, cancellation, and unmount.
- Publish coordinate arrays with object-valued `items` plus exact two-item bounds while retaining runtime tuple validation, including rejection of sparse arrays.

## Phase 3 — Automated verification (complete)

- TypeScript, lint, focused updater/signing/microphone/Computer Use tests, and the complete test suite pass.
- Three independent adversarial reviews and the parent review covered release, permission, lifecycle, and Computer Use security regressions.

## Phase 4 — Release acceptance (pending)

- The safe 0.28.31 manifest/payload pair was published and direct artifact/range verification passed.
- Installed 0.27.30 acceptance exposed a second updater defect: discovery succeeded, but a detached differential/full download reset and then stalled without progress or failure UI.
- On a clean macOS TCC profile, verify both composer voice input and global dictation after granting microphone access.

## Phase 5 — Observable full-download recovery (implemented; release acceptance pending)

- Replace `checkForUpdatesAndNotify()` with an app-owned check and awaited full-package download.
- Disable differential download because the immutable GitHub release set does not publish the old/new blockmaps required for that path.
- Treat the update as ready only after Electron completes the macOS installer handoff.
- Publish checking, bounded progress, recoverable error, and ready states to Settings → About and the chat sidebar.
- Cancel downloads that make no progress for two minutes, retry with bounded backoff, and retain an explicit Try Again action.
- Preserve the protected quit/restart barrier and ordinary install-on-normal-quit behavior.
- Publish the next immutable release, manually install it on any old build whose updater remains stalled, then verify the following release updates through the repaired in-app path.
