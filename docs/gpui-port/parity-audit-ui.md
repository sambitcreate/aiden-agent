# UI/UX Parity Audit — TS Electron Renderer vs. Rust GPUI Port

**Branch:** `gpui-rust`
**Scope:** 1:1 parity of the user-facing renderer surface — markdown rendering,
keyboard shortcuts, drag/drop, copy affordances, message actions, scroll,
reduced motion, accessibility, window state, command palette, settings,
empty/loading states, and theme switching.
**Method:** Each TS `renderer/` file/line is traced to its Rust `rust/aiden-ui/src/`
counterpart (or its absence), with the specific gap and severity.

> **Headline:** The GPUI port has strong *contract* parity (the keybinding
> catalog, command-palette model, appearance token system, and settings store
> keys are all faithfully ported in `aiden-core`) but weak *rendering* parity.
> The shell is wired and navigable, but the chat transcript, composer, and
> settings are noticeably lighter: markdown is rendered through gpui-component's
> stock `TextView::markdown` (no syntax highlighting, no KaTeX, no code-copy),
> only **5 of 26** keyboard shortcuts are actually bound to keys, there are **no
> copy affordances** anywhere in the chat, scroll is unconditional (no
> lock-when-scrolled-up), the main chat surface **ignores reduced-motion**, and
> **accessibility is effectively absent** (no ARIA live regions, no focus
> management). 8 of the ~14 TS settings sections are missing.

Severity scale: **CRITICAL** (blocks core usability) · **HIGH** (significant UX
degradation) · **MEDIUM** (noticeable, workaround exists) · **LOW** (polish).

---

## 1. Markdown rendering quality · **HIGH**

**TS** (`renderer/components/markdown.tsx`, `code-block.tsx`) builds a rich
pipeline:
- `ReactMarkdown` + `remark-gfm` (tables, strikethrough, task lists, autolinks)
  + `remark-math`/`rehype-katex` (LaTeX) (`markdown.tsx:7-11,50-60`).
- A custom `code` component routes fenced blocks to `CodeBlock` and inline code
  to a styled `<code>` well (`markdown.tsx:34-48`).
- `CodeBlock` runs **highlight.js** (explicit language or `highlightAuto`),
  shows a **language label**, and embeds a **per-block copy button**
  (`code-block.tsx:17-52`).
- Semantic-token CSS for headings, lists, blockquotes, tables, links, hr, and
  KaTeX display blocks (`markdown.tsx:18-32`).
- Streaming-safe re-render with memoized highlighting
  (`code-block.tsx:21-30`).

**Rust** (`rust/aiden-ui/src/chat/message_list.rs:165-176,248-255`) renders
assistant content through gpui-component's stock `TextView::markdown(...).style(Default::default())` for both persisted and streaming
messages. There are **no custom component overrides** and no second-pass
handling of code fences.

| Feature | TS | Rust | Gap |
|---|---|---|---|
| Fenced code blocks | `CodeBlock` (highlight.js + label + copy) | library default | No syntax highlighting, no language label, no copy |
| LaTeX / math | `remark-math` + `rehype-katex` | — | **Missing entirely** |
| Tables / strikethrough / task lists | `remark-gfm` | depends on library GFM support | Unverified; no explicit handling |
| Inline code styling | styled `<code>` well | library default | No semantic-token well |
| Blockquote / link / hr styling | semantic CSS | library default | No Aiden-theme styling |
| Streaming re-render cost | memoized highlight | re-parses each delta | Possible jank on long code |

**Impact:** Code reads as flat monospace with no language hint or copy affordance;
math expressions render as raw `$…$`; the transcript does not match Aiden's
visual language. This is the most visible single gap.

**What's needed:** Either extend `TextView::markdown` with a custom code-block
renderer (syntax theme is already wired in `services/appearance.rs:180` —
`set_style(&mut syntax, "variable", "--syntax-variable")`) or wrap fenced blocks
in a custom element with a copy button + language label. Add a math path (KaTeX
or a fallback). Verify GFM table/task-list/strikethrough support in the library.

---

## 2. Keyboard shortcuts · **HIGH** (catalog parity, wiring gap)

**TS** (`renderer/shared/keybindings.ts:5-286`) defines **26 commands** and
`renderer/lib/command-system-core.ts:50-72` (`resolveCommandForKeyEvent`)
resolves every keypress against the effective bindings, scoped by
editable/file-editor/terminal/modal context. All are live in the app.

