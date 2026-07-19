# Aiden Agent

Aiden Agent is a private macOS AI workspace agent. It can chat with local or hosted models, work inside folders you explicitly open, run workspace-scoped coding tools, connect to MCP servers, load Agent Skills, search the web, and transcribe voice locally or through a configured provider.

The source of truth is the private repository: [sambitcreate/aiden-agent](https://github.com/sambitcreate/aiden-agent).

## What it does

- Organizes chats into folder-backed workspaces.
- Gives the agent read, search, edit, write, and command tools confined to the selected workspace folder.
- Supports Full, Ask, and No Access permission modes per workspace.
- Connects to OpenAI-compatible and Anthropic-compatible services, including local Ollama and LM Studio endpoints.
- Runs the embedded Pi agent loop for streaming, multi-step tool calls, and approvals.
- Connects to stdio, HTTP, and SSE MCP servers, including OAuth-enabled remote servers.
- Discovers Agent Skills from workspace and user skill folders.
- Supports attachments, Git branch operations, Exa web search, global shortcuts, and dictation.
- Provides on-device Parakeet transcription through the bundled sherpa-onnx runtime.

## Tech stack

| Layer | Technology | Role |
| --- | --- | --- |
| Desktop runtime | Electron 43 | macOS windows, menus, IPC, permissions, secure storage, and packaging |
| Language | TypeScript | Shared implementation language for main process, preload, and renderer |
| Renderer | React 19 | Chat, workspace, settings, model, MCP, and voice interfaces |
| Build | Vite 8 and esbuild | Renderer bundling plus Electron main/preload compilation |
| Styling | Tailwind CSS 4 | Local design tokens, layout, light/dark themes, and component styling |
| UI primitives | Local components, Radix UI, cmdk, Sonner, Lucide | Accessible dialogs, menus, inputs, command palettes, notifications, and icons |
| Routing and data | TanStack Router and TanStack Query | In-memory app navigation and cached IPC-backed server state |
| Agent runtime | `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` | Model streaming, multi-step agent execution, and tool calling |
| Tool protocol | `@modelcontextprotocol/sdk` | MCP clients over stdio, HTTP, and SSE |
| On-device speech | `sherpa-onnx-node` with NVIDIA Parakeet models | Local speech-to-text without sending recordings to a cloud service |
| Rich text | React Markdown, remark-gfm, remark-math, KaTeX, Highlight.js | Markdown, tables, math, and code rendering |
| Persistence | JSON files in Electron `userData` and Electron `safeStorage` | Chats, configuration, workspaces, encrypted provider keys, and encrypted MCP OAuth sessions |
| Distribution | electron-builder | Builds the macOS `.app`, DMG, and ZIP artifacts |

## Repository-owned interface system

The desktop interface is implemented locally in `renderer/components/ui.tsx` and `renderer/styles.css`. It preserves the app's established macOS interaction and visual language without requiring an external UI package or host runtime:

- translucent window and sidebar materials with light, dark, and inactive-window states;
- 28, 32, and 36 pixel native-density controls with pill and rounded variants;
- glass toolbar actions, searchable sidebars, selected rows, fields, wells, badges, and callouts;
- accessible Radix-backed dialogs, alerts, menus, selects, switches, radio controls, and tooltips;
- searchable cmdk model and branch pickers, Sonner notifications, and Lucide icons;
- a collapsible, pointer-resizable sidebar whose state and width persist per split view;
- measured sticky toolbars and composers, guarded chat auto-follow, and a scroll-to-bottom affordance.

App screens import only this local compatibility layer. Visual tokens and primitive behavior should be extended there so chat and settings remain consistent.

## Architecture

```text
React renderer
    │ narrow, allowlisted contextBridge API
    ▼
Electron preload
    │ invoke + notifications
    ▼
Electron main process
    ├── Pi agent and model adapters
    ├── workspace-scoped filesystem, command, and Git tools
    ├── chat/config JSON stores and encrypted secrets
    ├── MCP, OAuth, Exa, attachments, and model catalog
    └── local/cloud voice transcription
```

The renderer has no direct Node.js access. Electron runs with context isolation, Node integration disabled, a sandboxed renderer, a Content Security Policy, and allowlisted IPC prefixes and notification channels. Credentials remain in the main process and are not returned to React.

## Privacy boundary

The codebase and build pipeline are self-contained in this repository and do not require a separate host application or private SDK.

Local by default:

- Chats, configuration, workspace metadata, and downloaded speech models are stored under Electron's Aiden Agent user-data directory.
- Provider keys and MCP OAuth sessions are encrypted with the operating system's secure storage before being written to disk.
- Folder tools operate only inside the workspace root selected by the user.
- Parakeet transcription runs on the Mac after its model has been downloaded.
- Local model endpoints such as Ollama and LM Studio can keep prompts on the Mac.

Network activity is still possible when a feature requires it:

- Hosted model providers receive the prompts, attachments, and tool results sent to them.
- Cloud voice providers receive audio selected for cloud transcription.
- Exa receives web-search queries when web search is enabled.
- Remote MCP servers receive their tool requests.
- The models.dev catalog is fetched to enrich model capability metadata.
- Parakeet model downloads come from the sherpa-onnx project release hosting.

For a fully local session, select a local model endpoint, use on-device voice, disable Exa, and avoid remote MCP servers.

## Development

Requirements:

- macOS
- Node.js 22.19 or newer
- npm

Install and launch the Electron app with Vite hot reload:

```bash
npm install
npm run dev
```

Verification commands:

```bash
npm run type-check
npm run lint
npm run build
```

Create an unpacked macOS application:

```bash
npm run package
```

Create DMG and ZIP distribution artifacts:

```bash
npm run dist
```

Unsigned local builds may require the usual macOS confirmation before first launch. Signing and notarization should be added before distributing the app to other Macs.
