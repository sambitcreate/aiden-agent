# Bot bubbles (Edge heads) — 2026-11-25

Branch: `feature/bot-bubbles` (one PR). Plan: `docs/plans/bot-bubbles.md` (owner answers 1a–6a, 7b). Guide: `docs/bot-bubbles.md`.

## Summary
- Any Bot chat can shrink into a 52 px round head (max 5; a sixth pushes the oldest to recents, max 8). Click opens a mini chat beside the head with transcript, status line, approval and question cards and a compact composer. Heads show unread count, a Needs-you mark and a working ring; they never bounce.
- Desktop only. No Aiden Remote protocol change, no phone or CLI work, no new analytics events. The list lives in `<userData>/bot-bubbles.json` (`version: 1`), never sent to phones, paired Macs or analytics.

## Key files
- Contract: `renderer/shared/bot-bubbles.ts` (channels `bots:bubbles:*`, `BotBubbleState`, parsers). Client/store: `renderer/lib/bot-bubbles-api.ts` (`botBubblesApi`, `useBotBubbles`, `applyBotBubbleChange`, `botBubbleStore`).
- Main: `main/services/bot-bubbles/` (core + service), `main/handlers/bot-bubbles.ts`, overlay `main/windows/bot-bubbles-window.ts`, preload `renderer/preload-bot-bubbles.ts`.
- Renderer heads/mini chat: `renderer/bot-bubbles/` (`head-layout.ts` pure math, `window-host.tsx` exports `BotBubbleWindowHost`, `main.tsx` overlay entry).
- Main-window entry points: `BotBubbleButton` inside `BotChatActions` (`renderer/main/bots/bot-chat-header.tsx`), menu items in `BotMenuItems` (`bot-menu.tsx`: `botBubbleMenuItems`, `bubbleBot`, `botChatSourceRect`; actions `bubble` / `openBubble` / `bringBack` in `useBotMenuActions`), sidebar `BotBubbleChip` (`bot-sidebar.tsx`), `BotBubbleRoot` in `renderer/main/root-view.tsx` (command `bots.bubble`, `onShowChat` navigation, mounts `BotBubbleWindowHost`).
- Command `bots.bubble` "Bubble this Bot", `Command+Alt+B` (⌥⌘B), app scope, `paletteWhenAvailable` (handler registered only with a Bot chat open, host not off, Bot not bubbled), listed in `INTRODUCED_DEFAULT_COMMANDS`. No native menu entry.
- Settings → Bots → Bubbles: section/page `botBubbles` (group Autonomy & Devices, page title "Bots", gated by optional `SettingsCapabilities.bots`), `renderer/components/settings/bot-bubbles-settings.tsx`. Settings fields `botBubblesEnabled` / `botBubblesFloatOverApps` (undefined = on), saved with `settings:set`.
- Onboarding: Bots tile art (`BotsArt` in `onboarding-art/control-art.tsx`) has a floating head with an unread count; tile copy mentions floating bubbles.

