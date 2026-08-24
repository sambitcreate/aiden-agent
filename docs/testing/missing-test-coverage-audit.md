# Missing Test Coverage Audit

Date: 2026-08-24  
Scope: Aiden Agent Electron app (`main/`, `renderer/`, `scripts/`, `tests/e2e/`, `native/`) and Aiden On The Go (`ios/`)  
Method: source-vs-test inventory, `package.json` script expansion against CI (`.github/workflows/ci.yml`), contract tests, and iOS XCTest files. Three parallel codebase research agents were used for coverage, Remote API, and iOS cache/load paths. The requested Deepseek v4 flash 0731 subagent model is not available in this environment; research used the default Cursor agent model.

This is a findings document, not an implementation. It lists missing cases and CI holes. Do not treat “has a sibling `*.test.ts`” as behavioral coverage.

## 1. Executive verdict

Aiden’s suite is large and strong on protocol, pairing, Bot contracts, Remote routing, and focused core services. The gaps that actually matter are not “add a test file next to every module.” They are:

1. **CI does not run several registered suites.** Hosted `npm test` is `pretest` + `test`. `test:preflight`, `test:command-system`, `test:artificial-analysis`, `test:model-pad`, `test:google-provider`, `test:config-recovery`, `test:concentrate`, and most of `test:coverage` are not on that path. Those tests exist and look maintained, but a regression can merge without them.
2. **Three test files are not registered in any npm script**, so they never run in CI or a normal local `npm test`.
3. **iOS XCTest is compile-only in CI.** Hosted GitHub Actions builds the test bundle for generic iOS hardware and does not execute it. Behavioral iOS coverage depends on signed physical-device runs.
4. **Workspace Remote chat list hydrates every full transcript** (`GET /chats` → `listRegular` then `Promise.all` of `get()` + full `projectAidenRemoteChat`). There is no test that this list stays a summary, stays under the 1 MiB cap with many chats, or that iOS home can render without that payload.
5. **High-risk runtime owners have little or no direct coverage:** `main/services/llm-client.ts`, several Electron handlers (`providers`, `workspaces`, `local-voice`, `dictation`, `telegram`, `subagents`, `computer-use`), iOS SSE/Keychain/App Intents/Live Activities, and almost every settings/chat-pane UI module.

Priority: close the CI registration holes first, then add contract tests for the chat-list payload and iOS cache-first Workspace path, then fill P0 behavioral gaps around generation, handlers, and iOS networking.

## 2. Inventory

| Layer | What exists | How it is supposed to run |
| --- | --- | --- |
| Node/tsx unit and contract | ~400 `*.test.ts` / `*.test.tsx` / `*.test.mjs` files under `main/`, `renderer/`, `scripts/` | `npm test` (`pretest` then `test`) on CI |
| Coverage-oriented sibling scripts | `test:coverage`, `pretest:coverage`, `test:preflight`, `test:command-system`, `test:artificial-analysis`, `test:model-pad`, `test:google-provider`, `test:config-recovery`, `test:scheduled`, `test:concentrate` | **Not** invoked by `.github/workflows/ci.yml` |
| Playwright E2E | 8 specs in `tests/e2e/` | Separate `e2e` CI job via `npm run test:e2e` |
| iOS XCTest | 12 files / **264** `func test…` methods in `ios/AidenOnTheGoTests/` | Physical-device only; CI only `xcodebuild build-for-testing` |
| iOS release policy | Ruby + Node scripts | `pretest` → `test:ios-release` |
| Native Swift (Foundation Models helper) | `npm run test:native` | Separate CI step |
| Native Rust (Computer Use broker) | `test:computer-use:native` | End of `npm test` |
| Native C helpers | worktree remover, bot inbox writer, subagent run-store / file-mutator / shell-runner | Various `pretest:*` scripts |

CI (`ci.yml` `verify` job) actually runs: `type-check`, `lint`, `test:branding`, `npm test`, `test:native`, iOS `build-for-testing`, then `build`. The `e2e` job runs Playwright.

`npm test` already pulls in a large pretest graph: Remote, service-boundary, iOS release policy, terminal coverage, onboarding, assistant automations, slash commands, provider-failure, compaction, subagents, and bots. That is real coverage. It is not the full inventory of test files in the repo.

