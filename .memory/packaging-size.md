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
- **Onboarding art:** `npm run assets:onboarding` quantizes the PNGs to 256 colors and keeps
  them as 8-bit RGBA, because the onboarding test requires color type 6.
  - The script is idempotent.
  - 21.8 MB became 10.5 MB, at ≥38 dB premultiplied PSNR.
  - Run it after adding new art.
  - `features/aiden-assistant.png` and `features/form-fill.png` are not referenced by the
    bento, which is kept for planned tiles.
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
