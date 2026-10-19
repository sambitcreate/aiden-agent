# Compression and image format audit — 2026-10-18

The original read-only audit of `a74edb0f6` covered the Electron renderer and main process, Aiden Remote, iOS, Android, the CLI, checked-in assets, and release packaging. Five GPT-6 Sol high auditors inspected separate surfaces. The implementation follow-up in this PR is recorded below; measurements in the original audit remain baseline probes rather than release-artifact or live-traffic claims.

## Implementation follow-up

Two bounded changes from this audit are implemented in this PR:

| Change | Measured gain | Boundary |
| --- | --- | --- |
| Opt-in gzip for iOS and Android Remote speech uploads, advertised by the host | The complete two-second transcription JSON request is 85,431 B with identity and 55,932 B with gzip level 6: **29,499 B (34.53%) fewer uploaded body bytes**. | Fixture result. Live recording ratios, upload latency, CPU, and battery are not measured. Old hosts continue to receive identity JSON. |
| Minify the desktop model catalog only during macOS/Linux packaging | Source 9,109,569 B to packaged 5,319,504 B: **3,790,065 B (41.6%, 3.615 MiB) fewer installed catalog bytes**. A gzip level 6 per-file proxy saves 126,764 B. | The checked-in source remains readable; no catalog network behavior changes. Per-file compression does not predict the exact installer or update download difference. |

The Remote change preserves the 60-second PCM limit, caps both encoded and decoded JSON, accepts exactly one valid gzip member, and advertises the feature only when speech is wired. The native clients compress only after observing that feature and only when the result is smaller. The package verifier checks the compact catalog at the existing runtime path. See `.memory/remote-speech-compression.md` and `.memory/packaging-size.md` for the implementation contracts.

A macOS arm64 development package passed its after-sign checks and `npm run package:verify`. Its `app.asar` is 91,277,314 B with the 5,319,504 B catalog and zero source maps; the `.app` regular-file payload is 499,075,535 B. These are **post-change artifact sizes**, with no same-head pre-change package for an installer or update-download delta. The desktop Remote route/protocol/operation tests passed 156/156, the broader `test:aiden-remote` and model catalog suites passed, packaging tests passed 47/47, Android JVM tests passed 947/947, and iOS Remote client and Phase 0 classes finished with 144 passed, 5 skipped, 0 failed on an iPhone 17 iOS 26.2 simulator. TypeScript type checking passed.

AVIF, JPEG XL, zstd, and Brotli are retained as measured or proposed experiments in the sections below. Electron's current `nativeImage` API exposes PNG/JPEG thumbnail encoders, and the shared image wire still needs old-client compatibility. The image-storage and thumbnail opportunities need a representative corpus and end-to-end timing before choosing a codec.

## Executive assessment

The best near-term compression experiment is **gzip for mobile speech request bodies**. A committed two-second PCM fixture produces an 85,336-byte base64 request payload that gzip reduces to 56,557 bytes (33.7%). The maximum 60-second request contains 1,920,000 bytes of PCM or 2,560,000 base64 characters, so the benefit could matter on a slow uplink. This requires an explicit request `Content-Encoding` contract and strict limits on both compressed and expanded bytes.

The best image-performance work is **moving historical chat images out of inline JSON and serving sized thumbnails on demand**. That is a storage and IPC change, not a codec swap. AVIF or JPEG XL cannot fix the repeated full-chat rewrites, base64 expansion, or data-URL construction. Studio thumbnails are a narrower place to trial WebP, AVIF, and later JPEG XL on a real generated-image corpus.

The other straightforward installed-size opportunity is the desktop's pretty-printed models.dev snapshot: 8.688 MiB on disk versus 5.073 MiB after whitespace removal. Its bytes already compress extremely well inside distribution archives, so a raw-file change mainly affects installed size and read volume, not download size. The CLI already minifies its copy.

