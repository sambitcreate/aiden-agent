# Aiden-RS GPUI — Runtime Behavior Audit

Branch: `gpui-rust` · Scope: behavioral issues that would frustrate a user during
normal use (crash-class bugs are already fixed — see `crash-scan.md`).

Method: each scenario was traced through the actual source — onboarding →
keychain → `ChatService::boot` → `resolve_api_key` → `drive_stream` → SSE →
`StreamReducer` → `apply_stream_msg` → `cx.notify` → render — not assumed from
names. Severity scale: **BLOCKER** ( unusable / data loss ), **FRUSTRATING**
( clear UX regression a user will hit and notice ), **MINOR** ( polish / edge ).

The headline: **the streaming pipeline is sound and the crash-class work held.**
First-run streaming works end-to-end, compaction runs, the terminal is a real
PTY, and settings round-trips. The issues below are behavioral polish, with one
real bug (Enter discards typed text while a generation is running) and one
data-persistence gap (edit-via-send-button is not durable). No BLOCKERs found.

---

## Scenario-by-scenario findings

### 1. First-run experience — streaming response appears ✅ (with a minor race)

**Trace (verified):** onboarding `save_provider_then_advance` writes the
provider record + keychain key and awaits both (`onboarding/mod.rs:327-397`);
`complete_onboarding` writes the marker, then defers the callback which closes
the onboarding window and calls `open_main_window`
(`onboarding/mod.rs:445-472`, `main.rs:251-266`). `AppState::new` constructs
`ChatService` and calls `boot(cx)` (`app.rs:339-340`). `boot` re-reads the
providers + `modelSelection` from disk and resolves the selection
(`chat_service.rs:169-221`, `resolve_selection` `:225-245`). On send,
`send_message_with` → `start_generation` → `Tokio::spawn` driver →
`resolve_api_key` (reads the keychain **fresh each turn**, `provider_kit.rs:1313-1321`)
→ `drive_stream` → `transport().stream_simple` → SSE → `StreamReducer` →
`StreamMsg::Flush` → `apply_stream_msg` → `cx.notify` → render.

**Verdict: no broken link.** The keychain key written in onboarding is readable
on the first turn because `resolve_api_key` hits the keychain per-turn rather
than caching.

**MINOR — `app.rs:635-654` (`send_composer`) + `:427-430` (Enter subscription).**
`boot` is asynchronous (background disk reads). For the ~first instant the main
window is open, `self.selection` is still `None`. During that window the Send
**button** is correctly disabled (`can_send` requires `selection.is_some()`,
`chat_pane.rs:204-208`), but the **Enter key** still calls `send_composer`,
which clears the composer input *unconditionally* (`app.rs:640-641`) and then
sets `active_error = "Select a provider and model to start chatting."`
(`chat_service.rs:821-825`). A fast typist who hits Enter the moment the window
appears will see their text vanish and an error banner appear, then everything
works on the next try. Fixable now: guard the `set_value("")` behind a
selection/generation check, or noop the Enter handler until `booted`.

---

### 2. Rapid send while streaming — button UX correct, but Enter eats the text ❗

**What works:** the Send button correctly becomes a Stop button while
`generation_active()` (`chat_pane.rs:294-321`); the second send is rejected by
the `generation_active()` guard at the top of `send_message_with`
(`chat_service.rs:818-820`); there is **no queue** (second message is dropped,
matching the TS single-stream model).

**FRUSTRATING — `app.rs:635-654`.** The composer `Input` is **not disabled**
during generation, so the user can keep typing a follow-up. If they press Enter
on that follow-up, `send_composer` clears the input *first*
(`app.rs:640-641`), then `send_message_with` silently returns early because
`generation_active()` is true. **The typed follow-up is lost** with no toast,
no banner, no queue — the bubble they were writing simply disappears. The user
is left assuming the app swallowed their message.

Exact symptom: stream A in flight → type "and then also check X" → press Enter
→ composer empties → nothing happens → A keeps streaming.

