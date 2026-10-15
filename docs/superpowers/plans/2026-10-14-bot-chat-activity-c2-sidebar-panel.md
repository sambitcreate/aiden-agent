# Bot chat activity · Slice C2 (Bots sidebar and Bot side panel, desktop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On any `/bots` route the left sidebar lists only Bots (back, Search, New Bot, a pinned Bot, rows with working faces, "Needs you" and unread dots, Bots on paired Macs, profile and Connect apps), `/bots` opens the most recently used Bot's chat instead of a list page, and a Bot chat gets a side panel on the C1 `WorkbenchPanel` with Activity, Files, Memory and Routines tabs, opened from a header toggle, the `environment.toggle` shortcut, file chips and the ••• menu.

**Architecture:** Pure helpers own the rules: `renderer/lib/bot-routes.ts` (which surface a path is on, where ‹ goes back to, what the toggle shortcut acts on) and `renderer/lib/bot-sidebar-preferences.ts` (the per-device pin and last-viewed record). Main adds `needsYou` and `lastReplyAt` to the existing `bots:live:summary` and broadcasts `bots:attention` when a question or approval appears or settles. The renderer adds a `BotPanelProvider` (open state, tab, file request, focus hand-off) at the root next to `EnvironmentPanelProvider`, a `BotWorkbench` that mounts the C1 `WorkbenchPanel` beside the Bot chat with fixed Bot tabs, one shared live subscription per Bot (`BotLiveProvider`) so the chat and the Activity tab never fight over `bots:live:subscribe`, one shared ••• menu (`BotMenuItems`), and a `BotSidebar` that `ChatSidebar` renders on Bots paths. The workspace Environment surfaces are suppressed on Bots paths, so their open state and tabs come back untouched.

**Tech Stack:** Electron main (Node), React 19 + TanStack Router/Query, Radix menus via `renderer/components/ui`, lucide-react, `node:test` via `tsx --test`, Testing Library on happy-dom (`renderer/main/bots/test-dom.ts`), Playwright Electron e2e (`tests/e2e`).

**Spec:** [`docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md`](../specs/2026-10-14-bot-chat-activity-design.md): §2 decisions 5, 6, 10, 12; §4 slice C2; §8; §9; §10 (••• menu); §14; §15; §16.

**Slice plans (linear stack A → B → C1 → C2):** A ([quick fixes](2026-10-14-bot-chat-activity-a-quick-fixes.md), implemented), B ([status line](2026-10-14-bot-chat-activity-b-status-line.md)), C1 ([workbench shell](2026-10-14-bot-chat-activity-c1-workbench-shell.md)), C2 (this), D (phones).

## What this plan consumes from B and C1 (exact names)

- **C1** (`renderer/components/workbench-panel.tsx`): `WorkbenchPanel<T extends WorkbenchTab>(props: WorkbenchPanelProps<T>)`, `interface WorkbenchTab { id; viewId; label; icon?; selected; closable?; title?; onRename?; editor?; wrap?; dataAttributes? }`, `interface WorkbenchView { id; render(context: { presented; selected; width }) }`, `useWorkbenchWidth(storageKey): WorkbenchWidthState` (`preferredWidth`, `setPreferredWidth`, `commitPreferredWidth`, `resizing`, `setResizing`). Layout: `resolveEnvironmentPanelLayout(preferredWidth, containerWidth): { width; inline }` in `renderer/lib/environment-panel-layout.ts`. `EnvironmentWorkbench({ suppressed })` keeps Quick View, the device mini player and its Escape handler off while suppressed.
- **B** (`renderer/shared/bot-live.ts`): `BotTranscriptToolCall { id; name; kind: BotToolPhase; label; detail?; app? }`; the `tool_result` entry's `status: BotToolResultStatus` (`"ok" | "failed" | "blocked"`); snapshots carry `activity` and `queued`. (`main/services/bot-runtime/live-projection.ts`): `BotLiveProjectionDeps.approvalPending?(botId)` and the inner `waitingOn(botId)` helper of `createBotLiveProjection`; `botApprovals.onChange` is already wired in `bot-session-main.ts`. (`renderer/main/bots/bot-activity-steps.ts`): `BotRecapStep`, `botStepLine(step) → { text; detail?; tone: "normal" | "warning" | "error"; active }`. (`renderer/components/bot-avatar.tsx`): `BotAvatar` prop `working?: boolean` (root gets `data-working`). `agent-thinking-shimmer` animates only under `data-reduce-motion="false"`.

## Rulings on spec ambiguities

1. **Where the panel lives.** §8 says "on `/bots/$botId`", and the toggle "sits in the Bot chat header". The panel mounts on the chat route `/bots/$botId/chat` only. Profile and its sub-pages stay full pages (Profile → Memory stays, §8). ••• Files/Memory/Routines from anywhere open that Bot's chat with the panel on that tab. `environment.toggle` toggles the Bot panel in a Bot chat, does nothing on other Bots pages, and keeps today's behaviour everywhere else.
2. **Remote Bots go in the Bots sidebar**, under an "On {Mac}" group below this Mac's Bots, as compact rows that open the host chat exactly as today. Why: the `/bots` main area no longer has a list, the sidebar is now where every Bot is listed, a remote Bot's state lives on that Mac (no panel, no pin, no unread, §13), and opening one navigates to `/host/…`, which is not a Bots path, so the normal sidebar returns there. Search filters them too. The accessible contract of `RemoteBotsSection` (headings, button names, disabled reasons, `aria-busy`) is unchanged.
3. **"Most recently used Bot"** = the Bot last viewed on this Mac (per-Bot last-viewed preference) when it still exists, otherwise the Bot with the newest activity (the sidebar's first row). The redirect replaces the history entry.
4. **Unread baseline.** The preference record stores `since`, the time it was first created. A Bot never viewed on this Mac is unread only if a reply arrived after `since`, so the first launch after updating does not light up every Bot. The open Bot never shows a dot. Viewing a Bot's chat marks it viewed.
5. **Pinned Bot** appears only as the hero, not also as a row. While searching, the hero is hidden and the pinned Bot is filtered like any row. Deleting the pinned Bot clears the pin. Pruning runs only on a successful, non-empty Bot list, so a transient empty read cannot drop the pin.
6. **Footer "profile photo".** Aiden's `Profile` has only a name, so the footer shows the name's initial in a neutral circle (a `UserRound` glyph when empty) and opens `/profile`. **Connect apps** opens Settings → Plugins (`/settings?section=mcp`), where connections are set up.
7. **Back and Search.** ‹ ("Back to Aiden") returns to the last chat-shell page outside Bots this session (default `/`). The Search button reveals a search field and focuses it; Escape clears it, a second Escape closes it.
8. **Chat header.** The "All Bots" back button leaves the Bot chat header (the sidebar now holds the list). Profile's back reads "Chat" and returns to that Bot's chat.
9. **"Memory updated"** opens the panel's Memory tab, like ••• Memory.
10. **Row line.** Running and not waiting: "Thinking…" in shimmer. Waiting on an approval or question: "Waiting for you" (no shimmer) plus the "Needs you" badge. Otherwise the paused / needs-model / unavailable status, else the last message preview. Rows show no time.
11. **Activity tab** lists every step unmerged (questions included), grouped by the message or routine that started the reply, newest reply first, steps oldest first within a reply. Replies without steps are left out. A step still "running" in a reply that is not the live one reads as failed, as in B's recap. Data comes from the live snapshot's transcript entries; no new IPC.
12. **Panel defaults.** First open lands on Activity. Open state, tab and width persist per device under `aiden-agent.bot-panel.*`, never under `aiden-agent.environment.*`. Tabs are fixed (`closable: false`) and there is no "+".
13. **Quick View** (`quick-view.toggle`) does nothing on Bots pages, since its surface is suppressed there.

## Global Constraints

- Contract change is **Desktop IPC only** (§4): `BotLiveSummary` gains `needsYou: boolean` and `lastReplyAt: number | null`; a new main → renderer notification `bots:attention` `{ botId }` is added to `NOTIFICATION_CHANNELS`. No Remote route, wire field, feature token or protocol revision changes. iOS, Android and `packages/cli` are untouched.
- Pin and last-viewed are desktop UI preferences in `localStorage` under `aiden-agent.bots-sidebar.v1` (`{ version: 1, since, pinnedBotId, lastViewed }`), never part of `BotDefinition`, never synced to phones (§13). One pinned Bot at most.
- Bot panel keys: `aiden-agent.bot-panel.open`, `aiden-agent.bot-panel.tab`, `aiden-agent.bot-panel.width`. The `aiden-agent.environment.*` and `aiden-agent.quick-view.open` keys are never written from a Bots page.
- DOM: the panel is `id="bot-panel"`, `aria-label="Bot panel"`, tab strip `aria-label="Bot panel views"`, tab ids `bot-panel-<tab>-tab` / `-panel`, resize separator "Resize Bot panel", Close "Close Bot panel" with title `Close panel (${environment.toggle shortcut})`. The header toggle carries `data-bot-panel-toggle`, `aria-controls="bot-panel"`, `aria-pressed`, and reads "Show panel" / "Hide panel".
- ••• menu order everywhere on desktop (chat header, row hover, right-click, pinned hero): Profile, Files, Memory, Routines, Advanced, Pin to top | Unpin, separator, Delete Bot.
- Copy, exact: "Back to Aiden", "Search Bots", "New Bot", "Pinned Bot", "Your Bots", "Needs you", "Unread", "Thinking…", "Waiting for you", "No Bots yet", "No matching Bots", "Your Bots couldn’t be loaded", "Try again", "Connect apps", "Profile", "Activity", "Files", "Memory", "Routines", "No activity yet", "All files", "Pin to top", "Unpin", "Chat".
- Memory uses `MemoryCardIcon`. Never a brain icon or illustration.
- UI rules (AGENTS.md, `GUI.md`, `docs/design-guide.md`): shared `Button` primitives, semantic tokens only, status in soft fills (`Badge color="warning"`), no decorative borders or outlines on badges, rows or cards, every non-text control keeps a `focus-visible` ring, the search field gets no accent border on focus (use the shared `Input`). Before writing Tasks 7 and 10, read `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` and adapt, not copy.
- Motion: faces and marks freeze under Reduce Motion and off-screen (B's `BotAvatar`); shimmer only via `agent-thinking-shimmer`.
- No network calls are added.
- Tests are behavioural (AGENTS.md): no `readFileSync`/`assert.match` on production source, no class-string or snapshot assertions. Every new test file goes in `package.json` `test:bots` **and** the `renderer-other` lane of `scripts/ci-test-registry.json`; deleted test files leave both. `npm run test:ci-policy` must pass after each task that touches registration.
- Keep `renderer/main/chat-layout.tsx`'s `(pathname.startsWith("/bots") && !params.chatId)` expression unchanged (an existing source-grep in `renderer/main/bots-view.test.tsx` reads it; do not add new greps).
- Known pre-existing failure, out of scope: `renderer/lib/inline-metadata-hierarchy.test.ts` ("secondary menu suffixes…") already fails on this branch because it greps `bots-view.tsx` for markup that moved in slice A. Do not "fix" it by adding markup.

## Review Focus

1. **Two views of one Bot's live stream** (the chat and the Activity tab, or a panel tab closed while the chat stays). Expected: one `bots:live:subscribe` per Bot per window; switching or closing a tab never unsubscribes, and the chat keeps updating. Test: Task 5, Step 1, "a Bot's chat and its Activity tab share one live subscription…".
2. **The pinned or last-viewed Bot is deleted** (from the menu, another window, or a phone). Expected: the hero disappears and the pin is cleared; `/bots` opens the next most recent Bot, never "Bot not found". Tests: Task 10, Step 1, "Pin to top shows the Bot large…"; Task 11, Step 1, "with nothing viewed yet, or the last one deleted…".
3. **A hand-edited, foreign or garbage `aiden-agent.bots-sidebar.v1` value** (not JSON, `version: 2`, wrong types, thousands of entries). Expected: the sidebar loads with no pin and nothing viewed, and nothing throws. Test: Task 2, Step 1, "a stored record that is missing, malformed or from a newer build…".
4. **The first launch after updating, with Bots that replied long ago.** Expected: no unread dots until a new reply arrives. Tests: Task 2, Step 1, "a Bot is unread only for a reply after it was last viewed…"; Task 10, Step 1, "a reply since the person last looked shows an unread dot…".
5. **`environment.toggle` pressed in a Bot chat** (and the workspace panel was open before). Expected: only the Bot panel toggles; the workspace panel's saved open state and open tabs are untouched, and leaving Bots shows it exactly as it was. Tests: Task 1, Step 1, "the toggle shortcut acts on the Bot panel…"; Task 7, Step 1, "Escape inside the Bot panel closes it…"; Task 12, Step 1 (e2e).

---

## File map

| File | Responsibility |
|---|---|
| Create `renderer/lib/bot-routes.ts` (+ `.test.ts`) | `isBotsPath`, `botChatRouteBotId`, `botRouteBotId`, `environmentToggleTarget`, `botChatPath`, `rememberRoute`, `lastNonBotRoute` |
| Create `renderer/lib/bot-sidebar-preferences.ts` (+ `.test.ts`) | Pure pin / last-viewed record: parse, serialize, update, prune, unread, last viewed |
| Create `renderer/main/bots/use-bot-sidebar-preferences.ts` | `useSyncExternalStore` hook over that record with stable actions |
| Modify `renderer/shared/bot-live.ts`, `main/services/bot-runtime/live-projection.ts` (+ test), `main/handlers/bot-live.test.ts`, `main/services/bot-runtime/bot-session-main.ts`, `renderer/preload-channels.ts` | `needsYou`, `lastReplyAt`, `botLastReplyAt`, `bots:attention` |
| Create `renderer/main/bots/bot-panel-context.tsx` | `BotPanelProvider`, `useBotPanel`, tab ids and storage keys |
| Modify `renderer/main/root-view.tsx`, `renderer/main/chat-layout.tsx`, `renderer/main/bots/test-providers.tsx` | Provider at the root; toggle routing; suppression and route memory on Bots paths; test harness |
| Modify `renderer/lib/use-bot-live.ts` | `BotLiveProvider`, `useSharedBotLive` |
| Create `renderer/main/bots/bot-activity-log.ts` (+ `.test.ts`) | Activity grouping and the "Today, 6:41 PM" label |
| Create `renderer/main/bots/bot-workbench.tsx`, `bot-panel-activity.tsx`, `bot-panel-files.tsx`; test `renderer/main/bots/bot-panel.test.tsx` | The Bot side panel and its tabs |
| Modify `renderer/main/bots/bot-memory-page.tsx` | Extract `BotMemoryContent` (page and compact panel share it) |
| Modify `renderer/main/bot-chat-route.tsx`, `renderer/main/bots/bot-chat-header.tsx` (+ test), `renderer/main/bots/bot-chat-pane.tsx` (+ test) | Workbench around the chat, `BotPanelToggle`, chips/menu/caption open the panel, shared menu, mark viewed |
| Delete `renderer/main/bots/bot-files-dialog.tsx` | Replaced by the Files tab |
| Create `renderer/main/bots/bot-menu.tsx` | `BotMenuItems`, `useBotMenuActions` |
| Create `renderer/main/bots/bot-sidebar-rows.ts`, `renderer/main/bots/bot-sidebar.tsx`; test `renderer/main/bots/bot-sidebar.test.tsx` | Rows, ordering, search, the Bots sidebar |
| Modify `renderer/components/chat-sidebar.tsx` | `ChatSidebar` renders `BotSidebar` on Bots paths |
| Modify `renderer/components/remote-bots-section.tsx`, `renderer/main/remote-bots.tsx`, `renderer/main/remote-new-chat-view.test.tsx` | Sidebar rows and search for Bots on paired Macs |
| Delete `renderer/main/bots/bot-list.tsx`, `renderer/main/bots/bot-list.test.tsx` | Behaviours migrated to `bot-sidebar.test.tsx` |
| Modify `renderer/main/bots-view.tsx`, `renderer/main/bots/bot-profile.tsx`, `renderer/main/bots/bots-home.test.tsx` | `/bots` index redirect and starter page; Profile's back |
| Create `tests/e2e/bots-sidebar-panel.spec.ts` | Sidebar → latest Bot → Files tab shows a produced file; toggle isolation |
| Modify `renderer/components/onboarding-art/control-art.tsx` | Bots tile header follows the new chat header |
| Modify `package.json`, `scripts/ci-test-registry.json`, the spec, `docs/plans/README.md`, `.memory/bot-chat-activity.md`, `.memory/bots-rework-ui.md` | Registration, docs, memory |

---
### Task 1: Bots route helpers and the ‹ back target

**Files:**
- Create: `renderer/lib/bot-routes.ts`
- Test: `renderer/lib/bot-routes.test.ts`
- Modify: `renderer/main/bots-view.tsx:21-24` (`botChatPath` moves out; re-exported)
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json` (`renderer-other`)

**Interfaces:**
- Consumes: nothing.
- Produces (all in `renderer/lib/bot-routes.ts`):
  - `isBotsPath(pathname: string): boolean`
  - `botChatRouteBotId(pathname: string): string | null` (`/bots/$botId/chat` only)
  - `botRouteBotId(pathname: string): string | null` (`/bots/$botId` or `/bots/$botId/chat`)
  - `type EnvironmentToggleTarget = "bot-panel" | "workspace" | "none"`; `environmentToggleTarget(pathname): EnvironmentToggleTarget`
  - `botChatPath(botId): { to: "/bots/$botId/chat"; params: { botId: string } }`
  - `rememberRoute(href: string): void`, `lastNonBotRoute(): string` (default `"/"`)

- [ ] **Step 1: Write the failing tests**

```ts
// renderer/lib/bot-routes.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botChatPath,
  botChatRouteBotId,
  botRouteBotId,
  environmentToggleTarget,
  isBotsPath,
  lastNonBotRoute,
  rememberRoute,
} from "./bot-routes";

test("Bots pages are /bots and everything under it, and nothing that only starts with the same letters", () => {
  for (const path of ["/bots", "/bots/", "/bots/b1", "/bots/b1/chat"]) assert.equal(isBotsPath(path), true, path);
  for (const path of ["/", "/botsy", "/chat/c1", "/host/h1/chat/c1", "/settings"]) assert.equal(isBotsPath(path), false, path);
});

test("a Bot page names its Bot, and only the chat route counts as the Bot's chat", () => {
  assert.equal(botRouteBotId("/bots/9f0c/chat"), "9f0c");
  assert.equal(botRouteBotId("/bots/9f0c"), "9f0c");
  assert.equal(botRouteBotId("/bots"), null);
  assert.equal(botChatRouteBotId("/bots/9f0c/chat"), "9f0c");
  assert.equal(botChatRouteBotId("/bots/9f0c"), null);
  assert.equal(botChatRouteBotId("/bots/%E0%A4%A/chat"), null, "a malformed segment is no Bot");
  assert.deepEqual(botChatPath("9f0c"), { to: "/bots/$botId/chat", params: { botId: "9f0c" } });
});

test("the toggle shortcut acts on the Bot panel in a Bot chat, on nothing elsewhere in Bots, and on the workspace panel outside Bots", () => {
  assert.equal(environmentToggleTarget("/bots/9f0c/chat"), "bot-panel");
  assert.equal(environmentToggleTarget("/bots"), "none");
  assert.equal(environmentToggleTarget("/bots/9f0c"), "none");
  assert.equal(environmentToggleTarget("/chat/c1"), "workspace");
  assert.equal(environmentToggleTarget("/scheduled"), "workspace");
});

test("‹ goes back to the last page outside Bots, never to a Bots page", () => {
  assert.equal(lastNonBotRoute(), "/");
  rememberRoute("/chat/c1?draft=1");
  rememberRoute("/bots/9f0c/chat");
  rememberRoute("/bots");
  assert.equal(lastNonBotRoute(), "/chat/c1?draft=1");
  rememberRoute("/scheduled#top");
  assert.equal(lastNonBotRoute(), "/scheduled#top");
});
```

Register: append ` renderer/lib/bot-routes.test.ts` to the end of `package.json` `test:bots`, and in `scripts/ci-test-registry.json`'s `renderer-other` lane add `"renderer/lib/bot-routes.test.ts",` after `"renderer/main/bots/bot-memory-page.test.tsx",`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/lib/bot-routes.test.ts`
Expected: FAIL, cannot find module `./bot-routes`.

- [ ] **Step 3: Implement**

```ts
// renderer/lib/bot-routes.ts
// Where the Bots surfaces live in the route tree, what the panel shortcut acts
// on there, and where ‹ in the Bots sidebar goes back to (spec §8, §9).

const BOT_CHAT_ROUTE = /^\/bots\/([^/]+)\/chat\/?$/u;
const BOT_ROUTE = /^\/bots\/([^/]+)(?:\/chat)?\/?$/u;

export function isBotsPath(pathname: string): boolean {
  return pathname === "/bots" || pathname.startsWith("/bots/");
}

function decodedSegment(segment: string | undefined): string | null {
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The Bot whose chat is open, or null. */
export function botChatRouteBotId(pathname: string): string | null {
  return decodedSegment(BOT_CHAT_ROUTE.exec(pathname)?.[1]);
}

/** The Bot a `/bots/$botId` or `/bots/$botId/chat` page belongs to, or null. */
export function botRouteBotId(pathname: string): string | null {
  return decodedSegment(BOT_ROUTE.exec(pathname)?.[1]);
}

export type EnvironmentToggleTarget = "bot-panel" | "workspace" | "none";

/** What `environment.toggle` acts on: the Bot panel in a Bot chat, nothing on other Bots pages, else the workspace panel. */
export function environmentToggleTarget(pathname: string): EnvironmentToggleTarget {
  if (botChatRouteBotId(pathname) !== null) return "bot-panel";
  return isBotsPath(pathname) ? "none" : "workspace";
}

/** The Bot's one conversation, addressed by Bot id only. */
export function botChatPath(botId: string): { to: "/bots/$botId/chat"; params: { botId: string } } {
  return { to: "/bots/$botId/chat", params: { botId } };
}

let lastNonBotHref = "/";

/** Called on every chat-shell navigation. Bots pages are never a back target. */
export function rememberRoute(href: string): void {
  const pathname = href.split(/[?#]/u, 1)[0] ?? href;
  if (!isBotsPath(pathname)) lastNonBotHref = href;
}

/** Where ‹ in the Bots sidebar goes: the last page outside Bots this session, else the latest chat (`/`). */
export function lastNonBotRoute(): string {
  return lastNonBotHref;
}
```

In `renderer/main/bots-view.tsx`, delete the local `botChatPath` function (lines 21-24, with its doc comment) and add, after the other imports:

```tsx
import { botChatPath } from "../lib/bot-routes";

export { botChatPath } from "../lib/bot-routes";
```

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test renderer/lib/bot-routes.test.ts && npx tsc --noEmit && npm run test:ci-policy`
Expected: 4 tests PASS, no type errors, CI policy PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/lib/bot-routes.ts renderer/lib/bot-routes.test.ts renderer/main/bots-view.tsx package.json scripts/ci-test-registry.json
git commit -m "Bots: route helpers for the Bots sidebar and panel shortcut"
```

---

### Task 2: Per-device pin and last-viewed preferences

**Files:**
- Create: `renderer/lib/bot-sidebar-preferences.ts`, `renderer/main/bots/use-bot-sidebar-preferences.ts`
- Test: `renderer/lib/bot-sidebar-preferences.test.ts`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json` (`renderer-other`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `renderer/lib/bot-sidebar-preferences.ts`: `BOT_SIDEBAR_PREFERENCES_KEY = "aiden-agent.bots-sidebar.v1"`, `BOT_LAST_VIEWED_LIMIT = 200`, `interface BotSidebarPreferences { since: number; pinnedBotId: string | null; lastViewed: Readonly<Record<string, number>> }`, `parseBotSidebarPreferences(raw: string | null, now: number)`, `serializeBotSidebarPreferences(preferences): string`, `withPinnedBot(preferences, botId: string | null)`, `withBotViewed(preferences, botId, at)`, `withoutMissingBots(preferences, liveIds: ReadonlySet<string>)` (returns the same object when nothing changes), `isBotUnread(preferences, botId, lastReplyAt: number | null): boolean`, `lastViewedBotId(preferences, liveIds): string | null`.
  - `renderer/main/bots/use-bot-sidebar-preferences.ts`: `useBotSidebarPreferences(): { preferences; pin(botId); unpin(); markViewed(botId); prune(liveIds) }`. The four actions are module-level and stable across renders (effects can depend on them without looping).

- [ ] **Step 1: Write the failing tests**

```ts
// renderer/lib/bot-sidebar-preferences.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOT_LAST_VIEWED_LIMIT,
  isBotUnread,
  lastViewedBotId,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
  withBotViewed,
  withoutMissingBots,
  withPinnedBot,
} from "./bot-sidebar-preferences";