**Do not count existing wins again:** Remote JSON GETs already use gzip above 1 KiB and weak ETags; current iOS and Android clients send `If-None-Match` and accept 304 for authenticated JSON GETs. Renderer text deltas are already coalesced. Source maps and development packages were removed from packaged builds after the older October 3 optimization audit.

| Priority | Candidate | Possible gain | Confidence / scope |
| --- | --- | --- | --- |
| 1 | gzip mobile speech POST | 33.7% fewer bytes on a two-second fixture; planning 20–50% for real recordings | Measured fixture, live recordings unmeasured; changes shared wire contract. |
| 2 | Binary chat image storage and sized views | Planning 25–50% fewer bytes in image-bearing chat JSON/IPC, plus fewer repeated decodes | Architectural estimate, requires workload profile. |
| 3 | WebP/AVIF thumbnail rendition | Two WebP proxy samples saved 52–55%; planning 20–70% for photographic thumbnails | Proxy only; generated-image corpus and decoder support needed. |
| 4 | Minify desktop model snapshot at package time | 3.615 MiB installed; 0.121 MiB less than current gzip 6 per-file proxy | Implemented and verified in a development app; signed release archive not measured. |
| 5 | Optional Brotli for large Remote JSON | 10.6% smaller than gzip on one JSON fixture | Incremental fixture result; existing gzip/304 already strong. |
| 6 | Geometry compression for five GLBs | Unknown; whole-file Brotli proxy saves 5.953 MiB installed vs raw | Static-file proxy; first-view cost and real archive gain unknown. |
| 7 | Existing WebM in place of marketing GIF | 68.4% smaller media files; zero app-installer gain | Measured exports; depends on marketing consumer. |

## Baseline and measurements

At the read-only audit baseline, `git ls-files` reported 4,648 tracked files totaling 99.21 MiB. No local `build/`, `release/`, or `node_modules/` existed then, so the baseline did **not** claim a measured installer, asar, IPA, APK, or production traffic total. The follow-up built a development macOS app, reported above. Earlier `.memory/packaging-size.md` records a 96 MB development asar and 459 MB `.app` on 2026-10-09; those are historical and cannot serve as a same-head before/after comparison.

All sizes below are actual byte counts for checked-in samples. Generic compression tests used gzip level 6, Brotli quality 5, and zstd level 3 unless a row says otherwise. They measure *files in isolation*, not the actual signed distribution or HTTP response. MiB means 1,048,576 bytes. Codec outputs are not visually evaluated.

| Sample | Raw | gzip 6 | Brotli 5 | zstd 3 | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| `resources/model-capabilities.json` | 8.688 MiB | 0.635 MiB | 0.321 MiB | — | Highly repetitive JSON; CLI already uses a minified copy. |
| Same JSON, minified | 5.073 MiB | 0.514 MiB | 0.274 MiB | — | Saves 3.615 MiB installed, only 0.121 MiB against gzip 6. |
| Five bundled device GLBs, compressed separately and summed | 11.518 MiB | 6.607 MiB | 5.565 MiB | 6.402 MiB | Brotli is 1.042 MiB smaller than gzip in this proxy; rendering still needs GLB bytes. |
| Five marketing GIFs | 7.597 MiB | 7.542 MiB | 7.510 MiB | 7.579 MiB | Generic codecs barely affect already compressed GIFs. Existing matching alpha WebMs total 2.398 MiB. |
| Nerd Font WOFF2 | 1.123 MiB | 1.118 MiB | 1.123 MiB | 1.117 MiB | No useful generic recompression. |
| Remote contract fixture JSON | 94,749 B | 18,158 B | 16,230 B | 18,625 B | Brotli saves 1,928 B (10.6%) against gzip on this fixture; this is not a traffic sample. |
| Two-second 16 kHz PCM, base64 encoded | 85,336 B | 56,557 B | 55,082 B | 56,200 B | Brotli saves only 1,475 B against gzip on this speech sample. |

