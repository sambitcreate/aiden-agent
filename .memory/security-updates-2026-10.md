# Security updates, October 2026

2026-10-22 check against the October 21 disclosures (PHP2Shell, Linux PwnEscape, Node.js security release).

- PHP and the Linux kernel bugs do not apply: no PHP anywhere, and Aiden runs no VM hosts.
- The shipped app had drifted: Electron 43.1.1 (July 14, Chromium 150.0.7871.114) was 23 releases behind. Moved to `^43.8.3` (Chromium 150.0.7871.250), which also clears five Electron GHSAs fixed after 43.6.0.
- `@modelcontextprotocol/sdk` 1.30.0 -> 1.32.1 (OAuth credential steering, cross-origin redirect header leaks) and `yauzl` 3.2.0 -> 3.4.0. In-range transitive fixes from `npm audit fix` (undici, hono, fast-uri, proxy-addr, qs, ip-address, seroval, shell-quote, vite and others).
- electron-builder must stay at 26.15.3: `scripts/patch-electron-builder-keychain.mjs` refuses any other app-builder-lib version, and a plain `npm audit fix` bumps it to 26.18.0. Re-pin it after any audit fix.
- CI `node-version` moved from 22.22.3 to 22.23.4 (the Node 22 line's October 21 security release).
- 0.61.0 shipped without Node 24.22.1 because no Electron release carried it yet (43.8.3, 44.9.3 and 45.0.0 all ship 24.22.0).
- 2026-10-28: Electron 43.8.4, 44.10.0 and 45.1.0 (released 2026-10-27) carry Node 24.22.1. Moved to `^43.8.4`, which closes the Brotli decoder flaw (CVE-2026-111497) and the TLS hostname-check bypasses (CVE-2026-105483, CVE-2026-106069) in the app's main process. Chromium stays 150.0.7871.250. The glob rule below is unchanged on 24.22.1.
- `main/services/gemini-live/sdk-contract.test.ts` checks the Electron major (43) plus the display-media declarations; it no longer pins the exact patch.
- Electron 43.8.3 bundles Node 24.22.0, whose `fs.glob` no longer steps into a symlink after `**` (Node 22.23.4 and 24.18.0 still do). The foreground glob worker (`main/services/coding-tool-glob-worker.ts`) now follows the newer rule on every runtime, because the Electron smoke compares it with Electron's native glob. `coding-tools.test.ts` gives the five affected patterns fixed answers instead of the native oracle, so the unit test passes on any local Node. Run the Electron smoke as root with `--no-sandbox` appended after the script arguments.

## October 27 remediation refresh

Zod4.6.7, CLI undici8.12.3, KaTeX0.18.2, HappyDOM21.0.4, body-parser2.4.0 and tinypool2.1.2 are evaluated in the security dependency PR. Pi remains1.4.0 and electron-builder26.15.3. See docs/security/dependency-maintenance-2026-10-27.md and the remediation plan for checks and acceptance. StableElectron stillcarriesNode24.22.0; prerelease46/nightly47 have24.22.1, so stablefixremainsupstream.