**Rust** has *full catalog parity* — `rust/aiden-core/src/keybindings.rs:33-115`
ports all 26 `CommandId`s with identical titles, bindings, scopes, and the V1
override/repair/migration pipeline — and `settings/shortcuts.rs` exposes an
editor for all 26. **But only 5 are actually bound to keys:**

- `rust/aiden-ui/src/main.rs:144-153` registers only:
  `cmd-q`, `cmd-n`, `cmd-k`, `cmd-j`, `cmd-shift-d`.
- `rust/aiden-ui/src/app.rs:1094-1098` wires only 5 `on_action` handlers
  (`on_new_chat`, `on_quit`, `on_toggle_palette`, `on_toggle_terminal`,
  `on_toggle_pill`).

**Missing wired shortcuts (21 of 26):**

| Shortcut | Command | TS file | Status in Rust |
|---|---|---|---|
| `⌘⇧F` | `chat.search` | keybindings.ts:131 | Not bound |
| `⌘⇧[` / `⌘⇧]` | `chat.previous` / `chat.next` | keybindings.ts:143,155 | Not bound |
| `⌘1`…`⌘9` | `chat.jump.1`–`9` | keybindings.ts:161-174 | Not bound |
| `⌘,` | `settings.open` | keybindings.ts:217 | Not bound |
| `⌘O` | `workspace.openPreferredEditor` | keybindings.ts:230 | Not bound |
| `⌘⌃S` | `sidebar.toggle` | keybindings.ts:243 | Not bound |
| `⌘⇧E` | `environment.toggle` | keybindings.ts:267 | Not bound |
| `⌘⌥Space` | `composer.focus` (global) | keybindings.ts:64 | Not bound (global hotkey also unimplemented) |
| `⌘⌥A` | `assistant.open` (global) | keybindings.ts:91 | Not bound |
| `⌘S` | `file.save` | keybindings.ts:279 | Not bound (no file editor) |

**Impact:** The settings editor lets users *customize* shortcuts that do nothing.
Power-user navigation (chat switching, jumps, settings, environment) is
mouse-only.

**What's needed:** Register the remaining `KeyBinding`s in `main.rs`, add the
matching `on_action` handlers (and action types) in `app.rs`, and wire each to
its service. The global hotkeys (`composer.focus`, `assistant.open`,
`dictation.toggle`) additionally need the `aiden-mac` global-shortcut wiring
noted as deferred in `main.rs:149-151`.

---

## 3. Drag and drop · **N/A — parity (neither implements it)**

The audit premise states TS supports dragging files onto the composer. A full
search of `renderer/` and `main/` for `onDrop`, `onDragOver`, `dataTransfer`,
and `handleDrop` found **no composer drag-drop handler**. The "drag" hits are
all unrelated: the title-bar `drag-region`/`no-drag` CSS classes
(`ui.tsx:486,540`, `router.tsx:25`) and the model-pad reorder drag
(`model-picker-pad.tsx:63-64`).

**TS** attachments come exclusively from the **attach button** → `pickFiles()`
native picker (`composer.tsx:205-232`, `lib/ipc.ts`).

**Rust** has no attach button and no drag-drop (`composer.rs`, `chat_pane.rs`).
The Rust composer accepts text only (`chat_pane.rs:178-184`).

**Net:** Both lack composer drag-drop, so this is parity, not a regression.
However, the broader **attachment feature itself** (button + image/file
attachments + vision gating) is present in TS and entirely absent in Rust — that
is a real gap (see §5 / §11). If drag-drop is a desired capability, it must be
built on both sides.

---

## 4. Copy button on code blocks · **HIGH**

**TS** (`renderer/components/code-block.tsx:38-42`) renders a `CopyButton` in
every fenced block's header, revealed on hover/focus.

**Rust** has **no copy affordance on code blocks**. `message_list.rs:165-176`
hands the whole markdown string to `TextView::markdown` with no custom code
component. A search of `rust/aiden-ui/src` for copy/clipboard in the chat
surface found nothing (the only `Copy` icon is the dictation-pill transcript
copy at `pill/mod.rs:297`).

**Impact:** Users must select-and-copy manually; on long blocks with wrapping
this is error-prone.