## 3. Tests that never run in CI

### 3.1 Unregistered files (exist, no npm script owner)

These files are not named in any `package.json` script, including nested `npm run` expansion:

| File | Why it matters |
| --- | --- |
| `main/services/subagents/background-subagent-coordinator-v2.test.ts` | App-lifetime background coordinator. The Subagent Orchestration plan’s next milestone is activating this coordinator. The test exists and is invisible to CI. |
| `main/services/subagents/subagent-runtime-diagnostics.test.ts` | Bounded diagnostic capture, log rotation, secret redaction, `0600` modes. Privacy/safety coverage that is easy to regress. |
| `scripts/subagent-inference-worker-smoke.test.mjs` | Electron worker smoke that the plan treats as a real gate. Not wired into `test:subagents` or `npm test`. |

Playwright specs under `tests/e2e/*.spec.ts` are **not** listed file-by-file in `package.json`. That is fine: `npm run test:e2e` uses `playwright.config.ts`. Do not “register” them as `tsx --test` files.

### 3.2 Suites registered but not on the `npm test` path

These run only if someone remembers the extra script, or `npm run test:coverage` / `pretest:coverage`:

| Script | Representative files that CI `npm test` does not execute |
| --- | --- |
| `test:preflight` | `appearance-preview-core.test.ts`, `generation-timeline.test.ts`, `mcp-tool-result.test.ts`, `pi-thinking-disclosure.integration.test.ts`, `reasoning-block.test.tsx`, `reasoning-visibility-control.test.tsx`, `thinking-control.test.tsx`, `agent-steps.test.ts`, `streaming-reveal.test.ts`, `voice-recorder-core.test.ts`, `pill-preload-channels.test.ts`, thinking-contract shared tests |
| `test:command-system` | `native-menu-command-contract.test.ts`, `shortcut-registration-core.test.ts`, `shortcut-transaction-core.test.ts`, `command-palette-*.test.ts`, `keybindings.test.ts` |
| `test:artificial-analysis` | `artificial-analysis-*.test.ts`, `model-data-control.test.ts` |
| `test:model-pad` | `model-pad-layout.test.ts`, `pi-provider-display.test.ts`, `google-provider-migration.test.ts` |
| `test:google-provider` | `anthropic-provider.test.ts`, `google-provider.test.ts`, `provider-config-migration-core.test.ts` |
| `test:config-recovery` | `legacy-pi-credential-migration-core.test.ts`, `mcp-credential-cleanup-core.test.ts`, `mcp-oauth-store-core.test.ts`, `provider-credential-rotation-core.test.ts` |
| `test:scheduled` extras | `schedule-notification.test.ts`, `schedule-script.test.ts`, `scheduled-task-view.test.ts` (other schedule files do run via `test:assistant-automations`) |
| `test:concentrate` | `concentrate-provider.test.ts` |
| `test:coverage` only | `renderer/lib/codex-auth-view-state.test.ts` |

`test:branding` and `test:native` **are** on CI; they are just not inside `npm test`. That split is intentional.

`test:bots:coverage` and terminal `--experimental-test-coverage` gates are local/coverage tools, not missing product tests.

### 3.3 iOS tests are not executed on hosted CI

`.github/workflows/ci.yml` says so explicitly: physical-device-only XCTest; CI only compiles. A broken iOS assertion will not fail GitHub Actions unless it also fails TypeScript/Node contract tests or the compile.

Missing CI-executable iOS cases therefore have to be expressed twice when they are protocol-level: once in `main/services/aiden-remote-*.test.ts` / shared fixtures, and once in Swift. Several Bot/Remote cases already do that. Workspace home loading, SSE resume, Keychain, and App Intents do not.

## 4. What is already well covered (do not duplicate)

Keep these as regression anchors; new tests should extend them rather than fork new frameworks.

