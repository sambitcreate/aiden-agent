# Updater shutdown ownership — 2026-09-19

A pending updater feed check could complete after `cleanupApplication()` disposed
AppUpdateService and start a new download during the remaining quit drain. Pending
downloads could also publish ready/error state and open a manual result dialog
after shutdown. Disposal is now terminal for both service and controller; each
async completion and subscriber-notification boundary checks ownership before
starting more SDK work or publishing state. Disposed checks return the existing
`unavailable` outcome. No renderer or wire contract changes.

Preserve an already-ready snapshot: protected shutdown calls cleanup before
`installDownloadedUpdateAndRestart()`. Suppressing new work must not disable that
completed installer's handoff. No version, signing, release, or platform change.

## Evidence and references

- Baseline origin/main: 5cc831a17aa8971fb5b89c7dd9278a6ec4022beb.
- Real service bundled against a simulated updater/platform: baseline starts one
  unwanted download after dispose; late success/failure returns ready/failed.
  Three behavioral service regressions failed before the fix and pass after it.
- Waku `src/updater.rs`, 6d433e875d57091906ec0770d8bb9ffc9aa29b83,
  GPL-3.0: download, extraction and installer lifecycle are distinct.
- OMP `packages/coding-agent/src/cli/update-cli.ts`,
  f97fa5c95010b62ac34c7357f9a1cae6975e12d6, MIT: own update attempts and
  serialize shared installation transitions.
- Hermes `apps/desktop/electron/update-gate.ts`,
  69ae247cf3dba34a37ab4af8484b96d3559a4fcf, MIT: lifecycle gates must span
  the whole asynchronous critical section.
- Original implementation; no reference code copied. Platform/version gates and
  monotonic bounded progress already had coverage. SDK stall cancellation and
  signed installer acceptance are separate from this shutdown fix.

## Validation

Extended existing CI-registered `app-updater-core.test.ts` with deferred feed and
download settlement, late errors/progress, reentrant disposal, terminal service
start/check behavior, and completed restart handoff. `npm run test:branding`,
shared updater tests, `npm run type-check`, and lint validate the scoped change.
No live downloads or installed-app changes. Hosted exact-head CI, central review,
and signed macOS acceptance remain separate gates.
