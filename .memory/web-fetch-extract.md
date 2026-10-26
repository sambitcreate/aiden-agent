# Web page reading and extract mode — 2026-10-26

In review as PR #588 (branch `claude/project-thread-xxl0o7`); the owner merges. Plan: `docs/plans/web-page-extract-plan.md`. Guide: `docs/web-fetch-extract.md`.

The owner asked for pi-web-access v0.45.0's extract mode as a native feature, without installing the plugin, and chose a new page reader tool over extending Web Search.

## Where things live

- **Tool.** `main/services/web-fetch.ts`.
  - The tool is built per generation in `prepareGeneration` (`llm-client.ts`).
  - Gate: not a Bot, not the Assistant, `usageSource === "chat"` and not Telegram.
  - It follows the Web Search switch and the "Read web pages" setting, which is on by default.
- **Transport.** `web-fetch-transport.ts`, a public-address `BlockList` enforced through a custom `lookup` at connect time. Page text comes from `web-page-text.ts`.
- **Extraction.**
  - `web-extract-core.ts` holds the field types, the 0.80 threshold and the page matching (numbers with separators and k/m suffixes, dates in several forms, folded text).
  - `web-extract-models.ts` holds the Clairic adapter, which calls `@cf/cloudflare/clairic` on the person's account. It rotates `cloudflare-workers-ai` keys from the Web Search key pool.
  - Adding a model means a definition in `renderer/shared/web-fetch-settings.ts` and a factory.
- **Recap.**
  - `renderer/shared/web-extract.ts` (`buildWebExtractRecap`, `parseWebExtractRecap`). The tool result's `details` becomes the step's `extraction` in `generation-timeline.ts`.
  - The desktop card is `renderer/components/web-extract-recap.tsx`, wired in `message-list.tsx`.
- **Settings.** `renderer/components/settings/web-page-settings.tsx`, at the end of Settings → Web Search. IPC is `webSearch:pages:*` in `main/handlers/web-fetch.ts`.

## Rules that matter

- `extracted` needs the type, a confidence of at least 0.80 and the value found on the page. A value not on the page is `uncertain` with `notFound`, never `extracted`.
- Uncertain values travel as `guess`, never `value`.
- While extract mode is off or not set up, the schema doesn't offer `mode` or `fields`.
- The settings switch shows the saved choice. If extract is on but its setup goes missing, the row reads "Paused" with Needs setup and can still be turned off. A switch that is off can't be turned on until the setup is ready.
- A failed extraction returns the page text with the reason, and the recap carries `error` with no fields.
- Keys never reach tool args, results, the recap or portable config.

## Remote contract and phones

- Remote revision 40 is provisional. Re-claim it at merge by changing only `AIDEN_REMOTE_WEB_EXTRACT_CONTRACT_REVISION`, plus the fixture's `contractRevision` in two places, the iOS Phase0 test and the docs.
- OpenAPI has `WebExtractRecap` and `WebExtractRecapField`. A version 1 or 2 timeline must not carry `extraction`.
- The Ajv agreement test is in `aiden-remote-protocol.test.ts`. The runtime parser rebuilds the recap, so it drops stray keys while the schema rejects them. That case is asserted separately.
- iOS: `AidenWebExtractRecap` in `Models/AidenChat.swift` and `AidenWebExtractRecapView` in `AidenChatFeature.swift`.
- Android: `models/AidenWebExtractRecap.kt` and `features/chat/AidenWebExtractRecapView.kt`.
- Both phones drop a bad recap and keep the step, emit `extraction` chronological rows after the tool group row, and count "web page(s)" in the Explored summary. Their one-line check mirrors JS `\s`.
- The Swift and Kotlin code wasn't compiled in the cloud container. The Kotlin model was checked in a scratch JVM project.

## Token trim

- Tokens measured with the o200k tokenizer over `web_search`, `browser_tools`, the 14 browser tools and `BROWSER_AGENT_GUIDANCE`:
  - description text: 1,015 → 440;
  - whole definitions: 2,754 → 1,566.
- An earlier plan figure of 2,667 left out `web_search` (87 tokens).
- `advertisedBrowserSchema` strips limits from what the model sees. `execute` re-validates against the strict schema, and the browser-tools test checks both.
- `web_fetch` adds 51 tokens in read mode and 163 in extract mode.
