# Bots rework: simple, durable, useful

- Status: Design approved in chat on 2026-10-07; awaiting written-spec review
- Surfaces: Electron desktop (main + renderer), Aiden On The Go iOS and Android, Telegram ingress
- Supersedes for Bots: the unwired Bot slice of `docs/plans/durable-jobs-leases-plan.md` (PR 2/3), and the "no pi-durable migration" exclusion in `docs/plans/pi-1.0.3-upgrade-plan.md` / `pi-1-parity-plan.md` (Bots only)

## 1. Intent

Owner's words: focus on Bots as single-thread chats on desktop and clients; there is too much chatter and non-useful UI; keep it simple yet customizable with options behind UI elements (progressive disclosure), like Grok Bots on mobile; simple enough for "my mom"; introduce Pi Durable sessions so a Bot picks up where it left off after a connection error or crash; make Bots actually useful by asking people to connect email, Notion, Composio and similar, with nice icons.

Success means:

1. A non-technical person can create or pick a Bot and chat with it without meeting provider, model, access, workspace, Telegram, or tool-activity concepts.
2. Every Bot has exactly one conversation on every client.
3. A turn interrupted by a crash, quit, or dropped connection is recoverable with one **Resume** tap, with no lost accepted input and no silently repeated side effects.
4. Bots proactively, and only with consent, suggest the connections they need.
5. Power settings remain reachable behind ••• → Advanced.

Constraints and owner decisions:

- Aiden is pre-1.0: **no migrations**. Existing extra Bot conversations and existing Bot transcripts are deleted, not migrated.
- **Pi Durable owns Bot session durability** (`@earendil-works/pi-durable`). Pi maintains it; Aiden borrows its OSS code where a gap needs filling rather than reimplementing it.
- Recovery is **explicit**: a Resume button, not automatic restart.
- **Delete** replaces Archive and must clearly warn what is erased.
- **Telegram binding** moves to Advanced.
- Repo rules from `AGENTS.md` apply: design-guide squircle actions, semantic tokens, no decorative borders, no brain icons, behavioral tests, exact pi pins, the Remote protocol revision is claimed at merge time, and native clients are updated together.

## 2. Evidence summary

- **Grok Bots references** (`~/Downloads/grokbots-screenshits`): an identity-first list; a chat with a name pill and •••; a profile with Character (colour plus shape), Instructions, and Routines; A–E quick-reply cards; file chips; a long-press sheet; and a "Meet Your First Bot" carousel.
- **Aiden today**:
  - Mobile already enforces one chat per Bot.
  - Desktop still shows a Conversations list with "New conversation" (`renderer/main/bots-view.tsx:1275-1337`), even though the backend always returns the canonical chat (`bot-application-service.ts:977-1000`).
  - iOS has three access layers: a global notice wall, Bot Full/Custom, and per-chat overrides.
  - There are four avatar systems, not one.
  - `ask_user_question` is disabled for Bots (`main/services/ask-user-question-extension.ts:60`) and capped at 4 options.
  - Schedules have no `botId`.
  - There are no starter Bots.
  - About 6k lines of Bot UI code are already dead (iOS/Android prototypes, Android Custom Access, Android chat tools, Android Image Studio placeholder, multi-chat delete helpers).
- **pi-durable spike** (throwaway, real SIGKILLs against `pi-durable@1.0.3` with the faux provider):
  - A mid-stream kill keeps the partial as `stopReason:"aborted"`, then makes a fresh provider request.
  - A tool without `replay:"safe"` returns "interrupted, may have partially run"; a safe tool reruns.
  - A pending async `beforeTool` approval is re-asked.
  - A duplicate `requestId` deduplicates.
  - A watcher that reattaches receives a full snapshot.
  - **Two processes on one database double-billed a turn**, because there is no cross-process lock.
  - 1.0.3 matches Aiden's pi-ai/pi-agent-core 1.0.3 pins and adds `@earendil-works/chord@1.0.3`.
  - The package is labelled experimental, and breaking changes ship in patch releases.
