# Distribution verification and remaining acceptance

Status: W12 implementation candidate, October 27, 2026; Linux updater scope changed by the owner on October 29, 2026. Local tests and a production renderer build establish the source behavior below. They do not establish hosted release verification or installation of a signed candidate.

## Linux AppImage updates

Owner decision, October 29, 2026: in-app AppImage updates do not require the GitHub CLI. A writable, mounted production AppImage keeps today's behavior: the download is checked against the SHA-512 digest in the architecture-specific GitHub release feed, then replaced atomically under the existing eligibility, path/device/inode identity, regular-file, filename and cancellation checks. A checksum from the same feed is integrity, not publisher authentication.

Publisher authentication stays where it already is: `install.sh` runs `gh attestation verify` with the fixed repository, main-branch release workflow identity, GitHub Actions issuer and source commit policy (see [Linux package provenance](releasing.md#linux-package-provenance)), and anyone can run the same command by hand on a downloaded AppImage, `.deb` or `.rpm`.

An in-app verifier that required a trusted local `gh` 2.68+ and online attestation before an AppImage update became ready was built and reviewed for this audit (W12), then left out by that decision because most AppImage users do not have the GitHub CLI and would stop receiving updates. If it is revisited, the October 27 design is in the history of PR #614.

## Production renderer policy

Vite's build-only HTML transformation removes localhost and `127.0.0.1` HTTP origins from `script-src` and `style-src` for every HTML entrypoint. Development retains its Vite script/style and WebSocket origins. `npm run build` checks every emitted HTML page, requires `main-window.html`, `pill.html` and `visual-snapshot.html`, and the macOS/Linux package verifiers repeat the check inside `app.asar`. Synthetic tests build real Vite output and archive it before checking. The actual application renderer build also passed the output checker locally.

The connection inventory is intentionally unchanged:

| Consumer | Existing connection requirement |
| --- | --- |
| Main renderer | `'self'` for shipped WASM/assets; `blob:` for the GLTF embedded-texture path; loopback HTTP/WebSocket for Device Hub video, AX, foreground, fold and event-log streams; existing HTTPS allowance. |
| Dictation pill | Existing self, HTTPS and loopback HTTP/WebSocket policy. No new external destination is added. |
| Native visual snapshot entrypoint | Existing self and loopback development connection policy. Code-loading localhost origins are removed independently. |
| Custom/local inference providers | Main-process `model-runtime.ts` / `model-runtime-core.ts` resolve configured provider URLs and delegate to the provider registry. This CSP change does not alter those requests or forbid custom endpoints. |

Other shipped windows use separate documents: HTML visual capture is a `data:` host with the offline generative-UI guest policy and an opaque `srcdoc` frame; the phone visual viewer is a self-contained generated document with its own offline policy. Browser PiP and recording use `data:` documents with `default-src 'none'` and bounded image/style allowances. Browsing web contents load the visited site's policy. None of those documents acquires development script/style origins from the three renderer entrypoints. The relevant source inventory is `visual-snapshot-main.ts`, `visual-viewer-document.ts`, `renderer/shared/generative-ui.ts`, `renderer/shared/visual-viewer.ts` and `browser/service.ts`.

Packaged runtime acceptance still needs to load the main window, pill, native visual capture, HTML visual capture, phone viewer, terminal WASM, device streams and a configured custom provider with CSP violations monitored. The build/ASAR checks establish policy bytes, not successful native runtime behavior.

Renderer `file://` loading and `GrantFileProtocolExtraPrivileges` remain unchanged. Their custom-protocol migration has a [separate compatibility plan](plans/renderer-protocol-compatibility-plan.md).

## V2 macOS entitlement inventory

Disposition: retain existing exceptions pending measured necessity tests. Read-only measurement on October 27, 2026 inspected installed `/Applications/Aiden Agent.app` version/build `0.61.0`. `/usr/bin/codesign --verify --deep --strict` passed. Its main executable SHA-256 was `1aab24991d0a3c7aa770bb67e7a358614cb3d42470d18e03ce89378392b4a03d`; `Contents/Resources/app.asar` SHA-256 was `f4a16cef14b097d6c92161614a9dc651ab84f21b52a9bbea8dbeedd15777cbb0`. This is an installed baseline, not a build of this patch. No app/helper was launched, permission requested or entitlement removed.

| Executable/process | Measured true entitlements | Existing source enforcement |
| --- | --- | --- |
| Main Electron executable | Apple events, microphone, allow-jit, allow-unsigned-executable-memory, disable-library-validation | `entitlements.mac.plist`; exact main set asserted by package verifier. |
| Each Electron helper: plain, GPU, Plugin, Renderer | Microphone and all three runtime exceptions above | `entitlements.mac.inherit.plist`; exact set checked for each of the four helpers. |
| Foundation Models helper | Microphone and all three runtime exceptions | Inherited signing policy; signature/runtime checked, but no dedicated exact entitlement assertion currently exists. |
| CUA-S1 Forms helper | Microphone and all three runtime exceptions | Inherited policy; exact set asserted by package verifier. |
| Seven helpers: Bot inbox writer, lease flock, subagent run store, subagent file mutator, subagent shell runner, worktree remover, worktree file I/O | Empty dictionaries, individually measured | `sign-macos.mjs` selects empty `entitlements.computer-use.plist`; exact empty set checked per helper. |
| Aiden CUA broker | Empty dictionary | Same minimal signing override and package assertion. |
| Pinned CuaDriver | Apple events and screen capture | Upstream signed binary remains byte-pinned; no speculative re-signing. |
| Pinned Lume | Virtualization and VM networking | Upstream signature, exact two entitlements, binary digest and provisioning policy checked. |

Reproduce the inventory with `codesign -d --entitlements :-` for each executable and record artifact version, hashes, architecture and signature result. T3's similar runtime exceptions remain comparison context; they do not prove Aiden needs them.

Bounded follow-up: prepare signed candidate artifacts with one exception removed from one process/helper at a time, starting with the native Foundation Models/CUA forms helpers, and compare with the unchanged baseline. Before narrowing any set, exercise cold launch, renderer/GPU creation, provider requests and JIT/WASM, native addon loading, terminal `node-pty` spawn, Apple-event automation, Accessibility and Screen Recording, microphone capture, Foundation Models generation and CUA-S1 scoring. Include both supported macOS architectures where a helper ships and preserve valid upstream CuaDriver/Lume signatures. Record per-case pass/failure and OS logs. Then narrow only proven sets and update exact entitlement assertions, including the currently missing Foundation Models assertion. This candidate supplies inventory and validation boundaries; necessity remains open until that signed packaged run exists.

## Real release verification, October 27

The since-removed in-app verifier accepted the actual v0.61.0 x86_64 AppImage downloaded from the repository release, using gh 2.100.0 and the documented online policy. Its verified subject SHA-256 was e6327465cb0604cac8dfca940e36a660051e7d7197b3352d053f7f2081970009. A copy with one byte changed was rejected. Neither file was executed or installed. The same `gh attestation verify` policy remains the manual and installer check.
