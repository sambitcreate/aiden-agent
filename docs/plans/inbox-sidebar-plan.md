# Inbox Sidebar

Status: Planned (2026-10-31). The owner picked Option D (Hybrid Inbox) and accepted every recommended decision. Two code-grounded edge-case reviews (local desktop; connected hosts, `aiden serve` and phones) are folded in. Nothing is implemented yet.

Interactive options page (private, shared by the owner): <https://claude.ai/artifact/2KX5jwZ68w9wsejKTAAqx8>

## Outcome

A person running many agents across workspaces and Macs can see, from one list, which chats are waiting on them, which have news, and which are still running. They can answer the easy ones without opening the chat.

The Inbox is a third way to show the sidebar, next to **By workspace** and **Recent only**. It is opt-in and labelled Beta. **By workspace** stays the default. Every sidebar view reads the same chats, and a chat shows in only one view at a time, as the [Unified Workspace Sidebar](unified-workspace-sidebar-plan.md) contract requires.

## Research basis

Ten research passes looked at two reference apps and Aiden's current sidebar. Their reports are in the session scratchpad and summarized on the options page.

| Source | What we take | What we leave |
| --- | --- | --- |
| OpenCode Inbox | Status precedence: approval > input > working > read > done. Subagent states roll up into their parent chat. "Needs attention" sits on top. Working sits at the bottom, at most 40% of the height, ordered by when the run began. Unread means the chat went idle after the person last viewed it, and each state records when it began (`since`). | No focus ring, number shortcuts lost, no phone surface, no approving from the list. |
| T3 Code | Sections: Pinned, Active, Working, Snoozed, Settled. A stable order. On hover the status slot turns into actions. Snooze presets that wake early. A 5-second undo that merges repeated actions. Reordering animates for 150 ms with moves capped at 40 px, and stops animating under Reduce Motion or when more than 40 rows change. One shared inbox module. | Auto-settling after 3 days or a merged PR (revisit after Phase 2). Fractional order keys (Aiden has no manual chat order). |
| Aiden today | Needs-attention tiers (`SIDEBAR_ATTENTION_TIERS`, `sidebarAttention` in `renderer/lib/sidebar-organization.ts`). Honest unread and failed markers (Remote revisions 18 and 36). Remote rows (`remoteSidebarRows` in `renderer/lib/sidebar-remote-groups.ts`). Bot `needsYou` (`main/services/bot-runtime/live-projection.ts:1475-1505`, shown by `renderer/main/bots/bot-sidebar.tsx`). First-responder-wins run approvals over Remote. | Hand-written phone sorts (`aidenNeedsAttentionFirst` on iOS and Android) once the host can send the bucket. |

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| D1 | Shape | Option D, Hybrid Inbox: "Needs you", Updates, Earlier, and a Working shelf pinned to the bottom. |
| D2 | Default | **By workspace** stays the default. Inbox is opt-in and labelled Beta. |
| D3 | Where the switch lives | In both Settings → Appearance → Sidebar (cards) and the sidebar's Organize menu → View. Both edit one stored value (see "One stored view"). |
| D4 | Approvals and questions | They get their own "Needs you" section on top. |
| D5 | Acting from a row | Rows carry no Approve, Deny, Reply or Open Bot buttons and no request preview, which keeps every row two lines tall. A Needs you row shows a coloured status (Approval, Question, Failed, Interrupted, Unavailable, or Needs you for a Bot) and how long it has waited; the pending command or question is only in the row's tooltip and `aria-description`. Clicking the row opens the chat or Bot, and the person approves, denies or answers there. |
| D6 | Triage | Mark read ships in Phase 1. Done, Snooze and Pin ship in Phase 2. |
| D7 | Running chats | A collapsible Working shelf pinned to the bottom, ordered by when each run started. |
| D8 | Bots | A Bot appears only when it needs the person (which includes a failed run or an issue) or has an unread reply. This amends the unified sidebar plan's "Bots do not enter the outline" rule; the amendment applies only to the Inbox view. |
| D9 | `aiden serve` hosts | Later. Not in Phase 1. Phase 2 builds the host feed, run registry, read markers and activity they lack. |
| D10 | Phones | Phase 3. The host computes `inboxBucket` so iOS, Android and desktop agree. |
| D11 | Dock badge | Phase 2, driven by a main-process count. |
| D12 | Local prompts detach | Leaving a local chat detaches its pending prompts (see "Where Needs you comes from"). The Inbox shows what really waits, plus detached and interrupted prompts as rows the person returns to. It never pretends a detached prompt is still answerable. |
| D13 | Analytics | Phase 1 adds no analytics event. An optional `sidebar_view_changed { view }` may come later, through `analytics-events.ts`, `docs/analytics.md` and a test. |

