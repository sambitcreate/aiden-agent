# GPUI Port Research: Data + Integration Layer

Date: 2026-08-06. Status: research only — no application code. Scope: the Electron
main-process data model, provider/model abstraction, MCP, subagents, scheduling,
Computer Use, on-disk storage, and renderer wire contracts of Aiden Agent
(`main/services/**`, `renderer/shared/**`, `native/**`). Companion to
`research-gpui-patterns.md` (UI/runtime patterns).

Aiden's integration layer is built on two vendored npm packages from
`@earendil-works`: **pi-ai** (provider streaming transports + model registry +
credential store contract) and **pi-agent-core** (the tool-calling agent loop).
Aiden wraps these with an Electron shell: JSON-file persistence with heavy
crash-durability machinery, safeStorage-encrypted secrets, four signed native
helper binaries (3 C, 1 Rust), and an owner-document-bound IPC streaming protocol.
Everything below maps what must be reproduced, replaced, or dropped in a
GPUI + Rust port.

---

## 1. Chat / domain data model

### 1.1 Core shapes (`main/services/types.ts`)

The domain model is intentionally small: `Chat` = metadata + flat
`ChatMessage[]`. There is no thread tree, no branching, no message editing.

```typescript
export type ChatRole = "user" | "assistant" | "system";
export type AttachmentKind = "image" | "text";

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  data?: string;  // base64 (no data: prefix) for images
  text?: string;  // inlined UTF-8 for text/code (truncated)
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;                      // plain text only — never blocks
  createdAt: number;                    // ms epoch
  model?: string;                       // model that produced assistant msg
  reasoning?: string;                   // exposed provider thinking (assistant only)
  attachments?: Attachment[];           // user messages only
  timeline?: GenerationTimeline;        // renderer-safe tool milestones (assistant only)
  subagents?: SubagentMessageReferenceV1; // bounded child-run refs (assistant only)
}

export interface ChatMeta {
  id: string;                           // `${Date.now().toString(36)}-${rand36}`
  title: string;
  workspaceId?: string;                 // absent = "default"
  providerId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}
export interface Chat extends ChatMeta {
  computerUseEnabled?: boolean;         // per-chat opt-in; global beta setting is authoritative
  messages: ChatMessage[];
}
```

Key design facts:

- **Persisted messages are lossy projections.** Pi's wire format (`AssistantMessage`
  with `TextContent | ThinkingContent | ToolCall` blocks, `Usage`, `stopReason`)
  is collapsed to plain `content` + optional `reasoning` string on save. Tool
  calls are persisted only as the renderer-safe `timeline` projection, not as
  replayable tool-call protocol. A port must decide whether to keep this
  projection or persist full protocol messages (recommended: keep the projection
  for renderer parity, since rehydration uses `toPiMessages()` which only
  reconstructs text/images anyway — `main/services/generation-messages.ts:14-55`).
- **Reasoning is only exposed for Google + LM Studio + Ollama**
  (`shouldExposeReasoning`, `generation-runtime.ts:35-41`). Anthropic/Codex
  thinking is timed (for the UI) but the text is discarded.
- **Generation timeline** (`renderer/shared/generation-timeline.ts`) is the
  persisted record of tool activity: version 2, replayable versions {1, 2}:

```typescript
export interface GenerationTimeline {
  version: 2;
  generationId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  steps: AgentStep[];                   // AgentToolStep | AgentThinkingStep
  claimCheck?: GenerationClaimCheck;    // { kind: "unverified_success", stepIds }
}
export interface AgentToolStep {
  id: string; order: number; kind: "tool";
  toolCallId: string; toolName: string; label: string;
  status: "pending"|"awaiting_approval"|"running"|"completed"|"failed"|"blocked"|"cancelled";
  startedAt: number; updatedAt: number; finishedAt?: number;
  target?: string;                      // workspace-relative path, never contents
  detail?: string;                      // one-line object of action, ≤120 chars
}
export interface AgentThinkingStep {
  id: string; order: number; kind: "thinking";
  startedAt: number; updatedAt: number; finishedAt?: number;
  durationMs?: number;                  // host wall-clock; pi reports no duration
}
```

### 1.2 Chat store (`main/services/chat-store-core.ts`)

Layout: `<userData>/chats/index.json` (array of `ChatMeta`, sorted by
`updatedAt` desc) + `<userData>/chats/<chatId>.json` per chat (full `Chat`).

Durability protocol (important — this is the hardest persistence behavior to
port faithfully):

- **All operations serialized** through a single promise tail (`serialized()`),
  because index writes and background title generation overlap message writes.
- **Write protocol per chat file**: write `.<name>.<uuid>.chat-write.tmp` with
  `O_EXCL` + mode 0600 → fsync file → optional pre-rename ownership check →
  rename → fsync directory. Crash-left staging files (matching strict regexes)
  are swept before each write.
- **Cross-file transaction**: `writeChatAndMeta` = `beginChatTransaction`
  (creates `.chat-transaction.<id>.pending`) → write chat → update index →
  clear marker. On every operation, `reconcileChatTransactions()` re-checks
  pending markers and repairs index/chat divergence.
- **Index recovery**: unreadable/invalid `index.json` is quarantined to
  `.index.json.<uuid>.corrupt` and rebuilt by scanning `*.json` chat payloads;
  index entries are never trusted — metadata is always re-derived from the
  same-ID payload (`readIndex`, lines 272-305).
- **Chat id validation**: NFKC-normal, `^[A-Za-z0-9._:-]+$`, ≤160 chars.
- **Provider id migration** happens on read (`migrateLegacyPiProviderId`).

API surface: `list(workspaceId?)`, `get`, `create`, `rename`,
`replaceTitleIfUnchanged` (CAS for async title gen), `moveEmptyChatToWorkspace`,
`setComputerUseEnabled` (with renderer-document ownership fence),
`remove`, `appendMessage` (with `expectedWorkspaceId` fence + auto-title seed
on first user message), `replaceAutoTitle` (CAS).

### 1.3 Generation & streaming protocol

Entry: IPC `chat:start(streamId?, params, messageTurnId)` → returns
`{streamId}`; the renderer pre-subscribes to owner-bound channels so no opening
tokens are dropped (`main/handlers/chat.ts:23-50`). `params` parses to
`ChatStartParams`:

```typescript
export interface ChatStartParams {
  chatId: string;
  workspaceId?: string;
  providerId: string;
  model: string;
  mode?: "assistant" | "assistant-unattended" | "assistant-automation"; // main-only; renderer parse never produces these
  thinkingLevel?: GenerationThinkingLevel; // small enum, validated per provider
  messages: Array<{ role: ChatRole; content: string; attachments?: Attachment[] }>;
}
```

Push channels ( Electron `webContents.send`, owner-bound):

| Channel | Payload | Meaning |
|---|---|---|
| `chat:delta` | `{ streamId, delta }` | assistant text token |
| `chat:reasoning-delta` | `{ streamId, delta }` | thinking text (exposed providers only) |
| `chat:tool` | `{ streamId, phase: "call"\|"result"\|"error"\|"blocked", toolName }` | tool activity |
| `chat:timeline` | `{ streamId, timeline }` | full `GenerationTimeline` snapshot |
| `chat:done` | `{ streamId, content, reasoning?, timeline?, chat? }` | terminal success (also sent with `content:""` on cancel) |
| `chat:error` | `{ streamId, message, content?, reasoning?, timeline?, chat? }` | terminal failure, partial content retained |
| `chat:approval` | `ApprovalRequest{ streamId, approvalId, toolName, summary }` | "ask"-mode pause |
| `chats:metadata-updated` | `{ chatId, workspaceId, title, updatedAt }` | sidebar refresh |