- **IPC allowlist drift:** `main/handlers/ipc-contract.test.ts` parses production TypeScript so renderer invoke prefixes and notification channels cannot silently diverge.
- **Remote protocol / OpenAPI / fixtures:** `aiden-remote-protocol.test.ts`, `aiden-remote-operation-contract.test.ts`, `aiden-remote-router.test.ts`, `protocol/aiden-remote/v1/`.
- **Pairing, TLS pin, Tailscale ownership, revocation:** dedicated Remote service tests plus iOS pairing tests in `AidenRemotePhase0Tests` / `AidenRemoteClientTests`.
- **Bot classification, one-chat-per-bot, cache A→B→A fencing, avatars, access revisions:** `aiden-remote-bots.test.ts`, `AidenBotCacheTests`, `AidenBotContractTests`, `AidenBotGeneratedAvatarTests`.
- **Chat projection allowlists, 1 MiB cap, 10_000 message cap, Bot vs regular list split:** `aiden-remote-chats.test.ts`.
- **Onboarding, slash commands, subagent v2 contracts, Telegram unit graph, Computer Use native broker.**

The Bot inbox path is the model for “cache-first + tests.” Workspace chat list is not.

## 5. Missing cases by area

Priority:

- **P0** — can hide data loss, auth/capability bugs, CI-blind regressions, or multi-second iOS loads
- **P1** — user-visible wrong behavior without a current automated net
- **P2** — UI/polish, settings, or deferred product surfaces

### 5.1 P0 — CI and payload contracts

| Missing case | Evidence | Suggested test |
| --- | --- | --- |
| Register and run the three orphan subagent files | Files have no `package.json` owner | Add them to `test:subagents` / `pretest:subagents`; keep the Electron smoke behind the existing worker build |
| Put `test:preflight`, `test:command-system`, `test:config-recovery`, and provider suites on a CI path | `ci.yml` only runs `npm test` | Either fold them into `pretest` or add an explicit CI step. Do not leave “coverage” as the only runner |
| `GET /chats` hydrates every chat body | `AidenRemoteChatService.list` maps metadata → `this.chat(id)` → full `projectAidenRemoteChat` | Assert list uses metadata/previews only, or assert a many-chat fixture stays under `AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES` and does not read every journal. Today the test only checks IDs |
| List vs get payload shape | OpenAPI `listChats` items `$ref` the full `Chat` schema, including `messages` | Contract test that a Workspace home client can decode a summary DTO; fail if messages are required on list |
| iOS Workspace home ignores `AidenChatCache` | `AidenWorkspaceHomeModel.load` calls `client.chats()` with no workspace filter and no cache hydrate | Swift test: cached regular chats paint before network; Bot chats stay excluded; empty cache + 413/timeout shows a retryable error |
| Coordinator connect has no workspace snapshot cache | `AidenRemoteCoordinator.load` always `server()` + `workspaces()` | Cold start with saved workspaces should show the last registry before the round trip, then reconcile |

### 5.2 P0 — generation, handlers, and persistence owners

| Missing case | Source without adequate test | Suggested test |
| --- | --- | --- |
| Turn start / tool approval / cancel / remote vs renderer ownership | `llm-client.ts` (~2.7k lines), `chat-generation-owner.ts` is tested, the client is not | Extracted admission/stop/remote-owner cases: Bot policy refuse, Computer Use opt-in, stop does not leak tools, remote device owns the stream |
| Chat JSON durability / partial write | Called out in `performance-stability-efficiency-plan.md`; `chat-store-core.test.ts` covers happy path more than fault injection | Kill during rename, truncated JSON, last-good generation, index rebuild |
| Attachment aggregate bounds | `attachments.ts` / handlers; contract tests exist for DTO shape | Sparse huge file, many near-limit images, concurrent selection, remote staging capacity (`aiden-remote-attachments.ts` has **no sibling test file**) |
| Provider handler auth session | `main/handlers/providers.ts` | IPC parse + main-owned completion; onboarding plan already tracks hosted/local validation |
| Workspace handler permission elevation | `main/handlers/workspaces.ts` | Confirm foreground evidence required; Remote already tests this on HTTP, Electron IPC should match |
| Local voice / dictation main-thread load | `local-voice.ts`, `dictation.ts`, `parakeet.ts` | Do not load the recognizer in unit tests; test that bounds, cancellation, and cache keys fail closed |
| Telegram handler surface | `main/handlers/telegram.ts`; core Telegram files are well tested | Handler-level grant/ceiling so Computer Use/subagents cannot enter via IPC the way the Bot-first plan forbids on Telegram |
| Subagent IPC handler | `main/handlers/subagents.ts` | Control-plane parse already has some core tests; handler registration and document-owner checks need an explicit contract like `bots.contract.test.ts` |

