# Pi 1.3.0 upgrade (2026-10-15)

Live desktop and CLI Pi packages are pinned exactly at 1.3.0 in lockstep: root pi-agent-core, pi-ai, chord, pi-durable, pi-codemode; CLI pi-coding-agent, pi-ai, pi-agent-core, pi-codemode, pi-mcp. The frozen 0.87.1 legacy harness is unchanged.

Also bumped with the pin: `PI_AI_VERSION` in `scripts/patch-pi-oauth-branding.mjs`, and `AIDEN_PI_CATALOG_VERSION` / `AIDEN_PI_CATALOG_GENERATED_AT` in `main/services/pi-remote-catalog.ts` (take generatedAt from pi-ai's bundled `dist/providers/data/*.json`, here 2026-10-15T19:00:55.287Z).

No Aiden code changes were needed. Chord 1.3.0 has large breaking API changes, but Aiden never imports chord directly (only pi-durable does), so the root pin just follows pi-durable. pi-durable moved its output helpers to `@earendil-works/chord/output`; Aiden does not use them. OpenCode moved to `opencode.ai/inference`, same hostname, so OpenCode session attribution still matches. kimi-coding now needs `/v1` in models.json base URL overrides; Aiden ships none.

Local validation in a cloud container: root/CLI type-check, lint, vite and Electron production builds, CLI build and 97/99 CLI tests, 85 focused Pi/Bot/models/compaction files (1,189 pass, 1 skip). Environmental-only local failures, not Pi: CLI print-mode test picks up container AWS creds (passes with them unset), IPv6/LAN listener tests, macOS `plutil`, and some git sandbox tests. Full `npm test` hung past two hours in that container, so hosted CI is the acceptance record.
