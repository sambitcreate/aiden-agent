# Pi 1.6.0 upgrade

## Status

Complete on branch `chore/pi-1.6.0-upgrade` (2026-11-24). The desktop and CLI Pi packages moved from exactly 1.5.2 to exactly 1.6.0 in lockstep; the frozen 0.87.1 legacy harness is unchanged. The dependency record, with the reasoning behind each decision, is [`.memory/pi-1.6.0-upgrade.md`](../../../.memory/pi-1.6.0-upgrade.md).

## Scope

The upgrade was split into three lanes that touched separate files.

| Lane | Area | Outcome |
| --- | --- | --- |
| Pins | Root and CLI `package.json`, both lockfiles, chord override keys, `PI_AI_VERSION` | Exact 1.6.0 pins; type-check passes. |
| A | Runtime, extensions, Durable, server | One change: the server shows the calls of a stopped tool batch as stopped, not failed, as the desktop does. Pi's wider socket retries are adopted with no change. The Durable and chord breaking changes touch nothing Aiden uses. |
| B | Models, providers, catalog, thinking levels | With nothing saved, each provider starts on Pi's default model (`main/services/pi-default-models.ts`): gpt-6.2-sol for OpenAI, Azure and Codex, claude-opus-5-5 for Anthropic, gemini-4-argon for Google, on desktop, phones and CLI. GPT-6.2 never offers thinking "off". Anthropic message threads stay off. WebSocket failures count as network errors. Qwen Token Plan's new providers and keys need no change. The models.dev snapshot gains only the four GPT-6.2 entries (openai and azure). |
| C | Build, branding, overrides, transcript notice, docs | Branding anchors unchanged. Redundant chord `ws` overrides and the CLI `undici` override dropped; root chord `react` override kept. OpenAI's dropped-reasoning notice stays hidden on every client. |

## Decisions

1. **Overrides.** Keep the root chord `react 19.2.7` override; without it npm resolves react 19.3.1 beside react-dom 19.2.7. Drop both chord `ws` overrides, because the lockfiles are identical without them. Drop the CLI `undici 8.12.3` override, because pi-coding-agent 1.6.0 pins undici 8.12.4 for six newer advisories and the override held it back.
2. **Dropped-reasoning notice.** Pi 1.6 records reasoning items OpenAI removed as an `openai_input_transformations` diagnostic on the assistant message, and its terminal shows it only with `showCacheMissNotices` on, which is off by default. Aiden strips message diagnostics before storing them, and the Aiden Remote contract only carries allowlisted fields, so desktop, iOS and Android all leave it out. No protocol revision. The person cannot act on it, and Aiden never showed the matching Anthropic notice either.
3. **Stopped tool batches.** After a stop, Pi now ends every unstarted call of a batch with an "Operation aborted" result. The server marks those cancelled (`stoppedByUser` for a person's Stop) instead of failed.
4. **One-way migration.** Pi Durable 1.6 writes `pi.tool` v4 and `pi.generation` v3 tasks, which an older Harness blocks as `task_too_old`. Downgrading after a Bot ran on 1.6.0 is not supported, and the next version-bump PR must say so in `docs/release-notes/v<version>.md`. The equivalent 1.5.2 note shipped in `v0.66.0.md`.
5. **Web search model.** `OPENAI_WEB_SEARCH_MODEL` stays `gpt-5.6`. It is the fallback for the separate OpenAI web-search tool, not the chat default, and Pi's default change does not reach it.
6. **Upstream week W3.** pi-durable 1.6 releases signals and tools that park, which [W3](../upstream-week-2026-11-11-plan.md) waited for. W3 is unblocked but not started; it is not part of this upgrade.

## Validation

Local Mac:

- Root tsc, CLI type-check and CLI build: clean.
- CLI tests: 371, 368 pass, 3 skipped (rerun after the reinstall moved undici to 8.12.4).
- Snapshot suites (`pi-provider-contract`, `update-model-capabilities`, `model-snapshot-core`): 13/13.
- `test:bot-runtime` 624/624, `test:compaction` 24/24 plus 900 (897 pass, 3 todo), `test:hooks` 184/184, replay gate and cachedPrefix passed.
- Provider suites 168/168, `test:model-picker` 87/87, `test:google-provider` 205/205, default-model consumers 379/379, provider-failure 8/8.
- `test:branding` 66 pass, 2 skipped; `test:ci-policy` 123/123; `generation-messages.test.ts` 11/11.

No E2E: the upgrade changes no UI or mobile code.
