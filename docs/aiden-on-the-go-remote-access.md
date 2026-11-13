# Aiden On The Go remote access

Aiden Agent can expose a small authenticated API to Aiden On The Go on phones and tablets. Phone access is off by default. Aiden must remain running on the desktop (Mac or Linux), although its window may be closed.

## Local Network setup

1. Open **Settings → Connections → Control this device** in Aiden Agent.
2. Choose **On the same Wi-Fi**, then **Connect a device**.
3. Review what Aiden will enable and choose **Enable and show code**.
4. Scan the code in Aiden On The Go. If the camera is unavailable, use the setup code instead.

After choosing the method, setup takes two desktop actions. Scanning and any phone permissions are additional steps. Existing ready connections can add a device directly. Under **Workspace access**, approve any additional folders the phone may browse; existing workspace access is unchanged. Approving the whole home folder requires a separate confirmation.

The Mac advertises `_aiden-agent._tcp` with Bonjour only while Local Network access is running. LAN traffic uses a per-install P-256 HTTPS identity. The QR contains the private CA trust anchor and the server public-key pin so the mobile client can validate the hostname, certificate chain, and pinned key. On a Mac, the LAN endpoint uses the Bonjour name (`scutil --get LocalHostName` plus `.local`, the name shown in System Settings → General → Sharing → Local hostname), not the Unix host name, which can be a bare `Mac` or a router-assigned `.lan` name that does not resolve. The certificate covers that name and the Unix host name; when the computer is renamed, the certificate is reissued on the next start for the new name. A certificate renewal or reissue keeps the server key; an identity-key change requires pairing again. The iPhone app compares host names without regard to case: Nearby discovery reports the Bonjour name with its capitals, while TLS challenges and the setup-code payload carry it in lowercase.

## Tailscale setup

Tailscale supplies reachability and network encryption, but Aiden still requires its own device credential on every request.

1. Install Tailscale on the Mac and phone, sign in to the intended network, and make sure HTTPS is authorized for the Mac’s Tailscale name.
2. Open **Settings → Connections → Control this device** and choose **Away from home**.
3. Choose **Connect a device → Enable and show code**. Aiden turns on access, sets up its private connection, checks it, and shows the one-time code.
4. Scan the code on your phone.

Aiden checks installation, sign-in, HTTPS availability, and route ownership before setup. Missing prerequisites remain user actions. Conflicts and uncertain changes direct you to the advanced **Connection** controls; setup never silently replaces another route. If setup fails, Aiden removes only access introduced by that attempt where the outcome is known. An uncertain external change remains available for explicit verification.

**This Mac settings** contains the Mac name and enable switch; **Connection** contains the saved mode and technical controls. Closing the code window stops pairing; phone access remains enabled until switched off. Removing a device’s access is separate from turning off all phone access.

Aiden owns only `/api/aiden/v1`, proxies it to the loopback-only HTTP listener's matching `/api/aiden/v1` base, and verifies the resulting route. The matching target base is required because Tailscale strips the public `--set-path` prefix before proxying. On macOS, Aiden invokes Tailscale's shared app executable in its documented explicit CLI mode, so Finder and Dock launches do not depend on terminal environment variables. First-time connection works from an empty Serve configuration only after the node's exact Tailscale certificate domain proves HTTPS was already authorized. Aiden never enables Tailscale Funnel, never runs `tailscale serve reset`, never completes Tailscale authorization for you, and never changes unrelated Serve handlers. **Disconnect** removes only the exact route and target recorded by Aiden. A conflict is reported instead of being overwritten.

## Devices, credentials, and revocation

Each phone or tablet receives a separate random credential. Aiden persists only a fast lookup digest, a salted scrypt digest, and redacted device metadata—not the credential or pairing secret. Pairing QR codes expire after five minutes and work once.

Use **Remove access** beside a paired device to invalidate it immediately. Revocation does not rotate model-provider credentials or affect other paired devices. Pair the device again to restore access.

## Offline behavior

