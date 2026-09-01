# macOS releases and automatic updates

Aiden publishes its source, signed release binaries, and updater metadata from
`sambitcreate/aiden-agent`. The repository must be public before the first release so website
visitors and installed apps can download GitHub Release assets without a GitHub credential.

## Model catalog refreshes

`resources/model-capabilities.json` is the packaged, immutable models.dev snapshot used for
runtime limits and request admission. `npm run dist` refreshes and validates it before every
package. A separate `Model catalog refresh` workflow runs after pushes to `main`, updates only that
tracked file, runs `npm run test:model-catalog`, and commits a changed snapshot with the GitHub
Actions bot. A failed fetch leaves the known-good snapshot untouched; a non-fast-forward push is
allowed to fail so the newer `main` run remains authoritative.

The live app contacts models.dev only when a user chooses **Update model catalogs** in Settings →
Providers. That foreground request uses the fixed anonymous endpoint and writes a validated,
same-app-version, device-local display cache. It cannot add selectable models or alter routing,
context windows, output limits, or active turns. Provider inventory remains a separate Pi/provider
authority. Ordinary model reads and application startup remain offline.

## Release behavior

- `.github/workflows/ci.yml` verifies pull requests and pushes on GitHub's `macos-26` image.
- `.github/workflows/release.yml` is considered enabled only when the source repository variable
  `RELEASES_ENABLED` is exactly `true`.
- A release uses the complete SemVer declared in `package.json` exactly. For example, `0.35.0`
  publishes only as `v0.35.0`; workflow run numbers never become application versions.
- If the exact declared tag already exists, an enabled push to `main` completes the release job as
  a green no-op. Publishing another build requires an explicit reviewed version change in both
  `package.json` and `package-lock.json`.
- The release job runs the full TypeScript, lint, JavaScript/TypeScript, Rust, Swift, and build
  gates before preparing signing material.
- GitHub-hosted macOS VMs do not enforce Aiden's live kernel launch constraint. CI still verifies
  its exact pinned requirement bytes and the other 39 broker tests; the two live enforcement
  checks remain mandatory on a physical Mac during packaged acceptance.
- `npm run dist` refreshes only the approved release-time model snapshot, builds the app and
  native helpers, signs with Developer ID, notarizes, staples, and verifies the app, DMG, and ZIP.
- Before publication, the signed app must launch from a disposable profile whose committed
  V1-to-V2 subagent migration has identical source bytes but a deliberately stale native file
  generation. This covers the APFS device-identifier churn observed after a reboot.
- Automatic-update builds also generate `latest-mac.yml`. macOS archive names are restricted to
  stable GitHub-safe characters, and release verification requires the manifest URL and path to
  equal the exact ZIP basename. Verification also recomputes the ZIP's SHA-512 digest and requires
  both the current file entry and legacy top-level manifest field to match it. The workflow
  publishes that file and the exact verified versioned DMG/ZIP pair together, plus `SHA256SUMS`,
  in one public GitHub release in this repository. The workflow also uploads a byte-identical
  `Aiden-Agent-Beta-arm64.dmg` alias so the website can use GitHub's stable
  `releases/latest/download` URL without a per-release source edit. Each release includes
  GitHub-generated notes for changes since the previous release. The DMGs are website and
  Homebrew downloads; the ZIP and YAML are the updater payload.
- Release-related pull requests run the separate release-consumer contract workflow. It verifies
  the versioned DMG name against `sambitcreate/homebrew-tap`, verifies the deployed website points
  at the stable alias, confirms that alias resolves to a non-empty public DMG, and requires the
  historical `download.chatwithaiden.com/Aiden-Agent-Beta.dmg` URL to return a non-cacheable HTTP
  307 redirect to the same alias. The redirect Worker is owned by `sambitcreate/aiden-website`; its
  underlying R2 object is rollback fallback only. The release job repeats this check before spending
  signing/notarization resources. If the artifact contract must change, update and deploy the
  consumers first, then change Aiden's release configuration.
