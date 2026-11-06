# Web page reading and extract mode — 2026-10-26

Merged as PR #588 on 2026-10-26 (owner enabled auto-merge); unreleased. Plan: `docs/plans/web-page-extract-plan.md`. Guide: `docs/web-fetch-extract.md`.

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

- Remote revision 38, claimed at merge on 2026-10-26 after `main`'s 37. It lives in `AIDEN_REMOTE_WEB_EXTRACT_CONTRACT_REVISION`, the fixture's `contractRevision` (two places), the iOS Phase0 test and the docs.
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

## 2026-11-02: complete numeric and citation support (backlog 9.1 / 9.2)

Reconfirmed both findings on `9b2875d65f316265323d3d06a73904fbe00e2277` before editing: a high-confidence `1.2` matched `1.2k`, and `New York` split across lines cited only `New`. Three added core regressions and a real WebFetchService → structured output/model text/validated recap test failed before the fix. No paid provider or website calls.

- A scale suffix now determines the only numeric reading; signed, case-insensitive and word scales stay supported. Unit boundaries remain distinct. A later exact decimal no longer borrows an earlier scaled token's citation, and the quoted support includes the suffix.
- Text matching retains exclusive raw ends for whole normalized characters/combining marks and the entire multiline span. Citation windows flatten whitespace before sizing and retain all support or return none. Lists cover every item's support (separate spans use ` … `); datetime spans include time and offset as well as date.
- A value whose full support cannot fit the existing 200-character citation becomes `uncertain`, without `sourceLine` and without `notFound` if it exists on the page. The Remote shape/revision and native rendering stay unchanged; iOS/Android tests cover these recaps surviving cache round trips.
- Local validation: `npm run test:web-fetch` 63/63; protocol + generation-timeline suites 99/99; Android `AidenChatTest` 137/137; iOS three selected recap XCTest methods 3/3 on the isolated iPhone 17 Pro / iOS 26.5 simulator `29A9A9C8-97CD-461C-98FE-28930588DFDC` (not physical-device acceptance). Type-check, scoped ESLint and `git diff --check` pass. Dependencies reused from the existing local install, with Pi 1.4.0 and parse5 7.3.0 checked; no install or paid/live network validation.
- Branch `feature/web-extraction-evidence`; PR creation is authorized, but merge is not. The coordinator owns hosted CI/review polling.

### PR #715 review: Unicode citation budget

Review `PRRT_kwDOTctvDc6y7A1y` correctly identified that the new overflow guard at `9752d9415fc12edee25ec6f02d0dfe9274b95431` used UTF-16 length while the recap validator and phone clients count code points/scalars. A real extraction/validator matrix reproduced incorrect downgrades for 101/200 emoji, windowed and multiline support; genuine over-budget controls stayed uncertain. Two new core behavioral tests failed before the correction; the overflow control passed.

Citation sizing now translates flattened prefixes at the existing raw UTF-16 offsets to code-point indices, then budgets context/ellipsis markers and slices a code-point array. Whole normalized-character match ends remain unchanged. Tests include one/two required omission markers, mixed astral context, CRLF multiline support, actual 201-code-point overflow and decomposed combining marks (counted as scalars, not visual glyphs). The WebFetchService and both native cache/parser suites exercise the same boundary. No Remote shape or revision change.

Validation: the retained 12-case extraction/validator matrix now has zero mismatches; all returned windows retain full support without unpaired surrogates. `npm run test:web-fetch` 67/67; protocol/timeline 99/99; Android `AidenChatTest` 138/138; iOS four selected recap methods 4/4 on the same isolated iOS 26.5 simulator. Full type-check, scoped ESLint and whitespace checks pass. No live provider/web requests, full Electron E2E or physical-device validation. The substantive correction remains on the established #715 branch, with hosted checks/review follow-up owned by the coordinator.
