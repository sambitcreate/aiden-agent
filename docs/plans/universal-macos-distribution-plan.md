# Universal macOS Distribution Plan

Status: Proposed  
Date: 2026-08-11

## Goal

Expand Aiden's current arm64 macOS product into one verified universal
`arm64 + x86_64` app without weakening the existing native-helper, signing,
notarization, updater, or package-content contracts.

This is a whole-product release change, not an Ambient Music implementation
detail. Ambient Music inference remains Apple-silicon-only; an x64 Aiden slice
must show the existing unsupported state and must not offer model downloads or
launch the arm64 helper.

## Proposed packaging contract

1. Produce unsigned arm64 and x64 Electron app intermediates with identical
   ASAR/application resources and architecture-appropriate native modules.
2. Merge the app and Electron helpers with `@electron/universal` under a
   reproducible, fail-closed script.
3. Inject the reviewed arm64 Ambient Music helper only after the universal
   merge so tooling never attempts to merge it with a nonexistent x64 slice.
4. Sign nested code from the inside out, then sign the outer universal app
   once with the normal hardened-runtime entitlements.
5. Require the main Electron executable and every Electron helper to contain
   exactly `arm64` and `x86_64`. Require Ambient Music to remain exactly
   `arm64`, macOS 14.0 minimum, background-only, and minimally entitled.
6. Build, notarize, staple, and independently verify the universal app, DMG,
   ZIP, updater metadata, and extracted/mounted copies.

## Acceptance

- Real Apple-silicon and Intel machines launch the same artifact.
- Intel retains normal Aiden workflows while Ambient Music is absent or shows
  only its unsupported explanation; no Ambient helper or model network action
  is reachable.
- Apple silicon retains the complete explicit-download Ambient Music flow.
- Update and rollback preserve settings and user data across architectures.
- Package verification rejects missing/extra slices, architecture-dependent
  ASAR drift, nested-signature drift, and accidental x64 Ambient payloads.

Implementation should begin only with access to an Intel test host or an
equivalent signed CI runner; emulation alone is not release acceptance.