### One stored view

The sidebar view already lives in `SidebarPreferences.view`. It is device-local and saved in `localStorage` (`chat-sidebar.tsx`, `SIDEBAR_PREFERENCES_KEY`). The Appearance cards will not add a second `AppearanceConfig.sidebarStyle` field. Two stored values could disagree, and the unified sidebar plan keeps organization state device-local. Instead, Phase 1 adds a small `useSidebarView()` store. The Organize menu and the Appearance cards both read and write it, and both stay in sync within the window.

### Needs attention becomes Inbox

The existing **Needs attention** view (`view: "attention"`) is the first version of this idea. Inbox replaces it rather than sitting beside it, so four sidebar views do not overlap. `parseSidebarPreferences` reads a stored `"attention"` as `"inbox"`. The Organize menu's "Needs attention" item becomes "Inbox" with a Beta label.

## Status model

Phase 1 adds one pure module, `renderer/lib/sidebar-inbox.ts`. It does not read React state, storage, or the clock on its own.

```ts
interface InboxSignals {
  rowState: ChatRowState;          // needs_approval | needs_input | working | idle
  unread: boolean;
  failed: boolean;                 // lastAssistantFailed / lastRunFailed
  attention?: "detached" | "interrupted"; // local only, from chats:pendingAttention
  isOpen: boolean;                 // the chat in the main pane
  hostOnline: boolean;             // always true for local chats
  updatedAt: number;
  lastAssistantAt?: number;
  attentionSince?: number;         // local: chats:pendingAttention; remote: Phase 2 host field
  runStartedAt?: number;           // local: chats:pendingAttention; remote: Phase 2 host field
  pinnedAt?: number;               // Phase 2
  doneAt?: number;                 // Phase 2
  snoozedUntil?: number;           // Phase 2
}

type InboxShelf = "needs_you" | "pinned" | "updates" | "earlier" | "working" | "hidden";

inboxState(signals, now, recentWindowMs) → { shelf, tier, sortAt }
organizeInbox(rows, now, options) → { needsYou, pinned, updates, earlier, working, hiddenCount }
```

### Where Needs you comes from

Leaving a local chat calls `cancel("lifecycle")` (`chat-pane.tsx:865-873`), which detaches the renderer (`chat.ts:77-81`, `llm-client.ts:5146-5167`), and pending prompts settle as `"detached"` (`tool-approval.ts:61-62`, `:214-230`). So a local approval or question is live only while some window shows that chat. Local Needs you rows come from:

- the open chat;
- a chat open in another window;
- Remote-origin runs on this Mac (started from a phone or a paired Mac), which don't detach with the desktop pane;
- Bots (`needsYou`);
- detached prompts: main records the detached settle per chat, and the row reads **Unavailable**, tooltip "Approval unavailable — return to retry". It clears when the chat opens or a new run starts;
- interrupted waits: `interruptedWaits` (`renderer/shared/interrupted-reply.ts`) keeps `askedAt` and the summary for 7 days after a quit or crash. The row reads **Interrupted**, `attentionSince = askedAt`, and opening it shows the existing Resume card (`chat-pane.tsx:3278-3374`).