Control IPC: `chat:cancel(streamId, origin)`, `chat:approve(approvalId,
"allow"|"deny")`. Approval/decision shapes in `types.ts:603-611`.

Internally, generation = one fresh pi `Agent` per turn
(`llm-client.ts`, 1860 lines — the orchestration hub):

1. Resolve model runtime (`resolveModelRuntime`, §2.3).
2. Build system prompt + tool set (`buildAgentTools`, §2.5) per workspace
   permission and `mode`.
3. `toPiMessages()` rehydrates transcript → pi `Message[]` (assistant text
   blocks with zero usage; user text + image parts gated by
   `runtimeSupportsImages(model)`).
4. Context compaction transform (`generation-context.ts`) — see §1.4.
5. `beforeToolCall` hook enforces "ask" permission: mutating tools
   (`write_file`, `edit_file`, `run_command` = `APPROVAL_TOOL_NAMES`) pause for
   `chat:approval`; denial returns `{block:true, reason}`.
6. `Agent.subscribe` event fan-out: `message_update` (`text_delta` →
   `chat:delta`; `thinking_delta` → `chat:reasoning-delta`),
   `tool_execution_start/update/end` → timeline projector + `chat:tool`,
   `message_end` → usage accounting + terminal text/thinking fallback
   (`terminalAssistantTextFallback` handles providers that complete without
   deltas).
7. Terminal: append assistant message to chat store (with timeline + subagent
   refs), send `chat:done`/`chat:error`, settle cleanup with a deadline
   (`settleGenerationCleanup`).

`stopReason` mapping: pi terminal assistant message with `stopReason:"error"`
→ `chat:error`; `"aborted"` + app cancel → `chat:done{content:""}`;
`"aborted"` without cancel → interruption error (`generation-runtime.ts:213-238`).

### 1.4 Context compaction (`main/services/generation-context.ts`)

Port-worthy deterministic algorithm, Electron-free by design:

- Budget: `inputBudget = contextWindow - reserve`, where
  `reserve = min(20% window, pi default) + max(5% window, 1024)` capped.
- Token estimation: chars/4 heuristic, corrected by the last provider-reported
  `usage` ("anchor") with a prefix ratio (`providerPrefixRatio`).
- `assertGenerationContextCapacity` fails before any provider I/O if system
  prompt + tools + fallback notice can't fit.
