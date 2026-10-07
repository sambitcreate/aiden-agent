# Chat visibility (Studio Foundation F-3, PR A)

Branch: `feature/studio-chat-visibility`. Binding spec: `docs/plans/studio-foundation-adr.md` F-D5.

## Classifier
`renderer/shared/chat-visibility.ts` (Electron-free; bundled by the CLI) exports
`chatSurface(chat)` and `isUserVisibleChat(chat)`. Four surfaces: `regular`, `assistant`,
`bot`, `feature`. Precedence: any present `owner` -> `feature` (even a malformed one: fail
closed), then `botId` -> `bot`, then persisted Assistant workspace -> `assistant`, else `regular`.
`ChatOwnerV1 = { kind: "design-project"; projectId }`, parsed strictly by `parseChatOwnerV1`.
Sites admit surfaces by allow-list, so any future owner kind is hidden everywhere by default.
Only main-internal callers can set `owner`; public parsers and Remote create cannot.

## list() / listSummaryMetadata() stay unfiltered (do not "fix")
Startup reconciliation derives the live chat-ID set from `chatStore.list()` and then
garbage-collects `piRuntimeEffectStore` / `piCompactionSessionStore` state for missing IDs.
Filtering would delete the state of hidden (feature-owned) chats on every launch. The
reconcile step is extracted as `reconcileChatScopedStores` in
`main/services/startup-chat-reconciliation.ts` and pinned by a test that a hidden chat's ID
still reaches every store. Other full-list consumers that must stay unfiltered:
`fork-summary-service-main.ts`, `empty-chat-migration-main.ts`, `bot-capability-services-main.ts`,
`bot-inbox-projection` (`listChatMetadata: () => chatStore.list()`), `aiden-remote-service-main.ts`.
Only `listRegular` (sidebar/search/palette/Remote list) is filtered.

## Site table (ADR-F F-D5)
| # | Site | Change |
|---|---|---|
| 1 | `chat-store-core` `listRegular` | surface in {regular, assistant} (Assistant inclusion unchanged) |
| 2 | `aiden-remote-chats` `safeSummaryMetadata` | surface === regular (summaries, cursors, host feed) |
| 3 | `aiden-remote-chats` `classify` | feature -> `not_found` for every per-chat Remote route |
| 4 | `aiden-remote-chat-progress-authorize` | surface not in {regular, bot} -> 404 |
| 5 | `chat-fork-service` / `copyVisibleHistory` | Assistant or feature -> `ineligible` / refused |
| 6 | `rpiv-btw/service-core` | surface !== regular -> refuse side questions |
| 7 | `empty-chat-migration` | surface === regular (never sweep a fresh owned chat) |
| 8 | `botChatIds` | unchanged (store rejects owner + bot) |
| 9 | skill catalog | unchanged (`classify` refuses feature chats first) |
| 10 | `chats:todoSnapshot` | unchanged (design chats have no todo tool) |
| 11 | `chat-workspace-authority` | DS-1a, not this PR |
| 12 | Assistant-ID reservation guards on create | unchanged (creation guards, not visibility) |
| 13 | Assistant UI | unchanged |
| 14 | startup/background reconcilers | full `list()`; first one extracted and tested |

Store guards: `create` refuses `owner` + `botId`; `isValidMeta` accepts only undefined or a
valid owner (damaged owner => record invalid => hidden); `metaOf` propagates `owner`;
`copyVisibleHistory` never copies it.

## Wire shape
No change. `owner` is never projected (explicit field lists). `AIDEN_REMOTE_CONTRACT_REVISION`
stays 24, fixtures unchanged, iOS/Android untouched; their suites ran as regression evidence.

## Q2 (open, deliberately unchanged)
Remote `list()` without a `workspaceId`, and `classify()` / `get()` by direct ID, still do NOT
exclude Assistant chats (only summaries and progress do). F-3 keeps Assistant behavior as
umbrella section 7 requires. Q2 proposes a separate small PR (with native checks) to 404
Assistant chats by direct ID and drop them from workspace-less `list()`.
