# GPUI Research: Building a Production macOS Desktop App in Rust

Date: 2026-08-06. Status: research only — no application code. Sources: local `gpui` /
`gpui-component` skill references, crates.io, docs.rs, zed-industries/zed repo,
longbridge/gpui-component repo and docs site, assorted crate repos (linked inline).

---

## 1. Executive summary

- **GPUI is now standalone-usable from crates.io.** `gpui 0.2.2` (published Oct 2025,
  owned by zed-industries) plus the `gpui_platform` companion crate is the supported
  path. Git dependencies on `zed-industries/zed` still work (and are what the
  gpui-component README shows) but are no longer required.
- **gpui-component 0.5.1 (Feb 2026) builds against crates.io gpui** (`gpui ^0.2.2` in
  its dependency list), so an all-crates.io setup is possible today. It ships 60+
  components, a theme system, Markdown/HTML `TextView`, tree-sitter highlighting, a
  code editor with LSP, dock layout, charts, and virtualized tables/lists.
- **macOS glyph rasterization requires the `font-kit` feature on `gpui_platform`.**
  Without it text lays out but renders no glyphs. Metal rendering is always on.
- **Tokio interop is solved but unofficial.** Zed's internal `gpui_tokio` is not
  published; the community `gpui-tokio-bridge` crate wraps it. `async-compat` (smol-rs)
  is the runtime-agnostic fallback. GPUI's own executor is GCD-backed on macOS
  (foreground = main queue, background = global queue), not tokio or smol proper.
- **Terminal emulation is proven but heavy.** Zed's `terminal`/`terminal_view` crates
  embed `alacritty_terminal` (PTY, grid, scrollback) behind a custom GPUI `Element`.
  Copy the architecture, not the crate.
- **macOS integrations are third-party crate territory** (GPUI ships almost none):
  `global-hotkey`, `tray-icon`, `keyring`, `mac-notification-sys` or
  `objc2-user-notifications`, Sparkle via `sparklers`/`sparkle-updater`.
- **SQLite: use `rusqlite` with `bundled`**; run queries on `background_executor()`.
  sqlx is only worth it for multi-backend or compile-time-checked queries.

---

## 2. GPUI crate availability (2025–2026 state)

### 2.1 What exists

| Crate | Version (as of Aug 2026) | Source | Notes |
|---|---|---|---|
| `gpui` | 0.2.2 (2025-10) | crates.io, owned by zed-industries | Core framework. Pre-1.0, breaking changes between releases. |
| `gpui_platform` | 0.2.x | crates.io | Platform backend picker. macOS needs `features = ["font-kit"]`. |
| `gpui` (git) | tracks zed `main` | `git = "https://github.com/zed-industries/zed"` | Bleeding edge; used by gpui-component README. |
| `gpui-unofficial` | mirrors Zed tags (e.g. 1.7.2) | crates.io, community (iamnbutler) | Auto-published standalone repackage per Zed release tag. Single dep pulls platform backends. Not Zed-maintained. |
| `gpui_tokio` | — | NOT on crates.io | Zed-internal tokio bridge (see §7). |

The official gpui README says: *"pre-1.0, breaking changes between versions; use latest
stable Rust; macOS or Linux."* Windows backend also exists upstream now.

**Recommendation:** pin `gpui = "0.2"` and `gpui_platform = { version = "0.2", features = ["font-kit"] }` from crates.io. This matches what gpui-component 0.5.x depends on, avoids dragging the entire zed workspace into the build graph, and gives reproducible versions. Only fall back to git deps if you need an unreleased API.

### 2.2 macOS build requirements