Closing the Aiden window does not stop Remote Access. Quitting Aiden does. The mobile app may retain its bounded offline read cache, but it cannot start new work or mutate the Mac while Aiden is stopped or unreachable. Temporary connection loss does not grant broader access and does not make an invalid or revoked credential valid.

## Control another computer

Any computer running Aiden Agent can use the chats, workspaces and Bots of another computer running Aiden, and be used by it in turn. Work stays on the computer that owns it: its chats, models, tools and files run there, and this Mac sends your actions to it.

### Pair a computer

1. On the computer you want to control, open **Settings → Connections → Control this device** enable **Accept connection requests** (off on new installations), and open **Add device**. Requests are accepted only while that host window is open. Existing paired devices continue to work.
2. On this Mac, open **Settings → Connections → Control other devices** and choose **Add device**. While the sheet is open, Aiden looks for computers on the same network and on your Tailscale tailnet. It never searches in the background.
3. Choose **Connect** beside the computer. Both screens show the same six-digit match code.
4. On the other computer, check the code and choose **Allow**. A request that is denied, cancelled or left for two minutes pairs nothing. Cancelling an approved request withdraws its device access and closes its open streams.

When nobody is at the other computer, choose **Enter setup code** instead and type the code it showed for **Connect a device**. **Paste pairing link** is an advanced fallback.

Pairing a computer gives it full control of this computer's chats: it can read them, send messages, stop runs and answer approvals, including runs started on this computer's own screen, its phone, Bots or schedules. Pair only computers you own. To end that access, remove the computer under **Control this device**.

### Use a paired computer

- **Sidebar.** The paired computer's workspaces and chats appear in the sidebar with a globe marker. The **Organize sidebar** menu chooses the view (Workspaces, Recent or Inbox (Beta)), the sort orders, a machine filter and whether workspaces from the same repository on different machines are grouped together (**Group across machines**). A remote chat row's ••• menu (or right-click) offers **Open**, **Mark read** on an unread chat when the other computer supports read state, and **Rename** when the pairing grants chat control. Mark read and Rename are unavailable while that computer is offline; Delete stays in the open chat.
- **Phone Inbox actions.** On iPhone and Android, swipe an eligible row for Mark read, Done or Snooze; VoiceOver and TalkBack offer the same actions. Search finds Done and snoozed chats too, with **Mark not done** and **Unsnooze** available after the short Undo expires. These writes go to the computer that owns the chat.
- **Dock badge.** With Inbox (Beta) as the sidebar view, the app icon's badge (the Dock on a Mac, the launcher count on Linux) counts what sits in **Needs you**: this computer's chats and Bots plus those of every paired computer that is connected and synced. An offline, reconnecting or blocked computer's rows leave the count, and a chat reached through two paths counts once. The count is made from the feeds this computer already holds, so it adds no traffic to the other computer. Turn it off with **Show Needs you count on the Dock icon** (**on the app icon** on Linux) in Settings → Appearance → Sidebar.
- **Chats.** Open a remote chat to read it, load older messages, send, stop, approve or deny tools, answer questions and steer. The transcript and composer use the same layout, width and text sizes as a local chat. A chip beside the title, where a local chat shows its workspace, names the computer the chat runs on, and adds **Offline** or **Needs re-pairing** in a warning or red fill when that computer is unreachable. Runs started anywhere on the other computer appear live.
  - **History.** Reopening a chat can show its cached messages while the newest page loads. During a long run, updated computers and phones can restore the reply so far, its reasoning and tool activity together, then follow new work. This requires revision 58 on the computer running the chat. If live text exceeds the replay limit, the completed reply is available in the saved chat.
  - **Model and effort.** The composer's model picker lists the other computer's models and shows the chat's own. Picking one runs the next message on it, and that computer saves it as the chat's model, as a phone's pick does. Models with effort levels show the same effort control as a local chat, starting at that computer's default; a level you pick here goes with each message from this Mac and is remembered while Aiden is open.
  - **Context.** The composer's context meter shows how full the next request would be on the other computer, as that computer projects it for the chosen model. It refreshes when the chat opens, when a reply finishes and when you pick another model. It needs Aiden on that computer to support contract revision 41; an older one shows no meter. Unsent draft text is not counted.
  - **Queue.** Messages queued while a reply is running wait on this Mac in the same editable list as a local chat's, then go to the other computer one at a time as new messages once its run ends. **Steer** joins the running reply there directly. Stop pauses the queue.
  - **Failed replies.** A reply that failed offers **Try again** or **Continue**, and **Switch model**. Compacting a full context and fixing a provider sign-in happen on the other computer.
  - **Pictures.** PNG and JPEG images in the chat (up to 8 MB), the ones you sent and the ones a reply drew or showed, appear as pictures. Each shows as a named file until its bytes arrive from the other computer, which hands over a few at a time so sends and approvals are never held up. **Expand** opens one full size. **Save** and **Copy** are not offered here; use them on the computer the chat runs on. An image that computer can no longer hand over stays a named file.
  - **Not here.** Read-aloud is not offered for a remote chat.
