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
  - Bots use `bot-files-dialog.tsx` instead.
- **Sidebar:** `renderer/components/chat-sidebar.tsx` and `sidebar-primary-nav.tsx`. Bots are one nav item, and no Bot rows appear in the sidebar.
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
  - On `/bots/$botId`, the workbench shows Bot tabs instead of workspace tabs. Leaving the Bot restores the workspace tabs.
- **Tabs:**
  - **Activity:** every step of every reply, newest first, grouped by reply ("Today, 6:41 PM · Plan dinners for this week"). Routine runs carry the routine's name. It uses the transcript tool calls from §6 and is read-only.
  - **Files:** today's Bot files content. `bot-files-dialog.tsx` is removed. File chips in the chat open this tab and select the file.
  - **Memory:** the Memory page's content in compact form. Edit and delete behave exactly as in Profile → Memory, which stays.
  - **Routines:** the Routines group's content, with Add routine.
- **Opening it.** A panel toggle sits in the Bot chat header. Files, Memory and Routines in the ••• menu open the panel on that tab.

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
- **Android localization.** Copy goes in `strings.xml`, following the localization conventions.

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
