# Project History

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
