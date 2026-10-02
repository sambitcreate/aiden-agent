# Dictation: Parakeet lifecycle, activation modes, and custom dictionary

Status: Complete — merged in [PR #279](https://github.com/sambitcreate/aiden-agent/pull/279) on 2026-09-30; on main after 0.51.0, not yet released. VAD, history and mute remain later work; real-hardware acceptance is still pending.

This is the first slice of the Handy-inspired P1 dictation work. VAD, dictation history, and mute-while-recording come later.

## Parakeet idle unload and warm-up

- `ParakeetIdleUnloader` (`main/services/parakeet-idle-unload.ts`) counts in-flight model work as leases. After the last lease ends, it starts a countdown using **Settings → Voice → On-Device Engine → Free memory when idle**. The choices are Never, 2, 5, 10 (the default), 15, 30, or 60 minutes.
- Unloading kills the Parakeet utility process. That is the only reliable way to return sherpa-onnx native memory. In-process fallback recognizers are released instead.
- Status probes also take a lease, so a worker spawned only for a status check still gets reaped.
- An async idle-period read that races a new lease cannot arm the timer. Changing the setting re-arms the countdown immediately.
- Warm-up uses a new `warm` worker message (`{kind, requestId, modelId, modelDirectory}`). It runs through the same transcription lane, so it never overlaps a transcription.
- The global shortcut warms the model when a press starts from idle. The composer microphone warms it when capture starts, through `localVoice:warm`.
- Warm-up is best effort. The transcription that follows reports any actionable error.
- The parent and worker ship in the same bundle, so the protocol version stays at 1.

## Activation modes

- `dictationActivationMode` is one of `toggle`, `hold`, or `hybrid`. The Settings label for `hybrid` is "Tap or hold".
- `dictationHoldToTalk` stays the persisted "must report key releases" flag, which the Linux portal binding already uses. Choosing a mode sets that flag. A legacy boolean alone leaves the stored mode unchanged.
- In hybrid mode the key watch starts at press time. A release within 300 ms of key-down counts as a tap and latches recording on, so the next press stops it. A longer hold behaves as push-to-talk. Timestamps are taken when the call happens, not when it is dequeued, so a slow pill does not turn a hold into a tap.
- If the release watch fails in hybrid mode, recording latches as toggle and the pill shows "Press the shortcut again to stop."
- Hosts that cannot report releases resolve every mode to toggle.

## Custom dictionary

- Each entry is `{from, to}`, where an empty `to` means "write `from` as typed". Limits are 200 entries and 100 characters per term. Entries are de-duplicated case-insensitively, and re-adding a word updates its replacement.
- The dictionary is applied in one pass after optional LLM cleanup:
  - matching is case-insensitive, with Unicode whole-word boundaries;
  - longest phrases win;
  - whitespace inside a phrase matches any run of whitespace;
  - replacements are never re-scanned.
- It applies to global dictation (main process) and composer microphone transcripts (renderer). A failing dictionary keeps the original transcript.
- The editor is **Settings → Voice → Custom Dictionary**.

## Verification

- `npm run test:voice` covers:
  - the idle-unload timer;
  - hybrid, hold, and toggle state machines;
  - warm-up;
  - dictionary application and parsing;
  - settings patch validation;
  - the dictionary editor view.
- `config-store-core.test.ts` covers hand-edited preference normalization.
- Real-hardware acceptance is still open: macOS hold timing, the Linux portal, and memory reclaimed after unload.

## Later

- VAD trimming, dictation history, and muting other audio while recording.
- Applying the dictionary to Remote (iOS/Android) Mac-side Parakeet transcription, and syncing it to the native clients' on-device dictation.
