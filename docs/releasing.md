# macOS releases and automatic updates

Aiden keeps its source in the private `sambitcreate/aiden-agent` repository. Signed release
binaries and updater metadata are published separately from
`sambitcreate/aiden-agent-releases`, which must be public so installed apps can update without
shipping a GitHub credential.

## Release behavior

- `.github/workflows/ci.yml` verifies pull requests and pushes on GitHub's `macos-26` image.
- `.github/workflows/release.yml` is considered enabled only when the source repository variable
  `RELEASES_ENABLED` is exactly `true`.
- Each enabled push to `main` derives a monotonically increasing version from the workflow run
  number. The beta line starts at `0.27.0`; the base `package.json` version supplies that release
  line, so `0.27.0` plus run `41` produces `0.27.41` without committing a version-bump loop to
  `main`.
- The release job runs the full TypeScript, lint, JavaScript/TypeScript, Rust, Swift, and build
  gates before preparing signing material.
- GitHub-hosted macOS VMs do not enforce Aiden's live kernel launch constraint. CI still verifies
  its exact pinned requirement bytes and the other 39 broker tests; the two live enforcement
  checks remain mandatory on a physical Mac during packaged acceptance.
- `npm run dist` refreshes only the approved release-time model snapshot, builds the app and
  native helpers, signs with Developer ID, notarizes, staples, and verifies the app, DMG, and ZIP.
- Automatic-update builds also generate `latest-mac.yml`. The workflow publishes that file and
  the exact verified DMG/ZIP pair together, plus `SHA256SUMS`, in one public GitHub release.
- Aiden checks shortly after launch and every six hours. It downloads a newer signed update in
  the background, notifies the user when ready, and installs only after Aiden exits normally.
  It never interrupts an open workspace or bypasses the existing quit barriers.
- A failed or rerun job refuses to overwrite an existing tag. Recovery is a new `main` commit,
  which receives a higher version.

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

Creating the public repository makes the signed application binaries publicly downloadable.
It does not expose the private source repository or its history.

1. Create `sambitcreate/aiden-agent-releases` as a public repository with a minimal README.
2. Create a `release` environment in the private source repository. Optional required reviewers
   can be added while the pipeline is being proven.
3. Create a fine-grained GitHub token that can write repository contents only for
   `sambitcreate/aiden-agent-releases`.
4. Add the following environment secrets to the private source repository's `release`
   environment:

   | Secret | Value |
   | --- | --- |
   | `APPLE_API_KEY_ID` | App Store Connect API key ID |
   | `APPLE_API_ISSUER` | App Store Connect issuer UUID |
   | `APPLE_API_KEY_P8` | Complete private `.p8` key contents |
   | `MACOS_CERTIFICATE_P12` | Base64-encoded Developer ID Application certificate and private key |
   | `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12` |
   | `RELEASE_REPOSITORY_TOKEN` | Fine-grained token for the public binary repository |

5. Keep `RELEASES_ENABLED` unset while validating secrets. Set it to `true` only when public
   binary publication is approved.
6. Trigger `Release macOS` manually for the first release or push a reviewed commit to `main`.
7. Install the published DMG, then publish one higher version and verify the installed app
   downloads it, reports it ready, and installs it after a normal quit.

Never place a GitHub token, Apple private key, certificate password, or notarization credential
in `package.json`, workflow logs, an application resource, or the public release repository.

## Version-line changes

For a planned minor or major release, change only the major/minor line in `package.json` and
`package-lock.json` (for example, `0.27.0` to `0.28.0`). The next workflow run becomes
`0.28.<run number>`, which remains greater than every `0.27.x` build. Do not lower the
major/minor line or manually reuse a published version.
