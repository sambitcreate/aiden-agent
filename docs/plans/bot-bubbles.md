# Bot bubbles (Edge heads)

Status: in progress (one PR). Planned 2026-11-25. Owner-approved answers: 1a, 2a, 3a, 4a, 5a, 6a, 7b.

Any Bot chat can shrink into a round head that floats over every app. Its mini chat opens beside the head when you click it. Desktop only; phones, Bots on another paired Mac and Telegram are out of scope. No Aiden Remote protocol change and no new analytics events.

## Decisions

| # | Question | Answer |
|---|---|---|
| 1 | Where bubbles float | Over every app on macOS. Linux keeps heads inside the Aiden window (see Linux below) |
| 2 | Main window while bubbled | A small card: "Penny is in a bubble" with **Bring back here** and **Open bubble** |
| 3 | How many | Up to 5. A sixth pushes the oldest head to the recent list ("Bubble again" in the Bot ••• menu) |
| 4 | Closed head shows | Unread reply count, a Needs-you mark, and a working ring |
| 5 | Approvals in the bubble | Yes, the same approval and question cards as the main chat |
| 6 | After a restart | The same Bots come back on the same side and height |
| 7 | Phones | Desktop only |

Also decided: heads never bounce (a reply only changes the count); a head shows the Bot's photo when it has one, otherwise its face.

**Linux:** Electron only passes clicks through a see-through window on macOS and Windows. The plan allowed Linux X11 to keep heads inside the Aiden window if a bounded X11 overlay proved shaky; it can't be checked on real X11 hardware here, so Linux (X11 and Wayland) draws heads inside the Aiden window. "Float over other apps" is shown only where it works (macOS).

## Behaviour

- **Entry points:** a bubble button in the Bot chat header next to •••; "Bubble" in the Bot ••• menu and the sidebar right-click menu; command `bots.bubble` "Bubble this Bot" with default ⌥⌘B (changeable in Settings → Keyboard shortcuts, listed in the command palette).
- **Head:** 52 px circle; photo or face (glances while working) with a thin turning ring while working; blue unread count; small amber Needs-you mark; hover peek with name and latest line; drag anywhere, release snaps to the nearest side, a flick throws it to the far side; heads on one side stack without overlapping (12 px gap); while dragging a × target rises near the bottom and pulls the head in when close (84 px), release closes the bubble; right-click: Open, Open in Aiden, Close bubble.
- **Mini chat:** opens beside its head with a pointer to it; click the head again, Esc or click elsewhere tucks it away. Shows transcript, status line, approval and question cards, compact composer. Header: Open in Aiden, Shrink, Close bubble. One mini chat open at a time; opening it clears that Bot's unread count.
- **Main window:** a bubbled Bot's chat shows the "in a bubble" card instead of the chat (one home at a time). The sidebar row shows a small Bubble label.
- **Settings → Bots → Bubbles:** Allow bubbles (default on; off hides every head and the bubble button), Float over other apps (default on; macOS only).
- **Keyboard and motion:** Tab reaches each head (in the floating overlay, only while a mini chat is open, because the overlay never takes focus otherwise); Enter opens, Delete closes, arrows move, Esc tucks the chat away; focus rings stay visible. Reduce Motion: heads move without the spring, the shrink becomes a short fade, the mini chat opens and closes at once and the grow is skipped.
- **Deleted Bot:** its head disappears. **Paused Bot:** unchanged; its chat shows the paused state.

## Implementation contract

Shared types and channels: `renderer/shared/bot-bubbles.ts`. Renderer client and store: `renderer/lib/bot-bubbles-api.ts` (`botBubblesApi`, `useBotBubbles`, `applyBotBubbleChange`).

### Main (`main/services/bot-bubbles/`, `main/handlers/bot-bubbles.ts`)

