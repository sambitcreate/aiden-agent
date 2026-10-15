# Linux installer: gh attestation preflight and identity flags (2026-10-04)

A first real install of v0.52.0 on Ubuntu 26.04 failed with `unknown command "attestation" for "gh"`. Two separate defects in `install.sh`:

- Ubuntu's archive `gh` is 2.46.0. `gh attestation` arrived in 2.49 and the `--source-ref`, `--source-digest`, and `--signer-digest` flags in 2.68. The installer now probes `gh attestation verify --help` for `--signer-digest` and fails with an upgrade message instead of leaking gh's usage text.
- Real gh treats `--cert-identity`, `--cert-identity-regex`, `--signer-repo`, and `--signer-workflow` as mutually exclusive, so the previous command could not pass on any gh version. The installer and `docs/releasing.md` keep only the exact `--cert-identity` SAN (`release.yml@refs/heads/main`), which is stricter than the two dropped flags.

The fake `gh` in `scripts/install.test.mjs` never enforced either rule, which is why CI stayed green. It now models an outdated gh (`ghVersion: "2.46.0"`) and rejects combined identity flags. Accepted against the real v0.52.0 amd64 `.deb` with gh 2.102.0: verification passes, and a wrong `--expected-commit` is rejected.
