# Chats without a workspace

Aiden offers three places a chat can run:

1. **A workspace on your folder.** Open a folder, type a path or clone a repository. The chat works on your files with that workspace's access level.
2. **A scratch workspace.** **Scratch chat** makes a new, randomly named folder in `~/aiden` (for example `~/aiden/calm-moon-sail`) and registers it as a workspace you can see and reopen.
3. **No workspace.** The chat uses your global settings and is listed under **Chats** in the sidebar instead of under a workspace. Behind the scenes it still runs in a real folder that Aiden manages, so files, skills, the terminal and Git keep working.

## Choosing No workspace

- The workspace menu on a new chat (the composer chip or the headline) lists **No workspace** after Scratch chat. **New chat in…** (`⌘⇧N`) lists it too.
- The sidebar's **Chats** group collects every No workspace chat. Its **+** button and its menu start another one.
- A new install starts in No workspace.

## Where the folders are

Each No workspace chat gets its own folder in Aiden's app data, named like a scratch folder:

| Platform | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/Aiden Agent/chat-folders/<name>` |
| Linux | `~/.config/Aiden Agent/chat-folders/<name>` |

The folder is created when the chat is first sent, so a draft you abandon leaves nothing behind. If the folder goes missing (cleared app data, a manual delete), Aiden makes it again, empty, on the next message. The model is told the folder is private to the chat, so it can use it for downloads, clones and scratch files.

The chat's header chip reads **No workspace**; its menu can still show the folder in Finder or a file manager.

## Settings, access and memory

- No workspace chats follow global settings. Per-workspace settings (such as the skills and connectors a workspace switches off) never apply to them.
- Access starts at **Ask first**, like any new workspace, and can be changed from the composer for that chat.
- All No workspace chats share one memory. It is the memory the old folderless "Workspace" used, so facts saved there carry on. Settings → Memory lists it as **No workspace chats**.

## Deleting

Deleting a No workspace chat moves its folder to the Trash (an empty folder is simply removed). Startup also clears away hidden folders left without a chat.

## Older installs

Every install used to have a folderless workspace called "Workspace" whose chats could not read files or use Git. On the first start with this version it becomes the No workspace home of those chats: it gets one hidden folder that those older chats share, and their memory stays where it was. Chats started from then on each get their own folder.

## Platforms

Desktop (macOS and Linux). Paired phones and the CLI do not offer No workspace yet: a phone lists each hidden workspace by its name, **No workspace**, and can open and continue those chats.
