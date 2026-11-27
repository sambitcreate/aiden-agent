# Code simplification audit

_Four rounds of parallel read-only audits, each round verified against the code by Gemini 4 Neon (High) via `agy`._

- **Date:** 2026-11-26
- **Baseline:** `main` at `a60cd7c30` (0.70.0 line)
- **Goal:** find places where code can shrink while user-visible behavior and UX stay identical.
- **Method per round:** 5 independent DeepSeek 4.1 Flash agents, each with a disjoint scope; then Gemini 4 Neon (High) verification passes that re-read the cited code and reject anything that changes behavior, contracts, or accessibility.
- **Constraints applied to every finding:** no UX or protocol changes, no test-coverage loss, no generated/vendored code, no security or accessibility weakening.

**Legend:** `V` = verified sound as written · `P` = real, but the proposal or estimate needed correction (the corrected version is listed) · LOC is net lines removed after verification.

## Status

| Round | Scope | Raw findings | Accepted | Est. net LOC |
| --- | --- | --- | --- | --- |
| 1 | Broad module sweep | 76 | 70 (34 V, 36 P) | ~1,510 |
| 2 | Dead code, cross-boundary duplication, state, legacy shims | 53 | 46 (31 V, 15 P) | ~804 |
| 3 | Subsystems (Bots, mobile, tests, design system) | 64 | 60 (45 V, 15 P) | ~2,376 |
| 4 | Remaining surfaces, storage/tools, build pipeline | 59 | 55 (33 V, 22 P) | ~1,216 |
| **Cumulative** | unique work, overlap-adjusted | **252** | **231 (143 V, 88 P)** | **~5,890** |

---

# Round 1 — broad module sweep

Five auditors covered main core services, the Aiden Remote server family, renderer chat surfaces, renderer components, and CLI/scripts/IPC. Verification rejected 6 of 76 claims (one hallucinated worktree invariant, three wire-visible Remote changes, two behavior-changing UI merges) and corrected most LOC estimates downward.

## Top opportunities, all areas

| ID | Area | Change | LOC | Verdict | Risk |
| --- | --- | --- | --- | --- | --- |
| F2.1 | Remote | Move `deviceIdSuffix` into `authenticate`; delete 140 route-level assignments | 135 | V | low |
| F2.2 | Remote | One shared file-service helper module for the two file routes + workspace browser | 80 | V | low |
| F5.1 | IPC handlers | One exact-key/shape guard family in `main/shared/guards.ts` (12 handler files) | 80 | P | low |
| F2.4 | Remote | Reuse `main/shared/guards.ts` guards across 9 Remote services | 75 | V | low |
| F3.1 | Renderer chat | One `saveThinkingSetting` helper for five thinking-level handlers | 75 | P | low |
| F5.3 | Scripts | `packaged-acceptance-support.mjs` for 7 helpers across 8 acceptance scripts | 75 | V | low |
| F1.1 | Main core | Shared stored-message field parsers (4 copies → 1 module) | 55 | P | medium |
| F2.3 | Remote | One ordered capability table for 23 aligned opt-in groups | 50 | P | medium |
| F5.2 | IPC handlers | Consolidate bounded/non-empty string guards under distinct names | 35 | P | low |
| F2.5 | Remote | Two query-parser helpers (raw single-key, strict URLSearchParams) | 35 | V | low–med |
| F4.1 | Components | Delete 3 dead exports and 3 `CustomDropdownMenu*` aliases | 34 | V | low |
| F4.2 | Components | Local `SelectField` with an `after` slot for 9 schedule-editor blocks | 34 | P | low |
| F1.3 | Main core | `addWarning` helper for 8 push-warning appends | 30 | V | low |
| F2.6 | Remote | Compose `AIDEN_REMOTE_CAPABILITIES` from the three arrays above it | 28 | V | low |
| F4.3 | Components | `runProviderMutation` for 5 web-search setup handlers | 28 | V | low |
| F4.4 | Components | Palette row class + `LoadingRow`/`RetryRow` | 28 | V | low |
| F4.6 | Components | `RadioChoiceCard` with a `className` prop (5 cards) | 25 | P | low–med |
| F1.4 | Main core | Hoist `MANAGED_STATUS_ARGS` (5 sites) | 24 | P | low |
| F2.7 | Remote | One capability-membership guard for 6 list guards | 24 | V | low |
| F4.7 | Components | Hoist web-search setup dialog, merge zero-result checks, extract subpage chrome | 22 | P | low |
| F5.5 | Scripts | `package-file-guards.mjs` for digest/file helpers (keep re-export names) | 22 | P | low |
| F5.4 | IPC handlers | Replace 8 hand-rolled exact-key loops in `bot-params.ts` with `exact()` | 21 | V | low |
| F2.9 | Remote | One `walkJsonEntries` for 3 private-field walkers | 20 | V | low |

## Main core execution services — ~295 LOC accepted

