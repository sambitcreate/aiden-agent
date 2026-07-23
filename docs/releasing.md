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
  number. The base `package.json` version supplies the release line, so `1.0.0` plus run `41`
  produces `1.0.41` without committing a version-bump loop to `main`.
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
`package-lock.json` (for example, `1.0.0` to `1.1.0`). The next workflow run becomes
`1.1.<run number>`, which remains greater than every `1.0.x` build. Do not lower the major/minor
line or manually reuse a published version.
