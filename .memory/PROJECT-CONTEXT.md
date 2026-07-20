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
- **External editors:** `main/services/external-editors.ts` discovers a curated set of installed macOS editors from bundle metadata and standard application locations, deduplicates related bundles, caches native icons, and opens only a stored workspace folder through `/usr/bin/open -b` without a shell. The renderer stores the global preference under `aiden-agent.preferredEditorId`; Finder is always the final fallback.
- **Renderer:** React 19, TanStack Router, TanStack Query, Tailwind CSS 4, local UI components in `renderer/components/ui.tsx`, Radix primitives, cmdk, Sonner, and Lucide. The local component layer preserves the established macOS visual contract: translucent materials, native-density controls, a light/dark elevation ladder, shared hover/pressed/focus/disabled states, collapsible/resizable split views with compact focus isolation, measured toolbar/footer scrolling, content-aware scroll-edge fades, command pickers, fields, menus, and dialogs.
- **Build:** Vite emits `build/renderer`; esbuild emits `build/main/index.js` and `build/preload/preload.cjs`; SwiftPM builds a background helper app for Apple Foundation Models; electron-builder packages the `.app`, DMG, and ZIP.
- **Persistence:** JSON under `app.getPath("userData")`; chat mutations are serialized across the shared index so background metadata updates cannot race message writes. Provider keys and MCP OAuth sessions are encrypted with Electron `safeStorage`.

## Agent and tools

- Pi is embedded in-process through `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`.
- Workspace tools include `read_file`, `list_dir`, `glob`, `grep`, `edit_file`, `write_file`, and `run_command`.
- Every filesystem path is resolved inside the active workspace root. Commands run with the workspace root as their working directory.
- Permission modes are Full, Ask, and No Access. Ask mode pauses write/edit/command calls for inline Allow once or Deny approval. Permission, folder, and workspace changes cancel both active and initializing generations before any newly disallowed tool continuation can begin.
- On an untouched new chat, the composer folder control opens a searchable workspace plate and can reassign that same empty chat without leaving a duplicate. “Don’t work in a workspace” creates a private, collision-safe `~/aiden/<word-word-word>` scratch folder using three- or four-letter words, persists it as an Ask-mode workspace, and binds the chat to it. Chats with messages cannot be moved this way.
- Git IPC is workspace-ID scoped: main re-resolves the stored directory and rejects No Access workspaces instead of accepting renderer-provided paths. Folder grants come from a main-process system picker. Permission changes, workspace removal, and renderer teardown abort active Git operations.
- `main/services/git.ts` runs direct argv-only, noninteractive Git subprocesses with bounded output, read/mutation timeouts, process-group cancellation, path/credential-redacted failures, inherited Git-routing-variable removal, NUL-safe porcelain parsing, one-second bounded caches with mutation epochs, and a mutation queue keyed by Git's canonical common directory.
- Git status reports the current, detached, or unborn ref, uncommitted count, upstream, ahead/behind divergence, default branch, remotes, and local/remote refs. Tracking information uses local refs and is labeled “last fetched”; Aiden never fetches implicitly. The composer branch menu polls local state, switches or creates local branches, and can create an isolated branch checkout under Electron `userData/worktrees`.
- Managed worktrees are persisted as separate workspaces with the source permission and ownership provenance. Creation preserves nested workspace scope and rolls back both Git and filesystem state on failure. Explicit deletion refuses dirty checkouts and deletes the managed branch only when it still points to its original creation commit.
- Agent Skills are loaded from workspace and user `.agents/*/SKILL.md` folders.
- MCP supports stdio, HTTP, and SSE transports plus native-app OAuth with a loopback PKCE redirect and encrypted tokens.
- Optional Exa search becomes an agent tool when enabled and configured.

## Models, attachments, and voice

- Providers support OpenAI-compatible and Anthropic-compatible APIs, with presets for common hosted services and local Ollama/LM Studio endpoints.
- A new chat immediately uses the first prompt or attachment name as a temporary title, then generates a concise title in the background. Provider Settings offers Automatic, Apple Foundation Models, or the selected chat model. Automatic prefers Apple on supported macOS 26+ Apple Intelligence hardware when the model is ready; the Apple-only mode never silently falls back to a network model after a native attempt. Manual renames win over late generated results, and failures leave the temporary title in place. Successful background title replacements fade the temporary sidebar title out over 200ms, then run a 500ms character-by-character opacity and 2px-rise reveal; Reduce Motion renders the final title immediately.
- A release-generated static model-capability snapshot supplies vision, tool, reasoning, open-weight, and context metadata. The app reads it locally from the package and never refreshes it at runtime.
- Text files are inlined with size limits; images are base64 encoded and sent only to vision-capable models.
- Cloud transcription supports configured OpenAI and Gemini providers.
- Local transcription uses bundled `sherpa-onnx-node` and downloaded Parakeet models. PCM conversion happens in the renderer; recognition happens in the main process.

## Privacy boundary

- Local data and credentials remain on the Mac unless a configured feature sends a request.
- Apple Foundation Models title prompts stay on-device. Electron main launches the bundled background helper app through LaunchServices and exchanges one bounded, versioned JSON request through a private temporary directory that is deleted after completion.
- Hosted model calls, cloud transcription, Exa, remote MCP servers, and model downloads require network access and share the minimum data needed for that request. Model-catalog refreshes happen only while creating release artifacts.
- A local-only session requires a local model endpoint, local voice, Exa disabled, and no remote MCP servers.

## Important files

