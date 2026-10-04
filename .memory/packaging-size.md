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