Times come from main, not the window. `chats:pendingAttention` reads `HostRunRegistry` (`pendingPrompt`, `host-run-registry.ts:406`; `currentRunForChat`, `:441`; `startedAt`) and returns `since` and `runStartedAt`. `ChatActivityRegistry` holds only id sets (`chat-activity-core.ts:21-93`) and supplies neither summaries nor times. Remote rows have no prompt times until Phase 2.

### Placement rules, in order

1. **`needs_approval` or `needs_input`** → Needs you, tier 0 or 1. These override Done and Snooze: an approval wakes a snoozed chat.
2. **An unread failed run** → Needs you, tier 2. This matches the existing `failed` tier in `sidebarAttention`, and it also wakes a snoozed chat.
3. **Detached or interrupted** (local) → Needs you, tier 3.
4. **`working`** → the Working shelf.
5. **Done** with no newer output → hidden. Output newer than `doneAt` brings the chat back. A snooze that hasn't expired → hidden.
6. **Pinned** → Pinned (Phase 2).
7. **Unread** → Updates.
8. **Read and idle, active within `recentWindowMs`** (default 7 days) → Earlier. Earlier shows 20 chats, then **Show more**. Anything older is reached through search or the other views.

The open chat never counts as unread (existing rule). It keeps its place while it is open.

A remote row whose host isn't online keeps its last state but never counts toward Needs you totals or the badge (see Phase 1 edge cases).

### Ordering

| Section | Order |
| --- | --- |
| Needs you | By tier, then by `attentionSince`, oldest first. The longest wait blocks the most work. Rows without `attentionSince` (remote in Phase 1) fall back to `updatedAt`. |
| Pinned | By `pinnedAt`, newest first. |
| Updates | By `lastAssistantAt`, newest first. |
| Earlier | By `updatedAt`, newest first. |
| Working | By `runStartedAt`, oldest first. |

Ties fall back to the host-qualified key `projectOrderKey(hostId, chatId)`, so the order is stable and local and remote ids never collide.

### Freeze while the list is in use

The list freezes while the pointer is over it, `:focus-visible` is inside it, or a row's ••• menu or a dialog opened from a row is open. It releases on window blur or when the window is hidden. While frozen:

- New rows still appear, added to the end of their section.
- State changes update a row's status and the section counts but don't move the row.
- A row that leaves the list (Done or read on another device, a host dropping out) holds its slot, dimmed, until the freeze releases.
- Deletes and workspace removal apply at once. Focus moves to the next row, as in BotSidebar's `deleteReturnFocus`.
- A full reset (host reconnect, view switch) waits for the release and then applies without animation.
- An action the person takes, such as opening a row or Mark read, places that row at once.

Outside a freeze, entering Needs you is immediate and leaving it is debounced 400 ms, so a run that answers one prompt and raises the next doesn't bounce the row.

Moves animate with FLIP for 150 ms, capped at 40 px. There's no animation under Reduce Motion or when more than 40 rows move at once.

## Phase 0 — Split the sidebar (no behaviour change, 1–2 PRs)

`renderer/components/chat-sidebar.tsx` is 2,023 lines. Inbox needs its row and section parts on their own.

**0a. Extract shared pieces** into `renderer/components/sidebar/`:

- `chat-row.tsx`: title, `ChatRowStatus`, context glyphs, shortcut kbd, and the ••• menu.
- `row-group.tsx`: disclosure group.
- `section-header.tsx`: label, count, and an optional collapse control.

`chat-sidebar.tsx` keeps state, data reads and view switching.

**0b. One row for local and remote chats.** `remoteSidebarRows` output renders through the same `ChatRow`. Remote rows gain the ••• menu, limited to actions the Remote API already supports and the host grants: Open; Mark read on unread rows where the host reports the `chat-read-state-v1` feature and grants `chat:read`; Rename where `chat:write` is granted and the row carries the host's revision. A rename reads that revision from the newest feed row when it is saved, retries once against a newer row if the host refused it, and makes the open remote chat reread its transcript. This is the only visible change in Phase 0, and the PR description calls it out.

**Tests.** `renderToStaticMarkup` tests for `ChatRow` cover these behaviours, without locking class strings:

- a status pill per row state;
- the unread dot hidden on the open chat;
- a remote row's host marker and menu items, with Mark read and Rename absent when the host lacks them;
- `aria-busy` only while Working.

The existing sidebar Playwright specs must pass unchanged.

**Docs.** None outside `.memory/`. This is a refactor.

## Phase 1 — Inbox on the desktop, renderer first (no Remote revision, 3–4 PRs)

**1a. The model.**

- `renderer/lib/sidebar-inbox.ts` with `inboxState` and `organizeInbox`.
- `"inbox"` added to `SIDEBAR_VIEWS`, and the `"attention"` migration in `parseSidebarPreferences`. The migration maps `"attention"` before the `oneOf(SIDEBAR_VIEWS, …)` check (`sidebar-organization.ts:485`); only then is `"attention"` removed from `SIDEBAR_VIEWS`.
- The `useSidebarView()` store.
- Fixture-based tests in `renderer/lib/sidebar-inbox.test.ts`. Each placement and ordering rule gets its own hand-written expected order (an independent oracle). The tests also cover snooze wake-ups, Done coming back on new output, detached and interrupted rows, offline hosts, and tie stability.

**1b. The Inbox view.**

- Sections: Needs you, Updates, Earlier, plus the Working shelf. The shelf is collapsible, takes at most 40% of the sidebar height, scrolls on its own, and remembers whether it is collapsed.
- Compact two-line rows, sized like OpenCode's Inbox: the whole row is one button with 6 px block padding and a 2 px gap; line 1 is 16 px tall in 12 px quaternary text (`project · {host}`, then the status or age at the end); line 2 is the title, 13 px on a 16 px line, medium weight when unread. Rows come out about 46 px. Section headers are 24 px. The host part appears only when paired hosts exist, and uses the host's name from `sidebarHosts` (fallback "Paired Mac"), never a literal "Mac". Working rows dim their status icon (not the text, to keep contrast) and show `Working {duration}`.
- Status text in Needs you uses the soft semantic colours: Approval and Question in warning, Failed in danger, Interrupted and Unavailable in warning. The tooltip carries the pending command, question or failure reason:
  - local chats: the `summary` from `chats:pendingAttention`;
  - remote chats: status, host and wait only. Summary rows can't carry prompt text (preview is forbidden, `protocol.ts:2491`), and approval summaries exist only on the run stream (`protocol.ts:2703`). Phase 2 adds `attentionSummary`.
- Freeze-while-in-use, and the FLIP rules above.
- Empty state: "Nothing needs you".
- A stable **Inbox** header at the top holds the Organize menu. Today the menu lives in the first section's header (`chat-sidebar.tsx:1920-1932`), which would jump as Needs you empties and fills.
- Keyboard: the existing F6 and arrow-key sidebar navigation, plus ⌘1–9 over the visible rows in display order, remote rows included (`renderer/lib/sidebar-chat-shortcuts.ts`). Including remote rows is a behaviour change: today ⌘1–9 skips them (`chat-sidebar.tsx:659-671`). Shortcuts key by `projectOrderKey(hostId, chatId)` and follow the frozen on-screen order, not the pending one.

**1c. Opening from a row.**

New desktop-only IPC, `chats:pendingAttention`, returns for each chat `{ kind, summary, since, runStartedAt, count }`, read from `HostRunRegistry` plus the detached and interrupted records. `kind` is `approval`, `question`, `detached` or `interrupted`. The summary is capped at 200 characters and never includes file contents. Rows never send an approval or an answer.

- **Open.** Clicking a row, Enter on a focused row, or ⌘1–9 opens the chat or Bot. The approval card is docked above the composer (`chat-pane.tsx:3540-3570`), so there is nothing to scroll. Opening focuses its Deny button, the existing default (`chat-pane.tsx:3128-3143`), but only when the person isn't typing and no overlay is open. With several approvals the card shows `approvals[0]` and `pendingCount` (`:3065`). A question replaces the composer (`:3667-3680`) and its answer field takes focus. When both wait, the approval comes first. Once the prompt resolves, focus goes to the composer. Approve, Deny and Always allow keep their existing rules in the chat, for local and remote chats alike.
- **Mark read** uses `chats:markRead` for local chats and `POST /chats/{chatId}/read` with `throughMessageId` for remote chats. It is available on Updates rows and from the ••• menu.