For the catalog, a local Node 22.22.3 microbenchmark gave median `JSON.parse` times of about 30 ms (pretty) and 25 ms (minified) across 15 runs. Brotli 5 decompression of its compressed catalog took about 3–4 ms median. These are machine-local microbenchmarks without file I/O, startup scheduling, or Electron load; they do not prove a first-paint gain. Brotli 11 and zstd 19 reduced the raw snapshot further to 0.220 and 0.224 MiB, respectively, but high offline compression settings are not appropriate for live responses without latency tests.

## Ranked opportunities

### 1. Mobile speech POST: negotiate gzip request bodies

`main/services/aiden-remote-speech-codec.ts:3-15` defines a 60-second, 16 kHz, mono PCM16 limit and base64 JSON envelope. iOS sends it at `ios/AidenOnTheGo/Networking/AidenRemoteClient.swift:2177-2185`; Android does so at `android/app/src/main/java/sbtbiswas/AidenOnTheGo/networking/AidenRemoteClient.kt:2109-2117`. The router currently reads request bodies as UTF-8 JSON without `Content-Encoding` decoding (`main/services/aiden-remote-router.ts:741-790,3184`).

The two-second fixture shows **33.7% fewer request-body bytes with gzip**. A planning range of 20–50% over real speech is plausible but unmeasured; at the 2.56 MB base64 ceiling this corresponds to roughly 0.5–1.3 MB less transfer for a full-length request. gzip is a sensible first candidate because the platform clients already handle it for *responses*. Brotli improves this one speech sample by only 2.6% relative to gzip; zstd is essentially tied.

Implementation requires both clients and the server to agree on request encoding, preserve old-client fallback, reject unsupported encodings, cap compressed and **expanded** body lengths independently, and retain the current 60-second PCM validation. This changes the shared Remote contract; update the protocol fixture and focused server, iOS, and Android tests together. Measure encode time, p95 upload latency, memory, battery, and Tailscale/LAN byte counts with actual recordings before rollout.

### 2. Chat image storage and IPC: remove repeated image bytes

`main/services/attachments.ts:454-485` base64-encodes selected images. `main/services/chat-store-core.ts:905-929` writes compact JSON, but image bodies remain inline and whole chat files are rewritten on append. `main/handlers/chats.ts:187` can return a full chat over IPC, and `renderer/components/message-attachments.tsx:12-20,141-155,248-256,358-364` constructs data URLs for historical images. Base64 expands arbitrary binary by about 33% before JSON and IPC copies; the live impact scales with image count and chat length.

Prefer a content-addressed binary attachment store, metadata-only chat projection, bounded thumbnail URL, and lazy original fetch. Keep the original bytes for model input, save, and copy. **Potential gain:** roughly 25–50% fewer bytes in image-bearing chat JSON/IPC is a planning hypothesis; the real gain depends on the proportion of image data and repeated reads. Benchmark 500-chat and long image-heavy profiles: append p50/p95, bytes written, IPC bytes, renderer heap, decode count, and first-thumbnail time. Changing PNG to AVIF without this architecture would retain the repeated-copy pattern.

### 3. Studio/Create Images: compare thumbnail formats on real output

`main/services/studio-assets/thumbnailer-main.ts:4-23` decodes and resizes with Electron `nativeImage`, then always emits PNG at 256 or 512 pixels. `main/services/studio-assets/store.ts:257-290` caches those PNG bytes, and `main/services/studio-assets/request-handler.ts:42-61` serves them with `cache-control: no-store` under an asset grant. A lossless WebP spot check on two resized committed images reduced 29,012 to 13,770 bytes and 53,824 to 24,134 bytes (52–55%). Those are **not** generated-image samples and the production PNG encoder may behave differently.

Trial WebP first, then AVIF/JPEG XL only where encode/decode support is demonstrated in the packaged Electron builds and both native clients if the format crosses Remote. A 20–70% thumbnail byte reduction for photographic images is an unverified target, not a forecast. Flat art, screenshots, and transparency may favor lossless encodings. Measure source-image classes at 256, 512, and full resolution for bytes, visual quality, encode/decode time, peak memory, and fallback frequency. Preserve the grant lifetime and `no-store` policy while testing.

