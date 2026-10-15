# Bot chat activity, Bots sidebar and side panel

- Status: Design draft, 2026-10-14. Awaiting owner review.
- Branch: `claude/bot-creation-flow-model-selector-6a5d3a`.
- Surfaces: Electron main and renderer, Aiden On The Go iOS and Android, the Aiden Remote contract.
- Builds on: [Bots rework design](2026-10-07-bots-rework-design.md) and [Bot memory, soul and proactivity](2026-10-09-bot-memory-soul-proactivity-design.md).
- Mockups (open in a browser): [`2026-10-14-bot-chat-activity/bot-chat-states.html`](2026-10-14-bot-chat-activity/bot-chat-states.html) (every chat state, the status words, the Chat activity page, sidebar, panel and menu) and [`2026-10-14-bot-chat-activity/bot-creation-flow.html`](2026-10-14-bot-chat-activity/bot-creation-flow.html) (New Bot with a model picker, desktop and iPhone).
- References (behaviour only, no source copied): [CopilotKit/openbot](https://github.com/CopilotKit/openbot) `app/src/components/channels/tool-line.tsx`, `browser-activity.tsx`, `lib/copilot/stopped-turn.ts`; [elie222/rakazo](https://github.com/elie222/rakazo) `apps/web/src/components/ToolActivityDisclosure.tsx`, `lib/tool-activity-preference.ts`, `components/ai/CollaborationMarker.tsx`.

## 1. Intent

A Bot chat should feel like messaging a person who is busy on your behalf, not watching a terminal. While a Bot works, the person sees one calm, animated line that says what kind of thing is happening ("Thinking", "Searching the web", "Editing files"). People who want more can choose it, by seeing what each option looks like. Everything the Bot did is still one click away, in a side panel, never in the transcript by default.

Alongside this, Bots get their own sidebar on the Bots page, a side panel for their files and other non-chat surfaces, Advanced in every ••• menu, and a model choice when they are created.

Success means:

1. Between sending and the first word of the reply, every client shows the Bot is working. Today phones show nothing.
2. With the default settings, a Bot chat shows no tool rows, commands, file paths or reasoning text. It shows only the status line, the reply, and the things that need the person or change the outcome.
3. A person can choose Quiet, Summary or Detailed, and the status line's wording, from previews that show what each choice looks like.
4. Phones show the same status words and never show steps, paths, commands or search terms.
5. Every step a Bot took can still be inspected on the Mac, in the side panel's Activity tab.

## 2. Decisions

These are the owner's decisions from 2026-10-14.

| # | Decision |
|---|---|
| 1 | Quiet is a single status line: an activity mark plus a word. No tool rows. |
| 2 | Each Bot has a **Chat activity** sub-page in Advanced. It has two choices, each shown with a live preview. **How much to show:** Quiet (default), Summary or Detailed. **What the status line says:** Follows the work (default) or Always "Thinking". |
| 3 | Phones are always minimal. They show the status line with the same words at every level, and never steps, recaps or the hover peek. |
| 4 | The status vocabulary is shared by the Mac and phones and is larger than "thinking/working" (§5). |
| 5 | On the Bots page, the left sidebar shows only Bots (pinned Bot, Bot rows, Connect apps). It is modelled on the owner's reference screenshot. |
| 6 | Bot files move out of the modal into a side panel built on the environment panel's shell. The panel also holds Activity, Memory and Routines. |
| 7 | Advanced appears in every Bot ••• menu. |
| 8 | New Bot includes a model choice on desktop, iOS and Android. It lists the models Aiden already has set up and defaults to today's recommendation. |
| 9 | The Bot's own progress messages ("On it, I'll dig into…") are always bubbles, at every level. |
| 10 | New Bots default to Quiet and Follows the work. The featured Bot at the top of the sidebar is one the person pins. The setting covers Bots only; workspace chats may adopt it later. |
| 11 | Input sent while a Bot is working offers both **Steer** (join the running turn) and **Queue** (send when it finishes), on the Mac and on phones. |
| 12 | The side panel's shell is extracted in its own PR (C1), and the Bot panel and sidebar are a PR stacked on it (C2). |
| 13 | Tool categories are fixed against the real Bot tool set (§5.1). Bots have no browser or image-generation tool, so those phases are dropped and **Using your Mac** is added for Computer Use. |

## 3. Evidence

### Aiden today (verified 2026-10-14)

- **Desktop Bot chat** (`renderer/main/bots/bot-transcript-rows.ts`, `bot-chat-pane.tsx`, `bot-updates.tsx`):
  - Each reply gets one collapsed `BotUpdates` line ("Working…" while running, then "Updates").
  - It holds only the Bot's narration. `timeline` is hard-coded to `null`, so the `ActivityFeed` slot is never used.
  - `tool_result` rows are dropped.
- **Desktop projection** (`main/services/bot-runtime/live-projection.ts`) strips detail before the renderer sees it:
  - `BotTranscriptToolCall` is `{id, name}` (arguments mapped away).
  - `tool_result` keeps `toolCallId`, `toolName` and `isError`.
  - `textOf` drops thinking parts, and `livePartialText` reads only text.
  - `pi.live` does carry the in-flight generation content and the active tool slots (`pi.live.tools`), so a live phase can be derived there.
- **Remote** (`main/services/aiden-remote-bot-session.ts`):
  - The comment says "tool traffic stays on the Mac". Tool-only steps are dropped, and only `partial {text}` streams.
  - Session states are `idle | running | interrupted | needs_model | unavailable`. There is no activity state.
  - The contract is at revision 29 on this branch.
- **iOS and Android Bot chats** (`AidenBotSessionChatView.swift`, `AidenBotSessionScreen.kt`):
  - Nothing renders between sending and the first streamed text. The only running signal is Stop.
  - Both platforms already draw the activity marks natively (`Features/Shared/ActivityMarks/`, `features/shared/activitymarks/`), and normal chats map phases to marks (`AidenActivityMarkMapping.swift`).
- **Activity marks** (`renderer/components/aiden-activity-mark.tsx`, `docs/activity-marks.md`):
  - `tri-step`, `quad-shuffle`, `compose`, `scan-grid`, `glance` and `bounce` are inline SVG with transform/opacity keyframes.
  - They freeze on the t=0 pose under Reduce Motion and when off-screen.
- **Environment panel** (`renderer/components/environment-panel.tsx`, about 2,100 lines):
  - `EnvironmentWorkbench` wraps every route, including `/bots/*`.
  - Its tabs are tightly coupled to the workspace and the active chat.
  - (was) Bots use `bot-files-dialog.tsx` instead. C2 replaced it with the Bot panel's Files tab.
- **Sidebar:** `renderer/components/chat-sidebar.tsx` and `sidebar-primary-nav.tsx`. (was) Bots are one nav item, and no Bot rows appear in the sidebar. C2 gives Bots pages their own sidebar.
- **••• menus:**
  - Chat header: Profile, Files, Delete Bot.
  - List rows: Profile, Delete Bot.
- **Advanced model select bug** (owner screenshot):
  - `bot-advanced.tsx` puts "· Reads images" inside each `SelectItem`. Radix copies it into the trigger.
  - Radix drops `SelectValue`'s `truncate` class.
  - `.settings-page .settings-field-control > .flex { flex-wrap: wrap }` (`renderer/styles.css`) lets the trigger wrap, so the chevron drops to a second line.
- **Telegram** already has a per-binding `activity: quiet | thinking | tools | verbose` setting (`renderer/lib/types.ts`). It is left as is (§13).

### What we take from the references

- **openbot:**
  - One line primitive per action, past-tense label plus a muted detail, collapsed by default.
  - "Blocked: …" is visually distinct from "…, didn't work".
  - Repeated page visits merge into "Browsed N pages".
  - Shimmer is the only "running" signal, disabled under reduced motion.
  - A stopped turn is a status line, not a transcript row the model reads back.
  - Queued messages are faded real bubbles.
- **rakazo:**
  - A turn-level disclosure: "Working… · N tools" opens while live, then auto-folds to "Done · N tools · 4.2s".
  - The live list is windowed.
  - The Bot's own avatar is the "working" indicator.
- **Not taken:**
  - Rakazo hides activity entirely by default, in a per-device localStorage switch. Here the setting is per Bot and synced, and the full log stays available.
  - Rakazo's unguarded pulse animations.

## 4. Slices

Each slice ships on its own, in this order.

| Slice | Scope | Contract change |
|---|---|---|
| A · Quick fixes | Advanced in every ••• menu. Model choice in New Bot (desktop, iOS, Android). Advanced's model control fixed (§10). | None |
| B · Status line and Chat activity (desktop) | Phase projection, `BotStatusLine`, Summary/Detailed folds, the Chat activity sub-page and its stored setting, progress bubbles, queued messages. | Desktop IPC only |
| C1 · Workbench shell (desktop, preparatory PR) | Extract `WorkbenchPanel` (open state, width, resize, tab strip, toggle shortcut) from `environment-panel.tsx`. Workspace behaviour is unchanged. | None |
| C2 · Bots sidebar and side panel (desktop, stacked on C1) | The Bots-only sidebar, the Bot side panel (Activity, Files, Memory, Routines), the panel toggle. The Files dialog is removed. | Desktop IPC only |
| D · Phones | Phase in the Remote session stream, the Chat activity page on iOS and Android, status line, face animation, Steer/Queue. | Remote revision 30, token `bot-activity-v1` |

## 5. Status words (phases)

A Bot in a running turn is always in exactly one phase. The Mac and phones use the same ids, words and marks.

| Phase id | Word | Mark | Entered when |
|---|---|---|---|
| `preparing` | Getting ready | bounce | The person's input was accepted and the model has not produced anything yet |
| `thinking` | Thinking | tri-step | The model is generating with no text and no tool call (including reasoning) |
| `reading` | Reading | scan-grid | A file read or listing tool is active |
| `photo` | Looking at your photo | scan-grid | An attached image is being described by the image (vision) model |
| `searching` | Searching the web | scan-grid | A web search tool is active |
| `command` | Running a command | quad-shuffle | A shell or script tool is active |
| `editing` | Editing files | quad-shuffle | A file write or edit tool is active |
| `app` | Using {app} | quad-shuffle | A connection (MCP or Composio) tool is active. `{app}` is the connection's display label. |
| `helper` | Asking a helper | quad-shuffle | A subagent or delegation tool is active |
| `computer` | Using your Mac | quad-shuffle | Computer Use or Form Fill is active |
| `remembering` | Remembering | compose | `bot_memory` is active |
| `routine` | Setting up a routine | tri-step | The routines tool is active |
| `working` | Working | quad-shuffle | Any other tool, and the fallback for an unknown phase |
| `writing` | Writing | compose | The reply's text has started but no visible words have been shown yet (e.g. heading for a quick-reply block) |
| `waiting` | Waiting for you | glance | An approval or an A–E question is open |
| `tidying` | Tidying up its notes | bounce | Compaction is running inside the turn |
| `stopping` | Stopping | bounce | The person pressed Stop and the run has not ended |
| `resuming` | Picking up where it left off | bounce | A Resume after an interruption, until the next phase |
| `reconnecting` | Reconnecting to your Mac | bounce | Phones only, client-side, while the session stream is down during a running turn |

### 5.1 Tool → phase (fixed against the Bot tool set)

| Tools (from `bot-tool-policy.ts`, `bot-file-tool-router.ts`) | Phase |
|---|---|
| `read_file`, `list_dir`, `glob`, `grep` | `reading` |
| `edit_file`, `write_file` | `editing` |
| `run_command` | `command` |
| `web_search` | `searching` |
| `computer_use`, `form_fill` | `computer` |
| `inspect_image` | `photo` |
| `subagent` | `helper` |
| `bot_memory` | `remembering` |
| `routines`, `routine_notes` | `routine` |
| An MCP or Composio tool from `facts.mcpTools()` | `app`, with the connection's label |
| `ask_user_question` (while its card is open), any approval wait | `waiting` |
| `share_image`, `suggest_connection`, skill tools, anything else | `working` |

When a new tool kind ships (a browser, image generation), it gets its own phase in the same table and on all three clients in one change.

### 5.2 Rules

- **Classifier.** A pure classifier maps an active tool to a phase by tool name and category: `(toolName, connection label?) → PhaseId`. It lives in `renderer/shared/bot-activity.ts` so main, the renderer and the CLI share it. It reuses the categories in `renderer/lib/agent-steps.ts`; categories needed by main move into the shared module. When several tools are active in parallel, the most recently started one wins.
- **Hidden while words stream.** While the reply's visible text is streaming, the status line is hidden. The text itself is the signal.
- **Always "Thinking".** With this wording, every phase except `waiting`, `stopping` and `reconnecting` shows `thinking`'s word and mark. Those three stay because they change what the person should do.
- **Unknown ids.** Clients render an unknown phase id as `working`, for forward compatibility.
- **Elapsed time.** After 20 seconds in a turn, the line adds the elapsed time ("· 1m 12s"), measured from `activity.startedAt`. After 2 minutes, a centred note adds "Still going. I'll message you when it's done." The finish already posts a notification through the existing paths.
- **No Stop on the line on phones.** On the Mac, the line shows Stop after 20 seconds as well. Phones keep Stop in the composer.

## 6. Desktop chat rendering

| Level | While working | After the reply |
|---|---|---|
| Quiet | The status line. Hovering or focusing it reveals the current step's short label ("· grocery-list.md"). No rows are added. | Nothing beyond the reply. |
| Summary | Same as Quiet. | One collapsed recap above the reply: "Worked for 18s · read 1 file, searched the web, edited 1 file, used Notion". It opens to the step trail. |
| Detailed | The status line plus the last three steps, the active one shimmering. | The same recap, open while live and auto-folded when the reply lands. A manual open or close during the run sticks. |

The recap is a Bot-specific fold (`renderer/main/bots/bot-activity-recap.tsx`). It reuses the activity feed's tone tokens, shimmer and row rhythm. Its wording comes from the shared step phrases in `renderer/shared/bot-activity.ts`, because `ActivityFeed` owns its own open state and `summarizeActivity` cannot name apps. Repeats merge: reading six files becomes "Read 6 files", and page visits become "Browsed 3 pages".

Shown at every level:

- Approvals, A–E questions, connect cards, needs-model.
- Produced files (chips that open the side panel's Files tab), images, "Memory updated", routine proposals.
- Failed-turn, interrupted and model-error cards.
- "You stopped this reply." as a centred line. It is not stored as a transcript row the model reads.

Problems:

- A failed step the Bot recovered from is hidden in Quiet. Summary and Detailed show a red "1 issue" on the recap and a red "Couldn't …" step.
- A step refused by the Bot's access shows as amber "Blocked: …". The server marks refusals (the existing approval and policy paths know when a call was denied), so refused and failed never look alike.

Other changes:

- **Progress bubbles.** Narration written alongside tool calls stops folding into `BotUpdates`. It renders as a normal assistant bubble, and `BotUpdates` is removed.
- **Steer and Queue.** The Bot runtime already takes `whenBusy: "steer" | "followUp"` (`bot-session-service.ts`, default `followUp`), and the desktop composer already wires `onSteer`/`onQueue`.
  - **Queue** shows the message as a faded user bubble marked "Queued" until its turn starts. It gets a Remove only if Pi Durable can withdraw one queued submission; otherwise there is no Remove (the plan confirms which).
  - **Steer** shows the message as a normal bubble right away, and the running turn continues with it. The status line stays.
- **Faces.**
  - `BotAvatar` gains `working`. The canonical face's eyes look left and right and blink, using the `glance` keyframes, while its Bot is in a running turn.
  - It is used in the sidebar row, the chat header pill and the Bot list.
  - Photo avatars get a small activity-mark badge instead.
  - Reduce Motion freezes both.

### Projection changes (main)

- **Live activity.** `BotLiveSnapshot` gains `activity: { phase, app?, startedAt, step?: { kind, label, detail? } } | null`, with a matching `activity` live event.
  - The phase and step come from `pi.live` (the generation content and the active `tools`), plus question, approval and stop state.
  - `step.detail` is a short, safe summary built in main: a file's base name, the first 80 characters of a command, or a search query. It is bounded and redacted with the existing path/secret redaction.
- **Transcript tool calls** gain `kind`, `label` and `detail?`, built the same way.
- **Tool results** gain `status: ok | failed | blocked` and `durationMs`.
- **Thinking.** Thinking text is still never projected.

## 7. Chat activity setting

### Data

`BotDefinition` gains:

```ts
chatActivity?: { level: "quiet" | "summary" | "detailed"; wording: "follows" | "thinking" }
```

- Absent means `{ level: "quiet", wording: "follows" }`.
- It is normalised and validated in the Bot store like the other identity fields, and saved through the existing `bots:update` path with the Bot's revision.

### UI: Advanced → Chat activity

- A sub-page `?page=chat-activity` in `BotPageShell`, opened from a "Chat activity" row in Advanced. The row's trailing value reads e.g. "Quiet · Follows the work".
- **"How much to show":** three radio rows (Quiet *Recommended*, Summary, Detailed).
- **"What the status line says":** two radio rows (Follows the work, Always "Thinking").
- **Previews.** Every row carries a looping preview: a small chat replaying a short scripted turn rendered with the real components (`BotStatusLine`, the recap fold).
  - Previews use the current wording when showing levels, and Quiet when showing wordings.
  - They pause off-screen.
  - Under Reduce Motion they show a still frame with a "Play" control.
- **Phones note.** A third group says "On iPhone and Android: always just the line", with its own preview.
- **Saving.** Each choice saves when picked, like Profile. There is no Save button on this page.
- **Styling.** Radio rows follow the settings design system: no borders around choice cards, selection shown with the radio and background state, `focus-visible` rings kept.

## 8. Bot side panel

- **Shell.** The Bot panel reuses the environment panel's shell: the open state, width, resize, tab strip, and the `environment.toggle` shortcut.
  - The shell is extracted from `environment-panel.tsx` into a reusable `WorkbenchPanel`. The workspace tab bodies stay where they are.
  - Implemented in C1 as `WorkbenchPanel` (`renderer/components/workbench-panel.tsx`). It is controlled. Tabs (`WorkbenchTab`: `id`, `viewId`, `label`, `icon?`, `selected`, `closable?`, rename/wrap hooks) and views (`WorkbenchView`: `id`, `render({ presented, selected, width })`) are separate lists, because several strip tabs can share one view. `newTab` is the launcher hook point; without it there is no "+". The open state, Quick View, Escape and suppression stay in `EnvironmentPanelProvider`/`EnvironmentWorkbench`, so the `environment.toggle` shortcut and the persisted open bit apply to any tab set mounted there.
  - On `/bots/$botId`, the workbench shows Bot tabs instead of workspace tabs. Leaving the Bot restores the workspace tabs.
- **Tabs:**
  - **Activity:** every step of every reply, newest first, grouped by reply ("Today, 6:41 PM · Plan dinners for this week"). Routine runs carry the routine's name. It uses the transcript tool calls from §6 and is read-only.
  - **Files:** today's Bot files content. `bot-files-dialog.tsx` is removed. File chips in the chat open this tab and select the file.
  - **Memory:** the Memory page's content in compact form. Edit and delete behave exactly as in Profile → Memory, which stays.
  - **Routines:** the Routines group's content, with Add routine.
- **Opening it.** A panel toggle sits in the Bot chat header. Files, Memory and Routines in the ••• menu open the panel on that tab.
  - Implemented in C2 on the chat route `/bots/$botId/chat` (`renderer/main/bots/bot-workbench.tsx`), with its own state and keys (`aiden-agent.bot-panel.*`, `BotPanelProvider`). `environment.toggle` toggles it in a Bot chat and does nothing on other Bots pages. The workspace Environment, Quick View and device mini player are suppressed on every Bots path and come back unchanged (the workspace panel reads `data-state="covered"` while Bots pages show).

## 9. Bots sidebar

On any `/bots` route, `chat-sidebar.tsx` renders `BotSidebar` instead of the project/chat list:

- **Top:** ‹ (back to the last non-Bot route), Search, and New Bot.
- **Pinned Bot.** A large face and the name, shown only when a Bot is pinned. "Pin to top" and "Unpin" are in the ••• menu. The pin is a desktop UI preference (one Bot), not part of `BotDefinition`.
- **Rows.** Face (animated while working), name, and a one-line preview of the last message ("Thinking…" in shimmer while working). Trailing markers:
  - "Needs you": an open approval or question.
  - An unread dot: a reply arrived after the person last viewed that Bot. Last-viewed is a desktop UI preference per Bot.
- **Ordering.** Most recent activity first.
- **Interactions.** Rows keep the context menu and hover •••. Search filters rows in place.
- **Footer.** The profile photo and Connect apps.
- **No Bot selected.** The `/bots` main area opens the most recently used Bot's chat, or the "Meet your first Bot" carousel when there are none. The old list page is removed, since the list now lives in the sidebar.
- **Primary nav.** `sidebar-primary-nav.tsx`'s Bots item stays as the way in.

## 10. Menus, model choice and the Advanced model control

- **••• menu** (chat header, row hover, right-click, and the same order on phones):
  - Profile, Files, Memory, Routines, Advanced, Pin to top/Unpin (desktop only), separator, Delete Bot.
  - Phones have no side panel, so Files and Memory open the existing sheets.
- **New Bot model field (desktop).** An "AI model" field in step 1 of `bot-create-flow.tsx`.
  - It opens `BotModelPicker` (`renderer/main/bots/bot-model-picker.tsx`), a Bot-specific searchable popover built from the same `Popover`/`Command` primitives as the composer picker. The composer's `ModelPicker` needs real provider ids for its icons, model info and Pad, and Bot catalog ids are deliberately opaque, so it can't be reused. Provider logos fall back to initials until the catalog carries a non-secret icon slug.
  - It defaults to `recommendedBotModelChoice` (the first available model, as before), marked Recommended.
  - When the chosen model reads text only, a "For photos" row is filled with `firstAvailableVisionModel`.
  - With no model set up, the field reads "No AI model set up yet", with Set up…, and creating still works.
- **New Bot model row (iOS and Android).** A Model row in the New Bot form pushes a list of the Mac's models: Recommended first, then one section per provider with provider icons. A Photos row appears for text-only models.
  - iOS shows the Photos row only when a model that reads images is set up on the Mac; otherwise it says "<model> reads text only, and no model that reads images is set up on your Mac." and creates the Bot reading text only, as desktop does.
  - Android differs (slice A): New Bot uses the shared `AidenModelPickerField` sheet, which has no Recommended section, and has no photo model row; the Mac picks the image model. Adding one is a recorded follow-up.
  - The create request already carries the selection (`AidenBotEditorDraft.customAccess`), so there is no contract change.
- **Advanced model control.** Advanced uses the same model field as New Bot instead of the Service + Model selects.
  - The selected value shows only the model name on one line with an ellipsis.
  - "Reads images" / "Text only" moves to the row's description.
  - The `flex-wrap` rule no longer applies to the trigger.
  - Android Advanced moves from radio rows to `AidenModelPickerField`.

## 11. Remote contract (revision 30, provisional)

Revision 30 is claimed at merge time, after whatever `main` holds then. The token `bot-activity-v1` is announced only while the routes below are wired.

- **Session stream.**
  - New SSE event `activity` with `{ phase: string, app?: string, startedAt: number } | null`.
  - The `snapshot` gains `activity?`.
  - Frames keep the existing one-seq-after-the-last rule.
  - `app` is the connection's display label, at most 40 characters.
  - Nothing else from the step crosses the wire: no `step`, `detail`, path, command, query or thinking.
- **Bot detail** gains `chatActivity`.
- **Steer and Queue.** `POST /bots/{id}/messages` accepts an optional `whenBusy: "steer" | "queue"` on hosts announcing the token (mapped to `steer`/`followUp`). Without it, behaviour is today's queue.
- **Saving the setting.** `PATCH /bots/{id}` accepts `chatActivity` (exact keys, enum values) on hosts announcing the token. Phones send it only to such hosts. Older hosts reject unknown keys, so the gate is required.
- **Device opt-in (plan ruling).** Older phones' decoders refuse unknown session keys and event types, so the token alone can't gate what the host sends. A device negotiates `bot:activity` (no authority, any device type, offered only while `bot-activity-v1` is announced), like revision 27's `bot:cards`. Holders receive `activity` and `queued` (snapshot keys and frames), Bot detail `chatActivity`, and the `submissionId` below. Other devices get a no-op `state` frame at those seqs, and every Bot-detail-returning route (create, GET, PATCH and avatar DELETE; avatar PUT returns the asset metadata, not a detail) strips `chatActivity` for them at one choke point. The grant is persisted per device (a re-paired device negotiates again), and an older state file without it still loads.
- **Queued (plan ruling).** A `queued` frame and snapshot list carry the person's own waiting messages `{ submissionId, mode: "steer" | "queue", text }` (at most 20, text at most 32,000 code points, ids unique). Routine and hidden inputs never appear (R1): the list is built by inclusion from ids the desktop's fail-closed classifier marked as the person's own. Photo-only inputs have no text and are omitted (R11). Phones have no Remove (follow-up).
- **`submissionId` on user entries (R16, plan ruling).** For `bot:activity` devices a transcript `message` entry with `role: "user"` may carry `submissionId`: the id the same message had as the send receipt and in the queued list. Phones settle their optimistic bubble by it. It is never on a routine's input (`label`) or a question answer, and omitted when the Mac no longer knows it. The tag is sticky while the entry is in the projected view (eviction never changes an old entry, so no ghost bubble reaches any phone); for non-holders it is stripped at the existing choke point.
- **Stop and Resume.** `botTurnIntents` (`stopping`, `stopCancelled`, `resuming`) is the one source for the desktop projection and Remote. Remote Stop announces `stopping` (and `stopCancelled` when it fails); a Resume is announced only from the runtime's `onResumed`, never before `runtime.resume` (R2, R3, R4). Phones therefore read "Stopping" and "Picking up where it left off" exactly as the Mac does.
- **Bounds on the wire.** `app` at most 40 code points; `startedAt` an integer 0 to 2^53-1; `phase` matches `^[a-z][a-z_]{0,31}$` and is rendered as `working` when unknown; the `activity` object has exactly `phase`, `app?`, `startedAt`.
- **Revision.** 30 is provisional and must be re-claimed at merge, after whatever `main` holds then (every place that carries the number is listed in `.memory/bot-chat-activity.md`).
- **Fixtures.** The privacy fixture asserts that an `activity` frame never carries keys outside the allow-list. Fixtures are shared across TS, Swift and Kotlin.
- **Older Macs.** Phones paired with an older Mac keep today's behaviour and hide the Chat activity row.

## 12. iOS and Android

Both platforms (`AidenBotSessionChatView`/`AidenBotSessionModel`, `AidenBotSessionScreen`/`AidenBotSessionController`):

- **Status line.** A status line renders while `activity != nil` and no partial text is showing. It uses the native activity marks with the shared words, and the chosen wording applies. It shows elapsed time after 20 seconds and "Reconnecting to your Mac" while the stream is down during a running turn.
- **Never on phones:** steps, recaps or peek.
- **Phase words.** They come from one table per platform, kept in step with §5 by a shared fixture listing every id.
- **Chat activity page.** On iOS it is a native `Form` with radio rows and a looping preview per row; on Android it uses the Material 3 Expressive layer. Both pause their previews under Reduce Motion. The page saves through `PATCH /bots/{id}`.
- **Steer and Queue.** While the Bot works, the composer offers Steer and Queue like normal chats (the iOS busy pill, Android's equivalent). Queued messages show faded with "Queued".
- **Faces.** In the Bots home list, a running Bot's face uses the glance animation.
- **Plan rulings.**
  - The line shows from the send (`preparing` until the first frame).
  - It hides only while reply text streams and the phase is writing or thinking (or none yet); a tool phase keeps it over narration text (R7). Whitespace-only text does not count as a reply.
  - Elapsed time compares the Mac's `startedAt` with the phone's clock, and is hidden when negative.
  - Phones don't show the 2-minute note.
  - The Steer/Queue pill defaults to Queue, and Stop stays where it is.
  - Previews illustrate the Mac's levels, and hold a still frame under Reduce Motion. The still frame depends on the level: Summary holds the reply with its recap, Quiet and Detailed hold a mid-turn frame.
  - A photo avatar gets a glance badge. Under Reduce Motion or Low Power a canonical face also keeps the badge's still pose, so a working Bot stays distinguishable without motion (R19; shipped on Android, iOS is a follow-up).
  - Running-step words in the previews are the Mac's phase words, not their own copy.
- **Optimistic, never waiting to connect (R14, R18).** Every Bot action on a phone applies at once and reconciles with the Mac later.
  - Send shows the bubble (faded "Sending…") and "Getting ready" immediately, and goes through the outbox below.
  - Stop shows "Stopping" at once; Resume shows "Picking up where it left off" at once; Retry goes through the outbox as a fresh optimistic send; Dismiss, question answers, approvals and routine proposals apply at once. Each rolls back with an error when it fails, and the rollback checks whether that field changed since the tap, not the transcript cursor.
  - Steer/Queue and Chat activity picks apply at once and roll back on failure. A pick made while the phone is still connecting is held for up to 8 s, then sent or rolled back. Chat activity picks coalesce (three taps send two requests), are not queued durably, and recover a `revision_conflict` by refreshing the Bot and adopting the Mac's choice.
  - Opening Bots home, a chat, Advanced or Chat activity never blocks on the connection: cached data or skeleton rows and bubbles show at once, with a quiet "Connecting…" hint and no spinner. The Chat activity row opens offline from the cached Bot.
  - Every Bot request is bounded to 12 s, because the phone's URL session otherwise waits minutes on a dead link. A timed-out Chat activity save refreshes the Bot, so a late success is shown as saved rather than rolled back.
- **Outbox (R17).** A message sent while the phone is not connected, or before the Mac answers, waits in a per-Bot outbox with its idempotency key.
  - It survives leaving the chat, a Bot switch and a relaunch. On iOS it is a file under Application Support (`BotOutbox-v1`) with file protection `completeUntilFirstUserAuthentication`, excluded from backup; on Android it is a file under `noBackupFilesDir` (never backed up). Both are keyed by the installation identity (instance and device), so a re-pair never restores old messages.
  - Privacy: unsent message text is on disk for up to 24 hours. It is purged on unpair, on revoked credentials and on access loss (a 401/403 on the stream or reads), and only the per-Bot outbox file is read back.
  - Limits: at most 20 messages and a byte budget (10 MB iOS, 4 MB Android). An over-limit send is refused visibly; the outbox never deletes older messages to make room.
  - After 24 hours an unsent message becomes "Couldn't send · Try again"; it is never silently dropped, and neither is an exhausted retry. Ambiguous failures (I/O errors, 5xx, 408, 429, 409 `idempotency_in_flight`) keep the key and retry with backoff (1 s, then 4 s); a definite refusal fails the message, and Try again uses a new key.
  - A message is frozen when first attempted (text and `whenBusy`), so a replay is byte-exact and never hits `idempotency_conflict`.
  - Reconcile is by `submissionId` (receipt, queued list and the user entry), with text only as a fallback for Macs that omit it. Each transcript entry settles one message, once; an unsettled message is hidden when echoed and never removed. Order is first in, first out: a deferred head blocks later messages.
- **Android localization.** Copy goes in `strings.xml`, following the localization conventions. `aidenBotElapsedLabel` and `aidenBotDurationLabel` are deliberately English helpers (JVM-tested presentation helpers, like `AidenTurnElapsed`).

## 13. Not in scope

- Workspace (non-Bot) chats keep their current activity UI.
- The Telegram binding keeps its own `activity` setting. Aligning it with `chatActivity` is a follow-up.
- No reasoning text is shown anywhere for Bots.
- Phones get no Activity tab.
- Unread and pinned state are not synced to phones.

## 14. Accessibility and motion

- **Status line semantics.** The status line is `role="status"` with an accessible name of the word plus, on the Mac, the step label. It announces phase changes at most once every 2 seconds, so screen readers are not flooded.
- **Motion.**
  - Marks and faces freeze on their still pose under Reduce Motion and when off-screen, through the existing `rewindWhenFrozen` behaviour.
  - Shimmer only runs under `data-reduce-motion="false"`.
  - Previews pause.
- **Controls.** All new controls keep `focus-visible` rings. Radio rows are keyboard operable (arrow keys within the group).

## 15. Onboarding

- The Bots feature-tour tile (`renderer/components/onboarding-feature-gallery.tsx`) is reviewed.
- If its illustration shows the old list or the Updates line, it is redrawn from the art kit to show a face row and the status line.
- No new onboarding step: Chat activity defaults are right for new users.

## 16. Testing

Every new test file is registered in the matching `package.json` script and `scripts/ci-test-registry.json`.

- **Classifier** (`renderer/shared/bot-activity.test.ts`): tool fixtures → phase. Covers the parallel-tool tie-break, connection label, unknown tool → `working`, and the Always "Thinking" mapping that keeps `waiting`/`stopping`/`reconnecting`.
- **Projection** (`live-projection.test.ts`, extended): a real harness turn produces `preparing → thinking → reading → writing → null`. It also covers:
  - step `detail` is bounded and redacted;
  - a failed versus a refused tool result gets `failed`/`blocked`;
  - thinking text never appears.
- **Remote** (`aiden-remote-bot-session.test.ts`, router tests):
  - `activity` frames carry only allow-listed keys;
  - the token appears only while wired;
  - `PATCH chatActivity` round-trips, and is rejected without the token.
- **Renderer** (Testing Library):
  - `BotStatusLine` at each level and wording;
  - the recap fold auto-folds on finish and keeps a manual toggle;
  - progress narration renders as bubbles;
  - the Chat activity page saves on pick;
  - the Bots sidebar renders pinned, working, needs-you and unread rows;
  - the ••• menu has Advanced and opens panel tabs;
  - the New Bot model field defaults to the recommendation and adds the photo row for text-only models.
- **Playwright:** Bots page → sidebar shows only Bots → open a Bot → the panel's Files tab shows a produced file.
- **iOS and Android:**
  - decoder tests for `activity` and `chatActivity`, with the shared fixtures;
  - session model/controller tests: the status line shows until partial text, and an unknown phase becomes `working`;
  - the New Bot model row and Chat activity save.
  - Run the applicable mobile suites.

## 17. Resolved items

- Mid-turn input: both Steer and Queue (decision 11, §6, §11).
- Workbench shell: its own PR, with C2 stacked on it (decision 12, §4).
- Tool categories: §5.1 (decision 13).
- Left to the plan: whether Pi Durable can withdraw a single queued submission (decides the Remove button).
- Pi Durable withdraw on phones: no Remote withdraw route in D; the Queued bubble has no Remove on phones (follow-up).

- **Slice B rulings (2026-10-14):**
  - Pi Durable 1.0.3 withdraws one queued submission (`Harness.abortSubmission`), so the Queued bubble has Remove. It reports `withdrawn`, `started` or `gone`; only `withdrawn` removes the bubble.
  - Refusals are told from failures by Pi's `blocked` tool diagnostic. A fourth result status, `stopped`, covers steps cut off by Stop or a restart; it renders neutrally, never red.
  - `chatActivity` left out of an update keeps the stored value. Identity updates merge a partial `chatActivity` onto the freshly read Bot. It is stored last in the Bot record because the revision hashes the record JSON. Remote's identity PATCH still rejects it (slice D).
  - The app label is read from the MCP agent tool name.
  - A command step never shows the command. It shows only the model's `description`, redacted before it is cut to 80 characters; with no description the step has no detail.
  - Always "Thinking" hides the peek.
  - The recap shows red "N issues" and amber "N blocked" separately.
  - The snapshot also carries `queued` from `pi.inbox`. The queued list holds only the person's own inputs: it is classified by the durable submission request id (`routine:`, `intro:`) plus the hidden flag, and fails closed when an id is missing.
  - Run identity is the run's first input (`inputs[0]`), not the generation task id. A Resume is marked by the service's `onResumed` callback inside the per-Bot serialize, and the Stop and Resume flags are scoped to that run, so a double Stop never carries "Stopping" into the next turn.
  - Every user entry begins a turn in the transcript rows (Pi Durable places a steer after the round's tool results).
  - The status line hides only while reply text streams with no active tool step. Announcements go through sr-only text inside `role="status"`, throttled to one per 2 seconds.
  - The Chat activity page saves on pick through a serial queue (a failed save returns the radio to the saved choice with a toast). Each level has its own Reduce Motion still frame, and Reduce Motion is read live.
  - Faces glance through `data-working` on the avatar, with one shared off-screen observer.
  - The Bots onboarding tile needed no redraw: it shows neither the list nor the Updates line (it draws the name pill, one exchange and a routine chip).

- **Slice C2 rulings (2026-10-14):**
  - The Bot panel lives on the chat route only; Profile and its sub-pages stay full pages.
  - Bots on paired Macs are listed in the Bots sidebar under "On {Mac}", and search filters them.
  - "Most recently used" is the Bot last viewed on this Mac, else the newest activity (chat activity once the summaries answer, else the Bot's own `updatedAt` after 800 ms, so a summary that never answers cannot leave `/bots` blank). While the list loads, or a Bot is about to open, `/bots` shows a skeleton; an open create flow suppresses the redirect.
  - Unread compares the Bot's last reply with the newest reply its chat showed on this Mac (`seenReplyAt`, both main's times), or with when the preference record began for a Bot whose chat showed none, so updating lights up nothing. Main times a reply from when it starts streaming, so a reply that started before the person left and finished after is still unread. `lastViewed` (this Mac's clock) only picks the Bot `/bots` opens.
  - The pinned Bot shows only as the hero; deleting it clears the pin.
  - The footer shows the profile name's initial (Aiden has no profile photo) and Connect apps opens Settings → Plugins.
  - The chat header has no "All Bots" back; Profile's back reads "Chat". The exceptions keep "All Bots", because there is no Bot whose chat they could go back to: Profile's loading and "not found" shells, and the chat's "not found" shell.
  - "Memory updated" opens the panel's Memory tab.
  - A waiting Bot's row reads "Waiting for you"; a working one "Thinking…".
  - `bots:live:summary` gained `needsYou` and `lastReplyAt`; `bots:attention` refreshes a row when a question or approval changes. Desktop IPC only.
  - Deviations from the plan as written, all accepted:
    - One refcounted live store per Bot per window (`useBotLive`) instead of a context-only provider, so every consumer (the chat, the panel tabs) shares the single `bots:live:subscribe`. The chat holds it while it is shown.
    - C1's `WorkbenchPanel` gained two optional props: `surface` (the `data-environment-surface` name, default `"tools"`, so the Bot panel is not treated as the workspace surface by focus and Escape rules) and `tabMenu` (default true; the Bot panel hides the "Open tabs" menu because its tabs are fixed).
    - Back to Aiden, Search and New Bot sit at the top of the sidebar body rather than in the title bar, which the window controls overlap.
    - `bots:changed` and `bots:attention` are synced once per window (`useBotNotificationsSync`) and re-read only the Bot they name.
    - The Activity tab always shows the full log. The Chat activity level governs only the in-chat recap, since opening the panel is an explicit ask.
    - Bot renderer suites run with `NODE_ENV=test` (`renderer/main/bots/test-env.ts`, imported first by `test-dom.ts`) so TanStack Router uses its client behaviour and routed pages re-render; navigation tests are real.
  - Final fix wave: the Bot panel has its own width range (400–720, default 440) so it sits beside the chat, reflowing it, wherever the chat keeps a 560px column, and floats only where the workspace panel would float too. Deleting a Bot that is not on screen stays on the current page. A consumer joining a failed live store keeps the last view while it retries. Search folds only Latin accents.
  - Parked, not fixed in C2:
    - The workspace sidebar's local state is lost when Bots pages remount it.
    - A batched summaries IPC (one `bots:live:summary` read per Bot on mount today).
    - Profile → Chat pushes a history entry (pre-existing).
    - A list with only paired Macs' Bots still shows "Meet your first Bot" on `/bots`.
    - The device mini player reconnects while the workspace surface is suppressed (pre-existing, shared with the paired-host path).
    - Closing the Bot panel returns focus to the panel toggle, not the composer (as briefed).
    - A file chip names only the file's basename (pre-existing).
    - Test debt: the `lastNonBotRoute` test depends on pristine module state and lacks edge cases (trailing slash, `/chat/extra`, a query on a Bots path, `/botsy`); dead `deferred()` lines in the Files keep-on-refresh test; the render probe never uninstalls (each suite is its own process); Task 2 review minors 3, 4 and 6 on the preference store.
  - The Bots onboarding tile keeps its content; only its header changed from a back chevron to the panel toggle.

- **Slice D rulings (2026-10-14).** The plan (`docs/superpowers/plans/2026-10-14-bot-chat-activity-d-phones.md`) was written before B, C1 and C2 shipped, so a pre-flight scan against the shipped code produced these rulings. `.superpowers/sdd/2026-10-14-bot-chat-activity-d-phones/progress.md` is the full record; the numbers match it.
  - **R1 Queued privacy.** The Remote projector classifies queued inputs with the desktop's fail-closed classifier (`createQueuedInputClassifier`, one implementation shared by the desktop feed and every projector; throttled retry through the caller's serial lane, on the injected clock). Routine and intro inputs never reach a phone. `liveQueuedMessages` lists only ids classified as the person's own (an inclusion filter), and a classification failure is reported once per failing streak.
  - **R2 Resume.** `botTurnIntents.resuming` is announced from the runtime's `onResumed` path inside the per-Bot serialize, not before `runtime.resume`, which preserves B's stale-Resume fix. Remote `control()` and the handlers never announce Resume.
  - **R3 Failed Stop.** A third intent, `stopCancelled`, clears "Stopping" when a Stop fails. Both `bots:stop` and Remote Stop go through `stopWithIntents`.
  - **R4 Run scoping.** `liveRunKey` is exported; the Remote projector resets `startedAt`, Stop and Resume when the run key changes, as the desktop does, so a queued follow-up never carries a stale "Stopping". `startedAt` itself comes from one process-wide record per run (`botRunStarts`, final wave FR-I1): the first surface to see a run records its start, and the desktop feed and every Remote projector read it, so a phone that opens mid-run or comes back after the projector's 60 s idle close sees the run's real elapsed time. A surface that sees the Bot not running ends the record, so the next run, or a Resume of the same one, starts afresh.
  - **R5, R6.** Android defines `AidenStrictLongSerializer` beside the Int one; the delegated test transport takes the new `send` signature.
  - **R7 Line visibility.** Phones use the desktop rule (hide only while reply text streams with no active tool step).
  - **R8 Android Home.** `AidenBotsHomeScreen` opens Advanced with Chat activity too.
  - **R9, R10, R12, R13.** Tasks 2 and 11 were split (2a/2b, 11a/11b); the desktop intents wiring is extracted and tested like `wireBotAttention`; preview tests assert per-level behaviour, never exact recap strings; execution was serial.
  - **R11 Photo-only queued messages** are omitted from the queued list (no text to show).
  - **R14, R18 Optimistic actions** (user directive: "all client actions immediate and optimistically loading with skeletons, not waiting to connect"). See §12.
  - **R15 Scope.** The directive also covers the slice A phone surfaces (create Bot, model pick, Advanced, profile and memory edits); they are final-wave work, below. Non-Bot phone surfaces get their own plan.
  - **R16 `submissionId`** on the person's own user entries, adopted into revision 30 (§11).
  - **R17 Outbox**, persisted, TTL'd, file-protected, excluded from backup and purged on unpair and access loss (§12).
  - **R19 Still badges** (amends R8): under Reduce Motion or Low Power a working canonical face keeps the glance mark's still pose as a badge.
  - **R20.** Android ran in parallel with the iOS fix rounds, committing by pathspec in one command.
  - **R21 Offline capabilities** (final wave): cache the last known server capabilities (the `bot-activity-v1` feature and the `bot:activity` grant) per installation, so the line, Steer/Queue and `whenBusy` work before `serverInfo` arrives and the Chat activity row stays reachable offline; a send frozen under the cached capability replays exactly. iOS shipped it in the final wave: `AidenInstallation.botActivityAnnounced` is persisted (absent in older records reads as false), and `aidenBotActivitySupported(server:installation:)` uses `/server` once it answers and the cache before that, for the chat and for Advanced's Chat activity row. Android ships the cached-grant path and persists the feature token in the same wave.
    - Android confirmed: the pairing persists the `/server` feature tokens; a cached "supported" needs `bot-activity-v1` plus the stored grant and stands in until `/server` answers.
  - **R22 Refused sends never stick and never duplicate.** (a) Phones: a definite refusal mints a new key on Try again; the "may have arrived" mark stays for echo matching only. (b) Mac: a send, Resume, Dismiss or Stop that the session refuses from state before doing anything (`BotSessionError` `needs_model`, `model_error`, `unavailable` or `bot_paused`) leaves no record in the Remote operation ledger (`AidenOperationNotExecutedError`), so a retry with the same key is evaluated afresh once the Bot is fixed, instead of replaying `internal_error` for a day. Every other failure keeps its record and replays, so nothing runs twice. Accepted residual: a Mac downgrade that refuses before the ledger a body it accepted earlier could duplicate.
  - **Task 3 fold-ins.** The `bot:activity` opt-in list widens `isBotCardCapability`; the router has its own `bot:activity` branch gated on both service flags (never the progress fallthrough); `chatActivity` is stripped at one choke point for every detail-returning route (a review caught avatar DELETE leaking it; avatar PUT returns asset metadata, not a detail); `session` and `openEvents` activity are gated on the service being fully wired.
  - **B Resume bug (fixed in D).** After a crash with partial text, stale `pi.live` text read as writing and cleared "Picking up where it left off". The shared derivation now takes `resumedFrom` (the `pi.live` doc as it was when the Resume began): partial text that predates the Resume does not count as writing, and Resuming holds until the first live event after it. This changes the desktop line as well as phones.
  - **Review-driven fixes.** Echo claims are per epoch; the pending outbox survives dismiss, Bot switch and relaunch; TTL expiry and retry exhaustion become "Couldn't send · Try again" instead of dropping; an echo naming a foreign `submissionId` never settles a message; Android freezes the request exactly and re-gates `whenBusy` only in the controller; the Chat activity page recovers from `revision_conflict`, pauses previews off-screen and when inactive, and holds a pick up to 8 s while connecting.
  - **Deviations from the plan.** `projectBotSessionQueued(docs, personal)` takes the personal id set instead of filtering `docs` alone; `BotLiveProjector` takes one optional `ProjectorActivity` dep instead of `now` and `activityEnabled`; `stopCancelled` is a third intent; the iOS and Android Chat activity models are the final (R14) models, not the plan's first draft; Android's dialog takes a host (`botChatActivityHost`) because the scope, pairing pin and cache report must outlive the dialog.
  - **Final fix wave, desktop and protocol (done).**
    - FR-I1 and FR-m6: the process-wide run start (R4 above), and the projector's classification pause runs on the injected clock, not `Date.now`.
    - R22(b) (above).
    - One shared fail-closed classifier and the inclusion filter (R1 above). The Resume baseline (`resumedFrom`) is serialized once when the Resume is heard, not on every derivation.
    - A failing `placed()` lookup (a new message's `submissionId`) is reported once per failing streak, like classification.
    - Tests added: a reconnect snapshot mid-run carries the phase and the queued list; `projectBotSessionActivity` keeps a 40-code-point app name only for the `app` phase; a frame that leaves the phase unchanged sends no activity frame; a held `bot:activity` grant gets activity on session and stream only while both halves are wired; the bubble-tag memo holds exactly the session window; the Stop-with-nothing-running check no longer waits a fixed 50 ms.
    - Fixture: `botActivityPrivacy.rejectedNullLiterals` holds an optional key sent as the literal null (`app: null`, `queued: null` on a session and on a `queued` frame, `label: null` with `submissionId`). Every decoder must refuse each; TypeScript does.
  - **Final fix wave, iOS (done; b0d8cfc4c, 04b623430; `final-fix-report-ios.md`).**
    - FR-m1: the status-line clock ticks only while `activitySupported` and running or awaiting a turn. FR-m3: iOS already asked for `bot:activity` only when the server offers it (the shared rule). FR-m4: "Couldn’t send" uses the curly apostrophe; the other shared strings already matched Android. FR-m7: Chat activity requests race through `aidenBotWithin`; `AidenBotOutboxStore.load(_:)` is a test-only seam.
    - FR-m5 snapshot grace: a sent message that a snapshot shows as neither queued nor echoed is marked unheld and dropped only at a later reconcile at least 10 s after the mark; seen queued again, the mark clears; a frame that is not a snapshot never marks. It applies on every `bot:activity` Mac, because the phone can't see the host failing closed. Android is to match it.
    - R19: under Reduce Motion or Low Power a working canonical face wears the still glance badge, like a photo; the glance timeline is capped at 1/30 s. R21 (above).
    - R15: New Bot, the model pick, Advanced Save, and Profile and Memory edits apply at once without waiting to connect, show skeletons instead of `ProgressView`, roll back with an error on failure, settle a lost answer by re-reading, and bound each request to 12 s. Bot create keeps its idempotency (the same key for the same request, a Bot already made is reused, a definite refusal takes a new key). The screens behind an Advanced Save change when the Mac confirms (no local detail can be built), and its failure shows there.
    - Chat polish: 44 pt Try again and remove targets; the Steer/Queue menu with an empty draft; Queued/Sending text through a semantic token at 4.5:1 or more in every theme; the announcer resets when the line hides; a `start()` failure shows a still skeleton, copy and Try again; no shimmer while unreachable; `@ScaledMetric` and a stacked composer at accessibility sizes; follow-scroll only at the end or after the person's own send; the dead `.id("status")` is gone; a pure busy-mode test.
    - Chat activity: running labels in the Mac's phase words; a refresh after a timeout shows a save that landed as saved; a pick confirmed after Advanced closed still reaches the screens behind; distinct `generic`, `offline` and `conflict` failure copy; the off-screen pause uses `onAppear`/`onDisappear` inside a `Form`; bounded test polls.
    - Fixture: every null-literal sample is refused by the iOS decoders (no change needed).
    - Pre-merge bug sweep (PR #479 review and follow-ups), done: Remote — `model_error` is a 409 state refusal (bbd13274e); snapshot and every frame fit the 1 MiB SSE limit by priority allocation (f78443bae, 7aebccfe5). iOS — Chat activity picks stay with their pairing (25574c1ae); a send before the outbox restore never replaces the last launch's file (cc7ae5c6b); Try Again replays the frozen Create through a catalog change (9a2feca96); outbox diagnostics through the typed wrapper (65e00968b); a restore landing after an access-loss purge is dropped (7744dd31b); a New Bot cut off by a relaunch comes back with Try Again (9685204a9, 89b91a071); Files sheet skeletons (7eddc5be8); bounded test waits (d4d63580d); Chat activity reports after leaving and keeps a pick made during a timed-out save (4030c06a5, 978caa670). Android — a restore after an access-loss purge is dropped (e0202df7a); unconfirmed edits never reach the Bot cache's disk (6352bfbad); null literals refused (ea29ffe2f); optimistic New Bot with a Creating… row and same-key Try again, surviving process death (c47d018f6, 212f69254, e348b0131); scheme-derived error text at ≥4.5:1 (4de4bf33f). Test harness — the core-git EPIPE race (3d3cbc959).
    - Still open on both phones: a manual VoiceOver/TalkBack pass and an end-to-end run against a real Mac.
    - Android, done (e2f678024, 7533f2096, 237e9e861; 892 JVM tests, 12/12 Bot instrumented tests on a headless AVD): FR-I2 unreadable outbox renamed aside with "Some unsent messages couldn’t be restored."; FR-I3 every Bot session request bounded to 12 s (timeout is ambiguous, key kept); FR-m2 Mac answers applied by write counters; FR-m3 asks for `bot:activity` only when `serverCapabilities` offers it; FR-m4 shared copy matches iOS and lives in `strings.xml`; FR-m5 unheld grace as on iOS; FR-m8 elapsed exposed to TalkBack (the word is announced, the per-second state is not); R21 completion (persisted `bot-activity-v1` token plus grant stand in until `/server` answers); R15 Profile, Memory, model pick and Advanced Save apply at once with rollback and skeletons; Chat activity pin by (instanceId, deviceId, createdAt). Open on Android: the fixture null-literal raw-null guard; Bot create still waits on the form ("Creating…", bounded, key replayed after a timeout) instead of an optimistic Home row; inline error text (`palette.danger`) is about 3:1 in some light themes.
  - **Parked and final-wave items (open when this was written).** Follow-ups unless the pre-merge sweep above closed them:
    - Desktop: overlapping Stops where one fails briefly clear "Stopping" (cosmetic).
    - Fixtures: a whitespace-only `app` label parity note (the Android raw-null guard shipped in ea29ffe2f).
    - Android chat polish: follow-scroll only at or near the bottom or after the person's own send (check iOS too); Try again contrast of at least 4.5:1 through a scheme token, and the contrast test extended to captions and links; a failed bubble `stateDescription`; `AnimatedVisibility` for the hint row and in-flight Try again feedback; one shared power-save receiver per screen with the glance and skeleton capped near 30 fps; first-read 401/403 shows access-lost copy, not "Mac nearby"; move " ·" into `strings.xml`; sent bubble colours through `aidenBotUserBubbleColors`; a narrower `botDetails` collection; drop the duplicate Bot GET; the split button at large font; test name accuracy.
    - Android controller: read outside the store lock and merge under it; the restore continuation resumes on a throw; caps re-checked after the merge (refuse or keep failed, never let `load` drop the newest); `deliver` re-checks released after a refused freeze; release claims and `keepsKey=frozen` on FAILED-for-state paths; Resume clears only on non-null activity; inline io in the four store tests.
    - Final review findings for Android: set an unreadable outbox aside with a notice instead of dropping it (FR-I2); bound every Bot request to 12 s (FR-I3); request `bot:activity` only when the server's capability list offers it (FR-m3); share copy with iOS (FR-m4); the iOS snapshot grace period (FR-m5); a write counter for answers (FR-m2); elapsed time as TalkBack state (FR-m8); R15 and R21 completion.
    - A manual VoiceOver and TalkBack pass; the manual end-to-end checks in the plan's Task 12 Step 4 were not run in this environment (no paired Mac build).
    - No Remove for a queued message on phones, no durable queue for Chat activity picks (both by design).