**1d. Bots, Settings and docs.**

- **Bots in the Inbox.** A local Bot shows in Needs you when `needsYou`, which already covers pending prompts, issues and failed runs (`live-projection.ts:1475-1505`). Its status reads "Needs you", never Approval or Question. It shows in Updates when it has an unread reply, which lives in `use-bot-sidebar-preferences.ts`, not in chat read markers. The row says it is a Bot, and opening it goes to the Bot. Remote Bots wait for Phase 2.
- **Settings → Appearance → Sidebar.** Radio cards for By workspace, Recent only and Inbox (Beta), following the `ChatWidthPicker` pattern and `docs/settings-design-system.md`. Selection uses the list-selection fill, never a border, and keyboard focus uses the neutral ring.
- **Docs:**
  - `README.md` and `PRODUCT.md`: the Inbox view.
  - `docs/settings-design-system.md`: the "Chat width is the one Appearance layout preference" line, plus a new "Sidebar" section.
  - `docs/plans/README.md`: the status row.
  - `docs/design-guide.md`: the compact Inbox row and its hover-icon overlay.

**Phase 1 edge cases.**

- *Offline, blocked and stale hosts.* A stale host keeps reporting `needs_approval` (`sidebar-remote-groups.ts:197`). Rows from a host that isn't online dim, show an offline marker, freeze their wait time, and drop out of Needs you counts and the badge. A blocked host's rows leave Needs you, replaced by one notice with **Reconnect**. The peer feed cache is memory-only, so after a restart an unreachable host shows "{Host} offline · its chats are hidden".
- *Answered elsewhere.* If a prompt was answered on another device before the chat opens, the chat lands on the newest turn with the existing "elsewhere" outcome (`host-chat-adapter.ts:175`). An offline host opens to its offline state. A host that doesn't grant `respondApproval` shows "Approve on {Host}" instead of the buttons.
- *Mark read bounds.* `markChatRead` without `throughMessageId` marks the newest message (`chat-read-markers-main.ts:13-28`), so the row passes the last assistant message id it rendered; a reply that lands mid-click stays unread. Remote Mark read reads a one-message window to get that id, and is hidden when the host has no messages window. Mark read is hidden on Approval, Question, Interrupted and Unavailable rows. On a Failed row it reads **Acknowledge** and moves the chat to Earlier. Opening a chat marks it read only while the chat is visible (`use-mark-chat-read.ts`).
- *Lifecycle placements.* `localSidebarChats` drops chats with no registered workspace (`sidebar-workspace-groups.ts:54-78`). The Inbox decides each case:
  - the Assistant chat and workspace-less scheduled chats: listed, with "Assistant" or "Scheduled" in place of the project;
  - Bot chats: only through their Bot row;
  - chats of removed workspaces: excluded, as in the other views;
  - scheduled-run failures are plain text (`schedule-execution.ts:213-231`), not `failed`, so they land in Updates;
  - script runs never begin a run, so they never reach Working;
  - drafts stay in the By workspace view only (`chat-sidebar.tsx:1128-1140`, `:1833`);
  - forks have no read marker and use `baselineAt` (`chat-row-state.ts:124-140`), so a new fork isn't unread;
  - there is no archived state (`types.ts:666-684`), so the Inbox adds no Archive; Done (Phase 2) is the way to put a chat away;
  - child-stream prompts are ignored (`chat-activity-core.ts:15-19`, `:62-63`). Phase 1 keeps that; rolling child prompts into the parent is a follow-up.
