# Inbox Sidebar

Status: In progress (2026-10-31). The owner picked Option D (Hybrid Inbox) and accepted every recommended decision. Two code-grounded edge-case reviews (local desktop; connected hosts, `aiden serve` and phones) are folded in. Phase 0 and all of Phase 1 (1a–1d) are built on the plan branch `claude/inbox-sidebar-plan`; Phases 2–3 are next. See "1b and 1c as built" and "1d as built" for where the build differs from the text below.

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
| Aiden today (before the Inbox) | Needs-attention tiers (then `SIDEBAR_ATTENTION_TIERS` and `sidebarAttention` in `renderer/lib/sidebar-organization.ts`; the Inbox's `INBOX_TIERS` and `inboxRowStatus` replace them). Honest unread and failed markers (Remote revisions 18 and 36). Remote rows (`remoteSidebarRows` in `renderer/lib/sidebar-remote-groups.ts`). Bot `needsYou` (`main/services/bot-runtime/live-projection.ts:1475-1505`, shown by `renderer/main/bots/bot-sidebar.tsx`). First-responder-wins run approvals over Remote. | Hand-written phone sorts (`aidenNeedsAttentionFirst` on iOS and Android) once the host can send the bucket. |

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

The sidebar view already lives in `SidebarPreferences.view`. It is device-local and saved in `localStorage` under `SIDEBAR_PREFERENCES_KEY`, now owned by `renderer/lib/use-sidebar-view.ts`. The Appearance cards will not add a second `AppearanceConfig.sidebarStyle` field. Two stored values could disagree, and the unified sidebar plan keeps organization state device-local. Instead, Phase 1 adds a small `useSidebarView()` store. The Organize menu and the Appearance cards both read and write it. They stay in sync within the window, and across windows through the `storage` event; every write merges its own fields over what is stored at that moment.

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
organizeInbox(rows, now, options) → { needsYou, pinned, updates, earlier, working, hiddenCount, earlierMoreCount, needsYouCount }
freezeInboxOrder({ previous, next, touched, present }) → the held on-screen order (see the freeze rules)
```

### Where Needs you comes from

Leaving a local chat calls `cancel("lifecycle")` (`chat-pane.tsx:865-873`), which detaches the renderer (`chat.ts:77-81`, `llm-client.ts:5148-5171`), and pending prompts settle as `"detached"` (`tool-approval.ts:61-62`, `:214-230`). So a local approval or question is live only while some window shows that chat. Local Needs you rows come from:

- the open chat;
- a chat open in another window;
- Remote-origin runs on this Mac (started from a phone or a paired Mac), which don't detach with the desktop pane;
- Bots (`needsYou`);
- detached prompts: main records the prompts per chat just before the detach settles them (`main/services/chat-pending-attention.ts`, memory only, so a restart drops them with their runs), and the row reads **Unavailable**, tooltip "Approval unavailable — return to retry". A new run in the chat clears them; opening the chat clears them through `chats:dismissDetachedAttention`;
- interrupted waits: `interruptedWaits` (`main/services/interrupted-reply.ts`, shape in `renderer/shared/interrupted-reply.ts`) keeps `askedAt` and the summary for 7 days after a quit or crash. The row reads **Interrupted**, `attentionSince = askedAt`, and opening it shows the existing Resume card (`chat-pane.tsx:3278-3374`).

Times come from main, not the window. `chats:pendingAttention` reads `HostRunRegistry` (`pendingPrompt`, `host-run-registry.ts:412`; `currentRunForChat`, `:453`; `startedAt`) and returns `since` and `runStartedAt`. The registry had no per-prompt time, so Phase 1 adds `promptRaisedAt(id)` (`:419`), stamped when the prompt is journaled. `ChatActivityRegistry` holds only id sets (`chat-activity-core.ts:21-93`) and supplies neither summaries nor times. Remote rows have no prompt times until Phase 2.

### Placement rules, in order

1. **`needs_approval` or `needs_input`** → Needs you, tier 0 or 1. These override Done and Snooze: an approval wakes a snoozed chat.
2. **An unread failed run** → Needs you, tier 2. This matches the existing `failed` tier in `sidebarAttention`, and it also wakes a snoozed chat.
3. **Detached or interrupted** (local) → Needs you, tier 3.
4. **`working`** → the Working shelf.
5. **Done** with no newer output → hidden. Output newer than `doneAt` brings the chat back. A snooze that hasn't expired → hidden.
6. **Pinned** → Pinned (Phase 2).
7. **Unread** → Updates.
8. **Read and idle, active within `recentWindowMs`** (default 7 days) → Earlier. Earlier shows 20 chats, then **Show more**. Anything older is reached through search or the other views.

The open chat never counts as unread (existing rule). It keeps its place while it is open. If it would fall past Earlier's cap, it takes the last of the 20 slots instead, so Earlier never hides the chat in the main pane and never grows past the cap.

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

- New rows still appear, added to the end of their section. Earlier stays within its cap: a new arrival that would push it past 20 waits behind **Show more**, whose count includes it.
- State changes update a row's status and the section counts but don't move the row.
- A row that leaves the list (Done or read on another device, a host dropping out) holds its slot, dimmed, until the freeze releases. A row that only fell past Earlier's cap has not left: it keeps its slot, not dimmed.
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
- `"inbox"` added to `SIDEBAR_VIEWS`. The `"attention"` migration waits for 1b.
- The `useSidebarView()` store, plus `useWorkingShelfCollapsed()` for the shelf's stored state (`SidebarPreferences.workingShelfCollapsed`).
- Between 1a and 1b, a stored `inbox` laid out like Needs attention, and the sidebar title and Organize menu showed it as Needs attention. It is serialized with the legacy `organization: "workspace"`, so an older build falls back to By workspace. Since 1b it renders as the Inbox.
- `chats:pendingAttention` (see 1c) lands with 1a as data only.
- Fixture-based tests in `renderer/lib/sidebar-inbox.test.ts`. Each placement and ordering rule gets its own hand-written expected order (an independent oracle). The tests also cover snooze wake-ups, Done coming back on new output, detached and interrupted rows, offline hosts, and tie stability.

**1b. The Inbox view.**

- The `"attention"` migration in `parseSidebarPreferences`, landing with the view that replaces it. The migration maps `"attention"` before the `oneOf(knownViews, …)` check in `parseSidebarPreferences`; only then is `"attention"` removed from `SIDEBAR_VIEWS`.
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

New desktop-only IPC, `chats:pendingAttention`, returns for each chat `{ kind, summary, since, runStartedAt, count }`, read from `HostRunRegistry` plus the detached and interrupted records. `kind` is `approval`, `question`, `detached`, `interrupted` or `working` (a live run with nothing to answer, so Working-shelf rows get `runStartedAt`; its summary is empty and `count` is 0). Precedence is that order. The summary is the registry's bounded approval summary or the first question's text, collapsed to one line and capped at 200 characters; tool details and file contents never appear. Chats this host doesn't have, and chats waiting on nothing, are left out; malformed ids or more than 2,000 are refused. A second channel, `chats:dismissDetachedAttention(chatId)`, clears a chat's Unavailable prompts. Shape: `renderer/shared/chat-pending-attention.ts`; handler: `main/handlers/chat-pending-attention.ts`. Rows never send an approval or an answer.

`detached` covers prompts raised while the chat's renderer was detached as well as prompts open when it detached: a prompt the coordinators refuse because the renderer has gone is recorded with `since` set to the refusal, except on unattended runs (scheduled, Remote, routines), which have no window to come back to. An interrupted wait from a run older than the chat's live run is ignored, so a chat that is working again shows as Working. Deleting a chat clears its Unavailable prompts. Each call reads the saved interrupted waits once; a read failure is logged as a warning and the chats show no interrupted rows. The Inbox refreshes on change events (chat, run and prompt events), not by polling.

- **Open.** Clicking a row, Enter on a focused row, or ⌘1–9 opens the chat or Bot. The approval card is docked above the composer (`chat-pane.tsx:3540-3570`), so there is nothing to scroll. Opening focuses its Deny button, the existing default (`chat-pane.tsx:3128-3143`), but only when the person isn't typing and no overlay is open. With several approvals the card shows `approvals[0]` and `pendingCount` (`:3065`). A question replaces the composer (`:3667-3680`) and its answer field takes focus. When both wait, the approval comes first. Once the prompt resolves, focus goes to the composer. Approve, Deny and Always allow keep their existing rules in the chat, for local and remote chats alike.
- **Mark read** uses `chats:markRead` for local chats and `POST /chats/{chatId}/read` with `throughMessageId` for remote chats. It is available on Updates rows and from the ••• menu.

**1b and 1c as built (2026-10-31).** The view lives in `renderer/components/sidebar/inbox-view.tsx`, with its pure helpers (status label, description, row action, freeze bookkeeping) in `renderer/lib/sidebar-inbox-view.ts`. Where it differs from the text above:

- Remote **Mark read** goes through the existing `markRemoteChatRead` path rather than reading a one-message window; local Mark read passes the newest message no newer than the row's `lastAssistantAt`.
- A blocked host's rows are left out of the Inbox. 1d settled the notice that replaces them; see "1d as built".
- The Working shelf's 40% cap is measured from the sidebar's height with a `ResizeObserver`.
- Changing the search text or the machine filter resets the frozen order at once, so results never wait for the pointer to leave.
- "Nothing needs you" shows only when Needs you, Updates and Earlier are all empty; a running Working shelf doesn't hide it.
- Section counts appear on Needs you and Working only.
- A Question row relies on the existing `AskUserQuestionComposer` autofocus for its answer field.
- `chats:pendingAttention` is asked about at most 2,000 chats, its own limit: every chat that is running or waiting first, then the newest. Bot chats are left out. Its query key carries the id count and a hash, not the ids, and lives outside the `chats` key, so chat-list updaters never touch it.
- A prompt the host refuses after its window left publishes a new activity revision (`ChatActivityRegistry.touch`), so the Unavailable row appears without another change event.
- When a prompt resolves, focus returns to where it was before the card took it only if that was outside the sidebar; a chat opened from a row or ⌘1–9 leaves focus with the composer.
- A row held in Needs you by the 400 ms linger or a freeze shows its live status, not the one it entered with.
- The freeze re-checks for open menus once it starts watching, because the Organize menu that switches to the Inbox can close before the view's observer is attached.
- Opening a chat calls `chats:dismissDetachedAttention`, so its Unavailable row clears.
- The Working shelf is its own region under the scrolling list (the sidebar's `belowList` slot), not a sticky part of it: rows never show through it, a short list leaves it pinned to the bottom, it scrolls inside its 40% cap, and its rows line up with the list's. The roving-rows container spans both.
- The freeze reads the pointer and keyboard focus from the DOM, not React's synthetic events, so a portalled menu or tooltip never holds it; an open menu or dialog holds it on its own. A focused row that goes releases it unless focus moves to the row in its place.
- Row actions match their menu items: both come from `inboxRowAction`, so a Failed row reads Acknowledge in both, and held-over or offline rows offer neither.
- **Known gap, closed in 1d:** while the Inbox was the stored view it stayed on Bot routes in place of `BotSidebar`, so the Bot list couldn't be reached there and Bots didn't show in the Inbox. See "1d as built".

**1d. Bots, Settings and docs.**

- **Bots in the Inbox.** A local Bot shows in Needs you when `needsYou`, which already covers pending prompts, issues and failed runs (`live-projection.ts:1475-1505`). Its status reads "Needs you", never Approval or Question. It shows in Updates when it has an unread reply, which lives in `use-bot-sidebar-preferences.ts`, not in chat read markers. The row says it is a Bot, and opening it goes to the Bot. Remote Bots wait for Phase 2.
- **Settings → Appearance → Sidebar.** Radio cards for By workspace, Recent only and Inbox (Beta), following the `ChatWidthPicker` pattern and `docs/settings-design-system.md`. Selection uses the list-selection fill, never a border, and keyboard focus uses the neutral ring.
- **Docs:**
  - `README.md` and `PRODUCT.md`: the Inbox view.
  - `docs/settings-design-system.md`: the "Chat width is the one Appearance layout preference" line, plus a new "Sidebar" section.
  - `docs/plans/README.md`: the status row.
  - `docs/design-guide.md`: the compact Inbox row and its hover-icon overlay.

**1d as built (2026-10-31).** Where it differs from, or settles, the text above:

- **Bot rows.** `botInboxRows` (`renderer/lib/sidebar-inbox-view.ts`) turns each local Bot into one entry, keyed `local:bot:<id>` so it can never collide with a chat. A Bot that needs you sits in Needs you with the "Needs you" status and the description "Waiting for you"; a Bot with an unread reply (`isBotUnread` against the Bot sidebar preferences) sits in Updates; the open Bot sits in Earlier. Bots that are only running or are read are not listed: their activity lives in the Bot list, and the Working shelf stays for chats. The row's meta reads "Bot", led by a 14px copy of the Bot's face (`ChatRowInbox.metaIcon`, the avatar shape and colour without its photo) in line 1 rather than a leading avatar, so Bot and chat titles start at the same edge. Mark read calls the Bot preferences' `markReplySeen` (`withBotReplySeen`), which records the reply as seen without counting as a visit, so it never changes which Bot the Bots button opens. Bot chats still show only through their Bot row, and remote Bots wait for Phase 2. The Bot list is fetched, and the Bot preferences read (`useBotSidebarPreferencesWhen`), only while the Inbox is showing (`useBotRows({ enabled })`); `useBotNotificationsSync` keeps the summaries current.
- **Bots the list holds.** Every Bot is known to the Inbox, listed or not (`botInboxRows` returns `listed` and `unlisted`). A Bot that stops qualifying while the list is frozen under the pointer, or during the 400 ms Needs you linger, is held in place with its live state (a Bot read elsewhere shows read at once); only a deleted Bot goes at once. Mark read on the Bot's own row places it live at once, like any row acted on, and a read Bot's live place is off the list.
- **The open Bot stays listed.** Unlike an open chat that has gone quiet, the open Bot keeps a row in Earlier so the sidebar shows where the person is; it drops off when they leave it, unless it still needs them or has news.
- **Bot-list reachability.** Only the primary-nav Bots button, the `bots.open` command and the All Bots links ask for the Bot list. The ask lives on the history entry (`state.aidenBotList`, set by `botListLocation()` in `renderer/lib/bot-routes.ts`), and `carryBotListRequest`, wrapped around the router's `commitLocation`, carries it through the Bots entries that follow (the `/bots` redirect to the last Bot, opening other Bots) until the person leaves Bots. Because the ask goes on the location before the router compares it with the current entry, opening the Bot that's already open stays a no-op on an asked-for entry too, instead of pushing a duplicate history entry. `BotSidebar` also skips navigating when the row clicked is the open Bot, as the Bot menu does. `sidebarShowsBotList` reads the ask from the router location, so Back and Forward bring back whichever sidebar that entry showed. A plain `/bots` (after deleting a Bot, or Settings' Manage Bot grants) doesn't start an ask; it keeps one already in progress inside Bots. A Bot opened from an Inbox row or ⌘1–9 keeps the Inbox. One opened from a notification keeps the Inbox too, unless the person is already inside Bots on an asked-for entry, in which case it keeps the Bot list. When the Inbox shows on a Bot route, the open Bot's row is selected and the Bots nav item is not, so only one of them reads as current. Only one of the two sidebars is mounted at a time, so ⌘1–9 is registered once: by the Inbox on an Inbox Bot route, by `BotSidebar` on the Bot list.
- **⌘1–9 on held rows.** The Inbox registers ⌘1–9, ⌘[ and ⌘] from the same key list its hints number (`inboxShortcutTargets` in `renderer/lib/sidebar-inbox-view.ts`), resolving each key against the listed entries first and then the held ones. A Bot answered elsewhere that lingers in Needs you for 400 ms keeps its hint and its binding together, so ⌘N always opens the row that shows N.
- **Reconnect notice.** The existing `RemoteHostStatusList` (`renderer/components/sidebar-remote.tsx`) already sits above the list in every view, the Inbox included. It reads "{Host} · Needs re-pairing" with a **Connections** button for a blocked host, and "{Host} · Offline" with **Reconnect** for an offline one, so it is the one notice that stands in for a blocked host's rows. No Inbox-specific notice was added.
- **Settings → Appearance → Sidebar.** `SidebarViewPicker` (`renderer/components/settings/sidebar-view-picker.tsx`) reads and writes the same `useSidebarView()` store as the Organize menu, so either one updates the other at once, across windows too. The Inbox card's accessible name is "Inbox (Beta)". Its miniature leads with an amber bar for the waiting row, drawn from `--support-warning` and lifted to an amber lightness and chroma, because light schemes darken that token for text contrast. The cards share the Chat width cards' radio-card styles and arrow-key handling (`radio-navigation.ts`).
- **Accessible names.** An Inbox row's name leads with its title, then the project, status, wait and "Unread", joined by commas: "Fix the build, aiden, 2h, Unread".

**Phase 1 edge cases.**

- *Offline, blocked and stale hosts.* A stale host keeps reporting `needs_approval` (`sidebar-remote-groups.ts:197`). Rows from a host that isn't online dim, show an offline marker, freeze their wait time, and drop out of Needs you counts and the badge. A blocked host's rows leave Needs you, replaced by one notice (as built, the existing host status row: **Connections** to re-pair, **Reconnect** when offline). The peer feed cache is memory-only, so after a restart an unreachable host shows "{Host} offline · its chats are hidden".
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
- *Stored state.* The shelf's collapsed state lives in `SidebarPreferences`, not a new key. Preferences used to be written as a whole blob from `chat-sidebar.tsx`, so a second window could clobber the first. 1a moved the write into `writeSidebarPreferences(patch)`, which re-reads storage and writes only the changed fields, and the store listens for `storage` events, as `use-bot-sidebar-preferences.ts:72` does. The sidebar's own copies of stored fields (sorts, manual order, expanded groups, machine filter and grouping) refresh on another window's write (`useSidebarPreferencesFromOtherWindows`), so a later drag or collapse builds on that change instead of restoring the old list.
- *Bot routes.* On a Bot route the sidebar swaps to `BotSidebar` (`chat-sidebar.tsx:484`), chats with a `botId` redirect to `/bots/$botId/chat` (`chat-pane.tsx:317-321`), and `BotSidebar` registers its own ⌘1–9. When `view` is `inbox`, the Inbox stays on Bot routes and owns ⌘1–9 there, unless the entry asks for the Bot list (see 1d as built). Bot Mark read writes the Bot preferences.
- *Accessibility.* Each row's `aria-description` (the pattern at `chat-sidebar.tsx:1248`) carries the request text, and the tooltip also opens on keyboard focus. Each section is a `role="group"` with its label. The shelf sits inside the one `useRovingRows` container (`roving-rows.ts:90-120`), so arrow keys move between sections and the shelf. Status colours meet text contrast on both themes.
- *Clock.* Durations use `max(0, now - since)`. Remote clock skew waits for Phase 2.

**Phase 1 tests.**

- `sidebar-inbox.test.ts`.
- A render test for the Inbox sections, the status labels and the tooltip, and that Needs you rows render no action buttons.
- A register-and-invoke test for `chats:pendingAttention`: it refuses unknown chat ids, caps summary length, and returns `since` and `runStartedAt` from `HostRunRegistry` and a `detached` kind after the chat's renderer detaches.
- Update the Needs-attention coverage rather than adding beside it: `tests/e2e/chat-shell-interactions.spec.ts` and `renderer/components/sidebar-organize-menu.test.tsx`, plus a stored `"attention"` migrating to `"inbox"`.
- A Playwright spec run through `npm run test:e2e:space`: switch to Inbox; raise an approval from a second window (or a Remote-origin run), since a prompt raised in a chat the person leaves detaches; it appears in Needs you; clicking the row opens the chat with Deny focused; Approve there moves the chat to Working; ⌘1 opens the first row, remote rows included; leaving a chat mid-approval shows an Unavailable row. As built, `tests/e2e/inbox-sidebar.spec.ts` uses a Remote-origin approval (the main process's `remote:getPendingApproval` and activity events stand in for a paired phone), because Aiden has one main window. A second spec case raises a real approval, checks its Approval row and description, leaves the chat and checks the Unavailable row and tooltip. `chat-shell-interactions.spec.ts` checks that rows hold their places while the pointer is over the list.
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
| A stale or offline host keeps a chat in Needs you | Non-online hosts' rows dim, freeze, and leave the counts and the badge. A blocked host collapses to one host status notice (re-pair through Connections). |
| ⌘1–9 now reaches remote rows | Called out in the PR. Keys are host-qualified and follow the frozen on-screen order. A Playwright step covers it. |
| Large hosts (up to 2,000 chats each) | `organizeInbox` is linear plus one sort per section, memoized on the inputs. Earlier is capped at 20 with Show more. |
| Bots leak into workspace views | The D8 amendment is limited to the Inbox view. The workspace and recent projections keep excluding Bot homes, and existing tests stay. |
| Two places to switch the view disagree, or two windows clobber each other | One stored value through `useSidebarView()`, with `storage`-event per-field merge across windows. |
| Triage written from two devices at once | Last-writer-wins per field with a revision; Undo is conditional on `ifRevision`. |
| Remote revision collisions, phone feature-token budget | Claim at merge, and update iOS, Android and fixtures in the same PR. Spend at most two of the two remaining phone tokens. |

## Amendment to the Unified Workspace Sidebar plan

The Inbox view may list Bots, but only while they need the person (including an issue or a failed run) or have an unread reply, and (as built in 1d) the Bot that is open, the way an open chat stays listed. Bot rows open the Bot, never a workspace chat. The By workspace and Recent only views are unchanged.