### 4. Desktop model snapshot: minify the packaged copy

The release refresh intentionally writes readable JSON (`scripts/model-snapshot-core.mjs:116-123`); desktop reads and parses it once through `main/services/models-catalog.ts:12-17` and `main/services/models-catalog-reader.ts:25-31`. `package.json:355-365` packages the source JSON. The CLI already minifies its distribution copy at `packages/cli/scripts/build.mjs:617-622`.

A packaging-time minified desktop copy would save **3.615 MiB of installed asar payload** on this snapshot and perhaps a few milliseconds of local parse work, while preserving the checked-in release artifact and exact model data. It saved only **0.121 MiB after gzip 6** in this sample, so expect little installer or update-download change. Shipping a Brotli-compressed catalog inside the asar could save about 8.37 MiB installed versus the raw file, but it adds a decode and changes the path/read contract; outer ZIP/DMG compression already captures most download benefit. The package verifier reads the JSON by path (`scripts/verify-macos-package.mjs:212-253`), so that contract would need updating. Compare actual signed installers and cold model-info load before choosing between minification and an embedded compressed file. Do not add a catalog network fetch.

### 5. Large Remote JSON GET: benchmark Brotli as an optional encoding

`main/services/aiden-remote-router.ts:631-709` already gzips successful GET JSON of at least 1 KiB when requested, emits `Vary: accept-encoding`, and returns a bodyless 304 on matching `If-None-Match`. Current clients cache validated JSON responses in bounded memory and revalidate (`ios/AidenOnTheGo/Networking/AidenRemoteClient.swift:615-629,2765-2778`; `android/app/src/main/java/sbtbiswas/AidenOnTheGo/networking/AidenRemoteClient.kt:404-429,463-491`). The Remote test at `main/services/aiden-remote-router.test.ts:2935-3006` verifies gzip is under half the identity transcript size. Older `.memory/remote-server-network-efficiency.md` and `docs/performance/optimization-audit-2026-10-03.md` predate the mobile revalidation change; `.memory/native-connection-reliability.md` records it.

Brotli 5 beat gzip 6 by 1,928 bytes on a 94,749-byte *fixture*; zstd 3 was worse. For a real large JSON response, an optional Brotli path may save around 5–15% **relative to already-gzipped bytes**, but that range is not measured on production transcripts. Server negotiation, decoder support, bounded *decoded* bytes, and p95/p99 latency matter more than ratio alone. Keep gzip and identity fallback. First collect endpoint sizes, request frequency, cache/304 hit rate, and post-gzip bytes; the current 304 path can already remove the entire body for unchanged reads.

### 6. Bundled 3D device models: compress the asset representation, then measure load

Five `.glb` files occupy **11.518 MiB** checked in and are fetched lazily (`renderer/lib/device-3d/device-model-assets.ts:9-13`, `renderer/lib/device-3d/model-scene.ts:17-32`). Per-file Brotli 5 would total 5.565 MiB, gzip 6 totals 6.607 MiB, and zstd 3 totals 6.402 MiB. Those are static-file proxies. The `.glb` loader currently receives raw bytes, and outer installers already compress files. Precompressing within the app would require a decode step before `GLTFLoader.parseAsync`, plus memory and first-view latency checks. An independent GLB buffer-view inventory found **10.594 MB non-image data** and **1.155 MB embedded images**; the embedded textures already use `EXT_texture_webp`. Meshopt or Draco geometry compression is therefore a more relevant experiment than AVIF/JXL textures, although the current loader does not configure a geometry decoder. Expected download gain is **unknown** until measured in a real release artifact; installed-byte ceiling is about 6 MiB if Brotli 5 replaces raw files.

### 7. Marketing GIFs: use existing WebM exports where the consumer supports them