- **Hermes Bot Mode** (`~/projects/opp/hermes-agent`): resolve the Bot chat by Bot identity, not by a stored "latest session" pointer; no per-Bot session browser; send the self-intro only on genuine creation; label ambiguous redeliveries instead of resending silently; `[SILENT]` routine runs; routines from templates and slots; frequency-first schedule picker.
- **Rakazo** (`~/projects/opp/rakazo`): `Thread.botId` unique; avatar as colour plus mascot shape; onboarding auto-creates "Chief" and asks "What do you want me on first?"; typed `choice` / `ask` / `app_connect` / `file` message blocks; calm transcript with tool activity hidden; `NO_RESPONSE` silent routine replies.

## 3. Product model

A **Bot** consists of:

- name
- subtitle (one line)
- character: a colour and a shape, plus an optional photo
- instructions
- routines
- exactly one conversation
- a hidden managed home workspace (unchanged from today)

Everything else, such as model, image model, access, opening greeting and Telegram, is **Advanced**.

Removed concepts:

- multiple conversations per Bot
- per-chat access overrides
- Favorites and pinning
- Archive
- eye and detail avatar axes
- the LLM "design a face" generator
- the Full Access notice wall
- the "Set Up Image Understanding" alert

### Defaults

- **Model:** the first available configured model. **Image model:** the native model if it supports vision, else the first available vision companion. If no model is configured, the Bot shows one "Needs an AI model" state that links to provider setup.
- **Access:** Full by default, stated in one line in the create flow and in Advanced. The OS permissions, existing approvals and global safety rules that Full Access already respects are unchanged.

## 4. Screens (desktop, iOS, Android share one map)

### 4.1 Bot list

- **Header:** title "Bots", plus search and + in the top right. Desktop reuses the sidebar "Bots" entry.
- **Rows:** avatar with a small activity dot while working; name; subtitle pill; last-message preview; relative time. If the Bot is interrupted, the row shows "Paused — tap to resume".
- **Tapping a row** opens the Bot's chat directly, never a detail page.
- **Long-press or context menu:** Profile, Delete.
- **Bots from a paired Mac** appear as ordinary rows with a small Mac badge (desktop multi-host and mobile).
- **Removed:** Favorites carousel and ordering, the compose "Choose a Bot" chooser and bottom dock, Archived group, host section headers, cache-warning copy. One offline banner remains.

### 4.2 First run: "Meet Your First Bot"

- Shown when the person has no Bots: on desktop as a Bots-page empty state and onboarding step, on mobile as the Bots home empty state.
- A carousel of 3–5 starter Bots defined in a shared `renderer/shared/bot-presets.ts` and served over Remote so the phones match. Each preset has name, subtitle, character, instructions, suggested connections, and an optional suggested routine. Examples: Chief of Staff, Meal Planner, Inbox Helper, Researcher.
- Two actions:
  - **Start Chat** creates the preset idempotently (keyed `preset:<id>`) and opens its chat.
  - **Create My Own** opens the create flow.
- The bento feature tile copy is updated, with a new 1024×1024 PNG asset for Bots per the onboarding asset contract.

### 4.3 Create flow (two short steps)

1. **Name** and **"What should it help with?"** The answer becomes the subtitle and seeds the instructions. Character is auto-assigned and can be changed later.
2. **Suggested connections** as icon chips: Email, Calendar, Notion, Composio "500+ apps", and so on, ranked from the answer and preset. Each chip is optional; **Skip** is one tap.

On create, the Bot posts a one-time **self-intro**: a hidden-prompt turn, no tools, stating its understood role and asking what it needs first, with A–E quick replies. This happens only on genuine creation, never on reopen.

### 4.4 Chat

- **Header:**
  - back;
  - a pill with a small avatar and the name, which opens the Profile;
  - ••• with Profile, Files, Delete.
- **Body:**
  - plain bubbles;
  - inline **file chips** that open the existing file viewer;
  - **A–E quick-reply cards** (`ask_user_question` enabled for Bots, max options raised to 5);
  - **connect cards** (§7).
- **Tool activity:** one collapsible "Working…" / "Updates" line. Desktop ports the mobile `AidenBotReplyProjection` behaviour.
- **Long-press:** Copy, Reply (quote into the composer). Reactions are out of scope.
- **Desktop Bot chat mode** hides workspace, git, permission, model and thinking pickers; fork, side questions, export, rename; and the review and environment panels. The composer keeps attachments, voice, Stop, and busy Steer/Queue.
- **Interrupted state:** an inline card reading "I got interrupted while working on this." with **Resume** and **Dismiss** (§6.4).