- **New chats.** On a new chat, choose the computer in the composer's machine picker, then one of its workspaces and models. Attachments upload to that computer. Pictures in a format the other computer does not take (WebP, GIF, BMP) are converted first, to PNG (or JPEG when that is what fits), and shrunk step by step until each is within 8 MB and the message's attachments together are within 16 MB. An animated GIF sends its first frame. HEIC photos can't be sent to another computer yet: the composer asks you to export one as a JPEG first. A picture this Mac cannot open is not sent either, and the composer says to save it as a PNG or JPEG. When the other computer runs contract revision 50 or newer, pictures go as their own bytes instead of base64 text, about a quarter less to send.
- **Bots.** Paired computers' Bots appear in the Bots area below this Mac's own, with **Working…** while one is running there. Opening one shows the same single conversation its own computer, phones and Telegram show: the Bot runs there, and this Mac sends messages, Stop, Resume, Dismiss, question answers and tool approvals to it. A tool that only its own computer may allow (Computer Use) can only be denied from here. Connect cards ask the Bot's computer to finish the connection there. When the app is already connected on that computer but the Bot's Custom access leaves it out, the card still reads **Finish on <computer>**, and that opens the Bot's chat there, where its card's **Connect** adds the app to that Bot. Phones work the same way with **Finish on your Mac**. If that computer runs an older Aiden, update it; an older Mac sending to a newer computer's Bot is told to update. When the Bot's computer offers hand-offs (contract revision 37), a step the Bot hands back ("Your turn: …") can be answered from here too, in two steps: **Take control** first (it opens the page the step names, if any), then **I'm done** (with a note typed in the composer if you like), **Skip**, or **Open again** for that page. A step on the Bot's own screen over there puts **Finish on <computer>** first, which brings it forward on that computer, then offers **Skip** and **I'm done**. A sign-in in the Bot's own browser there also starts with **Finish on <computer>**; it is answered on that computer, so here it then offers **Skip** alone. Images the Bot shares appear in its chat as pictures, read from the Bot's computer while its chat is connected (contract revision 45). The chat's **···** menu offers **Pause Bot** and **Resume Bot**, and a paused Bot shows a Resume card and holds the composer until it is resumed. Custom Bots can also ask for a folder or temporary whole-Mac file access. Current iOS and Android clients can answer those cards. A Mac viewing a paired computer’s Bot sees a notice to answer on that computer; it does not grant access itself. See [Bot access requests](bot-access-requests.md). The Assistant stays on its own computer.
- **Not available remotely.** Terminal, the Environment browser, computer use and open-in-editor work only on the computer you are sitting at.

### Offline and identity changes

On macOS, Aiden asks for Local Network access the first time it looks for other computers. Allow it, or finding computers on the same network fails (typed addresses and Tailscale still work); you can change it later in System Settings → Privacy & Security → Local Network.

