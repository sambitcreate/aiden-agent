# Plan: Multi-Provider AI Chat Client (v1 — Core)

## Context

The user wants a native macOS AI chat app: connect any local backend (LM Studio, Ollama,
vLLM, llama.cpp) or hosted API (OpenAI-compatible or Anthropic/Claude-compatible), pick a
model, and chat with streamed responses saved to a chat-history sidebar. Preset providers
(OpenAI, Anthropic, Gemini, DeepSeek, Kimi/Moonshot) with API-key entry, plus custom
endpoints. Light/dark/auto appearance. In-app full-screen settings.

The full vision also includes MCP servers, Skills (tool-like capabilities), and an Exa
web-search tool. Per the user's decision, **this build delivers the solid core**; MCP +
Skills + Exa tool-calling ship as a focused **phase 2** on top of this foundation (they
share the same tool-calling loop, so grouping them avoids stubs now). Skills are defined
as tool-like capabilities, so they belong with phase 2, not here.

The template is greenfield: TanStack Router (memory history) + React Query are wired, the
`SplitView` shell is ready in `root-view.tsx`, and there are no components or storage yet.

## Architecture

Backend-owned data + logic (needed for encrypted keys, SSE streaming, and durable history);
renderer is pure UI over IPC. Streaming uses **invoke-to-start + notification events**
(the exposed `window.glazeAPI.glaze.ipc` has `invoke`/`onNotification` but not `stream`, so
no preload change is required):

- `chat:start` (invoke) → returns a `streamId`, begins generation.
- Backend pushes `chat:delta`, `chat:done`, `chat:error` notifications keyed by `streamId`.
- `chat:cancel` (invoke) aborts an in-flight generation.

Two wire-format adapters cover everything:
- **OpenAI Chat Completions** (`/v1/chat/completions`, SSE `choices[].delta.content`) —
  covers OpenAI, Gemini (OpenAI-compat endpoint), DeepSeek, Kimi, LM Studio, Ollama, vLLM,
  llama.cpp, and any custom OpenAI-compatible base URL.
- **Anthropic Messages** (`/v1/messages`, SSE `content_block_delta`) — Claude + custom
  Anthropic-compatible base URLs.

## Backend (`main/`)

New files under `main/services/`:
- `secrets.ts` — `@glaze/core/backend#safeStorage` wrapper. `setKey(providerId, key)` →
  `encryptString` → persist base64 in `keys.json`; `getKey` → `decryptString`; `hasKey`,
  `deleteKey`. Gate on `isEncryptionAvailable()`. Keys never returned to the renderer.
- `config-store.ts` — providers + app settings as JSON under `app.getPath("userData")`.
  Provider record: `{ id, kind: "openai"|"anthropic", label, baseUrl, models: string[],
  defaultModel?, hasKey }`. Seed preset definitions (OpenAI, Anthropic, Gemini, DeepSeek,
  Kimi/Moonshot, + Custom-OpenAI, Custom-Anthropic, + local LM Studio `:1234`/Ollama
  `:11434` templates).
- `chat-store.ts` — history under `userData/chats/`: `index.json` (id, title, providerId,
  model, updatedAt) + one `<id>.json` per chat (messages `{role, content, createdAt}`).
  CRUD + `appendMessage`.
- `llm-client.ts` — `fetch` (or `@glaze/core/backend#net.fetch`) to the provider, parse SSE,
  emit deltas via `ipcMain.broadcast`/`sendTo`; supports `AbortController` for cancel.
  Two adapters (openai/anthropic) selected by provider `kind`.
- `models.ts` — list models from provider (`GET /v1/models`, Anthropic `/v1/models`), used
  by the provider editor + model picker; falls back to `provider.models` when unlisted.

IPC handlers (extend `main/handlers/index.ts`, add `main/handlers/{providers,chats,chat}.ts`):
- providers: `providers:list`, `:save`, `:remove`, `:setKey`, `:test`, `:listModels`
- chats: `chats:list`, `:get`, `:create`, `:rename`, `:delete`, `:appendMessage`
- generation: `chat:start`, `chat:cancel` (+ `chat:delta/done/error` notifications)

## Renderer (`renderer/`)