### 4.5 Profile

Profile replaces the desktop detail page and `BotEditor` wizard, iOS `AidenBotProfileView` plus `AidenBotEditorView` plus `AidenBotCustomAccessFlowView`, and Android profile plus editor. It contains:

- A big avatar with ••• for Choose photo / Generate (iOS Image Playground only) / Remove photo.
- Inline **name** and **subtitle** fields.
- **Character:** 12 colour swatches (extend the palette to match the Grok range using semantic tokens), 8 shapes (existing recipe shapes), and **Reset to default**.
- An **Instructions** row that opens a full-screen editor with **Save**.
- **Routines:** a list plus **+ Add routine** (§8).
- ••• with **Advanced** and **Delete Bot**.

### 4.6 Advanced (one page)

- AI model and image model (auto by default, with a "Use recommended" reset)
- What it can use: Full or Custom (the existing capability sections, kept once)
- Opening greeting
- Telegram binding (desktop only; moved from the Bot page)

### 4.7 Delete

The confirmation reads: "Delete {name}? This permanently erases {name}'s chat, memory, instructions, routines, files, and photo. This can't be undone." The action button is "Delete Bot" (destructive style).

Delete removes:

- the Bot record
- its harness directory `bots/<id>/` (closed first): its durable conversation and entries
- its routines
- its managed home workspace
- its canonical photo
- its Telegram binding
- any unread or summary rows

## 5. Avatar consolidation

- Keep the recipe as **colour plus shape**, with one fixed eye mark. Keep the optional canonical photo overlay.
- Delete:
  - the eye and detail axes;
  - legacy string avatar ids;
  - `bot-avatar-generator-core.ts` and the `bots:suggestAvatar` / `cancelAvatarSuggestion` IPC;
  - `BotFaceStudio` tabs, which are replaced by the Character card.
- Android: delete the fake Image Studio. A Gallery photo picker feeding the existing upload lifecycle is the only photo source on Android.

## 6. Durable Bot sessions on Pi Durable

### 6.1 Runtime ownership

- Main hosts **one Pi Durable `Harness` per Bot**:
  - storage: `openNodeSqliteStorage(<profile>/bots/<botId>/session.sqlite)`;
  - opened lazily on first use (chat open, inbound Telegram, routine fire, or an interrupted-task scan at startup) after provider and MCP inventory is ready;
  - closed after 10 idle minutes with no live task, and on quit.

  A harness per Bot makes `resume()`, `inspect()` and deletion naturally per Bot, with no cross-Bot scheduling coupling.
- An **exclusive profile lock file** (`bots/runtime.lock`, holding pid and process start time, acquired with `O_EXCL` and validated against a live process) must be held before opening. If the lock is held by a live process, Bots are unavailable with a clear error. The CLI (`packages/cli`) never imports or opens the Bot runtime.
- Dependencies:
  - Pin `@earendil-works/pi-durable` and `@earendil-works/chord` exactly at `1.0.3`, matching the pi-ai pin.
  - The existing `@aiden/pi-legacy-harness` keeps its own chord 0.87.1 copy.
  - Upgrades go through a replay evaluation, as the CLI pin rule already requires.
- New module: `main/services/bot-runtime/`:
  - `harness-host.ts`: profile lock, per-Bot open/idle-close, inspect;
  - `bot-extension.ts`;
  - `tool-adapter.ts`;
  - `live-projection.ts`.

### 6.2 One conversation per Bot

- The Bot's conversation is its harness's **root conversation** (`harness.root(ctx, { agent })`). This creates the conversation on first use and returns the same one after every reopen. Identity is the storage path derived from `botId`, so no conversation pointer is stored and no second conversation can be created (the Hermes lesson).
- Crash-safe create order:
  1. commit the Bot record;
  2. open the harness and create the root conversation.

  A `bots/<id>/` directory found at startup with no Bot record is deleted.
- Bot chat identity on the wire stays `chatId`. A Bot's `chatId` maps 1:1 to its conversation. `ChatStore` keeps only a projection for lists and summaries: title, preview, `updatedAt`, unread.
- `/new` in a Bot chat compacts (`conv.compact()`) rather than forking.

### 6.3 The `aiden-bot` extension

