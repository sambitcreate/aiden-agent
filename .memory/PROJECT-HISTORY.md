# Project History

### 2026-07-19 — Plan Pi-owned plug-and-play providers

- Audited the current Electron provider path and Pi's `0.80.10` provider, model, auth, dynamic refresh, custom-provider, and persistence contracts with three independent review lanes.
- Confirmed that Aiden embeds Pi's Agent but bypasses Pi's provider runtime through seven seeded providers, two compatibility stream adapters, key-only credentials, and fabricated model metadata.
- Chose the lean public `pi-ai` `Models` integration over the full coding-agent package: all Pi built-ins in Settings, only authenticated/available models in the composer, encrypted type-tagged credentials, generic provider-owned auth IPC, and declarative custom endpoints.
- Added `docs/pi-provider-integration-plan.md` with the target architecture, security boundaries, legacy ID/key/config migration, DTO and IPC contracts, phased file-level implementation, test matrix, PR sequence, and definition of done.
- No production implementation or dependency update was made in this planning pass.

### 2026-07-19 — Complete the ChatGPT/Codex-inspired UI and trust polish

- Unified light/dark elevation, hover, pressed, focus, disabled, popover, dialog, toast, switch, radio, field, and list-row states across the repository-owned component system, with quieter motion and reduced-motion fallbacks.
- Reworked composer permission copy and Full Access confirmation, made permissions immutable during generation, and upgraded inline approvals with human tool labels, explicit one-time scope, recoverable decisions, keyboard focus management, and distinct running/finished/failed/blocked activity.
- Made workspace permission or folder changes cancel in-flight and initializing generations, including a tombstone handoff that prevents a cancelled start from reaching `agent.continue()`.
- Polished settings, editor/branch/model controls, copy and attachment actions, terminal tabs and resizers, strict scroll-edge fades, content-growth auto-follow, medium-width composer sizing, and compact sidebar overlay focus/isolation/Escape behavior.
- Completed three phase-specific two-reviewer loops and a final two-reviewer whole-diff pass. The repository's 18-test suite, including the new mutating-tool summary assertion, plus type-check, lint, production build, signed macOS packaging, and packaged-app settings/IPC smoke verification pass. The critical cancellation, focus, and scroll paths were source/runtime/reviewer validated but do not yet have dedicated automated tests; the existing large renderer chunk warning remains follow-up performance work.

### 2026-07-19 — Recreate ChatGPT/Codex-inspired interface elements

- Added an interactive, self-contained UI specimen covering button variants and state matrices, fields, search, toggles, chips, permission menus, sidebar rows, composer context, inline approvals, toasts, and Full Access confirmation.
- Recreated the useful shipped elevation ladder with separate hairline, rest, hover, pressed, popover, toast, composer, and dialog recipes in light and dark mode.
- Documented hover, pressed, keyboard-focus, disabled, primary, ghost, popover, and reduced-motion behavior in the main inspiration audit without changing production Aiden components yet.

### 2026-07-18 — Map ChatGPT/Codex desktop UI inspiration

- Inspected the installed ChatGPT-branded Codex Electron bundle, compiled renderer labels, routes, commands, layout tokens, and motion CSS, then mapped the inferred project/chat/approval/review/terminal/browser flows.
- Confirmed the local `ghidra-mcp` checkout is not currently deployable on this Mac because Ghidra, its localhost server, and Maven are unavailable; documented why renderer-package inspection is more useful than native-shell decompilation for Electron UI research.
- Added `docs/chatgpt-desktop-ui-inspiration.md` with a borrow/adapt/avoid ledger, exact motion timings, Aiden parity gaps, and a prioritized implementation slice.

### 2026-07-18 — Add the preferred-editor split control

