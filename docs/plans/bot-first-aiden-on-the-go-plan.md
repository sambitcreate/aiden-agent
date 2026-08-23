# Bot-First Aiden On The Go

- Status: Active; Phases 0–1 complete August 23, 2026; Phase 2 next
- Created: August 22, 2026
- Primary surface: Aiden On The Go for iPhone and iPad
- Authority: the paired Aiden Agent Mac remains the runtime and persistence owner

## Outcome

Aiden On The Go will have two clear product areas:

- **Workspaces** — project-oriented chats with folders, Files, review, and Git.
- **Bots** — reusable helpers presented like familiar message contacts and threads.

The Aiden logo at the top of the existing mobile home becomes the switcher. Tapping it opens exactly those two choices, marks the current choice, and returns the person to the last place they visited in each area. Bots becomes the default after a paired Mac supports and grants the new bot capability; Workspaces remains the safe fallback for older installations.

The Bots area will adapt the attached Messages references without copying Apple's product chrome. It will lead with large bot identities, favorites, recent conversations, search, and simple create/edit actions. It will continue to use Aiden's own appearance presets, semantic colors, chat renderer, streaming, attachments, approvals, and motion language.

A bot remains a thin, reusable identity over Aiden's existing Pi-backed chat runtime. The phone will not host a second agent engine. Bot definitions, conversations, access policies, generated avatars, provider selection, managed workspaces, and every tool decision remain authoritative on the paired Mac. Every bot gets a durable Aiden-managed home workspace for its chats and artifacts, but that implementation detail stays out of the ordinary UI unless the person asks about it.

## Owner decisions captured by this plan

These are settled product requirements for implementation:

1. The complete bot-first UX ships on **iPhone/iPad first**. Mac work in this release is limited to the runtime, policy enforcement, managed workspace, Remote API, canonical avatar storage, and displaying the avatar returned from iOS in existing surfaces. A Mac shell/inbox redesign comes later.
2. Every bot starts in **Full Access** after one clear, versioned notice. Full Access makes the ordinary capabilities currently enabled in Aiden available to that bot—including shell, Mac files, configured connections/MCPs, and skills—while preserving OS permissions, existing action approvals, and Aiden's global safety rules.
3. A person can switch a bot to **Custom Access** in Bot settings and selectively reduce Files, shell, Connections, Skills, and other exposed capability groups. A chat can further narrow its bot, but cannot exceed the bot's setting.
4. Every bot has one durable Aiden-managed home workspace. Aiden uses it as the working directory and normal save location for every chat with that bot, keeps the path out of routine UI, and reveals it only when the person asks. Full Access may inspect or operate elsewhere on the Mac when the task needs it.
5. Managed bot workspaces are **not Git repositories by default**. Shell is available in Full Access, and Git is not categorically prohibited: it becomes relevant only if the person asks, a task opens an existing repository, or a repository is explicitly initialized.
6. Provider credentials, MCP credentials, skill contents, internal paths, and configuration remain Mac-only. Mobile selects safe, already-configured entries; it never receives or edits their secrets.
7. Apple avatar creation uses the system **Image Playground** sheet, including Private Cloud Compute on supported OS/device combinations. Only the image the person accepts is uploaded to the paired Mac and saved as the bot's canonical photo.
8. Existing semantic Aiden avatars remain the universal fallback and rollback identity.

## Research and current-state audit

### What the references contribute

The five supplied references consistently put identity before thread history:

- large circular identities make helpers feel like recognizable contacts;
- favorites provide a small, stable set of common destinations;
- flat recent rows make the next action obvious without dashboard cards;
- Search, Edit, and Add stay visible but quiet;
- bot creation uses a guided sheet with friendly identity fields before advanced instructions;
- chat and bot management are separate actions.

Aiden should use that hierarchy, not clone iMessage. Bot avatars remain clearly synthetic, the app continues to say “Bots,” and Aiden's own palette, type, materials, focus behavior, and activity presentation remain visible.

The repository UI references reinforce the same approach: stable conversation layout, progressive disclosure, semantic tokens, 150–200 ms control feedback, 250–300 ms panel transitions, visible focus, reduced-motion alternatives, and no decorative motion that competes with the task.

### What already exists

- `renderer/shared/bots.ts` defines durable bot identity, description, instructions, semantic avatar, timestamps, and archive state.
- `main/services/bot-store-core.ts` persists up to 256 bots in main-owned storage, while a rollback-safe companion store preserves semantic avatar appearances.
- `main/services/bot-system-prompt.ts` and `main/services/llm-client.ts` re-read the persisted bot before each turn and compose its persona into the normal Aiden prompt without creating a second runtime.
- `Chat.botId` already binds a real Aiden conversation to a bot. Bot chats retain normal streaming, compaction, provider behavior, attachments, and history.
- Electron exposes bot CRUD only through `main/handlers/bots.ts`; Aiden Remote API has no bot routes.
- `ios/AidenOnTheGo/Features/Remote/AidenWorkspaceShellView.swift` already contains the requested large Aiden logo, but it is a noninteractive image. The same file has adaptive `NavigationStack`/`NavigationSplitView` navigation, search, recents, settings, and a floating “New Agent” action.
- On mobile, “New Agent” currently means “create a normal workspace chat.” That label must be retired so “New Bot,” “New Bot Chat,” and “New Workspace Chat” each have one meaning.
- `AidenChatDetailView` already provides the difficult conversation behavior: resumable SSE, stop, approvals, attachments, voice, Markdown, outcome reconciliation, Live Activity handoff, and offline history.

### Chat-classification correctness boundary

Before Phase 1, `AidenRemoteChatService.list()` called the all-chat application list, which included bot-tagged chats, while `projectAidenRemoteChat()` removed `botId`. Aiden On The Go could therefore receive a bot chat inside its Workspace/home list without knowing that it was a bot chat.

Phase 1 resolved this boundary: the wire `Chat` DTO carries an optional bounded `botId`, normal Workspace lists are explicitly regular-only, ordinary chat creation rejects a client-authored bot identity, and every Bot-classified chat/stream/attachment/approval route classifies from main-owned metadata before any payload read or effect. Shared TypeScript/Swift fixtures prove the classification and legacy clients remain on the regular-chat path.

### Current access must become explicit and controllable

Today a foreground bot chat inherits the normal ambient tool assembly:

- the combined coding tool set includes read, write, edit, and `run_command`;
- all enabled MCP servers may be added;
- all available skills and skill resources may be added;
- Exa, schedules, subagents, and Computer Use can enter through normal chat rules;
- Telegram bot turns use a different surface ceiling and currently do not match a per-bot policy.