- *Search.* Search reaches past `recentWindowMs` and the Earlier cap, and respects the machine filter (`sidebar-organization.ts:254-325`).
- *Stored state.* The shelf's collapsed state lives in `SidebarPreferences`, not a new key. Preferences are written as a whole blob (`chat-sidebar.tsx:813-827`), so a second window could clobber the first. Listen for `storage` events and merge per field, as `use-bot-sidebar-preferences.ts:72` does.
- *Bot routes.* On a Bot route the sidebar swaps to `BotSidebar` (`chat-sidebar.tsx:484`), chats with a `botId` redirect to `/bots/$botId/chat` (`chat-pane.tsx:317-321`), and `BotSidebar` registers its own ⌘1–9. When `view` is `inbox`, the Inbox stays on Bot routes and owns ⌘1–9 there. Bot Mark read writes the Bot preferences.
- *Accessibility.* Each row's `aria-description` (the pattern at `chat-sidebar.tsx:1248`) carries the request text, and the tooltip also opens on keyboard focus. Each section is a `role="group"` with its label. The shelf sits inside the one `useRovingRows` container (`roving-rows.ts:90-120`), so arrow keys move between sections and the shelf. Status colours meet text contrast on both themes.
- *Clock.* Durations use `max(0, now - since)`. Remote clock skew waits for Phase 2.

**Phase 1 tests.**

- `sidebar-inbox.test.ts`.
- A render test for the Inbox sections, the status labels and the tooltip, and that Needs you rows render no action buttons.
- A register-and-invoke test for `chats:pendingAttention`: it refuses unknown chat ids, caps summary length, and returns `since` and `runStartedAt` from `HostRunRegistry` and a `detached` kind after the chat's renderer detaches.
- Update the Needs-attention coverage rather than adding beside it: `tests/e2e/chat-shell-interactions.spec.ts` and `renderer/components/sidebar-organize-menu.test.tsx`, plus a stored `"attention"` migrating to `"inbox"`.
- A Playwright spec run through `npm run test:e2e:space`: switch to Inbox; raise an approval from a second window (or a Remote-origin run), since a prompt raised in a chat the person leaves detaches; it appears in Needs you; clicking the row opens the chat with Deny focused; Approve there moves the chat to Working; ⌘1 opens the first row, remote rows included; leaving a chat mid-approval shows an Unavailable row.
- Each new file is registered in `package.json` and `scripts/ci-test-registry.json`, then `npm run test:ci-policy` is run.
- Screenshots of every new surface in light and dark go to the owner before approval.

**Exit.** The owner uses the Inbox daily for a week, with no row jumping under the pointer and no opened chat that lands somewhere other than its pending card.

## Phase 2 — Triage and reach (Remote revision 48, additive, 3–4 PRs)

Claim the revision after the one on `main` at merge time. It is 47 today (`AIDEN_REMOTE_SPENDING_LIMITS_CONTRACT_REVISION`).

**2a. Done, Snooze and Pin, stored on the host.**

- A new `ChatTriageStore` (`userData/chat-triage.json`), modelled on `ChatReadMarkerStore`. Triage changes never rewrite the chat index or bump a summary revision. It is bounded, and it broadcasts `chats:triage-changed`, which is added to `hostFeedChannels` (`aiden-remote-service-main.ts:1066-1074`).
- Each field is last-writer-wins, and each chat carries a triage `revision`. Triage is shared per host, so every device paired to that host sees the same Done, Snooze and Pin.
- Desktop IPC `chats:setTriage`, and Remote `POST /chats/{chatId}/triage` (`chat:write`, `Idempotency-Key`, optional `ifRevision`). The body is `{ pinned?, done?, snoozeUntil? }`.
- Snooze presets: 1 hour, This evening (18:00), Tomorrow (09:00), Next week (Monday 09:00). An approval, a question or a failed run wakes the chat early.
- Undo: a 5-second toast. Repeated actions merge into one toast ("3 chats marked done · Undo").

**2b. Inbox signals (`inbox-signals-v1`).**

