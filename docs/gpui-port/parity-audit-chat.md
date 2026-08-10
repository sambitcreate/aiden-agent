# Chat-Flow Parity Audit — TS Electron vs. Rust GPUI Port

**Branch:** `gpui-rust`
**Scope:** The 1:1 chat flow — system prompt, compaction, titles, attachments,
tool loop, edit/retry, stop, error recovery, usage, timeline persistence.
**Method:** Each TS file/line is traced to its Rust counterpart (or its absence),
with the specific wiring gap and severity.

> **Headline finding:** The parity is asymmetric in a surprising direction.
> The *dock* assistant (`rust/aiden-ui/src/assistant/assistant_panel.rs`) IS
> fully wired — it calls `build_assistant_system_prompt`, runs a real
> multi-round agent loop (`run_agent`, `max_tool_iterations: 10`), and has a
> tool-error guard. The **main coding chat** the user actually uses
> (`rust/aiden-ui/src/services/provider_kit.rs::drive_stream`) is a hand-rolled
> stub that sends **no system prompt**, does **no compaction**, runs **a single
> MCP tool round**, has **no tool-approval gating**, and **cannot be aborted**.
> The portable ports (`system_prompt.rs`, `compact.rs`) exist and are correct —
> they are simply not called by the main chat driver.

---

## Gap 1 — System prompt is never sent in the main chat  ·  **CRITICAL**

**TS** builds two system prompts and always attaches one:
- Dock persona: `main/services/assistant/system-prompt.ts:162` (`buildAssistantSystemPrompt`).
- Main coding prompt: `main/services/llm-client.ts:370` (`buildSystemPrompt` — the
  "You are Pi…" folder-scoped persona, git branch, permission posture, skills list).
- It is resolved per-turn and stamped onto the agent:
  `main/services/llm-client.ts:1040-1068` (`const systemPrompt = …`), then passed
  to the agent's `initialState.systemPrompt` (`llm-client.ts:1113`) and to the
  capacity assertion + context transform (`llm-client.ts:1069`, `1091`).

**Rust** has a faithful port (`rust/aiden-agent/src/system_prompt.rs:263`,
`build_assistant_system_prompt`) but it is **only** called by the dock
(`rust/aiden-ui/src/assistant/assistant_panel.rs:373`). The main chat driver
hardcodes the field to `None`:

- `rust/aiden-ui/src/services/provider_kit.rs:419` —
  `system_prompt: None,` inside `build_stream_request_with_tools`.
- `rust/aiden-ui/src/services/provider_kit.rs:336-340` (doc comment) —
  *"System messages are dropped (the phase-5 build has no system-prompt pipeline)."*
- `rust/aiden-ui/src/services/provider_kit.rs:377` — `ChatRole::System => None`
  (persisted system messages are stripped on history replay, so even a stored
  prompt would be discarded).

**Impact:** The main chat runs with **zero** system instructions. The model gets
no Aiden/Pi persona, no folder/git/permission grounding, no skills listing, no
coding-workflow guidance, and (for the dock persona) no tool-handbook contracts.
This is the single highest-leverage correctness gap in the chat flow.

**What's needed:** Port `buildSystemPrompt` (llm-client.ts:370) into the Rust
crate, resolve it in `ChatService::send_message` from the active workspace
(folder path, git branch, permission) + discovered skills, and thread it into
`TurnSnapshot` so `build_stream_request_with_tools` sets `system_prompt: Some(…)`.

---

## Gap 2 — Context compaction is never invoked before streaming  ·  **CRITICAL**

**TS** wraps every generation in the degradation ladder:
- `main/services/generation-context.ts:286` (`compactGenerationContext`) and
  `:456` (`createGenerationContextTransform`) — image-cap → tool-result
  truncation → history drop → current-turn stub → fallback notice.
- Wired in as the agent's `transformContext`:
  `main/services/llm-client.ts:1088-1111`.
- Capacity asserted before I/O: `main/services/llm-client.ts:1069`
  (`assertGenerationContextCapacity`).

**Rust** has a complete, well-tested port —
`rust/aiden-providers/src/compact.rs:426` (`compact_generation_context`) and
`:626` (`create_generation_context_transform`). **It has zero callers.** A
workspace-wide grep for `compact_generation_context` / `create_generation_context_transform`
returns only the definition and its own unit tests in `compact.rs`. It is not
imported by `provider_kit.rs`, not by `chat_service.rs`, and not re-exported for
chat use.