That breadth now matches the chosen **Full Access** default, but it is implicit, has no one-time disclosure, has no bot-owned home workspace, and cannot be reduced reliably per bot or chat. The new access UI therefore depends on a main-owned mode and turn-admission resolver. **Full** deliberately follows Aiden's currently enabled capability inventory; **Custom** uses exact positive selections and fails closed on drift. Renderer and phone controls only request policy changes—the paired Mac remains the enforcement authority.

### Apple image-generation findings

- Apple's [Image Playground framework](https://developer.apple.com/documentation/imageplayground) is the image-creation API. Its SwiftUI system sheet returns a user-selected image URL.
- The [SwiftUI sheet](https://developer.apple.com/documentation/swiftui/view/imageplaygroundsheet%28ispresented%3Aconcepts%3Asourceimage%3Aoncompletion%3Aoncancellation%3A%29) is available from iOS 18.1, while this app still targets iOS 18.0, so the feature needs both an OS guard and the system [`supportsImagePlayground`](https://developer.apple.com/documentation/swiftui/environmentvalues/supportsimageplayground) availability check.
- Apple has deprecated the programmatic `ImageCreator` path for iOS 27 and directs apps to the system sheet instead. Aiden will not build on the discontinued API. See [Apple's deprecation notice](https://developer.apple.com/news/?id=dz9wvq0r).
- The [Foundation Models framework](https://developer.apple.com/documentation/foundationmodels/) is for language understanding, structured generation, and tool use; it is not Aiden's raster-avatar generator.
- Apple's current [Image Playground guidance](https://developer.apple.com/apple-intelligence/) says the newer image model runs on Private Cloud Compute. Copy must not promise universal local-only processing. Aiden receives only the image the person chooses; drafts and rejected candidates are not uploaded by Aiden.
- Apple's [Generative AI HIG](https://developer.apple.com/design/human-interface-guidelines/generative-ai) requires clear disclosure, user control, honest availability/failure states, privacy-aware model choices, and useful cancellation/retry behavior.
- The system sheet needs no new Aiden Photos permission, special setup flow, or Private Cloud Compute entitlement. Do not add one speculatively.

The existing `native/apple-foundation-models` executable remains a background, title-only helper. Its `LSBackgroundOnly` process is not widened to present UI. A future Mac Image Playground feature would need a separate foreground presentation boundary.

The currently used physical iPhone 13 Pro cannot exercise Apple Intelligence image generation. Release acceptance requires both that ineligible-device fallback and [supported Apple Intelligence hardware](https://www.apple.com/apple-intelligence/) for the actual system-sheet flow.

## Product experience

### 1. Aiden logo switcher

The current home logo becomes a native button/menu with exactly two rows:

| Choice | Plain-language description | Destination |
| --- | --- | --- |
| Bots | Reusable helpers and their conversations | Last Bot thread/profile, otherwise Bots home |
| Workspaces | Projects, folders, Files, review, and Git | Last Workspace/chat, otherwise Workspace home |

Behavior:

- remember the last selected area and independent navigation state per paired `instanceId`;
- keep both native area stacks mounted while switching so the existing chat view model retains stream state, selection, and scroll position; use one device-local `AidenChatDraftStore` keyed by `(instanceId, chatId)` for both Workspace and Bot chats so installation switches and ordinary view reconstruction preserve an unsent draft without inventing a Bot-specific chat model;
- default to Bots only when the authenticated device has `bot:read`;
- disable Bots with actionable “Update or approve access on your Mac” copy when the server or device grant is missing;
- do not switch until navigation succeeds;
- preserve drafts and respect any existing navigation/mutation blocker;
- close on Escape/click-away where applicable and restore focus to the logo;
- announce the current area in the logo's accessibility label.

Pairing remains outside this switcher. Scheduled Tasks, Usage, installation management, and appearance stay reachable from shared settings rather than becoming a third top-level area.

### 2. Bots home

The first screen is a calm inbox, not a configuration dashboard:

1. Header: **Edit**, the Aiden logo switcher with centered **Bots** title, and **+** for New Bot.
2. Favorites: horizontally scrolling circular bot avatars and visible names.
3. Recent conversations: flat rows with bot avatar, bot name, conversation title or bounded last-message preview, honest activity state, and relative time.
4. Bottom dock: an iMessage-inspired Search capsule and a separate circular New Conversation button remain anchored above the safe area. New Conversation chooses an existing bot and always creates a distinct chat. **+** always creates a new bot.

Rules:

- tapping a favorite opens its bot profile; it never silently sends or creates work;
- tapping a recent row opens that exact persisted chat;
- no fake unread badge is introduced. A ring/badge is shown only for real streaming, waiting-for-approval, failed, or locally known new activity;
- the bottom Search field covers bot name, purpose, conversation title, and the bounded previews actually returned by the Mac;
- Edit supports favorite ordering, bot archive entry points, and confirmed multi-chat deletion without permanent red-minus decorations over every avatar;
- empty, loading, retryable error, no-result, offline-cache, archived, and capability-degraded states each have distinct copy and actions.

### 3. Bot profile

A bot profile behaves like a contact card:

- large avatar, name, purpose, and capability summary;
- **New conversation** as the primary action;
- **Edit bot** and **Access** as direct actions;
- recent conversations below;
- Telegram status when a binding exists;
- archive/restore in the overflow menu with clear consequences.

Archived bots remain readable but cannot start a new turn until restored. Missing or corrupted policy/workspace state shows **Repair access** and blocks new turns until the Mac reconciles it; Full Access is never guessed from damage.

### 4. Create and edit bot

Use one guided native sheet/Form with progressive sections and a stable Save action:

1. **Identity** — name, “What is this bot for?”, and optional opening greeting.
2. **How it helps** — friendly behavior guidance; raw “Advanced instructions” stays behind disclosure instead of leading with “System prompt” or Pi language.
3. **Access** — **Full Access** by default, or **Custom** with plain-language Files, shell, Connections, Skills, and other capability groups. This is prominent, not hidden under Advanced.
4. **Look** — live circular preview, Aiden style editor/shuffle, and Create with Apple Intelligence when supported.
5. **Review** — concise summary of what the bot can access before Save.

The first time a person enters Bots on a given paired installation and policy version, show one blocking notice before any bot can act: Bots start with Full Access to the Mac capabilities already enabled in Aiden; work normally begins in a private Aiden-managed folder; and access can be reduced at any time in Bot settings. Offer **Continue with Full Access** and **Customize first**. Remember acceptance on the Mac, version the notice, and show it again only when the meaning of Full Access materially expands.

Freeze the first notice as policy identifier `bot-full-access-v1` with this copy:

> **Bots can use your Mac**
>
> By default, bots can use files your Mac lets Aiden access, run commands, and use connections and skills enabled in Aiden. Each bot starts in a private Aiden folder, but Full Access can work elsewhere when your request needs it. Capabilities you enable later in Aiden are also available to Full Access bots. You can choose Custom Access now or change access in Bot Settings anytime.

The actions are **Continue with Full Access** and **Customize first**. Existing-bot migration adds: **Your existing bots will keep the capabilities they already use. Aiden prepared a private working folder for each.** The Mac stores the accepted policy identifier and timestamp for the paired installation; local dismissal never counts as acceptance.

Other first-release state copy is also fixed so degraded security state does not become a vague spinner:

| State | Copy |
| --- | --- |
| Full summary | **Can use your Mac, shell, enabled connections, and skills.** |
| Custom summary | **Uses only the access you select. This chat can reduce it further.** |
| Offline | **Offline — showing saved bots. Reconnect to create, edit, or send.** |
| Unsupported Mac | **Bots need a newer version of Aiden Agent on your Mac.** |
| Device not granted | **Approve Bot access on your Mac, or pair this phone again.** |
| Policy/home repair | **This bot's access needs repair on your Mac before it can work.** |
| Selection drift | **Some selected access is unavailable. Review it on your Mac.** |
| Archived | **Archived bots are read-only until restored.** |
| No search result | **No bots or conversations match your search.** |
| Empty | **Create your first bot to give a familiar helper its own conversations and tools.** |

Drafts stay local until Save. Cancel on a dirty draft asks before discarding. Saving is one main-owned mutation with optimistic revision checking; a network ambiguity reconciles from the Mac instead of repeating creation.

An optional opening greeting is copied once into each newly created chat. Editing the bot later does not rewrite old conversations.

### 5. Bot conversation

Reuse `AidenChatDetailView` and its view model rather than fork the transcript/runtime. Add only a bot presentation layer:

- avatar and bot name in the conversation title/contact affordance;
- compact access summary such as **Full Access** or **Custom · Shell off · 3 connections**;
- a toolbar sheet for **Bot defaults** versus **This chat**;
- Files entry only when that chat has Files access;
- keep the conversation visually message-first: do not add workspace pickers, branch/worktree chrome, Review tabs, or a persistent terminal; capability availability and per-chat reductions live in the Access sheet, while actual tool activity and approvals use the existing shared chat presentation;
- existing provider/model, attachment, dictation, send/stop, approval, streaming, and reconciliation behavior stays shared.

Changing access while a turn is active invalidates its authority lease. Removed access blocks the next effect immediately; newly added access is unavailable until the next turn. The UI explains that access changed rather than presenting a generic provider failure.

### 6. Managed workspace and bot system instructions

Each bot owns one durable Aiden-managed home workspace. Every new chat for that bot binds to the same home so files and context remain useful across conversations. Aiden does not present folder setup, Git initialization, or a workspace chooser during ordinary bot creation. The path is omitted from normal mobile DTOs and UI; if the person asks where files are stored, the bot may state the resolved path and the app may offer the existing Files entry point.

The main process—not iOS, the renderer, or editable bot instructions—injects an authoritative workspace section into every bot turn after the editable persona. Its required meaning is:

> This bot's home workspace is `[managed path]`. Start shell and tool work there. Create and save ordinary artifacts there unless the person names another destination. You may inspect or work in other OS-accessible Mac locations when the request needs it. Treat files outside the home workspace as user-owned, minimize the scope of changes, and follow Aiden's existing approval and destructive-action rules. Do not initialize a Git repository, create branches, or make commits merely because the workspace exists; use Git only when the person's task makes it relevant. Do not expose private paths, credentials, or unrelated content unnecessarily.

The final implementation should express this in Aiden's established system-prompt structure rather than as user-editable prose. Tests must prove that later bot instructions cannot replace the managed path or weaken these operating rules.

### 7. iPad and constrained windows

- iPhone keeps native push navigation.
- iPad and wide Stage Manager windows use a Bot `NavigationSplitView`: inbox on the leading side, selected profile/chat in detail.
- compact/regular transitions preserve the selected bot/chat just as the current Workspace shell preserves workspace selection.
- favorite identities reflow or scroll; they never become a fixed four-column phone grid.
- keyboard, pointer, VoiceOver, Dynamic Type, Reduce Motion, Reduce Transparency, rotation, and split-window widths are acceptance requirements, not polish deferrals.

## Access model

### What people see

| Area | Choices | Meaning |
| --- | --- | --- |
| Access mode | Full Access / Custom | Full uses everything currently enabled for ordinary Aiden work; Custom lets the person reduce it |
| AI connection | one configured provider/model | Where replies are generated; account secrets stay on the Mac |
| Mac files | Full Mac / Bot folder only / Chosen locations / Off | Work still starts and normally saves in the bot's managed folder |
| Shell | On / Off | When on, commands start in the bot's managed folder; no repository is created automatically |
| Connections | All enabled / selected / off | External apps and services this bot may use; “MCP” appears only as explanatory detail |
| Skills | All available / selected / off | Instructions and workflows available to this bot |
| Other abilities | enabled Aiden capabilities, individually selectable | Web, browser/Computer Use, schedules, subagents, and future groups stay understandable and controllable without exposing internal tool names |
| This chat | inherit bot / customize | A conversation may turn capabilities off or back on up to the bot's limit; it cannot exceed the bot |

Full Access is selected for every valid new or migrated bot. The access screen leads with one sentence—**Can use your Mac, shell, enabled connections, and skills**—then offers **Customize**. The one-time notice described above appears before first use, not on every chat. A persistent, quiet **Full Access** label makes the state inspectable without turning the inbox into a security dashboard.

“Connect a new account” stays a Mac Settings task in the first release. Mobile shows unavailable, disabled, changed, or expired entries and tells the person what to fix on the Mac. Credentials never cross the Remote API.

### Rules enforced by the Mac

The effective authority for a tool call is the intersection of:

1. current OS permission and app/global availability;
2. the bot's explicit **Full** or **Custom** policy;
3. exact selected resources when the bot is Custom;
4. that chat's inherited policy plus any explicit reductions;
5. the current surface's supported approval and safety behavior (Electron, mobile, or Telegram);
6. the fresh turn/tool-effect lease.

Regular chats continue to use their saved Workspace permission. Bot chats do not expose or compose a second Workspace permission setting: their managed workspace carries a main-owned internal runtime baseline solely so existing tools can operate, and that baseline can never widen the Bot resolver's result. This keeps the visible Full/Custom summary identical to the effective authority instead of allowing a hidden Workspace setting to contradict it.

The least powerful result always wins. A valid `full` record deliberately follows the current ordinary Aiden inventory. Full Access is never inferred from corrupt or future-version data: creation and migration write it explicitly and atomically; missing/corrupt/future records block bot actions and show **Repair access** rather than guessing.

Specific enforcement:

- provision the bot's managed workspace with normal workspace write permission and make it the shell/tool working directory, but do not create `.git`, a branch, or a commit;
- in Full mode, assemble the same currently enabled file, shell, web, connection/MCP, skill, schedule, subagent, and other ordinary Aiden capabilities that the normal runtime would offer; existing OS grants, approval prompts, destructive-action checks, and Computer Use safety remain authoritative;
- in Custom mode, split Files from shell, enforce **Bot folder only**, chosen-location, or Off scopes, and register only the selected capability groups;
- allow Full mode to inspect OS-accessible locations outside the managed workspace when the task needs it while keeping the home workspace as `cwd` and the default artifact destination;
- do not categorically block Git or shell-like MCP tools; Git works only when a task enters an existing repository or the person explicitly asks to initialize/use it, under Aiden's existing safeguards;
- for Custom connections, bind each selection to the exact connection plus current tool names, input/output schemas, and conservative read/mutation effects;
- treat unknown MCP effects as mutating and require the existing approval behavior; connection/schema drift disables a Custom binding until reviewed;
- convert a Custom skill selection into a main-only stable binding plus content fingerprint; content/source/workspace drift disables it until reviewed;
- filter automatic skill tools, prompt inventory, Pi resources, and explicit skill invocation together so no alternate invocation bypasses a Custom toggle;
- bind provider/model selection to an available configured connection and never fall back to a different provider silently;
- invalidate active capability leases after narrowing, archive, global disable, connection change, credential change, or skill change.

Full mode is intentionally dynamic: a connection, skill, or ordinary capability enabled later in Aiden becomes available to Full bots and chats that still inherit Full. The notice must say this plainly. If a future release adds a materially broader capability class, bump the notice version and require acknowledgement again. Custom mode never grows silently.

### Change behavior

- Full bots and inheriting chats follow Aiden's current enabled inventory on the next turn.
- Switching a bot from Full to Custom, or removing a Custom selection, immediately narrows every affected chat and invalidates active leases.
- Switching a bot from Custom to Full requires an explicit confirmation and takes effect on the next turn; it never retries a running tool automatically.
- A re-added connection/skill receives a new internal grant identity, so old chats cannot regain it accidentally.
- Chat customization is revision-checked: an inheriting Full chat stores explicit reductions; a Custom chat stores a subset of its bot's bound grants.
- New bot chats bind to the bot's managed home. Existing chats retain their authoritative workspace/history during migration, while the bot home becomes the normal destination for all new chats.
- Copying a chat preserves its inheritance/reductions; it does not mint access or create a second bot home.
- Telegram-bound bot chats use the same Full/Custom resolver plus Telegram's existing supported approval and safety ceiling. Unsupported actions remain unavailable rather than bypassing the policy.

## Main-owned storage and wire contract

### Persistence

Keep identity, authority, and raster assets separate so stale UI edits and rollback cannot overwrite one another:

- `bots.json`: existing identity/instructions/semantic fallback, extended with bounded purpose/greeting fields through its normal versioned parser;
- `bot-capabilities.json`: mode-0600 versioned bot records with `accessMode: "full" | "custom"`, revisions, Custom opaque grants/fingerprints, and safe repair state;
- a main-owned bot-workspace binding: one opaque workspace ID and owned home directory per bot, created without Git metadata and never writable through a remote DTO;
- `bot-avatar-assets.json` plus an owned asset directory: bot ID, asset revision, dimensions, byte size, and atomic filename; never an arbitrary client path;
- each bot chat: existing `botId`, authoritative workspace binding, and a versioned inherited-policy reduction or Custom subset;
- paired-device state: the accepted Full Access notice version, so materially changed access meaning can require a fresh acknowledgement.

The public Bot access view returns labels, counts, state, and opaque selection IDs only. It never returns provider/MCP credentials, endpoint headers, environment variables, raw MCP binding fingerprints, skill paths/content, workspace paths, or internal asset filenames.

### Remote capabilities and compatibility

Add `bot:read` and `bot:write` to Aiden Remote API v1 as capability-gated additive work. Change these sources of truth together:

- `docs/aiden-remote-api-v1.md`
- `protocol/aiden-remote/v1/openapi.json`
- `protocol/aiden-remote/v1/fixtures/contract.json`
- `main/services/aiden-remote-protocol.ts`
- `ios/AidenOnTheGo/Networking/AidenRemoteContract.swift`

Increment `contractRevision` from its current value to the next free revision. Keep `/api/aiden/v1`; no breaking URL version is needed if older decoders ignore additive DTO fields and the capability negotiation is explicit.

New clients explicitly advertise support for the Bot capability vocabulary during pairing; only then may a new pairing disclose and grant bot read/write. Existing paired devices do **not** silently gain new authority. The Mac must locally approve the additional capability or require re-pairing, with minimum-client enforcement where needed. `/server` must distinguish server-supported capabilities from the authenticated device's actual grants so iOS never advertises an action it cannot perform.

Swift must represent those values separately (for example, `serverCapabilities` and `deviceCapabilities`). The current legacy `AidenInstallation.capabilities` value is ambiguous because `/server` overwrites the pairing grant; migration therefore treats legacy Bot grants as absent until the Mac explicitly approves the upgrade or the phone re-pairs. Merely seeing `bot:read` in server support never enables the Bots area.

### Proposed endpoint inventory

Exact request/response shapes are frozen in Phase 1, but the behavior is:

- `GET /bots` — bounded summaries, favorites, health, archive state; no instructions.
- `POST /bots` — idempotent main-owned creation.
- `GET /bots/{botId}` — authenticated detail including editable guidance and safe access view.
- `PATCH /bots/{botId}` — exact-key, `If-Match` identity edit.
- `DELETE /bots/{botId}` — revision-checked soft archive; never hard-delete bot data.
- `POST /bots/{botId}/restore` — idempotent revision-checked restore.
- `GET /bot-conversations?cursor=…&query=…&botId=…` — bounded, paginated inbox summaries and previews.
- `POST /bots/{botId}/chats` — idempotent creation of the real authoritative `botId` chat; ordinary `POST /chats` can never accept a client-provided `botId`.
- `GET /bot-capabilities` — safe provider, file-scope, shell, connection/MCP, skill, and other capability-group projection; no managed path.
- `PATCH /bots/{botId}/capabilities` — expected-revision Full/Custom policy update.
- `PATCH /chats/{chatId}/capabilities` — expected-revision chat subset update.
- `GET /bot-conversations/{chatId}/files` and bot-chat-scoped file read/write routes — reuse the existing safe file DTOs while authorizing against the device grant, authoritative `botId`, bot policy, chat reduction, policy epoch, and managed-home identity. Ordinary Workspace file routes reject hidden Bot homes even if an opaque workspace ID is learned.
- `PUT /bots/{botId}/avatar` — one bounded selected raster upload with expected revision.
- `GET /bots/{botId}/avatar/{assetRevision}` — authenticated canonical image content with `no-store`/`nosniff` headers.
- `DELETE /bots/{botId}/avatar` — return to the semantic fallback.

Add optional `botId` to the Chat DTO. Make `GET /chats` regular-only and use the dedicated Bot collection for bot recents; this corrects the current undocumented mixing behavior and makes older mobile builds stop showing indistinguishable bot chats.

Bot list/detail/favorite/access mutations use optimistic revisions. Create/chat/avatar operations use device-scoped idempotency keys. Disconnect never retries a create or a turn solely because the response was lost.

Favorite membership and order are Mac-owned Bot metadata, revision-checked, and shared across paired devices. Device-local caches mirror the authoritative order but cannot silently reorder it while offline.

### Bounded inbox projection

Do not call `listByBot` once per bot. Add one main-owned projection service that:

- filters indexed chat metadata by `botId` once;
- pages newest-first with stable cursors and a fixed page size;
- reads only the bounded page of chat payloads to derive a sanitized last visible message preview;
- caps bot count, candidate scan, preview scalars, response bytes, and search work;
- never includes reasoning, tool arguments/results, paths, attachment bytes, private journals, or provider errors;
- reports real stream/approval state from the existing authoritative registries rather than inventing unread state.

### Avatar asset contract

On iPhone/iPad:

1. Prefill the system Image Playground sheet from the visible bot name/purpose only.
2. Let the system own prompting, alternatives, safety handling, cancellation, and selection.
3. On iOS 18.4 and later, explicitly allow only Apple's illustration, animation, and sketch styles; never use unrestricted `.all`, which may expose a configured external provider on newer systems. Disable Photos/person personalization unless the owner later approves it as a separate feature.
4. Read the returned temporary URL immediately, normalize a square 512 × 512 image with ImageIO/UIKit, strip metadata, and show a local preview.
5. Upload only after the person taps **Use this image** and the Mac is connected.
6. Remove the temporary candidate on cancel, replacement, completion, or view teardown.

On the Mac:

- accept only a dedicated bounded envelope (PNG/JPEG source, at most 4 MiB decoded and 6 MiB for the dedicated JSON transport envelope); the phone's 512 × 512 normalization makes the tighter bound sufficient while the Mac still validates every untrusted upload independently;
- verify signature, completeness, dimensions, decoded pixel bound, and one-frame image content;
- independently normalize to canonical 512 × 512 PNG with metadata removed;
- stage and digest-verify the content-addressed asset, atomically write it with mode `0600` under an owned `0700` directory, fsync, swap the manifest revision, then prune the old revision;
- retain the semantic avatar in `bots.json` so an older build or unavailable asset still has a valid identity;
- serve only the exact authenticated bot/revision route, never a raw local path or data URL.

iOS caches bounded avatar bytes under protected, installation/device/bot/revision keys and prunes them with the existing installation data. Cached Bots remain read-only offline; avatar Save stays disabled until the authoritative Mac can accept it.

The shared `AidenChatDraftStore` may persist only composer text keyed by `(instanceId, chatId)` in the app's protected private container. It is not available to App Intents, the widget App Group, logs, or other installations; a successful send clears it and installation removal/revocation/re-pair purges it. Attachments retain their existing bounded reference lifecycle and are not copied into this draft store.

## Migration and compatibility

### Existing bots and chats

The current runtime already gives bot turns ambient Aiden capabilities, so migration preserves that behavior explicitly instead of silently restricting existing bots or pretending it is new:

- preserve bot identity, instructions, semantic avatar, archive state, Telegram binding, chat history, existing chat workspace, and each chat's provider/model;
- transactionally create one valid `full` policy and one durable non-Git managed home for every existing bot;
- show the versioned Full Access notice before the first bot action from Aiden On The Go, with **Continue with Full Access** and **Customize first**;
- use the new managed home for every new chat and as the normal artifact destination; do not move nonempty historical chats or rewrite their workspace/history during migration;
- make existing chats inherit the bot's explicit Full policy unless a later user action narrows them;
- allow immediate conversion to Custom, including selective Connections and Skills controls;
- block and offer repair for corrupt/future policy or workspace-binding data; never treat corruption as permission to infer Full.

New bot creation commits identity, explicit `full` policy, semantic fallback, and managed workspace binding as one recoverable operation. A crash that leaves an incomplete record blocks chat creation until reconciliation finishes; it does not create a second workspace or fall back to an arbitrary folder.

### Older Mac, older phone, and rollback

- Older Macs expose no bot capability; Bots is disabled on mobile with upgrade guidance.
- Older phones ignore additive Chat fields and do not receive new bot grants. They continue using Workspaces.
- New Macs keep old semantic bot fields valid and store raster/capability data in companion stores so an older desktop release cannot strip it from `bots.json`.
- After rollback, generated images may not be editable but the semantic fallback remains visible and bot chats remain ordinary Aiden chats.
- Removing a paired installation purges its Bot DTO cache and avatar cache along with chat credentials/data.

## Delivery phases

The active Aiden On The Go plan has reached Phase 12 but still records open physical-iPad, Stage Manager, signing/privacy, and wider-release acceptance. Phase 0 documentation/prototyping may proceed, but this feature cannot be declared release-ready by inheriting those unproven gates. Existing open gates must be completed or explicitly owner-waived with evidence.

### Phase 0 — Freeze contracts, disclosure, and threat model

1. Record the resolved owner decisions from this plan in the product spec: iOS first, explicit Full Access default, Custom reductions, one hidden managed home per bot, shell allowed, and no Git initialization by default.
2. Update `ios/PROJECT_SPEC.md` and the Aiden On The Go plan to add the Bots follow-on without weakening its client-only/security rules.
3. Define the two-area navigation contract, default/last-mode behavior, terminology, favorite ownership, Full Access notice/versioning, Custom access copy, and existing-bot migration copy.
4. Threat-model Full's dynamic inventory, Custom forged selections, policy/workspace rollback or corruption, outside-home file access, skill/MCP/provider drift, active-turn narrowing, Telegram parity, raster bombs, cross-bot avatar reads, and multi-device races.
5. Prototype the native logo menu, inbox density, bot editor, access sheet, and iPad split layout using fixture data only.

Acceptance:

- reviewed product decision table, approved one-time notice copy, and updated threat model;
- no production endpoint or renderer toggle before the main-owned policy is specified;
- prototype passes owner review at compact iPhone and iPad split widths in Aiden's four themes.

### Phase 1 — Correct chat classification and freeze Remote API v1 additions

Completed August 23, 2026. Contract revision 7 separates server-supported Bot vocabulary from exact device grants, persists explicit negotiation, adds bounded Bot classification to the shared Chat DTO, and makes Workspace collections regular-only. Main-owned metadata classification now runs before every retained chat/stream/attachment/approval payload read or effect, with normalized not-found/expired failures that do not reveal Bot existence. Swift stores grants and support separately, migrates ambiguous legacy state fail-closed, atomically persists negotiated support during pairing, and uses a new cache namespace so older ambiguous chat projections cannot reappear offline. Evidence: `docs/testing/aiden-on-the-go/bot-first-phase-1.md`.

1. Add `botId?` to TypeScript/Swift Chat DTOs and the shared fixture.
2. Make Workspace/home chat lists regular-only and prove bot chats cannot leak into them.
3. Specify `bot:read`/`bot:write`, negotiation, existing-device upgrade, endpoints, allowlists, revisions, idempotency, errors, pagination, limits, and log redaction.
4. Add strict tolerant Swift decoding: additive response fields are ignored, but required identity/grant/revision fields fail closed.

Acceptance:

- TypeScript and Swift decode the same incremented fixture;
- old client compatibility test is green;
- regular and bot lists are disjoint in service, router, and Swift tests;
- a device without `bot:read` cannot infer bot existence through any route.

### Phase 2 — Main-owned bot application and capability services

1. Extract a bot application service from Electron IPC semantics; HTTP never calls IPC or impersonates a `WebContents`.
2. Add the versioned Full/Custom capability store, optimistic revisions, notice acknowledgement, crash reconciliation, mode-0600 permissions, and policy view projector.
3. Add a main-owned managed-workspace service that provisions exactly one durable, non-Git home per bot, resolves the private path for prompts/tools, and reuses it across new chats.
4. Add safe catalogs for providers/models, file scopes, shell, MCP connections/tools, skills, and other ordinary Aiden capability groups.
5. Add per-chat inheritance/reductions, Custom opaque grants, policy epochs/leases, archive/copy/delete handling, and explicit-Full legacy migration.
6. Keep identity, policy, workspace, and avatar mutations isolated by revision while reconciling incomplete multi-store creation safely.

Acceptance:

- every new/migrated bot has one explicit Full/Custom policy and one non-Git managed home; missing/corrupt/future-version state is fail-closed;
- renderer/remote input cannot write internal fingerprints, paths, secrets, or arbitrary bot/chat IDs;
- create/update/archive/restore/copy/restart and simulated crash points reconcile without duplicate homes, implicit repositories, or authority outside the selected mode.

### Phase 3 — Enforce Full/Custom access and managed workspace behavior

1. Set each bot home as the working directory and ordinary save destination for its chats; assert provisioning never creates `.git`.
2. Update the main-owned bot system prompt with the managed-home contract, outside-Mac inspection rule, minimal-change rule, and no-automatic-Git rule defined above.
3. Build Full mode from the current ordinary Aiden inventory, including shell, OS-accessible Files, configured MCP connections, skills, and other globally enabled capabilities while preserving existing approvals and safety gates.
4. Split Files from shell for Custom mode; enforce Bot folder, chosen locations, or Off plus the exact selected capability groups.
5. Bind and filter Custom MCP tools and Skills across schemas, execution, prompt inventory, Pi resources, and explicit invocation; fail closed on drift.
6. Bind provider/model without silent fallback and fence active work immediately when access narrows.
7. Permit Git through ordinary shell or selected connections when the task explicitly makes it relevant, but never initialize a repository or perform Git setup as workspace provisioning.
8. Apply the same resolver and system-instruction contract to desktop-, mobile-, copied-, and Telegram-bound bot chats.

Acceptance:

- Full can run shell from the managed home, save ordinary artifacts there, and inspect an OS-accessible external location only when the request needs it;
- Custom can turn shell, Files, individual Connections, Skills, and other groups off, and removed capabilities disappear from prompt, schema, and execution;
- provisioning and ordinary chat creation produce no `.git`, branch, or commit, while an explicit Git task against a real repository still follows existing safeguards;
- new globally enabled capabilities appear for Full as disclosed, while new/changed/disabled resources never silently widen Custom;
- active narrowing fences the next effect;
- the UI's access summary exactly matches the effective main-owned tool inventory.

### Phase 4 — Remote bot service, inbox projection, and avatar store

1. Add bot service adapters and route them through the authenticated Aiden Remote router/service lifecycle.
2. Implement bot CRUD, favorites/order, archive/restore, capability views/updates, bot-chat creation, and chat-subset updates.
3. Add the bounded paginated inbox/search projection.
4. Add canonical raster asset storage/upload/content/delete with cross-device and cross-bot isolation.
5. Add desktop refresh notifications and optimistic conflict responses for simultaneous mobile/Mac edits.

Acceptance:

- complete mocked REST flow creates a bot, edits access, creates a real bot-tagged chat, streams a turn, narrows the chat, archives/restores, and survives restart;
- N+1 history reads, response/path/credential leakage, oversized assets, duplicate IDs, replay, and stale revisions fail safely;
- revoking one phone closes its bot access without disrupting another.

### Phase 5 — Swift domain, cache, and product shell

1. Add typed Bot DTOs, avatar recipes, access/catalog views, client methods, and instance-scoped cache.
2. Add an outer `AidenProductShellView` with per-installation Workspaces/Bots mode state while leaving pairing unchanged.
3. Turn the existing Aiden logo into the native two-choice switcher.
4. Rename the current “New Agent” Workspace flow to unambiguous Workspace language.
5. Present the versioned Full Access notice before the first Bot action, persist acceptance on the Mac, and let **Customize first** enter the same Bot editor without creating a chat.
6. Route chat deep links/Live Activities by fetching the chat and switching to Bots when `botId` is present.
7. Purge Bot cache on removal/revocation/re-pair and reject Mac A → B → A stale completions.

Acceptance:

- mode switching preserves independent compact/regular navigation per installation;
- no bot can act until the current Full Access notice is accepted or the bot is changed to Custom;
- unsupported/ungranted/offline states are honest and mutation-free;
- existing pairing, Workspace navigation, deep links, App Intents, and stream recovery remain green.

### Phase 6 — Bot inbox, profile, create/edit, and chat access UI

1. Build favorites, recent threads, bounded search, edit/reorder/archive/delete, loading/empty/error/offline states, and adaptive iPad split navigation.
2. Build the contact-like Bot profile.
3. Build the guided nontechnical editor and semantic avatar designer.
4. Build a clear Full Access summary and a progressive Custom editor for AI, Mac Files, shell, individual Connections, Skills, and other capability groups from Mac-projected catalogs.
5. Add the per-chat subset sheet and effective-access summary to the shared chat surface.
6. Keep the Bot presentation message-first: hide workspace selection, branch/worktree, Review, and persistent Terminal chrome without removing the shell capability itself or duplicating the chat engine.

Acceptance:

- all state inventory in this plan is exercised with behavioral Swift tests, not only source regexes;
- VoiceOver, Dynamic Type, keyboard/pointer, reduced motion/transparency, light/dark, and all Aiden presets pass;
- the person can complete notice → create → conversation with Full Access, or choose Custom and selectively disable shell/Files/Connections/Skills, without seeing Pi, JSON, fingerprints, environment variables, managed paths, or “system prompt” as a required concept.

### Phase 7 — Apple Image Playground and generated-avatar lifecycle

1. Add an iOS 18.1 availability-isolated wrapper around the current SwiftUI Image Playground sheet.
2. Prefill only visible identity/purpose, explicitly allow Apple's three non-personalized styles, disclose Apple-controlled generation, and support cancel/retry/unavailable/restricted/model-downloading/usage-limit states.
3. Normalize and preview locally; after **Use this image**, upload the accepted image to the paired Mac, make its canonical normalized copy the bot photo, then cache/replace/revert using the Phase 4 asset contract.
4. Keep the semantic avatar editor always available and never require Apple Intelligence to create a bot.
5. Update privacy/support/App Review copy so it describes the actual system behavior and paired-Mac upload.

Acceptance:

- supported physical Apple Intelligence hardware completes the system sheet → preview → authenticated paired-Mac save → relaunch/cache cycle;
- physical iPhone 13 Pro proves the unavailable fallback and no dead controls;
- cancel, refusal, offline-after-generation, oversize/corrupt result, upload ambiguity, replacement, and rollback are tested;
- no prompt, rejected candidate, temporary URL, image bytes, credential, or local path enters logs or ordinary Bot DTOs;
- source checks forbid `ImageCreator`, unrestricted `.all` styles, and accidental Photos-personalization enablement.

### Phase 8 — Onboarding, rollout, and release evidence

1. Keep Mac UI changes narrowly integrative: existing Bot views render the canonical photo returned from iOS with the semantic fallback. Defer the Mac Aiden-logo switcher, Messages-style inbox, and redesigned desktop Access editor to a later plan.
2. Update Telegram to the same Full/Custom policy resolver and keep unsupported approvals blocked.
3. Update the concise iOS onboarding/coachmark so new users discover the logo switcher and understand the one-time Full Access notice after pairing.
4. Review the desktop onboarding Bots tile for accuracy as required by the repository contract; update its copy, dedicated optimized 1024 × 1024 transparent PNG, and test only if the shipped backend/mobile capability is advertised there. Do not turn this into a Mac Bots UX redesign.
5. Ship behind server capability negotiation and a mobile feature flag, then migrate in stages: internal test data, fresh profiles, legacy profiles with explicit Full records, wider TestFlight.
6. Run full Mac/iOS suites, packaged listener tests, signed physical iPhone/iPad acceptance, multi-device/multi-Mac/revocation/offline/restart tests, privacy review, and App Store metadata checks.
7. Re-audit against the shipping iOS/Xcode 27 SDK before wider release because Apple's Image Playground processing and API surface are changing.

Acceptance:

- no P0/P1 security, data-loss, navigation, accessibility, or privacy findings remain;
- all existing Aiden On The Go Phase 12 gates are complete or explicitly owner-waived with recorded evidence;
- the release matrix covers supported and unsupported Image Playground hardware, iPhone, physical iPad/Stage Manager, Mac update/rollback, older paired clients, Telegram, and concurrent edits;
- generated photos selected on iOS survive paired-Mac save/restart and appear in existing Mac Bot surfaces without requiring a desktop redesign;
- onboarding advertises only shipped behavior and its required asset remains exact;
- App Review can create and use a Bot without Image Playground, and the “No data collected” declaration remains only if the final build still has no developer telemetry or relay.

## Likely implementation map

### Shared bot/runtime work

- `renderer/shared/bots.ts`
- new `renderer/shared/bot-capabilities.ts`
- `main/services/bot-store-core.ts`, `bot-store.ts`, `bot-mutation-gate.ts`
- new `main/services/bot-application-service.ts`
- new `main/services/bot-capability-store-core.ts`, `bot-capability-resolver.ts`, `bot-capability-bindings.ts`, `bot-capability-lease.ts`
- new `main/services/bot-managed-workspace.ts` and updates to `main/services/bot-system-prompt.ts`
- new `main/services/bot-avatar-asset-store-core.ts`
- `main/services/chat-store-core.ts`, `types.ts`, `visible-chat-projection.ts`
- `main/services/llm-client.ts`, `tools.ts`, `coding-tools.ts`, `mcp-selection.ts`, skill registry/tool/invocation paths, model runtime
- Telegram bot binding/turn/service paths
- `main/handlers/bot-params.ts`, `bots.ts`
- `renderer/lib/ipc.ts`, `queries.ts`
- `renderer/main/bots-view.tsx` for canonical-photo display/fallback only; no desktop shell redesign in this plan

### Aiden Remote contract/service work

- `docs/aiden-remote-api-v1.md`
- `docs/security/aiden-remote-threat-model.md`
- `protocol/aiden-remote/v1/openapi.json`
- `protocol/aiden-remote/v1/fixtures/contract.json`
- `main/services/aiden-remote-protocol.ts`
- new `main/services/aiden-remote-bots.ts`
- `main/services/aiden-remote-chats.ts`, `aiden-remote-router.ts`, `aiden-remote-service.ts`, main service wiring
- remote pairing/state/device-grant code

### iPhone/iPad work

- `ios/PROJECT_SPEC.md`
- `ios/AidenOnTheGo/ContentView.swift`
- new `Features/Remote/AidenProductShellView.swift`
- refactored `Features/Remote/AidenWorkspaceShellView.swift`
- new focused `Features/Bots/AidenBotsHomeView.swift`
- new `Features/Bots/AidenBotEditorView.swift`, `AidenBotAvatarView.swift`, and `AidenImagePlaygroundAvatarPicker.swift`
- shared `Features/Remote/AidenChatFeature.swift`
- new `Models/AidenBot.swift`
- existing `Models/AidenChat.swift`
- `Networking/AidenRemoteContract.swift`, `AidenRemoteClient.swift`
- new `Persistence/AidenBotCache.swift`
- `Features/Remote/AidenRemoteCoordinator.swift`
- `LiveActivities/AidenDeepLink.swift`
- `Resources/Localizable.xcstrings`, privacy/support/App Review material
- `ios/app-store/MOBILE_PRIVACY_SUPPORT_COPY.md` and `ios/APP_STORE_METADATA.md`
- `ios/AidenOnTheGo.xcodeproj/project.pbxproj`

### Onboarding and plans

- `renderer/components/onboarding-flow.tsx`
- `renderer/assets/onboarding/features/bots.png`
- `renderer/components/onboarding-flow.test.tsx`
- `docs/plans/aiden-on-the-go-plan.md`
- `docs/plans/README.md`
- relevant evidence under `docs/testing/aiden-on-the-go/`

## Verification matrix

### TypeScript/Mac

Add focused, explicitly registered suites for:

- explicit Full/Custom policy schema, store, migration, notice version, corruption/future-version blocking, and crash recovery;
- managed-home stability, mode/permissions, no implicit `.git`, no duplicate creation, private path projection, and legacy-chat preservation;
- authoritative system-prompt injection, managed-home `cwd`/ordinary save behavior, outside-home inspection when needed, and resistance to editable-instruction override;
- Full dynamic inventory, working shell, connection/skill additions, ordinary Aiden approvals/safety, and active lease invalidation;
- Custom file scopes, shell removal, exact MCP schema/effect drift, skill drift, provider binding, chat subsets, and immediate narrowing;
- regular-vs-bot remote Chat projection;
- remote Bot CRUD, grant checks, idempotency/revisions, inbox bounds/search, asset validation/content isolation, log redaction, multi-device revocation;
- Telegram surface ceiling and no policy bypass;
- existing renderer bot-photo fallback/display and onboarding contract.

Register new files under `test:bots`, `test:aiden-remote`, `test:telegram`, `test:onboarding`, and the applicable full/coverage scripts in `package.json`.

### Swift

Add `AidenBotTests.swift` and extend:

- `AidenRemotePhase0Tests.swift` for shared fixtures/capabilities;
- `AidenRemoteClientTests.swift` for canonical routes, headers, errors, revisions, and idempotency;
- `AidenChatTests.swift` for `botId`, deep-link routing, streaming continuity, and per-chat subsets;
- `AidenNativeIntegrationTests.swift` for mode, menu, editor, availability, cache, accessibility, and source wiring.

Cover strict required-field decoding, tolerant additive fields, per-installation mode/cache, versioned notice presentation/acceptance, Full-to-Custom editing, per-chat reductions, absence of managed paths/secrets, A → B → A stale response rejection, offline mutation disabling, compact/regular navigation, Dynamic Type layout, VoiceOver labels, generated-avatar state transitions, paired-Mac canonical-photo save, and temporary-file cleanup. Register new files in the Xcode project and update repository shipping-source policy tests that currently freeze the home logo and “New Agent” shell.

### Manual and physical evidence

- eligible Apple Intelligence iPhone or iPad: Image Playground success/cancel/refusal/network/model-download states;
- ineligible iPhone 13 Pro: fallback and no misleading promise;
- physical iPad: split view, Stage Manager, keyboard/pointer, rotation, large text;
- two paired devices and two saved Macs: grants, caches, favorites, edits, revocation, and stale responses;
- Full notice once per version, Full shell from the managed home, normal artifact save there, deliberate outside-home inspection, Custom reductions, and no automatic repository initialization;
- Mac restart/update/rollback, phone offline/reconnect, stream/approval recovery, and concurrent desktop/mobile edits;
- Telegram bound bot with selected and unselected capabilities;
- light/dark × Aiden/Slate/Berry/Moss × Reduce Motion/Transparency.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Attractive toggles lie about real authority | Build/enforce the main-owned policy before UI; test the effective tool list against the presented summary |
| Full Access surprises a nontechnical person | One blocking versioned notice, persistent Full Access label, **Customize first**, and a direct Bot settings path |
| A bot changes unrelated Mac files unnecessarily | Managed home as `cwd`/default save location, main-owned operating instructions, scoped-action guidance, and existing destructive-action approvals |
| A managed home becomes a repository merely by existing | Provisioning asserts no `.git`; no automatic init/branch/commit; Git is used only when the task makes it relevant |
| A newly enabled MCP tool or Skill appears unexpectedly | Disclose Full's dynamic behavior; Custom uses exact opaque grants and drift review and never grows silently |
| Existing paired device is silently widened | Local Mac approval/re-pair for `bot:*`; distinguish server support from device grant |
| Bot chats continue leaking into Workspaces | Fix `botId` projection and disjoint list semantics in Phase 1 before UI |
| Mobile UI becomes a separate runtime | Shared application services and existing Chat/SSE engine; no HTTP-to-IPC bridge |
| Inbox becomes slow or exposes history | One bounded paginated projection; only sanitized visible preview; no N+1 per bot |
| Generated image is oversized, malicious, or leaks a path | iOS preprocessing plus independent Mac decode/normalize, bounded canonical store, opaque authenticated content route |
| Apple processing is mislabeled | Say “Create with Apple Intelligence”; link/system disclosure; never promise universal offline/on-device behavior |
| Image Playground is unavailable | Semantic avatar editor remains complete and first-class |
| Old release removes new identity | Raster/policy companion stores; semantic fallback remains in rollback-compatible `bots.json` |
| Policy corruption accidentally becomes Full | Full is an explicit valid record, never a fallback; corrupt/future state blocks and repairs |
| Bot settings and chat settings disagree | Full chats inherit with explicit reductions; Custom chats use subsets; narrowing invalidates leases immediately |

## Owner decisions resolved — August 22, 2026

1. Apple Image Playground and Private Cloud Compute are acceptable on supported phones. The accepted result is sent to the paired Mac and becomes the bot photo.
2. The Messages-style Bot-first redesign is iPhone/iPad-only for this release. A Mac UX redesign is deferred.
3. Managed bot workspaces are not active Git repositories by default. Shell is available; Git is neither initialized automatically nor categorically blocked when a real task needs it.
4. Each bot has one hidden Aiden-managed home used by its chats. The bot normally creates and saves files there, may inspect the rest of the Mac as needed under Full Access, and explains the folder only when asked. The main-owned bot system instructions enforce that behavior.
5. Bots default to Full Access after a one-time versioned notice. People can switch a bot to Custom and reduce capabilities; a chat can narrow its bot but cannot exceed it.