- Added a native-density Open split control at the start of the chat toolbar; its primary segment opens the active workspace in the global preferred editor, while the chevron lists installed supported editors and Finder.
- Added curated main-process `.app` discovery with bundle/name fallbacks, duplicate Antigravity handling, a short cache refreshed when the menu opens, distinct native app artwork, and Finder kept last.
- Added workspace-ID-scoped launch IPC that re-resolves the stored folder, validates it is still a directory, rejects unknown or removed editors, and launches with `/usr/bin/open -b` argument arrays without a shell.
- Added global preference persistence under `aiden-agent.preferredEditorId`, automatic fallback when an editor disappears, actionable launch toasts, compact icon-only toolbar behavior, the File-menu `⌘O` command, and accessible split-control labels.
- Added focused tests for discovery filtering and duplicate bundles, preference fallback/persistence, unknown IDs, missing/non-directory folders, refresh-before-launch, and safe launch arguments.
- Verified the exact installed menu and native icons in the running dark-mode app at regular and compact widths, launched the active Downloads workspace in Cursor, and confirmed `npm test`, `npm run type-check`, `npm run lint`, and `npm run build` pass.

### 2026-07-18 — Generate concise chat titles after the first prompt

- Kept first-send navigation immediate by seeding the chat title from the normalized prompt or first attachment name, then launching a separate tool-free title request alongside the accepted first turn.
- Defaulted title generation to the provider and model used by that chat, with a single resolver boundary ready for a future dedicated title-model picker.
- Added a short 3–8-word coding-title prompt, strict one-line/sidebar-safe normalization, a 15-second timeout, and silent fallback to the initial seed.
- Preserved manual renames with a compare-and-set title update, deduplicated in-flight title work, serialized the shared chat index/message writes, and pushed successful metadata updates into React Query caches over an allowlisted notification.
- Split the chat persistence core from its Electron user-data binding so first-message, manual-rename, concurrent-write, and shared-index behavior can run under Node's test runner.
- Added 8 focused tests; `npm test`, `npm run type-check`, `npm run lint`, and `npm run build` pass.

### 2026-07-18 — Workspace terminal drawer

- Added a bottom, resizable terminal drawer with a Cmd/Ctrl-J toggle, new-terminal, horizontal/vertical split, clear, close, and per-session tabs.
- Terminal processes are real PTY-backed shells that start in a selected folder workspace. They have normal macOS user permissions (not filesystem confinement); IPC never accepts an arbitrary executable or working path, sessions are renderer-owned, and workspace revocation, workspace switches, or window closure terminates active sessions.
- Terminal sessions open immediately without a confirmation prompt; `none`/removed/repointed workspaces immediately terminate their sessions, direct process groups are signalled during cleanup, replay output is sequenced, and the drawer remains keyboard accessible through hide/show, theme changes, and resize controls.
- Widened the workspace switcher menu so workspace names and paths have a usable reading width.
- Refined the terminal’s visual hierarchy after live inspection: chat now claims the flex remainder cleanly, the terminal defaults to a compact height with a chat-preserving cap, and the chrome is a rounded closeable tab strip with a dedicated add-tab action rather than a large titled panel.
- Matched T3 Code’s closed-drawer lifecycle: the terminal is now unmounted from the chat layout when hidden, preventing a zero-height but still-painted bottom surface.
- Corrected the chat/terminal flex boundary after screenshot verification: the chat viewport again fills the available column, while its parent clips overflow and yields space only when the terminal drawer is mounted.

### 2026-07-18 — Standardize modal entrance motion

- Replaced the shared dialog's upward slide with a centered `0.8` to `1` zoom and slight fade-in for every standard and confirmation modal.
- Preserved the reduced-motion fallback and verified the Add MCP server dialog in the running Electron development app.
- Confirmed `npm run type-check`, `npm run lint`, and `npm run build` pass.

### 2026-07-18 — Refine the chat and settings interface

- Reworked the composer from a full-width footer into a centered floating cluster over the continuous transcript background, with an attached workspace context strip and restrained elevation.
- Preserved measured footer padding and auto-follow as the composer grows, kept approvals visible above the composer, retained failed send drafts, and tightened empty/model/permission copy without adding new actions.
- Raised description and placeholder contrast, standardized settings consequence/privacy copy, kept dialog actions visible, added compact split-view behavior, and improved keyboard/accessibility states.
- Reshaped settings navigation around a wider reference-led sidebar with a prominent Back to app action, real settings search, grouped Agent/App rows, larger line icons, and a clear full-width selection pill; matched the main sidebar's spacing and hierarchy without adding new product concepts.
- Fixed provider tests to use unsaved draft endpoints without persisting them, made MCP tests temporary instead of replacing cached runtime connections, cleared deleted active voice models, clarified Exa key removal, and protected the Electron window from model-supplied external navigation.
- Added `PRODUCT.md` and Impeccable live configuration so future UI work preserves the product register and existing visual identity.
- Verified the chat shell, settings, settings filtering, provider dialog, and light/dark appearance in the running Electron app; type-check, lint, and production build pass.