- Xcode + Command Line Tools (`xcode-select --install`), Metal is mandatory.
- `font-kit` feature for text glyph rasterization (otherwise placeholder text system:
  layout works, glyphs don't render).
- Latest stable Rust toolchain; edition 2024 assumed by ecosystem examples.

---

## 3. Recommended Cargo dependency set

```toml
[dependencies]
# --- UI framework ---
gpui = "0.2"
gpui_platform = { version = "0.2", features = ["font-kit"] }
gpui-component = "0.5"
gpui-component-assets = "0.5"          # bundled Lucide icons (optional; you can ship your own SVGs)
# Optional gpui-component features:
#   "tree-sitter-languages"  -> all ~25 tree-sitter grammars for editor/markdown highlighting
#   "inspector"              -> UI inspector (dev only)
#   "webview"                -> wry-based webview component (lb-wry fork)

# --- Async / networking ---
gpui-tokio-bridge = "0.1"              # Tokio::spawn(cx, fut) inside GPUI; wraps zed's gpui_tokio
tokio = { version = "1", features = ["rt-multi-thread", "macros"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "stream", "json"] }
reqwest-eventsource = "0.6"            # SSE with retry; or roll your own with eventsource-stream + bytes_stream()
serde = { version = "1", features = ["derive"] }
serde_json = "1"
futures = "0.3"
async-compat = "0.2"                   # fallback bridge if not using gpui-tokio-bridge

# --- Local persistence ---
rusqlite = { version = "0.39", features = ["bundled"] }
rusqlite_migration = "2"               # or refinery; migrations not built into rusqlite
directories = "6"                      # ~/Library/Application Support paths

# --- macOS integration ---
keyring = { version = "4", features = ["apple-native"] }   # Keychain Services
global-hotkey = "0.8"                  # system-wide hotkeys (tauri-apps)
tray-icon = "0.21"                     # NSStatusItem menu-bar icon + menu (tauri-apps)
mac-notification-sys = "0.6"           # simple notifications (legacy NSUserNotification)
# objc2-user-notifications = "0.3"     # modern UNUserNotificationCenter; needs real .app bundle + permission flow

# --- Terminal (only if embedding a PTY) ---
alacritty_terminal = "0.26"

# --- Auto-update (pick one; both need Sparkle.framework bundled) ---
# sparklers = "0.1"                    # slint-ui's safe Sparkle 2 bindings
# sparkle-updater = "0.1"              # hankbao's Sparkle/WinSparkle wrapper

anyhow = "1"
log = "0.4"
env_logger = "0.11"
```

Notes on the dependency set:
- All `gpui*` versions must agree on ONE gpui version. Mixing crates.io `gpui 0.2.2`
  with a git `gpui` in the same graph fails to compile (type identity mismatch).
- `gpui-component-assets` supplies the default Lucide SVG set referenced by `IconName`.
  You can instead implement `AssetSource` over your own embedded SVGs.
- reqwest default-features=false + rustls avoids OpenSSL linking pain on macOS CI.

---

## 4. gpui-component deep dive

### 4.1 Init & high-level pattern

```rust
fn main() {
    gpui_platform::application()
        .with_assets(gpui_component_assets::Assets)   // icon/asset source
        .run(move |cx| {
            gpui_component::init(cx);                  // MUST be first: theme global, i18n, keybindings

            cx.spawn(async move |cx| {
                cx.open_window(WindowOptions::default(), |window, cx| {
                    let view = cx.new(|_| MyApp);
                    cx.new(|cx| Root::new(view, window, cx)) // Root REQUIRED as first-level view
                }).expect("open window");
            }).detach();
        });
}
```

- `gpui_component::init(cx)` installs the `Theme` global, locale (rust-i18n), and the
  library's keybindings. Call before any component is used.
- `Root` wraps the first-level view of **every window** and provides the dialog /
  sheet / notification layers. If you hand-roll a root view instead of using `Root`,
  you must render `Root::render_dialog_layer(cx)`, `Root::render_sheet_layer(cx)`,
  `Root::render_notification_layer(cx)` yourself.
- Overlay APIs hang off `WindowExt`: `window.open_modal(...)`,
  `window.open_alert_dialog(...)`, `window.open_sheet(...)`,
  `window.push_notification(...)`, `window.close_modal(cx)`.
- Stateful components (`Input`, `Select`, `Combobox`, `Slider`, `DatePicker`, `List`,
  `Tree`, `DataTable`, `ColorPicker`, `HoverCard`, `OtpInput`, `NumberInput`) hold an
  `Entity<...State>` you create with `cx.new(|cx| InputState::new(window, cx))` and
  subscribe to (`InputEvent::Change`, `InputEvent::PressEnter`, `ListEvent::Select`…).
  Stateless ones (`Button`, `Checkbox`, `Switch`, `Badge`, `Icon`…) are used inline in
  `render` with builder chaining: `Button::new("id").primary().label("OK").on_click(...)`.
- Shared traits: `Sizable` (`.xsmall()/.small()/.medium()/.large()`), `Disableable`,
  `Selectable`, plus all GPUI `Styled` methods.
- Layout helpers: `h_flex()` = `div().flex().flex_row().items_center()`,
  `v_flex()` = `div().flex().flex_col()`. Prefer these over raw divs.

### 4.2 Theming

- Access colors anywhere: `cx.theme().primary / .background / .foreground / .border /
  .surface / .muted / .destructive` (via `gpui_component::ActiveTheme`).
- `Theme` is a GPUI global. Toggle light/dark:
  `cx.update_global::<Theme, _>(|theme, cx| theme.toggle_mode(cx))`.
- Custom themes: `Theme::global_mut(cx).apply_config(&theme_config)` — multi-theme +
  variable-based config (shadcn-style tokens).
- Observe changes: `cx.observe_global::<Theme>(|cx| ...)` (gpui-component theme changes
  notify globally).

### 4.3 Component catalog (one-liners)

Input & Form:
- `Input`/`InputState` — text/password/masked input with validation, prefix/suffix, clear button, IME.
- `NumberInput` — numeric input with step. `OtpInput` — one-time-code cells.
- `Select` — dropdown picker. `Combobox` — searchable select.
- `Checkbox`, `Switch`, `Radio`/`RadioGroup`, `Toggle` — boolean controls.
- `Slider` — value drag. `Stepper` — +/- increment. `Rating` — stars.
- `ColorPicker`, `DatePicker` — stateful pickers.
- `Form` (`v_form`/`h_form`/`field`) — labeled form layout container.

Display & Feedback:
- `Button`/`ButtonGroup`/`DropdownButton` — variants primary/danger/warning/success/ghost/link, loading/disabled/selected.
- `Icon`/`IconName` — Lucide icon element. `Badge`, `Tag` (closable), `Avatar`, `Label`, `Kbd`.
- `Alert` — info/success/warning/error banner. `Spinner`, `Skeleton` — loading states.
- `ProgressBar`/`ProgressCircle`. `Tooltip` (`.tooltip(...)` on any element with `.id()`).
- `HoverCard` — rich hover popup. `Image`. `Clipboard` — copy-to-clipboard button.

Overlay & Popups:
- `Dialog` — modal via `window.open_modal`. `AlertDialog` — via `window.open_alert_dialog`.
- `Sheet` — side panel via `window.open_sheet`. `Notification` — toasts via `window.push_notification`.
- `Popover` — anchored floating overlay. `PopupMenu`/`DropdownMenu` — context menus.

Navigation & Layout:
- `Tabs`/`TabBar`. `Sidebar` — full app nav panel (menus, groups, collapse).
- `TitleBar` — custom window title bar. `Breadcrumb`, `Pagination`.
- `Accordion`, `Collapsible`, `GroupBox` — sectioning.
- `Resizable` — draggable split panes. `Scrollbar` — custom scrollbars.
- `FocusTrap` — keyboard trap for modals.
- Dock system (separate `dock` module) — panel arrangements, splits, freeform Tiles.

Data Display:
- `DataTable` — virtualized rows+columns, column resize, sort; `Table` — simpler.
- `List` — searchable virtualized list with `ListDelegate`. `VirtualList` — raw high-perf lists.
- `Tree` — hierarchical with `TreeDelegate`. `DescriptionList` — key/value.
- `Settings` — ready-made settings panel.

Content & Charts:
- `TextView` — Markdown/HTML rendering (see §5). `markdown(...)` helper.
- `Chart`/`Plot` — bar/line/area/pie with `#[derive(IntoPlot)]`.
- Code editor (`editor` module) — rope-based, up to ~200K lines, LSP diagnostics/completion/hover, tree-sitter highlighting.

### 4.4 Repo layout worth mining

- `crates/story` — gallery app showcasing every component (run `cargo run`).
- Examples in the story crate: `cargo run --example editor|dock|markdown|html`.
- `examples/` — standalone crates: `hello_world`, `system_monitor`, `window_title`, …

---

## 5. Markdown rendering & syntax highlighting

### 5.1 gpui-component `TextView` (the default answer)

```rust
use gpui_component::text::{markdown, TextView};

// Stateless helper (parses per render):
markdown("# Hello\n\n**World**")
    .selectable(true)     // text selection support
    .scrollable(true)

// With stable id:
TextView::markdown("preview-id", &source).selectable(true)
TextView::html("html-id", "<strong>Hi</strong>")
```

- Parser: the `markdown` crate (v1, pulldown-cmark lineage) → gpui-component's own AST
  (`markdown_ast`) → native GPUI elements. No webview.
- Code blocks are syntax-highlighted with **tree-sitter** (gpui-component's highlighter;
  enable `tree-sitter-languages` feature for the full grammar set, or individual
  `tree-sitter-*` crates à la carte). tree-sitter-json ships by default.
- `code_block_actions(|block, window, cx| ...)` — render "Copy"/"Run" buttons per code
  block. This is the chat-app "copy code" hook.
- Custom block plugins: implement `MarkdownPlugin { name, is_block, parse, render }`
  and attach with `.plugin(MyPlugin)`. Inline plugins are reserved/not yet supported.
  This is the extension point for things like `$TICKER`, `@mention`, or math blocks
  rendered as styled text.
- Streaming chat pattern: hold the raw markdown `String` in your entity, append deltas
  as SSE chunks arrive (`cx.notify()` per chunk or batched), pass `&source` to
  `markdown(...)` in render. Re-parse cost is per-render; for long transcripts render
  each message as its own `TextView` so only the in-flight message re-parses.

### 5.2 Alternatives

- **Zed's markdown renderer** (`crates/markdown` in zed repo) — used for agent panel;
  not on crates.io, tied to zed's `language`/theme crates. Mine for ideas only.
- **Roll your own**: parse with `pulldown-cmark`, emit GPUI elements. More control,
  more work; only if TextView's styling is a dead end.
- **Webview**: gpui-component has an optional `webview` feature (lb-wry fork) — escape
  hatch for truly arbitrary HTML (e.g., KaTeX). Heavy; avoid for core chat.

### 5.3 Math / KaTeX

No native KaTeX/LaTeX support anywhere in the GPUI ecosystem today. Options, in
preference order: (1) skip math, (2) custom `MarkdownPlugin` rendering TeX source as
styled code/text, (3) render KaTeX to SVG offline and embed as `Image`, (4) webview.

---

## 6. Terminal emulation (PTY in GPUI)

`alacritty_terminal` 0.26 is the library half of Alacritty: PTY (`tty` module), VTE
parser, grid/scrollback, selection, search — no rendering. Zed's terminal is the
reference embedding, and it is architecturally clean:

- `crates/terminal` — backend-neutral domain wrapper. Owns `Term<ZedListener>` behind
  `Arc<FairMutex<...>>`, spawns alacritty's `EventLoop` on its own IO thread, receives
  `Event`s over an unbounded channel, and surfaces a renderable `TerminalContent`
  snapshot. Also `TerminalBuilder` (two-step fallible construction: PTY handles first,
  `subscribe(cx)` second).
- `crates/terminal_view` — GPUI integration: `TerminalView` entity with a
  `FocusHandle`, keybindings (`actions!(terminal, [...])`), mouse/scroll handling, IME
  marked text, selection, hyperlink detection (regex), cursor blinking via a
  `BlinkManager` entity, and a custom `Element` (`terminal_element.rs`) that paints the
  cell grid (batched quads + text runs) in `paint`.
- Event flow: alacritty IO thread → channel → GPUI foreground task → `term` lock →
  snapshot diff → `cx.notify()` → element paint. Resize goes the other way
  (`window_id`, `WindowSize`).
- Recent refactor (zed #57483, "backend-neutral terminal types") isolates alacritty
  types inside the terminal crate — good template for your own boundary.

Feasibility verdict: very feasible — this is exactly what Zed ships — but budget real
time. The hard parts are the paint-efficient custom element, IME, selection/hyperlinks,
and scrollback UX, not the PTY plumbing. Also note `penso/arbor` has an
`arbor-terminal-emulator` crate (Ghostty integration) worth reading as a second
reference. Do NOT expect a drop-in `TerminalView` crate; you will own ~2–4k lines.

---

## 7. Streaming HTTP + SSE, and the tokio question

### 7.1 GPUI's executor reality

GPUI does not use tokio or smol as its runtime. On macOS the `ForegroundExecutor`
dispatches `async_task::spawn_local` runnables onto GCD's main queue; the
`BackgroundExecutor` uses a GCD global queue (see Zed's "Async Rust" blog). Consequences:

- `cx.spawn(...)` / `cx.spawn_in(window, ...)` — foreground (UI thread) tasks.
- `cx.background_spawn(...)` / `cx.background_executor().spawn(...)` — background.
- Entity updates only on the foreground; chain with `.then(...)` to come back.
- Any crate that requires a tokio runtime context (reqwest with tokio, tokio channels,
  `tokio::select!`, most SSE helpers) **panics or stalls** unless you bridge.

### 7.2 Bridging tokio (pick one)

1. **`gpui-tokio-bridge` (recommended)** — community crate wrapping Zed's internal
   `gpui_tokio` (zed repo `crates/gpui_tokio`, itself not published):
   ```rust
   gpui_tokio_bridge::init(cx);                 // inside app.run, starts a small tokio runtime
   Tokio::spawn(cx, async {
       let resp = reqwest::get("https://api.example.com").await?;
       Ok::<_, anyhow::Error>(())
   }).detach();
   ```
   It runs tokio futures on a dedicated tokio runtime while returning a GPUI `Task`
   you can `.detach()` or await — clean handoff back to the foreground.
2. **`async-compat` (smol-rs)** — wrap the outer future once:
   `cx.background_spawn(Compat::new(async move { /* tokio-based code */ }))`.
   Gives tokio types a runtime context via a global single-threaded tokio runtime.
   Zero GPUI-specific glue, but everything tokio shares that one runtime thread.
3. **Avoid tokio entirely** — GPUI ships `gpui_http_client` (smol-based `HttpClient`
   trait, `cx.http_client()` / `cx.set_http_client(...)`). Zed streams LLM responses
   through it. If you hand-roll SSE parsing over `futures` streams, no bridge is
   needed. More work; few examples outside zed.

### 7.3 SSE patterns

- **`reqwest-eventsource` 0.6** — `EventSource::new(request_builder)`; `Stream` of
  `Event::{Open, Message}`; built-in retry-on-failure (disable if you manage retries,
  and call `es.close()` on terminal errors). Requires tokio context → use with the
  bridge above.
- **Manual** — `response.bytes_stream()` + `eventsource-stream` (parse `data:` frames)
  or a simple line buffer splitting on `\n\n`. Best control over backpressure and
  `[DONE]`-style sentinels. Same tokio-context requirement for reqwest.
- Chat-completion streaming shape (from a real OpenAI-compat provider impl): POST
  `{model, stream: true, messages, stream_options:{include_usage:true}}` → parse each
  `data:` JSON chunk → forward `TextDelta`/`ThinkingDelta`/`ToolCallDelta` events over
  a channel → a GPUI foreground task applies them to the message entity and
  `cx.notify()`s. Batch notifies (every N ms or M bytes) to avoid re-render storms.
- Cancellation: keep a `CancellationToken`/flag; on cancel, `es.close()` and mark the
  stream aborted. Dropping the GPUI `Task` cancels the GPUI side but NOT the HTTP
  stream unless you wire the token.

---

## 8. SQLite for local persistence

**Use `rusqlite` with `bundled`.** For a desktop app this is the consensus choice:

- `bundled` compiles SQLite 3.51.x into the binary — no system dependency, modern
  SQLite everywhere, reproducible.
- Sync API is a feature here: DB calls are microsecond–millisecond scale; run them
  directly, or offload heavy/transactional work with
  `cx.background_spawn(move || { conn... })` and chain results back to the foreground.
- Never call rusqlite from inside a render pass; keep a single writer connection
  (SQLite serializes writers anyway), WAL mode + `synchronous = NORMAL` for chat
  transcript workloads.
- Migrations: `rusqlite_migration` (simple, versioned) or `refinery`. Seed/PRAGMA
  setup at open time.
- `sqlx` (sqlite, async) only if you need compile-time-checked queries or plan to
  share code with a Postgres/MySQL backend; it pulls an async runtime story you then
  have to bridge, for no desktop-scale win. Do not run sync rusqlite calls on GPUI's
  foreground executor for anything beyond trivial queries.

---

## 9. macOS integration cookbook

### 9.1 Window chrome (GPUI-native)

```rust
WindowOptions {
    window_bounds: Some(WindowBounds::centered(size(1100., 760.), cx)),
    titlebar: Some(TitlebarOptions {
        title: None,
        appears_transparent: true,                      // custom-drawn titlebar (macOS/Windows)
        traffic_light_position: Some(point(px(12.), px(12.))),
    }),
    window_background: WindowBackgroundAppearance::Blurred, // Opaque | Transparent | Blurred
    kind: WindowKind::Normal,                           // Normal | PopUp | Floating
    is_movable: true,
    is_minimizable: true,
    is_resizable: true,
    app_id: Some("com.yourco.app".into()),
    tabbing_identifier: Some("main".into()),
    ..Default::default()
}
```

- `Blurred` gives translucency-behind-window (vibrancy-ish). There is no fine-grained
  `NSVisualEffectView` material control exposed; for sidebar-style vibrancy you paint
  translucency yourself over the blurred window.
- `WindowKind::PopUp` = above-everything alert-style; `Floating` = floating panel —
  the basis for Spotlight-style palette windows (see Loungy).
- App menu bar: GPUI supports native macOS menus (`Menu`/`MenuItem` and
  `cx.set_menus(...)` on `App`; verify exact signature against gpui 0.2.2 source —
  Zed's `crates/zed` app menu wiring is the reference).
- gpui-component's `TitleBar` component pairs with `appears_transparent: true` for a
  custom in-content titlebar; `window_title` example in the repo shows it.

### 9.2 Global hotkeys — `global-hotkey` 0.8 (tauri-apps)

- Register/unregister `HotKey`s via `GlobalHotKeyManager`; events arrive on
  `GlobalHotKeyEvent::receiver()` (crossbeam channel) — poll it from a GPUI foreground
  task or set an event handler that posts into a GPUI channel.
- macOS: must be created on the main thread with a running event loop — GPUI's main
  thread satisfies this. Create the manager inside `app.run`.
- Requires Accessibility permission for global capture when unfocused; check and guide
  the user to System Settings → Privacy & Security → Accessibility. Make the shortcut
  user-configurable; unregister before re-registering.

### 9.3 Menu-bar status item — `tray-icon` 0.21 (tauri-apps)

- NSStatusItem on macOS; must be created on the main thread (compatible with GPUI).
  Icon + native menu (`tray_icon::menu::Menu`), events via `TrayIconEvent::receiver()`.
- For a menu-bar-only mode hide the Dock icon via AppKit `setActivationPolicy(.accessory)`
  through `objc2-app-kit` (GPUI does not expose activation policy itself — verify;
  Zed never needs it). Alternative: call NSApplication via `objc2` directly for full
  control, skipping tray-icon.
- `system_status_bar_macos` crate exists but is stale (objc2 0.4-era); prefer
  `tray-icon` or raw `objc2-app-kit`.

### 9.4 Keychain — `keyring` 4.x

```rust
let entry = keyring::Entry::new("com.yourco.app", "anthropic-api-key")?;
entry.set_password(&key)?;           // create or update
let key = entry.get_password()?;
entry.delete_credential()?;
```

- v4 API: pick a store at startup (`use_native_store` / `use_apple_keychain_store`
  via keyring-core `set_default_store`) or use the feature-flagged default
  (`apple-native` feature). Service and account names must be non-empty on macOS.
- Store provider API keys here, never in the SQLite DB or plain config files.

### 9.5 Notifications

- Quick & simple: `mac-notification-sys` 0.6.15 — one-call API, but built on the
  deprecated `NSUserNotificationCenter` and needs a bundle identifier hack when run
  outside an `.app` bundle.
- Correct: `objc2-user-notifications` 0.3 — real `UNUserNotificationCenter`, requires
  a signed `.app` bundle and an async permission request; more code, no deprecation
  risk. Choose this for production.
- In-app toasts (gpui-component `window.push_notification`) cover most "done/failed"
  UX without touching the system center; use system notifications only when the
  window is unfocused.

### 9.6 Auto-update

Nothing in GPUI. Standard answer is **Sparkle 2** (appcast RSS + EdDSA-signed
archives; delta updates; background checks):

- `slint-ui/sparklers` — event-driven safe Rust bindings to Sparkle 2 (from the Slint
  team; newer, cleaner API).
- `hankbao/sparkle-updater` — thin Sparkle/WinSparkle wrapper (`Updater::new()` +
  `check_for_updates()`), pragmatic and proven.
- Either way you must: bundle `Sparkle.framework` in `Contents/Frameworks`, set
  rpath `@loader_path/../Frameworks`, add `SUFeedURL` + `SUPublicEDKey` to
  Info.plist, publish an appcast (`generate_appcast` tool), and sign the app.
- Alternative: Homebrew cask distribution (updates via `brew upgrade`) — zero code,
  but no in-app UX.

---

## 10. Reference apps to mine

| Project | What to steal |
|---|---|
| **zed-industries/zed** (`crates/gpui/examples`, `terminal*`, `markdown`, `gpui_tokio`, menu wiring) | Canonical everything: window setup, actions, custom elements, terminal, HTTP streaming |
| **longbridge/gpui-component** (`crates/story`, `examples/`) | Component usage, theming, dock layout, markdown/editor examples |
| **Longbridge Pro** (closed source) | Proof gpui-component scales to a production trading app |
| **penso/arbor** | Agentic-coding app in GPUI: embedded terminal engine, daemon + MCP architecture, theme sync — closest analog to an AI-assistant app |
| **MatthiasGrandl/Loungy** | Launcher: `WindowKind::Floating` palette window, hotkey-driven UX, cmd-K lists |
| **0xErwin1/dbflux** | Keyboard-first app shell: sidebar, multi-tab editor, virtualized tables, command palette, toast system |
| **manyougz/velotype** | Markdown editor: block model, markdown parse/serialize, theme tokens, PDF/HTML export |
| **hedge-ops/gpui-tutorial**, **MatinAniss/gpui-book** | Learning resources, concept walkthroughs |
| **duanebester/gpui-todos** | Minimal global state + theme + blurred window example |
| **brscrt/create-gpui-app** | `cargo install create-gpui-app` project scaffolder |
| **edo-zhou/awesome-gpui** | The maintained awesome list for new finds |
| **143mailliw/hummingbird**, **polachok/helix-gpui**, **duanebester/pgui** | Music player / editor / DB client — misc patterns |

---

## 11. Skeleton main.rs boot pattern

```rust
use gpui::*;
use gpui_component::{button::Button, *};

actions!(app, [Quit, ToggleSidebar, NewChat]);

struct AppState {
    // entities live here: chats, sidebar, composer InputState, etc.
}

impl Render for AppState {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .key_context("App")
            .on_action(cx.listener(|_, _: &NewChat, _, cx| { /* ... */ cx.notify(); }))
            .child(
                h_flex().size_full()
                    .child(div().w(px(260.)).h_full().bg(theme.sidebar).child("Sidebar"))
                    .child(
                        v_flex().flex_1().h_full()
                            .child(div().flex_1().child("Transcript (TextView/markdown here)"))
                            .child(Button::new("send").primary().label("Send")
                                .on_click(cx.listener(|_, _, _, cx| cx.notify())))
                    )
            )
            // If not using Root, add: Root::render_dialog_layer/sheet/notification layers
    }
}

fn main() {
    gpui_platform::application()
        .with_assets(gpui_component_assets::Assets)
        .run(|cx| {
            gpui_component::init(cx);            // theme global, i18n, component keybindings — FIRST
            gpui_tokio_bridge::init(cx);         // tokio runtime for reqwest/SSE

            cx.bind_keys([
                KeyBinding::new("cmd-n", NewChat, Some("App")),
                KeyBinding::new("cmd-b", ToggleSidebar, Some("App")),
                KeyBinding::new("cmd-q", Quit, None),
            ]);
            cx.on_action(|_: &Quit, cx| cx.quit());

            // cx.set_menus(...)  // native macOS menu bar (see zed for exact API)

            cx.spawn(async move |cx| {
                let options = WindowOptions {
                    window_bounds: Some(WindowBounds::centered(size(1100., 760.), cx)),
                    titlebar: Some(TitlebarOptions {
                        title: None,
                        appears_transparent: true,
                        traffic_light_position: None,
                    }),
                    app_id: Some("com.example.app".into()),
                    ..Default::default()
                };
                cx.open_window(options, |window, cx| {
                    let view = cx.new(|_| AppState {});
                    cx.new(|cx| Root::new(view, window, cx))
                })
                .expect("failed to open window");
            })
            .detach();
        });
}
```

---

## 12. Entity / context cheat-sheet

Contexts (name them all `cx`):
- `App` — global: entity creation (`cx.new`), globals (`set_global`/`global`/`update_global`),
  windows (`open_window`), key bindings, menus, executors.
- `Window` — per-window: bounds, focus, scale factor, `open_modal`/`push_notification`
  (via gpui-component `WindowExt`), `remove_window`.
- `Context<T>` — per-entity: `notify()`, `emit(event)`, `observe`, `subscribe`,
  `listener`, `spawn`, `entity()`.
- `AsyncApp` — in `cx.spawn` closures: `entity.update(cx, ...)`, `open_window`,
  `background_executor()`.
- `AsyncWindowContext` — `spawn_in` variant with window access (`update_in`).

Entities:
- `Entity<T>` strong handle; `WeakEntity<T>` via `.downgrade()` — always capture weak
  in closures/callbacks.
- `entity.read(cx).field`, `entity.update(cx, |s, cx| { s.x = 1; cx.notify(); })`.
- Never re-enter `update`/`read` on an entity already being updated/rendered — panics
  ("cannot update ... while it is already being updated"). Same rule inside
  `defer_in` callbacks and `render_item` hooks: use the direct `&mut` reference or a
  plain snapshot field.
- Events: define an enum/struct, `cx.emit(MyEvent::X)` inside the entity; listeners
  `cx.subscribe(&entity, |this, src, ev, cx| ...).detach()` — store the `Subscription`
  or it drops. `subscribe_in` when you need `&mut Window`.
- `cx.observe(&entity, ...)` fires on the observed entity's `notify()`.
- Re-render trigger is always `cx.notify()`; nothing re-renders implicitly.

Actions & keys:
- `actions!(ns, [A, B])` or `#[derive(Action)]` for parameterized actions.
- `cx.bind_keys([KeyBinding::new("cmd-s", Save, Some("Context"))])` at startup.
- Element side: `.key_context("Context")` + `.on_action(cx.listener(Self::on_save))`.
- Key format: `cmd-`, `ctrl-`, `alt-`, `shift-` + key (`"up"`, `"enter"`, `"escape"`, …).

Async:
- Foreground: `cx.spawn(async move |this, cx| { ... this.update(cx, ...) ... }).detach()`.
- Background: `cx.background_spawn(async move { heavy() }).then(cx.spawn(|r, cx| ...)).detach()`.
- Periodic: loop on `cx.background_executor().timer(Duration)` inside a stored `Task`.
- Tasks cancel on drop — keep long-running `Task<()>` in the struct.

Globals:
- `impl Global for MyConfig {}`, `cx.set_global(...)`, `cx.global::<T>()`,
  `cx.update_global::<T, _>(...)`. Use for config/services (Arc'd), not for
  frequently-changing UI state. `cx.observe_global::<T>(...)` to react.

Layout quick ref:
- `div()` + Styled chain; `h_flex()`/`v_flex()` from gpui-component.
- Units: `px()`, `rems()`, `relative(0.5)`; Tailwind shorthands `.p_4()`, `.gap_2()`,
  `.size_full()`, `.flex_1()`, `.w_full()`.
- Scroll: `.overflow_y_scrollbar()`; absolute: `.relative()` parent + `.absolute().top_0()`.
- Conditional styles: `.when(cond, |el| ...)` (import `gpui::prelude::FluentBuilder`).
- No `z_index` on general elements — order siblings (later paints above) or nest.

Focus:
- `focus_handle: FocusHandle = cx.focus_handle()`, `.track_focus(&self.focus_handle)`,
  `self.focus_handle.focus(cx)`, `cx.on_focus_in/on_focus_out`.

Testing:
- `#[gpui::test] async fn t(cx: &mut TestAppContext) { ... }`; `VisualTestContext` for
  window-level simulation. See local skill `references/test.md`.

---

## 13. Risk list — what may not work (or bite you) in GPUI today

1. **Pre-1.0 API churn.** Every gpui release breaks APIs. Pin exact versions of all
   gpui* crates together; upgrading gpui means upgrading gpui-component in lockstep.
2. **One gpui version per graph.** crates.io gpui + git gpui (or two different git
   revs) in one build = confusing type-mismatch errors. gpui-component tracks gpui
   releases with a lag; check its Cargo.toml before bumping.
3. **Docs lag code.** Official story is "read the Zed source / Discord." The
   gpui-component docs site (`llms-full.txt`, per-component `.md` pages) is the best
   written reference; GPUI itself relies on examples + rustdoc.
4. **Tokio bridge is unofficial.** `gpui-tokio-bridge` wraps unpublished zed code. If
   it rots, fall back to `async-compat` or GPUI's `gpui_http_client`. Test SSE
   streaming end-to-end early — it's the app's lifeline.
5. **No built-in auto-updater, no Sparkle in-tree.** You own bundle plumbing
   (framework copy, rpath, appcast hosting, EdDSA keys, signing/notarization).
6. **macOS-only conveniences missing:** no activation-policy API (Dock hiding needs
   objc2), no true `NSVisualEffectView` material control (`Blurred` window background
   is all-or-nothing), no native notifications in GPUI itself.
7. **Terminal is bring-your-own.** `alacritty_terminal` gives you the model, not the
   view. IME, selection, hyperlinks, cursor blink, and an efficient paint path are
   yours to write (Zed's terminal_view is ~4k lines for a reason).
8. **Markdown edge cases.** TextView covers commonmark-ish content + code blocks;
   tables/GFM extensions/math need verification against your real model output.
   Inline plugins aren't supported yet (block plugins only). Long streaming documents
   re-parse per render — partition per message.
9. **Tray/hotkey crates assume winit-style loops.** They work (main-thread Cocoa loop
   is what GPUI runs), but event delivery is channel-polling — you must pump
   `GlobalHotKeyEvent::receiver()` / `TrayIconEvent::receiver()` from a GPUI task.
10. **Accessibility/permissions UX is on you:** global hotkeys (Accessibility),
    notifications (bundle + UNUserNotificationCenter auth), Keychain prompts on first
    access. None of it is wired by the framework.
11. **Windows/Linux parity is secondary.** Fine if macOS-only; if cross-platform later,
    test `font-kit` vs platform text stacks and the wayland/x11 feature matrix early.
12. **Entity lock panics are the #1 runtime footgun.** Re-entrant `update` on the same
    entity (incl. via `defer_in`, subscriptions that bounce back, render hooks reading
    external entities) panics at runtime, not compile time. Design unidirectional
    data flow; snapshot for render.
13. **Binary size & build time.** Hello-world release ≈ 12 MB; the zed git-dependency
    path builds a large graph (expect long cold builds). crates.io gpui is lighter but
    still pulls Metal/taffy/tree-sitter stacks; `tree-sitter-languages` adds ~25 C
    grammars to compile.
