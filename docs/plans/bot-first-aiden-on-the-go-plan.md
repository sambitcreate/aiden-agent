# Bot-First Aiden On The Go

- Status: Planned; owner decisions at the end of this document are still open
- Created: August 22, 2026
- Primary surface: Aiden On The Go for iPhone and iPad
- Authority: the paired Aiden Agent Mac remains the runtime and persistence owner

## Outcome

Aiden On The Go will have two clear product areas:

- **Workspaces** — project-oriented chats with folders, terminal, review, and Git.
- **Bots** — reusable helpers presented like familiar message contacts and threads.

The Aiden logo at the top of the existing mobile home becomes the switcher. Tapping it opens exactly those two choices, marks the current choice, and returns the person to the last place they visited in each area. Bots becomes the default after a paired Mac supports and grants the new bot capability; Workspaces remains the safe fallback for older installations.

The Bots area will adapt the attached Messages references without copying Apple's product chrome. It will lead with large bot identities, favorites, recent conversations, search, and simple create/edit actions. It will continue to use Aiden's own appearance presets, semantic colors, chat renderer, streaming, attachments, approvals, and motion language.

A bot remains a thin, reusable identity over Aiden's existing Pi-backed chat runtime. The phone will not host a second agent engine. Bot definitions, conversations, access policies, generated avatars, provider selection, and every tool decision remain authoritative on the paired Mac.

## Recommended decisions captured by this plan

These are the safe defaults used throughout the phases. The owner questions at the end can change them before implementation begins.

1. The new bot-first shell is **iPhone/iPad first**. The Mac receives the shared services, security enforcement, remote API, avatar storage, and equivalent access controls in its existing Bots editor. Replacing the complete Mac shell with the same inbox is a separate scope decision.
2. “No Git” is treated as a **real runtime boundary**, not merely hidden buttons. A Bot chat receives no terminal, `run_command`, built-in Git tools, Review surface, Computer Use, schedules, or subagents.
3. Files are separate from shell access. The plain-language choices are **Off**, **Read only**, and **Ask before changing**.
4. A bot's Access settings are both the default and the maximum for its chats. A chat can turn allowed items off or back on, but cannot exceed its bot's ceiling.
5. Bot access sets the template for new chats. Existing chats never gain newly added access silently. Removing access narrows every affected chat immediately.
6. Provider credentials, MCP credentials, skill contents, paths, and configuration remain Mac-only. Mobile selects safe, already-configured entries; it does not receive or edit their secrets.
7. Apple avatar creation uses the system **Image Playground** sheet. It is not described as Foundation Models or promised to be offline/on-device on every OS release.
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

### Correctness issue that must be fixed first

`AidenRemoteChatService.list()` currently calls the all-chat application list, which includes bot-tagged chats. `projectAidenRemoteChat()` then removes `botId`. Aiden On The Go can therefore receive a bot chat inside its Workspace/home list without knowing that it is a bot chat.

Phase 1 will add optional `botId` to the wire `Chat` DTO, make normal Workspace lists explicitly regular-only, and put bot conversations behind bot-specific projections. No Bot inbox styling starts until shared TypeScript/Swift fixtures prove that classification.

### Current access is too broad for this product

Today a foreground bot chat inherits the normal ambient tool assembly:

- the combined coding tool set includes read, write, edit, and unrestricted `run_command`;
- all enabled MCP servers may be added;
- all available skills and skill resources may be added;
- Exa, schedules, subagents, and Computer Use can enter through normal chat rules;
- Telegram bot turns use a different surface ceiling and currently do not match a per-bot policy.

Hiding Git or Terminal would not remove their authority. The new access UI therefore depends on a main-owned, positive allowlist and turn-admission resolver. Renderer and phone toggles are requests to update that policy, never authority by themselves.

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
| Workspaces | Projects, folders, terminal, review, and Git | Last Workspace/chat, otherwise Workspace home |

Behavior:

- remember the last selected area and independent navigation state per paired `instanceId`;
- default to Bots only when the authenticated device has `bot:read`;
- disable Bots with actionable “Update or approve access on your Mac” copy when the server or device grant is missing;
- do not switch until navigation succeeds;
- preserve drafts and respect any existing navigation/mutation blocker;
- close on Escape/click-away where applicable and restore focus to the logo;
- announce the current area in the logo's accessibility label.

Pairing remains outside this switcher. Scheduled Tasks, Usage, installation management, and appearance stay reachable from shared settings rather than becoming a third top-level area.

### 2. Bots home

The first screen is a calm inbox, not a configuration dashboard:

1. Header: Aiden logo switcher, centered **Bots** title, Search, Edit, and **+**.
2. Favorites: horizontally scrolling circular bot avatars and visible names.
3. Recent conversations: flat rows with bot avatar, bot name, conversation title or bounded last-message preview, honest activity state, and relative time.
4. Floating compose: starts a new conversation by choosing an existing bot. **+** always creates a new bot.

Rules:

- tapping a favorite opens its bot profile; it never silently sends or creates work;
- tapping a recent row opens that exact persisted chat;
- no fake unread badge is introduced. A ring/badge is shown only for real streaming, waiting-for-approval, failed, or locally known new activity;
- search covers bot name, purpose, conversation title, and the bounded previews actually returned by the Mac;
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

Archived bots remain readable but cannot start a new turn until restored. Missing or corrupted policy state shows **Review access** and uses the safe baseline.

### 4. Create and edit bot

Use one guided native sheet/Form with progressive sections and a stable Save action:

1. **Identity** — name, “What is this bot for?”, and optional opening greeting.
2. **How it helps** — friendly behavior guidance; raw “Advanced instructions” stays behind disclosure instead of leading with “System prompt” or Pi language.
3. **Access** — AI connection/model, Files, Connections, and Skills. This is prominent, not hidden under Advanced.
4. **Look** — live circular preview, Aiden style editor/shuffle, and Create with Apple Intelligence when supported.
5. **Review** — concise summary of what the bot can access before Save.

Drafts stay local until Save. Cancel on a dirty draft asks before discarding. Saving is one main-owned mutation with optimistic revision checking; a network ambiguity reconciles from the Mac instead of repeating creation.

An optional opening greeting is copied once into each newly created chat. Editing the bot later does not rewrite old conversations.

### 5. Bot conversation

Reuse `AidenChatDetailView` and its view model rather than fork the transcript/runtime. Add only a bot presentation layer:

- avatar and bot name in the conversation title/contact affordance;
- compact access summary such as **Files · 3 connections · 2 skills**;
- a toolbar sheet for **Bot defaults** versus **This chat**;
- Files entry only when that chat has Files access;
- no workspace permission picker, branch/worktree, Review, Git, Terminal, Computer Use, schedules, or subagent controls;
- existing provider/model, attachment, dictation, send/stop, approval, streaming, and reconciliation behavior stays shared.

Changing access while a turn is active invalidates its authority lease. Removed access blocks the next effect immediately; newly added access is unavailable until the next turn. The UI explains that access changed rather than presenting a generic provider failure.

### 6. iPad and constrained windows

- iPhone keeps native push navigation.
- iPad and wide Stage Manager windows use a Bot `NavigationSplitView`: inbox on the leading side, selected profile/chat in detail.
- compact/regular transitions preserve the selected bot/chat just as the current Workspace shell preserves workspace selection.
- favorite identities reflow or scroll; they never become a fixed four-column phone grid.
- keyboard, pointer, VoiceOver, Dynamic Type, Reduce Motion, Reduce Transparency, rotation, and split-window widths are acceptance requirements, not polish deferrals.

## Access model

### What people see

