# Aiden Live voice upgrade, PR 1 (2026-11-06)

Plan: `docs/plans/aiden-live-voice-upgrade.md`. PR 1 is the ribbon pill, voice, speaking speed and goodbye.

## Where things live
- Ribbon UI: `renderer/components/assistant/live-ribbon.tsx` (states, menu), `live-ribbon-wave.tsx` (canvas), `use-live-ribbon-placement.ts` (drag, per-window offset in localStorage), `live-ribbon-session.ts` (end_session renderer tool and the exact end phrase). Mounted by `assistant-dock.tsx` while `live.active`.
- Voice: `GeminiLiveService` option `resolveVoice`, read each start; `protocol.ts` puts it in `speechConfig`.
- Speed: `renderer/lib/live-time-stretch.ts` (WSOLA) inside `PcmPlayer`; `flush` resets the stretcher.
- One utterance per user turn: `use-assistant-live.ts` joins input caption pieces and publishes on Google's `finished` (the caption event's optional `finished: true`), Live's first output, `turn`, a tool request, or 2 s of quiet (`utteranceQuietMs` dependency in tests). Approval receipts take their id at the first piece.

- Review fixes (2026-11-06): speech that starts while Live's reply is open (`liveReplyOpen`) ends only on `finished` or the quiet timer; `PcmPlayer.endOfReply()` on `turn` plays the stretcher's held tail (or after 250 ms without audio); `playbackState()` reports `bargeIns`, which a resumption's `pauseAndFlush` does not bump; goodbye waits take an `answerPending` check from the dock; the ribbon placement measures the whole section.

## Decisions
- The pill stays dark glass in light themes (`--live-glass-*` tokens). Spectrum colours are `--live-spectrum-1..5`.
- Esc ends Live only with focus inside the pill. End is hidden while the pill shows answer buttons.
- The ribbon root carries `data-live-guard="you"`; Live must never press inside it (PR 4).
- An approval's `allow` is optional (PR 3); without it the ribbon offers only Deny.

## Screenshots without the full app
A scratch Vite root that imports `renderer/styles.css` and renders `LiveRibbon` with `idleLiveController` from `assistant-live-test-fixture.ts`, served from the repo cwd so Tailwind scans the sources. Launch Electron through Playwright `_electron` with `--force-device-scale-factor=2`, under `xvfb-run -a -s "-screen 0 2560x1600x24"` (the default screen clamps the window). Move the mouse off onboarding tiles, or the hover description hides the art.
