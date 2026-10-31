# Keyboard control

Aiden's desktop app aims to be fully usable without a mouse. This page lists
the keys that exist today. Keys are shown with Mac symbols; on Linux and
Windows, `⌘` is `Ctrl`, `⌥` is `Alt` and `⇧` is `Shift`.

Every key in the tables below, except the fixed keys (the approval keys, `/`,
`F6`, the arrow keys and `↑` in the message box, listed in
`renderer/shared/built-in-keys.ts` and under **Built-in keys** in Settings), lives in the
one command catalog (`renderer/shared/keybindings.ts`), so it can be changed
or turned off in **Settings → Keyboard shortcuts**, and the native menus and button tooltips
show the current choice. Keys added in a later release never take a shortcut
someone already saved for another command; that command keeps it and the new
one starts unassigned.

## Everywhere

| Key | Does |
| --- | --- |
| `⌘K` | Command palette: commands, chats, models, providers, Settings, appearance, Bots |
| `⌘/` | Keyboard shortcuts: every key as set in Settings plus the built-in ones, searchable |
| `⌘N` / `⇧⌘N` | New chat / New chat in… |
| `⇧⌘F` | Search chats |
| `⌘1`–`⌘9` | Open the chat with that number (hold `⌘` to see the numbers); on the Bots page, the Bot on that row |
| `⇧⌘[` / `⇧⌘]` | Previous / next chat, or Bot on the Bots page |
| `⌘[` / `⌘]` | Go back / go forward |
| `⇧⌘M` | Change model |
| `⌘,` | Open Settings |
| `⌘B` | Toggle sidebar |
| `⌘O` / `⇧⌘O` | Open workspace in preferred editor / Open folder… |
| `⌘J` / `⇧⌘E` | Toggle terminal / Toggle Environment |
| `⌘S` | Save file (Files editor) |

## Moving around the window

| Key | Does |
| --- | --- |
| `F6` / `⇧F6` | Move to the next / previous area: sidebar, conversation, message box, side panel |
| `↑` `↓` | Move between chats or Bots in the sidebar |
| `Home` / `End` | First / last row in the sidebar |
| `←` / `→` | In the sidebar, close / open a project folder; `←` on a chat goes to its folder |

`F6` lands on the sidebar's open chat, on the conversation itself (scroll it
with the arrow keys, Page Up and Page Down), in the message box, or on the
side panel's selected tab. Areas that are hidden or closed are skipped, and
`F6` does nothing while a menu or dialog is open. The sidebar list is a
single `Tab` stop: `Tab` reaches the open chat (and its `•••`), then leaves the
list. ⌘K also has **Focus sidebar**, **Focus conversation** and **Focus side
panel**, which can be given their own keys in Settings.

The chat keys (`⌘1`–`⌘9`, `⇧⌘[` / `⇧⌘]`) also work while typing in the
message box.

Global keys (`⌥⌘Space` focus composer, `⇧⌘D` dictation, `⌥⌘A` open Aiden)
work while Aiden is in the background.

## In a chat

| Key | Does |
| --- | --- |
| `⌘.` | Stop the reply (`Esc` also works from the message box) |
| `⌘U` | Attach files |
| `⌘F` | Find in this chat: `↩` / `⇧↩` (or `⌘G` / `⇧⌘G`) next / previous match, `Esc` closes |
| `↑` | In an empty message box, bring back your last message to fix and send again |
| `⌥↑` / `⌥↓` | Step to the previous / next reply and its Copy and Fork buttons |
| `⌘↩` | Allow once, while an approval is waiting and the message box is empty |
| `⌘⌫` | Deny, under the same conditions |
| `/` | Slash commands in the message box |

`↑` works like **Edit in fork**: it forks the chat just before your last
message and puts that message back in the box, so the original chat stays as
it was. It needs that message to have a finished reply, and does nothing while
a reply is coming, in a Bot chat, or when the box holds anything. `⌥↑` works
from the conversation or an empty message box; `⌥↓` past the latest reply
returns to the message box. Find in chat searches the conversation on screen,
ignoring case, and keeps counting as replies stream in. A word split by
formatting (half bold) is not found.

The approval keys are fixed rather than set in Settings. They act only on the
open chat's approval (the first one in a Bot chat), and only from the message
box or a button. They never act while the message box holds anything (even
spaces or an attachment), while focus is in another text field, the terminal
or the file editor, or while a menu or dialog is open. The buttons show them when the card is wide enough. When an
approval appears, screen readers announce it.

In the Browser panel, `⌘.` starts page markup instead of stopping the reply,
but only while focus is inside the browser.

## Keyboard list and menu bar

`⌘/` (or **Help → Keyboard Shortcuts**) opens a searchable list of every key,
grouped as General, Moving around, In a chat and Workspace. It shows the keys
as set in Settings, leaves out commands with no key, and includes the built-in
keys with when each one applies. **Change keys…** opens Settings → Keyboard
shortcuts, which lists the same built-in keys under **Built-in keys**, below
the ones you can change. `⌘/` also works from the message box.

The menu bar has **View** (sidebar, terminal, Environment, the Focus commands),
**Go** (back, forward, previous and next chat, Search chats, Bots, Scheduled,
Profile), **Chat** (model, attach, find, stop and the open chat's actions) and
**Help → Keyboard Shortcuts**, next to File, Edit and Window. Each item shows
its current key, and items that can't run right now (no chat open, nothing to
stop) are greyed out. These items only show their key: the key itself still
follows the rules on this page (for example, it doesn't act while you type in
the terminal). On Linux, `Alt` opens the menu bar.

When first-run setup finishes, the message box has focus, so you can start
typing straight away.

## From ⌘K

Besides the keyed commands above, the palette lists commands with no default
key. You can give any of them one in Settings.

- **Places:** Go to Bots, Open a Bot… (searches Bots by name), Go to Scheduled,
  Go to Profile, Open Design Studio, Open Create Images.
- **Workspace tools:** Open Changes, Files, Browser, Device, Context,
  Subagents and Artifacts.
- **Chat actions:** Rename chat…, Duplicate chat, Delete chat…, Export chat,
  Compact chat, Fork chat…, Copy last reply, Chat details, Change folder
  access. These use the same rules as the matching slash commands and appear
  only while the open chat can run them.

## Menus on rows and messages

`⇧F10` (or the Menu key) opens the right-click menu of the focused sidebar
chat, Bot row or message. Sidebar chats and Bots also have a `•••` button that
appears on hover or focus and is reachable with `Tab`. A chat's menu has
Rename, Rename with Apple (where available) and Delete; `/delete` and ⌘K →
Delete chat… ask the same question for the open chat.