### 2026-07-18 — Recover the established macOS interface primitives

- Audited the pre-migration renderer build, source map, component contract, historical screenshots, and the thin native launcher to identify what the first local replacement had lost.
- Rebuilt the repository-owned UI layer around semantic light/dark tokens, translucent Electron vibrancy, native-density controls, glass toolbar actions, macOS-style sidebars, fields, menus, dialogs, and command pickers.
- Restored a persistent pointer-resizable split view, animated collapse, a pinned sidebar toggle with `Control-Command-S`, measured sticky toolbars/composers, guarded chat auto-follow, and the scroll-to-bottom control.
- Verified the chat shell, settings, provider dialog, workspace menu, collapse/expand, resize persistence, type-check, lint, and production build without adding an external UI/runtime dependency.

### 2026-07-18 — Replace the hosted runtime with repository-owned Electron code

- **Goal:** Make Aiden Agent independently buildable, runnable, and packageable from its private GitHub repository.
- **Runtime:** Replaced the former desktop bridge with Electron lifecycle, BrowserWindow, menus, native theme, microphone permissions, safe storage, shell access, global shortcuts, and IPC.
- **Security:** Added a context-isolated preload that exposes `window.aidenAPI`, allowlists renderer invoke prefixes and notifications, disables renderer Node integration, enables sandboxing, and keeps credentials in the main process.
- **UI:** Replaced the former component dependency with repository-owned React components backed by Radix UI, cmdk, Sonner, Lucide, and local Tailwind design tokens.
- **Build:** Replaced all host CLI scripts with Vite, esbuild, ESLint, TypeScript, and electron-builder commands. Added a tracked app icon and macOS microphone usage description.
- **Cleanup:** Removed obsolete host configuration, SDK paths, portable-export documentation, and the unused second settings window.
- **Privacy:** Documented which data stays local and which optional cloud/model/search/MCP features make network requests.
- **Verification:** Type-check, lint, production build, macOS packaging, code-signature verification, and packaged-app launch smoke tests pass. The running renderer exposed `window.aidenAPI`, rendered the workspace/chat shell, loaded seven providers over IPC, and read native theme state.

### 2026-07-18 — Rename and republish as Aiden Agent

- Renamed product metadata, UI copy, route titles, MCP identity, storage keys, documentation, and memory to Aiden Agent / `aiden-agent`.
- Reinitialized the repository and made `https://github.com/sambitcreate/aiden-agent` the only Git remote.

### 2026-07-17 — Workspace coding agent

- Added folder-backed workspaces, workspace-scoped chat history, Full/Ask/No Access permissions, inline tool approvals, confined filesystem tools, command execution, Git status, and branch actions.
- Embedded the Pi agent loop in-process for streaming and multi-step tool calling across OpenAI-compatible and Anthropic-compatible models.

### 2026-07-17 — MCP, Skills, search, attachments, and shortcuts

- Added MCP stdio/HTTP/SSE connections, loopback PKCE OAuth, encrypted tokens, Agent Skill discovery, optional Exa search, file/image attachments, a focus shortcut, and a dictation shortcut.
- Added models.dev capability metadata to gate image attachments and describe model capabilities.

### 2026-07-17 — On-device Parakeet voice

- Added `sherpa-onnx-node`, Parakeet model download/management, 16 kHz PCM conversion, local transcription, model activation, progress, cancellation, deletion, and dictation settings.
- Fixed settings persistence so local voice provider/model and dictation settings are accepted by the backend whitelist.

### 2026-07-17 — Chat and interface foundation

- Built provider configuration, encrypted API keys, chat persistence, streaming Markdown, math and code rendering, searchable model selection, chat history, settings, light/dark appearance, and workspace-aware composer UI.
