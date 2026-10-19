# Packaging size (branch perf/packaging-size, 2026-10-03)

- `app.asar` went from 238.9 MB to 87.9 MB and the macOS `.app` from 599 MB to 429 MB
  (arm64 `--dir` build). The unpacked part is now mostly sherpa-onnx-node, about 61 MB.
- **Source maps:**
  - `build.files` excludes `**/*.map`.
  - Vite emits `sourcemap: "hidden"`.
  - Production esbuild (`build:electron:production`, which `npm run build` uses) writes
    external maps with no `sourceMappingURL`.
  - The release workflow uploads the maps as the `symbols-macos-<run_id>` artifact,
    kept for 90 days. That name must not match the publish job's `release-*` pattern.
  - To symbolicate a stack, use `node:module` `SourceMap.findEntry` against those maps.
- **Production main and preload output:** `minifyWhitespace` + `minifySyntax` only.
  Never enable identifier minification there; serialized functions and stack names rely on
  the original names.
- **Production `dependencies`** must hold exactly what main or preload reaches. Renderer
  packages belong in devDependencies because Vite bundles them.
  - `scripts/main-runtime-dependencies.test.mjs` analyses the real esbuild graph.
  - Packages loaded through `createRequire` are invisible to the metafile, so list them in
    its `RUNTIME_LOADED` map: minimatch, node-pty, sherpa-onnx-node, ws.
  - katex and web-streams-polyfill stay in production only as transitive dependencies.
- **Package verifiers:** `verifyPackagedSlimness` (macOS and Linux) rejects maps,
  declarations, esbuild, and any packaged `name@version` that is not a production
  lockfile install.
  - electron-builder hoists nested production copies, so compare by name@version, not by
    lockfile path.
- **`build.files` exclusions:**
  - Excluded: node_modules `.ts`, test/example/docs directories, and README/CHANGELOG-style
    `.md` files.
  - Not excluded: `doc`, because `yaml/dist/doc` is runtime code; `benchmark`; licence files.
- **Onboarding art:** the 10.5 MB of quantized PNGs (and `npm run assets:onboarding`) are gone
  (2026-10-09). The feature tour now draws its art in code, a few tens of KB of TSX and CSS; see
  `.memory/onboarding-art.md`.
- **Native C helpers:**
  - Builds go through `compileNativeC`, which writes a `<output>.stamp` fingerprint
    covering the source, quoted local headers (transitively), compiler, args, env,
    platform, and arch.
  - `build:native:c` runs all eight builders in parallel.
  - A compiler upgrade under the same `xcrun` path and environment does not invalidate the
    stamp. Delete `build/native/*.stamp` to force a rebuild.
- **Bundle budget:** `npm run check:bundle-budget`, run in CI after `npm run build`,
  limits the main window's entry module plus its modulepreloads.
  - The limit is 3,520,000 B raw and 1,075,000 B gzip.
  - At introduction the measured size was 3,407,897 B raw and 1,043,384 B gzip.

## Packaged models.dev snapshot (2026-10-18)

- The release refresh continues to write readable `resources/model-capabilities.json`.
  Desktop package scripts run `npm run package:model-catalog` after the build; it
  validates and minifies that snapshot into ignored
  `build/package-resources/model-capabilities.json`. electron-builder maps the
  generated file into the same `resources/model-capabilities.json` path inside
  `app.asar`. This is an offline transform and does not change the manual-only
  network policy or runtime lookup path. The macOS and Linux package verifier
  requires valid, compact JSON at that path.
- On the 2026-10-18 snapshot: source 9,109,569 B, compact 5,319,504 B, a
  3,790,065 B (41.6%, 3.615 MiB) installed-payload saving. gzip level 6:
  665,444 B to 538,680 B (126,764 B saved); Brotli quality 5: 336,133 B to
  287,225 B (48,908 B saved). These are per-file compression probes, not
  measured DMG/ZIP or updater download changes.
- A macOS arm64 development package built after the FileSet change passed
  afterSign verification and `npm run package:verify`. Its `app.asar` is
  91,277,314 B, contains a 5,319,504 B catalog entry and zero `.map` entries;
  the `.app` contains 499,075,535 B of regular-file payload. These are
  current-package totals, not before/after installer measurements.

## Ogg/Opus decoder for on-device Telegram voice notes (2026-10-09, STT engine foundation Task 7)

- Main bundles use `packages: "external"`, so every production dependency ships in app.asar as
  installed files (minus `build.files` exclusions: maps, `.d.ts`, README-style `.md`).
- Measured the asar payload of `ogg-opus-decoder@1.7.5` on disk with those exclusions applied
  (no `npm run package` run; that script vendors helpers and builds native code):
  ogg-opus-decoder 4.22 MB (its `dist/` carries a 4.1 MB opus-ml bundle) +
  `@wasm-audio-decoders/opus-ml` 8.20 MB (pulled in for its optional ML speech enhancement) +
  opus-decoder 0.18 + codec-parser 0.13 + common 0.06 + @eshaz/web-worker 0.03 +
  simple-yenc 0.02 ≈ **12.8 MB**. Over the spec's 5 MB limit.
- Fallback taken per spec §11: `opus-decoder@0.7.12` + `codec-parser@2.5.0` (exact pins) used
  directly by `main/services/local-speech-opus.ts`. Same measurement ≈ **0.42 MB** (opus-decoder,
  codec-parser, @wasm-audio-decoders/common, @eshaz/web-worker, simple-yenc). WASM is inlined
  in JS, so nothing needs `asarUnpack`.
- Packaged `--dir` delta, measured 2026-10-09 (Task 10, `npm run package`, arm64 development):
  the five packages occupy **0.413 MB** of app.asar (opus-decoder 0.178, codec-parser 0.134,
  @wasm-audio-decoders/common 0.059, @eshaz/web-worker 0.026, simple-yenc 0.015), matching the
  on-disk estimate. Whole app 459 MB, app.asar 96 MB. `Resources/speech/silero_vad.onnx`
  (643,854 bytes) and `build/main/local-speech-worker.js` are present; `npm run package:verify`
  passes.
- Both are ESM-only and loaded through a dynamic `import()` on first decode, so the main
  bundle does not compile libopus at startup. The CLI build bundles them as lazy chunks of
  `dist/app/speech-worker.js`.