Routes (`main/router.tsx`): keep `/` → chat; add `/settings` → in-app settings. A "Settings"
button in the sidebar footer navigates to `/settings` (matches the screenshots' "Back to
app" pattern); repoint the app menu's Cmd+, to send an `app:navigate` notification the
router listens for.

- `main/chat-view.tsx` — replaces `home-view.tsx`. `SplitView` with `sidebar` = chat history,
  `children` = transcript + composer.
- `components/chat-sidebar.tsx` — `Sidebar` + `SidebarList` of chats, new-chat action,
  rename/delete (context menu + `AlertDialog`), `SidebarFooter` with Settings.
- `components/message-list.tsx` + `message-bubble.tsx` — user/assistant rows inside
  `ScrollArea` (`autoScrollToBottom`, `autoScrollDeps={[messages, streamingText]}`).
- `components/composer.tsx` — auto-grow `Textarea`, model picker via `Select`
  (provider → model, grouped), send / stop button, Enter-to-send.
- `components/markdown.tsx` — `react-markdown` + `remark-gfm` + `rehype-highlight` for
  assistant content, styled with semantic `Text`/Tailwind tokens so it respects light/dark.
- `main/settings-view.tsx` (in-app, full-screen) — left nav: **Providers** (list, add/edit
  preset or custom, base URL, API key entry, Test connection, model refresh) and
  **Appearance** (Auto/Light/Dark via `nativeTheme.setThemeSource`, reusing the RadioGroup
  pattern from the existing `renderer/settings/settings-view.tsx`). Include disabled/"coming
  soon" nav entries for MCP and Skills as phase-2 placeholders (clearly labeled, not fake
  functionality).
- `lib/ipc.ts` — typed `invoke` wrappers + a `streamChat(params, {onDelta,onDone,onError})`
  helper built on `glaze.ipc.invoke("chat:start")` + `onNotification`.
- React Query hooks for providers/chats; streaming text held in local component state,
  persisted via `chats:appendMessage` on completion.

## Dependencies

Add to `.glaze-sources/package.json`: `react-markdown`, `remark-gfm`, `rehype-highlight`
(+ `highlight.js` styles). Install with `npm install --include=dev`. If the npm min-release-age
policy rejects a version, pin to an older one in `package.json` (never touch `.npmrc`). No LLM
SDKs needed — raw `fetch`/SSE keeps the wire adapters transparent and dependency-light.

## Reused template pieces

- `SplitView` shell already in `root-view.tsx`; `useTheme()` already syncs `.dark`.
- Route pattern in `router.tsx` (`createRoute` + `staticData.title`).
- IPC via `window.glazeAPI.glaze.ipc.invoke` / `onNotification` (preload unchanged).
- Handler registration pattern in `main/handlers/index.ts`.
- Appearance RadioGroup pattern from `renderer/settings/settings-view.tsx`.
- Window size stays 1000×700 (good for sidebar + transcript).

## Skills to invoke during implementation

`glaze-backend-rules` + `glaze-data-storage` + `glaze-external-api` (backend/services),
`glaze-frontend-rules` + `glaze-component-patterns` (UI), `glaze-ipc-communication`
(streaming contract), `glaze-theming`/`glaze-icon-usage` as needed.

## Verification

1. `npm run type-check && npm run lint`, then build once.
2. Launch; DOM-snapshot the chat view (sidebar, composer, model picker) and `/settings`
   (Providers + Appearance render, nav works).
3. Provider round-trip: add a provider + key, run Test connection, refresh models — confirm
   key is encrypted (stored base64, never echoed back to renderer).
4. Streaming: point at a local OpenAI-compatible endpoint (LM Studio `:1234`) or a real key,
   send a message, confirm tokens stream in, transcript auto-scrolls, message persists, chat
   appears in the sidebar, and Stop cancels. (Full send/stream test needs a user-supplied
   key or running local server; UI wiring is validated via DOM regardless.)
5. Toggle Light/Dark/Auto and confirm the whole UI (incl. markdown) flips.

## Phase 2 (follow-up, not this build)

MCP servers (stdio via `child_process.spawn` + remote HTTP), Skills as tool-like
capabilities, Exa web-search tool, and the shared tool-calling orchestration loop.