When a paired computer is asleep or unreachable, its rows stay in the sidebar marked stale and read-only, and actions are disabled until it returns. Aiden reconnects on its own after sleep, unlock or a network change; choose **Reconnect** to try at once. Nothing is queued while a computer is offline.

If a computer reached over the local network presents a different identity, Aiden blocks it and asks you to pair again rather than trust the new key. Use **Re-pair** from its **···** menu in **Control other devices**. Under the same menu, **Rename locally** changes the name only on this Mac, and **Forget** removes it from this Mac.

## Chat models

A chat with messages keeps its own model on iPhone and Android. Reopening or refreshing it adopts a model changed on the desktop unless you have an unsent model choice in that chat. An empty remembered-default store or an unavailable optional model catalog does not turn the cached model into a new choice. Picking a model in an existing chat leaves other chats and the new-chat default alone.

## Mobile usage summary

The **Usage** row on the Aiden On The Go home screen reads aggregate usage from the paired Mac. It reflects Aiden Agent's device-local usage store and sends only aggregate request, token, activity, and estimated-cost totals to the phone. Chat content, workspace paths, and provider credentials are not included.

## Add a local project to a paired computer

In a new chat with a repository-root project selected, open the machine menu and
choose **Add this project to another machine…**. Pick a connected desktop that
supports project cloning (contract revision 48), then browse its approved folders and choose the parent
folder for the new repository. The target uses its own Git authentication.
The item is not offered in a No workspace chat, a scratch folder, or any folder
outside a Git repository.

Environment files may contain secrets. All choices start unchecked. Select only
files you want on that computer. Aiden offers ignored root-level `.env*` and
`.dev.vars*` text files, skips symlinks, hard links and files over 128 KiB, and caps
the transfer at 16 files and 512 KiB. Each selected file must also be ignored by the cloned repository with both case-sensitive and case-insensitive Git matching or the clone is discarded. User-level Git excludes do not satisfy this check. Nothing existing is overwritten. The cloned
project becomes available after the selected files arrive. The new chat opens on
the destination; a typed prompt and attachments carry over when that computer has
no saved draft. An existing remote draft is retained, with the local prompt still
saved here.

The flow clones committed history from the remote. Local edits and unpushed commits
stay here. Nested project folders must first be opened as repository-root projects.
A clone can run for up to 90 seconds. **Stop** requests cancellation; if the
connection is interrupted, check the destination project list before trying again.
Phones and CLI daemons do not offer this desktop setup action.

## Bot hand-offs and pause on the phone

When the paired Mac offers it (contract revision 37), Aiden On The Go for iPhone and Android shows a step a Bot hands back to you ("Your turn: Enter the code your bank sent you") as a card in the Bot's chat. **Done** marks it done: to add a note, type it in the composer and send it. A step your password-or-code rule hands back takes no note, so the composer waits and says "Enter it yourself, then tap Done": a code typed there would reach the Bot. **Skip** skips the step, and **Open** opens the page it names in the phone's browser. A sign-in step is finished in the Bot's own browser on the Mac: **Finish on your Mac** brings it forward there, or you can **Skip** it. A step in the Bot's own browser or on its own computer (a newer Mac) reads "This step is on the Bot’s own screen on your Mac": **Finish on your Mac** opens the Bot's screen there, and **Done** or **Skip** answers it from the phone. If the Bot's chat is open while the app is in the background, a notification says the Bot needs you. The Bot's profile menu offers **Pause Bot** and **Resume Bot**. A paused Bot reads "Paused" in the Bots list, and its chat shows a Resume card and takes no messages until you resume it. An interrupted Bot reads "Interrupted — tap to resume". With an older Mac, the step appears as a "needs you on your Mac" message, and you answer it on the Mac.

## Repeated Bot approvals on the phone

