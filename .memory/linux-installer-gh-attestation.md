# Linux installer: gh attestation preflight and identity flags (2026-10-04)

A first real install of v0.52.0 on Ubuntu 26.04 failed with `unknown command "attestation" for "gh"`. Two separate defects in `install.sh`:

- Ubuntu's archive `gh` is 2.46.0. `gh attestation` arrived in 2.49 and the `--source-ref`, `--source-digest`, and `--signer-digest` flags in 2.68. The installer now probes `gh attestation verify --help` for `--signer-digest` and fails with an upgrade message instead of leaking gh's usage text.
- Real gh treats `--cert-identity`, `--cert-identity-regex`, `--signer-repo`, and `--signer-workflow` as mutually exclusive, so the previous command could not pass on any gh version. The installer and `docs/releasing.md` keep only the exact `--cert-identity` SAN (`release.yml@refs/heads/main`), which is stricter than the two dropped flags.

The fake `gh` in `scripts/install.test.mjs` never enforced either rule, which is why CI stayed green. It now models an outdated gh (`ghVersion: "2.46.0"`) and rejects combined identity flags. Accepted against the real v0.52.0 amd64 `.deb` with gh 2.102.0: verification passes, and a wrong `--expected-commit` is rejected.

## AppImage updater reuse (2026-10-27, implementation candidate)

`app-updater-linux-provenance.ts` now applies the same online fixed repository, workflow certificate identity, main ref, GitHub issuer and release-record source/signer commit policy before an AppImage can become ready. Trusted local gh 2.68+ is a prerequisite. Successful subject SHA-256 is checked over the same bytes copied atomically alongside feed SHA-512. No offline bundle or checksum-only fallback exists. Pending verification is aborted/cleared on cancellation or shutdown, but an already-ready proof survives protected shutdown so its later synchronous install can finish. Tests exercise both normal-quit and protected-restart gates.

Production Vite HTML strips localhost script/style sources only; connect-src remains unchanged after consumer inventory. Emitted HTML and packaged ASAR are checked, including future HTML pages. Docs: `docs/distribution-hardening.md`. V2 retained all entitlement exceptions after read-only installed 0.61.0 inventory and strict deep signature verification; signed candidate necessity tests remain. `docs/plans/renderer-protocol-compatibility-plan.md` separately defers custom protocol/file-fuse migration. No real release or signing occurred.