| Area | Choices | Meaning |
| --- | --- | --- |
| AI connection | one configured provider/model | Where replies are generated; account secrets stay on the Mac |
| Files | Off / Read only / Ask before changing | Exact file tools only; no terminal or Git |
| Connections | configured MCP services, off by default | External apps/services this bot may use; “MCP” appears as explanatory detail |
| Skills | safe name/description list, off by default | Selected instructions and workflows available to this bot |
| This chat | subset of the bot's selections | A conversation may narrow access but cannot exceed its bot |

“Connect a new account” stays a Mac Settings task in the first release. Mobile shows unavailable, disabled, changed, or expired entries and tells the person what to fix on the Mac. Credentials never cross the remote API.

### Rules enforced by the Mac

The effective authority for a tool call is the intersection of:

1. current app/global availability;
2. the workspace's saved permission and root;
3. the bot's positive policy and exact bound resources;
4. that chat's positive subset;
5. the current surface ceiling (Electron, mobile, or Telegram);
6. the fresh turn/tool-effect lease.

The least powerful result always wins. Missing, duplicated, disabled, changed, corrupted, or future-version records resolve to unavailable, never to “all enabled.”

Specific enforcement:

- split file read/search and file edit/write builders away from shell;
- never register `run_command` or built-in Git for a Bot turn;
- reject `.git`, credential-family, private-key, symlink-escape, and root-replacement paths through the Bot file path;
- Workspace `none` denies Files; `ask` forces write approval; `full` can still be narrowed by the bot/chat;
- bind an MCP grant to the exact connection plus current tool names, input/output schemas, and conservative read/mutation effects;
- treat unknown MCP effects as mutating and require approval; do not silently include tools added after approval;
- convert a current safe skill-catalog selection into a main-only stable binding plus content fingerprint; content/source/workspace drift disables it until reviewed;
- filter automatic skill tools, prompt inventory, Pi resources, and explicit skill invocation together so no alternate invocation bypasses the toggle;
- bind provider/model selection to an available configured connection and never fall back to a different provider silently;
- invalidate active capability leases after narrowing, archive, global disable, connection change, credential change, or skill change.

MCP tools that themselves perform shell/Git-like work require the owner's answer about the intended “no Git” boundary. The safe Phase 1 assumption is to block those effects in Bots even when their parent connection is selected.

### Change behavior

- Bot additions apply to new chats only.
- Bot removals immediately narrow all chats.
- A re-added connection/skill receives a new internal grant identity, so old chats cannot regain it accidentally.
- Chat customization is an explicit, revision-checked subset.
- Moving an empty bot chat to another workspace revalidates Files and drops workspace-scoped skills that do not belong there.
- Copying a chat copies its explicit subset; it does not mint new access.
- Telegram-bound bot chats use the same resolver plus a stricter Telegram ceiling. Mutating or unclassified MCP use stays blocked until Telegram has a reviewed owner-bound approval surface.

## Main-owned storage and wire contract

### Persistence

Keep identity, authority, and raster assets separate so stale UI edits and rollback cannot overwrite one another:

- `bots.json`: existing identity/instructions/semantic fallback, extended with bounded purpose/greeting fields through its normal versioned parser;
- `bot-capabilities.json`: mode-0600 versioned policy records, revisions, opaque grants, main-only fingerprints, and safe fail-closed migration state;
- `bot-avatar-assets.json` plus an owned asset directory: bot ID, asset revision, dimensions, byte size, and atomic filename; never an arbitrary client path;
- each bot chat: explicit versioned capability snapshot/subset and existing `botId`.

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
- `GET /bot-capabilities` — safe provider, workspace, Files, MCP, and skill catalog projection.
- `PATCH /bots/{botId}/capabilities` — expected-revision bot ceiling/default update.
- `PATCH /chats/{chatId}/capabilities` — expected-revision chat subset update.
- `PUT /bots/{botId}/avatar` — one bounded selected raster upload with expected revision.
- `GET /bots/{botId}/avatar/{assetRevision}` — authenticated canonical image content with `no-store`/`nosniff` headers.
- `DELETE /bots/{botId}/avatar` — return to the semantic fallback.

