# Development and architecture

This guide covers building, running, testing, and packaging Aiden Agent from a source checkout.

## Architecture

```text
React renderer
    │ allowlisted context bridge
    ▼
Electron preload
    │ typed IPC and notifications
    ▼
Electron main process
    ├── Pi agent and model adapters
    ├── workspace-scoped tools, Git, review, and terminal
    ├── encrypted credentials and local JSON stores
    ├── MCP, attachments, search, and voice
    └── hardened native helpers, plus macOS-only Apple model and Computer Use helpers
```

Core technologies include Electron 43, React 19, TypeScript, Vite, Tailwind CSS, TanStack Router and Query, Radix UI, the Pi agent runtime, Swift, and Rust.

## Requirements

- macOS or a glibc 2.34+ x64/arm64 Linux desktop
- Node.js 22.22 or newer and npm (CI pins `22.23.4`; use the newest release of your Node line)
- A C17 compiler (`clang`/`gcc` or Xcode Command Line Tools), plus `pkg-config`, `libsecret-1` headers (`libsecret-1-dev`), and `gio-unix-2.0` headers (`libglib2.0-dev`) on Linux (`rpm` and `libselinux1-dev` for Linux packaging checks)
- Rust and Cargo (`rustup`, in `~/.cargo/bin` or on `PATH`, or set `CARGO`) for macOS Computer Use helper tests, packaged macOS builds, and Linux `native/linux-managed-payload` contract tests (`npm run test:linux-contracts`)
- A full Xcode installation for macOS native helpers (`npm run build:native` / `npm run package`), with Xcode 26 or newer required for Apple Foundation Models builds
- An Apple signing identity only for packaged macOS distribution builds

## Run locally

```bash
npm install
npm run dev
```

`npm run dev:sink` opens the development-only component sink, a page of every shared UI primitive in its states with a theme preset and Light/Dark toolbar. See [Component sink](design-guide.md#component-sink).

The development launcher prepares a platform-appropriate **Aiden Agent Dev** runtime that can run beside the installed **Aiden Agent** app. Development uses separate app-data, Chromium session, log, crash, and `~/.aiden-dev` roots; it does not copy production data, register global shortcuts, or check the production update feed by default. Set `AIDEN_DEV_GLOBAL_SHORTCUTS=1` only when a development run intentionally needs the global bindings.

Native builds discover the newest compatible full Xcode without changing the machine-wide `xcode-select` setting; `DEVELOPER_DIR` remains available as a per-command override.

## Companion clients and headless server

- **iOS and iPadOS (`ios/`)** — Aiden On The Go is distributed through TestFlight only (GitHub Releases do not publish an IPA). Open `ios/AidenOnTheGo.xcodeproj` or follow [`ios/README.md`](../ios/README.md).
- **Android (`android/`)** — Validation runs separately from the desktop release; relevant merges to `main` attest and upload `aiden-on-the-go-debug-apk` (`app-debug.apk` and `app-debug.apk.sha256`) as a 14-day GitHub Actions workflow artifact. Before sideloading an extracted main-branch artifact, check its SHA-256 digest and verify SLSA v1 provenance against the reviewed 40-character `main` commit with `gh` 2.68+:

  ```bash
  approved_commit=REPLACE_WITH_APPROVED_40_CHARACTER_COMMIT
  (cd /absolute/path/to/extracted-apk && sha256sum --check app-debug.apk.sha256)
  for subject in /absolute/path/to/extracted-apk/app-debug.apk.sha256 /absolute/path/to/extracted-apk/app-debug.apk; do
    gh attestation verify "$subject" \
      --hostname github.com \
      --repo sambitcreate/aiden-agent \
      --cert-identity https://github.com/sambitcreate/aiden-agent/.github/workflows/ci.yml@refs/heads/main \
      --cert-oidc-issuer https://token.actions.githubusercontent.com \
      --source-ref refs/heads/main \
      --source-digest "$approved_commit" \
      --signer-digest "$approved_commit" \
      --deny-self-hosted-runners \
      --predicate-type https://slsa.dev/provenance/v1 \
      --format json
  done
  ```

  See [`android/README.md`](../android/README.md).
- **Headless server (`packages/cli/`)** — `aiden serve` is a serve-only daemon for paired phones and Macs with no interactive terminal UI. Build it from a clone, or verify the attested `aiden-server-keyed-linux-x64` workflow artifact (`server-bundle.yml@refs/heads/main`), following [`packages/cli/README.md`](../packages/cli/README.md).

## Verify changes

```bash
npm test                  # full CI suite (includes lanes needing Ruby, Cargo, Playwright Chromium)
npm run test:native       # macOS + Xcode 26+ only (Apple Foundation Models Swift tests)
npm run type-check
npm run lint
npm run build
```

For faster local iteration, run a scoped lane (`npm run test:ci:core-git`, `npm run test:ci:runtime-subagents`, or `npm run test:ci:renderer-other`).

For Playwright Electron E2E runs:
- On macOS, run window-opening E2E suites off-screen in a Cua Space with `npm run test:e2e:space -- [playwright args]`.
- On Linux, run under `xvfb-run --auto-servernum npm run test:e2e` (with the CI prerequisites).

See [Continuous integration](ci.md) for change selection, test lanes, Electron shards, and the `CI required` gate.

## Package the app

```bash
# macOS
npm run package
npm run package:verify

# Linux (built on the target architecture)
npm run package:linux
npm run package:linux:verify
```

Distribution builds use `npm run dist` on macOS (requires Developer ID signing plus notarization) or `npm run dist:linux` on Linux (AppImage, `.deb`, `.rpm`). The release pipeline fails closed, verifies the platform artifacts, checks the deployed Homebrew and website consumers, and publishes updater metadata only with the matching verified artifacts. Read [macOS releases and automatic updates](releasing.md) before enabling publication.

### Release metadata and download aliases

- The checked-in `models.dev` snapshot is refreshed only through `npm run models:refresh` or the guarded distribution path (`npm run dist` / `release.yml`).
- Aiden no longer fetches benchmark scores (OpenRouter, Artificial Analysis) or measures model pace; a delete-only cleanup removes what earlier versions stored.
- Each public release publishes a signed Apple silicon macOS DMG/ZIP pair and verified Linux AppImage/DEB/RPM builds for x64 and arm64 with checksums.
- The canonical website download is the `Aiden-Agent-Beta-arm64.dmg` alias from the latest public GitHub release; `download.chatwithaiden.com/Aiden-Agent-Beta.dmg` is maintained by [`aiden-website`](https://github.com/sambitcreate/aiden-website) as a non-cacheable redirect to that alias (its R2 object is rollback fallback only). Release preflight verifies both paths before signing begins.