When a desktop host grants `bot:allowed` (contract revision 57), iPhone and Android approval cards can offer **Always allow for <Bot>** after repeated eligible approvals. The count and scope come from the host; a sent choice does not promise the allowance was saved. **Allowed without asking** on the Bot’s profile shows its saved app actions, website actions and selected Custom folders. The list loads every page, including folders beyond 50 remembered rules. Remove needs no confirmation, keeps the row pending until the host answers, and retains it with an error if removal fails. Removing a folder affects only that Bot, not other Bots or the phone’s file browser. Rules, passwords, payments and Computer Use keep their existing checks. Older hosts and CLI hosts do not offer this list. See [Bot rules](bot-rules.md#allowed-without-asking-from-cards).

## Needs you: Bot issues on the phone

When the paired Mac offers it (contract revision 42, `bot:issues`), a Bot's **Needs you** cards appear in its chat on Aiden On The Go for iPhone and Android. A card says what happened in plain words ("Paused “Morning brief” after 3 failed tries", "Gmail needs reconnecting", "A reply has been quiet for 10 minutes") and offers up to two actions: **Resume routine**, **Stop**, **Keep waiting**, or **Open chat**. A card whose only action opens the Mac's own settings shows "Open on your Mac" instead of a button. The Bots list shows how many open cards a Bot has, and a phone notification says the Bot needs you when the app is not in the foreground. With an older Mac the cards stay on the Mac, and the phone shows nothing for them.

## Bot messaging on the phone

With a host offering revision 59 and `bot:peers`, iPhone and Android can manage a Bot’s routing description and named pair approvals from **Profile → Bot peers**. Pair metadata needs Bot read access; exchange content and source/result evidence also need chat read access. Changes and Stop need Bot write access. Each recipient keeps its own rules and access. The phone retains the exact request after a lost reply; a pending Stop offers acknowledgement status rather than claiming cancellation. Intermediate exchange rows stay quiet, and the initiating Bot’s final update uses the existing notification feed. See [Bot peers](bot-peers.md).

## Messages Aiden Live sent

When Aiden Live on the Mac sends to a chat, that message shows a small "By voice" label on iPhone and Android too (contract revision 60, `inputSource: "voice"`). It is a display label only; phones never send it.

## Approval cards, approval settings and Bot templates (revision 61, in progress)

A desktop host offering provisional contract revision 61 can send a phone the same approval card the Mac shows (`approval:cards`): its title, arguments, the command or change in full, and only the buttons that card offers. A card that does not fit on a phone, or one only the Mac may allow, offers Deny and says to allow it on the Mac. The same host can let a paired phone read and set the Mac's approval mode and its rules page (`approvals:settings`), show a Bot's held settings changes and suggestions as Needs-you items, and offer versioned Templates and one-field New bot. `aiden serve` offers the approval card only. The iPhone and Android each ask for each capability in its own call and uses what it holds: the Mac's card with only its buttons (the answered line shows at once and the card returns if the Mac refuses), held settings changes with Apply / Dismiss and receipts with Undo, skill, lesson and tidy-up cards, Templates with versions and Open, the one-field **Name your Bot**, and **Settings → Approvals** with the mode and rules. On the same Mac it also shows two-step Take Control, one **Can message other Bots** switch, **Disable a Tool**, and a per-device **Show tool activity** switch. Disable a tool never turns on web search that Full access had off; the Mac enforces this too. See [the API reference](aiden-remote-api-v1.md#bot-ux-on-phones-revision-61-provisional).

## Images a Bot shares

When a Bot shares an image (a chart it drew, a screenshot it took), the paired Mac (contract revision 45) sends it to Aiden On The Go for iPhone and Android, which shows it in the Bot's chat like a photo in any other chat: tap it to see it full screen and save it. The phone reads the picture from the Mac when it is shown and keeps a limited number of pictures only while the chat is open; one it let go is read again when you scroll back to it. Another Mac viewing the Bot shows the picture too (see [Use a paired computer](#use-a-paired-computer)). With an older phone or Mac, the chat says "I shared an image: NAME. Open this chat on your Mac to see it."

## Browser recordings

When the agent records a browser tab, the paired Mac (contract revision 46) lets Aiden On The Go for iPhone and Android show the recording under the "Stopped browser recording" line, with its length and size. Tap **Play** to download it from the Mac and watch it full screen. The phone reads the video only when you tap Play. Each Play owns a separate temporary file: another download, a cancellation or a missing recording does not delete an active download or player. Closing the player, replacing its recording card or leaving the chat removes that Play's file, including when the download finishes before the player appears or after the card has gone. Android startup also clears playback files abandoned by the previous process. A recording deleted from the Mac says "This recording is no longer on the Mac." On iPhone, a recording the Mac saved as WebM (only when its H.264 encoder is unavailable) says to watch it on the Mac. Older phones and Macs show the activity line without the card.

## Values read from a web page

When the agent reads a page in extract mode, the Mac (contract revision 38) sends the values it read with the chat's activity. Aiden On The Go for iPhone and Android shows them as a card under the "Fetched web page" line: each value with supporting page text, a **Guess** label on values the agent isn't sure of, and "Not on the page" for values the page doesn't have. Only the field names, a short form of each value and its page line reach the phone, never the page. Older phones and Macs show the activity line without the card. See [web-fetch-extract.md](web-fetch-extract.md).

When the paired Mac has spending limits on (contract revision 47), Aiden On The Go for iPhone and Android shows a quiet line in a workspace chat or Bot chat once it has used 80% of its limit, and a card with **Allow $X more** once it reaches it. Allowing more from the phone and the Mac at the same moment adds the amount once. The limits themselves are set on the Mac in Settings → Context & Limits; see [usage limits and spending limits](usage-limits-and-spending.md). With an older phone, or from another paired Mac, a send over the limit is refused with the Mac's message, and you allow more on the Mac.

## Background jobs

When the agent leaves something running for a workspace chat on the Mac (a dev server, a watcher, a long test run, or a server a command started), Aiden On The Go for iPhone and Android shows **N in background** beside the composer (contract revision 49, `chat:jobs`, asked for in a call of its own). Its list says how long each job has run or how it ended and which addresses a server listens on ("localhost:5173 on your Mac"; open them in a browser on the Mac), and **Stop** ends a job and everything it started. The list refreshes after each reply and every few seconds while something runs. Linux desktops serve it too; the CLI does not run background jobs. Older phones and Macs show nothing new. See [coding follow-through](coding-follow-through.md).

## Chats without a workspace

When the paired desktop has No workspace chats (contract revision 51), Aiden On The Go for iPhone and Android lists them in one **Chats** group, as the desktop does, and **New Chat** offers **No Workspace** first. That chat runs on the desktop with its global settings in a private folder of its own; the private folders never show up in the phone's workspace list or pickers (an iPhone scheduled task that already runs in one keeps showing it while you edit the task). The CLI has no No workspace chats, so a phone paired to it offers nothing new. See [chats without a workspace](no-workspace-chats.md).

## New worktree

A new Workspace chat in a Git repository shows a **New worktree** chip beside the composer on Aiden On The Go for iPhone and Android (contract revision 53, `chat:new-worktree`, asked for in a call of its own; the phone also needs Git write access). Turned on, your first message shows at once with a **Setting up worktree…** row and **Cancel** while the Mac makes a worktree from the repository's default branch (or the branch it's on, without a remote), names its branch from the message (`aiden/new-chat` for a message of attachments only), and moves the chat into it; then the message sends there. Cancel puts the message back in the composer; if the Mac finishes the worktree anyway, sending again uses it. If the Mac can't make the worktree, it says why in plain words and the message comes back unsent, and sending again tries afresh. If New worktree stops being available for the chat while the chip is on, the phone turns the chip off and keeps your message rather than send it to the main folder. The chip doesn't show for a folder that isn't a repository or has no commits yet (when the phone may read Git), for a workspace that is already a worktree, or with an older Mac.

