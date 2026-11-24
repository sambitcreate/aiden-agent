# Pi 1.6.0 upgrade (2026-11-24)

The live desktop and CLI Pi packages are pinned exactly at 1.6.0, in lockstep, on branch `chore/pi-1.6.0-upgrade`. The packages are the same as for 1.5.2: on the root, pi-agent-core, pi-ai, chord, pi-durable, pi-mcp and pi-codemode; on the CLI, pi-coding-agent, pi-ai, pi-agent-core, pi-codemode, pi-mcp, pi-durable and chord. The frozen 0.87.1 legacy harness is unchanged. Install with `npx npm@11.11.0 install`. Plan record: `docs/plans/completed/pi-1.6.0-upgrade-plan.md`.

These were bumped with the pin:
- `PI_AI_VERSION` in `scripts/patch-pi-oauth-branding.mjs`, and the fail-closed version check in its test
- the chord override keys (`@earendil-works/chord@1.6.0`)

## Dependency overrides

Each was checked with a lockfile-only `npm install` in a scratch copy, with and without the override.

- **Root chord `react 19.2.7`: kept.** chord 1.6 turned its optional peers into ranges (`react ^19.3.0`, `ws ^8.21.0`). Without the override npm resolves react 19.3.1 while react-dom stays 19.2.7, and every renderer test fails with "Incompatible React versions". Drop it when React moves to 19.3.
- **Root chord `ws 8.21.1`: dropped.** The lockfile is byte-identical without it.
- **CLI chord `ws 8.22.0`: dropped.** The lockfile is identical without it.
- **CLI `undici 8.12.3`: dropped.** It came from the 2026-10-27 security refresh (PR #611). pi-coding-agent 1.6.0 pins `undici 8.12.4` itself, for six newer advisories (GHSA-mqg3-3v4r-cm32, GHSA-7xg3-fphp-28hg, GHSA-5rm8-gv32-r954, GHSA-9v6h-8rgp-m69f, GHSA-3g9m-rv3r-w5w2, GHSA-r4pc-4jcp-7pqc), and the override held it below that fix. openai 7.59 accepts `undici >=5 <9`, so the CLI now has one undici 8.12.4. The only CLI lockfile change is undici 8.12.3 → 8.12.4. The root has undici 7.30.1 and 6.29.1 from other packages, unaffected.
- **Legacy `@earendil-works/pi-ai@0.87.1` override (`openai 7.19.0`, `@google/genai: $@google/genai`): kept.** pi-ai 1.6.0 moved to openai 7.59.0 and @google/genai 2.32.0, which nest under it at the root, beside the legacy harness's openai 7.19.0 and Aiden's direct @google/genai 2.24.0. The duplicates are accepted. Bumping the root @google/genai to 2.32.0 would dedupe it; that is an optional follow-up.

## OpenAI dropped-reasoning notice: hidden on every client on purpose

- **Shape.** It is not a session entry. pi-ai's `appendReasoningRemovals` (`openai-responses-shared.js`) adds an `AssistantMessage.diagnostics` item `{ type: "openai_input_transformations", details: { transformations: [{ type: "reasoning", id, action: "removed", reason }] } }`, leaving out `turn_boundary` removals. Pi's TUI turns it into "OpenAI dropped N reasoning items: … (details in session)" only when `showCacheMissNotices` is on (default off) and the count grew.
- **Desktop.** `storedPiAssistantMessage()` in `main/services/pi-message-storage.ts` omits `diagnostics` before anything is stored. Test: `generation-messages.test.ts`, "stored Pi provenance strips raw provider errors and diagnostics".
- **Server and phones.** `packages/cli/src/sessions.ts` and the Aiden Remote DTOs copy explicit allowlisted fields, and nothing reads `diagnostics`, so iOS and Android never receive it. No protocol revision.
- **Why hidden.** Pi hides it by default, the person cannot act on it, it recurs after every automatic compaction, and Aiden never surfaced the matching Anthropic `thinking_dropped` diagnostic either. If it is ever wanted, the place is the desktop context panel next to the last prompt-cache miss, not the transcript.

## Runtime (lane A)

- **Stopped tool batch.** After a stop, Pi 1.6 ends every unstarted call of a tool batch with an "Operation aborted" result instead of breaking off (Pi #9986). The desktop already marked those ends cancelled. The server (`packages/cli/src/daemon-chats.ts`) now marks a tool that ends after a stop as cancelled, with `stoppedByUser` for a person's Stop, instead of failed. Test: `packages/cli/tests/daemon-turns.test.mjs`.
- **Retries.** pi-ai retries more transient socket errors (bare `ECONNRESET`, `ECONNABORTED`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, "connection reset by peer", "connection closed"). Aiden delegates to Pi's classifier, so it adopts them with no change.
- **Not used by Aiden.** `RunEndTask` renamed `HookTask`, code-mode namespaces moved to `Extension.namespace` (Aiden declares none), `reload()` and RPC session switching, `takeUnreportedDiagnostics()`, `pi.exec`, `find`, and chord's `createWorkers` / `telemetryIngestFacet`. Durable `execute()` may now return a `ToolPark`; Aiden's narrower return type still type-checks.
- **Suspendable work is released.** pi-durable 1.6 ships signals and tools that park, the blocker of W3 in `docs/plans/upstream-week-2026-11-11-plan.md`. W3 has not started.

## One-way migration (no downgrade)

- Pi Durable 1.6 writes `pi.tool` tasks at version 4 and `pi.generation` tasks at version 3. An older Harness, including Aiden or `aiden serve` on Pi 1.5.2, blocks those tasks (`task_too_old`) and would treat a sleep without `until` as due.
- Downgrading the app after a Bot ran on 1.6.0 is not supported.
- The 1.5.2 migration note shipped in `docs/release-notes/v0.66.0.md`, so that obligation is met. The next version-bump PR (after 0.69.0) must add `docs/release-notes/v<version>.md` saying that a Bot that ran on Pi 1.6 cannot be opened by an older version. Per `docs/release-notes/README.md`, these files belong only in the version-bump PR.

## Models and providers (lane B)

- **Default models follow Pi.** `main/services/pi-default-models.ts` mirrors Pi 1.6.0's `defaultModelPerProvider`, and `piDefaultModelFor()` is used by `provider-registry`, `provider-list-core`, `aiden-remote-models`, `codex-provider` and the CLI `providers.ts`. With nothing saved, OpenAI, Azure and Codex start on gpt-6.2-sol on the desktop, the phones and the CLI; Anthropic starts on claude-opus-5-5 and Google on gemini-4-argon. Before, each started on its first-listed model. The stale `OPENAI_CODEX_DEFAULT_MODEL "gpt-5.4"` constant is gone.
- **GPT-6.2 thinking.** GPT-6.2 Astra and Sol never offer thinking "off". This comes from Pi's model data and is covered by the provider contract tests.
- **Anthropic message threads stay off,** including for custom connections to api.anthropic.com (tested). The 1.5.2 reasoning still holds.
- **Qwen Token Plan.** Pi adds Individual and Individual CN providers and per-plan keys (`QWEN_TOKEN_PLAN_TEAM_API_KEY`, `QWEN_TOKEN_PLAN_TEAM_CN_API_KEY`, `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY`, `QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY`); the shared `QWEN_TOKEN_PLAN_API_KEY` still works and Team is now named "Qwen Token Plan Team". No Aiden code change.
- **llama.cpp** keeps port 9931 in Aiden; no change.
- **Provider failures.** WebSocket closed, error and connection-limit errors now map to the network category in `provider-failure.ts`.
- **`resources/model-capabilities.json`** gains only the four models.dev entries for GPT-6.2 Astra and Sol (openai and azure), copied verbatim from a models.dev refresh and inserted after 6.1 Sol. The rest of the snapshot is unchanged; the full refresh still happens at release (`npm run dist`).
- **Follow-up, not changed:** `OPENAI_WEB_SEARCH_MODEL` in `web-search-openai-adapter.ts` is still "gpt-5.6".

## CLI branding anchors

No change. `packages/cli/scripts/patch-branding.mjs` still applies its 6 replacements: 1.6.0's `system-prompt.js` is unchanged apart from the patched lines. The `build.mjs` cli.md MCP anchor `pi mcp <add|remove|list|login|logout> [options]` still matches. The Pi docs that changed in 1.6.0 (extensions, models-configuration, nvidia-rtx-llama-cpp, providers, rpc-commands, tui) are not patched.

## Validation (local Mac)

- Root tsc, CLI type-check and CLI build: clean (6 branding replacements, 298 files).
- CLI tests: 371, 368 pass, 3 skipped. They ran on the old lockfile (undici 8.12.3); rerun after `npx npm@11.11.0 install` in `packages/cli`.
- `test:bot-runtime` 624/624; `test:compaction` 24/24 plus 900 (897 pass, 3 todo); `test:hooks` 184/184; replay gate exit 0; cachedPrefix passed.
- Provider suites 168/168; `test:model-picker` 87/87; `test:google-provider` 205/205; default-model consumer suites 379/379; provider-failure 8/8.
- `test:branding` 68 (66 pass, 2 skipped); `test:ci-policy` 123/123; `generation-messages.test.ts` 11/11.
- No E2E run: no UI or mobile change.

## Review follow-ups

- The default change also moves routines and Telegram bots that pin a provider without a model (`schedule-execution.ts`, Telegram `selectionProvider`). The next version-bump release notes must say so, alongside the one-way Durable migration, and note that Azure deployments without gpt-6.2-sol need a model chosen.
- `packages/cli/tests/parity.test.mjs` deep-compares `PI_DEFAULT_MODEL_PER_PROVIDER` with pi-coding-agent's unexported `dist/core/model-resolver.js` table, so a Pi bump that changes defaults fails until the copy is updated.
- WebSocket closes, errors and Codex's connection limit report the `websocket-closed` transport cause (added to the diagnostics allowlist).
- Phones still pick a switched-to provider's first model, not Pi's default (pre-existing; iOS `AidenChatPolicies.swift`, Android `AidenChat.kt`).
