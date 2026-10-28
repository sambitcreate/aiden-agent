# Keyboard control

Aiden's desktop app aims to be fully usable without a mouse. This page lists
the keys that exist today. Keys are shown with Mac symbols; on Linux and
Windows, `⌘` is `Ctrl`, `⌥` is `Alt` and `⇧` is `Shift`.

Every key in the tables below, except the approval keys and `/`, lives in the
one command catalog (`renderer/shared/keybindings.ts`), so it can be changed
or turned off in **Settings → Keyboard shortcuts**, and the native menus and button tooltips
show the current choice. Keys added in a later release never take a shortcut
someone already saved for another command; that command keeps it and the new
one starts unassigned.

## Everywhere

| Key | Does |
| --- | --- |
| `⌘K` | Command palette: commands, chats, models, providers, Settings, appearance, Bots |
| `⌘N` / `⇧⌘N` | New chat / New chat in… |
| `⇧⌘F` | Search chats |
| `⌘1`–`⌘9` | Open the chat with that number (hold `⌘` to see the numbers) |
| `⇧⌘[` / `⇧⌘]` | Previous / next chat |
| `⌘[` / `⌘]` | Go back / go forward |
| `⇧⌘M` | Change model |
| `⌘,` | Open Settings |
| `⌘B` | Toggle sidebar |
| `⌘O` / `⇧⌘O` | Open workspace in preferred editor / Open folder… |
| `⌘J` / `⇧⌘E` | Toggle terminal / Toggle Environment |
| `⌘S` | Save file (Files editor) |

Global keys (`⌥⌘Space` focus composer, `⇧⌘D` dictation, `⌥⌘A` open Aiden)
work while Aiden is in the background.

## In a chat

| Key | Does |
| --- | --- |
| `⌘.` | Stop the reply (`Esc` also works from the message box) |
| `⌘U` | Attach files |
| `⌘↩` | Allow once, while an approval is waiting and the message box is empty |
| `⌘⌫` | Deny, under the same conditions |
| `/` | Slash commands in the message box |

The approval keys are fixed rather than set in Settings. They act only on the
open chat's approval (the first one in a Bot chat), and only from the message
box or a button. They never act while the message box holds anything (even
spaces or an attachment), while focus is in another text field, the terminal
or the file editor, or while a menu or dialog is open. The buttons show them when the card is wide enough. When an
approval appears, screen readers announce it.

In the Browser panel, `⌘.` starts page markup instead of stopping the reply,
but only while focus is inside the browser.

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