**What's needed:** A custom code-block element with a copy button (clipboard
write is already used by the pill — `MacPasteDeps` / `write_clipboard` at
`pill/coordinator.rs:352`).

---

## 5. Message actions · **MEDIUM**

**TS** (`renderer/components/message-bubble.tsx:72-78,96-107`) shows a
hover-revealed `CopyButton` on **every** user and assistant message
(`opacity-0 group-hover:opacity-100`). Generation retry lives in the error
callout (`message-list.tsx:154-165`). Message *edit* is not present in
`message-bubble.tsx` (the audit prompt's "edit" appears to be aspirational).

**Rust** (`message_list.rs`) renders messages with **no hover actions at all**
— no copy, no per-message retry. The only retry is the streaming-error banner
button (`message_list.rs:280-289`), which matches the TS error-callout path.

**Gap:** No per-message copy on hover. (Edit/retry-on-hover absent on both
sides.)

**What's needed:** Add a hover-revealed copy button to
`render_assistant_message` / `render_user_bubble`.

---

## 6. Scroll behavior · **MEDIUM**

**TS** (`renderer/components/ui.tsx:587-679`) `ScrollArea` implements
*stick-to-bottom*: it tracks `atBottom`/`atBottomRef` from scroll geometry and
only auto-scrolls when `autoScrollToBottom && atBottomRef.current`
(`ui.tsx:636,647,654`). When the user scrolls up, auto-scroll **locks off** and
a **"scroll to bottom" button** appears (`ui.tsx:708-713`,
`showScrollToBottomButton`). `chat-pane.tsx:1054-1063` enables both.

**Rust** (`rust/aiden-ui/src/app.rs:443-450`) unconditionally calls
`self.message_scroll.scroll_to_bottom()` whenever the message count changes or a
generation is active. There is:
- **No `atBottom` tracking** — the view snaps to the bottom even if the user is
  reading earlier output.
- **No scroll-to-bottom button.**
- **No distinction between user-initiated and programmatic scroll.**

**Impact:** During streaming, the transcript yanks the user back to the bottom
if they try to read prior content — a common, frustrating UX regression.

**What's needed:** Track scroll position in `message_list.rs`, gate
`scroll_to_bottom()` on "near bottom", and add a jump-to-bottom affordance.

---

## 7. Reduced motion · **HIGH**

**TS** respects macOS reduced-motion pervasively:
- `lib/appearance-runtime.ts:166` probes
  `matchMedia("(prefers-reduced-motion: reduce)")`.
- `lib/use-theme.ts:76-82` listens for changes.
- `styles.css:234-236` kills all transitions when
  `:root[data-reduce-motion="true"]`; `:1664` adds a `@media` fallback.
- Opt-in animations are gated on `data-reduce-motion="false"`
  (`styles.css:749-869`: dialogs, popovers, banners, dock, activity feed,
  streaming reveal, reasoning shimmer).
- The streaming-reveal cadence and assistant handoff delay collapse to 0 under
  reduced motion (`lib/streaming-reveal.ts:389`,
  `assistant/use-assistant-chat.ts:132-133`).

**Rust** has a `MotionGate` (`pill/state.rs:193-240`) and onboarding motion
handling (`onboarding/view.rs:29-33`), but the **main chat surface does not
consult it**:
- `app.rs:950` hardcodes `system_reduced_motion: false` for the pill deps.
- GPUI "exposes no `prefers-reduced-motion` probe" — the gate's
  `system_reduced` is an injected field that is **never wired to a real OS
  probe** for the main window (`pill/state.rs:193-200` doc comment).
- The transcript, composer, dialogs, and command palette apply gpui-component's
  default animations unconditionally; nothing reads the persisted
  `reduceMotion` setting in the chat view.

**Impact:** Users who have enabled macOS reduced motion still see full
transitions, shimmers, and streaming reveals in the main chat.

**What's needed:** Probe the OS reduced-motion flag (NSWorkspace /
`NSUserDefaults @"com.apple.swing.beep.disabled"`-equivalent or
`CGEventSourceFlagsState`-independent API), feed it into a main-window
`MotionGate`, and gate every animated surface (streaming reveal, thinking
shimmer, dialog/popover transitions, activity feed).

---

## 8. Accessibility · **HIGH**

