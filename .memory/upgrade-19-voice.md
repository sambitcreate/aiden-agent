# Voice batch timeout ownership — 2026-09-19

## Finding and implementation

At baseline `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`, composer and dictation pill deadlines cancelled main-process transcription but did not abort renderer audio conversion. A FileReader or offline-resampling callback completing afterward could submit a new request after the cancellation had already found no active operation.

`transcribeBlob` now owns the existing provider-specific wall-clock deadline across conversion and IPC. Timeout aborts a renderer-owned signal before issuing best-effort main cancellation. The signal is combined with caller cancellation, retaining unmount/cancel fencing. Both callers retain their Live deadlines and consent flow but delegate batch deadlines to this shared boundary. No wire, native client, UI layout, onboarding or feature-inventory change.

## Reference study

- `omp` at `f97fa5c95010b62ac34c7357f9a1cae6975e12d6`: `crates/pi-voice/src/audio.rs` (MIT; SHA-256 `dec55fdb946692e7621efc006defa51db6bf085127a2c3b551e3ed202553da0a`). Mark stopped before resource teardown; delayed audio callbacks inspect terminal state.
- `hermes-agent` at `69ae247cf3dba34a37ab4af8484b96d3559a4fcf`: `hermes_cli/voice.py` (MIT; SHA-256 `547bf7ba75b7e4a174890c722b8f526c16cb734725c983403d637286a4c2dcf9`). stop_continuous invalidates active state and callbacks before releasing capture.
- `pi` at `2a9b4ebc680053c64e31f635b0b22d5e22564001`: `packages/agent/src/agent.ts` (MIT; SHA-256 `25b52fda7c8fa09d4d5cc8bcbb04db63e9d785b978c846d8c59a367ba91fe045`). Run lifetime owns its abort signal across asynchronous execution.

Original Aiden implementation; no upstream source copied. Rejected hypotheses: stale microphone startup already stops late streams; queued Parakeet cancellation already has independent lane ownership/tests; new microphone selection would expand scope.

## Validation and limits

- Original baseline core plus original caller deadline composition fails all three new late-conversion dispatch regressions (OpenAI, Gemini and local).
- `npm run test:voice`: 81 passed, including deferred conversion, successful completion, caller abort and stuck IPC cancellation cases. Extended the already-registered voice-recorder-core test file.
- `npm run type-check`, scoped ESLint and `npx vite build` passed.
- Hosted exact-head CI and central review remain separate gates.
- Browser decode/resampling is not forcibly interrupted; completion cannot dispatch late transcription. Physical microphone, OS permission and credentialed-provider acceptance were not exercised.

## Pullfrog synchronous-encoding correction

Pullfrog thread `PRRT_kwDOTctvDc6j9r2f` identified that synchronous encoding can cross the deadline while the timer callback is blocked. Reproduced on `b4c69ecd` with deterministic clock advancement inside base64 encoding (PCM/WAV paths) and FileReader result delivery (OpenAI): six expired-boundary cases dispatched unexpectedly.

Batch deadlines now use `performance.now()` and check remaining time immediately before each provider IPC. Explicit expiry and timer expiry share one idempotent abort/cancel path and the canonical timeout error. This preserves cancellation of already-started requests, observes best-effort cancellation failures, and prevents wall-clock jumps from shortening or extending the elapsed budget. Nine new cases cover just-before, exact and past expiry for all three providers, with opposing wall-clock jumps and no timer advancement during encoding.

Validation: 90 voice tests, type-check, scoped ESLint, renderer Vite build and diff checks passed. Hosted CI and central re-review remain pending for the corrected head.