### 5.3 P1 — Aiden Remote HTTP

Covered well: pairing, router method matrix, Bot CRUD, files/git/schedules happy paths, opaque handles, revocation.

Missing or thin:

| Missing case | Notes |
| --- | --- |
| Chat list N+1 and 1 MiB overflow across many chats | See P0 |
| `GET /models` artwork budget under concurrent iOS chat opens | Catalog is truncated at 900 KiB; no test that iOS opening 3 chats does not refetch/decode artwork every time |
| `GET /usage` after Workspace home chats | Home loads chats+tasks+catalog, **then** usage. No test that usage failure does not blank chats |
| SSE `Last-Event-ID` / `after` resume across process death | Stream tests exist; iOS `AidenSSEParser` has no dedicated XCTest file |
| Conditional GET / collection revision | Not implemented; when added, tests must prove stale 304 vs capability change (device grant dropped) never serves a 304 |
| `Cache-Control: no-store` on immutable avatar/attachment GETs | Today correct for privacy-by-default; a future immutable cache must still purge on revocation |
| `aiden-remote-service-main.ts`, `aiden-remote-errors.ts`, `aiden-remote-workspace-owners.ts` | Wiring/main adapters; test through the service, but error-code mapping deserves a table test |
| Git mutation disconnect ownership | Workspace environment tests cover idempotency keys; missing: operation still owned after SSE drop (plan requires this) |

### 5.4 P1 — iOS application

12 XCTest files, 264 tests. Strong: Remote client routes, Bot contracts, Bot cache, chat cache, avatars, pairing payload, product-shell policy helpers, scheduled-task cache, workspace files/git DTO safety.

| Missing case | Source | Suggested test |
| --- | --- | --- |
| SSE parser framing, Last-Event-ID, unknown terminal event fail-closed | `Networking/AidenSSEParser.swift` | Isolated parser tests with truncated frames and unknown terminal states |
| Keychain write/read/delete and credential-scope isolation | `Auth/KeychainStore.swift` | Physical-device; at least a mockable seam test that A→B install cannot read A’s credential |
| App Intents are cache-only navigation | `AppIntents/AidenAppIntents.swift` | Assert intents never receive the bearer token and fail when the App Group snapshot is missing |
| Live Activity attributes bounded / no prompt text | `LiveActivities/*` | Decode/encode round-trip; reject oversized status |
| Workspace home waterfall | `AidenWorkspaceHomeModel.load` | Does not hydrate `AidenChatCache`; fetches **all** chats; usage is serial after the batch |
| Workspace registry offline | `AidenRemoteCoordinator` | No disk cache for `workspaces`; airplane mode after a successful session should still show names |
| Model catalog reuse across chats | `AidenChatFeature.load` always `chat()` + `modelCatalog()` | Second chat in the same session should not require a second catalog round trip |
| Draft store vs Bot/Workspace shared key | `AidenChatDraftStore` | BotCacheTests cover some; missing: instance switch, Bot vs Workspace same `chatId` (IDs should be globally unique—assert that) |
| Composer voice | `ComposerVoiceInputController.swift` | Dictation permission denied, empty buffer, no upload of audio |
| Deep link after revocation | `AidenDeepLink.swift` + coordinator purge | Open `aiden-otg://` after credential revoke does not restore purged cache |
| iPad split / Stage Manager | Shell views | Documented as physical-iPad acceptance; add layout-state unit tests for selection reconciliation (`AidenWorkspaceNavigation`) — some exist; missing compact↔split memory |

### 5.5 P1 — Electron renderer

Contract tests exist for composer, sidebar, assistant hook, chat-transition, some activity. Almost no tests for the actual panes.

