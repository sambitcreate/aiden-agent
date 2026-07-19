# Project Context

## Identity and repository

- **App:** Aiden Agent
- **Repository:** `https://github.com/sambitcreate/aiden-agent`
- **Ownership:** Privately owned, self-contained Electron codebase with no external host application or private SDK requirement.
- **Purpose:** A native macOS AI workspace agent that chats with local or hosted models and can act inside user-selected folders with explicit permissions.

## Current architecture

- **Desktop runtime:** Electron. `main/index.ts` owns lifecycle, windows, application menus, shortcuts, and cleanup.
- **Platform boundary:** `main/platform.ts` centralizes Electron exports, logging, native dialogs, theme, microphone permissions, and renderer notifications.
- **Security bridge:** `renderer/preload.ts` exposes `window.aidenAPI` through `contextBridge`. Renderer invokes are prefix-allowlisted and notifications are channel-allowlisted. Renderer sandboxing and context isolation are enabled; Node integration is disabled.
- **Renderer:** React 19, TanStack Router, TanStack Query, Tailwind CSS 4, local UI components in `renderer/components/ui.tsx`, Radix primitives, cmdk, Sonner, and Lucide. The local component layer preserves the established macOS visual contract: translucent materials, native-density controls, pinned/collapsible/resizable split views, measured toolbar/footer scrolling, command pickers, fields, menus, and dialogs.
- **Build:** Vite emits `build/renderer`; esbuild emits `build/main/index.js` and `build/preload/preload.cjs`; electron-builder packages the `.app`, DMG, and ZIP.
- **Persistence:** JSON under `app.getPath("userData")`; chat mutations are serialized across the shared index so background metadata updates cannot race message writes. Provider keys and MCP OAuth sessions are encrypted with Electron `safeStorage`.

## Agent and tools

- Pi is embedded in-process through `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`.
- Workspace tools include `read_file`, `list_dir`, `glob`, `grep`, `edit_file`, `write_file`, and `run_command`.
- Every filesystem path is resolved inside the active workspace root. Commands run with the workspace root as their working directory.
- Permission modes are Full, Ask, and No Access. Ask mode pauses write/edit/command calls for inline Allow or Deny approval.
- Git helpers report branch and uncommitted count, switch branches, and create branches.
- Agent Skills are loaded from workspace and user `.agents/*/SKILL.md` folders.
- MCP supports stdio, HTTP, and SSE transports plus native-app OAuth with a loopback PKCE redirect and encrypted tokens.
- Optional Exa search becomes an agent tool when enabled and configured.

## Models, attachments, and voice

- Providers support OpenAI-compatible and Anthropic-compatible APIs, with presets for common hosted services and local Ollama/LM Studio endpoints.
- A new chat immediately uses the first prompt or attachment name as a temporary title, then generates a concise title in the background with that chat's selected model. Manual renames win over late generated results; title failures leave the temporary title in place. The title-model resolver is isolated so a dedicated model picker can override the chat model later.
- The models.dev catalog is cached for 24 hours and supplies vision, tool, reasoning, open-weight, and context metadata.
- Text files are inlined with size limits; images are base64 encoded and sent only to vision-capable models.
- Cloud transcription supports configured OpenAI and Gemini providers.
- Local transcription uses bundled `sherpa-onnx-node` and downloaded Parakeet models. PCM conversion happens in the renderer; recognition happens in the main process.

## Privacy boundary

- Local data and credentials remain on the Mac unless a configured feature sends a request.
- Hosted model calls, cloud transcription, Exa, remote MCP servers, models.dev catalog refreshes, and model downloads require network access and share the minimum data needed for that request.
- A local-only session requires a local model endpoint, local voice, Exa disabled, and no remote MCP servers.

## Important files

- `main/index.ts` — Electron lifecycle and main window.
- `main/platform.ts` — Electron platform facade and native IPC handlers.
- `renderer/preload.ts` — allowlisted context bridge.
- `renderer/components/ui.tsx` — repository-owned component system.
- `PRODUCT.md` — product register, users, personality, anti-references, and design principles for interface work.
- `main/services/llm-client.ts` — Pi agent loop, streaming, and approvals.
- `main/services/coding-tools.ts` — workspace-confined tools.
- `main/services/config-store.ts` — providers, settings, skills, MCP servers, and workspaces.
- `main/services/chat-store.ts` — persisted chat history.
- `main/services/secrets.ts` and `main/services/mcp-oauth-store.ts` — encrypted secrets.
- `main/services/mcp.ts` and `main/services/mcp-oauth.ts` — MCP clients and OAuth.
- `main/services/parakeet.ts` and `main/services/local-models.ts` — on-device transcription.
- `vite.config.ts` and `scripts/build-electron.mjs` — independent builds.
- `README.md` — current stack, privacy boundary, and commands.

## Current verification status

- Shared standard and confirmation modal entrances use the centered `0.8` to `1` zoom with a slight fade-in; the Add MCP server path was visually verified in the running Electron development app.
- UI element and UX hardening pass: the composer now floats over the continuous transcript surface; settings use a wider, searchable, grouped navigation sidebar with readable descriptions and placeholders; settings dialogs keep actions visible; and the split view overlays/auto-collapses at compact widths.
- Validated settings/chat fixes include draft provider testing, temporary MCP connection tests, safe external link handling, send-draft preservation on failure, footer-growth auto-follow, active local-model cleanup, and explicit Exa key removal behavior.
- `npm run type-check`, `npm run lint`, and `npm run build`: passing after the UI element and UX hardening pass.
- `npm run type-check`: passing after the Electron migration and interface-fidelity recovery.
- `npm run lint`: passing after the Electron migration and interface-fidelity recovery.
- `npm run build`: passing after the interface-fidelity recovery; renderer still produces a large single main chunk and should be code-split later.
- `npm run package`: passing; produced a signed arm64 `Aiden Agent.app` with bundle ID `com.sambitcreate.aiden-agent`.
- Packaged-app smoke test: passing; the renderer loaded from the app archive, `window.aidenAPI` was present, the seven seeded providers loaded over IPC, and native theme IPC returned successfully.
- Development visual check: passing for the chat shell, searchable settings navigation, provider dialog, workspace menu, sidebar collapse/expand, and persisted pointer resizing.
- Background chat-title verification: 8 focused title/store tests, `npm run type-check`, `npm run lint`, and `npm run build` pass. The production build retains the existing large-renderer-chunk warning.