| ID | Change | LOC | Verdict | Risk |
| --- | --- | --- | --- | --- |
| F1.1 | `parseStoredMessageFields` + `parseStoredAssistantProtocol`; keep copy-path remaps and differing inputs explicit | 55 | P | medium |
| F1.3 | Local `addWarning` in `GitService.push` | 30 | V | low |
| F1.4 | Hoist `MANAGED_STATUS_ARGS`; first 2 sites spread after git-dir/work-tree, sites 3–5 spread directly | 24 | P | low |
| F1.5 | Use `main/shared/guards.ts` `isRecord` + local `hasOwn` across 5 `readChat` guards | 19 | P | low |
| F1.6 | One lock/read-modify-write helper for 4 throwing mutators; a second for 2 nullable title replacements | 15 | P | medium |
| F1.7 | Rename/generalize `blockComputerUse` to `blockToolCall(reason)` at 4 denial sites | 16 | V | low–med |
| F1.8 | One `inProgressOperation` table for commit/push state blockers | 14 | V | low |
| F1.9 | `trimBounded` for 7 bounded-`Map` evictions (`break` on `keep`) | 19 | V | low |
| F1.10 | Local `writeMessage`/`readBoundedMessage` in `GitService.commit` | 10 | V | low |
| F1.11 | Reuse `reviewStatus`; share the name-status comparator; drop unused export | 13 | V | low |
| F1.12 | Delegate `waitForManagedHook` to `waitForManagedPromise` | 12 | V | low |
| F1.13 | Share a chat-session end helper; delegate `beginChatExport` to `beginChatCopy` | 3 | P | low |
| F1.14 | `findChatGeneration` for 2 lookups; leave the contract-pinned `isChatOwnedByInactiveRenderer` | 6 | P | low |
| F1.15 | Drop the synthetic `ChatStartParams` detour in `chatMessageToPiMessage` | 5 | P | low |
| F1.16 | Hoist the abandoned-message spread (readability only) | 0 | P | low |
| F1.17 | Shared journal/removal identity assertion for 2 sites | 4 | P | low |
| F1.18 | `requireWorkspaceSubpath` for 3 guards | 7 | V | low |
| F1.19 | Module-level `NO_FOLLOW_READ_FLAGS` | 8 | V | low |
| F1.20 | `isSafeChatId` for 4 chat/bot-id checks | 13 | V | low |
| F1.21 | Shared review-summary reduction | 7 | V | low |
| F1.22 | `OwnerBoundGeneration extends GenerationOwnershipEntry` for 15 shared fields | 15 | V | low |

## Aiden Remote + renderer chat surfaces — ~665 LOC accepted

| ID | Change | LOC | Verdict | Risk |
| --- | --- | --- | --- | --- |
| F2.1 | `deviceIdSuffix` set once inside `authenticate`; remove 140 route assignments | 135 | V | low |
| F2.2 | `aiden-remote-file-shared.ts` for 3 constants + 5 helpers across 2 file routes and the browser route | 80 | V | low |
| F3.1 | `saveThinkingSetting` for 5 handlers; keep `!model` only on model-scoped wrappers | 75 | P | low |
| F2.3 | One ordered table for 23 aligned capability groups; leave 4 fallthrough Bots and `/server.features` alone | 50 | P | medium |
| F2.5 | `singleRawQueryValue` + `strictQueryParams` | 35 | V | low–med |
| F2.6 | Compose the capabilities tuple from the three existing arrays | 28 | V | low |
| F2.7 | One capability-membership guard/factory + one-line wrappers | 24 | V | low |
| F2.9 | `walkJsonEntries` for 3 protocol walkers | 20 | V | low |
| F3.2 | Shared `ChatLineageLine`; preserve `data-chat-fork-lineage` placement | 20 | P | low |
| F2.8 | `requireApproval` / `requireQuestion` / `firstPendingForChat` | 19 | V | low |
| F3.5 | `clearStreamBuffers` only at unmount + context-change cancel; shared setters only | 18 | P | medium |
| F2.13 | Delete 8 unreferenced protocol exports | 17 | V | low |
| F2.10 | `projectChatHeader`, `withoutThinkingOffsets`, `requireSummaryMetadata` (key-order shift is not a contract) | 15 | P | low |
| F3.8 | Delete unreachable `ModelPicker` branch and import | 15 | V | low |
| F3.9 | Reuse `timelineCompacting`, hoist one reasoning control, one `disabled` value | 10 | V | low |
| F3.3 | `rethrowWithToast` for 8 Bot handler catches | 8 | P | low |
| F3.7 | Shared `respondToPlan` + `renderPlanCard` | 7 | P | low |
| F3.13 | Hoist the Bot Stop row | 4 | V | low |
| F3.14 | Drop three duplicate derivations (keep `chat-pane.tsx:961`) | 4 | P | low |
| F3.4 | `useDeclaredThinkingLevels` for 3 unconditional memos | 3 | P | low |
| F3.12 | Two file-local artifact-recovery strings | 2 | P | low |
| F3.11 | Bind/hoist message-list values (minimal win) | 1 | P | low |

## Renderer components, CLI, scripts, IPC — ~550 LOC accepted