| Missing case | Source |
| --- | --- |
| Chat pane streaming + stop + approval | `renderer/main/chat-pane.tsx` |
| Markdown / streaming reveal idle RAF | `streaming-markdown-reveal.tsx` (performance plan P1) |
| Model picker closed-state catalog work | `model-picker.tsx` |
| Command palette | `command-palette.tsx` (logic tests exist in `renderer/lib`; the UI does not) |
| Settings sections | entire `renderer/components/settings/` except Remote Access |
| Git commit/push dialogs | `git-*-dialog.tsx` |
| Files / review panels | `files-panel.tsx`, `review-panel.tsx` |
| Bot face studio / avatar | `bot-face-studio.tsx`, `bot-avatar.tsx`; Mac canonical photo cache `bot-canonical-photo-cache.ts` has **no sibling test** |
| Terminal drawer | `terminal-drawer.tsx` |
| Assistant dock chrome | `assistant-dock.tsx` / panel / thread (hook/UI contract tests exist; chrome states do not) |

Prefer testing extracted lib functions (already the house style) over mounting every settings page. The missing lib tests that hurt: `bot-canonical-photo-cache.ts`, `append-reconciliation.ts`, `queries.ts` refetch-interval policy.

### 5.6 P1 — Mac React Query / Git polling

`renderer/lib/queries.ts`:

- `useGitInfo` refetches every **5s**
- `useGitReview` every **4s**
- `useGitPushCapability` every **5s**

The performance plan already flags ~6 Git subprocesses per info call. There is no test that hidden/minimized windows disable these intervals, or that `enabled: false` is wired from the review panel closed state in all routes.

### 5.7 P2 — scripts, packaging, E2E product surfaces

| Missing case | Notes |
| --- | --- |
| Playwright: Bots mode | E2E covers onboarding, chat shell, attachments, terminal, model picker, assistant scheduled profile, Remote Access enable/health. No Bot create/archive/favorite |
| Playwright: Telegram, Computer Use UI, subagent panel, compaction UI | Computer Use has packaged/native tests; no window-level E2E |
| Playwright: Remote pairing QR/manual | Lifecycle spec only toggles the setting and hits `/health` |
| `test:e2e:live:lmstudio` | Manual/live; keep it out of default CI |
| Packaging scripts | Many `scripts/*.test.mjs` are on `npm test`; keep it that way when adding scripts |

## 6. Source modules without a sibling test (guidance, not a todo dump)

A sibling-file scan finds ~238 production `main/` + `renderer/` files without `foo.test.ts` next to them. That number is inflated by adapters (`*-main.ts`, `*-production.ts`), type-only modules, and UI. Use it as a map, not a quota.

Highest-value untested (or only indirectly tested) modules:

**Main runtime**

- `llm-client.ts`, `parakeet.ts`, `local-models.ts`, `mcp.ts` (if present as orchestrator), `pi-catalog-refresh.ts`, `pi-message-storage.ts`, `chat-cancel.ts`, `chat-deletion-reconciliation.ts`
- `aiden-remote-attachments.ts`, `aiden-remote-service-main.ts`
- `bot-canonical-chat.ts` (logic is covered via inbox/Remote tests; keep a direct unit if the selector changes)
- `main/handlers/{providers,workspaces,local-voice,dictation,telegram,subagents,computer-use,usage,profile,terminal,title-providers,app,artificial-analysis}.ts`

**Renderer**

- `renderer/lib/queries.ts`, `bot-canonical-photo-cache.ts`, `workspace-context.tsx`
- `renderer/main/{chat-pane,chat-layout,settings-view,router}.tsx`
- Settings and environment panels listed in §5.5

**iOS (no XCTest file at all)**

- `AidenSSEParser.swift`
- `KeychainStore.swift`
- `AidenAppIntents.swift`
- `AidenRemoteLiveActivityManager.swift` / `AgentRunActivityAttributes.swift`
- `ComposerVoiceInputController.swift`
- `AidenDeepLink.swift` (partial via coordinator tests)
- `AidenWorkspaceShellView.swift` load path (navigation helpers are tested; the home model network mix is not)

## 7. iOS XCTest map vs product surfaces