**TS** has broad a11y coverage:
- `aria-live` / `role="status"` / `role="log"` on the activity feed
  (`activity-feed.tsx:129-130`), message activity transitions
  (`message-list.tsx:212-213`), the assistant thread (`assistant-thread.tsx:31-32`),
  the subagent live announcer (`subagent-live-announcer.tsx:67-69`,
  `aria-atomic="true"`), composer readiness (`composer.tsx:527`), provider
  editors (`provider-editor.tsx:326`, `codex-provider-settings.tsx:350,419`),
  and many settings surfaces.
- Focus management: subagent-chip focus capture/handoff
  (`message-list.tsx:55-106`), focus boundaries, `aria-label`s on every icon
  button.
- Keyboard-only operability via the command system.

**Rust** has **effectively no a11y in `aiden-ui/src`**: a search for
`aria`, `role=` (non-ChatRole), live-region, announcer, and focus-management
patterns found **no ARIA live regions, no `role="status"`, no focus
capture/handoff, and no screen-reader announcements**. The few "aria" hits are
comments ("the card's aria-label / tooltip" at
`assistant/automation_approval.rs:50`) and a Computer-Use explainer string
(`onboarding/view.rs:658`), not actual attributes.

**Impact:** The GPUI app is invisible to VoiceOver for dynamic state
(generation status, tool activity, errors, approvals). Static content may be
navigable via gpui's accessibility elements, but there is no parity with the TS
announcer model.

**What's needed:** Determine gpui's accessibility primitive (it exposes
`Accessibility`/`AX*` on elements), then add live-region equivalents for the
streaming state, error banner, approval cards, and tool-activity feed; add
`aria-label`/tooltip equivalents to icon-only buttons; replicate the subagent
focus-handoff.

---

## 9. Window state persistence · **PARITY (both omit it)**

**Neither** port remembers window position/size across launches.
- **TS** (`main/index.ts:621-641`) creates `BrowserWindow` with fixed
  `width: 1000, height: 700, minWidth: 390, minHeight: 456` and no bounds
  save/restore (no `electron-window-state`, no `getBounds`/`setBounds` on close).
- **Rust** (`rust/aiden-ui/src/main.rs:219-224`) opens
  `WindowBounds::Windowed(Bounds::centered(None, size(px(1000.), px(700.)), cx))`
  — fixed centered, no min size, no restore.

**Net:** At parity (feature absent on both). Rust additionally lacks the TS
`minWidth`/`minHeight` constraints, which is a minor regression (window can be
shrunk below usable bounds). If persistence is desired, both need it; the Rust
fix is to read/write bounds to `settings.json` and pass them to `WindowOptions`.

---

## 10. Command palette completeness · **LOW (largely at parity)**

**TS** (`renderer/components/command-palette.tsx`,
`lib/command-system-core.ts`) shows the `showInPalette: true` subset of the
26-command catalog (15 commands) plus four sub-modes: **Chats**, **Models**,
**Providers**, **Settings** (`command-palette.tsx:181-184`). Recent-command
ordering persists to localStorage (`lib/command-palette-recent.ts`).

**Rust** (`rust/aiden-ui/src/panels/command_palette.rs`) is a faithful, in some
ways fuller, port:
- `PALETTE_COMMAND_IDS` (`:115-135`) mirrors the TS visible set and **adds**
  `theme.toggle`, `view.scheduled`, `view.usage`, `view.subagents`, `app.quit`.
- `PaletteMode` (`:75-105`) mirrors Chats/Models/Providers/Settings.
- `PaletteCommand` enum (`:33-72`) covers SelectChat, SelectModel,
  SetAppearanceMode, ToggleTheme, RefreshProviders, OpenSettingsSection, etc.
- Orchestrator wiring (`app.rs:630-697`) routes every variant to a service.
- Recents persist to `settings.json` (`command_palette.rs:29`,
  `SettingsRecentStore`).

**Minor gaps:**
- Several `PaletteCommand` variants are `#[allow(dead_code)]` and emit nothing
  (`SearchChats`, `ChangeModel`, `ManageProviders`, `SearchSettings` — they enter
  modes, which is correct, but `ToggleSidebar`/`ToggleEnvironment`/
  `OpenWorkspaceEditor` are no-ops in `app.rs:691-697`).
- No toast feedback on model change (TS toasts success/failure,
  `command-palette.tsx:221,224`).