const NOW = 1_800_000_000_000;

test("a stored record that is missing, malformed or from a newer build reads as no pin and nothing viewed", () => {
  for (const raw of [null, "", "not json", "[]", "42", JSON.stringify({ version: 2, pinnedBotId: "b1" })]) {
    assert.deepEqual(parseBotSidebarPreferences(raw, NOW), { since: NOW, pinnedBotId: null, lastViewed: {} }, String(raw));
  }
  const odd = parseBotSidebarPreferences(
    JSON.stringify({ version: 1, since: -5, pinnedBotId: 7, lastViewed: { b1: 10, b2: "soon", b3: Number.NaN, "": 4, b4: -1 } }),
    NOW,
  );
  assert.deepEqual(odd, { since: NOW, pinnedBotId: null, lastViewed: { b1: 10 } });
});

test("a record round-trips, and only the most recent views are kept", () => {
  const stored = { since: 5, pinnedBotId: "b1", lastViewed: { b1: 10, b2: 20 } };
  assert.deepEqual(parseBotSidebarPreferences(serializeBotSidebarPreferences(stored), NOW), stored);
  const many = Object.fromEntries(Array.from({ length: BOT_LAST_VIEWED_LIMIT + 50 }, (_, index) => [`b${index}`, index + 1]));
  const trimmed = parseBotSidebarPreferences(JSON.stringify({ version: 1, since: 1, pinnedBotId: null, lastViewed: many }), NOW);
  assert.equal(Object.keys(trimmed.lastViewed).length, BOT_LAST_VIEWED_LIMIT);
  assert.equal(trimmed.lastViewed[`b${BOT_LAST_VIEWED_LIMIT + 49}`], BOT_LAST_VIEWED_LIMIT + 50, "the newest view survives");
  assert.equal(trimmed.lastViewed.b0, undefined, "the oldest view goes");
});

test("a Bot is unread only for a reply after it was last viewed, or after the record began when it never was", () => {
  const preferences = { since: 1_000, pinnedBotId: null, lastViewed: { seen: 5_000 } };
  assert.equal(isBotUnread(preferences, "seen", 6_000), true);
  assert.equal(isBotUnread(preferences, "seen", 4_000), false);
  assert.equal(isBotUnread(preferences, "never", 500), false, "an old reply from before the update is not news");
  assert.equal(isBotUnread(preferences, "never", 1_500), true);
  assert.equal(isBotUnread(preferences, "seen", null), false);
});

test("viewing only moves forward, pinning replaces the one pin, and pruning drops deleted Bots", () => {
  const start = { since: 1, pinnedBotId: null, lastViewed: { b1: 50 } };
  assert.equal(withBotViewed(start, "b1", 40), start, "an older view changes nothing");
  assert.equal(withBotViewed(start, "b1", 60).lastViewed.b1, 60);
  const pinned = withPinnedBot(withPinnedBot(start, "b1"), "b2");
  assert.equal(pinned.pinnedBotId, "b2");
  assert.equal(withPinnedBot(pinned, "b2"), pinned);
  const live = new Set(["b1"]);
  const pruned = withoutMissingBots({ ...pinned, lastViewed: { b1: 50, gone: 70 } }, live);
  assert.deepEqual(pruned, { since: 1, pinnedBotId: null, lastViewed: { b1: 50 } });
  assert.equal(withoutMissingBots(pruned, live), pruned, "nothing to prune keeps the same record");
});

test("the last viewed Bot is the newest view among Bots that still exist", () => {
  const preferences = { since: 1, pinnedBotId: null, lastViewed: { b1: 10, gone: 99, b2: 30 } };
  assert.equal(lastViewedBotId(preferences, new Set(["b1", "b2"])), "b2");
  assert.equal(lastViewedBotId(preferences, new Set(["b3"])), null);
});
```

Register: append ` renderer/lib/bot-sidebar-preferences.test.ts` to `package.json` `test:bots`, and add `"renderer/lib/bot-sidebar-preferences.test.ts",` after `"renderer/lib/bot-routes.test.ts",` in the `renderer-other` lane.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/lib/bot-sidebar-preferences.test.ts`
Expected: FAIL, cannot find module `./bot-sidebar-preferences`.

- [ ] **Step 3: Implement the pure record**

```ts
// renderer/lib/bot-sidebar-preferences.ts
// The Bots sidebar's per-device preferences (spec §9): which Bot is pinned and
// when each Bot was last viewed on this Mac. Not part of BotDefinition, never
// synced to phones. `since` is when the record began, so Bots never viewed here
// are not all unread after an update.

export const BOT_SIDEBAR_PREFERENCES_KEY = "aiden-agent.bots-sidebar.v1";
export const BOT_LAST_VIEWED_LIMIT = 200;

export interface BotSidebarPreferences {
  since: number;
  pinnedBotId: string | null;
  lastViewed: Readonly<Record<string, number>>;
}

function fresh(now: number): BotSidebarPreferences {
  return { since: now, pinnedBotId: null, lastViewed: {} };
}

const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function newest(lastViewed: Record<string, number>): Record<string, number> {
  const entries = Object.entries(lastViewed);
  if (entries.length <= BOT_LAST_VIEWED_LIMIT) return lastViewed;
  return Object.fromEntries(entries.sort((left, right) => right[1] - left[1]).slice(0, BOT_LAST_VIEWED_LIMIT));
}

export function parseBotSidebarPreferences(raw: string | null, now: number): BotSidebarPreferences {
  if (raw === null) return fresh(now);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fresh(now);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fresh(now);
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return fresh(now);
  const lastViewed: Record<string, number> = {};
  if (record.lastViewed && typeof record.lastViewed === "object" && !Array.isArray(record.lastViewed)) {
    for (const [botId, at] of Object.entries(record.lastViewed as Record<string, unknown>)) {
      if (botId && validTime(at)) lastViewed[botId] = at;
    }
  }
  return {
    since: validTime(record.since) ? record.since : now,
    pinnedBotId: typeof record.pinnedBotId === "string" && record.pinnedBotId ? record.pinnedBotId : null,
    lastViewed: newest(lastViewed),
  };
}

export function serializeBotSidebarPreferences(preferences: BotSidebarPreferences): string {
  return JSON.stringify({
    version: 1,
    since: preferences.since,
    pinnedBotId: preferences.pinnedBotId,
    lastViewed: preferences.lastViewed,
  });
}

export function withPinnedBot(preferences: BotSidebarPreferences, botId: string | null): BotSidebarPreferences {
  return preferences.pinnedBotId === botId ? preferences : { ...preferences, pinnedBotId: botId };
}

export function withBotViewed(preferences: BotSidebarPreferences, botId: string, at: number): BotSidebarPreferences {
  if (at <= (preferences.lastViewed[botId] ?? 0)) return preferences;
  return { ...preferences, lastViewed: newest({ ...preferences.lastViewed, [botId]: at }) };
}

export function withoutMissingBots(
  preferences: BotSidebarPreferences,
  liveIds: ReadonlySet<string>,
): BotSidebarPreferences {
  const pinGone = preferences.pinnedBotId !== null && !liveIds.has(preferences.pinnedBotId);
  const kept = Object.entries(preferences.lastViewed).filter(([botId]) => liveIds.has(botId));
  if (!pinGone && kept.length === Object.keys(preferences.lastViewed).length) return preferences;
  return {
    ...preferences,
    pinnedBotId: pinGone ? null : preferences.pinnedBotId,
    lastViewed: Object.fromEntries(kept),
  };
}

export function isBotUnread(preferences: BotSidebarPreferences, botId: string, lastReplyAt: number | null): boolean {
  return lastReplyAt !== null && lastReplyAt > (preferences.lastViewed[botId] ?? preferences.since);
}

export function lastViewedBotId(preferences: BotSidebarPreferences, liveIds: ReadonlySet<string>): string | null {
  let best: string | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const [botId, at] of Object.entries(preferences.lastViewed)) {
    if (liveIds.has(botId) && at > bestAt) {
      best = botId;
      bestAt = at;
    }
  }
  return best;
}
```

- [ ] **Step 4: Implement the hook**

```ts
// renderer/main/bots/use-bot-sidebar-preferences.ts
// One per-window view of the Bots sidebar preferences, kept in step across
// windows by the `storage` event. Storage can be missing or throw (a private
// profile, cleared site data): the sidebar then works for this session only.

import * as React from "react";
import {
  BOT_SIDEBAR_PREFERENCES_KEY,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
  withBotViewed,
  withoutMissingBots,
  withPinnedBot,
  type BotSidebarPreferences,
} from "../../lib/bot-sidebar-preferences";

const listeners = new Set<() => void>();
let cache: { raw: string | null; value: BotSidebarPreferences } | null = null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY);
  } catch {
    return null;
  }
}

function snapshot(): BotSidebarPreferences {
  const raw = readRaw();
  if (!cache || cache.raw !== raw) cache = { raw, value: parseBotSidebarPreferences(raw, Date.now()) };
  return cache.value;
}

function update(change: (current: BotSidebarPreferences) => BotSidebarPreferences): void {
  const current = snapshot();
  const next = change(current);
  // An unchanged record is still written once, so `since` sticks across launches.
  if (next === current && cache?.raw !== null) return;
  try {
    localStorage.setItem(BOT_SIDEBAR_PREFERENCES_KEY, serializeBotSidebarPreferences(next));
  } catch {
    // Per-device convenience only.
  }
  cache = { raw: readRaw(), value: next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === BOT_SIDEBAR_PREFERENCES_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const ACTIONS = {
  pin: (botId: string) => update((current) => withPinnedBot(current, botId)),
  unpin: () => update((current) => withPinnedBot(current, null)),
  markViewed: (botId: string) => update((current) => withBotViewed(current, botId, Date.now())),
  prune: (liveIds: ReadonlySet<string>) => update((current) => withoutMissingBots(current, liveIds)),
} as const;

export function useBotSidebarPreferences() {
  const preferences = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  return { preferences, ...ACTIONS };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test renderer/lib/bot-sidebar-preferences.test.ts && npx tsc --noEmit && npm run test:ci-policy`
Expected: 5 tests PASS, no type errors, CI policy PASS. (The hook is exercised by Task 10's sidebar tests.)

- [ ] **Step 6: Commit**

```bash
git add renderer/lib/bot-sidebar-preferences.ts renderer/lib/bot-sidebar-preferences.test.ts renderer/main/bots/use-bot-sidebar-preferences.ts package.json scripts/ci-test-registry.json
git commit -m "Bots: per-device pin and last-viewed preferences for the Bots sidebar"
```

---

### Task 3: List summaries say "needs you" and when the last reply arrived

**Files:**
- Modify: `renderer/shared/bot-live.ts` (`BotLiveSummary`, new `botLastReplyAt`)
- Modify: `main/services/bot-runtime/live-projection.ts` (`summary`, about lines 729-741)
- Modify: `main/services/bot-runtime/bot-session-main.ts` (next to the `botQuestions.onChange` block)
- Modify: `renderer/preload-channels.ts` (`NOTIFICATION_CHANNELS`)
- Test: `main/services/bot-runtime/live-projection.test.ts`, `main/handlers/bot-live.test.ts`

**Interfaces:**
- Consumes: B's `approvalPending` dep and the `waitingOn(botId)` helper inside `createBotLiveProjection` (B Task 3, Step 3). If B landed it under another name, use the same expression inline: `(deps.question?.(botId) ?? null) !== null || deps.approvalPending?.(botId) === true`.
- Produces:
  - `BotLiveSummary` = `{ botId; preview: string | null; updatedAt: number | null; state: BotSessionState; needsYou: boolean; lastReplyAt: number | null }`.
  - `botLastReplyAt(entries: readonly BotTranscriptEntry[]): number | null` in `renderer/shared/bot-live.ts`.
  - Notification `bots:attention` with payload `{ botId: string }`, broadcast whenever a Bot's question or approval appears or settles.

- [ ] **Step 1: Write the failing tests**

In `main/services/bot-runtime/live-projection.test.ts`, add `botLastReplyAt` to the `../../../renderer/shared/bot-live.js` import, then add:

```ts
test("the last reply time ignores the person's newer messages and replies with no text", () => {
  assert.equal(botLastReplyAt([]), null);
  assert.equal(
    botLastReplyAt([
      { id: "a1", type: "assistant", text: "Here you go.", toolCalls: [], stopReason: "stop", at: 10 },
      { id: "a2", type: "assistant", text: "  ", toolCalls: [], stopReason: "toolUse", at: 20 },
      { id: "u2", type: "user", text: "Thanks", imageCount: 0, at: 30 },
    ]),
    10,
  );
});

test("a list summary says when the last reply arrived and whether the Bot is waiting on the person", async () => {
  let waiting = false;
  const live = await start(createFauxModels([fauxAssistantMessage("Here is your meal plan.")]), {
    projection: { approvalPending: () => waiting },
  });
  try {
    const before = await live.projection.summary("bot:a");
    assert.equal(before.lastReplyAt, null);
    assert.equal(before.needsYou, false);
    const sent = await live.service.send("bot:a", { text: "Plan dinners", requestId: "desk-1" });
    await live.service.awaitReply("bot:a", sent.submissionId, new AbortController().signal);
    const after = await live.projection.summary("bot:a");
    assert.equal(after.preview, "Here is your meal plan.");
    assert.equal(typeof after.lastReplyAt, "number");
    assert.equal(after.lastReplyAt, after.updatedAt, "the newest message is the reply");
    waiting = true;
    assert.equal((await live.projection.summary("bot:a")).needsYou, true);
  } finally {
    await live.close();
  }
});
```

In `main/handlers/bot-live.test.ts`, change the fake's `summary` to `summary: async (botId) => ({ botId, preview: "hi", updatedAt: 1, state: { kind: "idle" }, needsYou: true, lastReplyAt: 1 }),` and the expected object in "the list summary comes from the projection" to:

```ts
  assert.deepEqual(await invoke("bots:live:summary", new FakeDocument("w"), "bot:a"), {
    botId: "bot:a",
    preview: "hi",
    updatedAt: 1,
    state: { kind: "idle" },
    needsYou: true,
    lastReplyAt: 1,
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test main/services/bot-runtime/live-projection.test.ts main/handlers/bot-live.test.ts`
Expected: FAIL. `botLastReplyAt` is not exported, and the fake's summary does not type-check against `BotLiveSummary`.

- [ ] **Step 3: Implement**

In `renderer/shared/bot-live.ts`, replace `BotLiveSummary` and add the helper below `botTranscriptPreview`:

```ts
/** What a Bots sidebar row shows, read from the same projection. */
export interface BotLiveSummary {
  botId: string;
  preview: string | null;
  updatedAt: number | null;
  state: BotSessionState;
  /** An approval or an A–E question is waiting on the person ("Needs you"). */
  needsYou: boolean;
  /** When the newest reply with visible text arrived; the sidebar's unread dot compares it with last-viewed. */
  lastReplyAt: number | null;
}

/** When the newest reply with visible text arrived, or null when none has a time. */
export function botLastReplyAt(entries: readonly BotTranscriptEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "assistant" && entry.text.trim() && entry.at !== undefined) return entry.at;
  }
  return null;
}
```

In `main/services/bot-runtime/live-projection.ts`, import `botLastReplyAt` next to `botTranscriptPreview` from `../../../renderer/shared/bot-live.js`, and replace `summary` in the returned object with:

```ts
    async summary(botId) {
      const needsYou = waitingOn(botId);
      const feed = feeds.get(botId);
      if (feed && !feed.ended) {
        await feed.queue;
        const preview = botTranscriptPreview(feed.entries);
        return {
          botId,
          preview: preview?.text ?? null,
          updatedAt: preview?.at ?? null,
          state: feed.state,
          needsYou,
          lastReplyAt: botLastReplyAt(feed.entries),
        };
      }
      const state = await deps.state(botId);
      if (state.kind === "unavailable") {
        return { botId, preview: null, updatedAt: null, state, needsYou: false, lastReplyAt: null };
      }
      const view = await (await deps.conversation(botId)).context(BACKGROUND_CONTEXT);
      const entries = projectBotTranscript(view.entries);
      const preview = botTranscriptPreview(entries);
      return {
        botId,
        preview: preview?.text ?? null,
        updatedAt: preview?.at ?? null,
        state,
        needsYou,
        lastReplyAt: botLastReplyAt(entries),
      };
    },
```

In `main/services/bot-runtime/bot-session-main.ts`, directly after the `botQuestions.onChange((botId) => { … });` block, add:

```ts
// "Needs you" in the Bots sidebar follows questions and approvals as they
// appear and settle; the renderer re-reads that Bot's summary.
function broadcastAttention(botId: string): void {
  ipcMain.broadcast("bots:attention", { botId });
}
botQuestions.onChange(broadcastAttention);
botApprovals.onChange(broadcastAttention);
```

In `renderer/preload-channels.ts`, after `"bots:approval-settled",` add:

```ts
  /** A Bot's question or approval appeared or settled: `{botId}`. The Bots sidebar re-reads its row. */
  "bots:attention",
```

- [ ] **Step 4: Run the tests**

Run:
```bash
npx tsx --test main/services/bot-runtime/live-projection.test.ts main/handlers/bot-live.test.ts main/handlers/ipc-contract.test.ts
npx tsc --noEmit
npm run test:aiden-remote
```
Expected: all PASS. `ipc-contract` confirms the new broadcast and the preload list agree. `test:aiden-remote` passes with no fixture change (the Remote wire does not use `summary`).

- [ ] **Step 5: Commit**

```bash
git add renderer/shared/bot-live.ts main/services/bot-runtime/live-projection.ts main/services/bot-runtime/live-projection.test.ts main/handlers/bot-live.test.ts main/services/bot-runtime/bot-session-main.ts renderer/preload-channels.ts
git commit -m "Bots: list summaries carry Needs you and the last reply time; bots:attention"
```

---
### Task 4: Bot panel state, the toggle shortcut, and suppressing workspace surfaces on Bots pages

This task answers three of C1's risks. **`toggleTools` appends a `new-tab` launcher**, so the Bot route never calls it: `environment.toggle` is routed by `environmentToggleTarget` to `BotPanelProvider.toggle`. **Open state is shared in `EnvironmentPanelProvider`**, so the Bot panel gets its own provider and keys, and the workspace surfaces are `suppressed` on every Bots path; their open state is kept, not changed, and comes back on leaving. **Quick View and the device mini player are not hidden on `/bots`**: `suppressed` hides both (they are gated on it inside `EnvironmentWorkbench`), and `quick-view.toggle` is a no-op on Bots paths.

**Files:**
- Create: `renderer/main/bots/bot-panel-context.tsx`
- Test: `renderer/main/bots/bot-panel.test.tsx`
- Modify: `renderer/main/root-view.tsx` (imports; `RootView`; the `environment.toggle` and `quick-view.toggle` handlers at about lines 139-159)
- Modify: `renderer/main/chat-layout.tsx` (route memory; `suppressed`)
- Modify: `renderer/main/bots/test-providers.tsx` (provider in the harness; `sidebar` option; two more paths)
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json` (`renderer-other`)

**Interfaces:**
- Consumes: `environmentToggleTarget`, `isBotsPath`, `rememberRoute` (Task 1).
- Produces (in `renderer/main/bots/bot-panel-context.tsx`):
  - `BOT_PANEL_ID = "bot-panel"`, `BOT_PANEL_TABS = ["activity", "files", "memory", "routines"] as const`, `type BotPanelTab`, `BOT_PANEL_OPEN_KEY`, `BOT_PANEL_TAB_KEY`, `BOT_PANEL_WIDTH_KEY`, `parseBotPanelTab(value: string | null): BotPanelTab`.
  - `interface BotPanelFileRequest { path: string; key: number }` (`key` is new on every request, so the same chip clicked twice re-selects its file).
  - `interface BotPanelValue { open; tab; fileRequest: BotPanelFileRequest | null; focusRequest: number; show(tab, options?: { path?: string }): void; setTab(tab): void; toggle(): void; close(): void; consumeFocusRequest(): boolean }`.
  - `BotPanelProvider`, `useBotPanel(): BotPanelValue` (throws outside the provider).
  - Test harness: `mountWithBotRouter(children, { initialPath?, queryClient?, sidebar? })` wraps every route in `BotPanelProvider` and renders `sidebar` beside the routed page; `BOT_TEST_PATHS` adds `/profile` and `/scheduled`.

- [ ] **Step 1: Write the failing tests**

```tsx
// renderer/main/bots/bot-panel.test.tsx
import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BOT_PANEL_OPEN_KEY, BOT_PANEL_TAB_KEY, BotPanelProvider, useBotPanel } from "./bot-panel-context";

