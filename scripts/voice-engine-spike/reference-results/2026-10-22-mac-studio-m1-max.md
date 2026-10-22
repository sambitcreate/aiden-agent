# Aiden voice engine spike: Mac Studio, M1 Max

This is the run that picked the phase 2 engine, kept for comparison. It was produced by `node bench.mjs` from commit 683126da on 2026-10-22 between 05:13 and 05:19 UTC, with nothing heavy running alongside it.

Machine: Mac Studio (Mac13,1), Apple M1 Max with 8 performance and 2 efficiency cores, 64 GB, on AC power, macOS 27.0 (26A428), Node v22.23.4.

That commit predates two fixes, so read the tables with these in mind:
- The `Footprint MB` column was measured after every decode had run, so it includes inference buffers.
- transcribe.cpp's `Load ms` does not include `createSession`.

The footprints measured right after load were:

| Config | Footprint after load, MB |
|---|---|
| sherpa-v3-cpu2 | 1136 |
| sherpa-v3-cpu4 | 1130 |
| sherpa-v3-coreml | 1148 |
| tcpp-v3-metal | 897 |
| tcpp-v3-cpu4 | 1179 |
| tcpp-unified-en-metal | 828 |
| tcpp-nemotron35-metal | 938 |
| sherpa-nemotron-en-cpu4 | 1127 |
| sherpa-nemotron35-cpu4 | 1157 |

The first Metal config (`tcpp-v3-metal`) paid a one-time Metal init of 4.9 s. Each config runs in its own process, and every later Metal config initialised in about 55 ms. sherpa's Core ML provider logged 11 "Context leak detected, CoreAnalytics returned false" lines; they did no harm.

## Load and memory

| Config | Backend | Init ms | Load ms | RSS after load MB | Footprint MB | Peak RSS MB |
|---|---|---|---|---|---|---|
| sherpa-v3-cpu2 | sherpa 1.13.8 | – | 885 | 1181 | 1534 | 1580 |
| sherpa-v3-cpu4 | sherpa 1.13.8 | – | 857 | 1175 | 1451 | 1644 |
| sherpa-v3-coreml | sherpa 1.13.8 | – | 5580 | 1205 | 4676 | 7710 |
| tcpp-v3-metal | MTL0 (MTL0) | 4875 | 241 | 968 | 1006 | 1087 |
| tcpp-v3-cpu4 | CPU (CPU) | 53 | 290 | 1249 | 1270 | 1457 |
| tcpp-unified-en-metal | MTL0 (MTL0) | 55 | 233 | 899 | 867 | 945 |
| tcpp-nemotron35-metal | MTL0 (MTL0) | 57 | 262 | 1009 | 983 | 1055 |
| sherpa-nemotron-en-cpu4 | sherpa 1.13.8 | – | 1055 | 1172 | 1168 | 1214 |
| sherpa-nemotron35-cpu4 | sherpa 1.13.8 | – | 711 | 1202 | 1182 | 1228 |

## Offline: release-to-text decode (median ms, first decode after load in brackets)

| Config | tts-3s | tts-10s | tts-30s | ls-0 | ls-1 | mean WER |
|---|---|---|---|---|---|---|
| sherpa-v3-cpu2 | 162 (169) | 378 (385) | 1220 (1241) | 298 (291) | 721 (724) | 0.036 |
| sherpa-v3-cpu4 | 119 (119) | 263 (274) | 810 (836) | 204 (207) | 487 (482) | 0.036 |
| sherpa-v3-coreml | 247 (746) | 545 (732) | 1740 (2569) | 420 (621) | 1032 (1272) | 0.036 |
| tcpp-v3-metal | 64 (460) | 115 (129) | 388 (351) | 95 (101) | 192 (219) | 0.022 |
| tcpp-v3-cpu4 | 178 (181) | 420 (413) | 1393 (1387) | 318 (331) | 821 (818) | 0.022 |
| tcpp-unified-en-metal | 63 (79) | 119 (113) | 285 (288) | 99 (105) | 254 (449) | 0.004 |

Clip lengths: tts-3s 3.5 s, tts-10s 8.8 s, tts-30s 26.9 s, ls-0 6.6 s, ls-1 16.7 s. sherpa's int8 v3 heard "pin chats" for "pinned chats" and "brothers" for "brothels"; transcribe.cpp's Q8_0 v3 got both right.

## Live text: words while speaking, then release-to-text

stream = 100 ms chunks into a streaming model. redecode = an offline model re-reads everything heard so far every 500 ms. Update cost must stay under the update interval, and busy % under 100, to keep up with speech.

