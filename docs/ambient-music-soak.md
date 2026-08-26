# Ambient Music installed-model soak

This opt-in acceptance harness exercises the already-downloaded native helper without downloading anything. It uses one fixed instrumental prompt in memory, never records audio, and writes only aggregate performance/lifecycle counters. The receipt contains no prompt text, helper path, model path, or device identity.

Run the production acceptance after explicitly downloading and verifying a model in Aiden:

```sh
npm run ambient-music:soak -- \
  --helper "/path/to/Aiden Ambient Music Helper.app/Contents/MacOS/aiden-ambient-music-helper" \
  --model-root "/path/to/Ambient Music/revisions/010aa0dcb0dfd27b24f0ad07b4dad63e8f9521cc" \
  --model mrt2_small \
  --output "/tmp/aiden-ambient-music-soak.json"
```

Defaults are four hours of active generation with a pause/resume cycle every ten minutes, followed by a system-style suspend, a verified native idle unload after five minutes, and the remainder of an eight-hour unloaded window. Override `--active-ms`, `--paused-ms`, `--sample-ms`, `--cycle-ms`, `--idle-unload-ms`, or `--min-idle-reclaim-mb` only for development. The production gate requires at least 128 MiB of RSS reclamation after idle unload.

The harness fails closed unless the helper reports the pinned protocol/build identity and exact authoritative playback result for load, play, pause/resume, suspend, and idle unload. Event and playback revisions and cumulative dropped-frame counters must increase monotonically. Active generation must show positive inference timings and process CPU-time deltas; two consecutive samples with a frame time of at least 40 ms, less than 25% buffer availability, or any dropped frame fail the receipt. Unexpected or repeated state events also fail it.

Every resource sample includes RSS, cumulative CPU time, and a helper-process TCP/UDP socket check. A sampling error or observed socket aborts the run immediately. Both peak and final RSS growth must stay within 1 GiB of the post-load baseline, idle unload must reclaim the configured minimum, and paused CPU must remain at or below 10%. CPU spent unloading the model is excluded from the paused hot-loop measurement. Startup readiness, every request, and shutdown are time-bounded; stderr is bounded to 4 MiB and protocol lines are bounded. Every failure uses bounded TERM→KILL escalation and verifies process exit.

The receipt records aggregate frame, buffer, peak/final/reclaimed memory, phase-specific CPU, network-observation, sustained-pressure, idle-unload, event, and exit counters only. Receipt keys are allowlisted and values are scalar; prompts, audio, paths, endpoints, and device identity are never written. The narrow automated suite separately drives the Electron-owned service through sleep/wake, route recovery, the remote-play/idle-unload boundary, crash recovery, and bounded quit. The long harness drives the same helper protocol directly so it can remain renderer-free and offline.

Passing the automated harness means the implementation gate is complete; it does not complete production acceptance by itself. Physical media-key, Control Center, Bluetooth/headset, signing, notarization, and the real Small-model four-hour/overnight receipt must be recorded separately on the packaged build after the user-authorized model download. Never automate a model download as part of this soak.