- One service owns `BotBubbleState`: ordered bubbles (oldest first, max 5), `openBotId`, recents (max 8, most recent first, never a bubbled Bot), settings, host.
- Persisted in `<userData>/bot-bubbles.json` `{ version: 1, bubbles: [{ botId, side, y, displayId }], recents: [] }`, written atomically; a damaged or unknown file starts empty. `openBotId` is not persisted. Never sent to phones, paired Macs or analytics.
- Settings live in app settings: `botBubblesEnabled?: boolean` and `botBubblesFloatOverApps?: boolean` (undefined means on), saved through `settings:set`.
- Host: `off` when disabled; `overlay` when `floatOverApps` and macOS; otherwise `window`.
- Bots that no longer exist are pruned on load and on `bots:changed`.
- Every change broadcasts `bots:bubbles:changed` with the full state.
- `bubble` is main-window-only; `close`, `open`, `move`, `bringBack` are allowed from the main window and the bubble overlay; `setInteractive`, `setDragging`, `overlayInfo` only from a current bubble overlay document. Bot ids go through `parseBotId`.
- `bringBack`: closes the bubble, shows and focuses the main window, and sends it `bots:bubbles:showChat { botId }`.
- Live chat "in front": an overlay document counts as showing a Bot in front only for its open mini chat Bot (`BotLiveOwner.inFront(botId)`).

### Overlay window (`main/windows/bot-bubbles-window.ts`, `bot-bubbles.html`, `renderer/preload-bot-bubbles.ts`)

- macOS only. One overlay per display that has heads, sized to the display work area; set up like Quick Chat (`type: "panel"`, frameless, transparent, no shadow, always on top at "floating"/"pop-up-menu" level, visible on all workspaces and over full-screen apps with `skipTransformProcessType`, skip taskbar, hidden in Mission Control, not resizable/movable, auxiliary window, sandboxed, `backgroundThrottling: false`).
- Clicks pass through (`setIgnoreMouseEvents(true, { forward: true })`) except when the renderer says the pointer is over a head, the peek, the × target, a menu or the open chat (`setInteractive`).
- Overlays are created non-focusable; opening a mini chat makes the overlay focusable and focuses it, and closing the chat makes it non-focusable again and hands the key window on without `blur()` (which on macOS orders the window out and back in and blinks every head). A crashed or reloaded overlay renderer resets to click-through and is rebuilt (with a crash-loop guard).
- Overlays exist only while at least one head is out on their display; display removal moves heads to the primary display.
- Shrink across windows: on `bubble` with `sourceRect`, main captures that rect of the main window (`webContents.capturePage`) and sends the overlay a `BotBubbleTransition` in overlay-local coordinates. When that display's overlay is already listening, the transition goes first with a `cover` number: the overlay shows the picture over the chat, answers `bots:bubbles:transitionShown`, and only then does main add the bubble (main waits at most 250 ms), so the window swaps its chat for the card under the picture and the shrink starts when the head arrives; `bringBack` sends `kind: "grow"` toward the main window's content bounds before showing the main window.
- Least-privilege bridge with its own invoke and notification allowlists (mirrors Quick Chat): live chat (`bots:live:*`), Bot read (`bots:get`, `bots:list`, `bots:getCanonicalPhoto`), send/stop/resume/dismiss/withdraw, approvals and questions (`bots:approve`, `bots:pendingApprovals`, `bots:answerQuestion`), the `bots:bubbles:*` channels, read-only settings/appearance, `app:getInfo`. No settings changes, terminal, browser, files, screen capture or native dialogs.

### Renderer (`renderer/bot-bubbles/`)

- `head-layout.ts`: pure layout math (stacking per side, side choice with flick, × pull distance, keyboard moves, mini chat placement and pointer offset, share ↔ pixels).
- Head layer component used by both hosts; mini chat component built from the shared Bot chat pieces (`TranscriptEntries`, approval and question cards, status line) extracted from `bot-chat-pane.tsx`.
- `window-host.tsx` exports `BotBubbleWindowHost` (heads inside the Aiden window when `host === "window"`); `main.tsx` is the overlay entry.

### Main window entry points

Header button, ••• and sidebar menu items, `bots.bubble` command, "in a bubble" card, sidebar label, Settings → Bots → Bubbles, `bots:bubbles:showChat` navigation.

## Done

- Behaviour tests (service fixtures, IPC register-and-invoke, preload allowlists, layout math, rendered components) and a hands-on check of the overlay on a Mac.
- No Playwright spec: the bubble service checks that a Bot exists through the Bot store in main, which the E2E profile can't open (the existing Bot specs mock the Bot IPC), and adding a production test seam for it isn't worth it. Rendered component tests cover the in-window heads instead.
- Docs: README.md, PRODUCT.md, docs/bot-bubbles.md, shortcut lists, docs/plans/README.md. Onboarding Bots tile shows a head with an unread count.