Fixable now. Options: (a) disable the Input (or just Enter) while generating,
(b) don't clear the composer until the send is actually accepted (move the
`set_value("")` after a successful acceptance check), or (c) keep the text and
show an inline "waiting for the current reply to finish" hint. (b) is the
smallest change and also fixes the scenario-1 boot race above.

---

### 3. Chat switching mid-stream — A is cancelled (not backgrounded) ⚠️

**Behavior (verified):** `select_chat` calls `cancel_generation`
(`chat_service.rs:535-545` → `:1127-1160`). `cancel_generation` sets the cancel
flag (the provider stream is **aborted**, not left running), persists any
non-empty partial text for A, drops the watcher/driver tasks, and clears
`self.generation`. B then loads clean (`load_chat`, `:547-567`).

So the model **stops generating for A** the instant the user clicks B; A's
partial reply is saved, B is in a clean state. No leak, no crash, no stale
stream re-appending to the wrong chat.

**FRUSTRATING (design, not a defect) — `chat_service.rs:535-545, 1127-1160`.**
There is only one `generation` slot and it belongs to the active chat, so
switching away from a streaming chat kills that stream. A user who clicks B to
glance at something and comes back to A will find A's reply truncated at the
point they switched (the partial is persisted, but the model stopped). There's
no "still generating in chat A" indicator while viewing B. This is internally
consistent and documented in comments, but it will surprise users who expect
ChatGPT-style background continuation. If background continuation is desired it
is a larger change (per-chat generation state + a sidebar "generating" affordance);
if the current single-stream model is acceptable, consider at least confirming
the cancellation is intended and surfacing a brief toast ("Stopped the reply in
<chat A>") so the truncation isn't mysterious.

---

### 4. Network failure — error surfaces; does NOT retry forever ✅ (message is generic)

I verified the actual `reqwest-eventsource 0.6.0` behavior against the scan's
"retry forever" note. The Anthropic transport wraps the `EventSource` in a
`stream::unfold` whose error arm sets `finished = true` and returns the error
(`anthropic.rs:566-572`); the next unfold iteration hits `if finished { return
None; }` (`:553-555`) and the stream **ends**. `EventSource`'s built-in
reconnect delay (set in `handle_error`) never fires because Aiden never polls
the source again after the first error. **The "retry forever" concern does not
manifest.**

- **OpenAI / Google / DeepSeek / Moonshot paths** (`openai_completions.rs:1487-1492`,
  `google.rs:1235`, `openai_responses.rs:383`): raw `reqwest` — a connection
  drop yields `ProviderError::Stream(<reqwest error>)` immediately; a non-2xx
  yields `ProviderError::Http { status, body }` immediately. Error surfaces.
- **Anthropic path** (`anthropic.rs:539-588`): a drop yields
  `ProviderError::Stream("Stream ended")` or the reqwest transport string.
  Error surfaces.
- **Stop works under all paths** — `drive_stream` polls the shared cancel flag
  on every ~30 ms flush tick (`provider_kit.rs:898-905`), so even a hung
  connection is interruptible.

**MINOR — `provider_kit.rs:893`, `lib.rs:344-354`.** The surfaced text is the
raw transport/eventsource string (e.g. "stream transport failed: error sending
request for url (...)") — decipherable but not friendly. There is no
network-specific copy ("Aiden lost the connection — check your network and
retry"). The in-bubble Retry button (`message_list.rs:446-455`) does let the
user re-send once connectivity returns. Fixable now: classify
`ProviderError::Stream` transport errors into a friendlier "network/connection"
message before display.

---

### 5. Invalid API key — cryptic on Anthropic, raw-JSON elsewhere; key is updatable ✅/❗

- **OpenAI-family** (`openai_completions.rs:1479-1486`): a 401 becomes
  `ProviderError::Http { status: 401, message: <body> }`, rendered by
  `provider_error_message` as `"401: <body>"` (`lib.rs:352`). The body is the
  provider's raw JSON (`{"error":{"message":"Invalid API key: ..."}}`). It
  contains the cause but is shown as unparsed JSON — decipherable, ugly.
- **Anthropic** (`anthropic.rs:545-572`): reqwest-eventsource raises
  `Error::InvalidStatusCode(401, _response)`, whose `Display` is
  **"Invalid status code: 401"** (`reqwest-eventsource-0.6.0/src/error.rs:42-43`).
  The response body (Anthropic's `authentication_error` JSON explaining the
  invalid `x-api-key`) is **dropped** — it is not part of the `Display` and
  Aiden never reads it. The user sees a banner that says, verbatim,
  **"Invalid status code: 401"** with no mention of an API key.

**FRUSTRATING — `anthropic.rs:566-572` + `provider_kit.rs:893`.** For the
default first-run provider (Anthropic), a wrong key produces a message that
does not tell the user what is wrong. This is the single most likely
"confusing first send" path. Fixable now: in the Anthropic transport's
`Some(Err(err))` arm, when the error is an `InvalidStatusCode`, read the
response body and surface `"{status}: {body}"` (matching the OpenAI path), and
ideally detect 401/403 and emit Aiden-owned copy like "Your {provider} API key
was rejected. Update it in Settings → Providers."

**Key is updatable ✅ — `settings/providers.rs:1035-1161`.** The Providers
editor writes the key via `keys.set(&provider_id, &key)` on the background
executor; `save_provider` writes `config.json`, which the portable-config watch
in `app.rs:399-419` picks up and forwards to `ChatService::refresh_providers`,
which re-reads `has_key` from the keychain. Because `resolve_api_key` reads the
keychain fresh per turn, an updated key takes effect on the very next send even
before the catalog refresh lands.

---

### 6. Empty model list — send blocked, guidance is a dead end ⚠️

`resolve_selection` falls back to `default_model` else `models.first()`
(`chat_service.rs:236-244`). A provider configured with **zero** models (e.g. a
`custom:` server with no live discovery) leaves `selection = None`.
`send_message_with` then sets `active_error = "Select a provider and model to
start chatting."` (`chat_service.rs:821-825`); the composer readiness line
reads "Pick a model from the sidebar to start chatting." (`chat_pane.rs:212-213`)
and the Send button is disabled.

**MINOR — `chat_pane.rs:210-218`.** The message directs the user to a model
picker that is genuinely empty, with no path to add models inline. A user with
an offline Ollama / LM Studio at first run (the exact onboarding case for those
providers) will hit this with no explanation that the server needs to be
running / that discovery failed. Fixable now: when the active provider has zero
models, show "{provider} has no models yet — start the local server and choose
Refresh provider catalogs" with an action, instead of the generic "pick a
model" line.

---

### 7. Large chat history — compaction runs; list is not virtualized ⚠️

**Compaction ✅ — `provider_kit.rs:851-869`, `compact.rs`.** `compact_generation_context`
runs **before every provider round** (not just once), so tool-result growth
between rounds is bounded. It is a full deterministic port of the TS ladder
(tool-result truncation → history dropping → fallback notice). A 100+ message
chat will not blow the context window silently.

**MINOR (potential) — `message_list.rs:107-111`.** The transcript renders
**every** persisted message on every re-render via `.children(snapshot.messages.iter()...)`,
and each assistant turn is a full `TextView::markdown` parse + tree-sitter
highlight pass (`message_list.rs:468-486`). There is **no windowing /
virtualization**. Stick-to-bottom scrolling re-renders on every scroll-wheel
tick (`:103-106`). I could not exercise 100+ messages at runtime here, but the
architecture (full re-render of all markdown on each `cx.notify`, which fires
on every ~30 ms flush during streaming) is the classic recipe for jank in long
transcripts. The scroll geometry is correct (`scroll_at_bottom`,
`:156-168`) and streaming stays pinned, so it won't *break* — but it may not
stay smooth. Worth a profile with a real 100-message chat before declaring
this shippable; if it janks, virtualize the list (only render messages near the
viewport).

---

### 8. Workspace with no git — silent, no crash ✅ (message is ambiguous)

**Trace (verified):** `WorkspaceState::start_poll` calls
`aiden_git::status::info` on the tokio bridge (`state.rs:1042-1054`). A non-repo
folder returns `Ok(GitInfo { is_repo: false, .. })` — **not** an error — so
`git_info = Some(...)` with `is_repo: false` and `git_error = None`
(`state.rs:1029-1033`). `git_chip_from_info` returns `None` when `!is_repo`
(`state.rs:1104-1105`). The chip render then hits the `None` arm
(`git.rs:51-74`): `active_folder.is_some()` and `git_error.is_none()` → it
shows a muted, **disabled** chip labeled **"Git…"**.

No crash, no error banner, the poll loop runs harmlessly every 15 s.

**MINOR — `workspace/git.rs:61-72`.** "Git…" on a disabled chip is ambiguous:
it does not tell the user the folder isn't a repository (compare the explicit
`git_error_hint(NotRepo)` = "This workspace is not a Git repository." that
exists for the error path, `state.rs:1232`). A user who picks a plain folder
sees a dead-looking chip with no explanation. Fixable now: when `git_info`
reports `is_repo == false`, render the chip as "Not a git repo" (still
disabled) instead of "Git…".

---

### 9. Terminal drawer — real PTY, usable, session preserved ✅

**Trace (verified):** `terminal_entity` is created **once** and cached on
`AppState` (`app.rs:1089-1111`). The default backend is `alacritty_terminal`
+ `portable-pty` (`terminal_drawer.rs:709-747`) — a real login shell, not a
stub. Keystrokes are translated to PTY bytes (`keystroke_bytes`,
`:638-703`) and written via `write_bytes` (`:581-591`); output is painted from
the live grid (`TerminalElement`, `:969-1258`). `toggle()` flips `open`
(`:541-550`) — closing the drawer hides it without dropping the backend, so
**reopen preserves the session**. Escape closes the drawer; the close button
and ⌘J toggle work. Shell-spawn failures surface as an inline error state
(`:1356-1380`).

**MINOR — `terminal_drawer.rs:559-572` (`set_cwd`).** Switching the active
workspace **drops the backend and respawns** the shell in the new folder
(`self.backend = None` + `spawn_backend`), so the terminal session is **not**
preserved across workspace changes (history, running processes, current dir
gone). This is documented in the code as intentional, but it will surprise a
user mid-`npm install`. Also note ⌘J is a no-op outside the Chat view
(`app.rs:1080-1082`) — also intentional, but a global keybind that silently
does nothing in 5 of the 6 views is a minor papercut.

---

### 10. Settings round-trip — live + persisted + remembered ✅ (one stale-state caveat)

**Trace (verified):** picking a preset calls `AppearanceState::set_preset`
(`settings/appearance.rs:364-402`) which applies the variant live via
`apply_appearance`, writes `appearance` into `settings.json` on the background
executor, and updates the Settings view's own `AppearanceState`. Mode and
reduce-motion round-trip the same way (`:304-361`). On restart,
`ChatService::boot` reads `appearance_from_settings` and applies it
(`chat_service.rs:190, 206`). **Theme changes live, persist, and survive
restart.** ✅

**MINOR — `settings/appearance.rs:364-402` vs `chat_service.rs:700-728`.** The
Settings view holds its **own** `AppearanceState` and writes the disk, but it
never updates `ChatService.appearance` in memory. The palette's "Toggle
appearance" command (`chat_service.rs:700-708`) reads that **stale** field,
mutates only `.mode`, then `apply_appearance` + `persist_appearance` —
**overwriting the just-saved preset** back to whatever the chat service had
cached at boot. Concrete repro: boot on preset Aiden → open Settings → pick
preset Berry (theme updates, disk says Berry) → ⌘K → "Toggle appearance" →
the mode flips but the colors snap **back to Aiden**, and `settings.json` now
records `{mode: Dark, preset: Aiden}`. The disk/snapshot source of truth is
the Settings view; the chat service's copy is a silent stale cache. Fixable
now: either have the Settings appearance writes route through the
`ChatService` (single source of truth) or have the palette's mode toggle
re-read `appearance_from_settings` before applying.

---

## Additional issue found while tracing (not in the scenario list)

### Edit-via-send-button is not durable ❗

**FRUSTRATING / data — `chat_pane.rs:583-606` (`submit_composer`).** Editing a
prior user message and re-sending via the **Send button** truncates the
in-memory transcript (`chat.messages = truncated`, `:598-600`) but **never
persists the truncation** — it then calls `service.send_message(...)`, which
calls `send_message_with(..., editing_message_id = None, ...)`, so the
persist-truncate branch (`chat_service.rs:868-886`) is skipped. The new user
message is appended to a disk record that **still contains the edited message
and everything after it**. On reload the rebranch is undone: the old tail
reappears alongside the new turn.

The **Enter-key** path does not have this bug: `app.rs:644-653` (`send_composer`)
passes `editing_message_id` through to `send_message_with`, which truncates
**and** persists (`chat_service.rs:868-886`). So the same edit behaves
differently depending on whether the user presses Enter or clicks Send.

Fixable now: in `submit_composer`, either route through `send_composer`
(pass `editing_message_id` into `send_message_with`) or persist the truncation
explicitly (`stores.chat.truncate_messages`) before calling `send_message`.

---

## Summary table

| # | Scenario | Verdict | Severity | Key ref |
|---|----------|---------|----------|---------|
| 1 | First-run stream | Works; Enter-before-boot race | MINOR | `app.rs:640-641` |
| 2 | Rapid send | Enter discards typed text while streaming | **FRUSTRATING** | `app.rs:635-654` |
| 3 | Chat switch mid-stream | A is cancelled (not backgrounded) | FRUSTRATING (design) | `chat_service.rs:535-545, 1127-1160` |
| 4 | Network failure | Error surfaces; no infinite retry; generic text | MINOR | `provider_kit.rs:893` |
| 5 | Invalid API key | Anthropic: "Invalid status code: 401" (cryptic) | **FRUSTRATING** | `anthropic.rs:566-572` |
| 6 | Empty model list | Send blocked; guidance is a dead end | MINOR | `chat_pane.rs:210-218` |
| 7 | Large history | Compaction ✅; list not virtualized (potential jank) | MINOR (potential) | `message_list.rs:107-111` |
| 8 | Non-git workspace | Silent disabled "Git…" chip (no crash) | MINOR | `workspace/git.rs:61-72` |
| 9 | Terminal drawer | Real PTY, usable, session preserved across toggle ✅ | (MINOR: respawn on ws change) | `terminal_drawer.rs:559-572` |
| 10 | Settings round-trip | Live + persisted + remembered ✅; palette can revert preset | MINOR | `settings/appearance.rs:364-402` ↔ `chat_service.rs:700-708` |
| + | Edit-via-Send-button | Rebranch not persisted (Enter path is) | **FRUSTRATING / data** | `chat_pane.rs:583-606` |

**Top three to fix first** (highest user-impact, all fixable now):
1. **#2** — Enter clears the composer while generating (one-line guard on
   `set_value("")`, also fixes #1's race).
2. **+#** — Edit-via-Send-button durability (route through `send_message_with`
   with the edit id, matching the Enter path).
3. **#5** — Anthropic 401 message ("Invalid status code: 401" → include the
   response body + "invalid API key" copy).

**What is solid and needs no work:** the streaming reducer, intent-counter
invalidation, cancel-token propagation, per-turn keychain resolution,
compaction, usage accounting (even on failure/stop), the real-PTY terminal,
settings persistence, onboarding → main-window handoff, and single-instance /
quit-barrier lifecycle.