beforeEach(() => {
  installBotTestIpc();
  localStorage.clear();
});
afterEach(cleanup);

function PanelProbe() {
  const panel = useBotPanel();
  const request = panel.fileRequest ? `${panel.fileRequest.path}#${panel.fileRequest.key}` : "none";
  return (
    <>
      <output aria-label="Panel">{`${panel.open ? "open" : "closed"} ${panel.tab} ${request}`}</output>
      <button type="button" onClick={() => panel.show("files", { path: "lists/groceries.md" })}>
        Open groceries
      </button>
      <button type="button" onClick={() => panel.show("memory")}>
        Open memory
      </button>
      <button type="button" onClick={panel.toggle}>
        Toggle
      </button>
    </>
  );
}

const panelState = () => screen.getByRole("status", { name: "Panel" }).textContent ?? "";

test("a file asked for twice is two requests, and the toggle closes and reopens on the same tab", () => {
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "closed activity none");
  fireEvent.click(screen.getByRole("button", { name: "Open groceries" }));
  const first = panelState();
  assert.match(first, /^open files lists\/groceries\.md#\d+$/u);
  fireEvent.click(screen.getByRole("button", { name: "Open groceries" }));
  assert.notEqual(panelState(), first, "the same chip clicked again selects its file again");
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  assert.match(panelState(), /^closed files /u);
  fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
  assert.match(panelState(), /^open files /u);
});

test("the Bot panel comes back open on its last tab after a relaunch, under its own keys only", () => {
  const first = render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open memory" }));
  first.unmount();
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "open memory none");
  assert.equal(localStorage.getItem(BOT_PANEL_OPEN_KEY), "true");
  assert.equal(localStorage.getItem(BOT_PANEL_TAB_KEY), "memory");
  for (const key of [
    "aiden-agent.environment.open",
    "aiden-agent.environment.open-tabs-v1",
    "aiden-agent.environment.tab",
    "aiden-agent.quick-view.open",
  ]) {
    assert.equal(localStorage.getItem(key), null, key);
  }
});

test("a saved tab this build doesn't know, or a garbled open flag, opens closed on Activity", () => {
  localStorage.setItem(BOT_PANEL_TAB_KEY, "browser");
  localStorage.setItem(BOT_PANEL_OPEN_KEY, "yes");
  render(
    <BotPanelProvider>
      <PanelProbe />
    </BotPanelProvider>,
  );
  assert.equal(panelState(), "closed activity none");
});
```

Register: append ` renderer/main/bots/bot-panel.test.tsx` to `package.json` `test:bots`; add `"renderer/main/bots/bot-panel.test.tsx",` after `"renderer/lib/bot-sidebar-preferences.test.ts",` in the `renderer-other` lane.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-panel.test.tsx`
Expected: FAIL, cannot find module `./bot-panel-context`.

- [ ] **Step 3: Implement the provider**

```tsx
// renderer/main/bots/bot-panel-context.tsx
// The Bot side panel's state (spec §8), kept apart from the workspace
// Environment panel: its own open flag, tab and width keys, so opening it on a
// Bot never opens or reshapes the workspace panel. Focus: opening asks the
// panel to focus its selected tab; closing with focus inside returns it to
// what was focused before, else the header toggle.

import * as React from "react";

export const BOT_PANEL_ID = "bot-panel";
export const BOT_PANEL_TABS = ["activity", "files", "memory", "routines"] as const;
export type BotPanelTab = (typeof BOT_PANEL_TABS)[number];
export const BOT_PANEL_OPEN_KEY = "aiden-agent.bot-panel.open";
export const BOT_PANEL_TAB_KEY = "aiden-agent.bot-panel.tab";
export const BOT_PANEL_WIDTH_KEY = "aiden-agent.bot-panel.width";

export interface BotPanelFileRequest {
  path: string;
  /** New on every request, so the same file chip clicked twice selects its file again. */
  key: number;
}

export interface BotPanelValue {
  open: boolean;
  tab: BotPanelTab;
  fileRequest: BotPanelFileRequest | null;
  /** Bumped whenever the person opens the panel or picks a tab from outside it. */
  focusRequest: number;
  show(tab: BotPanelTab, options?: { path?: string }): void;
  setTab(tab: BotPanelTab): void;
  toggle(): void;
  close(): void;
  /** True once after a person-initiated open: the panel then focuses its selected tab. */
  consumeFocusRequest(): boolean;
}

export function parseBotPanelTab(value: string | null): BotPanelTab {
  return (BOT_PANEL_TABS as readonly string[]).includes(value ?? "") ? (value as BotPanelTab) : "activity";
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Per-device convenience only.
  }
}

const BotPanelContext = React.createContext<BotPanelValue | null>(null);

interface PanelState {
  open: boolean;
  tab: BotPanelTab;
  fileRequest: BotPanelFileRequest | null;
}

export function BotPanelProvider({ children }: React.PropsWithChildren) {
  const [state, setState] = React.useState<PanelState>(() => ({
    open: readStored(BOT_PANEL_OPEN_KEY) === "true",
    tab: parseBotPanelTab(readStored(BOT_PANEL_TAB_KEY)),
    fileRequest: null,
  }));
  const [focusRequest, setFocusRequest] = React.useState(0);
  const openRef = React.useRef(state.open);
  openRef.current = state.open;
  const pendingFocus = React.useRef(false);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const fileKey = React.useRef(0);

  React.useEffect(() => writeStored(BOT_PANEL_OPEN_KEY, String(state.open)), [state.open]);
  React.useEffect(() => writeStored(BOT_PANEL_TAB_KEY, state.tab), [state.tab]);

  const requestFocus = React.useCallback(() => {
    if (!openRef.current) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && !active.closest(`#${BOT_PANEL_ID}`) ? active : null;
    }
    pendingFocus.current = true;
    setFocusRequest((value) => value + 1);
  }, []);

  const close = React.useCallback(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(`#${BOT_PANEL_ID}`)) {
      const stored = returnFocus.current;
      const target =
        stored?.isConnected && !stored.closest("[inert]")
          ? stored
          : (document.querySelector<HTMLElement>("[data-bot-panel-toggle]") ??
            document.querySelector<HTMLElement>("[data-app-focus-root]"));
      requestAnimationFrame(() => target?.focus());
    }
    pendingFocus.current = false;
    setState((current) => (current.open ? { ...current, open: false } : current));
  }, []);

  const show = React.useCallback(
    (tab: BotPanelTab, options?: { path?: string }) => {
      requestFocus();
      const request = options?.path ? { path: options.path, key: (fileKey.current += 1) } : null;
      setState((current) => ({ open: true, tab, fileRequest: request ?? current.fileRequest }));
    },
    [requestFocus],
  );

  const toggle = React.useCallback(() => {
    if (openRef.current) {
      close();
      return;
    }
    requestFocus();
    setState((current) => ({ ...current, open: true }));
  }, [close, requestFocus]);

  const setTab = React.useCallback(
    (tab: BotPanelTab) => setState((current) => (current.tab === tab ? current : { ...current, tab })),
    [],
  );

  const consumeFocusRequest = React.useCallback(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = false;
    return pending;
  }, []);

  const value = React.useMemo<BotPanelValue>(
    () => ({ ...state, focusRequest, show, setTab, toggle, close, consumeFocusRequest }),
    [state, focusRequest, show, setTab, toggle, close, consumeFocusRequest],
  );
  return <BotPanelContext.Provider value={value}>{children}</BotPanelContext.Provider>;
}

export function useBotPanel(): BotPanelValue {
  const value = React.useContext(BotPanelContext);
  if (!value) throw new Error("useBotPanel must be used inside BotPanelProvider.");
  return value;
}
```

- [ ] **Step 4: Wire it into the app and the test harness**

`renderer/main/root-view.tsx`:

1. Add imports:

```tsx
import { BotPanelProvider, useBotPanel } from "./bots/bot-panel-context";
import { environmentToggleTarget, isBotsPath } from "../lib/bot-routes";
```

2. In `RootView`, wrap `<CommandSystemProvider>…</CommandSystemProvider>` in `<BotPanelProvider>…</BotPanelProvider>` (inside `EnvironmentPanelProvider`), so `RootContent` can read it.
3. In `RootContent`, below `const environmentPanel = useEnvironmentPanel();`, add `const botPanel = useBotPanel();`.
4. Replace the two handlers:

```tsx
  useCommandHandler(
    "environment.toggle",
    () => {
      // In a Bot chat the shortcut is the Bot panel's; the workspace panel stays as it is.
      const target = environmentToggleTarget(pathname);
      if (target === "bot-panel") {
        botPanel.toggle();
        return;
      }
      if (target === "none") return;
      if (environmentPanel.gitOperationBusy) {
        toast.info("Wait for the current Git operation to finish before changing panels.");
        return;
      }
      environmentPanel.toggleTools();
    },
    workspaceCommands.environment,
  );
  useCommandHandler(
    "quick-view.toggle",
    () => {
      // Quick View is suppressed on Bots pages; toggling it there would change hidden state.
      if (isBotsPath(pathname)) return;
      if (environmentPanel.gitOperationBusy) {
        toast.info("Wait for the current Git operation to finish before changing panels.");
        return;
      }
      environmentPanel.toggleQuickView();
    },
    workspaceCommands.environment,
  );
```

`renderer/main/chat-layout.tsx`:

1. Add `import { isBotsPath, rememberRoute } from "../lib/bot-routes";`.
2. Below `const pathname = …`, add:

```tsx
  const href = useRouterState({ select: (state) => state.location.href });
  // ‹ in the Bots sidebar returns to the last page outside Bots (spec §9).
  React.useEffect(() => rememberRoute(href), [href]);
  // The workspace Environment, Quick View and device mini player are hidden, not
  // closed, on Bots pages: the Bot has its own panel, and leaving restores them.
  const botsSurface = isBotsPath(pathname);
```

3. Change `<EnvironmentWorkbench suppressed={onRemoteHost || studioSurface}>` to `<EnvironmentWorkbench suppressed={onRemoteHost || studioSurface || botsSurface}>`. Leave the `TerminalDrawer` condition exactly as it is.

`renderer/main/bots/test-providers.tsx`:

1. Add `import { BotPanelProvider } from "./bot-panel-context";`.
2. Add `"/profile"` and `"/scheduled"` to `BOT_TEST_PATHS` (after `"/"`).
3. Give both `mountWithBotRouter` and `createBotRouterHarness` the option type `{ initialPath?: string; queryClient?: QueryClient; sidebar?: React.ReactNode }`, and change the root route to:

```tsx
  // As in the app: the Bot panel's state outlives route changes, and a sidebar
  // (when a test passes one) stays mounted beside the routed page.
  const rootRoute = createRootRoute({
    component: () => (
      <BotPanelProvider>
        {options.sidebar}
        <Outlet />
      </BotPanelProvider>
    ),
  });
```

- [ ] **Step 5: Run the tests**

Run:
```bash
npx tsx --test renderer/main/bots/bot-panel.test.tsx renderer/lib/command-system-core.test.ts
npm run test:bots
npx tsc --noEmit && npm run lint && npm run test:ci-policy
```
Expected: the 3 provider tests PASS; every existing Bot suite still passes with the harness change; no type or lint errors.

- [ ] **Step 6: Commit**

```bash
git add renderer/main/bots/bot-panel-context.tsx renderer/main/bots/bot-panel.test.tsx renderer/main/root-view.tsx renderer/main/chat-layout.tsx renderer/main/bots/test-providers.tsx package.json scripts/ci-test-registry.json
git commit -m "Bots: Bot panel state apart from the workspace panel; route the toggle shortcut"
```

---

### Task 5: One live subscription per Bot, shared by the chat and the panel

`bots:live:subscribe` keeps one subscription per window and Bot (`main/handlers/bot-live.ts` replaces the previous one), and `useBotLive`'s cleanup calls `bots:live:unsubscribe`. Two hooks for the same Bot would therefore freeze the chat when the second unmounts. `BotLiveProvider` subscribes once; consumers inside it share that view.

**Files:**
- Modify: `renderer/lib/use-bot-live.ts` (append)
- Test: `renderer/main/bots/bot-panel.test.tsx` (append)

**Interfaces:**
- Consumes: `useBotLive(botId)`, `BotLiveView` (existing).
- Produces: `BotLiveProvider({ botId, children })`; `useSharedBotLive(botId: string | undefined): BotLiveView` (the provider's view when the ids match, else its own `useBotLive`).

- [ ] **Step 1: Write the failing test**

In `bot-panel.test.tsx`, change the first import to `import { emitBotTestNotification, installBotTestIpc } from "./test-dom";`, add `waitFor` to the `@testing-library/react` import, and add `import { BotLiveProvider, useSharedBotLive } from "../../lib/use-bot-live";`. Then append:

```tsx
function LiveProbe({ label }: { label: string }) {
  const live = useSharedBotLive("bot-1");
  return <p aria-label={label}>{live.snapshot ? `${live.snapshot.entries.length} entries` : "loading"}</p>;
}

function SharedLive({ second }: { second: boolean }) {
  return (
    <BotLiveProvider botId="bot-1">
      <LiveProbe label="Chat view" />
      {second ? <LiveProbe label="Activity view" /> : null}
    </BotLiveProvider>
  );
}