- Compaction order (loop until under budget):
  1. Keep only newest 3 Computer Use screenshots (`limitComputerUseImages`).
  2. Truncate tool results >32k chars (head/tail with marker).
  3. Drop oldest historical turns, preserving the 2 newest user turns.
  4. Replace old current-turn tool results with "payload omitted" stubs,
     protecting the newest ≤40k tokens / ≥2 results.
  5. Drop everything before the current user turn.
  6. Drop oldest current-turn assistant batches.
  7. Nuclear: replace entire outbound context with a fixed
     `CONTEXT_FALLBACK_TEXT` user notice ("explain retry with larger-context
     model… do not call tools") — never sends a knowingly over-window request.
- Result metrics (`GenerationContextCompaction`) feed usage/logging.

---

## 2. Model / provider abstraction — the critical port surface

### 2.1 The pi-ai contract (npm `@earendil-works/pi-ai`, `dist/types.d.ts`)

This is the normalized provider model Aiden streams against. Transcribed:

```typescript
export type KnownApi = "openai-completions" | "mistral-conversations"
  | "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
  | "anthropic-messages" | "bedrock-converse-stream"
  | "google-generative-ai" | "google-vertex" | "pi-messages";
export type Api = KnownApi | (string & {});
export type ThinkingLevel = "minimal"|"low"|"medium"|"high"|"xhigh"|"max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type ProviderHeaders = Record<string, string | null>; // null suppresses a default header

export interface Model<TApi extends Api> {
  id: string; name: string;
  api: TApi;                       // dispatch key for the wire transport
  provider: ProviderId;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap; // pi level → provider value; null = unsupported
  input: ("text" | "image")[];
  cost: ModelCost;                 // {input,output,cacheRead,cacheWrite, tiers?}
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];             // UserMessage | AssistantMessage | ToolResultMessage
  tools?: Tool[];                  // { name, description, parameters: TSchema(typebox) }
}

export interface StreamOptions {
  temperature?: number; maxTokens?: number; signal?: AbortSignal;
  apiKey?: string;                 // resolved per request (OAuth refresh-safe)
  transport?: Transport;
  cacheRetention?: "none"|"short"|"long";
  sessionId?: string;              // chat id → prompt-cache affinity
  onPayload?: (payload, model) => unknown | undefined;  // inspect/replace pre-send
  onResponse?: (response, model) => void;
  headers?: ProviderHeaders;
  timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number;
  metadata?: Record<string, unknown>;
  env?: ProviderEnv;               // provider-scoped env overrides (Cloudflare acct ids…)
}
export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets; // {minimal?,low?,medium?,high?} token budgets
}

export interface ProviderStreams {
  stream(model, context, options?): AssistantMessageEventStream;
  streamSimple(model, context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}
```

Message content blocks:

```typescript
export interface TextContent    { type:"text"; text: string; textSignature?: string }
export interface ThinkingContent{ type:"thinking"; thinking: string;
                                  thinkingSignature?: string; redacted?: boolean }
export interface ImageContent   { type:"image"; data: string; mimeType: string } // base64
export interface ToolCall       { type:"toolCall"; id: string; name: string;
                                  arguments: Record<string, any>; thoughtSignature?: string }

export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  cacheWrite1h?: number;           // Anthropic-only split
  reasoning?: number;              // subset of output
  totalTokens: number;
  cost: { input; output; cacheRead; cacheWrite; total };
}
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage      { role:"user"; content: string | (TextContent|ImageContent)[];
                                    timestamp: number }
export interface AssistantMessage { role:"assistant";
                                    content: (TextContent|ThinkingContent|ToolCall)[];
                                    api: Api; provider: ProviderId; model: string;
                                    responseModel?: string; responseId?: string;
                                    usage: Usage; stopReason: StopReason;
                                    errorMessage?: string; timestamp: number }
export interface ToolResultMessage<TDetails=any> {
  role:"toolResult"; toolCallId: string; toolName: string;
  content: (TextContent|ImageContent)[]; details?: TDetails;
  addedToolNames?: string[];       // deferred tool loading hook
  isError: boolean; timestamp: number;
}
```

The streaming event protocol every transport normalizes to
(`AssistantMessageEvent`, 14 variants):

```
start{partial} → (text_start|thinking_start|toolcall_start){contentIndex,partial}
  → *_delta{contentIndex, delta, partial} → *_end{contentIndex, content|toolCall, partial}
→ done{reason: "stop"|"length"|"toolUse", message}
| error{reason: "error"|"aborted", error: AssistantMessage}
```

Invariant: streams never throw; failures are terminal events with
`stopReason:"error"/"aborted"` + `errorMessage`. Tool-call argument deltas are
JSON fragments reassembled by the consumer.

### 2.2 Aiden's three provider routing families

`resolveModelRuntimeWith` (`model-runtime-core.ts:86-146`) is the single
routing funnel, in order:

1. **`openai-codex`** → `CodexProviderService` (OAuth subscription, own
   refresh/retry/supersede machinery, `codex-provider.ts` 765 lines). Pi owns
   the transport (`openai-codex-responses` API, WebSocket-capable);
   `prepareRuntimeModel` resolves models; Aiden stores the OAuth credential in
   Pi's credential store.
2. **Pi native built-ins** (`isBuiltinProvider` — every Pi-known provider:
   anthropic, google, openai, deepseek, moonshotai, xai, groq, openrouter,
   zai, mistral, kimi-coding, cloudflare-*, …). Pi owns model records, auth
   resolution (API key *or* OAuth *or* ambient env), catalogs, and streaming.
   Aiden never reconstructs these through the `/compat` path and never reads a
   legacy key for them (`provider-registry.ts`).
3. **Aiden custom connections** (`custom:`-prefixed ids; plus legacy `lmstudio`
   / `ollama` ids). Aiden builds a `Model<Api>` itself via `/compat`
   (`anthropicMessagesApi()` or `openAICompletionsApi()`), with limits from the
   catalog (`RuntimeModelLimits`, default `128k ctx / 8192 max / text-only`),
   key from the encrypted store, and header suppression for keyless endpoints:

```typescript
// generation-runtime.ts — the entire custom-connection transport policy
resolveRuntimeBaseUrl:  strip trailing slashes; strip /v1 for anthropic-kind only
resolveRuntimeApiKey:   needsKey ? storedKey||undefined : "aiden-local-no-auth" (pi ctor compat)
resolveRuntimeHeaders:  keyless anthropic → {Authorization:null, "x-api-key":null}
                        keyless openai    → {Authorization:null}
```

Routing record (`ResolvedModelRuntime`): `{ provider: StoredProvider,
model: Model<Api>, apiKey?, headers?, streams: Pick<ProviderStreams,"streamSimple"> }`.
The agent's `streamFn` closure re-injects `apiKey` and merges headers last so a
keyless provider can never inherit an `Authorization` header
(`buildAgentRuntimeOptions`, `generation-runtime.ts:195-211`).

`StoredProvider` / `Provider` (DTO) in §9, #3.

### 2.3 Native provider wrappers (thin)

- **Google** (`google-provider.ts`): Pi `google-generative-ai` API, base
  `https://generativelanguage.googleapis.com/v1beta`, default
  `gemini-2.5-flash`. Aiden keeps a legacy preset migration (`gemini` →
  `google` id remap incl. encrypted key move without decryption) and exposes
  metadata (thinking levels, vision, context length) from Pi's builtin model
  list. `GoogleProviderService.streamSimple` delegates to
  `models.getProvider("google").streamSimple`. Also: **Gemini context cache**
  (`gemini-context-cache.ts`) — REST `cachedContents` create/get, name pattern
  `cachedContents/<id>`, used to cache workspace snapshots; injects
  `cachedContent` into the payload via `onPayload`.
- **Anthropic** (`anthropic-provider.ts`): no custom transport; pins Pi builtin
  models (`claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5`), enriches
  metadata with Aiden thinking-level choices, migrates legacy preset model
  lists.
- **Codex** (`codex-provider.ts`): `https://chatgpt.com/backend-api`, default
  `gpt-5.4`, OAuth with credential generation/revision hashing (sha256 of
  access\0refresh\0expires), supersede-detection with 2 retries, 15s auth /
  60s refresh timeouts, 60s expiry skew. Error taxonomy: `model_unavailable |
  request_cancelled | sign_in_required | sign_in_needs_attention |
  temporarily_unavailable`.
- **Apple Foundation Models** (`foundation-models-connection-core.ts`):
  title-only local provider. Spawns a signed Swift helper
  (`native/apple-foundation-models`) with a file-based JSON protocol
  (`--request-file/--response-file/--process-file/--cancellation-file`),
  protocol version 1, methods `availability | generateTitle`, 20KB request
  cap, 5s status / 15s generation timeouts, status TTLs (30s stable / 5s
  preparing). States: `ready | unsupported_os | device_not_eligible |
  apple_intelligence_disabled | model_preparing | helper_unavailable |
  unavailable | error`. macOS 26+ arm64 only.
- **Local runtimes** (Ollama / LM Studio): discovered over HTTP from the
  custom connection's base URL (`models.ts`): OpenAI-style `/models`,
  `/v1/models`, Ollama `/api/tags` + `/api/show` (capabilities: vision,
  tools, reasoning; `details.parameter_size/quantization_level`),
  LM Studio extended fields. 10s discovery timeout. `local-runtime-status.ts`
  monitors model load (first-token latency → "model became ready" events).

### 2.4 Credentials & key policy

- **Pi credential store** (`pi-credential-store-core.ts` →
  `pi-provider-credentials.json` in userData): `{version:1, entries:
  Record<providerId, {type, ciphertext(base64 safeStorage)}>}`, one credential
  per provider, `modify()` is the only write path (serialized RMW, per-provider
  async mutex shared process-wide). Credential = `{type:"api_key", key?, env?}
  | {type:"oauth", refresh, access, expires, …}`.
- **Legacy/custom keys** (`secrets.ts` → `provider-keys.json`):
  `Record<providerId, base64 safeStorage ciphertext>` + endpoint **binding**
  entries (`__aiden_internal_provider_binding_v1__:<id>`) so a key can never be
  silently redirected to a different host (`provider-key-policy.ts`:
  `canUseStoredProviderKey` requires exact id+kind+baseUrl+needsKey match).
  Quarantine slots keep externally rotated keys recoverable
  (`reconcileProviderKeyQuarantine`). Keys never cross IPC; renderer only sees
  derived `hasKey`.
- **safeStorage** = Electron's OS keychain bridge (Keychain on macOS). In Rust:
  `keyring` crate (see §10).
- **Provider auth flows** (`provider-auth-flow-core.ts`,
  `provider-registry.ts:authBackend`): Pi-owned interactive login
  (`api_key`/`oauth`) with `AuthInteraction` prompts; credentials committed in
  main only at the UI coordinator's point of no return.

### 2.5 Tool assembly (`tools.ts`, `coding-tools.ts`)

Per-generation `AgentTool[]` (typebox `parameters` schemas):

- **Coding tools** (folder-scoped): `read_file` (200KB cap), `list_dir`
  (500 entries), `glob`, `grep` (RE2-wasm, 5s/200-match caps), `write_file`,
  `edit_file`, `run_command` (120s timeout, 10MB output cap, workspace cwd).
  All paths confined via `resolveInRoot` + realpath checks. Mutating set =
  `APPROVAL_TOOL_NAMES`.
- **Integrations**: `web_search` (Exa REST, x-api-key header), Agent Skills
  (`skill_<slug>` tools returning SKILL.md instructions + ≤10 supporting file
  paths), MCP tools (§3), `computer_use` (§6), `schedule_task`/`edit_automation`
  (assistant mode), `subagent` (§4).
- `AgentTool` shape (pi-agent-core): `{ name, label, description, parameters:
  TSchema, prepareArguments?, execute(toolCallId, params, signal, onUpdate) →
  AgentToolResult<TDetails>, executionMode?: "sequential"|"parallel" }`.
  `AgentToolResult = { content: (Text|Image)[], details, addedToolNames?,
  terminate? }`.
- Agent loop hooks Aiden uses: `beforeToolCall` (approval gate),
  `transformContext` (compaction), `getApiKey`, `streamFn`, `sessionId`.

---

## 3. MCP (Model Context Protocol)

### 3.1 Server config & transports

`McpServer` records live in the **portable** `~/.aiden/config.json`
(hand-editable). Transport matrix (`mcp.ts:88-143`):

```typescript
export type McpTransport = "stdio" | "http" | "sse";
export interface McpServer {
  id: string; name: string; transport: McpTransport;
  command?: string; args?: string[]; env?: Record<string,string>;   // stdio
  url?: string; headers?: Record<string,string>;                    // http/sse
  oauth?: boolean;                       // remote only: browser sign-in
  presetId?: string; enabled: boolean;
}
```

Official `@modelcontextprotocol/sdk` `Client` (name `aiden-agent` v1.0.0):
`StdioClientTransport` (spawns command with `process.env` + server env),
`StreamableHTTPClientTransport`, `SSEClientTransport`. Key handling: preset
API-key servers inject the key from the encrypted secrets store as an auth
header at connect time (`resolveAuth`) behind a **no-redirect fetch** (custom
key headers are not stripped on cross-origin redirects); OAuth servers attach a
non-interactive `OAuthClientProvider` backed by the encrypted session store —
background connections never open a browser; expired sessions fail loudly.

### 3.2 OAuth (`mcp-oauth.ts`, 532 lines)

MCP auth spec flow: PKCE + dynamic client registration, RFC 8252 loopback
redirect on fixed `http://127.0.0.1:41390/callback`, 5-minute auth timeout,
client metadata `{client_name:"Aiden Agent", grant_types:["authorization_code",
"refresh_token"], token_endpoint_auth_method:"none"}`. Sessions persisted
encrypted in `<userData>/mcp-oauth.json` (`mcp-oauth-store.ts`): map of
`serverId → base64 safeStorage ciphertext` of the session JSON (client info +
tokens + PKCE verifier + authorization binding hash). Writes stage both new map
and rollback map, with an ownership-gated publish/rollback commit
(`commitOwnedMutation`). Operation gate (`McpOAuthOperationGate`) serializes
flows per server with generations; config leases (`mcp-config-lease.ts`)
invalidate in-flight operations when the server record changes.

### 3.3 Tool inventory & naming

`client.listTools()` → each MCP tool becomes an `AgentTool` with
`parameters: Type.Unsafe(inputSchema)` (raw JSON Schema wrapped as typebox) and
`execute → client.callTool(...)` via `executeMcpAgentTool` (result normalization
+ size bounding in `mcp-tool-result.ts`). Tool names are namespaced per server
(`mcpAgentToolName(server, tool)` — see `mcp-tool-identity.ts`) and uniqueness
is asserted across servers. Connection lifecycle:
`GenerationBoundConnectionCache` — one cached `Client` per server id with
generation counters; a superseded connection fails instead of serving stale
tools. `collectMcpAgentTools(servers, {strict})` merges enabled servers;
`selectedMcpServers(configured, ids?)` resolves exact approved scopes
(undefined = all enabled — legacy only).

### 3.4 Presets (`mcp-presets.ts`)

Built-in catalog: Composio (apiKey header `x-consumer-api-key`,
`https://connect.composio.dev/mcp`), Notion (OAuth, `https://mcp.notion.com/mcp`),
Linear (OAuth, `https://mcp.linear.app/mcp`). Preset server id =
`preset-<id>`, secret id = `mcp:<serverId>`, origin allow-list enforced
(`assertMcpPresetServer`).

---

## 4. Subagent system

The largest subsystem (~90 files). The model-facing surface is one `subagent`
tool; everything else is main-process authority, supervision, and persistence.

### 4.1 Model-facing contract (`subagents/contracts.ts`)

```typescript
export interface SubagentToolRequest {
  context: "fresh" | "fork";                 // fork = clone parent transcript
  capabilities?: SubagentRequestedCapabilities; // root ceiling; omission = legacy read-only
  tasks: SubagentTaskRequest[];              // 1..4 per call
}
export interface SubagentRequestedCapabilities {
  workspaceRead: boolean; workspaceWrite: boolean;
  shell?: boolean;                           // positive full-host shell request
  delegate?: boolean;                        // positive nesting request
  web: boolean;
  mcp: SubagentRequestedMcpScope[];          // ≤16 servers, ≤32 tools each
  mcpMutations?: SubagentRequestedMcpScope[]; // disjoint from mcp
}
export interface SubagentTaskRequest {
  role: "scout" | "planner" | "reviewer";    // SUBAGENT_ROLES
  label: string;                             // ≤120 chars, control-char-free
  task: string;                              // ≤8000 chars
  capabilities?: SubagentRequestedCapabilities; // must narrow the root
}
export interface SubagentTaskResult {
  role: SubagentRole; label: string;
  status: "completed" | "failed" | "timed_out" | "interrupted";
  summary: string;                           // ≤8000 chars
  warning?: string;
}
```

Limits: ≤4 tasks/call, ≤8 launches/generation, tool results ≤24k chars.
Arguments are revalidated independently of provider schema enforcement
(`parseSubagentToolRequest` — prototype/Proxy-safe plain-record checks).

### 4.2 Authority & capability resolution (V2)

`authority-v2.ts`: every launch resolves a positive **intersection** of six
ceilings — requested ∩ root ∩ parent ∩ role ∩ rollout flags ∩ user grant —
then workspace permission gates (`none` → no tools). Result is an immutable
`SubagentAuthorityV2`:

```typescript
export interface SubagentAuthorityV2 {
  version: 2; grantId: string; treeRootId: string; runId: string;
  parentRunId?: string; depth: number;        // MAX depth 2
  authorityRevision: number;
  generationId: string; chatId: string; workspaceId: string;
  workspaceRevision: string; ownerDocumentId: string;
  providerFingerprint: string; modelFingerprint: string; contextRevision: string;
  execution: "foreground" | "background";
  context: "fresh" | "fork";
  thinkingLevel: ThinkingLevel;
  capabilities: SubagentCapabilitySetV2;      // resolved positive set
  budgets: SubagentBudgetV2;                  // deadline/turns/toolCalls/output/tokens/launches/depth/active/queued/networkOps
  expiresAt: number;
}
// sha256("aiden-subagent-authority-v2\0" + JSON) binds every downstream artifact
```

MCP scope entries carry `connectionFingerprint` + per-tool `schemaHash`;
mutating tools get an effect profile (`classification: declared_mutating |
unproven_mutating`, `destructive`, `idempotency`, `openWorld`, `taskSupport`).

Roles (`capability-profile.ts`): scout/planner/reviewer — currently identical
read-tool policy (`read_file, list_dir, glob, grep`); distinct system prompts
in `role-catalog.ts`.

### 4.3 Supervisor & run state machine

`SubagentSupervisor` (1340 lines): tree budget ledger + scheduler
(`subagent-nesting-core.ts` — depth ≤2, max active/queued, network operation
budget), deadline authority (tree 10min default, child 10min, cancel grace 5s),
child caps (24 turns / 64 tool calls / 512 events / 120k output chars).

Run states (`renderer/shared/subagent-runs.ts`):
`queued → starting → running → completed | failed | timed_out | interrupted`.
Persisted projection = `SubagentRunSnapshotV1` (§9, #8): renderer-safe,
no tool names/args/paths beyond bounded previews. Snapshots persist via the
run store; terminal runs are referenced from the assistant message via
`SubagentMessageReferenceV1 { generationId, runIds, items?, total, completed,
failed, timedOut, interrupted }`.

Execution lanes with separate approval gates (all digest-pinned, renderer gets
only safe facts — `renderer/shared/assistant.ts` `ToolApprovalDetails` union):

- **workspace write** → native file mutator (`SubagentWorkspaceWriteApprovalDetails`:
  path, pre/post sha256 prefixes, byte counts, bounded diff preview,
  `commandWillRun:false`, `refuseIfChanged:true`).
- **shell** → native shell runner (`SubagentShellApprovalDetails`: command,
  `/bin/zsh -f -c`, minimal-private-0700 env, timeouts/limits,
  `osSandboxed:false`, `arbitraryNetworkAvailable:true`).
- **MCP mutation** → main-proxied isolated client (`SubagentMcpMutationApprovalDetails`:
  connection/schema/profile/argument digest prefixes, classification, no retry,
  no rollback).
- **outbound (web)** → network budget + bounded fetch proxy.

### 4.4 Native C helpers (the security boundary)

Three single-file C binaries (signed, in `Helpers/` inside the app bundle;
`build/native/` in dev). Chosen over Node for small auditable TCB, no
DYLD-injection surface, and direct fstat/audit-token checks. All use line-based
request/response on stdio with fixed size caps.

| Helper | Protocol | Role |
|---|---|---|
| `aiden-subagent-run-store` (`native/subagent-run-store/main.c`) | commands: cleanup/read/write/sync; generation token `"missing"` \| hex id | Crash-safe custodian for `runs.json` (8MB cap). O_NONBLOCK+O_NOFOLLOW opens, fstat identity (dev/ino/size/mtime/ctime/birthtime) before trusting, exclusive single-link regular files only, staged install with `INSTALL_DESTINATION_CHANGED` semantics. TS side: `subagent-run-store-io.ts` keeps one long-lived child, 30s request timeout, 12MB response cap. |
| `aiden-subagent-file-mutator` (`native/subagent-file-mutator/main.c`) | inspect → prepare → commit/abort; base64 values; `SHA256` digests | Transactional workspace file mutation with recovery artifacts (`.aiden-subagent-file-*.tmp`). Client state machine: `idle → inspected → prepared → committed/indeterminate → closed`. Failures: `cancelled/conflict/indeterminate/invalid_input/io_failed`. Refuses if the file changed after inspection (digest-pinned). |
| `aiden-subagent-shell-runner` (`native/subagent-shell-runner/main.c` + `setsid-fixture.c`) | binary frame `AIDSH001`, v1: command(≤64KB) + effectDigest + nonce(sha256) + timeoutMs(≤1h); response ≤164B + 2×512KB streams | Runs approved full-host commands in a minimal private 0700 environment, pinned to a canonical workspace root (device+inode checked). Outcomes: `exited/signaled/timed_out/output_limit/cancelled/spawn_failed/protocol_failed/cleanup_unconfirmed` + `cleanupConfirmed`. |

Run store content: `{version:1, runs: SubagentRunSnapshotV1[] (≤512, ≤8MB),
pendingChatDeletions: string[] (≤512)}`, strict UTF-8, ≤128 JSON nesting
depth, merge-on-generation-conflict (`subagent-run-store-core.ts`).

---

## 5. Assistant & scheduling

### 5.1 Scheduled tasks (`types.ts:257-344`, `schedule-*.ts`)

```typescript
export interface ScheduledTask {
  id: string; name: string; enabled: boolean;
  mode: "llm" | "script";
  cron: string; timezone: string;            // validated IANA; croner "5-or-6-parts"
  nextRunAt?: number; lastRunAt?: number;
  workspaceId?: string; providerId?: string; model?: string;
  providerFingerprint?: string;              // main-owned; renderer cannot set
  prompt?: string; script?: string;          // script = filename under ~/.aiden/scripts
  permission: "read-only" | "full";
  mcpServerIds?: string[];                   // exact approved unattended MCP scope
  mcpServerBindings?: ScheduledMcpServerBinding[]; // {id, fingerprint} immutable
  executionProfile?: "assistant";            // main-owned
  chatId?: string; notify: boolean;
  lastResult?: "success"|"error"|"silent"|"blocked"; lastError?: string;
  createdAt: number; updatedAt: number;
}
export interface ScheduledRun {
  id: string; taskId: string; startedAt: number; finishedAt: number;
  result: ScheduledRunResult; output: string /* ≤64KB */; error?: string /* ≤4KB */;
  chatId?: string;
}
```

Persistence: `<userData>/schedules.json` + `schedule-runs.json` (≤50 runs/task),
both `DataStore`-backed. Runtime (`schedule-service-core.ts`): `croner` `Cron`
jobs per task, per-task lifecycle serialization, global enable gate,
workspace-blocked set, `advanceBeforeRun` claims the next run before execution
(crash-safe), unexpected failures recorded as error runs. Execution
(`schedule-execution.ts`): LLM tasks run a background generation with a
synthetic owner (`documentId: scheduled:<streamId>`), append the result to the
task's chat, `[SILENT]` contract suppresses noise; macOS `Notification` on
completion (`schedule-notification.ts`) with click-to-open-chat deep link.
Script tasks run files from `~/.aiden/scripts/` (`schedule-script.ts`).
Fingerprint binding: provider connection + MCP server connection fingerprints
are captured at save time and asserted at run time — a rotated endpoint breaks
the task instead of silently redirecting credentials.

### 5.2 Assistant proactivity (`types.ts` `AssistantConfig`)

Hotkey-driven docked assistant + opt-in ticker: polls git status
(`watchUncommitted`, `watchUntouchedProjects`, `watchConfigChanges`) on
`pollIntervalMinutes`, quiet hours, `maxNudgesPerDay`, `urgencyThreshold`.
**Required pin**: `providerId` + `model` must be set — an unattended loop never
inherits the user's current selection. Modes: interactive `assistant`,
`assistant-unattended` (ticker), `assistant-automation` (scheduled; coding
tools only, no MCP ambient tools, no computer use, no subagents — enforced by
contract tests). Assistant threads live in reserved workspace id `"assistant"`.

---

## 6. Computer Use

### 6.1 Architecture

Beta, macOS 14.4+, per-chat opt-in AND global setting. Stack:

```
Agent tool "computer_use" (sequential execution, Hermes-compatible params)
  → ComputerUseController (safety: grant ledger, approval descriptors,
    action normalization, 30s action / 60s capture / 120s discovery timeouts)
  → CuaDriverSession (MCP SDK Client over custom Transport to child stdio)
  → aiden-cua-broker (Rust, signed helper app — the TCC permission owner)
  → cua-driver (vendored third-party binary, v0.8.3, pinned + signature-verified)
```

Tool params (`computer-use/schema.ts`): action ∈ `capture, click, double_click,
right_click, middle_click, drag, scroll, type, key, set_value, wait, list_apps,
list_windows, focus_app`; `mode: som|vision|ax`; targeting by `app` name/bundle
id, `screen|desktop`, or exact `pid`+`window_id`; `element` = zero-based AX
index from latest capture; coordinates/modifiers/text/value bounded. Mutating
actions always require user approval (`safety.ts` grant ledger binds exact
target + action; approvals expire).

### 6.2 The Rust broker (`native/computer-use-broker`, 4.8k lines)

macOS-only (`compile_error!` otherwise). Deps: `libc`, `serde_json`, `sha2` —
no async runtime; thread-per-connection blocking I/O on Unix domain sockets.

- **Two modes** (`args.rs`): `broker` (long-lived, owns the driver) and
  `bridge` (per-session proxy between Electron and broker).
- **Sockets** (`socket.rs`): control socket + launch-lease socket, peer
  credentials via audit tokens; connect-target validation.
- **Signing** (`signing.rs`): verifies the Electron host, the helper peer, and
  the live driver by code-signing identity (SecCode/SecStaticCode via
  `darwin_security.m` + `darwin.rs`), plus a pinned driver binary check
  (sha256). TCC bundle id is the broker's own
  (`com.sambitcreate.aiden-agent.cua-driver`).
- **Supervisor** (`supervisor.rs`): launcher/watchdog state machine over a
  byte-code channel (`0x41 FALLBACK_READY … 0x6f SUPERVISION_FAILED`),
  constrained driver spawn in its own process group with owned stdio, stop/
  resume, 13-failure taxonomy (`SupervisionFailure`).
- **Protocol** (`runtime.rs`): internal frame version 2, fixed readiness
  frames (`{"type":"ready","protocolVersion":2}` etc.), 15s auth / 10s
  handshake timeouts, SIG{HUP,INT,TERM} → shutdown control fd.
- **JSON-RPC guard** (`jsonrpc.rs`): line-delimited JSON-RPC 2.0. Client→driver
  messages ≤1MB, driver→client ≤64MB. Method allow-list = exactly the 20 cua
  tools (`start_session … set_value`). `check_permissions{prompt:true}` is
  rewritten to a recheck; unknown methods get local `-32601`. This guard is the
  reason the model can never reach arbitrary driver powers (app/process/cursor
  control exists in the driver but is filtered).

Driver tool catalog contract (`computer-use/contract.ts`): `schema_version:"1"`,
`capability_version:"1"`, all 20 tools required, per-tool `capabilities[]` +
annotations (`readOnly/destructive/idempotent/openWorld`), each input schema
must declare a `session` string property (generation binding).
Environment given to the driver is minimal (`buildCuaDriverEnvironment`): PATH,
host bundle id, telemetry-off flags, locale/TMPDIR/HOME/USER only — no provider
keys, no proxy vars, no Node/Electron injection flags.

---

## 7. Storage formats — exact on-disk map

Two roots:

- **Portable root**: `$AIDEN_CONFIG_DIR` (must be absolute) else `~/.aiden`.
  User-owned, hand-editable (`aiden-config-dir.ts`).
- **Machine-local root**: Electron `app.getPath("userData")`
  (`~/Library/Application Support/aiden-agent` on macOS; product name from
  package.json). Machine-bound state, secrets, caches.

| File | Root | Shape | Notes |
|---|---|---|---|
| `config.json` | portable | `{providers: PortableProvider[], providerIdAliases: {}, mcpServers: McpServer[], skills: Skill[]}` | Hand-edited; `reloadBeforeWrite` + `rejectExternalChanges` + hard-link protected publication (`publishProtected`) |
| `README.md` | portable | seeded docs | explains the hand-editable file |
| `settings.json` | local | `{settings: AppSettings}` | UI prefs: last provider/model, keybindings, appearance, per-model thinking prefs, voice, scheduler defaults, assistant config |
| `config.json` | local | `{workspaces: Workspace[], seeded: bool, aidenDirMigratedAt?}` | workspaces carry absolute paths + managed-worktree git identities |
| `provider-model-cache.json` | local | `{byProvider: {models?, modelMetadata?}}` | regenerable discovery cache |
| `provider-keys.json` | local | `Record<providerId, base64 safeStorage>` + `__aiden_internal_provider_binding_v1__:<id>` entries + quarantine slots | mode 0600, staged write + fsync + dir fsync |
| `pi-provider-credentials.json` | local | `{version:1, entries: Record<id,{type, ciphertext}>}` | Pi credential store; per-provider mutex; safeStorage ciphertext |
| `pi-provider-models.json` | local | `{version:1, entries: Record<providerId, ModelsStoreEntry>}` | Pi dynamic catalog snapshots (non-secret) |
| `mcp-oauth.json` | local | `Record<serverId, base64 safeStorage(session JSON)>` | dual-stage write + rollback file, ownership-gated commit |
| `chats/index.json` | local | `ChatMeta[]` sorted updatedAt desc | recovery from payload scan; corrupt quarantine |
| `chats/<chatId>.json` | local | full `Chat` | transactional markers `.chat-transaction.<id>.pending` |
| `schedules.json` / `schedule-runs.json` | local | `ScheduledTask[]` / `ScheduledRun[]` | ≤50 runs per task |
| `usage.json` | local | `{version:1, buckets: DailyUsageBucket[]}` | per-day × source × provider × model aggregates; **no content** by design |
| `subagent runs` | local | `runs.json` `{version:1, runs[], pendingChatDeletions[]}` | native-helper custodian (§4.4); dir from `subagent-run-store.ts` |
| `~/.aiden/scripts/*` | portable | user scripts | scheduled script mode |
| `~/.aiden/skill(s)/` | portable | SKILL.md trees | skills discovery (global + workspace) |

`DataStore<T>` (`data-store.ts`) is the universal JSON engine behind most local
files: lazy single-load cache, serialized mutation tail, atomic
stage-fsync-rename-dirsync writes, corrupt-file parking (`.invalid-<iso>`),
held/previous inode retention with sha256-encoded names for crash recovery,
external-change rejection via content-hash comparison. **Port note: this
durability protocol is the product's data-safety story — replicate semantics,
not necessarily the exact inode dance.**

`secret-map-core.ts`: the shared parser/mutator for the three encrypted maps
(strict key validation, no prototype pollution, structured-binding
future-proofing).

Usage accounting (`usage-store-core.ts`): `UsageRequestRecord` per model call
(timestamp, source ∈ `chat|chat-title|voice-transcription|scheduled|subagent`,
provider/model ids+labels, local flag, status, nullable token breakdown, cost
status, costUsd) folded into daily buckets; cannot carry prompts/paths/content
by construction.

---

## 8. renderer/shared — the wire contracts

These dependency-free modules are imported by both processes; they are the
stable protocol a Rust port should transcribe first:

| Module | Contract |
|---|---|
| `generation-timeline.ts` | `GenerationTimeline` v2 (§1.1) + parsers/sanitizers |
| `generation-thinking.ts` | `GenerationThinkingLevel` enum + guards |
| `anthropic-thinking.ts` / `google-thinking.ts` / `codex-thinking.ts` | per-provider thinking levels, model→levels mapping, pref merge |
| `subagent-runs.ts` | `SubagentRunSnapshotV1`, `SubagentMessageReferenceV1`, state sets, id safety (`isSafeSubagentIdentifier`), text sanitization |
| `subagent-runs-v2.ts` / `subagent-management-v2.ts` | background run control protocol (list/stop/approve management requests) |
| `subagent-safe-text.ts` | snapshot text sanitizer (shared trust boundary) |
| `assistant.ts` | `ASSISTANT_WORKSPACE_ID="assistant"`, automation limits, `ToolApprovalDetails` union (4 approval kinds, §4.3) |
| `appearance.ts` | `AppearanceConfig` v1 (mode, light/dark `ThemeVariantConfig`, presets aiden/slate/berry/moss, fonts, motion, diff markers) |
| `keybindings.ts` | 26 `CommandId`s, `CommandDefinition` (binding, scope, category, palette/settings visibility), `KeybindingOverridesV1` |
| `google-provider.ts` | `GOOGLE_PROVIDER_ID`, legacy `gemini` id migration |
| `provider-deployment.ts` | `isLocalProviderDeployment` (loopback inference) |
| `claim-check.ts` | post-turn unverified-success annotation |
| `chat-workspace.ts` | `persistedChatWorkspaceId` (undefined → "default") |
| `app-update.ts`, `dictation.ts` | update status / dictation payload contracts |

Main-process IPC handlers (`main/handlers/*.ts`) validate every payload against
these shapes — the renderer is never trusted (`chat-params.ts`,
`assistant-parse.ts`, `scheduled-tasks-parse.ts`, `phase2-parse.ts`).

---

## 9. The 15 most important data structures (transcribed)

1. **`pi-ai Model<Api>`** — §2.1 (routing record: id/api/provider/baseUrl/
   reasoning/thinkingLevelMap/input/cost/contextWindow/maxTokens/compat).
2. **`pi-ai AssistantMessage` + `AssistantMessageEvent`** — §2.1 (content
   blocks, Usage, StopReason; 14-variant stream protocol).
3. **`pi-agent-core AgentTool / AgentToolResult / AgentEvent`** — §2.5 +
   `pi-agent-core/dist/types.d.ts:306-400` (tool def, result, 11-variant agent
   event union incl. `tool_execution_*`, `turn_*`, `agent_*`).
4. **`ChatMessage` / `Chat` / `ChatMeta`** — §1.1.
5. **`Attachment`** — §1.1 (image base64 vs inlined text).
6. **`GenerationTimeline` / `AgentStep`** — §1.1.
7. **`ChatStartParams` + push payloads (`ChatDelta`, `ChatDone`, `ChatError`,
   `ApprovalRequest`)** — §1.3.
8. **`SubagentRunSnapshotV1` / `SubagentMessageReferenceV1`** —
   `renderer/shared/subagent-runs.ts:56-108`: versioned, id-bound
   (runId/groupId/generationId/childId/chatId/workspaceId), revision, role,
   label/taskPreview, state, bounded activity/latestText/terminalMarkdown/
   error/warnings, counters (turns/tools/tokens), milestones (6 closed kinds).
9. **`SubagentToolRequest` / `SubagentTaskResult` / `SubagentAuthorityV2` /
   `SubagentBudgetV2`** — §4.1/§4.2.
10. **`StoredProvider` / `Provider` / `ProviderModelMetadata`** —
    `types.ts:19-75`: `{id, kind:"openai"|"anthropic", label, baseUrl, models[],
    modelMetadata?, defaultModel?, needsKey, deployment?, isPreset?, isBuiltin?}`
    + renderer-only `{hasKey, legacyIds?, authMethods?}`; metadata
    `{source:"lmstudio"|"ollama"|"provider", name?, type?, vision?, toolCall?,
    reasoning?, thinkingLevels?, thinkingCanDisable?, contextLength?,
    parameterCount?, format?}`.
11. **`McpServer` + `McpPreset` + `McpOAuthSession`** — §3.1/§3.4/§3.2.
12. **`Workspace` / `ManagedWorktree` / `WorkspacePermission`** —
    `types.ts:77-113` (permission `"full"|"ask"|"none"`; worktree git
    identity: repositoryPath, worktreePath, branch, worktreeGitDir,
    ownershipToken, device/inode, createdFromHead).
13. **`ScheduledTask` / `ScheduledRun` / `ScheduledTaskSettings`** — §5.1.
14. **`AppSettings` / `AssistantConfig` / `AppearanceConfig`** —
    `types.ts:415-488` + `appearance.ts` (§8).
15. **`ComputerUseParameters` + `CuaDriverToolCatalog` + `ComputerUseStatus`** —
    §6.1/§6.2 + `types.ts:490-514` (status state machine: `disabled | ready |
    permission_required | production_build_required | unsupported |
    unavailable | incompatible | error`, per-permission tri-state
    accessibility/screenRecording).

---

## 10. Rust crate recommendations (per area)

### 10.1 Provider streaming (replaces pi-ai) — the core build

| Need | Crate | Notes |
|---|---|---|
| Async runtime | `tokio` (rt-multi-thread, macros, time, sync) | One runtime; GPUI bridge via `gpui-tokio-bridge` or channel into `cx.spawn()` (see research-gpui-patterns.md) |
| HTTP | `reqwest` (rustls, stream, json) | Disable default native-tls to avoid OpenSSL; `rustls-tls-native-roots` |
| SSE parsing | `eventsource-stream` + `reqwest` bytes stream, or `reqwest-eventsource` | Anthropic/OpenAI/Google all SSE except Codex |
| WebSocket (Codex transport) | `tokio-tungstenite` | `openai-codex-responses` supports websocket transports |
| JSON | `serde` + `serde_json` (`json!`, `Value`) | `#[serde(tag="type", rename_all="camelCase")]` models the event unions precisely |
| JSON Schema for tools | `schemars` | Replace typebox: derive per-tool params; `schemars::JsonSchema`; keep `Type.Unsafe` escape hatch as raw `serde_json::Value` |
| Token estimation | keep chars/4 heuristic; optional `tiktoken-rs` | Aiden's estimator is heuristic + provider-usage anchor (§1.4) — no tokenizer dependency needed for parity |
| Retry/timeout | `tokio::time::timeout`, custom backoff or `backon` | pi semantics: maxRetries, maxRetryDelayMs cap, never-throw streams (encode errors as terminal events) |
| Stream type | `async_stream` / `futures::Stream` | Model `AssistantMessageEventStream` as `mpsc::Receiver<AssistantMessageEvent>` or `BoxStream` |

Suggested port shape: `trait ProviderApi { fn stream_simple(&self, model:
&Model, ctx: &Context, opts: &SimpleStreamOptions) ->
BoxStream<'static, AssistantMessageEvent>; }` with one impl per API family
(openai-completions, openai-responses, anthropic-messages,
google-generative-ai, codex-responses). Aiden only needs 5 of pi's 10.

### 10.2 Agent loop (replaces pi-agent-core)

No crate — build directly: a `turn` loop consuming the stream, dispatching
`AgentTool::execute` (trait objects with `schemars` params), sequential/
parallel modes (`tokio::task::JoinSet` for parallel), `before_tool_call` /
`after_tool_call` hooks, steering/follow-up queues, and the event fan-out as
`tokio::sync::broadcast`. The approval gate is a `oneshot` per
`approvalId` resolved by the UI. All Aiden-specific policy (compaction §1.4,
approval, timeline projection) is plain Rust functions over the message vec.

### 10.3 MCP

- **Official `rmcp` crate** (modelcontextprotocol/rust-sdk, formerly
  `mcp-sdk-rs`): client + stdio/sse/http transports, OAuth hooks. If its
  maturity is a concern, JSON-RPC over stdio is simple to hand-roll with
  `tokio::process` + `serde_json`; HTTP/SSE via reqwest + eventsource-stream.
- OAuth: `oauth2` crate (PKCE S256, device code), loopback listener with
  `axum`/`tiny-http` on fixed port 41390 equivalent; dynamic client
  registration is plain POST JSON.
- Tool name namespacing + `Type.Unsafe(inputSchema)` → pass-through
  `serde_json::Value` schemas.

### 10.4 Persistence & durability

- JSON files: `serde_json` + `tokio::fs`; atomic writes via
  `tempfile::NamedTempFile::persist` (or `atomicwrites` crate) + explicit
  `File::sync_all` + directory fsync (`fs::File::open(dir).sync_all()` — works
  on macOS). Serialization of the mutation queue: `tokio::sync::Mutex` per
  store. The chat-store transaction markers and DataStore held/previous inode
  protocol are pure std::fs logic — port the state machines, keep the regexes
  as `regex` crate literals or hand-rolled checks.
- Paths: `directories::ProjectDirs::from("", "", "aiden-agent")` for the local
  root; `~/.aiden` + `AIDEN_CONFIG_DIR` env for portable (keep exact semantics:
  absolute-path override only).
- If SQLite is preferred for usage/subagent runs: `rusqlite` with `bundled`,
  off the main thread (matches research-gpui-patterns.md §1). JSON parity is
  simpler for migration (reuse existing files).

### 10.5 Secrets

- `keyring` crate (macOS Keychain) — replaces Electron safeStorage. Store
  `provider-keys.json` semantics as keychain items directly, or keep the file
  layout and encrypt values with a keychain-held data key (preserves the
  binding/quarantine slots verbatim). Keep: keys never leave the "main"
  authority layer; renderer-equivalent sees only `hasKey`.

### 10.6 Scheduling

- `croner` → **`croner-rs`** is not official; best fits: `cron` crate
  (5/6-part expressions, `Schedule::upcoming(tz)`) with `chrono-tz` for IANA
  timezones, or port croner semantics via `saffron` (croner author's Rust
  crate — closest to "5-or-6-parts" mode). Tick loop on `tokio::time::interval`
  with the same claim-before-run persistence.
- Notifications: `mac-notification-sys` or `objc2-user-notifications` with
  deep-link handling.

### 10.7 Computer Use

- The existing `aiden-cua-broker` Rust crate ports **as-is** — it is already
  the boundary. In an all-Rust app, link it as a library instead of spawning
  the bridge: keep `jsonrpc.rs` guard + `signing.rs` verification; replace the
  Electron↔bridge stdio MCP transport with in-process channels. Keep the
  broker *process* model if TCC attribution to the separate signed bundle id
  must be preserved (recommended — permission grants survive app updates).
- Unix sockets: `tokio::net::UnixStream` or keep blocking `std::os::unix::net`
  on dedicated threads (current design).

### 10.8 Subagent helpers

- Replace the three C helpers with Rust bins in the same workspace:
  - run-store: `std::fs` + `libc::fstat` (or `rustix` for safer fd APIs);
    protocol stays line-based stdio.
  - file-mutator: `rustix` + `sha2`; keep the inspect→prepare→commit machine.
  - shell-runner: `std::process` + `nix`/`rustix` (setsid, rlimits, minimal
    env); keep the `AIDSH001` binary frame so approval digests stay stable.
- Alternatively, since the port is all-Rust, fold them into the main binary
  behind `--helper <role>` argv dispatch — but keeping separate signed
  executables preserves the audit/TCB argument and the existing test scripts.

### 10.9 Apple Foundation Models

- Keep the Swift helper binary unchanged; spawn it with `tokio::process` and
  the same file-based JSON protocol (version 1, 20KB cap, timeouts). Or use
  `objc2-foundation` + the Foundation Models framework directly once stable
  Rust bindings exist — not recommended today.

### 10.10 Supporting crates

- Global hotkey: `global-hotkey` (assistant/composer/dictation accelerators).
- Regex for grep tool: `regex` (RE2-equivalent safety: linear-time guarantee).
- Glob: `globset`. Semver for update/driver checks: `semver`.
- Hashing: `sha2` (sha256 used throughout — credential revisions, authority
  digests, approval pins, DataStore held-file names). UUIDs/ids: keep base36
  `timestamp-rand` ids (hand-rolled, 12 lines) for file-name parity; `uuid`
  elsewhere.
- Error handling: `thiserror` (domain errors like `CodexRuntimeError`,
  `CuaDriverError`, `SubagentFileMutatorError` map 1:1) + `anyhow` at edges.
- Logging: `tracing` + `tracing-subscriber` (Aiden's `logger.info/warn/error`
  with channel tags maps to targets).
- Test parity: the TS suites are `node:test` contract tests — port them as
  `#[tokio::test]` against the same shapes; the strict parsers (subagent-runs,
  timeline, contracts) should be property-tested with `proptest`.

---

## 11. Port risk notes (observed, not inferred)

1. **Never-throw stream invariant.** Every pi transport encodes failure as a
   terminal event; Aiden's terminal-error logic (`terminalGenerationError`,
   abort/interrupt distinction) depends on it. Rust `Stream` impls must not
   panic/error-out mid-turn.
2. **Credential binding is a load-bearing security feature**, not bookkeeping:
   keys are bound to exact endpoint snapshots; MCP presets refuse redirects;
   scheduled tasks pin provider+MCP fingerprints; subagent authority pins
   connection+schema+profile digests. Dropping any of these silently widens
   credential reach.
3. **Owner-document fencing.** Every mutating IPC re-checks renderer ownership
   at async boundaries (`isCurrent()`). In GPUI this becomes window/entity
   liveness checks — design it in from the start; retrofitting is what most of
   the TS code volume is.
4. **Compaction is deterministic and tested.** Port `generation-context.ts`
   literally (it is Electron-free); its fallback-notice contract
   (`CONTEXT_FALLBACK_TEXT` must not call tools) is user-visible behavior.
5. **The JSON files are the migration path.** Keeping the exact on-disk
   layouts (§7) lets the Rust app read existing installs; the strict parsers
   (chat meta validation, run snapshots, timeline versions) define the
   acceptance tests.
6. **Network calls are allow-listed by policy** (AGENTS.md): models.dev only in
   release scripts; Artificial Analysis free endpoint only after explicit user
   action. A port must keep this — no ambient catalog fetching at startup
   beyond Pi's `refresh({allowNetwork:false})` hydration pattern.