The extension is registered on every harness open, before any `resume()`. Pending tasks only continue once it is installed.

| Today | Pi Durable home |
| --- | --- |
| Base system prompt, Bot persona, `<bot_workspace>`, MCP server instructions, memory facts, skills list | `sections` (order: base, then persona, then authority; existing escaping preserved). Content is stable per turn to keep prompt caching. |
| Exact provider/model binding | conversation `configure()` plus a `beforeRequest` assertion |
| Coding tools, file tools, Bot file router, schedules, web, subagents as allowed | `defineTool` via `tool-adapter.ts` (TypeBox schemas reused, `AbortSignal` mapped to the chord context, `onUpdate` mapped to `api.output`). `replay:"safe"` only for read-only or idempotent tools. |
| MCP tools | rebuilt from current inventory on each open; never replay-safe |
| Companion vision `inspect_image` | replay-safe tool; attachment snapshots are stored as conversation entries, not closures |
| Full/Custom access, `protectAdmittedBotTool`, admission lease | `beforeTool` checks the current policy at every tool call; `beforeRequest` re-admits on resume and fails closed if the policy changed |
| Tool approvals | async `beforeTool`. The pending approval is persisted as a task memo `{waitId, toolCallId, summary}`. Desktop IPC and Remote approval routes resolve by `waitId`. After restart the approval is re-asked. |
| Steer / Queue (`chat-run-input-v1`) | `submit({whenBusy:"steer"\|"followUp"})` |
| Compaction | Pi Durable built-in compaction. Aiden's VCC path is not used for Bots. |

Gaps in 1.0.3 are filled by borrowing Pi Durable OSS code into the extension or adapter, never by forking the package. Any gap needing a package change is reported upstream.

### 6.4 Recovery: explicit Resume

- At startup the host opens each Bot harness that has a `session.sqlite` and checks `harness.inspect()` for unfinished tasks. Bots with unfinished work stay open but are **not** resumed: Aiden never calls `harness.resume()` automatically, and never submits to an interrupted conversation without user intent. The scheduler starts on resume, submit or wait, so the host must call none of these.
- Each interrupted Bot is projected as `interrupted`. The chat shows the interrupted card and the list row shows "Paused".
  - **Resume** re-admits Bot authority. If that fails, the card explains "This Bot's access changed. Review it in Advanced." Otherwise it calls `harness.resume()` on that Bot's harness and reacquires the submission with `harness.submission(id)` for status. Pi Durable semantics then apply: the aborted partial is kept, a fresh provider request is made, an unsafe tool becomes an interrupted error result, a safe tool reruns, and a pending approval is re-asked.
  - **Dismiss** calls `submission.abort()` on the reacquired submission. The partial stays in the transcript as interrupted.
  - Sending a new message while interrupted performs Dismiss first, then submits.
- P1 verifies with SIGKILL tests that a submission reacquired after restart can be aborted without first resuming the scheduler. If it cannot, Dismiss resumes and immediately aborts with a pre-armed abort before any provider request, and the test records the observed behaviour in `.memory/`.
- Every ingress passes a stable `requestId`, so resubmits dedupe:

  | Source | `requestId` |
  | --- | --- |
  | Desktop send | renderer send UUID |
  | Remote | the existing Idempotency-Key / request UUID |
  | Telegram | `tg:<bot>:<chat>:<thread>:<message>` |
  | Routine | `routine:<taskId>:<scheduledFireTime>` |

### 6.5 Live view and clients