**Impact:** Long conversations, large tool outputs, and big attachments are sent
to the provider **uncompacted**. The model will hit context-window errors (or, for
local small-context models, hard-fail) that TS silently degrades past. There is
also no capacity pre-check, so tiny-context models fail at the provider instead
of with Aiden's bounded message.

**What's needed:** Call `compact_generation_context` (or
`create_generation_context_transform`) inside `drive_stream` (or in
`send_message` when building the snapshot) using the resolved `context_window`
and the (currently missing) `system_prompt` + tool defs, then stream the
*compacted* message list. This depends on Gap 1 (compaction charges the system
prompt against the budget).

---

## Gap 3 — No model-driven chat title generation  ·  **HIGH**

**TS** generates a concise title in the background on the first user turn:
- `main/services/chat-generation-start.ts:9` (`startGenerationAndMaybeTitle`) —
  fires `startTitle` only after the real turn starts.
- `main/services/chat-title.ts:189` (`generateFirstTurnTitle`) — makes one
  small, tool-free `streamSimple` call with the title prompt
  (`chat-title.ts:108-114`) and replaces the seed via `chatStore.replaceAutoTitle`
  (`chat-title.ts:227`).
- Policy/prompt port: `main/services/chat-title-policy.ts`
  (`deriveChatTitleSeed:58`, `buildChatTitlePrompt:109`, `sanitizeGeneratedChatTitle:86`).
- Apple Foundation Models route + chat-model route:
  `main/services/chat-title.ts:155`, `:77`.

**Rust** ports the *policy* (`rust/aiden-core/src/chat_title.rs`) and the
*seed* (`rust/aiden-data/src/chat_store.rs:607`, `derive_chat_title_seed`), and
the seed is applied on first send via `auto_title: true`
(`chat_service.rs:1070`). But there is **no model-driven title step**:
- A grep of `aiden-ui` for `chat_title|generate_title|replace_auto_title|build_chat_title`
  returns nothing. `chat_title.rs` is consumed only by `aiden-computer-use`
  (the Foundation-Models connection), never by the chat service.
- `ChatService::send_message` (`chat_service.rs:640`) never schedules a
  background title request; `persist_user_message` writes the seed and stops.

**Impact:** Every chat is titled with a truncated copy of the user's first
message forever. The nice summarized titles ("Refactor auth middleware") that TS
produces never appear. Renaming via Foundation Models is also absent.

**What's needed:** Add a `generate_first_turn_title` background task in
`ChatService` (mirroring `chat-title.ts:189`): on the first user message, make a
small `stream_simple` call with `build_chat_title_prompt`, sanitize with
`sanitize_generated_chat_title`, and call a `replace_auto_title` store method.

---

## Gap 4 — Attachments / images are not handled end-to-end  ·  **HIGH**

**TS** supports image *and* text attachments across the full path:
- Read: `main/services/attachments.ts:76` (`readAttachments`) — images→base64,
  text→inlined UTF-8, size limits, binary rejection.
- Into messages: `main/services/generation-messages.ts:14` (`toPiMessages`) —
  text files become a fenced ```Attached file``` block; images become
  `ImageContent` parts gated on `supportsImages`
  (`generation-messages.ts:46-52`).
- Title prompt also uses the first image (`chat-title.ts:95-104`).

**Rust** has the *types* (`aiden_core::Attachment`, `ImageContent`,
`UserContent::Image`, `AttachmentKind`) and the title *policy* even reads
attachment names (`aiden-core/src/chat_title.rs:88`). But the chat driver and UI
ignore them entirely:

- `rust/aiden-ui/src/services/provider_kit.rs:351` —
  `chat_history_to_messages` maps user history to `UserContent::Text(entry.content)`
  only; attachments on persisted messages are dropped.
- `rust/aiden-ui/src/services/chat_service.rs:714` — `send_message` builds the
  user `ChatMessage` with `attachments: None` and never reads files.
- `rust/aiden-ui/src/chat/message_list.rs:98` (`render_user_bubble`) — renders
  only `prewrap(&message.content)`; no image render, no attachment chips.
- `rust/aiden-ui/src/chat/composer.rs:139` (`composer`) — text `Input` + send/stop
  only; **no attach button, no file picker, no paste-image, no drag-drop**.

**Impact:** The user cannot attach a screenshot, design reference, or text file.
Persisted attachments (from another client) are invisible and never reach the
model. Vision models are effectively unusable.

