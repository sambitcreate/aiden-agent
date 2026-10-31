# Pi 1.4.0 upgrade (2026-10-26)

Live desktop and CLI Pi packages are pinned exactly at 1.4.0 in lockstep (root pi-agent-core, pi-ai, chord, pi-durable, pi-mcp, pi-codemode; CLI pi-coding-agent, pi-ai, pi-agent-core, pi-codemode, pi-mcp, pi-durable, chord). The frozen 0.87.1 legacy harness is unchanged. Install with the repo's npm 11 (`npx npm@11.11.0 install`): npm 10 rewrites every `libc` field in the lockfile.

Also bumped with the pin: `PI_AI_VERSION` in `scripts/patch-pi-oauth-branding.mjs`, and `AIDEN_PI_CATALOG_VERSION` / `AIDEN_PI_CATALOG_GENERATED_AT` in `main/services/pi-remote-catalog.ts` (from pi-ai's `dist/providers/data/.manifest.json`, here 2026-10-21T22:33:24.994Z).

## Why (the separate upgrade gate)

Pi 1.4.0 contains Pi #11142, which Aiden had patched into pi-ai 1.3.0's compiled dist since 2026-10-20 (`pi-ai-11142-backport.md`). The patch, `scripts/patch-pi-ai-tool-cache.mjs`, its test and its four call sites are deleted. Other fixes Aiden gets: whitespace-only tool output no longer 400s on OpenAI and Google, more retryable gateway and Codex-proxy errors, any HTTP 413 counts as context overflow (Copilot), and the Codex catalog drops `gpt-5.5` and `gpt-5.3-codex-spark`, which the ChatGPT backend rejects.

## What changed in Aiden

- **Request identity.** Pi 1.4 attributes Agent-loop and durable Harness requests to pi by default (OpenRouter `HTTP-Referer: https://pi.dev`, `X-OpenRouter-Title: pi`, NVIDIA and OpenCode headers). `main/services/pi-client-identity.ts` sets `{ attribution: null }`; it is passed to `new Agent` in `pi-agent-runtime-harness.ts` and to `Harness.open` in `bot-runtime/harness-host.ts`. `PiAgentRuntimeHarnessOptions` omits Pi's `identity` (its own `identity` is the runtime identity). The CLI's coding agent already sends none through `PI_TELEMETRY=0`.
- **Crash-loop guard.** Pi Durable 1.4 parks a task after 5 crash cut-offs in a row (`settings.restartLimit`). Bot recovery already waits for the person's Resume and nothing calls `retryTask`, so a parked turn would leave the Bot busy forever. `BOT_HARNESS_SETTINGS` sets `restartLimit: Infinity` (1.3.0 behavior). Test: `harness-host.test.ts` (b1), five real SIGKILLs.
- **Legacy contexts.** chord 1.4's `Context` requires `telemetry`. The root tsconfig's catch-all `paths` entry resolves the frozen harness's `@earendil-works/chord` type import to the current chord, so its `TODO_CONTEXT` (from its own 0.87.1 chord) no longer type-checked against its own `Session`. `pi-legacy-harness.ts` re-exports `TODO_CONTEXT` and `withAbortSignal` typed as `LegacyContext`; they only ever go back into the frozen helpers. Removing the catch-all path fixes these but breaks other augmentation, so it stays.
- **Bot databases migrate one way.** Opening a Bot's `session.sqlite` with Pi Durable 1.4 moves it to schema 2. Checked on a real 1.3.0 database: history kept, new turns work; 1.3.0 then refuses with "Durable SQLite schema version 2 is newer than supported version 1". That error is not a corrupt-database error, so an older Aiden leaves the file alone and the Bot fails to open until Aiden is updated again.

Not used by Aiden: `TaskRuntime.sleep` (removed), `defineDoc` (needs `checkpointWhen`), `telemetryContext` (renamed), `getPiUserAgent` (removed). Generation retry backoffs now sleep as a `sleeping` task; Bot code checks `tasks.length`/`submissions.length`, not statuses, so idle close and busy state are unchanged.

## Validation (cloud container)

Root and CLI type-check; replay gate `scripts/pi-upgrade-evaluation.mjs` passed 7/7 (run with a scratch receipt dir and `node` as the executable); `test:bot-runtime` 272/272; `test:compaction` passes; CLI bundle build and CLI tests pass except the two known environment failures (container AWS creds, `/usr/bin/ffmpeg`). Codex and prompt-cache tests moved off the removed Codex models.