- Aiden checks shortly after launch and every six hours. It owns and observes one full-package
  download of a newer signed update rather than using differential updates because the release
  set does not publish separate blockmaps. Settings → About and the chat sidebar expose bounded progress, failure,
  retry, and ready states. A two-minute no-progress stall is cancelled and retried with bounded
  backoff. Installation starts only after the package and macOS updater handoff are ready, and
  never interrupts an open workspace or bypasses the existing quit barriers.
- A failed or rerun job refuses to overwrite an existing tag. If no tag or draft was created, rerun
  the same declared version. If a partial draft exists, inspect and remove only that exact failed
  draft before retrying. Never manufacture a version from a workflow run number.

Local `npm run dist` builds do not embed a feed or perform automatic update checks. The release
workflow opts in with `AIDEN_ENABLE_AUTO_UPDATES=1`.

## Physical Mac acceptance on a personal Mac Studio

A spare Mac is not required. For now, keep pull-request CI, release builds, signing,
notarization, and publication on GitHub-hosted runners. Use the personal Mac Studio only to run
the required physical-Mac packaged acceptance checks, then approve publication. Do not install a
persistent GitHub Actions runner inside a personal macOS account merely to automate those checks.

If manual acceptance becomes burdensome, create a separate standard macOS user such as
`aiden-runner` on the same Mac Studio. This is useful separation, but it is not as strong as a
separate or ephemeral machine. The runner account should:

- remain disconnected from iCloud and contain no personal files, browser sessions, SSH keys, or
  GitHub CLI credentials;
- register only with this private repository and accept only trusted `main` or manually
  dispatched release/acceptance jobs, never pull-request jobs;
- receive signing and notarization material only for the job, then remove temporary keychains,
  API keys, build output, and the runner workspace whether the job succeeds or fails;
- be logged into its own desktop session only when packaged UI checks require Accessibility or
  Screen Recording permission, with those grants limited to the exact signed Aiden helper; and
- stay updated and be unregistered or offline whenever it is not needed.

GitHub recommends ephemeral self-hosted runners over persistent ones because persistent hosts
retain job state. Environment approvals delay secret access but do not isolate a self-hosted
machine. See GitHub's [self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
and [secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

## One-time GitHub setup

Making this repository public makes both its source and signed application binaries publicly
downloadable. Complete the separate [public-readiness checklist](public-readiness.md), including
its history scan, before changing visibility.

1. Make `sambitcreate/aiden-agent` public only after the public-readiness checklist is complete.
2. Create a `release` environment in that repository. Require review for the first beta, restrict
   deployment to `main`, and keep the signing/notarization material scoped to this environment.
3. Add the following environment secrets:

   | Secret                       | Value                                                               |
   | ---------------------------- | ------------------------------------------------------------------- |
   | `APPLE_API_KEY_ID`           | App Store Connect API key ID                                        |
   | `APPLE_API_ISSUER`           | App Store Connect issuer UUID                                       |
   | `APPLE_API_KEY_P8`           | Complete private `.p8` key contents                                 |
   | `MACOS_CERTIFICATE_P12`      | Base64-encoded Developer ID Application certificate and private key |
   | `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12`                            |

4. Keep `RELEASES_ENABLED` unset while configuring the environment. Set the non-secret
   repository variable to `true` only when the first public beta is approved. The workflow uses
   its scoped `GITHUB_TOKEN` with `contents: write`; no separate release-repository token exists.
5. Trigger `Release macOS` manually for the first release or push a reviewed commit to `main`.
6. Install the published DMG, then publish one higher version and verify the installed app
   downloads it, reports it ready, and installs it through the in-app Update and Restart action.
   For the 0.27 recovery release, repeat this from an installed 0.27.0 build because older
   manifests named payloads that GitHub normalized differently.

Each Aiden beta is a normal published GitHub Release, rather than GitHub's `pre-release` state.
The updater intentionally uses GitHub's `releases/latest/download` endpoint and the app rejects
pre-release updates. The release notes visibly identify the Beta channel.

Never place an Apple private key, certificate password, or notarization credential in
`package.json`, workflow logs, or an application resource.

## Version-line changes

For every planned release, change the complete version in `package.json` and `package-lock.json`
(for example, `0.35.0` to `0.35.1`, or `0.35.0` to `0.36.0`). The next eligible workflow run uses
that exact version. Do not lower the version or reuse a published tag.