Five committed GIF exports total **7,965,630 bytes**; matching existing transparent WebM exports total **2,514,609 bytes**, a measured **68.4% reduction** for a consumer that can use them. Generic gzip/Brotli/zstd barely shrink the GIFs. `marketing/rive/README.md:12-20` describes their roles. Marketing assets are outside the Electron `build.files` allowlist (`package.json:355-365`), so this is **zero Aiden installer gain**. Validate loop, alpha, poster/fallback, and browser playback in the actual marketing destination before changing references. Animated AVIF/JPEG XL has no measured advantage over the existing WebM exports here.

### 8. Mobile avatars and image attachments: keep a compatibility fallback

The shared image wire currently accepts JPEG/PNG attachments (`main/services/aiden-remote-attachments.ts:152-205`; iOS `Features/Remote/AidenChatFeature.swift:60-119`; Android `features/remote/AidenChatFeature.kt:40-111`). Bot avatars are canonical 512-pixel PNG assets and direct GETs require PNG. Original valid JPEG/PNG attachments can pass through unchanged, which preserves user data. A photographic-avatar alternative might save **20–50% per image**, but there is no representative avatar corpus or built IPA/APK measurement; flat illustrations may gain little. Adding AVIF/JXL requires server normalization and validation, MIME and filename changes, native decode and save paths, protocol fixtures, and old-client fallback. First bound Android direct avatar downloads before format negotiation: `android/app/src/main/java/sbtbiswas/AidenOnTheGo/networking/AidenRemoteClient.kt:1907-1912` calls `bytes()` before a response-size check, while iOS has a bounded read.

## Format fit and places to avoid it

| Format | Best candidate here | Principal constraint |
| --- | --- | --- |
| **gzip** | Mobile speech request bodies; existing Remote JSON GET | Request decode is absent today; reject expansion bombs. Live SSE frames should not be delayed for compression. |
| **Brotli** | Optional large JSON GET after traffic measurement; offline static catalog/GLB experiment | Incremental gain over gzip is smaller than raw-to-gzip; clients must actually advertise and decode it. Quality 11 is for offline assets, not live response latency. |
| **zstd** | Experimental offline static files or bulk local archives | The checked-in JSON/speech samples do not beat Brotli and zstd 3 does not beat gzip on the JSON fixture; wire support must be explicit. |
| **AVIF** | Photographic generated-image thumbnails or selected future uploads | Encode latency, visual quality, alpha, and the oldest supported Android/iOS/macOS/Windows/Linux decoders must be verified. |
| **JPEG XL** | Research path for high-quality/lossless images once every consumer is proven | No repo support or local `cjxl` encoder was available; a new cross-platform decoder is a substantial dependency and release-test commitment. No numeric saving is claimed. |

### Current platform constraints

