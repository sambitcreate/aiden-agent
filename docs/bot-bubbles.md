# Bot bubbles

Any Bot chat can shrink into a round head that stays on screen while you work
elsewhere. Click the head and a small chat opens beside it, so you can read a
reply, answer a question or approve an action without going back to Aiden's
main window. Plan and decisions: [docs/plans/bot-bubbles.md](plans/bot-bubbles.md).

## Bubbling a Bot

Open the Bot's chat, then use any of these:

- the **Bubble** button in the chat header, next to `•••`;
- **Bubble** in the Bot's `•••` menu, or in its sidebar row's right-click or
  `•••` menu;
- **Bubble this Bot** (`bots.bubble`), `⌥⌘B` by default. It works while a Bot
  chat is open and is listed in the command palette (`⌘K`) only then. Change or
  turn off the key in **Settings → Keyboard shortcuts**; a key you already gave
  another command keeps it, and Bubble this Bot starts unassigned.

The chat shrinks into the head. While a Bot is bubbled, its chat in the main
window shows a small card instead ("Penny is in a bubble") with **Bring back
here** and **Open bubble**, so the conversation has one home at a time. Its
sidebar row shows a **Bubble** label, and its `•••` menu offers **Open bubble**
and **Bring back to window** instead of Bubble.

## The head

- Shows the Bot's photo, or its face, which glances while the Bot works. A thin
  ring turns while it is working.
- A blue count shows replies you haven't read; a small amber mark means the
  Bot needs you (an approval or a question). Heads never bounce: a reply only
  changes the count.
- Hover to peek at the Bot's name and latest line.
- Drag it anywhere. Let go and it snaps to the nearer side; a quick flick
  throws it to the far side. Heads on one side stack without overlapping.
- While you drag, a × target rises near the bottom of the screen. Drop the head
  on it to close the bubble.
- Right-click for **Open**, **Open in Aiden** and **Close bubble**.

## The mini chat

Clicking a head opens its chat beside it, with a pointer to the head. It shows
the transcript, the status line, the same approval and question cards as the
main chat, and a compact message box. Its header has **Open in Aiden** (closes
the bubble and opens the chat in the main window), **Shrink** and **Close
bubble**. Click the head again, press `Esc` or click elsewhere to tuck it away.
One mini chat is open at a time, and opening it clears that Bot's unread count.

## Limits, recents and restarts

- Up to 5 heads are out at once. Bubbling a sixth Bot moves the oldest head to
  the recent list.
- A closed or pushed-out bubble is remembered (up to 8). Its Bot's `•••` menu
  then offers **Bubble again**.
- After a restart the same Bots come back, on the same side and at the same
  height.
- A deleted Bot's head disappears. A paused Bot keeps its head, and its chat
  shows the paused state.

## Settings

**Settings → Bots → Bubbles**:

- **Allow bubbles** (on by default). Off hides every head, the header button,
  the menu items and `⌥⌘B`.
- **Float over other apps** (on by default, macOS only). Heads stay on top of
  every app, every Space and full-screen apps. Off keeps them inside the Aiden
  window. Where floating isn't available the page says that heads stay inside
  the Aiden window.

## Keyboard and motion

`Tab` reaches each head; `↩` opens its chat, `Delete` closes the bubble, the
arrow keys move it, and `Esc` tucks the chat away. Focus rings stay visible.
Heads floating over other apps never take keyboard focus from the app you are
using, so there they are reachable by keyboard while a mini chat is open
(`Tab` moves between the heads and the chat). Heads inside the Aiden window are
always reachable with `Tab`.
With **Reduce Motion** on, heads move without the spring and the shrink becomes
a short fade.

## Where it works

| Platform | Bubbles |
| --- | --- |
| macOS | Heads float over every app (or stay inside the Aiden window with Float over other apps off) |
| Linux (X11 and Wayland) | Heads stay inside the Aiden window. Electron can pass clicks through a see-through window only on macOS and Windows, so there is no floating overlay here |
| `aiden serve` (CLI), iOS, Android | No |

Bubbles are a view of Bots on this computer. Bots on a paired Mac and Telegram
chats can't be bubbled.

## Privacy

Which Bots are bubbled, and where their heads sit, is saved in
`bot-bubbles.json` in Aiden's data folder on this computer only. It is never
sent to phones, paired Macs or analytics, and bubbles add no analytics events.
There is no Aiden Remote protocol change.

## Security

On macOS the heads live in a see-through overlay window per display. Clicks
pass through it except over a head, the peek, the × target, a menu or the open
mini chat, and heads never take focus from the app you are using. The overlay
loads its own least-privilege preload: it can read and talk to Bot chats
(live transcript, send, stop, approvals and questions), read Bots, read-only
settings and appearance, and use the `bots:bubbles:*` channels. It can't change
settings or open the terminal, browser, files, screen capture or native
dialogs. Shrinking into a head from the main window and bubbling a Bot are
allowed only from the main window.

## For developers

- Contract: `renderer/shared/bot-bubbles.ts`; renderer client and store:
  `renderer/lib/bot-bubbles-api.ts` (`botBubblesApi`, `useBotBubbles`,
  `applyBotBubbleChange`).
- Main: `main/services/bot-bubbles/`, `main/handlers/bot-bubbles.ts`, overlay
  window `main/windows/bot-bubbles-window.ts` with `renderer/preload-bot-bubbles.ts`.
- Renderer: heads, mini chat and layout math in `renderer/bot-bubbles/`;
  `BotBubbleWindowHost` draws heads inside the main window when the host is
  `window`.
- Main-window entry points: the header button (`renderer/main/bots/bot-chat-header.tsx`),
  the menu items (`renderer/main/bots/bot-menu.tsx`), the sidebar label
  (`renderer/main/bots/bot-sidebar.tsx`), the `bots.bubble` command and
  `bots:bubbles:showChat` navigation (`renderer/main/root-view.tsx`), and the
  settings page (`renderer/components/settings/bot-bubbles-settings.tsx`).