test("a Bot's chat and its Activity tab share one live subscription, and closing the tab never stops the chat's", async () => {
  const calls = installBotTestIpc({
    "bots:live:subscribe": () => ({
      botId: "bot-1",
      epoch: "e1",
      seq: 0,
      entries: [],
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
    }),
    "bots:live:unsubscribe": () => undefined,
  });
  const view = render(<SharedLive second />);
  await waitFor(() => assert.equal(screen.getByLabelText("Activity view").textContent, "0 entries"));
  view.rerender(<SharedLive second={false} />);
  emitBotTestNotification("bots:live:event", {
    botId: "bot-1",
    epoch: "e1",
    seq: 1,
    type: "entry",
    entry: { id: "u1", type: "user", text: "Plan dinners", imageCount: 0 },
  });
  await waitFor(() => assert.equal(screen.getByLabelText("Chat view").textContent, "1 entries"));
  assert.equal(calls.filter((call) => call.channel === "bots:live:subscribe").length, 1);
  assert.equal(calls.filter((call) => call.channel === "bots:live:unsubscribe").length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test renderer/main/bots/bot-panel.test.tsx`
Expected: FAIL, `BotLiveProvider` is not exported.

- [ ] **Step 3: Implement**

Append to `renderer/lib/use-bot-live.ts`:

```ts
const BotLiveContext = React.createContext<{ botId: string; view: BotLiveView } | null>(null);

/**
 * One live subscription for a Bot, shared by everything inside (the chat and
 * the side panel). Main keeps one subscription per window and Bot, so two
 * independent `useBotLive` calls would unsubscribe each other.
 */
export function BotLiveProvider({ botId, children }: React.PropsWithChildren<{ botId: string }>) {
  const view = useBotLive(botId);
  const value = React.useMemo(() => ({ botId, view }), [botId, view]);
  return React.createElement(BotLiveContext.Provider, { value }, children);
}

/** The shared view when a `BotLiveProvider` for this Bot is above, else a subscription of its own. */
export function useSharedBotLive(botId: string | undefined): BotLiveView {
  const shared = React.useContext(BotLiveContext);
  const owned = shared !== null && shared.botId === botId;
  const own = useBotLive(owned ? undefined : botId);
  return owned ? shared.view : own;
}
```

In the same file, make `useBotLive`'s returned object stable so the memo above holds: replace `return { snapshot, failed, reload };` with `return React.useMemo(() => ({ snapshot, failed, reload }), [snapshot, failed, reload]);`.

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test renderer/main/bots/bot-panel.test.tsx renderer/main/bots/bot-chat-pane.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/lib/use-bot-live.ts renderer/main/bots/bot-panel.test.tsx
git commit -m "Bots: one live subscription per Bot, shared by the chat and the panel"
```

---

### Task 6: The Activity log

**Files:**
- Create: `renderer/main/bots/bot-activity-log.ts`
- Test: `renderer/main/bots/bot-activity-log.test.ts`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json` (`renderer-other`)

**Interfaces:**
- Consumes: B's `BotTranscriptEntry` (tool calls with `kind`, `label`, `detail?`, `app?`; results with `status`), `BotRecapStep`.
- Produces:
  - `interface BotActivityReply { id: string; title: string; routine: boolean; at?: number; steps: BotRecapStep[] }`
  - `BOT_ACTIVITY_TITLE_CHARS = 60`
  - `botActivityLog(entries: readonly BotTranscriptEntry[], options: { running: boolean }): BotActivityReply[]` (newest reply first; steps in the order they ran; replies with no steps left out)
  - `formatBotActivityWhen(at: number | undefined, now: number): string` ("Today, 6:41 PM", "Yesterday, 9:05 AM", "Oct 6, 7:00 PM", "Earlier")

- [ ] **Step 1: Write the failing tests**

```ts
// renderer/main/bots/bot-activity-log.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotTranscriptEntry, BotTranscriptToolCall } from "../../shared/bot-live";
import { BOT_ACTIVITY_TITLE_CHARS, botActivityLog, formatBotActivityWhen } from "./bot-activity-log";

const call = (id: string, name: string, kind: BotTranscriptToolCall["kind"], label: string, detail?: string): BotTranscriptToolCall => ({
  id,
  name,
  kind,
  label,
  ...(detail ? { detail } : {}),
});

const result = (callId: string, status: "ok" | "failed" | "blocked"): BotTranscriptEntry => ({
  id: `${callId}:result`,
  type: "tool_result",
  toolCallId: callId,
  toolName: "tool",
  isError: status !== "ok",
  status,
});

const working = (id: string, calls: BotTranscriptToolCall[], at?: number): BotTranscriptEntry => ({
  id,
  type: "assistant",
  text: "",
  toolCalls: calls,
  stopReason: "toolUse",
  ...(at === undefined ? {} : { at }),
});

const answer = (id: string, text: string): BotTranscriptEntry => ({ id, type: "assistant", text, toolCalls: [], stopReason: "stop" });

const ENTRIES: BotTranscriptEntry[] = [
  { id: "r1", type: "routine", label: "Sunday plan", text: "Plan next week", at: 100 },
  working("a1", [call("c1", "read_file", "reading", "Read 1 file", "pantry.md")]),
  result("c1", "ok"),
  answer("a2", "Planned."),
  { id: "u1", type: "user", text: "Ask me nothing", imageCount: 0, at: 150 },
  answer("a3", "Sure."),
  { id: "u2", type: "user", text: "Plan dinners for this week", imageCount: 0, at: 200 },
  working("a4", [
    call("c2", "web_search", "searching", "Searched the web", "dairy-free dinners"),
    call("c3", "run_command", "command", "Ran a command"),
  ]),
  result("c2", "ok"),
  result("c3", "failed"),
  working("a5", [call("c4", "edit_file", "editing", "Edited 1 file", "meal-plan.md")]),
  result("c4", "blocked"),
  answer("a6", "Here's your week."),
];

test("replies come newest first, each with its steps in the order they ran, and a reply with no steps is left out", () => {
  const log = botActivityLog(ENTRIES, { running: false });
  assert.deepEqual(log.map((reply) => reply.title), ["Plan dinners for this week", "Sunday plan"]);
  assert.deepEqual(
    log[0]!.steps.map((step) => [step.label, step.detail ?? null, step.status]),
    [
      ["Searched the web", "dairy-free dinners", "ok"],
      ["Ran a command", null, "failed"],
      ["Edited 1 file", "meal-plan.md", "blocked"],
    ],
  );
  assert.equal(log[0]!.at, 200);
});

test("a routine run carries the routine's name", () => {
  const routine = botActivityLog(ENTRIES, { running: false }).find((reply) => reply.routine);
  assert.equal(routine?.title, "Sunday plan");
  assert.equal(routine?.steps[0]?.detail, "pantry.md");
});

test("a step still running reads as failed once the Bot stopped, but stays running in the live reply", () => {
  const unfinished = [...ENTRIES.slice(0, 6), { id: "u3", type: "user", text: "Next", imageCount: 0 } as BotTranscriptEntry, working("a7", [call("c5", "grep", "reading", "Read 1 file")])];
  assert.equal(botActivityLog(unfinished, { running: true })[0]!.steps[0]!.status, "running");
  assert.equal(botActivityLog(unfinished, { running: false })[0]!.steps[0]!.status, "failed");
  const older = [...unfinished, { id: "u4", type: "user", text: "Again", imageCount: 0 } as BotTranscriptEntry];
  assert.equal(botActivityLog(older, { running: true }).find((reply) => reply.id === "u3")?.steps[0]?.status, "failed");
});

test("a long message makes a short title, and a photo-only message reads as Photo", () => {
  const long = "word ".repeat(40);
  const log = botActivityLog(
    [
      { id: "u1", type: "user", text: long, imageCount: 0 },
      working("a1", [call("c1", "grep", "reading", "Read 1 file")]),
      { id: "u2", type: "user", text: "", imageCount: 1 },
      working("a2", [call("c2", "inspect_image", "photo", "Looked at your photo")]),
    ],
    { running: false },
  );
  assert.equal(log[0]!.title, "Photo");
  assert.ok([...log[1]!.title].length <= BOT_ACTIVITY_TITLE_CHARS);
  assert.ok(log[1]!.title.endsWith("…"));
});

test("reply times read as today, yesterday, or a date, each with the time", () => {
  const now = new Date(2026, 9, 14, 18, 0).getTime();
  assert.match(formatBotActivityWhen(new Date(2026, 9, 14, 9, 5).getTime(), now), /^Today, \S/u);
  assert.match(formatBotActivityWhen(new Date(2026, 9, 13, 23, 0).getTime(), now), /^Yesterday, \S/u);
  const older = new Date(2026, 9, 6, 19, 0);
  const olderDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(older);
  assert.ok(formatBotActivityWhen(older.getTime(), now).startsWith(`${olderDay}, `), "an older reply names its date");
  assert.equal(formatBotActivityWhen(undefined, now), "Earlier");
});
```

Register: append ` renderer/main/bots/bot-activity-log.test.ts` to `package.json` `test:bots`; add `"renderer/main/bots/bot-activity-log.test.ts",` after `"renderer/main/bots/bot-panel.test.tsx",` in `renderer-other`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-activity-log.test.ts`
Expected: FAIL, cannot find module `./bot-activity-log`.

- [ ] **Step 3: Implement**

```ts
// renderer/main/bots/bot-activity-log.ts
// The side panel's Activity tab (spec §8): every step of every reply, newest
// reply first, grouped under the message or routine that started it. Built
// from the transcript tool calls slice B enriched; read-only.

import type { BotTranscriptEntry } from "../../shared/bot-live";
import type { BotRecapStep } from "./bot-activity-steps";

export interface BotActivityReply {
  id: string;
  /** The person's message, shortened, or the routine's name. */
  title: string;
  routine: boolean;
  at?: number;
  steps: BotRecapStep[];
}

export const BOT_ACTIVITY_TITLE_CHARS = 60;

type OpenReply = BotActivityReply & { byCall: Map<string, BotRecapStep> };

function shortTitle(text: string, fallback: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  if (!line) return fallback;
  const points = [...line];
  return points.length > BOT_ACTIVITY_TITLE_CHARS
    ? `${points.slice(0, BOT_ACTIVITY_TITLE_CHARS - 1).join("").trimEnd()}…`
    : line;
}

function openReply(id: string, title: string, routine: boolean, at: number | undefined): OpenReply {
  return { id, title, routine, ...(at === undefined ? {} : { at }), steps: [], byCall: new Map() };
}

export function botActivityLog(
  entries: readonly BotTranscriptEntry[],
  { running }: { running: boolean },
): BotActivityReply[] {
  const replies: OpenReply[] = [];
  let current: OpenReply | null = null;
  for (const entry of entries) {
    if (entry.type === "user") {
      const photos = entry.imageCount === 1 ? "Photo" : `${entry.imageCount} photos`;
      current = openReply(entry.id, shortTitle(entry.text, entry.imageCount > 0 ? photos : "Message"), false, entry.at);
      replies.push(current);
    } else if (entry.type === "question_answer") {
      current = openReply(entry.id, shortTitle(entry.text, "Answer"), false, entry.at);
      replies.push(current);
    } else if (entry.type === "routine") {
      current = openReply(entry.id, entry.label, true, entry.at);
      replies.push(current);
    } else if (entry.type === "assistant") {
      if (!current) {
        // A reply with no visible input (the self-intro) still gets a group.
        current = openReply(entry.id, "Reply", false, entry.at);
        replies.push(current);
      }
      for (const call of entry.toolCalls) {
        const step: BotRecapStep = {
          id: call.id,
          kind: call.kind,
          label: call.label,
          ...(call.detail ? { detail: call.detail } : {}),
          ...(call.app ? { app: call.app } : {}),
          status: "running",
        };
        current.steps.push(step);
        current.byCall.set(call.id, step);
      }
    } else if (entry.type === "tool_result") {
      const step = current?.byCall.get(entry.toolCallId);
      if (step) step.status = entry.status;
    }
  }
  const liveId = running ? replies[replies.length - 1]?.id : undefined;
  return replies
    .filter((reply) => reply.steps.length > 0)
    .map(({ byCall: _byCall, ...reply }) => ({
      ...reply,
      steps: reply.steps.map((step) =>
        step.status === "running" && reply.id !== liveId ? { ...step, status: "failed" as const } : step,
      ),
    }))
    .reverse();
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** "Today, 6:41 PM", "Yesterday, 9:05 AM", "Oct 6, 7:00 PM"; "Earlier" when the time is unknown. */
export function formatBotActivityWhen(at: number | undefined, now: number): string {
  if (at === undefined) return "Earlier";
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  const time = clock.format(at);
  if (days <= 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${day.format(at)}, ${time}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test renderer/main/bots/bot-activity-log.test.ts && npx tsc --noEmit && npm run test:ci-policy`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add renderer/main/bots/bot-activity-log.ts renderer/main/bots/bot-activity-log.test.ts package.json scripts/ci-test-registry.json
git commit -m "Bots: the Activity log, every step grouped by reply"
```

---
### Task 7: The Bot side panel on the workbench shell

This task answers C1's remaining risks. **Focus-on-open lives in workspace code**: `BotWorkbench` focuses the selected tab after a person-initiated open (`consumeFocusRequest`), keeps focus on the selected tab while arrow keys move through the strip, and `BotPanelProvider.close` returns focus to the opener or the header toggle. **The panel keeps a hard-coded `#environment-panel` id**: the Bot panel passes `id="bot-panel"` / `idPrefix="bot-panel"`, and its own Escape handler closes it (the workspace Escape handler is not installed while the workspace surfaces are suppressed on Bots pages).

**Files:**
- Create: `renderer/main/bots/bot-workbench.tsx`, `renderer/main/bots/bot-panel-activity.tsx`, `renderer/main/bots/bot-panel-files.tsx`
- Modify: `renderer/main/bots/bot-memory-page.tsx` (extract `BotMemoryContent`; `compact` groups)
- Modify: `renderer/main/bot-chat-route.tsx`, `renderer/main/bots/bot-chat-header.tsx` (add `BotPanelToggle`), `renderer/main/bots/bot-chat-pane.tsx` (shared live; toggle in the header)
- Test: `renderer/main/bots/bot-panel.test.tsx` (append)

**Interfaces:**
- Consumes: `WorkbenchPanel`, `WorkbenchTab`, `WorkbenchView`, `useWorkbenchWidth` (C1); `resolveEnvironmentPanelLayout`; `BotPanelProvider`/`useBotPanel`, `BOT_PANEL_*` (Task 4); `BotLiveProvider`, `useSharedBotLive` (Task 5); `botActivityLog`, `formatBotActivityWhen` (Task 6); `botStepLine`, `BotRecapStep` (B); `BotRoutines` (existing).
- Produces:
  - `BotWorkbench({ botId, children })` (wraps a Bot chat).
  - `BotPanelActivity({ botName, entries, running, loading, now? })`.
  - `BotPanelFiles({ botId, botName, active, request }: { …; active: boolean; request: BotPanelFileRequest | null })`.
  - `BotMemoryContent({ bot, compact? }: { bot: Pick<BotDefinition, "id" | "name">; compact?: boolean })` exported from `bot-memory-page.tsx`; `BotMemoryPage` renders it inside `BotPageShell`.
  - `BotPanelToggle()` exported from `bot-chat-header.tsx` ("Show panel" / "Hide panel", `data-bot-panel-toggle`).

- [ ] **Step 1: Write the failing tests**

Add `within` to the `@testing-library/react` import of `renderer/main/bots/bot-panel.test.tsx`, and add:

```tsx
import type { BotMemoryView } from "../../shared/bot-memory";
import type { BotTranscriptEntry } from "../../shared/bot-live";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";
```

Append:

```tsx
function chatSnapshot(entries: BotTranscriptEntry[] = []) {
  return {
    botId: "bot-1",
    epoch: "e1",
    seq: 0,
    entries,
    partial: null,
    state: { kind: "idle" },
    question: null,
    activity: null,
    queued: [],
  };
}

const FILE_HANDLERS = {
  "bots:files:list": () => ({
    entries: [
      { path: "lists", name: "lists", parentPath: "", depth: 0, kind: "directory" },
      { path: "lists/groceries.md", name: "groceries.md", parentPath: "lists", depth: 1, kind: "file" },
    ],
    truncated: false,
    skippedDirectories: 0,
  }),
  "bots:files:read": (_botId: unknown, path: unknown) => ({ path, content: "eggs\nmilk", size: 9, modifiedAt: 1, version: "v1" }),
};

async function mountBotChat(handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls = installBotTestIpc({
    "bots:get": () => botFixture(),
    "bots:pendingApprovals": () => [],
    "bots:live:subscribe": () => chatSnapshot(),
    "bots:live:unsubscribe": () => undefined,
    "bots:routines:list": () => [],
    ...handlers,
  });
  const mounted = await mountWithBotRouter(null, { initialPath: "/bots/bot-1/chat" });
  await screen.findByRole("button", { name: "Planner profile" });
  return { calls, ...mounted };
}

const botPanel = () => screen.getByRole("complementary", { name: "Bot panel", hidden: true });
const panelTab = (name: string) => within(botPanel()).getByRole("tab", { name });

test("the panel toggle opens the Bot panel with only Bot tabs, focused on the selected tab, and Close gives focus back", async () => {
  await mountBotChat();
  assert.equal(botPanel().getAttribute("data-state"), "closed");
  const toggle = screen.getByRole("button", { name: "Show panel" });
  toggle.focus();
  fireEvent.click(toggle);
  assert.equal(botPanel().getAttribute("data-state"), "open");
  assert.deepEqual(
    within(botPanel()).getAllByRole("tab").map((tab) => tab.textContent),
    ["Activity", "Files", "Memory", "Routines"],
  );
  assert.equal(within(botPanel()).queryByRole("button", { name: /^Close .+ tab$/u }), null, "Bot tabs are fixed");
  assert.equal(within(botPanel()).queryByRole("button", { name: "New workspace tab" }), null);
  await waitFor(() => assert.equal(document.activeElement, panelTab("Activity")));
  fireEvent.keyDown(panelTab("Activity"), { key: "ArrowRight" });
  await waitFor(() => assert.equal(document.activeElement, panelTab("Files")));
  assert.equal(panelTab("Files").getAttribute("aria-selected"), "true");
  assert.equal(screen.getByRole("button", { name: "Hide panel" }).getAttribute("aria-pressed"), "true");
  fireEvent.click(within(botPanel()).getByRole("button", { name: "Close Bot panel" }));
  assert.equal(botPanel().getAttribute("data-state"), "closed");
  await waitFor(() => assert.equal(document.activeElement, screen.getByRole("button", { name: "Show panel" })));
});

test("Escape inside the Bot panel closes it and leaves the workspace panel's saved state alone", async () => {
  localStorage.setItem("aiden-agent.environment.open", "true");
  localStorage.setItem("aiden-agent.environment.open-tabs-v1", JSON.stringify(["files"]));
  await mountBotChat();
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Routines"));
  panelTab("Routines").focus();
  fireEvent.keyDown(panelTab("Routines"), { key: "Escape" });
  assert.equal(botPanel().getAttribute("data-state"), "closed");
  assert.equal(localStorage.getItem("aiden-agent.environment.open"), "true");
  assert.equal(localStorage.getItem("aiden-agent.environment.open-tabs-v1"), JSON.stringify(["files"]));
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  assert.equal(panelTab("Routines").getAttribute("aria-selected"), "true", "it reopens where it was");
});

test("Activity lists every step newest reply first, names a routine run, and tells failed from blocked", async () => {
  const today = new Date().setHours(12, 0, 0, 0);
  const yesterday = new Date(today).setDate(new Date(today).getDate() - 1);
  const { calls } = await mountBotChat({
    "bots:live:subscribe": () =>
      chatSnapshot([
        { id: "r1", type: "routine", label: "Sunday plan", text: "Plan next week", at: yesterday },
        { id: "a1", type: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", kind: "reading", label: "Read 1 file", detail: "pantry.md" }], stopReason: "toolUse", at: yesterday },
        { id: "t1", type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, status: "ok" },
        { id: "a2", type: "assistant", text: "Planned.", toolCalls: [], stopReason: "stop", at: yesterday },
        { id: "u1", type: "user", text: "Plan dinners for this week", imageCount: 0, at: today },
        {
          id: "a3",
          type: "assistant",
          text: "",
          toolCalls: [
            { id: "c2", name: "web_search", kind: "searching", label: "Searched the web", detail: "dairy-free dinners" },
            { id: "c3", name: "run_command", kind: "command", label: "Ran a command" },
            { id: "c4", name: "edit_file", kind: "editing", label: "Edited 1 file", detail: "meal-plan.md" },
          ],
          stopReason: "toolUse",
          at: today,
        },
        { id: "t2", type: "tool_result", toolCallId: "c2", toolName: "web_search", isError: false, status: "ok" },
        { id: "t3", type: "tool_result", toolCallId: "c3", toolName: "run_command", isError: true, status: "failed" },
        { id: "t4", type: "tool_result", toolCallId: "c4", toolName: "edit_file", isError: true, status: "blocked" },
        { id: "a4", type: "assistant", text: "Here's your week.", toolCalls: [], stopReason: "stop", at: today },
      ]),
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  const headings = await within(botPanel()).findAllByRole("heading");
  assert.match(headings[0]!.textContent ?? "", /^Today, .+ · Plan dinners for this week$/u);
  assert.match(headings[1]!.textContent ?? "", /^Yesterday, .+ · Sunday plan \(routine\)$/u);
  const steps = within(botPanel()).getAllByRole("listitem").map((item) => item.textContent);
  assert.deepEqual(steps, [
    "Searched the web · dairy-free dinners",
    "Couldn’t run a command",
    "Blocked: edit a file · meal-plan.md",
    "Read 1 file · pantry.md",
  ]);
  assert.equal(calls.filter((call) => call.channel === "bots:live:subscribe").length, 1, "the chat and Activity share one subscription");
});

test("Files lists the Bot's folder and opens a file read-only, with All files to go back", async () => {
  const { calls } = await mountBotChat(FILE_HANDLERS);
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Files"));
  fireEvent.click(await within(botPanel()).findByRole("button", { name: "groceries.md" }));
  assert.equal((await within(botPanel()).findByLabelText("Contents of lists/groceries.md")).textContent, "eggs\nmilk");
  assert.deepEqual(calls.find((call) => call.channel === "bots:files:read")?.args, ["bot-1", "lists/groceries.md"]);
  fireEvent.click(within(botPanel()).getByRole("button", { name: "All files" }));
  assert.ok(await within(botPanel()).findByRole("list", { name: "Files" }));
});

function memoryView(entries: { id: string; text: string }[]): BotMemoryView {
  const store = (list: { id: string; text: string }[], limitChars: number) => ({
    entries: list,
    usedChars: list.reduce((sum, entry) => sum + entry.text.length, 0),
    limitChars,
    overBudget: false,
  });
  return { botId: "bot-1", revision: `rev-${entries.length}`, readable: true, user: store(entries, 1_375), memory: store([], 2_200), updatedAt: 1 };
}

test("Memory in the panel edits an entry exactly as Profile → Memory does", async () => {
  const edits: unknown[] = [];
  await mountBotChat({
    "bots:memory:get": () => memoryView([{ id: "u-short", text: "Prefers short answers." }]),
    "bots:memory:edit": (input) => {
      edits.push((input as { edit: unknown }).edit);
      return { ok: true, view: memoryView([{ id: "u-short", text: "Prefers short, friendly answers." }]) };
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Memory"));
  assert.ok(await within(botPanel()).findByText("Prefers short answers."));
  fireEvent.keyDown(within(botPanel()).getByRole("button", { name: "Memory options" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit memory" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Memory" }), { target: { value: "Prefers short, friendly answers." } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    assert.deepEqual(edits, [{ kind: "replace", target: "user", entryId: "u-short", text: "Prefers short, friendly answers." }]),
  );
  assert.ok(await within(botPanel()).findByText("Prefers short, friendly answers."));
});

test("Routines in the panel lists the Bot's routines and offers Add routine", async () => {
  await mountBotChat({
    "bots:routines:list": () => [
      {
        id: "task-1",
        botId: "bot-1",
        name: "Weekly meal prep",
        prompt: "Plan this week's meals.",
        schedule: { kind: "weekly", days: [0], time: "08:41" },
        timezone: "UTC",
        label: "Every Sunday at 8:41 AM",
        enabled: true,
        updatedAt: 10,
      },
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Show panel" }));
  fireEvent.click(panelTab("Routines"));
  const list = await within(botPanel()).findByRole("list", { name: "Routines" });
  assert.ok(within(list).getByText("Every Sunday at 8:41 AM"));
  fireEvent.click(within(botPanel()).getByRole("button", { name: /Add routine/u }));
  assert.ok(await screen.findByRole("dialog", { name: "Add routine" }));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-panel.test.tsx`
Expected: FAIL. There is no "Show panel" button.

- [ ] **Step 3: Extract `BotMemoryContent`**

In `renderer/main/bots/bot-memory-page.tsx`:

1. Give `MemoryGroup` a `compact?: boolean` prop (add `compact = false,` to the destructuring and `compact?: boolean;` to its type), and change its `<section>` and `<h2>` classes to:

```tsx
    <section aria-labelledby={titleId} className={compact ? "settings-group mb-5" : "settings-group mb-7"}>
      <h2
        id={titleId}
        className={
          compact
            ? "settings-group-title mb-2 px-4 text-strong text-primary"
            : "settings-group-title mb-3 px-4 text-large-strong text-primary"
        }
      >
```

2. Rename `export function BotMemoryPage({ bot, onClose }: …)` to `export function BotMemoryContent({ bot, compact = false }: { bot: Pick<BotDefinition, "id" | "name">; compact?: boolean })`. Pass `compact={compact}` to both `<MemoryGroup …>`s. Replace its `return (<BotPageShell …>{body}…</BotPageShell>);` with the same children in a fragment:

```tsx
  return (
    <>
      {body}
      {editing ? (
        <EditMemoryDialog
          key={`${editing.target}:${editing.entry.id}`}
          botId={bot.id}
          target={editing.target}
          title={groupTitle(editing.target, bot.name)}
          entry={editing.entry}
          onClose={() => setEditing(null)}
          onView={onView}
        />
      ) : null}
      <AlertDialog
        open={erasing}
        onOpenChange={(open) => {
          if (!erasingBusy) setErasing(open);
        }}
        title={`Erase everything ${bot.name} remembers?`}
        description="This can’t be undone."
        confirmLabel="Erase memory"
        confirmVariant="destructive"
        busy={erasingBusy}
        keepOpenOnConfirm
        onConfirm={erase}
      />
    </>
  );
}
```

3. Add the page back as a thin shell:

```tsx
/** Profile → Memory: the same content as the side panel's Memory tab, as a full page. */
export function BotMemoryPage({
  bot,
  onClose,
}: {
  bot: Pick<BotDefinition, "id" | "name">;
  onClose(): void;
}) {
  return (
    <BotPageShell
      scrollId={`bot-memory:${bot.id}`}
      title={bot.name}
      backLabel="Back"
      onBack={onClose}
      heading="Memory"
      description={`What ${bot.name} remembers about you and its work. It’s stored on this Mac, and ${bot.name} uses it in every chat.`}
    >
      <BotMemoryContent bot={bot} />
    </BotPageShell>
  );
}
```

- [ ] **Step 4: Write the Activity and Files tabs**

```tsx
// renderer/main/bots/bot-panel-activity.tsx
// Activity (spec §8): every step of every reply, newest reply first, grouped by
// the message or routine that started it. Red is a failure, amber a refusal,
// with B's step wording; the live step shimmers (only with motion allowed).

import * as React from "react";
import { EmptyState } from "../../components/ui";
import { cn } from "../../lib/ui-utils";
import type { BotTranscriptEntry } from "../../shared/bot-live";
import { botActivityLog, formatBotActivityWhen, type BotActivityReply } from "./bot-activity-log";
import { botStepLine, type BotRecapStep } from "./bot-activity-steps";

const TONE: Record<"normal" | "warning" | "error", string> = {
  normal: "text-secondary",
  warning: "text-support-warning",
  error: "text-red",
};

function ActivityStep({ step }: { step: BotRecapStep }) {
  const line = botStepLine(step);
  return (
    <div role="listitem" className="flex min-h-6 min-w-0 items-start py-0.5 text-small">
      <span className={cn("min-w-0 break-words", line.active && "agent-thinking-shimmer")}>
        <span className={cn("font-medium", TONE[line.tone])}>{line.text}</span>
        {line.detail ? <span className="text-tertiary"> · {line.detail}</span> : null}
      </span>
    </div>
  );
}

function ActivityReply({ reply, now }: { reply: BotActivityReply; now: number }) {
  const headingId = React.useId();
  const title = reply.routine ? `${reply.title} (routine)` : reply.title;
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="mb-1 text-small text-tertiary">
        {`${formatBotActivityWhen(reply.at, now)} · ${title}`}
      </h3>
      <div role="list" aria-label={`Steps for ${title}`} className="flex flex-col">
        {reply.steps.map((step) => (
          <ActivityStep key={step.id} step={step} />
        ))}
      </div>
    </section>
  );
}

export function BotPanelActivity({
  botName,
  entries,
  running,
  loading,
  now = Date.now(),
}: {
  botName: string;
  entries: readonly BotTranscriptEntry[];
  running: boolean;
  loading: boolean;
  now?: number;
}) {
  const replies = React.useMemo(() => botActivityLog(entries, { running }), [entries, running]);
  if (loading) {
    return (
      <div role="status" aria-label="Loading activity" className="flex flex-col gap-2">
        {[0, 1, 2].map((row) => (
          <span key={row} className="h-3 w-full rounded-full bg-control motion-safe:animate-pulse" />
        ))}
      </div>
    );
  }
  if (replies.length === 0) {
    return (
      <EmptyState
        placement="inline"
        title="No activity yet"
        description={`When ${botName} reads, searches or edits something, every step shows up here.`}
      />
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {replies.map((reply) => (
        <ActivityReply key={reply.id} reply={reply} now={now} />
      ))}
    </div>
  );
}
```

```tsx
// renderer/main/bots/bot-panel-files.tsx
// Files (spec §8): the files in the Bot's own folder, read-only, with a simple
// text viewer. Replaces the old Files dialog. A file chip in the chat opens
// this tab on that file through the panel's file request.

import * as React from "react";
import { ChevronLeft, File, Folder, RotateCcw } from "lucide-react";
import { Button, Callout, EmptyState, Text } from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import type { WorkspaceFileDocument, WorkspaceFileIndex } from "../../lib/types";
import type { BotPanelFileRequest } from "./bot-panel-context";

type Load<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; message: string };

export function BotPanelFiles({
  botId,
  botName,
  active,
  request,
}: {
  botId: string;
  botName: string;
  /** The tab is visible: the list is read each time it comes into view. */
  active: boolean;
  request: BotPanelFileRequest | null;
}) {
  const [index, setIndex] = React.useState<Load<WorkspaceFileIndex>>({ status: "loading" });
  const [path, setPath] = React.useState<string | null>(request?.path ?? null);
  const [document, setDocument] = React.useState<Load<WorkspaceFileDocument> | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const requestedPath = request?.path ?? null;
  const requestKey = request?.key ?? 0;

  React.useEffect(() => {
    if (requestedPath !== null) setPath(requestedPath);
  }, [requestedPath, requestKey]);

  React.useEffect(() => {
    if (!active) return;
    let current = true;
    setIndex({ status: "loading" });
    botsApi.files.list(botId).then(
      (value) => current && setIndex({ status: "ready", value }),
      (error: unknown) =>
        current &&
        setIndex({ status: "failed", message: userFacingErrorMessage(error, `Aiden couldn’t load ${botName}’s files.`) }),
    );
    return () => {
      current = false;
    };
  }, [active, botId, botName, attempt]);

  React.useEffect(() => {
    if (path === null) {
      setDocument(null);
      return;
    }
    if (!active) return;
    let current = true;
    setDocument({ status: "loading" });
    botsApi.files.read(botId, path).then(
      (value) => current && setDocument({ status: "ready", value }),
      (error: unknown) =>
        current && setDocument({ status: "failed", message: userFacingErrorMessage(error, "Aiden couldn’t open that file.") }),
    );
    return () => {
      current = false;
    };
  }, [active, botId, path, attempt]);

  const retry = (message: string) => (
    <Callout color="red" role="alert" className="flex-row items-center justify-between gap-3">
      <Text variant="small" color="red">
        {message}
      </Text>
      <Button size="small" variant="filled" onClick={() => setAttempt((value) => value + 1)}>
        <RotateCcw /> Try again
      </Button>
    </Callout>
  );
  const loading = (label: string) => (
    <div role="status" aria-label={label} className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-7 w-full rounded-control bg-well motion-safe:animate-pulse" />
      ))}
    </div>
  );

  if (path !== null) {
    return (
      <div className="flex min-h-0 flex-col gap-2">
        <div>
          <Button variant="transparent" size="small" onClick={() => setPath(null)}>
            <ChevronLeft aria-hidden="true" />
            All files
          </Button>
        </div>
        <Text as="h3" variant="strong" className="truncate px-1" title={path}>
          {path.split("/").pop() || path}
        </Text>
        {document === null || document.status === "loading" ? (
          loading("Opening file")
        ) : document.status === "failed" ? (
          retry(document.message)
        ) : (
          <pre
            aria-label={`Contents of ${document.value.path}`}
            className="select-text whitespace-pre-wrap break-words rounded-card bg-well p-3 font-mono text-small text-primary"
          >
            {document.value.content}
          </pre>
        )}
      </div>
    );
  }

  const files = index.status === "ready" ? index.value.entries : [];
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Text as="p" variant="small" color="secondary" className="px-1">
        {`Files ${botName} made or saved while helping you.`}
      </Text>
      {index.status === "loading" ? (
        loading("Loading files")
      ) : index.status === "failed" ? (
        retry(index.message)
      ) : files.length === 0 ? (
        <EmptyState
          placement="inline"
          title="No files yet"
          description={`When ${botName} writes a list, a note, or a plan, it shows up here.`}
        />
      ) : (
        <ul aria-label="Files" className="flex flex-col gap-0.5">
          {files.map((entry) => (
            <li key={entry.path} style={{ paddingLeft: `${entry.depth * 16}px` }}>
              {entry.kind === "file" ? (
                <Button variant="transparent" size="medium" className="w-full justify-start gap-2" onClick={() => setPath(entry.path)}>
                  <File aria-hidden="true" className="text-secondary" />
                  <span className="truncate">{entry.name}</span>
                </Button>
              ) : (
                <span className="flex h-8 items-center gap-2 px-4 text-secondary">
                  <Folder aria-hidden="true" className="size-4" />
                  <span className="truncate">{entry.name}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Write the workbench**

```tsx
// renderer/main/bots/bot-workbench.tsx
// The Bot side panel (spec §8) on the C1 workbench shell, beside a Bot's chat:
// fixed Activity, Files, Memory and Routines tabs. A tab's body mounts the first
// time it is shown, then stays mounted like the workspace views. The panel has
// its own state, id, width key, focus hand-off and Escape, so the workspace
// Environment panel (suppressed on Bots pages) is never touched.

import * as React from "react";
import { CalendarClock, Files, ListChecks } from "lucide-react";
import { MemoryCardIcon } from "../../components/memory-card-icon";
import { WorkbenchPanel, useWorkbenchWidth, type WorkbenchTab, type WorkbenchView } from "../../components/workbench-panel";
import { resolveEnvironmentPanelLayout } from "../../lib/environment-panel-layout";
import { useBot } from "../../lib/queries";
import { cn } from "../../lib/ui-utils";
import { BotLiveProvider, useSharedBotLive } from "../../lib/use-bot-live";
import { BotMemoryContent } from "./bot-memory-page";
import { BotPanelActivity } from "./bot-panel-activity";
import { BOT_PANEL_ID, BOT_PANEL_TABS, BOT_PANEL_WIDTH_KEY, useBotPanel, type BotPanelTab } from "./bot-panel-context";
import { BotPanelFiles } from "./bot-panel-files";
import { BotRoutines } from "./bot-routines";

const TAB_META: Record<BotPanelTab, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  activity: { label: "Activity", icon: ListChecks },
  files: { label: "Files", icon: Files },
  memory: { label: "Memory", icon: MemoryCardIcon },
  routines: { label: "Routines", icon: CalendarClock },
};

export function BotWorkbench({ botId, children }: React.PropsWithChildren<{ botId: string }>) {
  return (
    <BotLiveProvider botId={botId}>
      <BotWorkbenchLayout botId={botId}>{children}</BotWorkbenchLayout>
    </BotLiveProvider>
  );
}

function BotWorkbenchLayout({ botId, children }: React.PropsWithChildren<{ botId: string }>) {
  const panel = useBotPanel();
  const { open, tab, fileRequest, focusRequest, close, consumeFocusRequest, setTab } = panel;
  const bot = useBot(botId).data ?? null;
  const live = useSharedBotLive(botId);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const activeTabRef = React.useRef<HTMLButtonElement | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(() => window.innerWidth);
  const panelWidth = useWorkbenchWidth(BOT_PANEL_WIDTH_KEY);
  const { width, inline } = resolveEnvironmentPanelLayout(panelWidth.preferredWidth, containerWidth);
  const [visited, setVisited] = React.useState<ReadonlySet<BotPanelTab>>(() => new Set());

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setContainerWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setVisited((current) => (current.has(tab) ? current : new Set([...current, tab])));
  }, [open, tab]);

  // A person-initiated open focuses the selected tab; a panel restored open at launch does not.
  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (consumeFocusRequest()) activeTabRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, tab, focusRequest, consumeFocusRequest]);

  // Arrow keys in the strip select a tab; focus follows the one tab stop.
  React.useEffect(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.getAttribute("role") === "tab" &&
      active.closest(`#${BOT_PANEL_ID}`) &&
      active !== activeTabRef.current
    ) {
      activeTabRef.current?.focus();
    }
  }, [tab]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !active.closest(`#${BOT_PANEL_ID}`)) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  const tabs: WorkbenchTab[] = BOT_PANEL_TABS.map((id) => ({
    id,
    viewId: id,
    label: TAB_META[id].label,
    icon: TAB_META[id].icon,
    selected: tab === id,
    closable: false,
  }));
  const running = live.snapshot?.state.kind === "running";
  const body = (id: BotPanelTab, active: boolean): React.ReactNode => {
    if (!bot) return null;
    switch (id) {
      case "activity":
        return (
          <BotPanelActivity
            botName={bot.name}
            entries={live.snapshot?.entries ?? []}
            running={running}
            loading={live.snapshot === null && !live.failed}
          />
        );
      case "files":
        return <BotPanelFiles botId={bot.id} botName={bot.name} active={active} request={fileRequest} />;
      case "memory":
        return <BotMemoryContent bot={bot} compact />;
      case "routines":
        return <BotRoutines bot={bot} />;
    }
  };
  const views: WorkbenchView[] = BOT_PANEL_TABS.map((id) => ({
    id,
    render: ({ presented, selected }) =>
      visited.has(id) ? (
        <div className="h-full min-h-0 overflow-y-auto px-3 py-4">{body(id, presented && selected)}</div>
      ) : null,
  }));

  return (
    <div ref={containerRef} className="relative flex h-full min-h-0 w-full flex-1 overflow-clip">
      <div className="h-full min-h-0 min-w-0 flex-1">{children}</div>
      <div
        aria-hidden="true"
        className={cn(
          "h-full shrink-0 transition-[width] duration-300 ease-out motion-reduce:transition-none",
          panelWidth.resizing && "transition-none",
        )}
        style={{ width: open && inline ? width : 0 }}
      />
      <WorkbenchPanel
        id={BOT_PANEL_ID}
        label="Bot panel"
        resizeLabel="Resize Bot panel"
        open={open}
        presented={open}
        inline={inline}
        width={width}
        containerWidth={containerWidth}
        resizing={panelWidth.resizing}
        onResizingChange={panelWidth.setResizing}
        onWidthChange={panelWidth.setPreferredWidth}
        onWidthCommit={panelWidth.commitPreferredWidth}
        views={views}
        selectedViewId={tab}
        activeTabRef={activeTabRef}
        tabs={tabs}
        idPrefix={BOT_PANEL_ID}
        tabListLabel="Bot panel views"
        onSelectTab={(entry) => setTab(entry.viewId as BotPanelTab)}
        onCloseTab={() => undefined}
        closeLabel="Close Bot panel"
        closeTitle="Close panel"
        onClose={close}
      />
    </div>
  );
}
```

- [ ] **Step 6: Mount it around the chat and add the toggle**

`renderer/main/bot-chat-route.tsx`:

```tsx
import { BotChatPane } from "./bots/bot-chat-pane";
import { BotWorkbench } from "./bots/bot-workbench";

