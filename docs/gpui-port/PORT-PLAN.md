# Aiden Agent → GPUI + Rust Port Plan

Status: active | Branch: `gpui-rust` | Research: `research-main-process.md`, `research-renderer-ui.md`, `research-data-providers.md`, `research-gpui-patterns.md`

## Goal

Reimplement Aiden Agent (~105K LOC TypeScript, Electron + React) as a native macOS app in Rust using GPUI 0.2 + gpui-component 0.5. Preserve on-disk JSON formats so existing `~/.aiden` installs remain readable.

## Architecture (target)

Cargo workspace `rust/` at repo root:

| Crate | Ports from | Contents |
|---|---|---|
| `aiden-core` | `main/services/*-core.ts`, `renderer/shared/*` | Pure domain logic: types, chat-store core, config, generation timeline, compaction, keybindings, appearance tokens. Zero UI/zero async runtime deps. serde types = wire + disk contracts. |
| `aiden-data` | `main/services/data-store.ts`, `config-store-core.ts`, `secret-map-core.ts`, `aiden-config-dir.ts` | Durable JSON store (stage→fsync→rename), config dir (`~/.aiden` + app support), keyring-backed secrets. |
| `aiden-providers` | pi-ai surface used by Aiden: anthropic, google, openai-completions, openai-responses, codex-responses; `model-runtime-core.ts`, `models.ts` | Provider trait, `AssistantMessageEvent` stream (14 variants), SSE via reqwest-eventsource, model catalog, token estimation, context compaction glue. |
| `aiden-mcp` | `main/services/mcp-*.ts` | rmcp-based client, stdio/http servers, OAuth loopback 41390, tool inventory. |
| `aiden-agent` | `main/services/assistant/`, tool loop, `coding-tools.ts` | Agent tool loop, tool defs, approvals. |
| `aiden-scheduler` | `main/services/schedule-*.ts` | cron (croner→`cron` crate), notifications, scheduled tasks. |
| `aiden-mac` | `main/platform.ts`, shortcuts, updater, dictation | macOS integration: keyring, hotkeys, tray, notifications, objc2 vibrancy. |
| `aiden-ui` (bin `aiden`) | `renderer/**`, `main/windows/`, `main/index.ts` | GPUI app: shell, sidebar, chat pane, composer, settings, onboarding, pill window, terminal drawer. |

Later/deferred: `aiden-subagents` (authority system, 21.3K LOC TS), computer-use broker reuse (`native/computer-use-broker` stays as-is).

## Dependency pins

`gpui = "0.2.2"`, `gpui_platform = { version = "0.2", features = ["font-kit"] }`, `gpui-component = "0.5"`, `gpui-component-assets = "0.5"`, `gpui-tokio-bridge`, `tokio`, `reqwest 0.12` (rustls, stream), `reqwest-eventsource 0.6`, `serde/serde_json/schemars`, `thiserror`, `anyhow` (bin only), `keyring 4` (apple-native), `directories`, `cron`+`chrono-tz`, `fs4` or manual fsync, `sha2`, `parking_lot`, `alacritty_terminal 0.26` (terminal phase), `portable-pty`.

## Phases

- **P1 Research** — DONE (4 docs in this folder).
- **P2 Plan** — this document.
- **P3 Workspace scaffold** — workspace, all crates compile, GPUI hello-window boots with gpui-component theme, CI-shaped `cargo build/clippy/test` scripts.
- **P4 Core+data+providers** — port domain types & stores; provider streaming against real SSE; unit tests mirroring TS test expectations for the `*-core` modules.
- **P5 UI shell + chat flow** — window, titlebar, sidebar (chat list), chat pane with streaming message list (TextView markdown), composer, model picker (data from catalog), theme (4 presets × light/dark from `renderer/shared/appearance.ts`).
- **P6 Remaining surfaces** — settings sections, onboarding flow, pill window, scheduled tasks, profile/usage views, command palette, terminal drawer, approvals/dialogs, assistant panel.
- **P7 Verification** — `cargo build --release`, `clippy -D warnings`, `cargo test`, feature checklist against PRODUCT.md.

## Porting rules

1. Disk formats byte-compatible with TS versions (same paths, same JSON keys).
2. `*-core.ts` modules port first, literally; bindings become thin GPUI/async adapters.
3. No tokio types in `aiden-core`; async lives in service crates behind traits.
4. Streaming events forwarded to UI via channel → foreground task → `cx.notify()` (batched, mirroring renderer rAF batching).
5. Renderer epoch/invalidation pattern → GPUI entity generation counter + cancellation token.
6. KaTeX: render source text (degraded) — no math engine in phase 1.
7. models.dev / Artificial Analysis stay explicit-user-action-only, never bundled credentials.