| Surface | Test file | Gap |
| --- | --- | --- |
| Pairing / trust / protocol headers | `AidenRemotePhase0Tests`, `AidenRemoteClientTests` | Good |
| Bot DTO / access / catalog | `AidenBotContractTests` | Good |
| Bot disk cache / A→B→A | `AidenBotCacheTests` | Good; home `load()` orchestration is only indirectly tested |
| Product shell policy | `AidenProductShellTests` | Skeleton/cold-load helpers; not the network/cache merge |
| Chat cache / streams / attachments | `AidenChatTests` | Workspace **home** does not use this cache |
| Files/Git environment cache | `AidenWorkspaceEnvironmentTests` | Good for DTO + cache scope |
| Schedules | `AidenScheduledTaskTests` | 3 tests; thin on preview/run-now errors |
| Avatars / Image Playground | `AidenBotGeneratedAvatarTests`, `AidenBotImagePlaygroundTests` | Good |
| Native integration / shipping guards | `AidenNativeIntegrationTests` | Compile/source policy, not runtime cache |
| Prototype snapshots | `AidenBotPrototypeSnapshotTests` | 1 test; not product-critical |

## 8. E2E map vs product surfaces

| Spec | Covers | Does not cover |
| --- | --- | --- |
| `onboarding-lmstudio.spec.ts` | First-run LM Studio | Codex/hosted/local validation matrix |
| `chat-shell-interactions.spec.ts` | Shell chrome | Long-stream, approvals, stop |
| `lmstudio-chat-attachments.spec.ts` (+ live) | Attachments | Remote attachment staging |
| `terminal.spec.ts` | Terminal | Persistence across chat switch |
| `settings-model-picker.spec.ts` | Model picker | Closed-picker catalog cost |
| `assistant-scheduled-profile.spec.ts` | Assistant + schedules + profile | MCP tool loop |
| `remote-access-lifecycle.spec.ts` | Enable Remote, `/health` after window close | Pairing, Bot routes, chat list payload |

## 9. Recommended delivery order

1. **CI completeness (no product change)**  
   Register the three orphan files. Add `test:preflight`, `test:command-system`, `test:config-recovery`, and the provider scripts to CI or to `pretest`. Keep Playwright and native jobs as they are.

2. **Contract the expensive reads (unblocks iOS cache work)**  
   Tests for chat-list projection size, metadata-only listing, iOS Workspace cache-first, coordinator workspace snapshot, model-catalog reuse. Details live in `docs/plans/ios-remote-caching-strategy-plan.md`.

3. **Handler contracts** for providers, workspaces, telegram, subagents, attachments remote staging — copy the `bots.contract.test.ts` / `ipc-contract.test.ts` pattern.

4. **iOS parser/intent/Live Activity unit tests** that do not need a device, plus keep physical-device tests for Keychain.

5. **Renderer lib tests** for Git refetch gating and canonical photo cache.

6. **Playwright** Bot happy path and Remote pairing only after the list/summary API is stable.

## 10. What not to do

- Do not add a test file for every `*-main.ts` adapter or every settings row.
- Do not run iOS XCTest on the GitHub-hosted runner without a device; keep compile-for-testing plus physical evidence.
- Do not call models.dev from tests.
- Do not weaken fail-closed decoding tests to make cache-first easier.
- Do not treat `test:coverage` as a substitute for CI.

## 11. Traceability

| Claim | Location |
| --- | --- |
| CI test commands | `.github/workflows/ci.yml` |
| `npm test` graph | `package.json` `pretest`, `test` |
| Chat list hydrates bodies | `main/services/aiden-remote-chats.ts` `list()` |
| JSON/message caps | `main/services/aiden-remote-protocol.ts` |
| iOS Bot cache-first | `ios/AidenOnTheGo/Features/Bots/AidenBotsHomeView.swift` `load()` |
| iOS Workspace home network mix | `ios/AidenOnTheGo/Features/Remote/AidenWorkspaceShellView.swift` `AidenWorkspaceHomeModel.load` |
| iOS chat detail + catalog | `ios/AidenOnTheGo/Features/Remote/AidenChatFeature.swift` `load()` |
| Ephemeral URLSession, no HTTP cache | `ios/AidenOnTheGo/Networking/AidenRemoteClient.swift` `makePinnedSession` |
| Global `Cache-Control: no-store` | `main/services/aiden-remote-router.ts` `responseHeaders()` |
| Unregistered subagent tests | files in §3.1 vs `package.json` |
| Git poll intervals | `renderer/lib/queries.ts` |