## Pictures in a reply

When the agent shows, shares or generates a picture, Aiden On The Go for iPhone and Android draws it right beneath the step that made it, in the order the reply happened (contract revision 44). Pictures still arrive when the reply is saved, not while it streams; a picture being generated shows its placeholder in that same spot. With an older Mac they stay at the end of the reply.

## Paired-Mac voice input

In the mobile app's speech settings, choose the paired Mac when you want Aiden Agent's local Parakeet model to transcribe composer dictation instead of the phone's native speech API. Recording begins only after an explicit dictation action in the app or the intentional iOS voice shortcut; externally opened URLs never start recording. The phone sends at most 60 seconds of mono PCM audio over the same authenticated, certificate-pinned Remote Access connection and receives one final transcript for the composer.

The Mac processes that recording locally. Aiden does not persist the recording or transcript, include either in Remote Access diagnostics, or send them to Aiden's model-provider integrations or an Aiden-operated service. Normal chat submission remains a separate user action.

If the selected local speech model is not installed, the mobile settings can ask the paired Mac to set it up. Aiden downloads only that model's fixed, hash-pinned file: a release archive from the k2-fsa GitHub release host, or, for Parakeet on Metal on an Apple silicon Mac, one GGUF file from a fixed Hugging Face revision. It caps the download at 800 MiB, verifies its exact size and SHA-256, unpacks or moves it into staging, validates the required model files, and stores it in Aiden Agent's device-local model directory. The phone cannot provide a model URL or Mac destination. Model setup requires Aiden Agent to remain running and online.

