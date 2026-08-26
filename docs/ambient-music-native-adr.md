# Ambient Music native architecture decision

Status: accepted implementation architecture; production acceptance pending  
Date: 2026-08-11

## Decision

Ambient Music runs in a separately signed, arm64, background-only helper app. The helper owns Magenta RealTime's C++ `RealtimeRunner`, MLX/Metal, TensorFlow Lite, SentencePiece, the 48 kHz stereo `AVAudioEngine` graph, and MediaPlayer Now Playing commands. Electron owns the helper process, settings, model installation, and all network access. The renderer owns presentation only.

Model weights are never bundled. Aiden downloads the selected model only after an explicit user action, from the fixed `google/magenta-realtime-2` repository at revision `010aa0dcb0dfd27b24f0ad07b4dad63e8f9521cc`, then verifies every manifest byte count and SHA-256 digest before publishing an install.

## Phase 0 evidence

- Host: Apple Silicon arm64, macOS 26.4.1, Xcode 26.3, AppleClang 17, CMake 4.4.2.
- The helper and the pinned native stack configure and build from `/tmp/Aiden Ambient Music Magenta Build`, exercising MLX's known path-with-spaces edge case.
- The targeted CMake graph builds `magentart_core` and the helper without adding Magenta's AUv3, standalone, Jam, Collider, Max, Pd, SuperCollider, web UI, or example targets.
- Pins: Magenta RealTime `v2.0.3` / `694a545e4ba0b88bf1150137b129582166d3e07f`, MLX `v0.31.1`, TensorFlow Lite `v2.21.0`, SentencePiece `v0.2.0`.
- The linked helper is a thin arm64 executable. Its development binary is about 24 MB before bundle resources and signing; `mlx.metallib` is generated separately and must be colocated with the helper executable.
- A muted self-test starts and stops an `AVAudioEngine` source node at 48 kHz stereo and registers Now Playing play, pause, toggle, and stop commands without needing model files.
- The newline-delimited JSON protocol rejects oversized, malformed, unsupported-version, unknown-method, invalid prompt, invalid weight, invalid volume, and unsupported-model requests.
- Prompt mixing is bounded to one through six non-empty text prompts. Weights are normalized inside the helper before reaching `RealtimeRunner`.
- Pausing ramps output down over approximately 60 ms, then sets `RealtimeRunner` bypass. Upstream bypass silences output and makes the inference loop sleep in 10 ms increments.
- The model path is passed by Electron as an Aiden-owned revision install root. The helper derives fixed resource and model-relative paths and accepts only `mrt2_small` or `mrt2_base` identifiers.

## Blocking acceptance work

Phase 0 intentionally performed no weight download without a user action. The helper is now part of the reviewed native build/package/signing pipeline so package contracts can be tested without model files. Real Small-model playback, long-soak underrun metrics, unified-memory/energy measurements, contention with a local chat model, physical Control Center/headset acceptance, and distribution notarization still require the explicit user-authorized model-install flow. They remain release blockers, not assumptions; packaging the weight-free helper is not evidence that those physical gates passed.

The public upstream `set_audio_prompt(path)` is a deterministic placeholder. Version one therefore supports text prompt mixing only; reference-audio conditioning is excluded until decoded, resampled samples can be passed to `set_audio_prompt_samples` with an independently tested license/privacy flow.

## Rejected alternatives

- Loading the native inference stack into Electron: rejected because native crashes, Metal lifetime, audio realtime work, and unified-memory pressure would share the main process.
- Python sidecar: rejected because it increases bundle/runtime complexity and is unnecessary for the supported C++/MLX path.
- Electron global media-key shortcuts: rejected because they compete with system playback ownership and cannot provide correct Now Playing metadata.
- Bundled model weights: rejected because of application size, user choice, update cost, and the explicit CC BY 4.0 asset contract.