Add optional `botId` to the Chat DTO. Make `GET /chats` regular-only and use the dedicated Bot collection for bot recents; this corrects the current undocumented mixing behavior and makes older mobile builds stop showing indistinguishable bot chats.

Bot list/detail/favorite/access mutations use optimistic revisions. Create/chat/avatar operations use device-scoped idempotency keys. Disconnect never retries a create or a turn solely because the response was lost.

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

- accept only a dedicated bounded envelope (PNG/JPEG source, at most 8 MiB decoded and 12 MiB including the existing base64 transport overhead);
- verify signature, completeness, dimensions, decoded pixel bound, and one-frame image content;
- independently normalize to canonical 512 × 512 PNG with metadata removed;
- stage and digest-verify the content-addressed asset, atomically write it with mode `0600` under an owned `0700` directory, fsync, swap the manifest revision, then prune the old revision;
- retain the semantic avatar in `bots.json` so an older build or unavailable asset still has a valid identity;
- serve only the exact authenticated bot/revision route, never a raw local path or data URL.

iOS caches bounded avatar bytes under protected, installation/device/bot/revision keys and prunes them with the existing installation data. Cached Bots remain read-only offline; avatar Save stays disabled until the authoritative Mac can accept it.

## Migration and compatibility

### Existing bots and chats

The current runtime was ambient, so automatically snapshotting all enabled MCPs, skills, and shell access would silently create broad durable grants. The recommended migration is:

- preserve bot identity, instructions, semantic avatar, archive state, Telegram binding, chat history, workspace, and each chat's existing provider/model;
- create a `needs_review` policy with no shell, Git, Computer Use, schedules, subagents, MCP connections, or skills;
- allow safe bounded Files read-only only where the existing workspace/root still validates; otherwise Files is Off;
- keep text conversation available and show a one-time **Review access** banner;
- require explicit selection before optional Connections/Skills are active;
- never use missing/corrupt/future capability data as a reason to restore ambient access.

New bots must complete the Access review before they can start a chat. A crash after persona creation but before policy creation reconciles that bot to `needs_review`, which is safe.

### Older Mac, older phone, and rollback

- Older Macs expose no bot capability; Bots is disabled on mobile with upgrade guidance.
- Older phones ignore additive Chat fields and do not receive new bot grants. They continue using Workspaces.
- New Macs keep old semantic bot fields valid and store raster/capability data in companion stores so an older desktop release cannot strip it from `bots.json`.
- After rollback, generated images may not be editable but the semantic fallback remains visible and bot chats remain ordinary Aiden chats.
- Removing a paired installation purges its Bot DTO cache and avatar cache along with chat credentials/data.

## Delivery phases

The active Aiden On The Go plan has reached Phase 12 but still records open physical-iPad, Stage Manager, signing/privacy, and wider-release acceptance. Phase 0 documentation/prototyping may proceed, but this feature cannot be declared release-ready by inheriting those unproven gates. Existing open gates must be completed or explicitly owner-waived with evidence.

### Phase 0 — Freeze product and threat decisions

1. Resolve the owner questions at the end of this plan.
2. Update `ios/PROJECT_SPEC.md` and the Aiden On The Go plan to add the Bots follow-on without weakening its client-only/security rules.
3. Define the two-area navigation contract, default/last-mode behavior, terminology, favorite ownership, and existing-bot migration copy.
4. Threat-model capability upgrades, forged selections, policy rollback/corruption, skill/MCP/provider drift, active-turn narrowing, Telegram parity, raster bombs, cross-bot avatar reads, and multi-device races.
5. Prototype the native logo menu, inbox density, bot editor, access sheet, and iPad split layout using fixture data only.

Acceptance:

- reviewed product decision table and updated threat model;
- no production endpoint or renderer toggle before the main-owned policy is specified;
- prototype passes owner review at compact iPhone and iPad split widths in Aiden's four themes.