/** `/bots/$botId/chat`: one Bot's conversation, with its side panel beside it. */
export function BotChatRoute({ botId }: { botId: string }) {
  return (
    <BotWorkbench key={botId} botId={botId}>
      <BotChatPane botId={botId} />
    </BotWorkbench>
  );
}
```

`renderer/main/bots/bot-chat-header.tsx`: change the lucide import to `import { ChevronLeft, Ellipsis, PanelRightClose, PanelRightOpen } from "lucide-react";`, add

```tsx
import { useShortcutBinding, useShortcutLabel } from "../../lib/command-system";
import { ariaKeyShortcut } from "../../shared/keybindings";
import { BOT_PANEL_ID, useBotPanel } from "./bot-panel-context";
```

and append:

```tsx
/** Shows and hides the Bot side panel; `environment.toggle` does the same from the keyboard. */
export function BotPanelToggle() {
  const panel = useBotPanel();
  const shortcut = useShortcutLabel("environment.toggle");
  const binding = useShortcutBinding("environment.toggle");
  return (
    <Button
      iconOnly
      variant="bar"
      size="small"
      onClick={panel.toggle}
      aria-label={panel.open ? "Hide panel" : "Show panel"}
      aria-pressed={panel.open}
      aria-controls={BOT_PANEL_ID}
      aria-keyshortcuts={ariaKeyShortcut(binding)}
      title={`Toggle panel (${shortcut})`}
      data-bot-panel-toggle
    >
      {panel.open ? <PanelRightClose /> : <PanelRightOpen />}
    </Button>
  );
}
```

`renderer/main/bots/bot-chat-pane.tsx`:

1. Change `import { useBotLive } from "../../lib/use-bot-live";` to `import { useSharedBotLive } from "../../lib/use-bot-live";` and `const live = useBotLive(botId);` to `const live = useSharedBotLive(botId);`.
2. Add `BotPanelToggle` to the `./bot-chat-header` import.
3. In `shell`'s `actions`, render the toggle before the ••• menu:

```tsx
      actions={
        current ? (
          <>
            <BotPanelToggle />
            <BotChatActions
              bot={current}
              onOpenProfile={() => void navigate({ to: "/bots/$botId", params: { botId: current.id } })}
              onOpenFiles={() => setFiles({ open: true, path: null })}
              onOpenMemory={openMemory}
              onOpenAdvanced={openAdvanced}
              onDelete={() => setDeleteOpen(true)}
            />
          </>
        ) : null
      }