- Summary rows gain optional fields: `attentionSince`, `runStartedAt`, `lastAssistantAt`, `pinnedAt`, `doneAt` and `snoozedUntil`. They give remote rows the times local rows already get from `chats:pendingAttention`.
- Run summaries gain `attentionSummary` (≤ 200 characters) for devices with `runs:observe`, so remote tooltips can show the request.
- Remote Bots: the host feed's Bot rows gain `needsYou` and `failed`, and remote Bot rows join the Inbox. Don't depend on `bot:issues` (revision 42): desktops don't negotiate it (`peer-host-registry.ts:132`, `aiden-remote-service-main.ts:1047-1058`). Durable Bot turns aren't in `HostRunRegistry`, so Bot times come from the Bot projection.
- iOS, Android and `protocol/aiden-remote/v1/fixtures/contract.json` are updated together, with parsers that ignore the fields on older hosts. The `HostRunSummary` fixture checks exact keys (`protocol.ts:8556`), so adding a field updates it in the same PR.

**2c. Dock badge.**

- A main-process count of Needs you: local signals from `HostRunRegistry`, Bot `needsYou`, and unseen failures, plus remote Needs you from the `PeerHostManager` feed caches in main.
- Only online hosts count. Keys are host-qualified (`hostId:chatId`), so a chat seen through two paths counts once.
- macOS uses `app.dock.setBadge`, and Linux uses `app.setBadgeCount` where the desktop supports it. Add a `badgeCount` capability to `main/services/host-platform-capabilities.ts:35` rather than reusing `dockIcon`. Unpackaged builds keep their `DEV` badge (`main/index.ts:2210`) and show no count.
- A switch next to the sidebar cards, on by default while Inbox is the view.

**2d. `aiden serve` hosts.** The CLI doesn't serve `GET /host/events`, which is what the desktop reads, and has no `HostRunRegistry`, read markers or activity snapshot (`packages/cli/src/remote-chats.ts:67-76`). 2d adds all four, then the chat-summary read with row state, unread and the `inbox-signals-v1` fields. A paired CLI host's chats then appear in the desktop sidebar and Inbox. Update `packages/cli/README.md`.

**Phase 2 edge cases.**

- *Clock skew.* Host times are shifted by the offset from `GET /server` `serverTime`. Durations stay `max(0, …)`.
- *Snooze time zones.* Presets resolve on the device that acts, in its time zone, and are sent as absolute RFC 3339 times. Main sets one timer at the earliest `snoozedUntil` and re-arms it after each wake.
- *Undo.* Undo sends `ifRevision`. If another device changed the chat since, Undo does nothing and the toast says so.
- *Many hosts.* A multi-chat action sends one request per host. Triage is disabled for a host under `hostControlRefusal`. Writes to a peer go through `peer-intent-store`, so a reconnect replays them with the same `Idempotency-Key`.
- *Capability gating.* `/triage` gets its own feature token. Each host falls back on its own: Done, Snooze and Pin are hidden for a host without the token.
- *Phone feature-token budget.* Phones use 30 of 32 tokens. Phases 2 and 3 spend at most two: one for `/triage`, and `inbox-signals-v1` for both 2b and 3a.

**Phase 2 tests.**

- `ChatTriageStore` resilience: corrupt file, bounds, last-writer-wins per field, and `ifRevision` refusing a stale write.
- Parser and route tests for `/triage`: idempotent replay, `chat:write` required.
- Fixture contract tests on desktop, iOS and Android.
- A dock-count aggregator unit test: offline hosts excluded, a chat counted once across paths.
- A Playwright check that Snooze hides the chat and an approval brings it back.

**Phase 2 docs.**

- `docs/aiden-remote-api-v1.md`: a new revision section.
- `docs/aiden-on-the-go-remote-access.md` and `docs/linux.md`: the badge.

## Phase 3 — Phones and onboarding (2–3 PRs)

**3a. Host-computed bucket.** Summary rows gain `inboxBucket` (`needs_you`, `pinned`, `updates`, `earlier`, `working`, `snoozed` or `done`) and `inboxSortAt`. Both come from the same `inboxState` code in `renderer/shared/`, so the CLI build shares it. The bucket is computed from state only; clients recheck the time-based parts (snooze expiry, `recentWindowMs`) against their own clock. It ships under the `inbox-signals-v1` token. It shares 2b's revision if both merge together, or claims the next one otherwise.