### Phase 1 — Correct chat classification and freeze Remote API v1 additions

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
2. Add the versioned capability store, optimistic revisions, crash reconciliation, mode-0600 permissions, and policy view projector.
3. Add safe catalogs for providers/models, workspaces, MCP connections/tools, and skills.
4. Add per-chat snapshots, opaque grants, policy epochs/leases, archive/copy/move/delete handling, and legacy `needs_review` migration.
5. Keep identity, policy, and avatar mutations separate so stale edits cannot overwrite one another.

Acceptance:

- missing/corrupt/future-version state is fail-closed;
- renderer/remote input cannot write internal fingerprints, paths, secrets, or arbitrary bot/chat IDs;
- create/update/archive/restore/copy/move/restart and simulated crash points reconcile without widening access.

### Phase 3 — Enforce Files, Connections, Skills, and surface ceilings

1. Split positive file read/search and file edit/write tools from shell/Git.
2. Reuse the hardened path/credential/symlink checks and enforce the selected Files tier plus workspace permission.
3. Bind and filter exact MCP tools using connection/schema/effect fingerprints and one-shot approvals.
4. Bind and filter Skills across tool creation, prompt inventory, Pi resources, and explicit invocation.
5. Bind provider/model without silent fallback.
6. Remove ambient Exa, schedules, subagents, Computer Use, shell, and Git from Bot turns unless a future reviewed capability explicitly adds them.
7. Apply the same policy resolver to desktop, mobile-created, copied, and Telegram bot chats.

Acceptance:

- adversarial tests prove a Bot with Files can read only within its workspace and has no shell/Git path;
- unselected/new/changed/disabled MCP tools and Skills never appear in prompt, schema, or execution;
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
5. Route chat deep links/Live Activities by fetching the chat and switching to Bots when `botId` is present.
6. Purge Bot cache on removal/revocation/re-pair and reject Mac A → B → A stale completions.

Acceptance:

- mode switching preserves independent compact/regular navigation per installation;
- unsupported/ungranted/offline states are honest and mutation-free;
- existing pairing, Workspace navigation, deep links, App Intents, and stream recovery remain green.

### Phase 6 — Bot inbox, profile, create/edit, and chat access UI

1. Build favorites, recent threads, bounded search, edit/reorder/archive/delete, loading/empty/error/offline states, and adaptive iPad split navigation.
2. Build the contact-like Bot profile.
3. Build the guided nontechnical editor and semantic avatar designer.
4. Build safe AI/Files/Connections/Skills pickers from Mac-projected catalogs.
5. Add the per-chat subset sheet and effective-access summary to the shared chat surface.
6. Hide every workspace-only/Git/Terminal affordance in the Bot presentation without duplicating the chat engine.

Acceptance:

- all state inventory in this plan is exercised with behavioral Swift tests, not only source regexes;
- VoiceOver, Dynamic Type, keyboard/pointer, reduced motion/transparency, light/dark, and all Aiden presets pass;
- the person can complete create → access review → conversation without seeing Pi, JSON, fingerprints, environment variables, or “system prompt” as a required concept.

### Phase 7 — Apple Image Playground and generated-avatar lifecycle

1. Add an iOS 18.1 availability-isolated wrapper around the current SwiftUI Image Playground sheet.
2. Prefill only visible identity/purpose, explicitly allow Apple's three non-personalized styles, disclose Apple-controlled generation, and support cancel/retry/unavailable/restricted/model-downloading/usage-limit states.
3. Normalize, preview, upload, cache, replace, and revert using the Phase 4 asset contract.
4. Keep the semantic avatar editor always available and never require Apple Intelligence to create a bot.
5. Update privacy/support/App Review copy so it describes the actual system behavior and paired-Mac upload.

Acceptance:

- supported physical Apple Intelligence hardware completes the system sheet → preview → authenticated paired-Mac save → relaunch/cache cycle;
- physical iPhone 13 Pro proves the unavailable fallback and no dead controls;
- cancel, refusal, offline-after-generation, oversize/corrupt result, upload ambiguity, replacement, and rollback are tested;
- no prompt, rejected candidate, temporary URL, image bytes, credential, or local path enters logs or ordinary Bot DTOs;
- source checks forbid `ImageCreator`, unrestricted `.all` styles, and accidental Photos-personalization enablement.

### Phase 8 — Desktop parity, onboarding, rollout, and release evidence

1. Add equivalent safe Access controls and generated-avatar display/revert to the existing Mac Bots editor.
2. Update Telegram to the same policy resolver and keep unsupported approvals blocked.
3. Update the concise iOS onboarding/coachmark so new users discover the logo switcher after pairing.
4. Update the desktop onboarding Bots tile and its dedicated optimized 1024 × 1024 transparent PNG; keep its asset contract test accurate.
5. Ship behind server capability negotiation and a mobile feature flag, then migrate in stages: internal test data, fresh profiles, reviewed legacy profiles, wider TestFlight.
6. Run full Mac/iOS suites, packaged listener tests, signed physical iPhone/iPad acceptance, multi-device/multi-Mac/revocation/offline/restart tests, privacy review, and App Store metadata checks.
7. Re-audit against the shipping iOS/Xcode 27 SDK before wider release because Apple's Image Playground processing and API surface are changing.

Acceptance:

- no P0/P1 security, data-loss, navigation, accessibility, or privacy findings remain;
- all existing Aiden On The Go Phase 12 gates are complete or explicitly owner-waived with recorded evidence;
- the release matrix covers supported and unsupported Image Playground hardware, iPhone, physical iPad/Stage Manager, Mac update/rollback, older paired clients, Telegram, and concurrent edits;
- onboarding advertises only shipped behavior and its required asset remains exact;
- App Review can create and use a Bot without Image Playground, and the “No data collected” declaration remains only if the final build still has no developer telemetry or relay.

## Likely implementation map

### Shared bot/runtime work

- `renderer/shared/bots.ts`
- new `renderer/shared/bot-capabilities.ts`
- `main/services/bot-store-core.ts`, `bot-store.ts`, `bot-mutation-gate.ts`
- new `main/services/bot-application-service.ts`
- new `main/services/bot-capability-store-core.ts`, `bot-capability-resolver.ts`, `bot-capability-bindings.ts`, `bot-capability-lease.ts`
- new `main/services/bot-avatar-asset-store-core.ts`
- `main/services/chat-store-core.ts`, `types.ts`, `visible-chat-projection.ts`
- `main/services/llm-client.ts`, `tools.ts`, `coding-tools.ts`, `mcp-selection.ts`, skill registry/tool/invocation paths, model runtime
- Telegram bot binding/turn/service paths
- `main/handlers/bot-params.ts`, `bots.ts`
- `renderer/lib/ipc.ts`, `queries.ts`
- `renderer/main/bots-view.tsx`, `bot-chat-route.tsx`, shared chat/composer presentation

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

- bot policy schema/store/corruption/future-version/crash recovery;
- capability intersection, revision, provider drift, exact MCP schema/effect drift, skill drift, and active lease invalidation;
- Files read/edit tiers, approvals, credential-family and `.git` denial, symlink/root replacement, and zero shell registration;
- regular-vs-bot remote Chat projection;
- remote Bot CRUD, grant checks, idempotency/revisions, inbox bounds/search, asset validation/content isolation, log redaction, multi-device revocation;
- Telegram surface ceiling and no policy bypass;
- renderer access controls and onboarding contract.

Register new files under `test:bots`, `test:aiden-remote`, `test:telegram`, `test:onboarding`, and the applicable full/coverage scripts in `package.json`.

### Swift

Add `AidenBotTests.swift` and extend:

- `AidenRemotePhase0Tests.swift` for shared fixtures/capabilities;
- `AidenRemoteClientTests.swift` for canonical routes, headers, errors, revisions, and idempotency;
- `AidenChatTests.swift` for `botId`, deep-link routing, streaming continuity, and per-chat subsets;
- `AidenNativeIntegrationTests.swift` for mode, menu, editor, availability, cache, accessibility, and source wiring.

Cover strict required-field decoding, tolerant additive fields, per-installation mode/cache, A → B → A stale response rejection, offline mutation disabling, compact/regular navigation, Dynamic Type layout, VoiceOver labels, generated-avatar state transitions, and temporary-file cleanup. Register new files in the Xcode project and update repository shipping-source policy tests that currently freeze the home logo and “New Agent” shell.

### Manual and physical evidence

- eligible Apple Intelligence iPhone or iPad: Image Playground success/cancel/refusal/network/model-download states;
- ineligible iPhone 13 Pro: fallback and no misleading promise;
- physical iPad: split view, Stage Manager, keyboard/pointer, rotation, large text;
- two paired devices and two saved Macs: grants, caches, favorites, edits, revocation, and stale responses;
- Mac restart/update/rollback, phone offline/reconnect, stream/approval recovery, and concurrent desktop/mobile edits;
- Telegram bound bot with selected and unselected capabilities;
- light/dark × Aiden/Slate/Berry/Moss × Reduce Motion/Transparency.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Attractive toggles lie about real authority | Build/enforce the main-owned policy before UI; test the effective tool list against the presented summary |
| “Files” still reaches shell or Git | Positive file-only builders, no `run_command`, `.git`/credential denial, no Bot Git/Terminal routes |
| Newly installed MCP tool or changed Skill appears silently | Exact opaque grants plus connection/schema/effect/content fingerprints; drift requires review |
| Existing paired device is silently widened | Local Mac approval/re-pair for `bot:*`; distinguish server support from device grant |
| Bot chats continue leaking into Workspaces | Fix `botId` projection and disjoint list semantics in Phase 1 before UI |
| Mobile UI becomes a separate runtime | Shared application services and existing Chat/SSE engine; no HTTP-to-IPC bridge |
| Inbox becomes slow or exposes history | One bounded paginated projection; only sanitized visible preview; no N+1 per bot |
| Generated image is oversized, malicious, or leaks a path | iOS preprocessing plus independent Mac decode/normalize, bounded canonical store, opaque authenticated content route |
| Apple processing is mislabeled | Say “Create with Apple Intelligence”; link/system disclosure; never promise universal offline/on-device behavior |
| Image Playground is unavailable | Semantic avatar editor remains complete and first-class |
| Old release removes new identity | Raster/policy companion stores; semantic fallback remains in rollback-compatible `bots.json` |
| Bot changes widen old chats | Per-chat positive snapshots; additions new-chat-only; removals revoke grant IDs immediately |

## Owner questions before implementation

1. **Apple processing:** Is “Apple's system Image Playground, including Private Cloud Compute on newer OS versions” acceptable, or is strict local-only generation a hard requirement? Strict local-only would mean keeping the semantic avatar designer and not promising generated raster avatars on iOS 27.
2. **Platform scope:** Should the complete Aiden-logo Workspaces/Bots switcher and Messages-style inbox ship on iPhone/iPad first as planned, or should the Mac desktop shell be redesigned in the same release too?
3. **Bot authority:** Should “no Git” block only Aiden's built-in terminal/Git features, or also block Git/shell-like tools exposed by an explicitly selected MCP connection? This plan recommends the stricter block.
4. **Workspace model:** Should each bot have one home workspace/folder by default, or may one bot start chats across many workspaces? One home workspace is simpler for nontechnical Files and workspace-scoped Skills; the plan can still offer “Choose another” per new chat.
5. **Chat overrides:** Is the recommended rule acceptable that a chat may only narrow its bot's Access, never turn on something the bot itself does not allow?