| ID | Change | LOC | Verdict | Risk |
| --- | --- | --- | --- | --- |
| F5.1 | One guard family in `main/shared/guards.ts`, coordinated with F2.4/F1.5; preserve tested strings | 80 | P | low |
| F5.3 | `scripts/packaged-acceptance-support.mjs` (7 helpers, keep gemini's local `monitorChild`) | 75 | V | low |
| F5.2 | Consolidate bounded/non-empty string guards under distinct names; exclude `boundedId` | 35 | P | low |
| F4.1 | Delete `HtmlArtifactList`, `useSplitViewCollapsed`, `useExpandedSubagentHelperChat`, 3 aliases | 34 | V | low |
| F4.2 | Local `SelectField` with `after` slot; 9 main + 4 trigger-form blocks | 34 | P | low |
| F4.3 | `runProviderMutation` for 5 web-search setup handlers | 28 | V | low |
| F4.4 | `PaletteResultItem` default class + `LoadingRow` + `RetryRow` | 28 | V | low |
| F4.6 | `RadioChoiceCard` with `className`; keep `py-2.5` vs `py-3` | 25 | P | low–med |
| F4.7 | Hoist setup dialog, merge zero-result checks, `ProviderSubpage`, fragment-only policy links | 22 | P | low |
| F5.5 | `scripts/package-file-guards.mjs`; keep `hashFile`/`assertRegularFile` re-exports | 22 | P | low |
| F5.4 | `exact()` + module `Set`s for 8 `bot-params.ts` checks | 21 | V | low |
| F4.8 | Merge mutually exclusive rename dialogs; hoist `chatListHeader` | 18 | V | low–med |
| F4.9 | `SettingsPageHeading` with variants; migrate the source-grep test to rendering | 18 | P | medium |
| F4.5 | One local error-message helper for 11 semantics-identical copies; leave key-pool regex alone | 16 | P | medium |
| F4.12 | Shared `environmentWorkBlockedReason` for sidebar + history nav only | 16 | P | medium |
| F5.9 | Export parse helpers; add `idWithRevision` for 5 double-validating handlers | 13 | V | low |
| F4.10 | Workspace-chip button factory (must stay `PopoverTrigger asChild`-compatible) + 2 composer constants | 12 | P | low |
| F5.6 | Replace 2 `botIdOf` copies with `parseBotId` | 12 | V | low |
| F4.11 | Hoist `cancelButton`, extract `dialogCloseAutoFocus`; skip `dialogLayerClass` | 11 | P | low |
| F5.12 | Share CLI `wait`/`pause`; extract `raceTimeout` | 9 | V | medium |
| F5.8 | `scripts/ci-github-output.mjs` with exported delegations | 8 | P | medium |
| F5.13 | Local `mainWindowOwner` factory for 3 registrations | 7 | V | low |
| F5.7 | Export `requireBot` for 3 Bot handler modules; leave `bot-pause` | 5 | P | low |
| F5.14 | Delete dead CLI re-export (and optional façade removal) | 1 | P | low |
| F5.10 | Extract preload IPC transport (net zero, consistency only) | 0 | P | low |
| F5.15 | Remove 23 pass-through `handle` adapters | 0 | P | low |

## Rejected in Round 1

| ID | Why it was rejected |
| --- | --- |
| F1.2 | Hallucinated invariant: `worktreeAdministrativeRegistrationExists` deliberately skips the ownership token so missing markers are detected; merging would break deletion safety. |
| F2.11 | Proposed shared Bot POST preamble flips wire HTTP error precedence (403 vs 404, 400 vs 404) across 6 routes. |
| F2.12 | The two "empty body" validators throw different wire error strings; merging is wire-visible. |
| F3.6 | The five workspace-change handlers intentionally test different conditions in different orders; a shared ladder changes behavior. |
| F3.10 | The unsent-message and fork paths have different draft precedence and must not share `saveComposerDraftText`. |
| F5.11 | Proposed IPC cleanup changes the `devices:refresh` payload and hides direct `invoke` channels from the contract test. |

---

# Round 2 — dead code, duplication, state, legacy

Verification accepted 46 of 53 findings. It rejected six "dead migration" deletions because they would require deleting existing tests (the repo forbids that), and one renderer API deletion that would break the IPC contract test. Two accepted items supersede parts of Round 1, so their LOC is counted incrementally.

## Top opportunities

| ID | Area | Change | LOC | Verdict | Risk |
| --- | --- | --- | --- | --- | --- |
| F8.1 | Shared guards | Replace 69 exact `isRecord` copies with `main/shared/guards.ts` (46 main/services + 23 renderer/shared; no overlap with F2.4/F5.1) | 136 | V | low |
| F8.2 | CLI ↔ desktop | One Electron-free worktree git-port factory for 21 duplicated ports | 65 | P | medium |
| F9.1 | Renderer state | `useSettingsSave` across 7 settings handlers in 6 files | 60 | V | low |
| F8.3 | CLI ↔ desktop | Share process-group ancestry walk, entry type, survivor predicate | 45 | P | medium |
| F9.4 | Renderer state | `useSubagentScrollFollow` for the duplicated growth-follow engine | 36 | P | medium |
| F6.4 | Main dead code | Delete 22 unreferenced exported type aliases in 21 files | 33 | V | low |
| F6.5 | Main dead code | Delete 12 unreferenced event/status/credential types | 27 | V | low |
| F6.1 | Main dead code | Delete dead `MemoryStore.deleteScope` | 26 | V | low |
| F8.4 | Shared | `renderer/shared/base64.ts` for two identical decoders | 25 | V | low |
| F9.3 | Renderer state | `createSharedSnapshot` for two refcounted subscription caches | 25 | V | low |
| F9.2 | Renderer state | Extend `useNow(live)`; replace 3 wall-clock tickers (exclude pairing sheet) | 24 | P | low |
| F9.6 | Renderer state | `useNotificationSnapshot` for 3 chat-activity subscriptions | 24 | V | low |
| F6.6 | Main dead code | Delete 6 never-called methods | 23 | V | low |
| F8.6 | Shared | `uiVisualFromCompiled` + one markup limit for 4 call sites | 20 | V | low |
| F6.7 | Main dead code | Delete 4 dead exported helpers | 19 | V | low |
| F9.5 | Renderer state | One `ComposerPopoverPresence` for history + slash palettes | 19 | V | low |
| F6.8 | Main dead code | Delete 4 never-called turn/protocol methods | 15 | V | low |
| F7.1 | Renderer dead code | Delete 3 dead subagent-helper-chat exports | 15 | V | low |
| F8.5 | Shared | One visual-snapshot page builder for desktop + CLI | 15 | V | low |
| F9.8 | Shared | Move `updateRestartError` into `renderer/shared/app-update.ts` | 14 | V | low |
| F9.9 | Shared | One `compactNumber` for 4 usage-profile views | 14 | V | low |

## Dead main code and legacy shims — ~187 LOC accepted

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F6.4 | Delete 22 exported `ReturnType`/union aliases with zero references | 33 | V |
| F6.5 | Delete 12 unreferenced types/interfaces | 27 | V |
| F6.1 | Delete `MemoryStore.deleteScope` | 26 | V |
| F6.6 | Delete 6 never-called methods | 23 | V |
| F6.7 | Delete 4 dead exported helpers (+ unused type import) | 19 | V |
| F6.8 | Delete 4 never-called turn/protocol methods | 15 | V |
| F6.2 | Delete `activeStreamForChat`; supersedes Round 1 F1.14 (incremental) | 8 | P |
| F10.4 | Delete `skills:discovered` alias + dead `skillsApi.discovered` | 8 | V |
| F6.3 | Delete `approvalChatId`; supersedes the `requireApproval` half of F2.8 | 7 | P |
| F6.9 | Delete 5 unread constants | 6 | V |
| F10.8 | Drop unused `legacy`/`legacySettings` migration inputs | 5 | V |
| F10.6 | Delete `WebSearchService.readiness()` | 4 | P |
| F10.7 | Delete `DictationCoordinator.toggle()`; update tests to `.press()` | 4 | V |
| F6.10 | Delete dead `journalUserMessages` field | 2 | V |
| F6.11 | Opportunistic `export` cleanup in touched files (no codemod) | 0 | P |

## Dead renderer code and cross-boundary duplication — ~380 LOC accepted

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F8.1 | One `isRecord` for 69 exact copies | 136 | V |
| F8.2 | Electron-free worktree git-port factory (export `gitService`/adapter) | 65 | P |
| F8.3 | Share process-group walk/type/survivor helper; keep serve-lifecycle UID gate local | 45 | P |
| F8.4 | `renderer/shared/base64.ts` (loop-based, optional max) | 25 | V |
| F8.6 | `uiVisualFromCompiled` + `AIDEN_UI_LIMITS.markupChars` | 20 | V |
| F8.5 | `visualHostPageHtml` + shared snapshot constants | 15 | V |
| F7.1 | Delete dead subagent-helper-chat exports | 15 | V |
| F8.8 | `isTimestamp`/`isFiniteTimestamp`/`timestampOf` in guards | 13 | V |
| F7.3 | Delete 5 dead shared types/constants | 12 | V |
| F7.5 | Remove never-passed component props | 11 | V |
| F8.7 | Alias 5 vocabularies + 4 skill limits to shared owners | 11 | P |
| F7.6 | Remove 5 orphaned Quick Chat `data-testid`s | 5 | V |
| F8.9 | Share MCP client snippets with a `scope` option | 3 | V |
| F7.4 | Remove never-passed `defaultSelectedRunId` | 2 | V |
| F7.7 | Delete dead `queryKeys.botSessionState` | 1 | V |
| F7.8 | Delete dead `CLOSE_TARGET_SIZE` | 1 | V |
| F8.12 | Reuse `assertPathInside` in CLI coding tools | 1 | P |
| F7.9 | Collapse identical ternary arms | 0 | V |
| F8.10 | Deduplicate 6 type unions (drift prevention, no LOC) | 0 | P |
| F8.11 | Share provenance/silent-reply/export constants (no LOC) | 0 | P |

## Renderer state, effects, hooks — ~237 LOC accepted

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F9.1 | `useSettingsSave` with explicit guard/error/afterSave options | 60 | V |
| F9.4 | `useSubagentScrollFollow` with full scroll API, reduced-motion left inline | 36 | P |
| F9.3 | `createSharedSnapshot` for two subscription caches | 25 | V |
| F9.2 | `useNow(live)` for 3 safe tickers | 24 | P |
| F9.6 | `useNotificationSnapshot` for 3 chat-activity effects | 24 | V |
| F9.5 | `ComposerPopoverPresence` shared by history + slash palettes | 19 | V |
| F9.8 | `updateRestartError` in `app-update.ts` | 14 | V |
| F9.9 | `compactNumber` in `usage-profile-data.ts` | 14 | V |
| F9.7 | `useContainerWidth` (place after suspension hooks) | 11 | P |
| F9.10 | `useDocumentVisible` shared, all 5 consumers updated/re-exported | 6 | P |
| F9.11 | `textAttachmentBody` with a zero-import structural type | 4 | P |

## Rejected in Round 2

| ID | Why it was rejected |
| --- | --- |
| F7.2 | Deleting `botsApi.allowedList`/`removeAllowed` breaks `ipc-contract.test.ts`'s exact Bot handler/invoke match. |
| F10.1–F10.3, F10.5 | Code is dead in production but deleting it requires deleting existing unit tests, which the repo forbids. |
| F10.9 | Removing the default-closed Bot issue parser weakens a documented fail-closed boundary and requires flipping assertions in two test files. |
| F10.10 | Breaks `diagnostic-policy.test.mjs` and is net-negative LOC. |

---

# Round 3 — Bots, mobile, tests, design system

The largest round: 60 of 64 findings accepted. Mobile and test consolidation dominate the savings; design-system work is mostly exact CSS duplication with computed-style proof. Four findings were rejected: one approval-panel abstraction that broke DOM/accessibility, one Android top-bar wrapper that dropped weight/color and was net-negative, one source-grep test helper that hid allowlisted contracts, and one Remote test-helper merge that broke negative-isolation assertions.

## Top opportunities

| ID | Area | Change | LOC | Verdict |
| --- | --- | --- | --- | --- |
| F14.1 | Tests | One `deferred<T>()` in `main/shared/async-test-support.ts` for 55 files | 310 | V |
| F13.1 | Android | Delete 3 superseded Compose surfaces, an unused toolbar action, and a motion alias | 187 | V |
| F13.4 | Android | Delete 19 zero-reference helpers/fields/types across 11 files | 156 | V |
| F14.3 | Tests | Shared temp-directory helper + per-caller registry (205 sites, 87 files) | 145 | P |
| F14.2 | Tests | One `MemoryPersistence<T>` for 12 suites | 115 | V |
| F13.3 | Android | Delete 13 uncalled `AidenRemoteClient` route wrappers | 97 | V |
| F14.5 | Tests | Shared workspace/QueryClient/settle + 53 redundant IPC defaults | 95 | V |
| F14.11 | Tests | Share 5 DOM doubles/fixtures across renderer and main suites | 90 | P |
| F14.4 | Tests | One `FakeTimers` for 5 peer suites | 80 | V |
| F14.6 | Tests | Web-search adapter test support (parameterized) | 70 | P |
| F13.2 | Android | Delete unreachable canonicalization helpers | 69 | V |
| F12.1 | iOS | One `AidenBotJournal` for 4 protected-file stores | 68 | V |
| F13.5 | Android | One solo-capability request helper for 19 wrappers | 52 | V |
| F14.8 | Tests | `openBotHarness` + typed `botToolResults` | 50 | P |
| F14.12 | Tests | Reuse existing process-liveness/handoff fixtures | 50 | V |
| F13.7 | Android | One reified `decode<T>` for 25 decode lambdas | 48 | V |
| F14.9 | E2E | `tests/e2e/device-fixtures.ts` for 3 device specs | 43 | V |
| F12.3 | iOS | One session-identity type + aliases for 3 copies | 40 | V |
| F12.2 | iOS | One `AidenBotProfileLinkRow` with contentShape + accessibility | 38 | P |
| F13.11 | Android | `AidenSha256` for 12 hash helpers | 38 | V |

## Bots subsystem and design system — ~248 LOC accepted

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F11.1 | One Composio settings-probe helper (fully parameterized deadlines/copy/ports) | 34 | P |
| F11.2 | `botSessionJsonListStore` for 6 Bot stores (with remove + encode callbacks) | 25 | P |
| F11.3 | Reuse exported `createKeyedSerial` in 2 queues | 25 | V |
| F11.4 | `refreshFeed` for 6 live-projection refreshers | 16 | V |
| F11.5 | One Bot card-notifier factory for 2 notifiers | 11 | V |
| F11.9 | `proposeLesson` for record/retire lesson | 10 | V |
| F11.6 | `NeedsYouSlotBody` for 2 chat panes | 5 | P |
| F11.8 | Map the two memory groups with interpolated empty text | 4 | P |
| F11.10 | `QuietTimeField` (exact classes/aria) | 2 | V |
| F11.11 | `pointerPoint` clamp helper | 2 | V |
| F11.12 | `writeBotToCache` for 2 cache writers | 2 | V |
| F11.7 | Merge reset/remove dialogs only with a last-confirm ref (animation-safe) | 1 | P |
| F15.1 | Reuse `aiden-popover-*` keyframes for quick-view cards | 21 | V |
| F15.2 | Delete redundant `.appearance-heading` | 19 | V |
| F15.3 | Drop scheme-invariant dark custom-property restatements | 15 | V |
| F15.4 | Merge appearance tile/width shared declarations | 13 | V |
| F15.9 | `MenuItemColorProps` + `menuItemTone` in `ui.tsx` | 9 | V |
| F15.7 | Merge appearance label rules | 8 | V |
| F15.5 | Delete 4 shadowed local focus-visible rules | 7 | V |
| F15.6 | Merge 4 reduced-motion banner entrance rules | 7 | V |
| F15.8 | Delete 5 unused theme aliases | 6 | V |
| F15.11 | One reduced-motion live-mark rule | 4 | V |
| F15.10 | Parameterize sticky-header base layer | 2 | V |

## iOS and Android — ~1,062 LOC accepted

| ID | Platform | Change | LOC | Verdict |
| --- | --- | --- | --- | --- |
| F13.1 | Android | Delete 3 superseded Compose surfaces + motion alias | 187 | V |
| F13.4 | Android | Delete 19 zero-reference helpers/fields/types | 156 | V |
| F13.3 | Android | Delete 13 uncalled route wrappers | 97 | V |
| F13.2 | Android | Delete unreachable canonicalization helpers | 69 | V |
| F12.1 | iOS | One `AidenBotJournal` for 4 stores | 68 | V |
| F13.5 | Android | One solo-capability request helper | 52 | V |
| F13.7 | Android | One reified `decode<T>` | 48 | V |
| F13.11 | Android | `AidenSha256` for 12 helpers | 38 | V |
| F13.6 | Android | One `postNotification` with explicit action/request-code flags | 36 | P |
| F13.8 | Android | `AidenSSEFrameReader<T>` (Bot session parser stays separate) | 36 | P |
| F12.4 | iOS | One identifier-scalar validator | 34 | V |
| F12.3 | iOS | One session identity + aliases | 40 | V |
| F12.2 | iOS | One profile link row (contentShape + accessibility combined) | 38 | P |
| F12.5 | iOS | One restore-state helper returning state/mutation/message | 24 | P |
| F12.8 | iOS | One SHA-256 hex helper | 20 | V |
| F12.7 | iOS | One Bot POST helper with optional idempotency/validator | 19 | P |
| F12.6 | iOS | One catch-up toolbar modifier | 18 | V |
| F13.12 | Android | `AidenBotCardIcon` for 5 icon tiles | 17 | P |
| F13.9 | Android | Reuse `AidenApprovalHeader` | 14 | V |
| F12.9 | iOS | One dynamic coding key | 13 | V |
| F12.10 | iOS | One open-link confirmation modifier | 10 | V |
| F13.14 | Android | Use Compose `compositeOver` | 9 | V |
| F12.11 | iOS | One phone-progress capability vocabulary | 7 | V |
| F13.13 | Android | Reuse pending bubble view | 5 | V |
| F12.13 | iOS | Delete 2 dead members | 4 | V |
| F12.12 | iOS | Share pairing alphabet + validator | 3 | V |

## Test-suite consolidation — ~1,066 LOC accepted

These changes are test-only and should land as a separate PR from production refactors.

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F14.1 | `deferred<T>()` for 55 sites | 310 | V |
| F14.3 | Temp-dir helper + fresh per-caller registry (exclude realpath + `/tmp` alias test) | 145 | P |
| F14.2 | `MemoryPersistence<T>` for 12 suites | 115 | V |
| F14.5 | `TEST_WORKSPACE`, `createTestQueryClient`, `settle` (IPC defaults dropped in review: a `null` default for `shortcut:get` broke Quick Chat tests, and `settings:get`/`app:renderer-ready` defaults silently turned rejections into `null` in ~50 untouched suites) | 55 | P |
| F14.11 | 5 shared DOM doubles/fixtures (modelOption not in test-dom) | 90 | P |
| F14.4 | One `FakeTimers` for 5 suites | 80 | V |
| F14.6 | Web-search adapter support with explicit `maxBytes`/request args | 70 | P |
| F14.8 | `openBotHarness` + typed `botToolResults` | 50 | P |
| F14.12 | Reuse process-liveness/handoff fixtures; add 2 small shared fixtures | 50 | V |
| F14.9 | `device-fixtures.ts` for 3 E2E specs | 43 | V |
| F14.13 | `git-test-support.ts` for 3 worktree suites | 18 | V |

## Rejected in Round 3

| ID | Why it was rejected |
| --- | --- |
| F15.12 | Proposed approval-facts shell breaks the DOM/`aria-describedby` layout of all five panels and is net-negative LOC. |
| F13.10 | Proposed Android top-bar wrapper drops weight/color, turns an empty title into a `Text("")`, and adds LOC at 4 one-line call sites. |
| F14.7 | Moving `source()` hides allowlisted source-grep tests from the rules gate and breaks relative URL resolution. |
| F14.10 | One Remote test-recording helper breaks negative-isolation assertions and conflates incompatible per-revision behaviors. |

---

# Round 4 — remaining surfaces, storage/tools, build pipeline

Verification accepted 55 of 59 findings. Rejections were substantive: a maximum-depth provider-alias migration that would break at depth 257, a credential-store rewrite that would throw on every production write, a PNG-header validator that would break computer-use fixtures while weakening device validation, and a Vite-config share that would turn an independent CSP release gate into a tautology.

## Top opportunities

| ID | Area | Change | LOC | Verdict |
| --- | --- | --- | --- | --- |
| F17.1 | Subagents | One `consumeTreeUsage` helper for 16 try/catch budget blocks | 140 | V |
| F19.1 | Build | One native-helper build runner for 6 entry scripts | 90 | V |
| F19.5 | Build | One `MACOS_NATIVE_HELPERS` table for 7 package-verify phases | 55 | V |
| F18.6 | Native | Six shared C leaf helpers across 4 binaries (rebuild prebuilts) | 53 | P |
| F17.2 | Subagents | One `SubagentToolGateV2` + `SubagentApprovalSeamsV2` contract | 45 | V |
| F19.3 | Build | `mainBundle`/`preloadBundle` factories for 9 esbuild entries | 44 | V |
| F20.1 | Browser | `componentFrame`/`frameworkResult` for 6 framework inspectors (Astro/Solid unminified) | 40 | P |
| F20.2 | Computer Use | `unavailableStatus` factory for 6 status shells | 37 | V |
| F18.1 | Aux windows | One secondary-window bootstrap for Quick Chat + Bot bubbles | 36 | V |
| F17.3 | Schedules | Field builders for 3 scheduled-task tool schemas | 35 | P |
| F18.3 | Main window | Ownership-gate helper for `app:*` handlers (keep `checkForUpdates` inline) | 34 | P |
| F19.2 | Build | One Swift helper-app builder | 31 | V |
| F16.2 | Config | Shared own-entry read/write helpers in `guards.ts` | 28 | V |
| F17.4 | MCP | `inspectVerifiedReadScope` + `exactReadTool` | 25 | V |
| F16.5 | Settings | `applyBoolean` for 8 `settings:set` fields | 24 | P |
| F16.3 | Storage | Reuse `durable-fs` sync/staging primitives | 21 | V |
| F17.5 | Subagents | `acknowledgeTerminal` + `rejectAndStop` helpers | 21 | P |
| F16.9 | Config | Mapped type for 9 publish test hooks | 20 | V |
| F20.5 | Assistant | Shared approval-details predicates | 20 | V |
| F18.4 | Pill | `abortActiveCapture` + button factory (keep audio teardown explicit) | 19 | P |

## Storage, config, credentials — ~176 LOC accepted

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F16.2 | Own-entry read/write helpers in `main/shared/guards.ts` | 28 | V |
| F16.5 | `applyBoolean` for 8 optional settings fields (typed keys) | 24 | P |
| F16.3 | Reuse `durable-fs` sync/staging for data-store + portable config | 21 | V |
| F16.9 | `StorePublishTestHooks<Prefix, T>` mapped type | 20 | V |
| F16.4 | `workspaceOwner(event)` for 7 handler guards | 17 | V |
| F16.8 | Shared worktree/provisioned-file leaf validators | 16 | V |
| F16.6 | `main/shared/serial-queue.ts` for 5 promise-tail queues | 15 | V |
| F16.1 | `updateSettings`-style helper for 12 clean mutators (keep snapshot isolation) | 14 | P |
| F16.12 | `uniqueById` for 4 count-then-filter loops | 11 | V |
| F16.11 | `deferMigration()` for 10 README gates | 10 | V |

## Tools, MCP, skills, schedules, subagents — ~350 LOC accepted

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F17.1 | `consumeTreeUsage` for 16 budget/abort blocks | 140 | V |
| F17.2 | `SubagentToolGateV2` + approval seams; drop 14 imports | 45 | V |
| F17.3 | Schedule schema field builders (byte-identical JSON) | 35 | P |
| F17.4 | `inspectVerifiedReadScope` + `exactReadTool` | 25 | V |
| F17.5 | `acknowledgeTerminal` + `rejectAndStop` | 21 | P |
| F17.8 | `SubagentRuntimeChildSpecInput`; drop 3 imports | 21 | V |
| F17.6 | Shared skill-candidate constructors | 19 | V |
| F17.7 | `drainApproval` for 3 shutdown blocks | 19 | V |
| F17.9 | `selectedScheduleMcpServers` + `sameStringList` | 13 | V |
| F17.10 | `databaseSchemaKind` for 2 parsers | 7 | V |
| F17.11 | Delete `withDurableToolOutputs` wrapper | 5 | V |

## Native, aux windows, terminal, preloads — ~221 LOC accepted

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F18.6 | Six shared C leaf helpers across 4 binaries; rebuild prebuilts + manifests | 53 | P |
| F18.1 | Shared secondary-window bootstrap (separate Vite inputs preserved) | 36 | V |
| F18.3 | Ownership-gate helper for `app:*` (source-grep pin on `checkForUpdates` noted) | 34 | P |
| F18.4 | Pill abort/cancel consolidation with explicit audio teardown | 19 | P |
| F18.9 | One aux-window security policy module | 18 | V |
| F18.2 | `readsBooleanFlag` for 5 Ghostty boolean getters | 17 | V |
| F18.10 | `toggleEvents(active)` for 22 terminal listeners | 16 | P |
| F18.5 | `windowGone`/`showAndFocus` helper (safe subset) | 13 | P |
| F18.11 | Hoist `EMPTY_CLOSE_GUARD` | 11 | V |
| F18.8 | Shared bubble-restore action with per-caller fallback copy | 4 | P |
| F18.7 | Aux-window lifecycle extraction (net zero; consistency only) | 0 | P |

## Build, packaging, CI — ~302 LOC accepted

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F19.1 | `scripts/build-native-helper-entry.mjs` for 6 entry scripts | 90 | V |
| F19.5 | `MACOS_NATIVE_HELPERS` table for 7 verify phases | 55 | V |
| F19.3 | `mainBundle`/`preloadBundle` factories for 9 esbuild entries | 44 | V |
| F19.2 | `scripts/swift-helper-build.mjs` | 31 | V |
| F19.4 | `scripts/vendor-archive.mjs` for two vendor scripts | 18 | P |
| F19.8 | Linux pkg-config helper entry (keep two entry files) | 18 | P |
| F19.6 | `--github-output`/`--announce-existing` for release prep | 15 | V |
| F19.9 | Recursive `readdir` for Ghostty asset verify | 9 | P |
| F19.10 | Collapse identical `evaluateRequiredGate` arms | 9 | V |
| F19.7 | Parameterize Apple developer-tools probe | 5 | P |
| F19.11 | Share `writeFileAtomically` in model snapshot core | 5 | V |
| F19.13 | Delete 3 unused exported aliases | 3 | V |

## Remaining services and gaps — ~167 LOC accepted

| ID | Change | LOC | Verdict |
| --- | --- | --- | --- |
| F20.1 | Framework-inspector frame/result helpers (Astro/Solid unminified; regenerate grab runtime) | 40 | P |
| F20.2 | `unavailableStatus` for Computer Use status shells | 37 | V |
| F20.5 | Shared assistant approval-details predicates | 20 | V |
| F20.3 | `runCapturedChild` with timeout note + sync settle hook | 15 | P |
| F20.4 | `device-ipc-support.ts` (reuse `requireSaveTarget`/`ID_PATTERN`) | 12 | P |
| F20.8 | Share main-only `DEVICE_ACTION_LABELS` (keep Android `setToggle` copy) | 11 | P |
| F20.7 | `main/shared/async-timeout.ts` + `recordOf` guard | 10 | V |
| F20.6 | `ownedPendingRequest` helper (narrow owner type) | 8 | P |
| F20.10 | Reuse `isCredentialAutocomplete` (document browser-pure invariant; regenerate) | 7 | P |
| F20.11 | `captureNativeImage` for design canvas | 6 | V |
| F20.12 | Delete duplicate JSDoc line | 1 | P |

## Rejected in Round 4

| ID | Why it was rejected |
| --- | --- |
| F16.7 | Replacing `flattenAliasTargets` breaks migration of a valid 256-deep alias graph that becomes 257-deep mid-migration. |
| F16.10 | Credential-store rewrite throws on every production write (undefined `syncDirectory`), changes durability-error semantics, and nets ~0 LOC. |
| F19.12 | Sharing Vite inputs with the CSP verifier is net-negative and turns an independent release gate into a tautology. |
| F20.9 | Shared PNG-header validation breaks synthetic computer-use fixtures (no `IHDR` bytes) or weakens device validation; net-negative LOC. |

---

# Final summary

## What was done

- **4 rounds**, each with **5 independent DeepSeek 4.1 Flash auditors** (20 agents, disjoint scopes) and **a Gemini 4 Neon (High) verification batch** via `agy` (12 verifier runs total).
- **252 raw findings**; **231 accepted** (143 VALID, 88 PARTIAL, 21 INVALID).
- **~5,890 net LOC** removable while keeping UX, wire formats, security, accessibility, and test coverage unchanged (overlap-adjusted).
- Rejected claims are recorded per round so they are not re-litigated. Several were plausible but would have broken a contract test, a migration invariant, or a security gate.

## Largest 25 opportunities across all rounds

| Rank | ID | Area | Change | LOC |
| --- | --- | --- | --- | --- |
| 1 | F14.1 | Tests | One `deferred<T>()` for 55 files | 310 |
| 2 | F13.1 | Android | Delete 3 superseded Compose surfaces | 187 |
| 3 | F13.4 | Android | Delete 19 zero-reference helpers/types | 156 |
| 4 | F14.3 | Tests | Shared temp-dir helper (87 files) | 145 |
| 5 | F17.1 | Subagents | One tree-budget consume helper | 140 |
| 6 | F8.1 | Guards | One `isRecord` for 69 copies | 136 |
| 7 | F2.1 | Remote | Move `deviceIdSuffix` into `authenticate` | 135 |
| 8 | F14.2 | Tests | One `MemoryPersistence<T>` | 115 |
| 9 | F13.3 | Android | Delete 13 uncalled route wrappers | 97 |
| 10 | F14.5 | Tests | Shared harness + 53 IPC defaults | 95 |
| 11 | F14.11 | Tests | Share 5 DOM doubles/fixtures | 90 |
| 12 | F19.1 | Build | One native-helper build runner | 90 |
| 13 | F5.1 | Handlers | One exact-key guard family | 80 |
| 14 | F2.2 | Remote | Shared file-service helpers | 80 |
| 15 | F14.4 | Tests | One `FakeTimers` | 80 |
| 16 | F2.4 | Remote | Reuse shared guards in 9 services | 75 |
| 17 | F3.1 | Renderer chat | One thinking-save helper | 75 |
| 18 | F5.3 | Scripts | Packaged-acceptance support module | 75 |
| 19 | F14.6 | Tests | Web-search adapter support | 70 |
| 20 | F13.2 | Android | Delete unreachable validators | 69 |
| 21 | F12.1 | iOS | One `AidenBotJournal` for 4 stores | 68 |
| 22 | F8.2 | CLI ↔ desktop | Worktree git-port factory | 65 |
| 23 | F9.1 | Renderer state | `useSettingsSave` for 7 handlers | 60 |
| 24 | F1.1 | Chat store | Shared stored-message parsers | 55 |
| 25 | F19.5 | Build | One macOS helper table | 55 |

## Suggested execution order

1. **Test-only harness consolidation (~1,066 LOC, separate PR).** Land F14.* first: it touches only test files, is mechanical, and shrinks every later diff's test churn. Run the affected suites plus `--fail-on-flaky-tests`.
2. **Dead-code sweep (~700 LOC).** F6.*, F7.*, F10.4/F10.7/F10.8, F12.13, F13.1–F13.4, F19.13, F15.2/F15.3/F15.5/F15.8. Pure deletions; gate on `tsc`, lint, and the focused suites for each surface.
3. **Shared guards and parsers (~400 LOC).** F8.1, F8.4, F8.8, F16.2, F16.3, F20.7. One `main/shared/guards.ts` API, then bulk replacements. Run `tests/bundle.test.mjs` for the CLI boundary.
4. **Remote and IPC consolidation (~700 LOC).** F2.1–F2.10, F5.1/F5.2/F5.4, F16.4. Highest contract sensitivity; run the Remote, handler, and IPC-contract suites and preserve every wire error string.
5. **Renderer chat, components, and state (~700 LOC).** F1.1, F3.1–F3.9, F4.1–F4.12, F9.1–F9.11. Keep the contract-pinned source-shape blocks inline; migrate any source-grep oracle to behavioral coverage in the same PR.
6. **Tools, schedules, and subagents (~350 LOC).** F17.*. Model-visible schemas must stay byte-identical; add a schema snapshot test before touching `schedule-tool.ts`.
7. **Storage, build, native, and remaining services (~600 LOC).** F16.*, F19.*, F18.*, F20.*. Rebuild prebuilt native binaries/manifests (F18.6) and regenerate the browser grab runtime (F20.1/F20.10) in the same PR.
8. **Design system (~111 LOC).** F15.*. CSS-only; verify computed styles, dark mode, reduced motion, and focus rings.
9. **Mobile (~1,062 LOC).** F12.* (iOS) and F13.* (Android). Run the platform test targets; keep screen deletions atomic with their routes/navigation registrations.

## Guardrails that mattered

- Every deletion was checked repo-wide, including tests, scripts, docs, dynamic imports, string-keyed registries, and `export *` barrels.
- LOC estimates were recomputed after adding shared modules; many net wins are smaller than the raw duplication (and a few are 0 LOC consistency wins).
- Contract-locked code (Remote error precedence, provider aliases, credential durability, IPC inventories, source-grep allowlists, CSP gates, PNG fixtures) was rejected rather than refactored.
- Test coverage is never reduced: all accepted test work is helper/fixture consolidation with case-level equivalence.