## Troubleshooting

- **Remote Access says Off:** enable it locally in Aiden Settings. No listener or Bonjour advertisement exists while it is off.
- **Local device cannot find Aiden:** confirm both devices are on the same network, Local Network mode is selected, and local-network permission is enabled for Aiden On The Go.
- **Certificate or pin changed:** do not bypass the warning. Verify the Mac, revoke the old device record, and pair again.
- **Tailscale not found or disconnected:** open Tailscale on the Mac and confirm it reports a stable MagicDNS name.
- **Local service ready, Tailscale unavailable:** the listener is running, but Aiden could not verify a safe Serve route. Retry after confirming Tailscale is signed in; Aiden will not mutate a route it cannot inspect.
- **Tailnet HTTPS unavailable:** complete Tailscale's HTTPS authorization flow, then retry Connect in Aiden. Aiden will not authorize it on your behalf.
- **Serve conflict:** inspect the route shown in the error. Remove or relocate the conflicting handler yourself; Aiden will not take it over.
- **A folder is missing:** add it from the Mac. The phone cannot submit an arbitrary path or approve a new browser root.
- **"This chat's workspace folder is missing" or "This chat's worktree folder is missing on your Mac":** the chat's workspace folder was moved, renamed or deleted on the Mac, or its drive isn't connected. Nothing was sent; your message stays in the box. Put the folder back, or for a worktree choose **Restore worktree** in that chat on the Mac, then send again. The phone never receives the folder's path.
- **Paired-Mac speech is unavailable:** confirm Aiden Agent is running, Remote Access is reachable, and the paired Mac remains selected in mobile speech settings.
- **Speech model needs setup:** open mobile speech settings and choose setup for the fixed local model, or complete the same setup in Aiden Agent on the Mac.
- **Speech setup failed:** keep Aiden Agent online, retry once, and verify the Mac has enough free local storage. Aiden will discard an incomplete staged model.
- **Speech service is busy:** wait for the active transcription to finish and retry. The Mac permits one active transcription and one waiting request.
- **Port already in use:** stop the other local service or repair the saved Remote Access configuration before enabling it again.

Remote Access diagnostics keep only closed route categories, outcome/status classes, bounded latency, stable Aiden-owned error codes, and categorical Tailscale inspection phase/reason/attempt counts. Successful production traffic is reduced to daily aggregate counts; durable records never contain Tailscale command output, request IDs, device or instance suffixes, bearer credentials, pairing secrets, provider keys, request/response bodies, URLs, or filesystem paths.

## Connection recovery

