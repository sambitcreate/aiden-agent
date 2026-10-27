# Distribution verification and remaining acceptance

Status: W12 implementation candidate, October 27, 2026. Local tests and a production renderer build establish the source behavior below. They do not establish hosted release verification or installation of a signed candidate.

## Linux AppImage trust policy

Before an AppImage download becomes ready, Aiden invokes a trusted, locally installed GitHub CLI with the same online certificate policy as `install.sh`. `gh` 2.68 or newer is required. The verifier fixes `github.com`, repository `sambitcreate/aiden-agent`, certificate identity `https://github.com/sambitcreate/aiden-agent/.github/workflows/release.yml@refs/heads/main`, GitHub Actions OIDC issuer, source ref `refs/heads/main`, SLSA provenance v1 and rejection of self-hosted runners. Source and signer digests must both equal the exact 40-character commit obtained from the selected version's GitHub release record. Certificate identity flags are mutually exclusive; do not add `--signer-repo` or `--signer-workflow` to that command.

The feed selects a stable version and its architecture-specific filename, but supplies no verification key, custom root, signer policy or source commit. A successful verified subject must name that exact asset. Its SHA-256 digest is retained in memory. The atomic replacement hashes the bytes it copies using both that authenticated SHA-256 and the existing feed SHA-512. A forged executable plus a matching forged feed checksum therefore cannot authorize replacement. Verification cannot authorize a different later cache file.

The independent trust roots are the trusted installed GitHub CLI and its GitHub/Sigstore certificate, transparency and trust-root verification. GitHub still controls the release record and repository identity. This is release-workflow authentication, not an independent source-code approval or protection against a compromised trusted workflow. Unlike `install.sh --expected-commit`, the in-app updater does not accept an operator-reviewed commit pin. A separately distributed publisher key was considered, but would require a new key custody, signing and rotation process; no new key or signer ceremony is introduced here.

Verification uses the GitHub attestation API and the CLI's normal trust verification. There is no offline bundle mode or checksum-only fallback. A missing/outdated CLI, unavailable API or verification material, invalid signature/identity/ref/commit, ambiguous subject, cancellation or loss of AppImage eligibility leaves the current image in place and the download unavailable for installation. Each CLI process has a 60-second timeout and 1 MiB output bound; the existing two-minute download watchdog cancels verification as well. The CLI is noninteractive and its failure output is not copied into logs. A completed proof survives Aiden's protected shutdown cleanup because installation happens after that cleanup; pending proofs do not. After a new process starts, cached downloads must be verified again.

Certificate validity and historical transparency timestamps are checked by `gh`. An expired short-lived signing certificate is not independently rejected when a valid authenticated signing time establishes its validity. Missing or unacceptable trust material fails closed. Do not substitute feed-provided roots or disable verification to work around an outage.

Changing the repository, workflow path/ref or accepted issuer requires a reviewed Aiden release that changes this policy before the publishing identity moves. If the old workflow can no longer publish, install a separately verified new release manually. GitHub/Sigstore trust-root rotation follows the trusted GitHub CLI's verifier; operators must update a CLI that cannot verify current material. There is no automatic trust-policy download from the feed.

Existing writable/mounted production eligibility, current path/device/inode identity, regular AppImage input, SHA-512 validation, filename preservation and cancellation checks remain. All checks finish before rename. Failure before rename leaves the old image intact and removes the temporary copy. This is not a post-install launch-health rollback mechanism. Aiden still declines downgrades/prereleases through its existing updater policy; provenance alone does not prevent replay of a previously authorized release.

The next approved Linux release must provide an attended acceptance run for both architectures: valid release, wrong source commit/repository/workflow/ref, modified bytes plus matching feed checksum, unavailable trust material, cancellation during verification, update-and-restart and normal-quit installation. No real release, signing or live installation was performed for this candidate.

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