**3b. iOS and Android Inbox.**

- An Inbox option in each platform's workspace sidebar projection.
- iOS drops `aidenNeedsAttentionFirst` (`ios/…/Models/AidenChat.swift`) in favour of the host bucket. Android does the same (`AidenChatRowStatus.kt`). Both keep a local fallback for older hosts.
- Swipe actions: leading Mark read, trailing Done and Snooze.
- Optimistic, with skeletons, per the owner's phone rule.
- Android uses the M3 Expressive layer and is checked on a headless AVD.

**3c. One Working indicator.** iOS uses a spinner and Android a breathing dot. Both adopt the desktop's indicator so the three platforms match.

**3d. Onboarding.** Only if Inbox leaves Beta or becomes a headline feature: add a gallery tile in `renderer/components/onboarding-feature-gallery.tsx`. It needs code-drawn art in `renderer/components/onboarding-art/`, uses the `oa-anim-*` classes, and is covered by the onboarding art test.

**Phase 3 tests.**

- The iOS `AidenRemoteClientTests` suite and the Android chat-summary tests decode the bucket, and an unknown bucket falls back to local ordering.
- A snoozed bucket past its `snoozedUntil` on the phone's clock shows as awake.
- UI tests for the swipe actions.

**Phase 3 docs.** `ios/` and Android docs, and App Store "What's New" copy if it ships in a TestFlight build.

## Leaving Beta

Remove the Beta label once all of the following hold:

- Phases 1 and 2 have shipped in a release.
- No reported row-jump bugs are open.
- Phones show the same buckets as the desktop.

Whether Inbox becomes the default is a separate owner decision, made afterwards.

## Risks

| Risk | Mitigation |
| --- | --- |
| Approving the wrong command from a row | Rows can't approve. Approvals happen only in the chat, where the existing `promptId` / `approvalId` checks apply. |
| Needs you looks empty because local prompts detach | D12: detached prompts show as Unavailable and interrupted waits as Interrupted. The Playwright spec raises approvals from a second window or a Remote-origin run, so it tests a prompt that is really live. |
| Rows moving under the pointer | Freeze-while-in-use (pointer, focus-visible, open menus and dialogs), held slots for leaving rows, capped animation, and a Playwright check that moves are held back. |
| Remote rows lack times and request text in Phase 1 | Local times come from `HostRunRegistry` through `chats:pendingAttention`. Remote rows order by `updatedAt` and show status, host and wait only until 2b. Never a wrong section. |
| A stale or offline host keeps a chat in Needs you | Non-online hosts' rows dim, freeze, and leave the counts and the badge. A blocked host collapses to one Reconnect notice. |
| ⌘1–9 now reaches remote rows | Called out in the PR. Keys are host-qualified and follow the frozen on-screen order. A Playwright step covers it. |
| Large hosts (up to 2,000 chats each) | `organizeInbox` is linear plus one sort per section, memoized on the inputs. Earlier is capped at 20 with Show more. |
| Bots leak into workspace views | The D8 amendment is limited to the Inbox view. The workspace and recent projections keep excluding Bot homes, and existing tests stay. |
| Two places to switch the view disagree, or two windows clobber each other | One stored value through `useSidebarView()`, with `storage`-event per-field merge across windows. |
| Triage written from two devices at once | Last-writer-wins per field with a revision; Undo is conditional on `ifRevision`. |
| Remote revision collisions, phone feature-token budget | Claim at merge, and update iOS, Android and fixtures in the same PR. Spend at most two of the two remaining phone tokens. |

## Amendment to the Unified Workspace Sidebar plan

The Inbox view may list Bots, but only while they need the person (including an issue or a failed run) or have an unread reply. Bot rows open the Bot, never a workspace chat. The By workspace and Recent only views are unchanged.
