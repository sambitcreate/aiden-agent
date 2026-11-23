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

Copying a chat or forking from a reply gives the new chat a separate, empty private folder and its own **Ask first** access setting. Conversation history is copied; files and workspace access are not shared. This also applies when copying an older chat from the migrated shared home. Previously created shared copies keep their existing files and access; Aiden does not move or duplicate that existing data automatically.

A skill selected before the first send is validated in the draft's original workspace, while its one-turn instructions run in the newly assigned private folder.

The chat's header chip reads **No workspace**; its menu can still show the folder in Finder or a file manager.

## Settings, access and memory

- No workspace chats follow global settings. Per-workspace settings (such as the skills and connectors a workspace switches off) never apply to them.
- Access starts at **Ask first**, like any new workspace, and can be changed from the composer for that chat.
- All No workspace chats share one memory. It is the memory the old folderless "Workspace" used, so facts saved there carry on. Settings → Memory lists it as **No workspace chats**.

## Temporary chats & attaching to a workspace

Chats started from the Floating Quick Chat starter (`⌘⇧Space` on macOS, `Ctrl+Shift+Space` on Linux) default to **Temporary**. A Temporary chat runs in its own hidden private folder like a No workspace chat, but stays out of the sidebar, Inbox, durable Memory, and paired-device lists and is cleaned up automatically if discarded or left unsaved across restarts.

- Until it's saved or attached, a Temporary chat keeps nothing that outlives its reply: it can't have a keep-going goal (`/goal`, `/until` or one the agent suggests), the agent isn't offered check-backs or starting other chats, and a task scheduled in it runs in its own chat instead of posting into this one. Once you save or attach it, its next turn has them.
- Choose **Save** to promote a Temporary chat into **Chats** as a durable No workspace chat.
- Choose **Attach to workspace…** on any Temporary or No workspace chat (from the Quick Chat mini-modal or the main window's top bar) to move the conversation in-place into a project workspace folder. If files were created in the private scratch folder, Aiden prompts whether to copy them into the workspace (or leave them behind) before continuing with a clean workspace context boundary.

## Deleting

Deleting a No workspace chat moves its folder to the Trash (an empty folder is simply removed). Startup also clears away hidden folders left without a chat. A new chat that was still aimed at the deleted chat's folder (a fork of it, or the new chat that opens after the delete) stays under Chats and gets a folder of its own when you send it.

## Older installs

Every install used to have a folderless workspace called "Workspace" whose chats could not read files or use Git. On the first start with this version it becomes the No workspace home of those chats: it gets one hidden folder that those older chats share, and their memory stays where it was. Chats started from then on each get their own folder.

## Platforms

Desktop (macOS and Linux), and Aiden On The Go for iPhone and Android paired to a desktop on contract revision 51.

On a phone, the sidebar shows the same one **Chats** group, and **New Chat** offers **No Workspace** first, above New Workspace and Existing Workspace. A chat started there runs on the desktop in a hidden folder of its own: the phone aims it at the home folder, and the desktop gives it a fresh folder when the home already holds a chat. On iPhone, touch and hold a chat under **Chats** to delete it, since those chats have no workspace page of their own (Android has no chat delete yet). Hidden folders never appear in a phone's workspace list or pickers; on iPhone, a scheduled task that already runs in one still shows it while you edit the task, as on the desktop. A desktop whose old default workspace already had a folder shows **No Workspace** on phones once its first No workspace chat is started on the desktop. A phone paired to an older desktop, or to the CLI (which has no No workspace chats), offers nothing new; an older phone keeps listing each hidden workspace by its name, **No workspace**.
