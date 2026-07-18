# Aiden Agent

Aiden Agent is a native macOS AI workspace agent for chatting with local or hosted models and letting an AI agent work inside folders you choose. It was created with Glaze and uses the embedded Pi agent loop for streaming responses, tool use, and workspace-scoped coding tasks.

The project is currently private and under active development.

Repository: [sambitcreate/aiden-agent](https://github.com/sambitcreate/aiden-agent)

## What it does

- Connects to OpenAI, Anthropic, Gemini, DeepSeek, Kimi/Moonshot, and compatible custom endpoints.
- Supports local models through Ollama and LM Studio.
- Organizes chats into folder-backed workspaces with Full, Ask, or No Access permissions.
- Gives the agent root-confined file, search, edit, and command tools inside the selected workspace.
- Integrates MCP servers, Agent Skills, Exa web search, file attachments, and image-capable models.
- Shows Git branches and uncommitted-file counts and supports branch checkout and creation.
- Streams Markdown with GFM tables, syntax-highlighted code, LaTeX, JSON formatting, and copy controls.
- Supports cloud voice transcription and fully local Parakeet transcription through sherpa-onnx.
- Stores provider keys and MCP OAuth sessions with macOS encrypted storage.

## Tech stack

| Area | Technology |
| --- | --- |
| Desktop runtime | Glaze SDK 0.10, native macOS window and IPC APIs |
| Language | TypeScript 5.5, ES modules |
| UI | React 19, Glaze components, Radix UI, Tailwind CSS 4 |
| Routing and server state | TanStack Router, TanStack Query |
| Agent runtime | `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai` |
| Model integrations | OpenAI-compatible and Anthropic-compatible APIs, Ollama, LM Studio |
| Tools | Model Context Protocol SDK, Agent Skills, Exa, folder-scoped coding tools |
| Rich text | React Markdown, Remark GFM/Math, KaTeX, Highlight.js |
| Voice | sherpa-onnx with NVIDIA Parakeet; OpenAI and Gemini transcription |
| Build tooling | Glaze CLI, Vite 8, esbuild, TypeScript, ESLint, oxfmt |
| Persistence | JSON stores in Glaze app data; macOS `safeStorage` for secrets |

## Architecture

The React renderer communicates only through typed IPC. Glaze's Node.js backend owns model credentials, chat and workspace persistence, model streaming, MCP connections, voice transcription, Git operations, and filesystem access.

```text
React renderer
    │ typed IPC
    ▼
Glaze handlers
    │
    ├── Pi agent loop ── model providers
    ├── workspace tools ── filesystem, shell, Git
    ├── MCP / Skills / Exa
    ├── chat and configuration stores
    └── cloud and local voice services
```

Workspace file tools are confined to the selected folder. In Ask mode, writes, edits, and commands require an inline approval before execution.

## Project structure

```text
main/
  handlers/       IPC endpoints
  services/       Agents, models, tools, storage, Git, MCP, and voice
  windows/        Native window helpers
renderer/
  components/     Chat, composer, model picker, and settings UI
  lib/            IPC client, queries, workspace state, and shared helpers
  main/           Main chat window and router
  settings/       Settings window entry point
.memory/          Project context and implementation history
```

## Requirements

- macOS
- Glaze 0.10.0.0 or newer
- Node.js 24 or newer
- npm 11

The Glaze SDK supplies the native runtime and build commands. Keep Glaze installed in `/Applications`; the local `glaze.ts` wrapper resolves the SDK from either Glaze's Application Support cache or the installed app bundle.

## Development

Install dependencies:

```bash
npm install
```

Run the app in development from Glaze's project environment:

```bash
npm run dev
```

The raw Terminal command starts the backend and Vite servers, but Glaze 0.10 does not attach a native host when the command is launched outside Glaze. In that case native calls such as theme and screen discovery time out even though the renderer server is healthy. Use Glaze for full native development and Terminal for build, type-check, and lint.

Available checks and build commands:

```bash
npm run type-check
npm run lint
npm run format
npm run build
```

## Local data and secrets

Runtime data is stored in the app's Glaze application-support directory rather than this repository. It includes chats, workspace configuration, downloaded-model metadata, logs, encrypted provider keys, and encrypted MCP OAuth sessions.

Portable `.glaze` exports can also contain runtime data, chat transcripts, generated builds, and screenshots. They are intentionally ignored by Git and should be reviewed before sharing.

## Project memory

Read `.memory/PROJECT-CONTEXT.md` and `.memory/PROJECT-HISTORY.md` before making substantial changes. Keep them current when implementation, architecture, decisions, or project status changes.