**What's needed:** (a) composer attach affordance + `readAttachments`-equivalent
file read; (b) thread `Attachment` into `ChatMessage` + `chat_history_to_messages`
(text→fenced prefix, image→`UserContent::Image` gated on the model's `vision`
limit, already resolved in `build_stream_request_with_tools:415`); (c) render
image/chips in `render_user_bubble`.

---

## Gap 5 — Tool loop is single-round, not a full agent loop  ·  **CRITICAL**

**TS** runs the full pi-agent loop with unbounded rounds until the model stops
emitting tool calls:
- `main/services/llm-client.ts:1074` constructs `new Agent({...})` and
  `:1518` `await agent.continue()` drives it to completion.
- Per-round hooks: `beforeToolCall` (`llm-client.ts:1138`) for approval gating,
  `prepareNextTurnWithContext` (`llm-client.ts:1119`) for the attended tool-error
  guard.
- Tool-execution events stream each round (`llm-client.ts:1388-1438`).

**Rust** main chat does **at most two passes** — one initial turn plus one
follow-up after dispatching tool calls — by design:

- `rust/aiden-ui/src/services/provider_kit.rs:534` — `let mut tool_round_done = false;`
- `rust/aiden-ui/src/services/provider_kit.rs:611` —
  `if dispatch_ready && !tool_round_done { tool_round_done = true; … continue; }`
  — the flag guarantees only **one** re-dispatch even if the model emits further
  tool calls.
- Doc comment, `rust/aiden-ui/src/services/provider_kit.rs:489-491` —
  *"Multi-round agent loops are out of scope for the chat driver; a turn that
  keeps asking for tools after the round settles with whatever text it produced."*

**Contrast inside the same crate:** the dock assistant uses the real runner —
`rust/aiden-ui/src/assistant/assistant_panel.rs:380-382`:
`RunnerConfig { max_tool_iterations: 10, max_repeated_calls: 3, attended_tool_error_guard: true }`
via `run_agent` (`assistant_panel.rs:398`). So the *secondary* surface has the
correct loop; the *primary* one does not.

**Impact:** Any task needing >1 tool call (read a file *then* edit it, search
*then* open *then* patch) cannot complete. The model's second tool request is
silently dropped and the turn ends with whatever text was produced. There is
also **no tool-approval gating** (no `beforeToolCall` equivalent) and no
workspace-permission model, so `ask`-mode approvals are entirely absent.

**What's needed:** Replace `drive_stream`'s hand-rolled two-pass loop with the
same `run_agent` runner the dock uses (or loop until `tool_calls.is_empty()` /
`StopReason != ToolUse`), add an approval bridge hook for mutating tools, and
cap with `max_tool_iterations`.

---

## Gap 6 — Message editing / retry-from-edit is missing  ·  **MEDIUM**

**TS** lets the user edit any prior user message and regenerate from that point
(the renderer truncates the transcript after the edited message and resends).
The full agent re-runs against the truncated history.

**Rust** has only a bare *error*-retry and no edit-at-all:

- `rust/aiden-ui/src/services/chat_service.rs:775` (`retry_last`) — finds the
  last user message and re-sends its text verbatim via `send_message`. It does
  **not** truncate the conversation after it, so the retry appends a *duplicate*
  user turn on top of existing history rather than regenerating from the edit
  point.
- No `edit_message` / `truncate_after` / `regenerate_from` exists anywhere in
  `aiden-ui` (grep for `truncate_after|edit_message|editMessage|retryFrom` →
  none).
- `rust/aiden-ui/src/chat/message_list.rs:98` (`render_user_bubble`) — no hover
  edit affordance, no pencil icon, no per-message actions at all.
- `rust/aiden-ui/src/chat/chat_pane.rs` — composer is send-only.

**Impact:** Users cannot correct a misunderstood prompt mid-conversation without
starting a new chat, and the existing "Retry" button (error banner,
`message_list.rs:280-288`) duplicates history instead of regenerating.

**What's needed:** (a) an edit affordance on user bubbles; (b) a service method
that truncates the chat store after the target message and re-sends the edited
text; (c) fix `retry_last` to truncate-to-and-regenerate rather than append.

---

## Gap 7 — Stop does not cancel the in-flight provider stream  ·  **HIGH**

**TS** aborts the agent and the underlying request immediately:
- `main/services/llm-client.ts:1663` (`cancel`) — sets `cancelRequested`,
  `generation.agent.abort()` (`:1663`), aborts the AbortController
  (`:1655`), cancels approvals and subagents.
- The abort propagates into the provider's HTTP stream; partial text is still
  persisted (`llm-client.ts:1566-1592`, `persistAssistant`).

**Rust** saves partial content correctly but **does not stop the provider
request**:

- `rust/aiden-ui/src/services/chat_service.rs:791` (`stop_generation`) — bumps
  the generation counter, marks `complete = true`, persists partial text/thinking,
  then drops the handles: `_stream_task = None; _driver = None` (`:823-824`).
- `drive_stream` (`provider_kit.rs:544-569`) has **no cancellation input** — its
  `tokio::select!` listens only to `stream.next()` and the flush `interval.tick()`.
  There is no cancel channel/token. Dropping the gpui `Task` handle does not
  abort it: `rust/aiden-ui/src/workspace/state.rs:95` explicitly notes
  *"gpui `Task` handles do not cancel on drop"*.
- Result: the background tokio task keeps consuming the provider stream to
  completion; its terminal `Done`/`Error` is sent into a channel whose receiver
  was dropped (the watcher was dropped at `:823`) → `send` returns `Err` and is
  ignored. The model keeps generating (and the provider keeps billing) after the
  user pressed Stop.

**Impact:** Stop is a *visual* stop only. Tokens/cost continue to accrue at the
provider with no usage recorded (the watcher that would record usage is gone —
see Gap 9). On slow/streaming models the run can continue for many seconds after
Stop.

**What's needed:** Pass a `tokio_util::sync::CancellationToken` (or abort
handle) into `drive_stream` and select on it; on `stop_generation`/`cancel_generation`,
fire the token so `stream_simple`'s future is dropped. The dock's
`stop` (`assistant_panel.rs:439`) should be the reference (it at least drops the
driver + cancels approvals), but it *also* lacks a provider-level cancel token
and needs the same fix.

---

## Gap 8 — Error recovery re-sends but does not truncate  ·  **MEDIUM**

**TS** surfaces an error banner with retry; retry re-runs the turn. Crucially TS
tracks `deniedToolCalls`, distinguishes abort vs error
(`llm-client.ts:1520-1525`), and on a true error persists the partial then lets
the user retry (which regenerates the last user turn).

**Rust** shows the banner and retries, but with a behavioral gap:

- Banner + Retry button: `rust/aiden-ui/src/chat/message_list.rs:256-290`
  → calls `retry_last`.
- `rust/aiden-ui/src/services/chat_service.rs:775` (`retry_last`) re-sends the
  last user message text via `send_message`, which **appends** a new user
  message rather than removing the failed assistant turn first. So the
  transcript grows: `[user, assistant(error), user(dup), assistant]` instead of
  regenerating in place.
- `on_stream_closed` (`chat_service.rs:1019`) does surface a "Generation
  stopped." error when the channel closes without a terminal event — good
  defensive behavior — but the retry path still duplicates.

**Impact:** Retrying an error leaves the failed/partial assistant bubble in
history and adds a duplicate user message, confusing context for the model and
cluttering the transcript.

**What's needed:** Make `retry_last` (or a new `regenerate`) truncate the
conversation back to (and including) the failed assistant turn before resending,
mirroring TS in-place regeneration.

---

## Gap 9 — Usage is not captured on failures or on stopped generations  ·  **MEDIUM**

**TS** records usage on **every** terminal assistant message, including errors
and the partial turn before an abort:
- `main/services/llm-client.ts:1357-1364` — `usageStore.record(assistantUsageRecord({message, …}))`
  fires on each `message_end` event, which carries real usage even when a later
  error follows.
- Title generation records usage on both success and failure
  (`chat-title.ts:128-148`).

**Rust** records usage only on a *successful* terminal, and uses zero usage on
failure:

- `rust/aiden-ui/src/services/chat_service.rs:920` (Done) —
  `record_usage(build_usage_record(&usage, Completed))` ✅ (real usage).
- `rust/aiden-ui/src/services/chat_service.rs:958-960` (Error) —
  `record_usage(build_usage_record(&zero_usage(), Failed))` ❌ — the reducer's
  `StreamTerminal::Error` does not carry usage (`stream.rs:175-179`), so input
  tokens already consumed before the error are recorded as **zero**.
- Stop path (`chat_service.rs:791`) records **no usage at all** — partial
  content is persisted (`:812`) but `record_usage` is never called; and because
  the watcher is dropped, the provider's eventual real usage is sent into a dead
  channel and lost (see Gap 7).

**Impact:** Usage/cost accounting undercounts failures and all stopped
generations. The privacy-safe aggregate (`usage.json`) is incomplete vs. TS,
which matters for the usage view and for cost visibility.