- **Desktop:** `live-projection.ts` runs `conv.watch(ctx)` and publishes a bounded IPC stream (entries plus `pi.live` partial) to any renderer window. A renderer reload re-attaches and gets a full snapshot. This replaces Bot use of the current per-owner delta path.
- **Remote:** a new revision (claim the next number after `main`'s at merge; currently expected 25) is added:
  - Bot chat snapshot carries the entry window plus the in-flight partial text and an `interrupted` flag;
  - stream events are derived from watch diffs and carry a `(epoch, seq)` pair, where `epoch` changes when the harness reopens;
  - two new routes, `POST /bots/{botId}/resume` and `POST /bots/{botId}/dismiss`, are idempotent per request UUID.

  iOS and Android update DTOs, strict parsers, and fixtures together. Older clients keep stream Stop and plain message history.
- **Telegram:** ingress submits with its `requestId`. The offset advances only after the harness accepts the submission. A reply **outbox** row (`pending → sent`) gates delivery, so a crash after generation redelivers the persisted reply instead of regenerating it. A send that was cut off mid-way is redelivered prefixed "(may be a duplicate)".

### 6.6 Retired for Bots

- The Bot run path through `PiAgentRuntimeHarness` / ChatStore turn persistence / Pi JSONL journals.
- The unwired durable-jobs ledger as a Bot owner. The ledger module stays for workspace chats until its own plan decides.
- The per-chat capability route `/chats/:chatId/capabilities` for Bots.
- `/bot-favorites`.
- Archive and restore routes, which become `DELETE /bots/:botId` with the erase semantics above.

## 7. Connections

- **Catalog:** reuse `renderer/shared/plugin-catalog.ts` entries (Composio, Gmail, Google Calendar, Notion, Slack, Outlook, and others) and `mcp-preset-icons.tsx` icon paths. A shared `connectionSuggestionFor(pluginId)` gives the icon, a display name, and the setup entry point.
- **Create flow:** chips are ranked from the "What should it help with?" text and the preset. A chip opens the existing preset setup (`mcp-preset-setup.tsx`) inline. When finished, the connection is added to the Bot's allowed connections (Full Access already includes it).
- **In chat:** a new Bot-only tool, `suggest_connection({ pluginId, reason })`, appends a typed **connect card** entry:
  - icon, "Connect {name}", the reason, and a **Connect** button;
  - after setup, the card updates to "Connected ✓";
  - **Not now** dismisses it, and the Bot is not offered that plugin again for that Bot (stored per Bot, by `pluginId`);
  - at most one pending card per plugin;
  - the tool is unavailable for already-connected plugins.
- **Mobile:** credentials stay on the Mac. The card's button reads **Finish on your Mac**. It posts `POST /bots/{botId}/connection-requests` (idempotent), and the Mac shows a notification that opens the setup flow focused on that plugin. The card updates through the normal stream.
- **Icons:** existing preset SVG paths render inside the shared squircle tile, on a neutral fill, with no coloured borders.

## 8. Routines per Bot

- `ScheduledTask` gains an optional `botId`. A Bot routine targets the Bot's conversation, not a workspace chat.
- **Create:**
  - From the Profile: **+ Add routine** opens a name field, a frequency-first schedule picker (Once / Every day / Weekdays / Weekly with days / Monthly; time picker; timezone defaults to local) and a "What should it do?" message. Raw cron is never shown.
  - From chat: the Bot's existing schedule tool creates routines bound to the current Bot. A routine run cannot create routines.
- **Run:** the routine submits `{ type: "input" }` with `requestId = routine:<taskId>:<fireTime>`. Results appear in the Bot's chat as a labelled turn ("Weekly meal prep") the person can reply to.
- **Silence:** routine instructions include "If there is nothing new, reply exactly [SILENT]". A final reply of `[SILENT]` is kept for audit, but no bubble, notification, or unread state is produced. Failures always surface.
- **Rows** show the friendly label, e.g. "Every Sunday at 8:41 AM". Deleting a Bot deletes its routines.

## 9. Code removal (pre-1.0, no compatibility)

| Area | Removed |
| --- | --- |
| Dead code | iOS `Prototype/BotFirstPrototype.swift`, its snapshot test and app wiring; Android `prototype/BotFirstPrototype.kt`, `AidenBotCustomAccessFlowScreen.kt`, `features/remote/AidenBotChatToolsView.kt` (+ androidTest), `AidenBotImagePlaygroundView.kt`; multi-chat delete helpers on both platforms |
| Desktop | Conversations section, `startConversation`, `useBotChats` list UI, `BotEditor` wizard, `BotAccessSummary`, `BotFaceStudio` tabs, avatar generator, Telegram UI on the Bot page (moved), archive UI |
| iOS | Favorites, compose chooser, profile Chat card, editor access/AI sections (moved to Advanced), duplicate Custom Access flow, per-chat access sheet, Full Access notice wall, "Set Up Image Understanding" alert |
| Android | Favorites, FAB chooser, Recent Chats, editor access sections (moved), eye/accessory pickers |
| Contract fixtures | test fixtures move out of production model files (`AidenBot.swift` 1661-1831) into test targets |

The estimated net removal is about 9–10k production lines.

## 10. Error handling

| Situation | Behaviour |
| --- | --- |
| Lock held by a live process | Bots page: "Bots are open in another Aiden window." No writes happen. |
| Harness open fails (corrupt DB) | Move that Bot's file aside as `.corrupt-<ts>`, start a fresh conversation for that Bot only, and show a one-time notice in its chat. Pre-1.0, no repair attempt. |
| Missing model | Bot row and chat show "Needs an AI model" with a Set up button. |
| Resume authority failure | Interrupted card says the access changed, with an Advanced link. Nothing runs. |
| Provider error mid-turn | Pi Durable retry policy, then a typed failure bubble with a Retry action (new submission, new `requestId`). |
| Remote disconnect | The client reconnects; a snapshot carries the partial; a new `epoch` triggers a refetch. |
| Ambiguous Telegram send | Redelivered once, labelled "(may be a duplicate)". |

## 11. Testing

- **Runtime:** Node tests use pi-ai's faux provider and real child-process SIGKILL (as in the spike):
  - kill mid-stream, then Resume (aborted partial plus fresh reply);
  - unsafe and safe tool interruption;
  - approval re-ask after kill;
  - Dismiss;
  - requestId dedupe across restart;
  - lock contention (a second process refused);
  - orphan Bot directory cleanup;
  - root conversation stable across reopen;
  - idle close and reopen mid-conversation;
  - policy drift fails closed on Resume.

  These are registered in a new `test:bot-runtime` script and added to the root `test` chain (union on conflict).
- **Extension:** register-and-invoke tests for sections order, the tool adapter, and the `beforeTool` policy/approval paths. No source-grep tests.
- **Desktop UI:** Testing Library tests for the list (row tap opens chat), Bot chat mode hiding, the Profile (character reset, instructions save), the delete confirmation copy and effects, and connect card states. Playwright e2e covers create preset, then Start Chat, then quick reply.
- **Remote contract:** shared TS/Swift/Kotlin fixtures for the new revision (snapshot partial, interrupted, resume/dismiss, connection-request). iOS XCTest and Android JUnit suites run.
- **Routines:** service tests for Bot-targeted fire, `[SILENT]` suppression, and dedupe of a duplicate fire time.
- **Onboarding:** the asset contract test covers the new Bots tile PNG.
- Existing tests for deleted surfaces are removed, not rewritten.

## 12. Phasing

Each phase gets its own implementation plan and PRs; independent phases run in parallel subagent worktrees.

1. **P1 Durable Bot runtime (critical path).**
   - harness host and lock;
   - extension;
   - tool adapter;
   - desktop live projection;
   - explicit Resume/Dismiss IPC;
   - Telegram requestId and outbox;
   - delete erase semantics.

   Bot chats switch to Pi Durable and existing Bot transcripts are wiped.
2. **P2 Desktop Bot UI.** List, chat mode, Profile, Advanced, Delete, avatar consolidation, quick replies enabled for Bots. Can start before P1 lands against the current chat runtime, then swaps to the live projection.
3. **P3 iOS + Android.** Same screens, dead-code removal, Gallery picker on Android. P3a (UI and deletions) runs in parallel with P1. P3b (new Remote revision: partial snapshot, Resume/Dismiss) follows P1.
4. **P4 Routines per Bot.** Data model, scheduler targeting, Profile UI on three clients, `[SILENT]`.
5. **P5 Connections and onboarding.** `suggest_connection`, connect cards, mobile connection requests, create-flow chips, presets, "Meet Your First Bot", self-intro, bento tile and asset.

Docs to update as phases land:

- `docs/plans/README.md` (new plan entries; mark the durable-jobs Bot slice superseded)
- `pi-1.0.3-upgrade-plan.md` exclusion note
- `bot-first-aiden-on-the-go-plan.md` (Favorites/Archive/per-chat access removed)
- `.memory/` entries per phase

## 13. Out of scope

- Reactions
- Message threads
- Bot-to-Bot chat and group rooms
- Phone-side OAuth
- Moving workspace chats to Pi Durable
- Automatic resume
- Personality presets beyond starter Bots
- Mac shell redesign outside Bots