## Decisions
- Host: `off` when Allow bubbles is off (heads stay in the list but hidden; header button, menu items, sidebar label and ⌥⌘B all disappear), `overlay` on macOS with Float over other apps on, else `window` (heads inside the Aiden window).
- Linux (X11 and Wayland) always uses `window`: Electron passes clicks through a transparent window only on macOS/Windows, and an X11 overlay couldn't be checked on real hardware. "Float over other apps" shows only where `floatOverAppsAvailable` (macOS).
- One home at a time: a bubbled Bot's main-window chat shows the "in a bubble" card (Bring back here / Open bubble).
- "Bubble again" is the Bubble item's label for a Bot in `recents`.
- Overlay focus: overlays are created `focusable: false`; only the overlay holding the open mini chat is made focusable and focused (`applyFocus`, re-run on every sync, focuses once per newly opened chat). So overlay heads are keyboard-reachable only while a mini chat is open; in-window heads always are.
- Overlay least privilege in main: `main/windows/bot-bubbles-overlay-access.ts` wraps every `registerBotHandlers` and bubble handler. Overlay requests must come from the overlay's trusted main document (`isBotBubbleOverlayEvent`) and name a Bot whose head is on that overlay's display (approvals via the wait's Bot), `bots:list` is filtered the same way, `bots:live:unsubscribe` always passes, the overlay controls pass for the trusted page, and every other channel on that handle is refused for overlays. Overlay notifications are filtered to that display's heads (`botBubbleOverlayHears`).
- Overlay trust compares the page URL without its `#fragment` (in-page links in replies). A refused overlay sender is reset to click-through. Crashed/hung overlays are rebuilt, at most 3 times per display per minute.
- Tuck on blur / click outside sends `open(null, { ifOpen })` so a late tuck can't close a chat just opened on another display.
- A focused overlay doesn't count as "Aiden focused" for hand-off, access-request and issue banners (`isAidenAppWindowFocused` in `bot-bubbles-overlay-registry.ts`).
- Live feeds: `BotLiveOwner.mayFollow` (overlay pages: `botBubbleOverlayDrawsBot`) is checked on every live event, so an overlay's feed for a Bot ends when its head leaves that display or closes, even without an unsubscribe.
- Unread counts: both hosts count with `botUnreadReplyCount` over person-facing reply times (`botRecentReplyTimes`, capped at 100; badge and label say 99+). Overlay heads take them from their live feed; in-window heads must not subscribe (it would mark the chat on screen), so they count from `BotLiveSummary.recentReplyAt` (newest-first reply times, capped at 100, same rule as `lastReplyAt`).
- Settings receipts in the mini chat show no Undo (`SettingsChangeReceipt` hides it without `onUndo`).
- No Playwright spec: the bubble service checks Bots through the Bot store in main, which the E2E profile can't open. The overlay was not tried hands-on on a Mac in the PR session.
- The ••• / sidebar "Bubble" shrinks from the chat area only when that Bot's chat is the open route; otherwise the head simply appears.

## Test notes
- `botBubbleStore` resets `loaded` when its last listener leaves, so a later consumer waits for a fresh read.
- Head order on a side survives saving: shares aren't clamped to the 14 px margin and `placeHeadInStack` picks a wanted y strictly between neighbours.
- Tests set bubble state with `botBubbleStore.accept(...)` and reset to `EMPTY_BOT_BUBBLE_STATE` after each test (the store is a module singleton).
- In `bot-sidebar.test.tsx`, clicking a right-click (Radix ContextMenu) item and then waiting with a failing `waitFor` hung the happy-dom run; the bubble test drives the row's ••• dropdown instead.

## Animation pass (2026-11-25): what flickered and the fix
- **Tucking a mini chat blinked every head (the reported bug).** `applyFocus` called `window.blur()`; on macOS Electron implements that as `orderOut:` then `orderBack:` (`NativeWindowMac::Focus(false)`, checked in v43.8.4), so the whole overlay left the screen for a moment. Only head click, Esc, Shrink, ⌘W, Close bubble and Open in Aiden from the chat hit it; click-outside did not (the overlay was no longer key). Now `releaseOverlayFocus` (core) makes the overlay unfocusable, then `passKeyOn` gives the key window to a 1 px see-through `BaseWindow` panel that is destroyed at once; `blur()` stays only as the fallback when the overlay is still key afterwards. Not seen on a real Mac in that session.
- **The mini chat had no exit.** It unmounted on the state change. `BotBubbleHeads` now keeps the same element mounted as `closing` (inert, no hit region, no Escape layer, marks nothing seen) until its `animationend`, with a 400 ms timer as fallback. Re-opening while it leaves keeps the element and the draft.
- **Shrink showed the card first.** The window swapped to the "in a bubble" card on `changed` before the overlay had decoded and painted the picture. Now `coverChat` sends the transition before the bubble exists (`cover` number, `bots:bubbles:transitionShown` ack, 250 ms cap), and `BotBubbleTransitionView` shows nothing until `img.decode()`, holds still until its head exists (600 ms cap, then fades in place). First head on a display still plays late: no overlay exists to cover with.
- **Grow with Reduce Motion (or no known head) flashed a window-sized sheet.** It is skipped now.
- **Drop on ×:** the head sprang back toward its side for a few frames before main removed it. It now stays on the × until the bubble is gone (back to its side if the close fails).
- **Faces:** a new head showed the default face, then the real one, then the photo; and adding a head emptied the photo cache, so every other head blinked to its drawn face. Heads hold their last photo while it reloads and stay at opacity 0 (`data-arriving`) until Bot and photo are known (600 ms cap).
- After Escape with the pointer over the closing chat the overlay stayed interactive until the mouse moved; the layer now asks again what is under the pointer when a chat closes.
- Test note: never pass a DOM node to `assert.equal` inside a `waitFor` that may fail; printing the happy-dom node stalls the run. Compare with `===` and `assert.ok`.
- Left alone: the mini chat jumps (no glide) when its head restacks; coming back to the window shows the chat skeleton for one read.
