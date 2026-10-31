# Inbox Sidebar

Status: Planned (2026-10-31). The owner picked Option D (Hybrid Inbox) and accepted every recommended decision. Nothing is implemented yet.

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
| Aiden today | Needs-attention tiers (`SIDEBAR_ATTENTION_TIERS`, `sidebarAttention` in `renderer/lib/sidebar-organization.ts`). Honest unread and failed markers (Remote revisions 18 and 36). Remote rows (`remoteSidebarRows` in `renderer/lib/sidebar-remote-groups.ts`). Bot `needsYou` (`renderer/main/bots/bot-sidebar.tsx`). First-responder-wins run approvals over Remote. | Hand-written phone sorts (`aidenNeedsAttentionFirst` on iOS and Android) once the host can send the bucket. |

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| D1 | Shape | Option D, Hybrid Inbox: "Needs you", Updates, Earlier, and a Working shelf pinned to the bottom. |
| D2 | Default | **By workspace** stays the default. Inbox is opt-in and labelled Beta. |
| D3 | Where the switch lives | In both Settings → Appearance → Sidebar (cards) and the sidebar's Organize menu → View. Both edit one stored value (see "One stored view"). |
| D4 | Approvals and questions | They get their own "Needs you" section on top. |
| D5 | Acting from a row | Rows carry no Approve, Deny, Reply or Open Bot buttons and no request preview, which keeps every row two lines tall. A Needs you row shows a coloured status (Approval, Question, Failed, or Needs you for a Bot) and how long it has waited; the pending command or question is only in the row's tooltip. Clicking the row opens the chat or Bot, and the person approves, denies or answers there. |
| D6 | Triage | Mark read ships in Phase 1. Done, Snooze and Pin ship in Phase 2. |
| D7 | Running chats | A collapsible Working shelf pinned to the bottom, ordered by when each run started. |
| D8 | Bots | A Bot appears only when it needs the person, a run failed, or it has an unread reply. This amends the unified sidebar plan's "Bots do not enter the outline" rule; the amendment applies only to the Inbox view. |
| D9 | `aiden serve` hosts | Later. Not in Phase 1. Phase 2 adds the host feed they need. |
| D10 | Phones | Phase 3. The host computes `inboxBucket` so iOS, Android and desktop agree. |
| D11 | Dock badge | Phase 2, driven by a main-process count. |

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
  isOpen: boolean;                 // the chat in the main pane
  updatedAt: number;
  lastAssistantAt?: number;
  attentionSince?: number;         // Phase 1: first time this window saw it; Phase 2: from the host
  runStartedAt?: number;           // Phase 1: first time this window saw it working; Phase 2: from the host
  pinnedAt?: number;               // Phase 2
  doneAt?: number;                 // Phase 2
  snoozedUntil?: number;           // Phase 2
}

type InboxShelf = "needs_you" | "pinned" | "updates" | "earlier" | "working" | "hidden";