On iPhone and iPad, the disconnected recovery panel offers **Switch connection**
alongside **Retry connection**. It opens the Machines page, which shows each paired
machine's own state, where you can make another machine the default or choose
**Pair a machine** without reconnecting first. Switching remains available when a
secure-identity failure prevents retrying.

Settings → Connections separates computers that control this device from computers
this device controls. A paired computer shows its current route, route count, and last
successful chat synchronization. “Syncing chats” means the secure connection is open
but the chat feed is not ready. “Recently active” describes recent contact, not a live
connection guarantee.

When a paired desktop cannot connect, its row distinguishes address lookup, network
routing, a refused connection, a timeout, secure connection failure, and an unreadable
response when the transport can identify the cause. Recovery steps point to Tailscale
online status and access rules, or the local network, firewall, and Local Network
permission for the last known route. A refused connection asks you to open Aiden and
turn on Control this device on the other computer. The displayed route is the last
successful route; Aiden may also have tried its saved alternatives. These hints do
not probe Tailscale or change permissions. Identity changes still require re-pairing.

Paired desktop computers can learn local-network and Tailscale alternatives through
their verified connection. Aiden checks each route's certificate and paired identity
before using it, switches when a route fails, and checks for a preferred local route
while on a fallback. Removing a learned route suppresses it until **Restore learned
routes** is selected. The computer still needs to be awake with Aiden running.

A send whose response is lost remains a saved, unconfirmed request. Reopening the
conversation restores its notice. **Retry** uses that exact request and its original
key within the safe retry window; it never runs automatically. A send the host refuses
as busy (`429 rate_limited` with `retryable: true`) is different: nothing was added to
the chat, so Aiden On The Go for iPhone and Android saves the same request under a new
key and sends it again on its own after the delay the host asked for
(`details.retryAfterSeconds`, else the `Retry-After` header, held between 1 and 60
seconds). If three automatic resends are refused as busy too, the request stays saved
for **Retry** and the notice says Aiden Agent is still busy and the message wasn’t sent,
so retrying is safe. A
`429` the host marks `retryable: false` fails the send and returns the text to the
composer. When the window ends,
review the conversation on the host before dismissing the notice and making a new
attempt. New draft edits remain separate from the saved request. Desktop saved
requests are encrypted locally and bound to the original pairing; mobile records
stay in the app's private storage and are scoped to that pairing. Editable mobile
drafts and unconfirmed-send records are excluded from backups and do not move to
a replacement phone through backup restore. iOS marks existing draft storage during app startup even when no chat is opened
and retains its existing protected storage class; Android keeps its backup and device-transfer exclusions.

On Android, **Nearby** discovers desktops on the local network. New Android pairings
require a desktop supporting the Android device identity (contract revision 31); an
older desktop shows an update prompt. QR or manual-address pairing remains available
when nearby discovery is unavailable. Discovery only supplies an address hint;
setup-code verification and certificate validation still establish trust. Connection
errors distinguish network reachability, secure-identity verification, and app-version
problems. A secure-identity failure requires verification and pairing repair, rather
than a trust-bypass retry.

## External links and shortcuts

On iOS and Android, an external new-chat link waits for connection and workspace
readiness, then asks before creating a chat. Waiting grants no installation
switch, chat creation or recording authority; newer navigation supersedes the
waiting request. The
confirmation names its desktop installation and workspace before any installation
switch or host write. The legacy `aiden-otg://new-chat-voice` link opens this same
confirmation and cannot start the microphone, even when microphone permission is
already granted. Use the in-app microphone button to dictate. No recognized text
is sent automatically. Existing-chat notification and widget links still open
their paired conversation.

iOS App Intents deliver a short-lived, one-use action inside the foreground app
process. The intentional **New Chat with Voice** shortcut retains dictation using
the selected mode and ordinary OS permission checks. URL parameters and Android
Intent extras cannot claim internal-action authority. A cancelled, expired,
revoked or stale creation approval is discarded, and creation is never retried
automatically after an uncertain result.
