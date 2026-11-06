# CI execution chain

Pullfrog v0.1.57 source SHA0657d542 is pinned, with supported forced-local cli.ts and frozen pnpm dependencies instead of the launcher caret npm runtime. Keep OIDC. Node22.23.4 suppliesCorepack. Everyrelease job explicitlyrequiresmain. Operational bootstrap acceptance is tracked in the plan; do not infer it from YAML tests.

Fresh review found the separate OpenCode tarball installer escaped the frozen tree. The source-hash-guarded Node hook now substitutes native OpenCode/Claude binaries from frozen optional packages and refuses other executable download routes; no unverified install-script fallback. Real authorized workflow run remains required.