```

- [ ] **Step 7: Run the tests**

Run:
```bash
npx tsx --test renderer/main/bots/bot-panel.test.tsx renderer/main/bots/bot-memory-page.test.tsx renderer/main/bots/bot-chat-pane.test.tsx renderer/main/bots/bot-chat-header.test.tsx renderer/components/workbench-panel.test.tsx
npx tsc --noEmit && npm run lint
```
Expected: all PASS (Profile → Memory's suite proves the page still behaves the same).

- [ ] **Step 8: Commit**

```bash
git add renderer/main/bots/bot-workbench.tsx renderer/main/bots/bot-panel-activity.tsx renderer/main/bots/bot-panel-files.tsx renderer/main/bots/bot-memory-page.tsx renderer/main/bot-chat-route.tsx renderer/main/bots/bot-chat-header.tsx renderer/main/bots/bot-chat-pane.tsx renderer/main/bots/bot-panel.test.tsx
git commit -m "Bots: the Bot side panel with Activity, Files, Memory and Routines"
```

---
### Task 8: File chips, ••• Files and "Memory updated" open the panel; the Files dialog goes

**Files:**
- Modify: `renderer/main/bots/bot-chat-pane.tsx`
- Delete: `renderer/main/bots/bot-files-dialog.tsx`
- Test: `renderer/main/bots/bot-panel.test.tsx` (append), `renderer/main/bots/bot-chat-pane.test.tsx`

**Interfaces:**
- Consumes: `useBotPanel().show(tab, { path? })` (Task 4); the panel (Task 7).
- Produces: nothing new. `BotChatPane` no longer imports or renders `BotFilesDialog`.

- [ ] **Step 1: Write the failing tests**

Append to `renderer/main/bots/bot-panel.test.tsx`:

```tsx
test("a file the Bot wrote is a chip that opens the panel's Files tab on that file, again after going back", async () => {
  await mountBotChat({
    ...FILE_HANDLERS,
    "bots:live:subscribe": () =>
      chatSnapshot([
        { id: "u1", type: "user", text: "Write my grocery list", imageCount: 0 },
        { id: "f1", type: "file", path: "lists/groceries.md", operation: "written" },
        { id: "a1", type: "assistant", text: "Done.", toolCalls: [], stopReason: "stop" },
      ]),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Open groceries.md" }));
  assert.equal(botPanel().getAttribute("data-state"), "open");
  assert.equal(panelTab("Files").getAttribute("aria-selected"), "true");
  assert.equal((await within(botPanel()).findByLabelText("Contents of lists/groceries.md")).textContent, "eggs\nmilk");
  fireEvent.click(within(botPanel()).getByRole("button", { name: "All files" }));
  await within(botPanel()).findByRole("list", { name: "Files" });
  fireEvent.click(screen.getByRole("button", { name: "Open groceries.md" }));
  assert.ok(await within(botPanel()).findByLabelText("Contents of lists/groceries.md"), "the same chip selects its file again");
  assert.equal(screen.queryByRole("dialog"), null, "no Files dialog any more");
});

test("Files and Memory in the chat's ••• menu open the panel on that tab", async () => {
  await mountBotChat({ ...FILE_HANDLERS, "bots:memory:get": () => memoryView([]) });
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
  assert.equal(panelTab("Files").getAttribute("aria-selected"), "true");
  assert.ok(await within(botPanel()).findByRole("button", { name: "groceries.md" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "More for Planner" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Memory" }));
  assert.equal(panelTab("Memory").getAttribute("aria-selected"), "true");
});
```

In `renderer/main/bots/bot-chat-pane.test.tsx`:

1. Change the `node:test` import to `import { afterEach, beforeEach, test } from "node:test";` and add `beforeEach(() => localStorage.clear());` under `afterEach(cleanup);`, so a panel opened by one test never carries into the next.
2. Delete the tests "Files in the ••• menu lists the Bot's folder and opens a file" and "a file the Bot wrote shows as a chip that opens that file", and the `FILE_HANDLERS` constant they used. Their behaviour is now covered by the two panel tests above and Task 7's Files test.
3. In "Memory updated is a quiet caption, outside Updates, that opens this Bot's Memory page", rename it to "Memory updated is a quiet caption, outside Updates, that opens the panel's Memory tab" and replace its last three lines (`fireEvent.click(captions[0]!);` onwards) with:

```tsx
  fireEvent.click(captions[0]!);
  const panel = screen.getByRole("complementary", { name: "Bot panel" });
  assert.equal(within(panel).getByRole("tab", { name: "Memory" }).getAttribute("aria-selected"), "true");
  assert.equal(router.state.location.pathname, "/bots/bot-1/chat", "the chat stays open beside it");
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-panel.test.tsx renderer/main/bots/bot-chat-pane.test.tsx`
Expected: FAIL. The chip still opens a dialog, and the caption navigates to Profile → Memory.

- [ ] **Step 3: Implement**

In `renderer/main/bots/bot-chat-pane.tsx`:

1. Delete `import { BotFilesDialog } from "./bot-files-dialog";` and add `import { useBotPanel } from "./bot-panel-context";`.
2. Delete `const [files, setFiles] = React.useState<{ open: boolean; path: string | null }>({ open: false, path: null });` and add `const panel = useBotPanel();` in its place.
3. Replace `const openMemory = () => void navigate({ to: "/bots/$botId", params: { botId }, search: { page: "memory" } });` with:

```tsx
  // Memory, Files and Routines live in the side panel beside the chat (spec §8).
  const openMemory = () => panel.show("memory");
```

4. In `shell`, change `onOpenFiles={() => setFiles({ open: true, path: null })}` to `onOpenFiles={() => panel.show("files")}` and delete the whole `<BotFilesDialog … />` element (leave `BotDeleteDialog`).
5. In the `TranscriptEntries` call, change `onOpenFile={(path) => setFiles({ open: true, path })}` to `onOpenFile={(path) => panel.show("files", { path })}`.

Delete the file:

```bash
git rm renderer/main/bots/bot-files-dialog.tsx
```

- [ ] **Step 4: Run the tests**

Run:
```bash
npx tsx --test renderer/main/bots/bot-panel.test.tsx renderer/main/bots/bot-chat-pane.test.tsx
git grep -n "bot-files-dialog\|BotFilesDialog" -- renderer main tests
npx tsc --noEmit && npm run lint
```
Expected: tests PASS; the grep prints nothing; no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add renderer/main/bots/bot-chat-pane.tsx renderer/main/bots/bot-panel.test.tsx renderer/main/bots/bot-chat-pane.test.tsx
git commit -m "Bots: file chips, Files and Memory open the side panel; the Files dialog is removed"
```

---

### Task 9: One ••• menu for every Bot surface, with Routines and Pin to top

**Files:**
- Create: `renderer/main/bots/bot-menu.tsx`
- Modify: `renderer/main/bots/bot-chat-header.tsx` (`BotChatActions`), `renderer/main/bots/bot-chat-pane.tsx`
- Test: `renderer/main/bots/bot-chat-header.test.tsx`, `renderer/main/bots/bot-panel.test.tsx` (append)

**Interfaces:**
- Consumes: `useBotPanel` (Task 4), `useBotSidebarPreferences` (Task 2), `botChatPath`, `botChatRouteBotId` (Task 1).
- Produces:
  - `type BotMenuAction = "profile" | "files" | "memory" | "routines" | "advanced" | "pin" | "delete"`
  - `BotMenuItems({ pinned, Item, Separator, onAction })` (the §10 order; "Pin to top" or "Unpin")
  - `useBotMenuActions(onDelete: (bot: BotDefinition) => void): (bot: BotDefinition, action: BotMenuAction) => void`. Files/Memory/Routines open the panel on that tab and, when that Bot's chat is not the open page, navigate to it.
  - `BotChatActions({ bot, pinned, onAction }: { bot: Pick<BotDefinition, "name">; pinned: boolean; onAction(action: BotMenuAction): void })`

- [ ] **Step 1: Write the failing tests**

Replace `renderer/main/bots/bot-chat-header.test.tsx` with:

```tsx
import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_BOT_AVATAR } from "../../shared/bots";
import { BotChatActions, BotChatBackButton, BotChatNamePill } from "./bot-chat-header";

afterEach(cleanup);

const bot = { id: "b1", name: "SLMob", avatar: { ...DEFAULT_BOT_AVATAR } };

function renderHeader(pinned = false) {
  const calls: string[] = [];
  render(
    <>
      <BotChatBackButton onBack={() => calls.push("back")} />
      <BotChatNamePill bot={bot} onOpenProfile={() => calls.push("profile")} />
      <BotChatActions bot={bot} pinned={pinned} onAction={(action) => calls.push(action)} />
    </>,
  );
  return calls;
}

const openMenu = async () => {
  fireEvent.keyDown(screen.getByRole("button", { name: "More for SLMob" }), { key: "Enter" });
  return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
};

test("the name pill opens the Bot's profile and back returns to all Bots", () => {
  const calls = renderHeader();
  fireEvent.click(screen.getByRole("button", { name: "SLMob profile" }));
  fireEvent.click(screen.getByRole("button", { name: "All Bots" }));
  assert.deepEqual(calls, ["profile", "back"]);
});

test("the ••• menu offers Profile, Files, Memory, Routines, Advanced, Pin to top and Delete Bot, in that order", async () => {
  const calls = renderHeader();
  assert.deepEqual(await openMenu(), ["Profile", "Files", "Memory", "Routines", "Advanced", "Pin to top", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Routines" }));
  assert.deepEqual(calls, ["routines"]);
});

test("a pinned Bot's menu offers Unpin instead", async () => {
  const calls = renderHeader(true);
  assert.ok((await openMenu()).includes("Unpin"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
  assert.deepEqual(calls, ["pin"]);
});
```

Add `import { BOT_SIDEBAR_PREFERENCES_KEY, parseBotSidebarPreferences } from "../../lib/bot-sidebar-preferences";` to `bot-panel.test.tsx` and append:

```tsx
test("Routines in the chat's ••• menu opens the panel on Routines, and Pin to top pins the Bot", async () => {
  await mountBotChat();
  const more = () => screen.getByRole("button", { name: "More for Planner" });
  fireEvent.keyDown(more(), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Routines" }));
  assert.equal(panelTab("Routines").getAttribute("aria-selected"), "true");
  fireEvent.keyDown(more(), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin to top" }));
  assert.equal(parseBotSidebarPreferences(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY), 0).pinnedBotId, "bot-1");
  fireEvent.keyDown(more(), { key: "Enter" });
  assert.ok(await screen.findByRole("menuitem", { name: "Unpin" }));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-chat-header.test.tsx renderer/main/bots/bot-panel.test.tsx`
Expected: FAIL. `BotChatActions` has no `onAction`, and there is no Routines item.

- [ ] **Step 3: Write the shared menu**

```tsx
// renderer/main/bots/bot-menu.tsx
// The one Bot ••• menu (spec §10), for the chat header, sidebar rows (hover and
// right-click) and the pinned Bot: Profile, Files, Memory, Routines, Advanced,
// Pin to top/Unpin, then Delete Bot. Files, Memory and Routines open the side
// panel on that tab, beside that Bot's chat.

import * as React from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type {
  ContextMenuItem,
  ContextMenuSeparator,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../../components/ui";
import { botChatPath, botChatRouteBotId } from "../../lib/bot-routes";
import type { BotDefinition } from "../../shared/bots";
import { useBotPanel } from "./bot-panel-context";
import { useBotSidebarPreferences } from "./use-bot-sidebar-preferences";

export type BotMenuAction = "profile" | "files" | "memory" | "routines" | "advanced" | "pin" | "delete";

export function BotMenuItems({
  pinned,
  Item,
  Separator,
  onAction,
}: {
  pinned: boolean;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
  onAction(action: BotMenuAction): void;
}) {
  return (
    <>
      <Item onSelect={() => onAction("profile")}>Profile</Item>
      <Item onSelect={() => onAction("files")}>Files</Item>
      <Item onSelect={() => onAction("memory")}>Memory</Item>
      <Item onSelect={() => onAction("routines")}>Routines</Item>
      <Item onSelect={() => onAction("advanced")}>Advanced</Item>
      <Item onSelect={() => onAction("pin")}>{pinned ? "Unpin" : "Pin to top"}</Item>
      <Separator />
      <Item color="status-red" onSelect={() => onAction("delete")}>
        Delete Bot
      </Item>
    </>
  );
}

/** What each menu item does for a Bot. Delete is the caller's, because it owns the confirmation. */
export function useBotMenuActions(onDelete: (bot: BotDefinition) => void) {
  const navigate = useNavigate();
  const { show } = useBotPanel();
  const { preferences, pin, unpin } = useBotSidebarPreferences();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const chatBotId = botChatRouteBotId(pathname);
  const pinnedBotId = preferences.pinnedBotId;
  return React.useCallback(
    (bot: BotDefinition, action: BotMenuAction) => {
      switch (action) {
        case "profile":
          void navigate({ to: "/bots/$botId", params: { botId: bot.id } });
          return;
        case "advanced":
          void navigate({ to: "/bots/$botId", params: { botId: bot.id }, search: { page: "advanced" } });
          return;
        case "files":
        case "memory":
        case "routines":
          show(action);
          if (chatBotId !== bot.id) void navigate(botChatPath(bot.id));
          return;
        case "pin":
          if (pinnedBotId === bot.id) unpin();
          else pin(bot.id);
          return;
        case "delete":
          onDelete(bot);
          return;
      }
    },
    [chatBotId, navigate, onDelete, pin, pinnedBotId, show, unpin],
  );
}
```

- [ ] **Step 4: Use it in the chat header**

In `renderer/main/bots/bot-chat-header.tsx`, add `import { BotMenuItems, type BotMenuAction } from "./bot-menu";` and replace `BotChatActions` with:

```tsx
/** The action side of a Bot chat: the shared Bot ••• menu (spec §10). */
export function BotChatActions({
  bot,
  pinned,
  onAction,
}: {
  bot: Pick<BotDefinition, "name">;
  pinned: boolean;
  onAction(action: BotMenuAction): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button iconOnly variant="bar" size="small" aria-label={`More for ${bot.name}`}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <BotMenuItems pinned={pinned} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} onAction={onAction} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

In `renderer/main/bots/bot-chat-pane.tsx`, add

```tsx
import { useBotMenuActions } from "./bot-menu";
import { useBotSidebarPreferences } from "./use-bot-sidebar-preferences";
```

below `const panel = useBotPanel();` add

```tsx
  const { preferences } = useBotSidebarPreferences();
  const menuAction = useBotMenuActions(() => setDeleteOpen(true));
```

and replace the `<BotChatActions … />` element in `shell` with:

```tsx
            <BotChatActions
              bot={current}
              pinned={preferences.pinnedBotId === current.id}
              onAction={(action) => menuAction(current, action)}
            />
```

Keep `openMemory` and `openAdvanced`: the "Memory updated" caption, the interrupted card and the model-error card still use them.

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test renderer/main/bots/bot-chat-header.test.tsx renderer/main/bots/bot-panel.test.tsx renderer/main/bots/bot-chat-pane.test.tsx && npx tsc --noEmit && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/main/bots/bot-menu.tsx renderer/main/bots/bot-chat-header.tsx renderer/main/bots/bot-chat-header.test.tsx renderer/main/bots/bot-chat-pane.tsx renderer/main/bots/bot-panel.test.tsx
git commit -m "Bots: one ••• menu with Routines and Pin to top on every Bot surface"
```

---
### Task 10: The Bots sidebar

**Files:**
- Create: `renderer/main/bots/bot-sidebar-rows.ts`, `renderer/main/bots/bot-sidebar.tsx`
- Test: `renderer/main/bots/bot-sidebar.test.tsx`
- Modify: `renderer/components/chat-sidebar.tsx` (the exported `ChatSidebar` at about line 461)
- Modify: `renderer/components/remote-bots-section.tsx`, `renderer/main/remote-bots.tsx`, `renderer/main/remote-new-chat-view.test.tsx`
- Modify: `renderer/main/bots/bot-chat-pane.tsx` (mark viewed; no "All Bots" back), `renderer/main/bots/bot-chat-header.tsx` (delete `BotChatBackButton`), `renderer/main/bots/bot-chat-header.test.tsx`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json` (`renderer-other`)

Before writing the markup, read `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` (sidebar rows, hover affordances, badges, focus) and `docs/design-guide.md`.

**Interfaces:**
- Consumes: `botLiveSummary` fields (Task 3), `useBotSidebarPreferences`, `isBotUnread` (Task 2), `botChatPath`, `botRouteBotId`, `isBotsPath`, `lastNonBotRoute` (Task 1), `BotMenuItems`, `useBotMenuActions` (Task 9), `BotAvatar` `working` (B), `botRowStatusLabel` (existing).
- Produces:
  - `bot-sidebar-rows.ts`: `interface BotSidebarRow { bot: BotDefinition; state?: BotSessionState; preview?: string; activityAt: number; needsYou: boolean; lastReplyAt: number | null }`, `BOT_WORKING_LINE = "Thinking…"`, `BOT_WAITING_LINE = "Waiting for you"`, `botSidebarRows(bots, summaries): BotSidebarRow[]` (newest activity first, then name), `matchesBotSearch(row, query): boolean`, `type BotRowLine = { kind: "working" | "waiting" | "status" | "preview"; text: string }`, `botRowLine(row): BotRowLine | null`, `botLiveSummaryKey(botId)`, `useBotRows(): { bots: UseQueryResult<BotDefinition[]>; rows: BotSidebarRow[]; summariesSettled: boolean }` (re-reads a row on `bots:attention`).
  - `BotSidebar()`.
  - `RemoteBotsSection({ groups, opening, onOpen, query? })`, `RemoteBots({ query? })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// renderer/main/bots/bot-sidebar.test.tsx
import { emitBotTestNotification, installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { rememberRoute } from "../../lib/bot-routes";
import {
  BOT_SIDEBAR_PREFERENCES_KEY,
  parseBotSidebarPreferences,
  serializeBotSidebarPreferences,
} from "../../lib/bot-sidebar-preferences";
import type { BotLiveSummary } from "../../shared/bot-live";
import type { BotDefinition } from "../../shared/bots";
import { BotSidebar } from "./bot-sidebar";
import { mountWithBotRouter } from "./test-providers";
import { botFixture } from "./test-fixtures";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const PLANNER = botFixture({ id: "bot-1", name: "Planner", description: "Plans trips" });
const INBOX = botFixture({ id: "bot-2", name: "Inbox Helper", description: "Email" });
const SCOUT = botFixture({ id: "bot-3", name: "Scout", description: "Finds places" });

function summary(botId: string, patch: Partial<BotLiveSummary> = {}): BotLiveSummary {
  return { botId, preview: null, updatedAt: null, state: { kind: "idle" }, needsYou: false, lastReplyAt: null, ...patch };
}

function sidebarIpc(
  bots: BotDefinition[],
  summaries: Record<string, BotLiveSummary> = {},
  extra: Record<string, (...args: unknown[]) => unknown> = {},
) {
  return installBotTestIpc({
    "bots:list": () => bots,
    "bots:live:summary": (botId) => summaries[botId as string] ?? summary(botId as string),
    "bots:get": (botId) => bots.find((bot) => bot.id === botId) ?? null,
    "bots:live:subscribe": (botId) => ({
      botId,
      epoch: "e1",
      seq: 0,
      entries: [],
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
    }),
    "bots:live:unsubscribe": () => undefined,
    "bots:pendingApprovals": () => [],
    "profile:get": () => ({ name: "Sam" }),
    ...extra,
  });
}

async function mountSidebar(initialPath = "/bots") {
  const mounted = await mountWithBotRouter(null, { initialPath, sidebar: <BotSidebar /> });
  await screen.findByRole("navigation", { name: "Bots" });
  return mounted;
}

const rowButton = (name: string) =>
  within(screen.getByRole("navigation", { name: "Bots" })).getByRole("button", { name: new RegExp(`^${name}`, "u") });

/** Row order by each row's face, whose title is the Bot's name. */
const rowOrder = () =>
  within(screen.getByRole("list", { name: "Your Bots" }))
    .getAllByRole("listitem")
    .map((item) => item.querySelector("span[title]")?.getAttribute("title"));

const noUnread = (name: string) => within(rowButton(name)).queryByRole("img", { name: "Unread" }) === null;

test("rows show each Bot's last message, newest activity first, in plain words", async () => {
  sidebarIpc([PLANNER, INBOX, SCOUT], {
    "bot-1": summary("bot-1", { preview: "Lisbon in May", updatedAt: 100 }),
    "bot-2": summary("bot-2", { preview: "Inbox is clear", updatedAt: 300 }),
    "bot-3": summary("bot-3", { preview: "Found two cafés", updatedAt: 200 }),
  });
  await mountSidebar();
  await waitFor(() => assert.deepEqual(rowOrder(), ["Inbox Helper", "Scout", "Planner"]));
  assert.ok(within(rowButton("Planner")).getByText("Lisbon in May"));
  assert.equal(screen.queryByRole("navigation", { name: "Primary" }), null, "only Bots in this sidebar");
  const text = document.body.textContent ?? "";
  for (const jargon of [/\bPi\b/u, /provider/iu, /workspace/iu, /capabilit/iu, /canonical/iu]) {
    assert.doesNotMatch(text, jargon);
  }
});

test("a working Bot's face works and its line reads Thinking…, and Needs you appears as soon as it asks", async () => {
  let asking = false;
  sidebarIpc([PLANNER, INBOX], {}, {
    "bots:live:summary": (botId) =>
      botId === "bot-1"
        ? summary("bot-1", { state: { kind: "running", submissionId: "s1" }, needsYou: asking })
        : summary("bot-2", { preview: "Inbox is clear" }),
  });
  await mountSidebar();
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Thinking…")));
  assert.equal(within(rowButton("Planner")).getByTitle("Planner").hasAttribute("data-working"), true);
  assert.equal(within(rowButton("Inbox Helper")).getByTitle("Inbox Helper").hasAttribute("data-working"), false);
  asking = true;
  emitBotTestNotification("bots:attention", { botId: "bot-1" });
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Needs you")));
  assert.ok(within(rowButton("Planner")).getByText("Waiting for you"));
  assert.equal(within(rowButton("Inbox Helper")).queryByText("Needs you"), null);
});

test("a reply since the person last looked shows an unread dot, but not on the open Bot or on replies from before the sidebar existed", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1_000, pinnedBotId: null, lastViewed: { "bot-2": 5_000 } }),
  );
  sidebarIpc([PLANNER, INBOX, SCOUT], {
    "bot-1": summary("bot-1", { lastReplyAt: 9_000, updatedAt: 9_000 }),
    "bot-2": summary("bot-2", { lastReplyAt: 6_000, updatedAt: 6_000 }),
    "bot-3": summary("bot-3", { lastReplyAt: 500, updatedAt: 500 }),
  });
  const { router } = await mountSidebar("/bots/bot-1");
  await waitFor(() => assert.ok(within(rowButton("Inbox Helper")).getByRole("img", { name: "Unread" })));
  assert.ok(noUnread("Planner"), "the open Bot");
  assert.ok(noUnread("Scout"), "a reply from before the sidebar existed");
  assert.equal(rowButton("Planner").getAttribute("aria-current"), "page");

  fireEvent.click(rowButton("Inbox Helper"));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  await screen.findByRole("button", { name: "Inbox Helper profile" });
  await router.navigate({ to: "/bots/$botId", params: { botId: "bot-1" } });
  await waitFor(() => assert.ok(noUnread("Inbox Helper"), "viewing its chat marked it read"));
});

test("a paused Bot says so, and one without a model says it needs one", async () => {
  sidebarIpc([PLANNER, INBOX], {
    "bot-1": summary("bot-1", { preview: "Reading your calendar", state: { kind: "interrupted", submissionId: "s1" } }),
    "bot-2": summary("bot-2", { state: { kind: "needs_model" } }),
  });
  await mountSidebar();
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Paused — tap to resume")));
  assert.equal(within(rowButton("Planner")).queryByText("Reading your calendar"), null);
  assert.ok(within(rowButton("Inbox Helper")).getByText("Needs an AI model"));
});

test("tapping a row opens that Bot's chat, and its context menu and ••• offer the Bot menu", async () => {
  sidebarIpc([PLANNER, INBOX]);
  const { router } = await mountSidebar();
  fireEvent.click(await screen.findByRole("button", { name: /^Inbox Helper/u }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));

  fireEvent.contextMenu(rowButton("Planner"));
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Profile", "Files", "Memory", "Routines", "Advanced", "Pin to top", "Delete Bot"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Advanced" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-1"));
  assert.equal((router.state.location.search as { page?: string }).page, "advanced");

  fireEvent.keyDown(screen.getByRole("button", { name: "More for Inbox Helper" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Bot" }));
  const confirm = await screen.findByRole("alertdialog");
  assert.ok(within(confirm).getByRole("heading", { name: "Delete Inbox Helper?" }));
});

test("Memory in a row's menu opens that Bot's chat with the panel on Memory", async () => {
  const empty = { entries: [], usedChars: 0, limitChars: 1_375, overBudget: false };
  sidebarIpc([PLANNER, INBOX], {}, {
    "bots:memory:get": (botId) => ({ botId, revision: "r1", readable: true, user: empty, memory: { ...empty, limitChars: 2_200 }, updatedAt: 1 }),
  });
  const { router } = await mountSidebar("/bots/bot-1/chat");
  fireEvent.keyDown(await screen.findByRole("button", { name: "More for Inbox Helper" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Memory" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  const panel = await screen.findByRole("complementary", { name: "Bot panel" });
  assert.equal(within(panel).getByRole("tab", { name: "Memory" }).getAttribute("aria-selected"), "true");
});

test("Pin to top shows the Bot large above the rows, Unpin puts it back, and a deleted pinned Bot leaves no hero", async () => {
  let bots = [PLANNER, INBOX];
  sidebarIpc([], {}, { "bots:list": () => bots });
  const { queryClient } = await mountSidebar();
  fireEvent.contextMenu(await screen.findByRole("button", { name: /^Inbox Helper/u }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin to top" }));
  const hero = await screen.findByRole("region", { name: "Pinned Bot" });
  assert.ok(within(hero).getByRole("button", { name: /^Inbox Helper/u }));
  assert.deepEqual(rowOrder(), ["Planner"], "a pinned Bot is not listed twice");

  fireEvent.keyDown(within(hero).getByRole("button", { name: "More for Inbox Helper" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
  await waitFor(() => assert.equal(screen.queryByRole("region", { name: "Pinned Bot" }), null));
  assert.deepEqual(rowOrder(), ["Inbox Helper", "Planner"]);

  fireEvent.contextMenu(rowButton("Inbox Helper"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin to top" }));
  await screen.findByRole("region", { name: "Pinned Bot" });
  bots = [PLANNER];
  await queryClient.invalidateQueries({ queryKey: ["bots"] });
  await waitFor(() => assert.equal(screen.queryByRole("region", { name: "Pinned Bot" }), null));
  assert.equal(parseBotSidebarPreferences(localStorage.getItem(BOT_SIDEBAR_PREFERENCES_KEY), 0).pinnedBotId, null);
});

test("search narrows rows by name, subtitle or last message, finds the pinned Bot, and Clear brings everything back", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: "bot-3", lastViewed: {} }),
  );
  sidebarIpc([PLANNER, INBOX, SCOUT], { "bot-1": summary("bot-1", { preview: "Lisbon in May" }) });
  await mountSidebar();
  await screen.findByRole("region", { name: "Pinned Bot" });
  await waitFor(() => assert.ok(within(rowButton("Planner")).getByText("Lisbon in May")));
  fireEvent.click(screen.getByRole("button", { name: "Search Bots" }));
  const search = screen.getByRole("searchbox", { name: "Search Bots" });
  await waitFor(() => assert.equal(document.activeElement, search));
  fireEvent.change(search, { target: { value: "email" } });
  assert.deepEqual(rowOrder(), ["Inbox Helper"]);
  fireEvent.change(search, { target: { value: "lisbon" } });
  assert.deepEqual(rowOrder(), ["Planner"]);
  fireEvent.change(search, { target: { value: "places" } });
  assert.equal(screen.queryByRole("region", { name: "Pinned Bot" }), null);
  assert.deepEqual(rowOrder(), ["Scout"]);
  fireEvent.change(search, { target: { value: "zebra" } });
  assert.ok(within(screen.getByRole("status")).getByText("No matching Bots"));
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  assert.deepEqual(rowOrder(), ["Inbox Helper", "Planner"]);
  assert.ok(screen.getByRole("region", { name: "Pinned Bot" }));
});

test("while the Bots load the sidebar shows placeholders, and a failed load offers Try again", async () => {
  let release!: (bots: BotDefinition[]) => void;
  sidebarIpc([], {}, { "bots:list": () => new Promise<BotDefinition[]>((resolve) => (release = resolve)) });
  await mountSidebar();
  assert.ok(screen.getByRole("status", { name: "Loading Bots" }));
  release([PLANNER]);
  await screen.findByRole("button", { name: /^Planner/u });
  cleanup();

  let fail = true;
  sidebarIpc([], {}, {
    "bots:list": () => {
      if (fail) throw new Error("Bots are still starting");
      return [PLANNER];
    },
  });
  await mountSidebar();
  const alert = await screen.findByRole("alert");
  fail = false;
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: /^Planner/u });
});

test("‹ returns to the last page outside Bots, and the footer opens Profile and Connect apps", async () => {
  rememberRoute("/scheduled");
  rememberRoute("/bots/bot-1/chat");
  sidebarIpc([PLANNER]);
  const { router } = await mountSidebar();
  fireEvent.click(screen.getByRole("button", { name: "Back to Aiden" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/scheduled"));
  await waitFor(() => assert.ok(within(screen.getByRole("button", { name: "Profile" })).getByText("S")));
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/profile"));
  fireEvent.click(screen.getByRole("button", { name: "Connect apps" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/settings"));
  assert.equal((router.state.location.search as { section?: string }).section, "mcp");
});
```

Append to `renderer/main/remote-new-chat-view.test.tsx`:

```tsx
test("search in the Bots sidebar narrows paired Macs' Bots too, and hides a Mac with no match", () => {
  const groups = [
    { host: studio, bots: [{ id: "bot-1", name: "Reviewer", purpose: "Reviews pull requests" }, { id: "bot-2", name: "Scribe" }] },
    { host: laptop, bots: [{ id: "bot-3", name: "Planner" }] },
  ];
  const searched = dom(renderToStaticMarkup(<RemoteBotsSection groups={groups} opening={null} onOpen={noop} query="pull requests" />));
  assert.ok(searched.button(/^Reviewer, on Studio$/u));
  assert.equal(searched.button(/^Scribe, on Studio$/u), undefined);
  assert.doesNotMatch(searched.text, /On Laptop/u);
  assert.equal(renderToStaticMarkup(<RemoteBotsSection groups={groups} opening={null} onOpen={noop} query="zebra" />), "");
});
```

Register: append ` renderer/main/bots/bot-sidebar.test.tsx` to `package.json` `test:bots`; add `"renderer/main/bots/bot-sidebar.test.tsx",` after `"renderer/main/bots/bot-activity-log.test.ts",` in `renderer-other`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/main/bots/bot-sidebar.test.tsx renderer/main/remote-new-chat-view.test.tsx`
Expected: FAIL, cannot find module `./bot-sidebar`; `RemoteBotsSection` ignores `query`.

- [ ] **Step 3: Write the rows model**

```ts
// renderer/main/bots/bot-sidebar-rows.ts
// The Bots sidebar's rows (spec §9): one per Bot, newest activity first, read
// from the same live summaries main projects for the chat. A question or an
// approval appearing or settling (`bots:attention`) re-reads that Bot's row;
// state changes already re-read every row through `bots:changed`.

import * as React from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { botsApi, onNotification } from "../../lib/ipc";
import { useBots } from "../../lib/queries";
import type { BotLiveSummary } from "../../shared/bot-live";
import type { BotDefinition } from "../../shared/bots";
import { botRowStatusLabel, type BotSessionState } from "./bot-session-state";

export interface BotSidebarRow {
  bot: BotDefinition;
  state?: BotSessionState;
  /** Last message preview, one line of plain text. */
  preview?: string;
  /** When the Bot's chat last changed, or the Bot itself when it has no messages. */
  activityAt: number;
  needsYou: boolean;
  lastReplyAt: number | null;
}

export const BOT_WORKING_LINE = "Thinking…";
export const BOT_WAITING_LINE = "Waiting for you";

export const botLiveSummaryKey = (botId: string) => ["bot-live-summary", botId] as const;

export function botSidebarRows(
  bots: readonly BotDefinition[],
  summaries: ReadonlyArray<BotLiveSummary | undefined>,
): BotSidebarRow[] {
  return bots
    .map((bot, index): BotSidebarRow => {
      const summary = summaries[index];
      return {
        bot,
        ...(summary ? { state: summary.state } : {}),
        ...(summary?.preview ? { preview: summary.preview } : {}),
        activityAt: summary?.updatedAt ?? bot.updatedAt,
        needsYou: summary?.needsYou ?? false,
        lastReplyAt: summary?.lastReplyAt ?? null,
      };
    })
    .sort((left, right) => right.activityAt - left.activityAt || left.bot.name.localeCompare(right.bot.name));
}

export function matchesBotSearch(row: BotSidebarRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.bot.name, row.bot.description ?? "", row.preview ?? ""].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

export type BotRowLine = { kind: "working" | "waiting" | "status" | "preview"; text: string };

export function botRowLine(row: BotSidebarRow): BotRowLine | null {
  if (row.needsYou) return { kind: "waiting", text: BOT_WAITING_LINE };
  if (row.state?.kind === "running") return { kind: "working", text: BOT_WORKING_LINE };
  const status = botRowStatusLabel(row.state);
  if (status) return { kind: "status", text: status };
  return row.preview ? { kind: "preview", text: row.preview } : null;
}

export function useBotRows() {
  const queryClient = useQueryClient();
  const bots = useBots();
  const list = bots.data ?? [];
  const summaries = useQueries({
    queries: list.map((bot) => ({
      queryKey: botLiveSummaryKey(bot.id),
      queryFn: () => botsApi.liveSummary(bot.id),
      retry: false,
    })),
  });
  React.useEffect(
    () =>
      onNotification<{ botId?: string }>("bots:attention", ({ botId }) => {
        void queryClient.invalidateQueries({ queryKey: botId ? botLiveSummaryKey(botId) : ["bot-live-summary"] });
      }),
    [queryClient],
  );
  const rows = botSidebarRows(
    list,
    summaries.map((result) => result.data),
  );
  return { bots, rows, summariesSettled: summaries.every((result) => !result.isPending) };
}
```

- [ ] **Step 4: Write the sidebar**

```tsx
// renderer/main/bots/bot-sidebar.tsx
// The Bots-only sidebar (spec §9): ‹ back to Aiden, Search and New Bot on top;
// the pinned Bot, large, when one is pinned; one row per Bot, newest activity
// first, whose face glances while it works, with "Needs you" and an unread dot;
// Bots on paired Macs; the profile and Connect apps in the footer.

import * as React from "react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, Ellipsis, Plug, Plus, RotateCcw, Search, UserRound, X } from "lucide-react";
import { BotAvatar } from "../../components/bot-avatar";
import { HistoryNavButtons } from "../../components/history-nav";
import {
  Badge,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Sidebar,
  SidebarFooter,
  SidebarListItem,
  SplitView,
} from "../../components/ui";
import { botChatPath, botRouteBotId, lastNonBotRoute } from "../../lib/bot-routes";
import { isBotUnread } from "../../lib/bot-sidebar-preferences";
import { useProfile } from "../../lib/queries";
import { cn } from "../../lib/ui-utils";
import type { BotDefinition } from "../../shared/bots";
import { RemoteBots } from "../remote-bots";
import { BotCreateFlow } from "./bot-create-flow";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { BotMenuItems, useBotMenuActions, type BotMenuAction } from "./bot-menu";
import { botRowLine, matchesBotSearch, useBotRows, type BotSidebarRow } from "./bot-sidebar-rows";
import { useBotSidebarPreferences } from "./use-bot-sidebar-preferences";

const ROW_FOCUS =
  "outline-none focus-visible:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring";

interface RowProps {
  row: BotSidebarRow;
  selected: boolean;
  unread: boolean;
  pinned: boolean;
  onOpen(bot: BotDefinition): void;
  onAction(bot: BotDefinition, action: BotMenuAction): void;
}

function RowMarkers({ row, unread }: { row: BotSidebarRow; unread: boolean }) {
  return (
    <>
      {row.needsYou ? (
        <Badge color="warning" className="h-5 shrink-0 px-1.5 text-mini">
          Needs you
        </Badge>
      ) : null}
      {unread ? (
        <span role="img" aria-label="Unread" title="New reply" className="inline-flex size-5 shrink-0 items-center justify-center">
          <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
        </span>
      ) : null}
    </>
  );
}

/** The row's right-click menu and its hover ••• button, with the same items. */
function RowMenus({
  row,
  pinned,
  onAction,
  moreClassName,
  children,
}: Pick<RowProps, "row" | "pinned" | "onAction"> & { moreClassName: string; children: React.ReactElement }) {
  const act = (action: BotMenuAction) => onAction(row.bot, action);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <BotMenuItems pinned={pinned} Item={ContextMenuItem} Separator={ContextMenuSeparator} onAction={act} />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            iconOnly
            variant="transparent"
            size="small"
            aria-label={`More for ${row.bot.name}`}
            className={cn(
              "absolute opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none",
              moreClassName,
            )}
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <BotMenuItems pinned={pinned} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} onAction={act} />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function BotRow({ row, selected, unread, pinned, onOpen, onAction }: RowProps) {
  const line = botRowLine(row);
  return (
    <li className="group relative">
      <RowMenus row={row} pinned={pinned} onAction={onAction} moreClassName="right-1.5 top-1/2 -translate-y-1/2">
        <button
          type="button"
          aria-current={selected ? "page" : undefined}
          className={cn(
            "flex w-full min-w-0 items-center gap-2.5 rounded-control py-1.5 pl-2 pr-9 text-left transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover motion-reduce:transition-none",
            ROW_FOCUS,
            selected && "bg-list-selection hover:bg-list-selection",
          )}
          onClick={() => onOpen(row.bot)}
        >
          <BotAvatar
            botId={row.bot.id}
            avatar={row.bot.avatar}
            name={row.bot.name}
            photoLoading="visible"
            size="medium"
            working={row.state?.kind === "running"}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-regular font-medium text-primary">{row.bot.name}</span>
            {line ? (
              <span className={cn("mt-0.5 block truncate text-small text-secondary", line.kind === "working" && "agent-thinking-shimmer")}>
                {line.text}
              </span>
            ) : null}
          </span>
          <RowMarkers row={row} unread={unread} />
        </button>
      </RowMenus>
    </li>
  );
}

function PinnedBot({ row, selected, unread, onOpen, onAction }: Omit<RowProps, "pinned">) {
  return (
    <section aria-label="Pinned Bot" className="group relative mb-2">
      <RowMenus row={row} pinned onAction={onAction} moreClassName="right-1.5 top-1.5">
        <button
          type="button"
          aria-current={selected ? "page" : undefined}
          className={cn(
            "flex w-full min-w-0 flex-col items-center gap-2 rounded-card px-3 py-3 transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover motion-reduce:transition-none",
            ROW_FOCUS,
            selected && "bg-list-selection hover:bg-list-selection",
          )}
          onClick={() => onOpen(row.bot)}
        >
          <BotAvatar
            botId={row.bot.id}
            avatar={row.bot.avatar}
            name={row.bot.name}
            photoLoading="visible"
            size="large"
            working={row.state?.kind === "running"}
          />
          <span className="flex max-w-full min-w-0 items-center gap-1.5">
            <span className="truncate text-strong font-medium text-primary">{row.bot.name}</span>
            <RowMarkers row={row} unread={unread} />
          </span>
        </button>
      </RowMenus>
    </section>
  );
}

function RowsSkeleton() {
  return (
    <div role="status" aria-label="Loading Bots" className="flex flex-col gap-0.5">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="size-9 shrink-0 rounded-card bg-control motion-safe:animate-pulse" />
          <span className="grid min-w-0 flex-1 gap-1.5">
            <span className="h-3 w-24 rounded-full bg-control motion-safe:animate-pulse" />
            <span className="h-2.5 w-36 max-w-full rounded-full bg-control motion-safe:animate-pulse" />
          </span>
        </div>
      ))}
      <span className="sr-only">Loading Bots…</span>
    </div>
  );
}

function ProfileFace({ name }: { name: string }) {
  const initial = [...name.trim()][0]?.toLocaleUpperCase();
  return (
    <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-control text-small-strong font-medium text-secondary">
      {initial ?? <UserRound className="size-3.5" />}
    </span>
  );
}

export function BotSidebar() {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentBotId = botRouteBotId(pathname);
  const profile = useProfile();
  const { bots, rows } = useBotRows();
  const { preferences, prune } = useBotSidebarPreferences();
  const [query, setQuery] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<BotDefinition | null>(null);
  const act = useBotMenuActions(setDeleting);

  React.useEffect(() => {
    // Only a loaded, non-empty list prunes, so a transient empty read can't drop the pin.
    if (bots.data && bots.data.length > 0) prune(new Set(bots.data.map((bot) => bot.id)));
  }, [bots.data, prune]);

  React.useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const searching = query.trim().length > 0;
  const pinnedBotId = preferences.pinnedBotId;
  const pinnedRow = searching ? undefined : rows.find((row) => row.bot.id === pinnedBotId);
  const visible = rows.filter((row) => row !== pinnedRow && matchesBotSearch(row, query));
  const openChat = (bot: BotDefinition) => void navigate(botChatPath(bot.id));
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };
  const rowProps = (row: BotSidebarRow) => ({
    row,
    selected: row.bot.id === currentBotId,
    unread: row.bot.id !== currentBotId && isBotUnread(preferences, row.bot.id, row.lastReplyAt),
    onOpen: openChat,
    onAction: act,
  });

  let list: React.ReactNode;
  if (bots.isLoading) {
    list = <RowsSkeleton />;
  } else if (bots.isError) {
    list = (
      <div role="alert" className="flex flex-col gap-1">
        <EmptyState
          placement="inline"
          title="Your Bots couldn’t be loaded"
          description="Check that Aiden finished starting, then try again."
        />
        <SidebarListItem icon={<RotateCcw />} title="Try again" onClick={() => void bots.refetch()} />
      </div>
    );
  } else if (rows.length === 0) {
    list = (
      <EmptyState
        placement="inline"
        title="No Bots yet"
        description="A Bot is a helper with its own name, look, and instructions."
      />
    );
  } else if (searching && visible.length === 0) {
    list = (
      <EmptyState role="status" placement="inline" title="No matching Bots" description={`Nothing matches “${query.trim()}”.`} />
    );
  } else {
    list = (
      <>
        {pinnedRow ? <PinnedBot {...rowProps(pinnedRow)} /> : null}
        {visible.length > 0 ? (
          <ul aria-label="Your Bots" className="flex flex-col gap-0.5">
            {visible.map((row) => (
              <BotRow key={row.bot.id} {...rowProps(row)} pinned={row.bot.id === pinnedBotId} />
            ))}
          </ul>
        ) : null}
      </>
    );
  }

  return (
    <>
      <Sidebar
        actions={
          <div className="flex w-full min-w-0 items-center gap-1">
            <SplitView.SidebarToggle>
              <HistoryNavButtons />
            </SplitView.SidebarToggle>
            <Button
              iconOnly
              variant="bar"
              size="small"
              className="no-drag"
              aria-label="Back to Aiden"
              title="Back to Aiden"
              onClick={() => router.history.push(lastNonBotRoute())}
            >
              <ChevronLeft />
            </Button>
            <span className="flex-1" />
            <Button
              iconOnly
              variant="bar"
              size="small"
              className="no-drag"
              aria-label="Search Bots"
              aria-pressed={searchOpen}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            >
              <Search />
            </Button>
            <Button iconOnly variant="bar" size="small" className="no-drag" aria-label="New Bot" onClick={() => setCreating(true)}>
              <Plus />
            </Button>
          </div>
        }
        footer={
          <SidebarFooter>
            <div className="flex min-w-0 items-center gap-0.5">
              <SidebarListItem
                icon={<ProfileFace name={profile.data?.name ?? ""} />}
                title={profile.data?.name?.trim() || "Profile"}
                aria-label="Profile"
                selected={pathname === "/profile"}
                className="min-w-0 flex-1"
                onClick={() => void navigate({ to: "/profile" })}
              />
              <Button
                variant="transparent"
                size="small"
                className="shrink-0"
                onClick={() => void navigate({ to: "/settings", search: { section: "mcp" } })}
              >
                <Plug /> Connect apps
              </Button>
            </div>
          </SidebarFooter>
        }
      >
        <nav aria-label="Bots" className="flex flex-col px-2.5 pb-3">
          {searchOpen ? (
            <div className="relative mb-2">
              <Input
                ref={searchRef}
                type="search"
                aria-label="Search Bots"
                placeholder="Search Bots"
                className="pr-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  if (query) setQuery("");
                  else closeSearch();
                }}
              />
              {query ? (
                <Button
                  iconOnly
                  variant="transparent"
                  size="small"
                  aria-label="Clear search"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => setQuery("")}
                >
                  <X />
                </Button>
              ) : null}
            </div>
          ) : null}
          {list}
          <RemoteBots query={query} />
        </nav>
      </Sidebar>
      <BotCreateFlow open={creating} onOpenChange={setCreating} onCreated={(bot) => openChat(bot)} />
      {deleting ? (
        <BotDeleteDialog
          bot={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
        />
      ) : null}
    </>
  );
}
```

- [ ] **Step 5: Show it on Bots pages, and move paired Macs' Bots into it**

`renderer/components/chat-sidebar.tsx`:

1. Add imports: `import { isBotsPath } from "../lib/bot-routes";` and `import { BotSidebar } from "../main/bots/bot-sidebar";`.
2. Rename `export function ChatSidebar({ activeChatId, activeRemoteChat = null, titleReveal }: ChatSidebarProps) {` to `function WorkspaceChatSidebar({ activeChatId, activeRemoteChat = null, titleReveal }: ChatSidebarProps) {`.
3. Add above it:

```tsx
/** On any Bots page the sidebar lists only Bots (spec §9); everywhere else it is the workspace outline. */
export function ChatSidebar(props: ChatSidebarProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const capabilities = useAppCapabilities();
  return capabilities.bots && isBotsPath(pathname) ? <BotSidebar /> : <WorkspaceChatSidebar {...props} />;
}
```

`renderer/components/remote-bots-section.tsx`: replace the component (keep the imports) with compact sidebar rows and a `query` filter. Headings, button names, disabled reasons and `aria-busy` are unchanged:

```tsx
/**
 * Bots that live on paired Macs, grouped by Mac, as rows in the Bots sidebar.
 * Opening one opens its chat on that Mac; nothing about a remote Bot is stored
 * or run on this one. `query` narrows them with the sidebar's search.
 */
export function RemoteBotsSection({
  groups,
  opening,
  onOpen,
  query = "",
}: {
  groups: readonly RemoteBotGroup[];
  /** `hostId/botId` of the Bot whose chat is being opened. */
  opening: string | null;
  onOpen(hostId: string, botId: string): void;
  query?: string;
}) {
  const needle = query.trim().toLocaleLowerCase();
  const shown = groups
    .map(({ host, bots }) => ({
      host,
      bots: needle
        ? bots.filter((bot) => [bot.name, bot.purpose ?? ""].some((value) => value.toLocaleLowerCase().includes(needle)))
        : bots,
    }))
    .filter((group) => group.bots.length > 0);
  if (shown.length === 0) return null;
  return (
    <div className="mt-5 flex flex-col gap-5" data-remote-bots="true">
      {shown.map(({ host, bots }) => (
        <section key={host.id} aria-labelledby={`remote-bots-${host.id}`}>
          <div className="mb-1 flex items-center gap-1.5 px-2">
            <RemoteHostMarker hostLabel={host.label} stale={host.availability !== "online"} />
            <Text id={`remote-bots-${host.id}`} as="h2" variant="small-strong" color="tertiary">
              {`On ${host.label}`}
            </Text>
          </div>
          {host.disabledReason ? (
            <Text as="p" variant="small" color="tertiary" className="mb-1 px-2">
              {host.disabledReason}
            </Text>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {bots.map((bot) => {
              const busy = opening === `${host.id}/${bot.id}`;
              return (
                <li key={bot.id}>
                  <button
                    type="button"
                    disabled={Boolean(host.disabledReason) || opening !== null}
                    aria-busy={busy || undefined}
                    aria-label={`${bot.name}, on ${host.label}`}
                    className="flex w-full min-w-0 items-center gap-2.5 rounded-control px-2 py-1.5 text-left outline-none transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent motion-reduce:transition-none"
                    onClick={() => onOpen(host.id, bot.id)}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-card bg-control text-secondary" aria-hidden="true">
                      {busy ? <Loader2 className="size-4 animate-spin" /> : <Bot className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-regular font-medium text-primary">{bot.name}</span>
                      <span className="mt-0.5 block truncate text-small text-secondary">{bot.purpose ?? `A Bot on ${host.label}.`}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

`renderer/main/remote-bots.tsx`: change the signature to `export function RemoteBots({ query = "" }: { query?: string } = {}) {` and the return to `return <RemoteBotsSection groups={groups} opening={opening} query={query} onOpen={(hostId, botId) => void open(hostId, botId)} />;`.

- [ ] **Step 6: The chat marks its Bot viewed and loses the "All Bots" back**

`renderer/main/bots/bot-chat-pane.tsx`:

1. Change `const { preferences } = useBotSidebarPreferences();` to `const { preferences, markViewed } = useBotSidebarPreferences();`.
2. Below `const snapshot = live.snapshot;` (not above it: the effect reads `snapshot`) add:

```tsx
  const entryCount = snapshot?.entries.length ?? 0;
  // Seeing the chat (and every message that arrives while it is open) clears its unread dot.
  React.useEffect(() => {
    markViewed(botId);
  }, [botId, entryCount, markViewed]);
```

3. Delete `leading={<BotChatBackButton onBack={back} />}` from `shell`, and remove `BotChatBackButton` from the `./bot-chat-header` import. Keep `back` (the "Bot not found" state's "All Bots" button uses it).

`renderer/main/bots/bot-chat-header.tsx`: delete `BotChatBackButton` and its doc comment, and drop `ChevronLeft` from the lucide import.

`renderer/main/bots/bot-chat-header.test.tsx`: remove `BotChatBackButton` from the import and from `renderHeader`, and replace the first test with:

```tsx
test("the name pill opens the Bot's profile", () => {
  const calls = renderHeader();
  fireEvent.click(screen.getByRole("button", { name: "SLMob profile" }));
  assert.deepEqual(calls, ["profile"]);
});
```

- [ ] **Step 7: Run the tests**

Run:
```bash
npx tsx --test renderer/main/bots/bot-sidebar.test.tsx renderer/main/remote-new-chat-view.test.tsx renderer/main/bots/bot-chat-header.test.tsx renderer/main/bots/bot-chat-pane.test.tsx renderer/main/bots/bot-panel.test.tsx
npx tsc --noEmit && npm run lint && npm run test:ci-policy
```
Expected: 10 sidebar tests and the remote filter test PASS, the rest still PASS, no type or lint errors, CI policy PASS.

- [ ] **Step 8: Commit**

```bash
git add renderer/main/bots/bot-sidebar-rows.ts renderer/main/bots/bot-sidebar.tsx renderer/main/bots/bot-sidebar.test.tsx renderer/components/chat-sidebar.tsx renderer/components/remote-bots-section.tsx renderer/main/remote-bots.tsx renderer/main/remote-new-chat-view.test.tsx renderer/main/bots/bot-chat-pane.tsx renderer/main/bots/bot-chat-header.tsx renderer/main/bots/bot-chat-header.test.tsx package.json scripts/ci-test-registry.json
git commit -m "Bots: a Bots-only sidebar with pinned Bot, working faces, Needs you and unread"
```

---
### Task 11: `/bots` opens the most recently used Bot; the list page goes

**Files:**
- Modify: `renderer/main/bots-view.tsx` (`BotsHome` → `BotsIndex`; imports; Profile's back)
- Modify: `renderer/main/bots/bot-profile.tsx:211` (back label)
- Delete: `renderer/main/bots/bot-list.tsx`, `renderer/main/bots/bot-list.test.tsx`
- Test: `renderer/main/bots/bots-home.test.tsx`
- Modify: `package.json` (`test:bots`), `scripts/ci-test-registry.json` (`renderer-other`)

**Interfaces:**
- Consumes: `useBotRows` (Task 10), `useBotSidebarPreferences` (Task 2), `lastViewedBotId` (Task 2), `botChatPath` (Task 1).
- Produces: `/bots` with Bots redirects (replace) to the last viewed Bot's chat, else the newest-activity Bot's chat. With no Bots it shows "Meet your first Bot" with New Bot in the toolbar. `BotProfile`'s back reads "Chat" and opens that Bot's chat.

Where the list's behaviours went: row opens chat, context menu, •••, search, loading, error, plain language, paused and needs-model labels, and the working face are in `bot-sidebar.test.tsx` (Task 10). Row times are gone: sidebar rows show no time (ruling 10), so `formatBotRowTime` and its test are deleted, not moved.

- [ ] **Step 1: Write the failing tests**

In `renderer/main/bots/bots-home.test.tsx`:

1. Change the `node:test` import to `import { afterEach, beforeEach, test } from "node:test";`, add `beforeEach(() => localStorage.clear());`, and add `import { BOT_SIDEBAR_PREFERENCES_KEY, serializeBotSidebarPreferences } from "../../lib/bot-sidebar-preferences";`.
2. Change `const idle = …` to `const idle = { botId: "bot-1", preview: null, updatedAt: null, state: { kind: "idle" }, needsYou: false, lastReplyAt: null };`.
3. Delete the four row tests ("tapping a Bot row opens its one chat directly", "the row's ••• menu opens the Bot's profile", "a Bot that needs a model says so in its row", "an interrupted Bot's row reads Paused"). They live in `bot-sidebar.test.tsx` now.
4. Add:

```tsx
const PLANNER = botFixture();
const INBOX = botFixture({ id: "bot-2", name: "Inbox" });

function twoBots(updatedAt: Record<string, number>) {
  installBotTestIpc({
    "bots:list": () => [PLANNER, INBOX],
    "bots:live:summary": (botId) => ({ ...idle, botId, updatedAt: updatedAt[botId as string] ?? null }),
    "bots:get": (botId) => [PLANNER, INBOX].find((bot) => bot.id === botId) ?? null,
    "bots:live:subscribe": (botId) => ({ ...idle, botId, epoch: "e1", seq: 0, entries: [], partial: null, question: null, activity: null, queued: [] }),
    "bots:pendingApprovals": () => [],
  });
}

test("/bots opens the chat of the Bot the person last looked at", async () => {
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: null, lastViewed: { "bot-2": 50 } }),
  );
  twoBots({ "bot-1": 900, "bot-2": 100 });
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
  assert.equal(screen.queryByRole("heading", { name: "Meet your first Bot" }), null);
});

test("with nothing viewed yet, or the last one deleted, /bots opens the Bot with the newest activity", async () => {
  twoBots({ "bot-1": 100, "bot-2": 900 });
  const first = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  await waitFor(() => assert.equal(first.router.state.location.pathname, "/bots/bot-2/chat"));
  cleanup();
  localStorage.setItem(
    BOT_SIDEBAR_PREFERENCES_KEY,
    serializeBotSidebarPreferences({ since: 1, pinnedBotId: null, lastViewed: { "bot-gone": 999 } }),
  );
  twoBots({ "bot-1": 900, "bot-2": 100 });
  const second = await mountWithBotRouter(<BotsView />, { initialPath: "/bots" });
  await waitFor(() => assert.equal(second.router.state.location.pathname, "/bots/bot-1/chat"));
});
```

5. Add a test for Profile's back:

```tsx
test("Profile's back returns to the Bot's chat", async () => {
  twoBots({});
  const { router } = await mountWithBotRouter(<BotsView />, { initialPath: "/bots/bot-2" });
  fireEvent.click(await screen.findByRole("button", { name: "Chat" }));
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots/bot-2/chat"));
});
```

The starter-carousel, "Create my own" and connection-setup tests stay as they are.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx tsx --test renderer/main/bots/bots-home.test.tsx`
Expected: FAIL. `/bots` still renders the list page, and Profile's back reads "All Bots".

- [ ] **Step 3: Implement**

In `renderer/main/bots-view.tsx`:

1. Replace the imports of `useQueries`, `botsApi`, `useBots`, `BotList`/`BotListRow` and `RemoteBots` with:

```tsx
import { RotateCcw } from "lucide-react";
import { lastViewedBotId } from "../lib/bot-sidebar-preferences";
import { useBotRows } from "./bots/bot-sidebar-rows";
import { useBotSidebarPreferences } from "./bots/use-bot-sidebar-preferences";
```

(keep `Plus`; add `Callout` and `Text` to the `../components/ui` import.)

2. Replace the whole `BotsHome` function with:

```tsx
/**
 * `/bots` with no Bot selected (spec §9): the Bot list lives in the sidebar, so
 * this opens the chat of the Bot last viewed on this Mac, else the one with the
 * newest activity. With no Bots it is "Meet your first Bot".
 */
function BotsIndex() {
  const navigate = useNavigate();
  const { bots, rows, summariesSettled } = useBotRows();
  const { preferences } = useBotSidebarPreferences();
  const [creating, setCreating] = React.useState(false);
  const openChat = (bot: BotDefinition) => void navigate(botChatPath(bot.id));
  const hasBots = (bots.data?.length ?? 0) > 0;
  const target = React.useMemo(() => {
    if (!bots.data || bots.data.length === 0) return null;
    const viewed = lastViewedBotId(preferences, new Set(bots.data.map((bot) => bot.id)));
    if (viewed) return viewed;
    return summariesSettled ? (rows[0]?.bot.id ?? null) : null;
  }, [bots.data, preferences, rows, summariesSettled]);

  React.useEffect(() => {
    // While the create flow is open it finishes first and opens the new Bot itself.
    if (target && !creating) void navigate({ ...botChatPath(target), replace: true });
  }, [creating, navigate, target]);

  if (hasBots && !creating) return <div className="h-full" />;
  return (
    <ScrollArea
      scrollRestorationId="bots-home"
      title="Bots"
      actions={
        <Button variant="toolbar" size="medium" onClick={() => setCreating(true)}>
          <Plus /> New Bot
        </Button>
      }
    >
      <main className="mx-auto w-full max-w-3xl px-5 pb-10 pt-4">
        {bots.isLoading ? (
          <BotPageSkeleton label="Loading Bots" groups={[3]} />
        ) : bots.isError ? (
          <Callout color="red" role="alert" className="flex-row items-center justify-between gap-4">
            <div>
              <Text variant="small-strong" color="red">
                Your Bots couldn’t be loaded
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-0.5">
                Check that Aiden finished starting, then try again.
              </Text>
            </div>
            <Button size="small" variant="filled" onClick={() => void bots.refetch()}>
              <RotateCcw /> Try again
            </Button>
          </Callout>
        ) : (
          <BotStarterCarousel onCreateOwn={() => setCreating(true)} onOpenChat={openChat} />
        )}
      </main>
      <BotCreateFlow open={creating} onOpenChange={setCreating} onCreated={(bot) => openChat(bot)} />
    </ScrollArea>
  );
}
```

3. In `BotsView`, change `return <BotsHome />;` to `return <BotsIndex />;`, and update its doc comment to "Routes `/bots` to the most recent Bot's chat (or the starter Bots), `/bots/$botId` to a Bot's Profile and `/bots/$botId/chat` to its chat."
4. In `BotPage`, pass `onBack={() => void navigate(botChatPath(current.id))}` to `BotProfile` instead of `onBack={allBots}`. Keep `allBots` for the loading and "Bot not found" shells.

In `renderer/main/bots/bot-profile.tsx`, change `backLabel="All Bots"` to `backLabel="Chat"`.

Delete the list:

```bash
git rm renderer/main/bots/bot-list.tsx renderer/main/bots/bot-list.test.tsx
```

Remove ` renderer/main/bots/bot-list.test.tsx` from `package.json` `test:bots` and `"renderer/main/bots/bot-list.test.tsx",` from the `renderer-other` lane.

- [ ] **Step 4: Run the tests**

Run:
```bash
npx tsx --test renderer/main/bots/bots-home.test.tsx renderer/main/bots/bot-create-flow.test.tsx renderer/main/bots/bot-profile.test.tsx renderer/main/bots/bot-profile-photo.test.tsx renderer/main/bots/bot-memory-page.test.tsx
git grep -n "bot-list\|BotList\b\|formatBotRowTime" -- renderer main tests
npm run test:bots
npx tsc --noEmit && npm run lint && npm run test:ci-policy
```
Expected: all PASS. The grep prints nothing. `bot-create-flow.test.tsx` still finds "New Bot" in the toolbar of the empty `/bots` page.

- [ ] **Step 5: Commit**

```bash
git add renderer/main/bots-view.tsx renderer/main/bots/bot-profile.tsx renderer/main/bots/bots-home.test.tsx package.json scripts/ci-test-registry.json
git commit -m "Bots: /bots opens the most recently used Bot; the list page is removed"
```

---

### Task 12: Electron check, onboarding art, docs and full verification

**Files:**
- Create: `tests/e2e/bots-sidebar-panel.spec.ts`
- Modify: `renderer/components/onboarding-art/control-art.tsx` (`BotsArt` header, about lines 178-192; lucide import)
- Modify: `docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md` (§8, §17), `docs/plans/README.md`, `.memory/bot-chat-activity.md`, `.memory/bots-rework-ui.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the record slice D starts from.

- [ ] **Step 1: Write the e2e test**

```ts
// tests/e2e/bots-sidebar-panel.spec.ts
import { botFixture } from "../../renderer/main/bots/test-fixtures";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// The e2e profile cannot open the real Bot store (no Keychain authority), so
// only the Bot IPC is substituted, as in bots-starter.spec.ts. The sidebar,
// routing, panel and workspace panel are the shipped renderer.
test("the Bots page lists only Bots, opens the latest one, and its panel shows a file it made without touching the workspace panel", async ({
  aiden,
}) => {
  const { page } = aiden;
  const planner = botFixture({ id: "bot-planner", name: "Planner", description: "Plans meals" });
  const inbox = botFixture({ id: "bot-inbox", name: "Inbox Helper", description: "Email" });
  await finishLmStudioOnboarding(page);
  await page.locator("[data-environment-toggle]").click();
  await expect(page.locator("#environment-panel")).toHaveAttribute("data-state", "open");
  const workspaceTabs = await page.evaluate(() => localStorage.getItem("aiden-agent.environment.open-tabs-v1"));

  await aiden.app.evaluate(({ ipcMain }, bots) => {
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    const [plannerBot] = bots;
    for (const channel of [
      "bots:list",
      "bots:get",
      "bots:live:subscribe",
      "bots:live:summary",
      "bots:getCanonicalPhoto",
      "bots:pendingApprovals",
      "bots:files:list",
      "bots:files:read",
    ]) ipcMain.removeHandler(channel);
    ipcMain.handle("bots:list", () => bots);
    ipcMain.handle("bots:get", (_event, botId: string) => byId.get(botId) ?? null);
    ipcMain.handle("bots:live:summary", (_event, botId: string) => ({
      botId,
      preview: botId === plannerBot!.id ? "Here’s your week." : "Inbox is clear.",
      updatedAt: botId === plannerBot!.id ? 2_000 : 1_000,
      state: { kind: "idle" },
      needsYou: false,
      lastReplyAt: null,
    }));
    ipcMain.handle("bots:live:subscribe", (_event, botId: string) => ({
      botId,
      epoch: "e1",
      seq: 0,
      partial: null,
      state: { kind: "idle" },
      question: null,
      activity: null,
      queued: [],
      entries:
        botId === plannerBot!.id
          ? [
              { id: "u1", type: "user", text: "Plan dinners", imageCount: 0 },
              { id: "f1", type: "file", path: "lists/groceries.md", operation: "written" },
              { id: "a1", type: "assistant", text: "Here’s your week.", toolCalls: [], stopReason: "stop" },
            ]
          : [],
    }));
    ipcMain.handle("bots:getCanonicalPhoto", () => null);
    ipcMain.handle("bots:pendingApprovals", () => []);
    ipcMain.handle("bots:files:list", () => ({
      entries: [
        { path: "lists", name: "lists", parentPath: "", depth: 0, kind: "directory" },
        { path: "lists/groceries.md", name: "groceries.md", parentPath: "lists", depth: 1, kind: "file" },
      ],
      truncated: false,
      skippedDirectories: 0,
    }));
    ipcMain.handle("bots:files:read", (_event, _botId: string, path: string) => ({
      path,
      content: "eggs\nmilk",
      size: 9,
      modifiedAt: 1,
      version: "v1",
    }));
  }, [planner, inbox]);

  await page.getByRole("button", { name: "Bots", exact: true }).click();
  const botsNav = page.getByRole("navigation", { name: "Bots" });
  await expect(botsNav.getByRole("button", { name: /^Planner/u })).toBeVisible();
  await expect(botsNav.getByRole("button", { name: /^Inbox Helper/u })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  await expect(page.getByPlaceholder("Ask Planner")).toBeVisible();
  await expect(page.locator("#environment-panel")).toHaveAttribute("data-state", "closed");

  await page.getByRole("button", { name: "Open groceries.md" }).click();
  const panel = page.getByRole("complementary", { name: "Bot panel" });
  await expect(panel.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByLabel("Contents of lists/groceries.md")).toHaveText("eggs\nmilk");

  const sendToggle = () =>
    aiden.app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("app:command", { commandId: "environment.toggle" });
      }
    });
  await sendToggle();
  await expect(page.locator("#bot-panel")).toHaveAttribute("data-state", "closed");
  await sendToggle();
  await expect(page.locator("#bot-panel")).toHaveAttribute("data-state", "open");
  expect(await page.evaluate(() => localStorage.getItem("aiden-agent.environment.open-tabs-v1"))).toBe(workspaceTabs);

  await page.getByRole("button", { name: "Back to Aiden" }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.locator("#environment-panel")).toHaveAttribute("data-state", "open");
  expect(await page.evaluate(() => localStorage.getItem("aiden-agent.environment.open-tabs-v1"))).toBe(workspaceTabs);
});
```

The spec is picked up by the e2e shard planner automatically (`scripts/ci-e2e-shards.mjs` discovers new specs).

- [ ] **Step 2: Run the Electron specs**

Run:
```bash
npm run type-check:e2e && npm run build
npx playwright test tests/e2e/bots-sidebar-panel.spec.ts tests/e2e/bots-starter.spec.ts tests/e2e/workspace-panel.spec.ts tests/e2e/environment-focus.spec.ts --config=playwright.config.ts --fail-on-flaky-tests
```
Expected: all PASS. If a spec fails and then passes on rerun, it is still a bug: record it in the PR description (AGENTS.md).

- [ ] **Step 3: Review the onboarding Bots tile**

`BotsArt` (`renderer/components/onboarding-art/control-art.tsx`) draws a Bot chat header with a back chevron, which the chat no longer has; the panel toggle sits beside •••. The tile's copy ("Each Bot keeps one chat, remembers what matters to you, and can check in on a schedule.") stays accurate, so only the header changes. Replace the header block with:

```tsx
        <div className="oa-bots-head oa-separator-bottom">
          <span className="oa-bots-name">
            <span className="oa-bots-avatar">
              <AvatarFace avatar={{ version: 1, shape: "drop", color: "peach" }} />
            </span>
            Meal Planner
          </span>
          <span className="oa-grow" />
          <ArtIcon icon={PanelRightOpen} />
          <ArtIcon icon={Ellipsis} />
        </div>
```

In the lucide import at the top of the file, remove `ChevronLeft` (no other art uses it) and add `PanelRightOpen`.

Run: `npm run test:onboarding`
Expected: PASS (every tile keeps its art; no raster images).

- [ ] **Step 4: Record the rulings in the spec**

In §8, under **Opening it.**, add a sub-bullet:

> - Implemented in C2 on the chat route `/bots/$botId/chat` (`renderer/main/bots/bot-workbench.tsx`), with its own state and keys (`aiden-agent.bot-panel.*`, `BotPanelProvider`). `environment.toggle` toggles it in a Bot chat and does nothing on other Bots pages. The workspace Environment, Quick View and device mini player are suppressed on every Bots path and come back unchanged.

In §17, add:

> - **Slice C2 rulings (2026-10-14):**
>   - The Bot panel lives on the chat route only; Profile and its sub-pages stay full pages.
>   - Bots on paired Macs are listed in the Bots sidebar under "On {Mac}", and search filters them.
>   - "Most recently used" is the Bot last viewed on this Mac, else the newest activity.
>   - Unread compares the last reply with last-viewed, or with when the preference record began for a Bot never viewed, so updating lights up nothing.
>   - The pinned Bot shows only as the hero; deleting it clears the pin.
>   - The footer shows the profile name's initial (Aiden has no profile photo) and Connect apps opens Settings → Plugins.
>   - The chat header has no "All Bots" back; Profile's back reads "Chat".
>   - "Memory updated" opens the panel's Memory tab.
>   - A waiting Bot's row reads "Waiting for you"; a working one "Thinking…".
>   - `bots:live:summary` gained `needsYou` and `lastReplyAt`; `bots:attention` refreshes a row when a question or approval changes. Desktop IPC only.

- [ ] **Step 5: Update the plan index**

In `docs/plans/README.md`, in the "Bot chat activity…" row, change `C2 Bots-only sidebar + Bot side panel (stacked on C1)` to `C2 Bots-only sidebar + Bot side panel (stacked on C1, [plan](../superpowers/plans/2026-10-14-bot-chat-activity-c2-sidebar-panel.md))`.

- [ ] **Step 6: Project memory**

Append to `.memory/bot-chat-activity.md`:

```markdown
## Slice C2 (desktop) — what shipped
- Bots sidebar: `renderer/main/bots/bot-sidebar.tsx`, rendered by `ChatSidebar` on any Bots path (`isBotsPath`, `renderer/lib/bot-routes.ts`). Rows from `useBotRows` (`bot-sidebar-rows.ts`): `bots:live:summary` now carries `needsYou` and `lastReplyAt`; `bots:attention` (questions/approvals) re-reads a row. ‹ goes to `lastNonBotRoute()` (recorded by `ChatLayout`).
- Pin and last-viewed: `aiden-agent.bots-sidebar.v1` (`renderer/lib/bot-sidebar-preferences.ts`, hook `use-bot-sidebar-preferences.ts`), with `since` so old replies are never unread. Not synced to phones.
- `/bots` (`BotsIndex` in `bots-view.tsx`) redirects to the last viewed Bot's chat, else the newest; the starter carousel when there are none. `bot-list.tsx` is gone.
- Bot panel: `BotPanelProvider` (`bot-panel-context.tsx`, keys `aiden-agent.bot-panel.*`) at the root; `BotWorkbench` (`bot-workbench.tsx`) on the C1 `WorkbenchPanel`, `id="bot-panel"`, fixed tabs Activity (`bot-activity-log.ts`), Files (`bot-panel-files.tsx`, replaced `bot-files-dialog.tsx`), Memory (`BotMemoryContent` shared with Profile → Memory), Routines (`BotRoutines`). Chat route only.
- `environment.toggle` → `environmentToggleTarget(pathname)`: Bot panel in a Bot chat, nothing elsewhere in Bots, workspace otherwise. `EnvironmentWorkbench` is suppressed on Bots paths.
- One live subscription per Bot: `BotLiveProvider`/`useSharedBotLive` (`renderer/lib/use-bot-live.ts`).
- One ••• menu: `bot-menu.tsx` (`BotMenuItems`, `useBotMenuActions`).
- Bots on paired Macs: `RemoteBotsSection` rows in the sidebar, filtered by search.
```

In `.memory/bots-rework-ui.md`:
- Replace the List bullet with "List: the Bots sidebar (`bot-sidebar.tsx`); `/bots` opens the most recent Bot's chat."
- Replace the Files mention with "Files: the side panel's Files tab (`bot-panel-files.tsx`)."
- In Key files add `bot-sidebar.tsx`, `bot-sidebar-rows.ts`, `bot-menu.tsx`, `bot-workbench.tsx`, `bot-panel-context.tsx`, `bot-panel-activity.tsx`, `bot-panel-files.tsx`, `bot-activity-log.ts`, `renderer/lib/bot-routes.ts`, `renderer/lib/bot-sidebar-preferences.ts`.
- In Deleted add `bot-list.tsx`, `bot-files-dialog.tsx` (2026-10-14).

- [ ] **Step 7: Run every affected suite**

```bash
npx tsc --noEmit
npm run lint
npm run test:ci-policy
npm run test:bots
npm run test:bot-runtime
npm run test:aiden-remote
npm run test:onboarding
npx tsx --test main/handlers/ipc-contract.test.ts renderer/components/workbench-panel.test.tsx renderer/lib/command-system-core.test.ts
npm test
```
Expected: all PASS, apart from the pre-existing `inline-metadata-hierarchy` failure noted in Global Constraints (confirm it fails the same way on the base commit). iOS and Android are unaffected: the Remote wire is unchanged, which `test:aiden-remote` confirms, so the mobile suites need no run for this slice. Confirm Step 2's Playwright run is green on the final head.

In the running app (`npm run dev`), check by eye: the Bots sidebar in light and dark and two theme presets; a working Bot's face glances and its "Thinking…" shimmers, and both hold still with Reduce Motion on; every row, the hero, the ••• buttons, the panel tabs and the separator show a focus ring with the keyboard; the search field shows no accent border when focused.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/bots-sidebar-panel.spec.ts renderer/components/onboarding-art/control-art.tsx docs/superpowers/specs/2026-10-14-bot-chat-activity-design.md docs/plans/README.md .memory/bot-chat-activity.md .memory/bots-rework-ui.md
git commit -m "Bots: e2e for the sidebar and panel; onboarding tile, spec rulings, memory"
```