inboxState(signals, now, recentWindowMs) → { shelf, tier, sortAt }
organizeInbox(rows, now, options) → { needsYou, pinned, updates, earlier, working, hiddenCount }
```

### Placement rules, in order

1. **`needs_approval` or `needs_input`** → Needs you, tier 0 or 1. These override Done and Snooze: an approval wakes a snoozed chat.
2. **An unread failed run** → Needs you, tier 2. This matches the existing `failed` tier in `sidebarAttention`, and it also wakes a snoozed chat.
3. **`working`** → the Working shelf.
4. **Done** with no newer output → hidden. Output newer than `doneAt` brings the chat back. A snooze that hasn't expired → hidden.
5. **Pinned** → Pinned (Phase 2).
6. **Unread** → Updates.
7. **Read and idle, active within `recentWindowMs`** (default 7 days) → Earlier. Earlier shows 20 chats, then **Show more**. Anything older is reached through search or the other views.

The open chat never counts as unread (existing rule). It keeps its place while it is open.

### Ordering

| Section | Order |
| --- | --- |
| Needs you | By tier, then by `attentionSince`, oldest first. The longest wait blocks the most work. |
| Pinned | By `pinnedAt`, newest first. |
| Updates | By `lastAssistantAt`, newest first. |
| Earlier | By `updatedAt`, newest first. |
| Working | By `runStartedAt`, oldest first. |

Ties fall back to the chat id, so the order is stable.

### Freeze while the list is in use

While the pointer is over the list or focus is inside it, rows keep their positions:

- New rows still appear, added to the end of their section.
- State changes update a row's badge but don't move the row.
- The held-back moves apply when the pointer and focus leave the list.
- An action the person takes, such as opening a row or Mark read, places that row at once.

Moves animate with FLIP for 150 ms, capped at 40 px. There's no animation under Reduce Motion or when more than 40 rows move at once.

## Phase 0 — Split the sidebar (no behaviour change, 1–2 PRs)

`renderer/components/chat-sidebar.tsx` is 2,023 lines. Inbox needs its row and section parts on their own.

**0a. Extract shared pieces** into `renderer/components/sidebar/`:

- `chat-row.tsx`: title, `ChatRowStatus`, context glyphs, shortcut kbd, and the ••• menu.
- `row-group.tsx`: disclosure group.
- `section-header.tsx`: label, count, and an optional collapse control.

`chat-sidebar.tsx` keeps state, data reads and view switching.

**0b. One row for local and remote chats.** `remoteSidebarRows` output renders through the same `ChatRow`. Remote rows gain the ••• menu, limited to actions the Remote API already supports (Open, Mark read, Rename where `chat:write` is granted). This is the only visible change in Phase 0, and the PR description calls it out.

**Tests.** `renderToStaticMarkup` tests for `ChatRow` cover these behaviours, without locking class strings:

- a status pill per row state;
- the unread dot hidden on the open chat;
- a remote row's host marker and menu items;
- `aria-busy` only while Working.

The existing sidebar Playwright specs must pass unchanged.

**Docs.** None outside `.memory/`. This is a refactor.

## Phase 1 — Inbox on the desktop, renderer first (no Remote revision, 3–4 PRs)

**1a. The model.**

- `renderer/lib/sidebar-inbox.ts` with `inboxState` and `organizeInbox`.
- `"inbox"` added to `SIDEBAR_VIEWS`, and the `"attention"` migration in `parseSidebarPreferences`.
- The `useSidebarView()` store.
- Fixture-based tests in `renderer/lib/sidebar-inbox.test.ts`. Each placement and ordering rule gets its own hand-written expected order (an independent oracle). The tests also cover snooze wake-ups, Done coming back on new output, and tie stability.

**1b. The Inbox view.**

- Sections: Needs you, Updates, Earlier, plus the Working shelf. The shelf is collapsible, takes at most 40% of the sidebar height, scrolls on its own, and remembers whether it is collapsed.
- Compact two-line rows, sized like OpenCode's Inbox: the whole row is one button with 6 px block padding and a 2 px gap; line 1 is 16 px tall in 12 px quaternary text (`project · Mac`, then the status or age at the end); line 2 is the title, 13 px on a 16 px line, medium weight when unread. Rows come out about 46 px. Section headers are 24 px. The Mac part appears only when paired Macs exist. Working rows dim to 75% opacity and show `Working {duration}`.
- Status text in Needs you uses the soft semantic colours: Approval and Question in warning, Failed in danger. The tooltip carries the pending command, question or failure reason (from `ChatActivityRegistry` for local chats, the Remote summary for remote chats).
- Freeze-while-in-use, and the FLIP rules above.
- Empty state: "Nothing needs you".
- Keyboard: the existing F6 and arrow-key sidebar navigation, plus ⌘1–9 over the visible rows in display order, remote rows included (`renderer/lib/sidebar-chat-shortcuts.ts`).

**1c. Opening from a row.**

New desktop-only IPC, `chats:pendingAttention`, returns for each chat `{ kind, summary }` for the status label and tooltip. The summary is capped at 200 characters and never includes file contents. Rows never send an approval or an answer.

- **Open.** Clicking a row, Enter on a focused row, or ⌘1–9 opens the chat or Bot. A chat waiting on an approval or a question scrolls to that card and focuses its first control, so Approve, Deny and the answer field are one keystroke away. Approve, Deny and Always allow keep their existing rules in the chat, for local and remote chats alike.
- **Mark read** uses `chats:markRead` for local chats and `POST /chats/{chatId}/read` with `throughMessageId` for remote chats. It is available on Updates rows and from the ••• menu.

**1d. Bots, Settings and docs.**

- **Bots in the Inbox.** A local Bot shows in Needs you when `needsYou`, and in Updates when it has a failed run or an unread reply. The row says it is a Bot, and opening it goes to the Bot. Remote Bots wait for Phase 2.
- **Settings → Appearance → Sidebar.** Radio cards for By workspace, Recent only and Inbox (Beta), following the `ChatWidthPicker` pattern and `docs/settings-design-system.md`. Selection uses the list-selection fill, never a border, and keyboard focus uses the neutral ring.
- **Docs:**
  - `README.md` and `PRODUCT.md`: the Inbox view.
  - `docs/settings-design-system.md`: the "Chat width is the one Appearance layout preference" line, plus a new "Sidebar" section.
  - `docs/plans/README.md`: the status row.
  - `docs/design-guide.md`: the compact Inbox row and its hover-icon overlay.

**Phase 1 tests.**

- `sidebar-inbox.test.ts`.
- A render test for the Inbox sections, the status labels and the tooltip, and that Needs you rows render no action buttons.
- A register-and-invoke test for `chats:pendingAttention` (it refuses unknown chat ids and caps summary length).
- A Playwright spec run through `npm run test:e2e:space`: switch to Inbox, a chat asking for approval appears in Needs you, clicking the row opens the chat with the approval card focused, Approve there moves the chat to Working, and ⌘1 opens the first row.
- Each new file is registered in `package.json` and `scripts/ci-test-registry.json`, then `npm run test:ci-policy` is run.
- Screenshots of every new surface in light and dark go to the owner before approval.

**Exit.** The owner uses the Inbox daily for a week, with no row jumping under the pointer and no opened chat that lands somewhere other than its pending card.

## Phase 2 — Triage and reach (Remote revision 48, additive, 3–4 PRs)

Claim the revision after the one on `main` at merge time. It is 47 today (`AIDEN_REMOTE_SPENDING_LIMITS_CONTRACT_REVISION`).

**2a. Done, Snooze and Pin, stored on the host.**

- A new `ChatTriageStore` (`userData/chat-triage.json`), modelled on `ChatReadMarkerStore`. Triage changes never rewrite the chat index or bump a summary revision. It is bounded, and it broadcasts `chats:triage-changed`.
- Desktop IPC `chats:setTriage`, and Remote `POST /chats/{chatId}/triage` (`chat:write`, `Idempotency-Key`). The body is `{ pinned?, done?, snoozeUntil? }`.
- Snooze presets: 1 hour, This evening (18:00), Tomorrow (09:00), Next week (Monday 09:00). An approval, a question or a failed run wakes the chat early.
- Undo: a 5-second toast. Repeated actions merge into one toast ("3 chats marked done · Undo").

**2b. Inbox signals (`inbox-signals-v1`).**

- Summary rows gain optional fields: `attentionSince`, `runStartedAt`, `lastAssistantAt`, `pinnedAt`, `doneAt` and `snoozedUntil`. They replace the window-local guesses from Phase 1.
- Bot list summaries gain `needsYou`, and remote Bot rows join the Inbox. They need `bot:issues` (revision 42) for the failed state.
- iOS, Android and `protocol/aiden-remote/v1/fixtures/contract.json` are updated together, with parsers that ignore the fields on older hosts.

**2c. Dock badge.**

- A main-process count of Needs you: local signals from `ChatActivityRegistry` and unseen failures, plus the peer-host count the renderer already reads (`app:setInboxPeerCount`).
- macOS uses `app.dock.setBadge`, and Linux uses `app.setBadgeCount` where the desktop supports it. Gate both through `main/services/host-platform-capabilities.ts`.
- A switch next to the sidebar cards, on by default while Inbox is the view.

**2d. `aiden serve` hosts.** `packages/cli` serves the chat-summary read with row state, unread and the `inbox-signals-v1` fields. A paired CLI host's chats then appear in the desktop sidebar and Inbox. Update `packages/cli/README.md`.

**Phase 2 tests.**

- `ChatTriageStore` resilience: corrupt file, bounds, markers that only move forward.
- Parser and route tests for `/triage`: idempotent replay, `chat:write` required.
- Fixture contract tests on desktop, iOS and Android.
- A dock-count aggregator unit test.
- A Playwright check that Snooze hides the chat and an approval brings it back.

**Phase 2 docs.**

- `docs/aiden-remote-api-v1.md`: a new revision section.
- `docs/aiden-on-the-go-remote-access.md` and `docs/linux.md`: the badge.

## Phase 3 — Phones and onboarding (2–3 PRs)

**3a. Host-computed bucket.** Summary rows gain `inboxBucket` (`needs_you`, `pinned`, `updates`, `earlier`, `working`, `snoozed` or `done`) and `inboxSortAt`. Both come from the same `inboxState` code in `renderer/shared/`, so the CLI build shares it. This is additive, so it shares 2b's revision if both merge together, or claims the next one otherwise.

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
| Rows moving under the pointer | Freeze-while-in-use, capped animation, and a Playwright check that moves are held back. |
| Phase 1 times are window-local guesses | Labelled as such in code. Phase 2 replaces them with host times. Ordering degrades to `updatedAt`, never to a wrong section. |
| Large hosts (up to 2,000 chats each) | `organizeInbox` is linear plus one sort per section, memoized on the inputs. Earlier is capped at 20 with Show more. |
| Bots leak into workspace views | The D8 amendment is limited to the Inbox view. The workspace and recent projections keep excluding Bot homes, and existing tests stay. |
| Two places to switch the view disagree | One stored value through `useSidebarView()`. |
| Remote revision collisions | Claim at merge, and update iOS, Android and fixtures in the same PR. |

## Amendment to the Unified Workspace Sidebar plan

The Inbox view may list Bots, but only while they need the person, have an unseen failed run, or have an unread reply. Bot rows open the Bot, never a workspace chat. The By workspace and Recent only views are unchanged.
