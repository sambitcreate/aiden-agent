# Inbox Sidebar

Status: In progress (2026-11-01). The owner picked Option D (Hybrid Inbox) and accepted every recommended decision. Two code-grounded edge-case reviews (local desktop; connected hosts, `aiden serve` and phones) are folded in. Phase 0, all of Phase 1 (1a–1d), all of Phase 2 (2a–2d), Phase 3a, and the iOS half of 3b and 3c are built on the plan branch `claude/inbox-sidebar-plan`; Android 3b and 3c are next. See "1b and 1c as built", "1d as built", "2a as built", "2b as built", "2c as built", "2d as built", "3a as built" and "3b as built, iOS" for where the build differs from the text below.

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
- **⌘1–9 on held rows.** The Inbox registers ⌘1–9, ⇧⌘[ and ⇧⌘] from the same key list its hints number (`inboxShortcutTargets` in `renderer/lib/sidebar-inbox-view.ts`), resolving each key against the listed entries first and then the held ones. A Bot answered elsewhere that lingers in Needs you for 400 ms keeps its hint and its binding together, so ⌘N always opens the row that shows N.
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

**2a as built (2026-11-01).**

- *Store.* `ChatTriageStore` (`main/services/chat-triage.ts`, wired in `chat-triage-main.ts`) keeps `{revision, updatedAt, pinnedAt?, doneAt?, snoozedUntil?}` per chat, bounded at 5,000 chats (empty entries go first, then the oldest) and 2 MB. A write sets each field it names and keeps the others. `pinned: true` on a pinned chat keeps the first `pinnedAt`. A snooze time that isn't positive or is more than 366 days ahead is refused as invalid, and one already past clears the snooze. Deleting a chat, from any path (desktop, Remote, Bot), drops its triage entry and its read marker. The shapes and pure rules (`inverseTriagePatch`, `snoozeOptions`) live in `renderer/shared/chat-triage.ts`.
- *Waking.* One main-process timer is armed at the earliest `snoozedUntil`, re-checks at least once a minute and again when the Mac wakes or unlocks, and re-arms after each wake (also after a failed clear). `wakeTriageOnAttention` subscribes to `HostRunRegistry`: a run that starts needing approval or input, fails, or raises a new prompt clears that chat's snooze (only the snooze; Pin and Done stay), so answering one of two approvals doesn't wake it. Sending a message in a snoozed chat clears its snooze too. The Inbox already ranks a live prompt above Snooze, so the row shows in Needs you at once either way.
- *Desktop IPC.* `chats:triage` reads the snapshot, `chats:setTriage` writes (`main/handlers/chat-triage-params.ts` parses `{chatId, patch, ifRevision?}`), and `chats:triage-changed` broadcasts the snapshot, also as a host-feed channel.
- *Remote.* `POST /chats/{chatId}/triage` (`chat:write`, `Idempotency-Key`) takes `{pinned?, done?, snoozeUntil?, ifRevision?}` with `snoozeUntil` an RFC 3339 time or `null`, and answers with the chat's triage (`revision`, RFC 3339 times). A stale `ifRevision` is `409 revision_conflict` with `currentRevision`. A Bot chat is `not_found`. The route has its own feature token, `chat-triage-v1`, announced to paired desktops only: phones already negotiate the full 32 tokens, so they gain it when a later revision frees a slot (the 2b fields stay optional and need no phone token). The OpenAPI path ships here; the revision number moves with 2b.
- *Writes from this Mac to a peer.* `RemoteHostAdapter.setTriage` mints one `Idempotency-Key` per action and retries once with the same key after an `outcome_unknown`. Triage does not go through `peer-intent-store`: a triage write that never landed is simply re-done by the person, and replaying a stale Pin or Snooze after a long disconnect would surprise more than help. The adapter refuses writes under `hostControlRefusal`, and the row's menu shows the items disabled for a host that isn't online or a dimmed row. A host without `chat-triage-v1` shows no triage items.
- *Rows.* Pin (or Unpin), **Mark done** and a **Snooze** submenu sit in an Inbox row's ••• and context menus only, never as inline buttons, and never on Bot rows (`renderer/components/sidebar/inbox-triage-menu.tsx`). The submenu works out its presets when it opens and shows each one's time ("6:00 PM" today, a short weekday and the time within the week, "Mon 9:00 AM", else the date, "Nov 9, 9:00 AM", since the label already names the day); This evening drops out once 18:00 is less than an hour away (see "2a/2b review fixes"). The Inbox gains a **Pinned** group between Needs you and Updates, newest pin first; a pinned chat that needs the person still shows in Needs you. Done rows hide until output newer than `doneAt` lands, and snoozed rows until they wake.
- *Instant, then Undo.* `useInboxTriage` (`renderer/lib/use-inbox-triage.ts`) applies each write to an overlay at once, by the store's own rules (`predictTriage`), so the row moves before the host answers; a failure puts the row back and shows one error toast. The overlay entry for a local chat goes once the store reports its revision. Then one Undo toast (5 s, `id: "inbox-triage"`, its Undo the shared small filled squircle button) names the action ("Marked done", "Snoozed until tomorrow, 9:00 AM"); actions of the same kind within the window merge into it ("3 chats marked done"), and a chat acted on twice keeps its first `before`. Undo writes the inverse of each chat's patch with `ifRevision` set to the revision this device's write left. A chat another device changed since is left alone, and the toast says "That chat changed since, so Undo left it as it is." Undo places its restored rows live, so a list in use puts them back in their own slot.
- *Many hosts.* Writes are grouped by host: each host gets one connection (this Mac's IPC, or one `RemoteHostAdapter`) and its writes run in order, while hosts run side by side. The sidebar has no multi-select, so a batch today is the merged Undo.
- *Not yet.* A paired host's triage reaches this Mac only through this device's own writes until 2b adds the summary fields, so a remote overlay entry doesn't expire yet. No client tracks `GET /server` `serverTime` skew; snooze times are absolute and compared on the reader's clock, so a skewed host wakes early or late by its skew (noted for 2b).

**2b. Inbox signals (`inbox-signals-v1`).**

- Summary rows gain optional fields: `attentionSince`, `runStartedAt`, `lastAssistantAt`, `pinnedAt`, `doneAt` and `snoozedUntil`. They give remote rows the times local rows already get from `chats:pendingAttention`.
- Run summaries gain `attentionSummary` (≤ 200 characters) for devices with `runs:observe`, so remote tooltips can show the request.
- Remote Bots: the host feed's Bot rows gain `needsYou` and `failed`, and remote Bot rows join the Inbox. Don't depend on `bot:issues` (revision 42): desktops don't negotiate it (`peer-host-registry.ts:132`, `aiden-remote-service-main.ts:1047-1058`). Durable Bot turns aren't in `HostRunRegistry`, so Bot times come from the Bot projection.
- iOS, Android and `protocol/aiden-remote/v1/fixtures/contract.json` are updated together, with parsers that ignore the fields on older hosts. The `HostRunSummary` fixture checks exact keys (`protocol.ts:8556`), so adding a field updates it in the same PR.

**2b as built (2026-11-01).** Where it differs from, or settles, the text above:

- *Revision and token.* Remote contract revision 48 (provisional: claim the next free revision at merge by changing only `AIDEN_REMOTE_INBOX_SIGNALS_CONTRACT_REVISION`). `inbox-signals-v1` is announced to paired desktops (`mac`, `linux`) only, while the host serves Chat Summaries. Phones spend no token: every field is optional and they decode as before (iOS and Android tests prove a phone's rows are unchanged, even by malformed values). 3a spends the reserved phone token when phones start reading the fields.
- *Summary fields.* `attentionSince` and `runStartedAt` come from the live run (`liveRunAttention` in `main/services/chat-pending-attention.ts`), `lastAssistantAt` from the projection, and `pinnedAt`, `doneAt`, `snoozedUntil` with `triageRevision` from the 2a store. All are RFC 3339 and sent only when known; a triage time without `triageRevision` fails closed (`parseInboxSignalFields` in `aiden-remote-protocol.ts`).
- *The ask.* `run.state` gains `attentionSummary` (whitespace collapsed, ≤ 200 characters with "…", `clipPendingAttentionSummary`) only while the run is `needs_approval` or `needs_input`, and only to `runs:observe` devices: the journal entry carries it as an alternate observer frame that `open()` picks per device, replay included. The peer feed cache clips it again and drops a malformed one; the sidebar shows it only while the row waits and the run is live.
- *Remote rows.* `remoteInboxEntries` reads the revision-48 times, so a remote wait shows and sorts like a local one ("Approve: npm publish. On Studio, waiting 7m"). A host without the token keeps 1c's behaviour.
- *Remote triage.* Each paired host's reported entry (from its summaries) feeds `useInboxTriage`, and `settledTriageOverlayKeys` drops an overlay entry once the host reports a `triageRevision` at least as new, closing 2a's "Not yet".
- *Remote Bots.* The host feed's Bot rows gain `needsYou`, `failed` (the Bot's last state is `interrupted` or `model_error`) and `lastReplyAt` (`hostFeedBotSignals` in `aiden-remote-host-feed.ts`), and the feed pushes on `bots:attention`. A paired host's Bot is listed while it needs the person, has failed, or is open: Needs you shows Needs input, a failure shows Failed in Needs you. It opens with `useRemoteBots().open`, offers no row action and no triage, and reads "Waiting for you on Studio" or "The last run failed on Studio" (". Studio is offline" when offline).
- *2a render loop fixed.* `useInboxTriage` returned a new object every render, and the Inbox's entry list depends on it, so opening the Inbox looped until React stopped it (error #185) and every Inbox E2E test crashed. The hook now returns a memoized `{ entryFor, act }`, and `useRemoteBots().open` keeps one identity.
- *Gaps.* A remote Bot has no wait start, so it orders by `lastReplyAt` (or its definition's `updatedAt`). Its replies are never unread: the feed has no Bot read marker. No client tracks `GET /server` `serverTime` skew; snooze and wait times are compared on this Mac's clock, so a skewed host's rows wake or age early or late by the skew.

**2a/2b review fixes (2026-11-01).** Two review passes on 2a and 2b settled:

- *Reversible triage.* A search lists Done and snoozed matches too (`organizeInbox` with `includeTriaged`), each with a quiet "Done" or "Snoozed until 6:00 PM" / "Mon 9:00 AM" / "Nov 16" status (`inboxRowStatus`, `formatSnoozeStatus`). Their menus offer **Mark not done** (`{done:false}`) and **Unsnooze** (`{snoozeUntil:null}`) in place of Mark done and Snooze. Sending a message in a snoozed chat, from this Mac or a paired device, clears its snooze through the store's `wake` (Pin and Done stay).
- *Only actions that move the row.* `inboxTriageOffer` hides Mark done and Snooze on a row with a pending approval or question, a run in progress or an Unavailable prompt, since none of them would move it; such rows offer Pin alone. On an unread failed run, Mark done and Snooze also mark the chat read, since unseen failed output keeps it in Needs you.
- *Snooze presets.* Next week on a Sunday is the Monday after next (at least 2 days away). This evening drops out once it is less than an hour away. The menu's trailing time is the time alone for today, "Mon 9:00 AM" within the week, else "Nov 9, 9:00 AM", so on a Sunday Next week no longer reads like Tomorrow.
- *Undo and shortcuts.* Undo places its restored rows live (`InboxViewHandle.touch`), so a frozen list puts them back in their own slot rather than at the end. After Done or Snooze on the open chat, ⇧⌘[ and ⇧⌘] step from the rows that were around it. A paired host's `revision_conflict` carries `entry: null` (the host sends only `currentRevision`); the adapter no longer invents one.
- *Remote menu order.* A remote Inbox row's triage sits right after its one action, as on a local row.
- *Host.* The snooze timer re-arms after a failed clear, re-checks at least once a minute, and checks again when the Mac wakes or unlocks. A snoozed chat wakes early only when a run starts needing approval or input, fails, or raises a new prompt, so answering one of two approvals doesn't wake it. A delete from any path (desktop, Remote, Bot) drops the chat's triage entry and read marker. A device that starts observing runs gets a `run.state` with its `attentionSummary` for each run already waiting, on sequences every other device skips.

**2a/2b re-review fixes (2026-11-01).** A second pass on those fixes settled:

- *Read after write.* On an unread failed run, Mark done and Snooze mark the chat read only once the host has taken the triage write (`act`'s `onWritten`), so a refused write leaves the chat unread. There is no way to mark a chat unread again, so **Undo reverses the triage but not the read**: the chat comes back read. A paired host that offers no mark-read offers Pin alone on such a row, since Mark done or Snooze could not move it.
- *Held rows.* A row held by a wait or a run that is still snoozed offers **Unsnooze** next to Pin, so a snooze set before the wait can still be cleared.
- *Snoozed status.* A snoozed match in search now reads "Until 1:42 PM" / "Until 6 PM" (today), "Until Mon 9 AM" (this week) or "Until Nov 16", short enough to keep the workspace beside it on a narrow sidebar. Its accessible name still says "Snoozed until" with the full time.
- *Toasts.* An IPC failure's toast shows the host's own message without Electron's "Error invoking remote method" prefix (`userFacingErrorMessage`). The toast's action button follows the small filled `Button`.
- *Snooze presets.* This evening's cutoff is covered at 4:59, 5:00 and 5:30 PM.
- *Host wake.* Needs approval and needs input are one waiting class, so a run moving from one to the other (answering an approval while its question still waits) keeps a snooze set during the wait; a failure or a new prompt still wakes it. A steer or follow-up sent into a snoozed chat wakes it too, through the same admission every send takes (`onPersonWrote`); a host notice and a refused send do not. The snooze timer re-arms in `finally` after a listener throws.
- *Deletes.* The startup roll-forward of a delete a crash cut short drops the chat's triage entry and read marker, through the same `forgetChatInboxState` the live delete uses.
- *Conflicts.* This Mac's store answers a stale `ifRevision` with `currentRevision` as well as its entry, like a paired host's `409`; `ChatTriageResult` documents both shapes.
- *Host feed cost.* A runs-observing device's waiting-run announcements are capped at half the journal by bytes as well as by count, so one resnapshot never expires another device's fresh cursor. A burst of reconnecting observers can still age a slow cursor out; that device resnapshots as usual.
- *Known limitation.* `attentionSummary` is per run, and a parent chat's row shows its own run's ask. A child (subagent) run waiting on the person rolls up into its parent's Needs you state, but its ask is not carried to the parent row.

**2a/2b round-3 fixes (2026-11-01).** A third pass settled:

- *Instant read with the action.* The placement rules are unchanged (unseen failed output still outranks Done and Snooze), so Mark done or Snooze on an unread failed run now counts its read at once: `useInboxTriage` keeps a per-row read-pending overlay (`readsPending`, applied by `withInboxReadsPending`) from the moment the person acts, so the row leaves Needs you before the host answers. The read itself is still sent only once the host takes the triage write (`act`'s `markRead`, which replaces `onWritten`). A write that fails or conflicts, or a read the host refuses or that names no message, drops the overlay so the row reads unread again, with an error toast for the read. The overlay goes once the row reads as read by itself (`settledInboxReads`), and output newer than the action still reads unread.
- *24-hour clocks.* The short snoozed status drops ":00" only on a 12-hour clock ("Until 6 PM"); a 24-hour locale keeps "Until 18:00".
- *Host.* A triage listener (the IPC broadcast) that throws after a committed write is logged and no longer fails the write, so a Remote retry with the same key doesn't read a false conflict.

**2c. Dock badge.**

- A main-process count of Needs you: local signals from `HostRunRegistry`, Bot `needsYou`, and unseen failures, plus remote Needs you from the `PeerHostManager` feed caches in main.
- Only online hosts count. Keys are host-qualified (`hostId:chatId`), so a chat seen through two paths counts once.
- macOS uses `app.dock.setBadge`, and Linux uses `app.setBadgeCount` where the desktop supports it. Add a `badgeCount` capability to `main/services/host-platform-capabilities.ts:35` rather than reusing `dockIcon`. Unpackaged builds keep their `DEV` badge (`main/index.ts:2210`) and show no count.
- A switch next to the sidebar cards, on by default while Inbox is the view.

**2c as built (2026-11-01).** Where it differs from, or settles, the text above:

- *Shared placement.* `inboxState`, `triageSignals` and the new `isLocalInboxChat` moved to `renderer/shared/inbox-state.ts`, and the feed-row readers (`peerFeedChatState`, `latestPeerRuns`, `reportedTriage`, `peerFeedBotAttention`) to `renderer/shared/peer-feed-inbox.ts`. The sidebar and main use the same code, so the badge and the Needs you section can't disagree. `renderer/lib/sidebar-inbox.ts` and `inbox-triage.ts` re-export it.
- *The count.* `inboxBadgeCount` (`main/services/inbox-dock-badge.ts`, pure) counts distinct Needs you rows: this Mac's listed chats (approvals and questions from `ChatActivityRegistry`, detached and interrupted waits from `pendingAttentionForChat`, unseen failures against the read markers), this Mac's Bots whose live projection reports `needsYou`, and each online paired host's summaries, runs and Bot rows (`needsYou` or `failed`, as the sidebar shows them). Keys are `host\0chat|bot\0id`. No chat counts as open, since no window may be: the chat being read is already read. A host counts only while it is connected, its status and feed are not stale, and the feed is for that host. Unreadable markers make nothing an unseen failure.
- *Done and Snooze.* The badge follows `inboxState` exactly, so a live approval or question on a snoozed or Done chat still counts, as it shows in the sidebar, and a failure that was read when it was marked Done does not.
- *Wiring.* `main/services/inbox-dock-badge-main.ts` reads the stores and `peekPeerHostManager()`, which never starts the peer supervisor, so the badge sends nothing to a peer. It recounts on change events only (one `onBroadcast` observer for chats, read markers, triage, activity, workspaces, Bots and peer feed and state, plus the chat index, workspaces and `HostRunRegistry`), debounced to 250 ms with one count in flight. There is no snooze timer, and none is needed: Done and Snooze never move a row out of Needs you (placement rules 1–3 come before rule 5), so an expiring snooze can't change the count. The badge still reads triage and recounts on `chats:triage-changed` so it keeps following `inboxState` exactly, should a later rule let triage reach Needs you; triage changes (a person's action, a paired device's write or a snooze ending) are rare, so the extra recount costs little. No network calls and no analytics.
- *Enablement.* The window reports `app:setInboxDockBadge(view === "inbox" && dockBadge && badgeCount)` (`useInboxDockBadgeSync` in `renderer/main/root-view.tsx`); the latest report wins and main stays off until one arrives. The badge stays when every window closes. Switching it off, or leaving the Inbox, clears it at once.
- *Switch.* `SidebarPreferences.dockBadge` (default true), shown under the view cards in Settings → Appearance → Sidebar only while Inbox is the view. It reads "Show Needs you count on the Dock icon" on macOS and "on the app icon" on Linux.
- *Platforms.* `badgeCount` is a new `HostPlatformCapabilities` field (macOS and Linux). macOS writes `app.dock.setBadge(String(n))` and clears it with `""`; Linux calls `app.setBadgeCount(n)`, which only Unity-launcher-API docks show. Unpackaged builds register the IPC handler but start no driver, so their `DEV` badge stays and no count shows.
- *Deliberate scope.* A failed run's unseen output counts even when its chat is open in a hidden or minimized window, since nobody is reading it there (main never treats a chat as open). The sidebar's machine filter is a view-only filter and the badge ignores it: Needs you rows on a machine the filter hides still count. People still on the legacy Needs attention view read as Inbox (`parseSidebarPreferences` maps a stored `"attention"` to `"inbox"`), so they get the badge on by default, as intended. A Bot with no open chat whose transcript can't be read still counts when it waits on the person (an open question, hand-off, approval or issue), while the host feed, built from `summary`, sends that Bot's row without `needsYou`: the person does owe it an answer.
- *Review fixes.* Bots are counted with `BotLiveProjection.needsYou(botId)`, the summary's `needsYou` without the transcript read (an open question, hand-off, approval or issue; never an unavailable Bot with no open feed), because a recount runs up to four times a second while a chat streams. `app:setInboxDockBadge` is registered in `main/index.ts` and, like `app:setDockIcon`, ignores any sender but the main window. A count that keeps failing the same way (a chat index over 10,000 entries or 16 MB, say) keeps the last badge and is logged once until a count works again, as is the Bot attention read; a renderer whose report is refused logs once per window.
- *Tests.* `main/services/inbox-dock-badge.test.ts` (aggregator, platform surfaces and the debounced driver, in `test:sidebar`), the switch in `sidebar-view-picker.test.tsx`, the preference in `sidebar-organization.test.ts`, and the capability in `host-platform-capabilities.test.ts` and `app-capabilities.test.ts`; `needsYou` agreeing with the summary with and without an open feed, and without a transcript read, in `bot-runtime/live-projection.test.ts`; the main-window-only request in `inbox-dock-badge.test.ts`.

**2d. `aiden serve` hosts.** The CLI doesn't serve `GET /host/events`, which is what the desktop reads, and has no `HostRunRegistry`, read markers or activity snapshot (`packages/cli/src/remote-chats.ts:67-76`). 2d adds all four, then the chat-summary read with row state, unread and the `inbox-signals-v1` fields. A paired CLI host's chats then appear in the desktop sidebar and Inbox. Update `packages/cli/README.md`.

**2d as built (2026-11-01).** Where it differs from, or settles, the text above:

- *Shared code, no copies.* The feed's read moved from `aiden-remote-service-main.ts` into `main/services/aiden-remote-host-feed-source.ts` (`createAidenRemoteHostFeedSource`: summaries, workspaces with their cached repository identity, and Bot rows in both audience shapes), and `markChatRead`'s body into `markChatReadThrough` (`main/services/chat-read-markers.ts`). The desktop and `aiden serve` call the same functions. The CLI also builds `AidenRemoteHostFeedService`, `AidenRemoteHostRunService`, `HostRunRegistry` with `createHostRunRecorders`, `ChatReadMarkerStore`, `ChatTriageStore`, `wakeTriageOnAttention` and `liveRunAttention` straight from `main/services`.
- *Runs.* `packages/cli/src/daemon-chats.ts` keeps a `HostRunRegistry`: a run begins at the turn hand-off, every stream event is recorded, an approval is raised in `ChatActivityRegistry` (so `rowState`, `attentionSince` and `run.state` see it) and resolved as allowed, denied, expired or cancelled, and the run settles on release. Host run control stops any run (`cancelRun`) and answers an approval through the stream that raised it, or straight to the daemon (`approveAsHost`) when no Remote stream owns it.
- *Feed invalidation.* `packages/cli/src/remote.ts` wires the feed to the chat activity registry, the chat index, read-marker and triage changes, workspace config saves (`onWorkspacesChanged`) and run changes. The feed is closed on `stop()`, and revoking a device drops its feed and run-stream subscriptions.
- *Inbox stores.* Read markers and triage live in the CLI data dir (`chat-read-markers.json`, `chat-triage.json`). The unread baseline is stamped when the daemon's Remote chats are first created, so older replies never read as unread. The snooze timer (`triage.start()`, re-checked at least every 60 s, unref'd) and the early wake on attention start with Remote and stop with it. Deleting a chat drops both entries through `inboxState`. A Remote turn wakes a snooze through the shared chat service, as on the Mac.
- *Gaps.* CLI Bot rows carry no `needsYou`, `failed` or `lastReplyAt`, because the CLI has no `BotLiveProjection`, so its Bots show in a desktop's Inbox only while open. A Bot edit reaches the feed only with the next other change, because the CLI has no Bot change hook. CLI runs take no questions or run input (`answer` is `rejected`, `admitInput` is `run_not_active`). Desktops paired to a CLI host before 2d don't need to pair again: they pick up the host grants on their next connection after Aiden starts (relaunch Aiden if already connected), through the automatic `POST /device/capabilities` negotiation. There is no wake or unlock re-check of snoozes, only the timer. The protocol revision stays 48.
- *Tests.* `packages/cli/tests/inbox-host.test.mjs` pairs a desktop over HTTPS and checks the feature tokens, the `/host/events` snapshot and its `chat.upsert` and `run.state` frames (with `attentionSummary`), a `needs_approval` row with `attentionSince` and `runStartedAt`, approving through `/runs/{runId}/approvals/{id}/respond`, unread and `POST /chats/{id}/read`, idempotent triage with `409 revision_conflict`, and that both survive a restart.
- *Review fixes.* A paired desktop shows Steer on a host's run only when the host also advertises `chat-run-input-v1`, and question answers only with `chat-question-prompts-v1` (`remoteHostCapabilities`); the desktop always advertises both, the CLI neither, so a CLI run offers Stop and approvals only. CLI host run control refuses an approval `scope` other than `once` with `400 invalid_request`, since the daemon keeps no remembered approvals. `aiden remote revoke` also drains the device's Bot session streams, before and after the revocation fence, as the desktop does. Phones paired to the CLI keep `phone-run-control-v1` and `chat-read-state-v1`; iOS and Android offer no Steer on a foreign run and gate their own run input on `chat-run-input-v1`, so no client change was needed. Tests: `peer-remote-chat-control.test.ts` (a host without the two tokens keeps Stop and approvals, refuses Steer before sending), and a second `inbox-host.test.mjs` case: a Mac paired with legacy grants is offered the host grants, is refused `/host/events` and `/runs/*` with `403 capability_denied` until `POST /device/capabilities`, then opens the feed; a phone hears the phone run subset, approves a foreign run, and has an `always` scope refused; revoking the Mac ends its feed and run stream.

**Phase 2 edge cases.**

- *Clock skew.* Host times are shifted by the offset from `GET /server` `serverTime`. Durations stay `max(0, …)`.
- *Snooze time zones.* Presets resolve on the device that acts, in its time zone, and are sent as absolute RFC 3339 times. Main sets one timer at the earliest `snoozedUntil` and re-arms it after each wake.
- *Undo.* Undo sends `ifRevision`. If another device changed the chat since, Undo does nothing and the toast says so.
- *Many hosts.* A multi-chat action sends one request per host. Triage is disabled for a host under `hostControlRefusal`. Writes to a peer do not go through `peer-intent-store` (see "2a as built"): `RemoteHostAdapter.setTriage` retries once with the same `Idempotency-Key` after an `outcome_unknown`, and a write that never landed is re-done by the person.
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

*3a as built (2026-11-01).* Built on the plan branch, at revision 48 with 2b, under `inbox-signals-v1` (no new token; phones decode the optional fields without it).

- `hostInboxPlacement` in `renderer/shared/inbox-state.ts` wraps `inboxState`. It runs with the row counted as not open (the host can't know a viewer's open chat), the host online, no recent window (an old read chat is `earlier` and the client ages it out), and no `attention` (a detached or interrupted prompt is retried only in the host's own window).
- A row `inboxState` hides becomes `done` (Done wins when both hold) or `snoozed`, with the sort time of its awake placement, as search lists it.
- `freezeSummaryPage` in `main/services/aiden-remote-chats.ts` computes both fields for `GET /chat-summaries` and the host feed, so the CLI build serves them unchanged.
- Unread is per host (the host's read markers), not per device.
- The Needs you tier is not sent; clients read it from `rowState`.
- The desktop parser drops a bucket it can't use with its sort time: an unknown or non-string bucket, a missing or malformed sort time, or a sort time alone. Newer hosts can add buckets, and a buggy one can't break a peer's page parse.
- The desktop peer client keeps placing peer rows from the raw signals and ignores the bucket.
- Tests: the summaries suite places every kind of row through the real service (including a snooze that lapses on the host clock, Done and Snooze held together, a question, and a snooze under a failure or a live run), the parser cases, the protocol fixture test recomputing both fixture buckets with `hostInboxPlacement`, iOS and Android tolerance tests carrying both fields, and `packages/cli/tests/inbox-host.test.mjs` reads `needs_you`, `updates`, `earlier`, `pinned` and `done` from `aiden serve`.

**3b. iOS and Android Inbox.**

- An Inbox option in each platform's workspace sidebar projection.
- iOS drops `aidenNeedsAttentionFirst` (`ios/…/Models/AidenChat.swift`) in favour of the host bucket. Android does the same (`AidenChatRowStatus.kt`). Both keep a local fallback for older hosts.
- Swipe actions: leading Mark read, trailing Done and Snooze.
- Optimistic, with skeletons, per the owner's phone rule.
- Android uses the M3 Expressive layer and is checked on a headless AVD.

*3b as built, iOS (2026-11-01).* Built on the plan branch; Android is still to do. No new token or revision.

- `AidenWorkspaceSidebarOrganization.inbox` ("Inbox", Beta badge in the heading and the menu) is stored per device with the other views. Workspaces and Recents now sort plainly by recency, as on the desktop; `aidenNeedsAttentionFirst` is gone.
- `ios/AidenOnTheGo/Models/AidenInbox.swift`: `AidenChatInboxSignals` decodes `inboxBucket` with `inboxSortAt` only as a pair, field by field, so an unknown bucket, a lone or malformed sort time, or a malformed sibling field drops the pair and keeps the row. The summary cache keeps the signals, and a detail reconcile keeps them but drops the host placement, since the row has changed under it.
- `AidenInbox.placement` uses the host bucket, rechecked on the phone's clock: the open chat leaves Updates and the failed Needs you tier, a `snoozed` row past `snoozedUntil` falls back to local placement, a row state that disagrees with the bucket (a live approval, question or run the bucket doesn't show) wins, and Earlier ages out after seven days. With no usable pair it runs a local port of `inboxState` from the same signals. The Needs you tier (approval, question, failed) always comes from `rowState`. `AidenInboxProjection` orders sections Needs you, Pinned, Updates, Earlier (20, then **Show more**), Working last, and searches title and workspace.
- Rows (`Features/Remote/AidenInboxViews.swift`): unread dot, title, workspace, a status (Approval or Question warning pill, Failed danger pill, "Working 6m", Done, "Until Mon 9:00 AM") and the wait. VoiceOver reads "title, workspace, status, wait, Unread" and gets the swipe actions as named actions, offered only when they apply.
- Swipes: leading **Mark read** (`chat-read-state-v1`, unread rows); trailing **Done** and **Snooze** (`chat-triage-v1` and `chat:write`, never on a Needs you or Working row). Snooze offers 1 hour, this evening (18:00, only while more than an hour away), tomorrow 09:00 and next week (Monday 09:00, at least two days away). `AidenRemoteClient.setChatTriage` sends only the changed fields with an `Idempotency-Key` and `ifRevision` (the row's `triageRevision`, else 0). Each change applies at once with a top banner and Undo; a refusal puts the row back and says so, and `409 revision_conflict` also reloads. Done on an unseen failure also marks it read, as the desktop does.
- Loading shows the shared skeleton rows; an empty Inbox reads "All Caught Up".
- **Gap: hosts announce `chat-triage-v1` to paired desktops only**, so against today's Mac and `aiden serve` a phone shows Mark read but not Done or Snooze. Announcing it to phones (with `chat:write`) is a host change for a later PR; the phone already handles it.
- **Gap: no UI test target.** The plan's swipe UI tests are covered by unit tests of the actions' gates, the optimistic change and its undo, and the triage request, plus simulator screenshots from a Debug-only `-AidenInboxFixture` launch argument that renders the same rows, headings and swipes from fixture chats.
- Tests: `AidenInboxTests` (local placement table, open-chat recheck, host bucket used and rechecked, snooze waking on the phone's clock, Earlier ageing out, projection order and cap, search, optimistic Done and Snooze, snooze presets, row status and VoiceOver name) and `AidenRemoteClientTests` (bucket decode, unknown or malformed bucket falling back, cache and reconcile, the triage request and its conflict).

*3c as built, iOS (2026-11-01).* `AidenWorkingIndicator` is the desktop's ring (three quarters of a circle at 60% opacity, one turn per 1.5 s) on chat rows and the Working shelf; under Reduce Motion it holds still and the row still says Working.

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