**Net:** The palette model and catalog are at parity; a handful of routed
actions are stubbed no-ops.

---

## 11. Settings completeness · **HIGH**

**TS** (`renderer/components/settings/`) ships **~14 sections**: Providers,
Appearance, Shortcuts, MCP, Scheduled Tasks, About **+** Assistant, Computer
Use, Voice, Local Voice, Web Search, Skills, Model Data (Artificial Analysis),
Model Pad, plus rich sub-editors (`provider-editor`, `builtin-provider-editor`,
`codex-provider-settings`, `model-manager-view`).

**Rust** (`rust/aiden-ui/src/settings/mod.rs:40-57`) ships **6 sections**:
Providers, Appearance, Shortcuts, MCP, ScheduledTasks, About.

| TS section | File | Rust | Status |
|---|---|---|---|
| Providers | providers-settings.tsx | settings/providers.rs | Present (basic rows) |
| Appearance | appearance-settings.tsx | settings/appearance.rs | **Reduced** — no reduce-motion picker, no per-scheme color editor, no typography (stated `appearance.rs:7`) |
| Shortcuts | shortcut-settings.tsx | settings/shortcuts.rs | Present (catalog display + editor) |
| MCP | mcp-settings.tsx | settings/mcp.rs | Present (basic) |
| Scheduled tasks | scheduled-tasks-settings.tsx | settings/scheduled.rs | Present |
| About | about-settings.tsx | settings/about.rs | Present |
| Assistant | assistant-settings.tsx | — | **Missing** |
| Computer Use | computer-use-settings.tsx | — | **Missing** |
| Voice | voice-settings.tsx | — | **Missing** |
| Local Voice | local-voice-settings.tsx | — | **Missing** |
| Web Search | web-search-settings.tsx | — | **Missing** |
| Skills | skills-settings.tsx | — | **Missing** |
| Model Data (AA) | model-data-settings.tsx | — | **Missing** |
| Model Pad | model-pad-settings.tsx | — | **Missing** |

**Impact:** 8 tunable feature areas are unconfigurable in the GPUI app
(assistant, computer use, voice, web search, skills, model data, model pad).
The Appearance editor lacks the reduce-motion segmented control that TS exposes
(`appearance-settings.tsx:462`).

**What's needed:** Port the eight missing sections (most have backing logic
already in `aiden-core`/`aiden-data` — e.g. `model_pad.rs`, `appearance` reduce
motion) and add the reduce-motion + typography controls to Appearance.

---

## 12. Empty states · **MEDIUM**

**TS** provides nuanced empty/error states:
- Welcome / no-chats, no-provider, chat-selected-but-empty
  (`chat-pane.tsx` via `EmptyState`).
- Generation-failed `Callout` (`message-list.tsx:154-165`).
- Error boundaries per message (`message-bubble.tsx:22-31`,
  `UnrenderableMessage`).
- Profile/usage loading skeletons (`profile-view.tsx:330`).

