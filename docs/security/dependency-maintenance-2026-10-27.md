# Dependency maintenance, 2026-10-27

This refresh re-queried npm advisories against both lockfiles. It preserves Pi 1.4.0 and electron-builder 26.15.3 and does not use audit fix or a Pi downgrade.

| Package | Evaluated change | Reason and boundary |
| --- | --- | --- |
| Zod | 4.3.6 → 4.6.7, all root copies | GHSA-mrhx-c7xc-m3w5; constrained collection memory exhaustion. Used through ACP/MCP/JSON-render/provider schemas. Existing transport byte limits do not establish every schema's collection bound; no Aiden DoS was claimed reproduced. |
| CLI undici | 8.12.1 → exact 8.12.3 override | GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c. Pi main configures EnvHttpProxyAgent and installs matching global fetch; the CLI bundles its source modules, so the override reaches the selected implementation. Daemon SDK sessions do not call Pi main's dispatcher initializer and keep the host Node fetch. |
| KaTeX | 0.16.47 → 0.18.2, including nested copies | GHSA-238p-pmpm-9mq7, trust bypass after prototype pollution. Keep existing Markdown trust configuration. |
| Happy DOM | 20.14.5 → 21.0.4 | GHSA-834v-8h66-3h79, host code execution through import alias in the test DOM. Development/test dependency only. |
| body-parser | 2.3.0 → exact 2.4.0 override | GHSA-27r3-jxmh-p828, compressed-request trailing-byte DoS in SDK Express dependency. |
| tinypool | 2.0.0 → exact 2.1.2 override | GHSA-5gmw-xhrv-c9v3 and GHSA-85c8-ppgw-ccpr, worker-option prototype gadgets in formatter tooling. |

Both root and CLI audits report zero known advisories after this bounded refresh. That is an advisory inventory result, not proof that all application paths are vulnerability-free. EventSource and fetch integrity are not selected by the model transport; the fixed dependency still removes those vulnerable APIs. A built-CLI behavioral probe rejects an excessive content-encoding chain and then successfully decodes a subsequent gzip response in the same process. Existing CLI streaming, cancellation and TLS/Remote tests remain relevant.

The official Electron release table still lists stable 43.8.3, 44.9.3 and 45.0.0 with Node24.22.0. Node24.22.1 appears only in prerelease/nightly builds; no stable runtime upgrade is claimed to close the tracked Node issues. Keep the separate release follow-up. Sources: [Electron releases](https://releases.electronjs.org/), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [undici content-encoding advisory](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c).

Validation status and exact-head PR acceptance are recorded in the remediation plan. Proxy and custom TLS production acceptance remains separate from local model-free tests.