The repo pins Electron `^43.1.1`, iOS deployment target 18, Android minimum API 26, and CLI Node `>=22.19`. [Chrome's JPEG XL announcement](https://developer.chrome.com/blog/jpeg-xl-in-chrome) places browser decode at Chrome 155; [Electron 43](https://releases.electronjs.org/release/v43.2.0) bundles Chromium 150, so this release cannot use browser JPEG XL decode. Chromium has supported AVIF decode since [Chrome 85](https://developer.chrome.com/blog/new-in-chrome-85), but decode does not establish an AVIF canvas encoder: the [HTML canvas specification](https://html.spec.whatwg.org/multipage/canvas.html) permits a PNG fallback for unsupported requested output types. Electron `nativeImage.toPNG()` has a known path today; prove any alternative encoder in the packaged build.

[Android's supported-format table](https://developer.android.com/media/platform/supported-formats) lists baseline AVIF decode from Android 12/API 31 and encode from Android 14/API 34 through MediaCodec; Android 26 cannot be assumed to decode it, and the table does not list JPEG XL. [Apple's ImageIO guidance](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/ImageIOGuide/imageio_basics/ikpg_basics.html) distinguishes readable and writable image types, so Safari support does not prove native iOS encoding. The compatibility auditor observed AVIF/JXL readable on the local macOS host but JXL absent from that host's ImageIO destination formats; that observation does not establish support on iOS 18 or every macOS release.

[Node 22's zlib documentation](https://nodejs.org/download/release/v22.22.0/docs/api/zlib.html) marks zstd experimental while gzip and Brotli are established. The CLI's Node 22 floor and Electron's embedded runtime must be evaluated separately. [OkHttp's bridge interceptor](https://github.com/square/okhttp/blob/master/okhttp/src/commonJvmAndroid/kotlin/okhttp3/internal/http/BridgeInterceptor.kt) transparently requests and decodes gzip when the app has not set `Accept-Encoding`; advertising Brotli or zstd needs an explicit decoder path and may suppress that automatic gzip behavior. A libavif/libjxl native addon would also add platform and architecture binaries, asar-unpack rules, Electron ABI and signing verification, and a larger installer. It is not a format flag.

Do **not** wrap JPEG, PNG, WOFF2, ONNX, WebM, MP4, H.264/AVCC, or MJPEG in generic HTTP compression on the assumption of large savings. The WOFF2 and marketing GIF measurements show almost none, and image/video codecs already exploit internal redundancy. SSE is written as small latency-sensitive frames (`main/services/aiden-remote-sse.ts:42-45,97-114,155-174`); per-frame compression overhead or stream buffering can worsen token latency. Simulator WebSocket frames intentionally do not negotiate `permessage-deflate` because its frame filter reads the first uncompressed tag byte (`main/services/aiden-remote-simulators.ts:540-586`). Peer transport pins identity and rejects encoded responses (`main/services/peer-transport.ts:346-356,453-459`); the device proxy strips encoding headers. These should change only with a separate end-to-end protocol and safety analysis.

App icons and DMG backgrounds are constrained by native packaging and asset catalogs. A lossless WebP spot check reduced source PNG bytes by 25–41%, but `package.json:376-382,489,563` names PNG/icon resources and the actual DMG uses the small 1x background. The six iOS resource PNGs total about 2.21 MiB, with two identical 0.92 MiB icon source files; Xcode may deduplicate or transform them. Measure built IPA before counting shipped duplicates or attempting an AVIF/JXL swap.

## Decision gates and validation

1. **Collect representative workload sizes:** LAN and Tailscale JSON GET/304 counts and bytes, speech request lengths, image-bearing chat sizes, 256/512 generated thumbnails, installed app and update archives, and first 3D viewer loads. Count both encoded wire bytes and decoded bytes after the trusted client boundary. Avoid collecting prompt/image contents in telemetry.
2. **Run a codec corpus:** photos, screenshots, line art, transparent avatars, generated images, and large chats. For each target format measure exact bytes, encode/decode p50/p95, peak RSS, battery/thermal, visual quality, and malformed-file handling. Compare at matched visual quality, not a single arbitrary quality setting.
3. **Keep compatibility explicit:** negotiate HTTP encodings with identity/gzip fallback; add strict compressed and expanded byte caps; do not infer image support solely from a MIME declaration. A shared Remote behavior change requires normative contract, fixture, desktop tests, and focused iOS/Android tests. Test Android API 26/31/34/36, iOS 18 simulator and physical device, and packaged Electron builds on macOS/Windows/Linux.
4. **Measure the release artifact:** compare signed/notarized DMG and ZIP, Linux AppImage/deb/rpm, npm CLI package, IPA, and APK. macOS updates use the full ZIP (`docs/releasing.md:57-80`), while Linux update feed uses AppImage; there is no measured differential-update/blockmap saving here. Installed-byte savings are not equal to download-byte savings; do not add the opportunities in this report into one overall percentage. Stop an experiment if encoding cost or first-view latency outweighs its wire or disk gain.

The baseline audit made no implementation changes. The follow-up changes and their validation are tracked with this PR.