| Config | Mode | Clip | Update every ms | Update cost p50 / max ms | Busy % | First word at (audio ms) | Shown at release | Finalize ms | WER |
|---|---|---|---|---|---|---|---|---|---|
| sherpa-v3-cpu4 | redecode | tts-3s | 500 | 83.6 / 121 | 16 | 500 | – | 117 | 0.091 |
| sherpa-v3-cpu4 | redecode | tts-10s | 500 | 152.5 / 266 | 29 | 500 | – | 471 | 0 |
| sherpa-v3-cpu4 | redecode | tts-30s | 500 | 427 / 966.5 | 83 | 500 | – | 806 | 0.011 |
| sherpa-v3-cpu4 | redecode | ls-0 | 500 | 113.7 / 204.2 | 23 | 500 | – | 202 | 0.056 |
| sherpa-v3-cpu4 | redecode | ls-1 | 500 | 261.2 / 510.5 | 52 | 1000 | – | 487 | 0.021 |
| tcpp-v3-metal | redecode | tts-3s | 500 | 77.6 / 305.1 | 27 | 500 | – | 64 | 0.091 |
| tcpp-v3-metal | redecode | tts-10s | 500 | 73.4 / 126.6 | 15 | 500 | – | 123 | 0 |
| tcpp-v3-metal | redecode | tts-30s | 500 | 167.7 / 546.1 | 37 | 500 | – | 316 | 0 |
| tcpp-v3-metal | redecode | ls-0 | 500 | 66.7 / 92 | 12 | 500 | – | 95 | 0 |
| tcpp-v3-metal | redecode | ls-1 | 500 | 107.6 / 323 | 25 | 1000 | – | 340 | 0.021 |
| tcpp-v3-cpu4 | redecode | tts-3s | 500 | 128.4 / 332 | 28 | 500 | – | 211 | 0.091 |
| tcpp-v3-cpu4 | redecode | tts-10s | 500 | 236 / 407.9 | 44 | 500 | – | 412 | 0 |
| tcpp-v3-cpu4 | redecode | tts-30s | 500 | 674.2 / 1502.8 | 136 | 500 | – | 1398 | 0 |
| tcpp-v3-cpu4 | redecode | ls-0 | 500 | 173.1 / 317.5 | 34 | 500 | – | 314 | 0 |
| tcpp-v3-cpu4 | redecode | ls-1 | 500 | 426.6 / 806.5 | 84 | 1000 | – | 830 | 0.021 |
| tcpp-unified-en-metal | stream | tts-3s | 100 | 0 / 51.7 | 3 | 2100 | 55% | 127 | 0.091 |
| tcpp-unified-en-metal | stream | tts-10s | 100 | 0 / 78.1 | 5 | 2100 | 83% | 85 | 0 |
| tcpp-unified-en-metal | stream | tts-30s | 100 | 0 / 87.1 | 6 | 2100 | 93% | 81 | 0 |
| tcpp-unified-en-metal | stream | ls-0 | 100 | 0 / 65.6 | 4 | 2100 | 83% | 68 | 0 |
| tcpp-unified-en-metal | stream | ls-1 | 100 | 0 / 79.2 | 6 | 2100 | 96% | 82 | 0.063 |
| tcpp-nemotron35-metal | stream | tts-3s | 100 | 0.2 / 39.6 | 4 | 1100 | 100% | 24 | 0 |
| tcpp-nemotron35-metal | stream | tts-10s | 100 | 0.2 / 60 | 4 | 1100 | 90% | 64 | 0 |
| tcpp-nemotron35-metal | stream | tts-30s | 100 | 0.2 / 58.8 | 4 | 1100 | 100% | 54 | 0.011 |
| tcpp-nemotron35-metal | stream | ls-0 | 100 | 0.2 / 37.9 | 3 | 1100 | 89% | 36 | 0.056 |
| tcpp-nemotron35-metal | stream | ls-1 | 100 | 0.2 / 39.2 | 3 | 1100 | 94% | 34 | 0.042 |
| sherpa-nemotron-en-cpu4 | stream | tts-3s | 100 | 35 / 44.3 | 22 | 1100 | 100% | 141 | 0.182 |
| sherpa-nemotron-en-cpu4 | stream | tts-10s | 100 | 35.2 / 44.3 | 23 | 600 | 100% | 141 | 0.033 |
| sherpa-nemotron-en-cpu4 | stream | tts-30s | 100 | 34.8 / 72.1 | 24 | 800 | 100% | 143 | 0.011 |
| sherpa-nemotron-en-cpu4 | stream | ls-0 | 100 | 34.6 / 43.6 | 22 | 800 | 100% | 139 | 0 |
| sherpa-nemotron-en-cpu4 | stream | ls-1 | 100 | 34.8 / 81.8 | 24 | 1100 | 100% | 179 | 0 |
| sherpa-nemotron35-cpu4 | stream | tts-3s | 100 | 37.1 / 59.9 | 26 | 1100 | 100% | 141 | 0.182 |
| sherpa-nemotron35-cpu4 | stream | tts-10s | 100 | 33.7 / 50 | 22 | 800 | 100% | 135 | 0.033 |
| sherpa-nemotron35-cpu4 | stream | tts-30s | 100 | 33.5 / 46.5 | 23 | 800 | 100% | 135 | 0.034 |
| sherpa-nemotron35-cpu4 | stream | ls-0 | 100 | 33.8 / 60.6 | 24 | 1000 | 100% | 139 | 0 |
| sherpa-nemotron35-cpu4 | stream | ls-1 | 100 | 33.6 / 51.2 | 22 | 1100 | 100% | 170 | 0.042 |

Both sherpa Nemotron streams dropped the first word of every TTS phrase ("Please", "I", "Here"). The tcpp Nemotron 3.5 stream misplaced one sentence boundary in tts-30s and heard "broffles" for "brothels".

## Follow-up run, 05:27 UTC, with the fixed script

I re-ran `tcpp-v3-metal` and `tcpp-nemotron35-metal` with `--runs 3`, using the cached models:
- `sessionMs` was 0 for both. Load time is all model loading: 273 ms and 284 ms.
- Footprint after load was 888 MB and 937 MB.
- Metal init took 65 ms and 55 ms. The first decode of tts-3s took 87 ms, against 460 ms in the first run.

The 4.9 s init and the slow first decode in the first run therefore came from compiling Metal shaders on a cold cache. macOS keeps those shaders cached afterwards. Medians matched the first run: tts-3s 65 ms, tts-30s 321 ms, and re-decoding stayed at or under 35% busy.