- `main/index.ts` — Electron lifecycle and main window.
- `main/platform.ts` — Electron platform facade and native IPC handlers.
- `renderer/preload.ts` — allowlisted context bridge.
- `renderer/components/ui.tsx` — repository-owned component system.
- `docs/chatgpt-desktop-ui-inspiration.md` — installed ChatGPT/Codex desktop flow, element, and motion audit with an Aiden-specific borrow/adapt/avoid backlog.
- `docs/chatgpt-ui-element-specimen.html` — interactive light/dark recreation of the recommended buttons, fields, menus, composer, approvals, shadows, and hover/focus/pressed states.
- `PRODUCT.md` — product register, users, personality, anti-references, and design principles for interface work.
- `main/services/llm-client.ts` — Pi agent loop, streaming, and approvals.
- `main/services/coding-tools.ts` — workspace-confined tools.
- `main/services/config-store.ts` — providers, settings, skills, MCP servers, and workspaces.
- `main/services/chat-store.ts` — persisted chat history.
- `main/services/chat-title.ts` and `main/services/chat-title-routing.ts` — title policy, native/chat-model routing, seed fallback, and manual-rename safety.
- `main/services/foundation-models-connection.ts` — macOS platform boundary and signed helper-app transport; its adjacent core module owns pure availability and protocol policy.
- `native/apple-foundation-models` — SwiftPM helper app, versioned JSON protocol, structured Foundation Models title generation, and native tests.
- `main/services/scratch-workspace.ts` — readable three-word scratch names and exclusive `~/aiden` directory creation.
- `main/services/git.ts` — structured Git process boundary, status parsing/cache, per-repository mutation serialization, branch actions, and managed worktrees.
- `main/services/git.test.ts` — real-repository coverage for unusual paths/refs, divergence, concurrency, process bounds, and worktree lifecycle.
- `renderer/components/workspace-picker.tsx` — the new-chat searchable workspace/scratch option plate.
- `main/services/secrets.ts` and `main/services/mcp-oauth-store.ts` — encrypted secrets.
- `main/services/mcp.ts` and `main/services/mcp-oauth.ts` — MCP clients and OAuth.
- `main/services/parakeet.ts` and `main/services/local-models.ts` — on-device transcription.
- `vite.config.ts` and `scripts/build-electron.mjs` — independent builds.
- `README.md` — current stack, privacy boundary, and commands.

## Planned provider-runtime migration

- `docs/pi-provider-integration-plan.md` is the source-grounded plan for replacing Aiden's seven-provider/two-protocol adapter with Pi's provider-owned `Models` runtime.
- The plan uses public `@earendil-works/pi-ai` directly, keeps provider runtime objects and credentials in Electron main, lists every Pi provider in Settings, and exposes only Pi-available models in the composer.
- The plan preserves declarative local/custom endpoints but deliberately excludes arbitrary executable Pi extensions until Aiden has a separate trusted plugin design.
- Implementation has not started. Aiden's lockfile remains on Pi `0.80.6`; the plan targets a paired, exact reviewed Pi release beginning with `0.80.10` because the needed provider auth/refresh contract changed in `0.80.8`.

## Current verification status

- Generated-title reveal: notification-scoped sidebar animation, a 200ms temporary-title fade followed by a bounded 500ms per-character reveal, accessible unsplit text, and reduced-motion behavior are implemented without another animation dependency. Three focused timing/order tests bring the TypeScript suite to 64 tests; type-check, lint, and production build pass.
- Apple Foundation Models titles: the macOS-gated helper, title routing, Provider Settings state, process ownership, cancellation, immediate prompt-file deletion, package filtering, and nested helper signature passed two fresh reviews against the Foundation Models skills repository and T3 Code. All validated findings were fixed. The 61-test TypeScript suite, 4-test Swift suite, type-check, lint, production build, unpacked package, clean asar inspection, strict helper signature check, and real development/packaged on-device title generation pass. The pre-existing outer-app sealed-resources signing issue remains separate.
- Git foundation: 15 focused real-repository tests and the full 37-test suite pass, along with type-check, lint, and the production renderer/main/preload build. Three independent backend, correctness, and UI reviews were completed against T3 Code and the documented ChatGPT/Codex references; their workspace authorization, cancellation/rollback, cache-race, linked-worktree, process isolation, managed cleanup, and interaction-state findings were resolved. An earlier live Electron pass verified the compact menu, creation disclosure, autofocus, consequence copy, and layered Escape/focus return; the post-review recheck was blocked by a locked Mac, so its changed states were source/build validated.
- New-chat workspace plate: the searchable anchored UI, keyboard filtering, and existing-workspace reassignment passed live Electron inspection. Scratch naming, collision retry, and empty-chat-only moves are covered by focused tests; the full 22-test suite, type-check, lint, production renderer build, and Electron main/preload build pass.
- The 2026-07-19 production UI/trust pass completed three phase-specific two-reviewer loops and a final two-reviewer whole-diff pass. Shared interactions, permissions/approvals, compact navigation, content-aware scroll edges, and responsive composer controls pass the repository's 18-test suite, type-check, lint, production build, signed macOS packaging, live light/dark inspection, and packaged-app settings/IPC smoke verification. The critical cancellation, focus, and scroll paths were source/runtime/reviewer validated but still need dedicated automated tests.
- Shared standard and confirmation modal entrances use a centered `.98` to `1` scale, 4px rise, and slight fade-in; reduced-motion mode removes the transform.
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
- Open-in-editor verification: the live menu detects Cursor, VS Code, Zed, Antigravity, Xcode, Android Studio, OpenCode, T3 Code, and Finder on this Mac; native icons, compact icon-only behavior, the preferred `⌘O` marker, and a real Cursor launch against the active workspace were verified. Focused launcher/preference tests, type-check, lint, and production build pass.