**What's needed:** (a) Capture usage in the `Error` terminal (thread the
reducer's accumulated usage into `StreamTerminal::Error` and pass it through
`StreamMsg::Error`); (b) record a `Cancelled`/`Failed` usage row in
`stop_generation` for the partial work; (c) ensure the driver records usage even
when the foreground watcher has gone (record inside the driver, not only in the
watcher).

---

## Gap 10 — Timeline persistence: mostly met, but tool-call bodies are lost  ·  **MEDIUM**

**TS** persists the full agent state per assistant turn: text, reasoning, the
`GenerationTimeline` (thinking stretches + tool steps with status/duration), and
the tool-call/tool-result message bodies (so the transcript reconstructs the
agent loop on reload):
- `main/services/llm-client.ts:965` (`persistAssistant`) writes `reasoning` and
  `timeline` (`:992-993`); the agent's own messages (tool calls + results) are
  part of the persisted chat.

**Rust** persists timeline + reasoning correctly and renders them on reload —
this part is at parity:
- `rust/aiden-ui/src/services/chat_service.rs:1109,1125` (`persist_assistant`)
  writes `timeline_value` and `reasoning` into `ChatMessageInput`.
- `rust/aiden-ui/src/chat/message_list.rs:133-139` renders `message.timeline`
  via `timeline_feed`; `:140-163` renders persisted `reasoning`.

**The gap:** the *content* of tool activity is not persisted or reconstructed:
- `persist_assistant` stores only `content: text` (`chat_service.rs:1117`) —
  assistant tool-call content blocks and tool-result messages are dropped.
- `chat_history_to_messages` (`provider_kit.rs:341-380`) only reconstructs
  `User(Text)` and `Assistant(Text)`; there is no `Message::ToolResult` branch,
  so on reload any prior tool exchange is gone from the model's context.
- Compounded by Gap 5 (single round) — timelines are capped at one tool step.

**Impact:** Reloaded conversations lose the tool evidence the model needs to
continue multi-step work, and the persisted timeline is a summary without the
underlying calls/results. For pure chat (no tools) this is at parity; for any
tool-assisted turn it regresses.

**What's needed:** Persist assistant tool-call blocks + tool-result messages
into the chat store and reconstruct them in `chat_history_to_messages`
(add `Message::ToolResult` mapping + assistant multi-block content).

---

## Summary table

| # | Feature | TS status | Rust (main chat) status | Severity |
|---|---------|-----------|-------------------------|----------|
| 1 | System prompt | Always sent (`llm-client.ts:1040`) | `None` (`provider_kit.rs:419`) | **CRITICAL** |
| 2 | Context compaction | `transformContext` (`llm-client.ts:1088`) | Port exists, **never called** (`compact.rs:426`) | **CRITICAL** |
| 3 | Auto title generation | Background `streamSimple` (`chat-title.ts:189`) | Seed only; no model title | **HIGH** |
| 4 | Attachments / images | Full path (`attachments.ts`, `generation-messages.ts:46`) | Dropped everywhere; no UI | **HIGH** |
| 5 | Multi-round tool loop | Full `Agent` (`llm-client.ts:1518`) | Single round (`provider_kit.rs:611`) | **CRITICAL** |
| 6 | Edit / retry-from-edit | Edit + truncate + regenerate | Append-only `retry_last` (`chat_service.rs:775`); no edit UI | **MEDIUM** |
| 7 | Stop cancels stream | `agent.abort()` (`llm-client.ts:1663`) | No cancel token; stream runs on (`provider_kit.rs:544`) | **HIGH** |
| 8 | Error recovery | In-place regenerate | Duplicates history (`chat_service.rs:775`) | **MEDIUM** |
| 9 | Usage on failures/stop | Every `message_end` (`llm-client.ts:1357`) | Zero on error; none on stop (`chat_service.rs:959`) | **MEDIUM** |
| 10 | Timeline persistence | Timeline + tool bodies | Timeline ✅; tool calls/results lost (`provider_kit.rs:341`) | **MEDIUM** |

### Cross-cutting note
The `drive_stream` function in `provider_kit.rs` is the root cause of gaps 1, 2,
5, 7, and 9. It duplicates (in stub form) what the dock's `run_agent` runner
already does correctly. The highest-leverage fix is to **retire `drive_stream`
and route the main chat through the same `run_agent` + `RunnerConfig` path the
dock uses** (`assistant_panel.rs:374-407`), then layer on workspace context
(Gap 1), attachments (Gap 4), and edit/truncate (Gap 6). That single refactor
closes the two CRITICAL and two HIGH gaps at once.
