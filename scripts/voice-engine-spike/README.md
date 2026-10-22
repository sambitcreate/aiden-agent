# Aiden voice engine spike

A throwaway benchmark for phase 2 of the [voice dictation speed plan](../../docs/plans/voice-dictation-speed-plan.md). It compares sherpa-onnx, the engine Aiden ships, with transcribe.cpp (ggml, the engine Handy moved to in v0.9.0) on the same clips. It runs each engine offline and as a live stream.

It is not part of the app. It is not bundled, and the root `npm install` does not install it.

## Run it on the Mac

```sh
cd scripts/voice-engine-spike
npm install            # sherpa-onnx-node 1.13.8 (Aiden's pin) and transcribe-cpp 0.4.0
node bench.mjs --list  # configs and their downloads
node bench.mjs         # about 3.5 GB of pinned downloads on the first run, then 10 to 20 minutes
```

Plug the Mac in and quit heavy apps first. Aiden can stay open, but do not dictate while the benchmark runs. The script reuses Aiden's installed Parakeet v3 from `~/Library/Application Support/Aiden Agent/voice-models/parakeet-v3`. Other models download into `~/.cache/aiden-voice-spike` and are checked against a pinned size and SHA-256.

Options:

- `--only id,id` runs some configs only.
- `--runs N` sets the number of timed decodes per clip (default 5, after one untimed decode).
- `--clips DIR` adds your own recordings: `name.wav` files with an optional `name.txt` reference transcript.
- `--cache DIR` and `--sherpa-model DIR` change where models are read from.

Results go to `results/<time>.md` (tables) and `results/<time>.json` (every number and transcript). `reference-results/` keeps the run that picked the phase 2 engine.

## What it measures

Clips:
- three dictation-style phrases spoken by macOS `say` at about 3, 10 and 30 seconds;
- two LibriSpeech recordings, about 7 and 17 seconds, with reference transcripts;
- any recordings you add with `--clips`.

| Config | What it is |
|---|---|
| `sherpa-v3-cpu2` | Aiden today: sherpa-onnx, Parakeet TDT v3 int8, 2 CPU threads |
| `sherpa-v3-cpu4` | The same with 4 threads |
| `sherpa-v3-coreml` | The same on sherpa's Core ML provider (may not load) |
| `tcpp-v3-metal` / `tcpp-v3-cpu4` | transcribe.cpp, Parakeet TDT v3 Q8_0 (Handy's file), offline and with live re-decoding |
| `tcpp-unified-en-metal` | transcribe.cpp, Parakeet Unified English (Handy's default English streaming model) |
| `tcpp-nemotron35-metal` | transcribe.cpp, Nemotron 3.5 streaming, multilingual |
| `sherpa-nemotron-en-cpu4` / `sherpa-nemotron35-cpu4` | sherpa-onnx streaming Nemotron (English, multilingual), 160 ms chunks |

For each config it reports:
- **Load:** time until the engine accepts audio (for transcribe.cpp, model load plus session setup), plus memory after load (RSS, and on macOS the physical footprint, which counts Metal buffers). The footprint after the whole run is shown too, since it includes inference buffers.
- **Offline:** the median decode time per clip. This is the release-to-text cost on a warm model. The first decode after load is shown too.
- **Live text, `stream`:** 100 ms chunks are fed into a streaming model as fast as it takes them. The cost per chunk must stay under 100 ms to keep up with the microphone. It also reports when the first word appears, how much of the text was on screen at release, and the finalize time. Finalize time is the release-to-text cost in live mode.
- **Live text, `redecode`:** an offline model (Parakeet v3, Aiden's multilingual default) re-reads everything heard so far every 500 ms. This shows how long live preview stays affordable without a streaming model. A busy figure over 100% means it falls behind.
- **WER:** word error rate against the reference. Punctuation and case are ignored. British and American spellings count as errors, so compare configs with each other, not with published numbers.