**Rust** (`chat_pane.rs:54-125`) has three inline empty states:
- No providers → "No providers configured yet" + Open Settings button.
- No chats → "Welcome to Aiden" + `⌘N` hint (matches PRODUCT.md's quiet style).
- New chat empty → "New chat" / "Ask anything to get started."
- Error → retry banner in the stream bubble (`message_list.rs:256-290`).

**Gaps:**
- **No per-message error boundary** — a malformed markdown payload would fail
  the whole transcript (TS isolates it). `TextView::markdown` either renders or
  panics; there is no `SafeMessageBubble` equivalent.
- No "unrenderable message" raw-text fallback.

**Net:** The happy-path empty states are reasonable and on-brand. The missing
piece is failure isolation per message.

---

## 13. Loading states · **MEDIUM**

**TS** shows spinners and skeletons during loads (profile/usage skeletons,
provider connection spinners, voice transcribing spinners, model-loading probes).

**Rust** uses `Spinner` selectively:
- Thinking header while reasoning (`message_list.rs:304`).
- MCP settings boot (`settings/mcp.rs:400`).
- Git branch/commit/push loading (`workspace/git.rs:146,524,574,691,893,1099`).
- Editor picker loading (`workspace/editors.rs:52-53,119`).
- Assistant providers loading (`assistant/assistant_panel.rs:285-286`).

**Gaps:**
- **No loading skeleton for the settings boot** — `settings/mod.rs:150-222`
  boots on a background spawn; until it resolves the sections paint empty with
  no skeleton/spinner.
- **No usage/profile skeleton** (`panels/usage_panel.rs:1016` shows text
  "Loading usage…" but no skeleton).
- **No provider-connection spinner** in the Providers section.
- **No model-loading probe** ("Model loading…" for local Ollama/LM Studio).

**Net:** Spinners exist where the workspace/git/MCP code was ported, but the
settings and usage surfaces lack TS-equivalent loading affordances.

---

## 14. Theme switching · **LOW (works, but reduced)**

**TS** (`appearance-settings.tsx`, `lib/appearance-runtime.ts`,
`lib/use-theme.ts`) applies appearance live, persists under the `appearance`
settings key, broadcasts to auxiliary windows, reconciles the pill, and exposes
preset + mode + **per-scheme color editor** + **reduce-motion segmented
control** + typography.

**Rust** (`settings/appearance.rs`, `services/appearance.rs`):
- `set_mode` / `set_preset` (`appearance.rs:249-307`) call `apply_appearance`
  live **and** persist under the `appearance` key — so the toggle **does apply
  to the gpui-component theme correctly and persists**.
- The syntax theme is wired from the same tokens
  (`services/appearance.rs:180`).
- Onboarding and the chat service hydrate the persisted appearance on boot.

**Gaps (functionality, not correctness):**
- **No reduce-motion control** in the UI (the `ReduceMotion` type exists in
  `aiden-core` but is not exposed; see §7).
- **No per-scheme custom color editor** (only the 4 presets).
- **No typography preferences.**
- The `system_reduced_motion` flag fed to the pill is hardcoded `false`
  (`app.rs:950`) and never read from the OS.

**Net:** Theme switching is functionally correct and persistent; it is simply a
smaller surface than TS (presets + mode only).

---

## Summary table

| # | Area | Severity | TS present | Rust present |
|---|---|---|---|---|
| 1 | Markdown rendering | HIGH | Full (GFM+KaTeX+highlight+copy) | Stock `TextView::markdown` only |
| 2 | Keyboard shortcuts | HIGH | 26/26 wired | 5/26 wired (catalog complete) |
| 3 | Drag and drop | N/A (parity) | No (button only) | No |
| 4 | Code-block copy | HIGH | Yes | No |
| 5 | Message actions | MEDIUM | Hover copy | None (retry only) |
| 6 | Scroll behavior | MEDIUM | Stick-to-bottom + button | Unconditional snap |
| 7 | Reduced motion | HIGH | Global | Pill/onboarding only; main chat ignores |
| 8 | Accessibility | HIGH | aria-live + focus mgmt | None |
| 9 | Window persistence | PARITY | No | No |
| 10 | Command palette | LOW | Full | Full (a few no-op actions) |
| 11 | Settings | HIGH | ~14 sections | 6 sections |
| 12 | Empty states | MEDIUM | Rich + error isolation | 3 states, no per-msg isolation |
| 13 | Loading states | MEDIUM | Spinners + skeletons | Selective spinners |
| 14 | Theme switching | LOW | Full editor | Preset + mode only (works, persists) |

### Highest-leverage fixes (ordered)
1. **Code-block copy + syntax highlighting** (§1, §4) — single most visible gap.
2. **Wire the remaining 21 keyboard shortcuts** (§2) — the catalog is ready.
3. **Accessibility live regions** (§8) — required for parity with TS announcers.
4. **Reduced-motion OS probe + main-window gating** (§7).
5. **Stick-to-bottom scroll + scroll-to-bottom button** (§6).
6. **Per-message hover copy** (§5) and **per-message error boundary** (§12).
7. **Port the 8 missing settings sections** (§11), starting with the
   reduce-motion control.

### Notes / assumptions
- gpui-component's `TextView::markdown` GFM/table/task-list support was not
  verified from source (the crate source was not located in the workspace); the
  audit records only what the Aiden code explicitly handles, which is nothing
  beyond the default.
- "Message edit" (audit prompt §5) does not exist in the TS `message-bubble.tsx`
  either; only hover-copy and error-retry are present on both sides.
- Window-state persistence (§9) is absent on **both** ports; flagged as parity,
  not a Rust regression.
