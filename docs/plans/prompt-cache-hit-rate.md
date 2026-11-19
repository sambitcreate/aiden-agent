# Prompt cache hit rate: keep the cached prefix byte-stable

Status: In progress (2026-11-19): phases 0, 1, 2, 3, 4, 5, 6 and 7 implemented. Delivered as one PR with one stacked commit series per phase, branch `feat/prompt-cache-stability`, cut from `main` at f2fd27640.

## Goal

Keep the provider prompt cache as close to 100% of input tokens as the provider allows, on every surface: desktop workspace chats, Bots, side calls, `aiden serve`, and Remote-driven chats.

A cache hit needs a byte-identical prefix, ordered tools, then system, then messages:

- Changing a tool or the model invalidates everything.
- Changing the system prompt keeps only the tools cache.
- Changing `tool_choice` or images invalidates the messages cache but keeps tools and system.

The audit (Opus, Carbon v2 and Neon, scored 2026-11-18) found 33 distinct causes. Most come down to three things: per-request bytes in the head of the prompt, a tool list that changes between turns, and side calls that pay full price for a prefix the parent already cached.

## Success criteria

- **Two-turn prefix test.** The new harness passes for a workspace chat, a Bot chat and an `aiden serve` chat. It sends two turns with no user-visible state change, captures both provider payloads, and checks that the second payload's tools and system and the first payload's messages are a byte-identical prefix of the second.
- **Cache miss attribution.** Every request with a lower `cacheRead` than expected logs one `detectCacheMiss()` reason with a source label (`tools`, `system:<section>`, `messages`, `model`, `ttl`, `retention`). The fixtures in phase 0 have zero unexplained misses after phase 8.
- **Measured hit rate.** On the recorded replay sessions (`npm run pi:upgrade:evaluate`, the replay gate), the cache-read share of input tokens on turn 2 and later is at least 90% for Anthropic direct, Bedrock and OpenAI Responses. The phase 0 baseline is recorded in the PR description so the gain is a measured number, not a claim.
  - Compaction counts toward this only for chats with no approved memory fact. Memory is on by default, and any approved fact sends the summary through the isolated request (phase 5), so the cached summary and the background summary currently reach only chats with no approved facts. Most chats of a person who uses memory therefore still compact cold. Phase 6 accepted this limit: the facts stay in the system head, because a summarize view without them would no longer be a byte prefix and would lose the cache anyway.
- **Visible figure.** The context panel shows the cache percentage, including 0%.

## Shape of the PR

There is one PR. Each phase is a commit series that builds, passes its own tests and can be reviewed alone. Phases follow the merged fix order, with measurement first so every later phase shows its effect.

Each phase follows the phased-build-review loop:

1. Implement the phase.
2. Two Opus reviewers review it.
3. Fix their findings, and repeat until the review is clean.

At the end, four Opus high reviewers review the whole PR, and a CI watcher owns the PR checks. The PR is not merged without the owner asking.

| Phase | Fix order step | Theme |
| --- | --- | --- |
| 0 | 2 | Measurement and the prefix harness |
| 1 | 1 | Stable AGENTS.md nonce and turn-fixed system sections |
| 2 | 3 | Fixed tool list |
| 3 | 4, 10b | Hook context on its message, frozen per-chat state |
| 4 | 7 | Side calls share the parent prefix; one-off calls write no cache |
| 5 | 6 | Compaction on the cached prefix, then in the background |
| 6 | 8 | Idle warming on real TTLs, `aiden serve` parity, long retention |
| 7 | 9, 10a | Screenshot trimming in batches, retire the Gemini explicit cache |
| 8 | 5, 11 | Codex WebSocket and TTL, message threads, provider routing |

## Phase 0: measurement and the prefix harness

**Why first.** Without per-source attribution, a later phase cannot prove it helped, and a regression goes unseen.

**Changes**

- `main/services/pi-cache-telemetry.ts` (new):
  - Wraps Pi's `detectCacheMiss()` for each finished request.
  - Hashes each payload section: tools, each system section by its journal label, and the messages prefix.
  - Compares the hashes with the previous request in the same chat and records the first section that differs.
  - Keeps the hashes only, never content.
  - Logs at debug level through the existing chat diagnostics.
  - The context panel reads the result over the existing context IPC.
- `main/services/llm-client.ts`: call the telemetry from the existing `onPayload` and usage paths.
- `packages/cli/src/daemon-chats.ts`: call the same telemetry, so `aiden serve` reports the same reasons.
- `renderer/components/chat-context-panel.tsx`, lines 86-87: render the cache percentage when it is 0, and show the last miss source as a muted line ("Cache missed: tools changed").
- **Prefix harness:** grow the seed in `docs/research/experiments/context-provider-payload-cache.ts` into `main/services/prompt-prefix-harness.ts`, a test helper.
  - It drives `llm-client` against a fake Pi provider that records payloads.
  - It returns the payloads with the section hashes.

**Analytics.** No event in this phase. If an aggregate cache-hit share is wanted later, it goes through the analytics registry: a bucketed number with no content, a docs row and a test.

**Tests**

- `main/services/pi-cache-telemetry.test.ts`: fixtures of payload pairs, covering a changed tool description, a changed system section, an edited earlier message, a model switch and a TTL lapse. Each must name the right source.
- `main/services/prompt-prefix-stability.test.ts`: the two-turn harness for a workspace chat. Cases fixed by later phases are marked `todo` here and switched on by the phase that fixes them, so the gain is visible commit by commit.
- `renderer/components/chat-context-panel` render test: 0% is rendered and the miss line appears.

**As built (2026-11-18).** The code differed from the plan in these ways:

- Pi 1.5.2 does not export `detectCacheMiss()`, so `pi-cache-telemetry.ts` ports its rules (`measurePromptCacheMiss`, `nextPromptCachePreviousRequest`), and a CLI parity test checks the port against the bundled server.
- Attribution fingerprints the normalized transcript Pi hands the stream function, not the `onPayload` payload. Each system message is labelled by its section: `base` for the head, and a refresher's label with its per-request suffix removed.
- Two labels were added: `system:base` for the head prompt, and `unknown` for a miss no section explains.
- `ttl` uses the model's documented cache lifetime (`promptCacheTtlMs`), falling back to Pi's 5 minutes when none is documented. Hashes carry a per-process random salt, and each history message is hashed once.
- The last miss clears when a later request reads from the cache, and on compaction. The panel's "from cache" figure, 0% included, appears only for a chat with cache activity, a documented cache or a measured miss, so a provider with no cache shows none.
- `aiden serve` feeds the `cache_warm` entries Pi's cache warmer writes to the session into the telemetry before each request, so warming restarts the lifetime there too.
- The desktop logs each miss at debug level and adds `lastCacheMiss {source, at}` to the context pressure feed. `aiden serve` passes no `cacheRetention` and writes the miss to stderr only when `AIDEN_PROMPT_CACHE_DEBUG=1` is set. The field is not part of the Remote context pressure contract.
- llm-client's per-request system prompt and tool list now come from `main/services/chat-prompt-assembly.ts`: `buildWorkspaceChatBasePrompt` for the base prompt, and `assembleChatPrompt` for the extension contributions, the codemode partition and on-demand tools (`toolsFor(history)`). llm-client and the harness both call it, so a harness case runs the same builders as a chat. The Bot runtime's fixed sections come from `composeBotSystemSections` in `bot-system-prompt.ts`, which `bot-session-main.ts` and the harness share.
- The harness runs each turn through `PiAgentRuntimeHarness.runManaged` over a real durable session (`InMemorySessionRepo`), the path a desktop chat takes. With it come:
  - the real AGENTS.md and `mcp_servers` refreshers, applied first and between tool turns
  - `createGenerationContextTransform`
  - the Pi Anthropic Messages and OpenAI Responses adapters, rendering offline with zero network calls
- Before each run, the managed run's shared prepare step rebuilds the context from the journal and folds the head and the system patches of the turn's first prepare into one system message, with compaction on or off. So a section patch added at turn start ends up in the head on every wire, including those with mid-conversation system messages. The phase 0 harness did not model this fold, which made the unchanged MCP section look like a miss on OpenAI Responses.
- Each changing case is driven through the real builders: branch and permission through the base prompt, memory through `createMemoryExtension`, on-demand tools through `load_tools`, and Bot open work through `composeBotSystemSections` and `renderBotOpenWork`. Bot cases run on Pi Durable through `createBotRegistry`, the Bot extension's real section builder, with the per-request `aiden-memory` section, and record through the same `createPromptRequestRecorder` as the workspace cases. The Bot instructions and file authority for a desktop Bot chat are chosen in `chat-prompt-assembly.ts` (`bot`), not in llm-client. Each `todo` case also asserts, outside the stability check, that the changed value still reaches the request, so deleting the value cannot pass as a fix.
- On a Bot, a section that changes between turns does not change the head: Pi Durable appends a section patch as a trailing system message, and the Anthropic adapter hoists it into the system block. The wire's system segment changes, but the normalized transcript only grows, so the miss telemetry attributes nothing. Bots have no miss telemetry wired today; when they get it, it must compare the hoisted system block, not only the transcript head.
- "No message is edited in place" runs three turns with AGENTS.md, MCP, an on-demand tool and screenshots, then re-fingerprints a deep copy of each request's messages. A match proves the telemetry's per-object hash memo (`pi-cache-telemetry.ts`) never serves a stale hash.
- Browser discovery is not modelled: it lives in llm-client's generation setup, outside the assembly. Per-request hook context is not modelled either (phase 3).

**Already stable:**

- a plain two-turn chat on Anthropic Messages, Anthropic Messages with in-place system messages, and OpenAI Responses with in-place system messages
- an unchanged MCP section on all three wires, because it is folded into the head at turn start
- a tool loop within one turn
- a chat with no AGENTS.md
- a Bot's second turn, memory section included, and a turn after the Bot's own `bot_memory` save (the save does not re-render the section within the session)
- no message edited in place after a request carried it
- an on-demand tool loaded in one turn, which stays declared from the start of the next (`initialTools`)

**Baseline: the `todo` cases, all failing today.** Each row gives the first changed wire segment and what the telemetry reports.

| Case | First changed segment | Telemetry reports |
| --- | --- | --- |
| AGENTS.md nonce, all three wires | system | `system:agents-instructions` |
| On-demand tool loaded mid-turn (step 2 against step 1) | tools | `tools` |
| Bot open work between turns | system | none: trailing section patch, hoisted by the wire |
| A person's Bot memory edit (`aiden-memory`) | system | none: trailing section patch, hoisted by the wire |
| Branch switch | system | `system:base` |
| Permission mode change | system | `system:base` |
| Memory edit | system | `system:base` |
| Fourth `computer_use` screenshot trims an earlier image | messages | `messages` |

## Phase 1: stable AGENTS.md nonce and turn-fixed system sections

**Causes**

- `agents-instructions.ts` draws a `randomUUID` nonce for every request, so the AGENTS.md section differs every turn. `acp/prompt.ts:31-47` already uses a fixed nonce, but only for ACP.
- `llm-client.ts` around 4148-4164 appends `sys_agents` and `sys_mcp` after the journaled head without journaling them, so they are rebuilt and can reorder or change.
  - Phase 0 found that a patch added at turn start is folded into the head before the run, so an unchanged MCP section is already stable across turns on every wire. What remains for MCP is a section that changes in the middle of a turn, which the late-admission check below covers.

**Changes**

- `main/services/agents-instructions.ts`: derive the nonce as `HMAC-SHA256(perChatSecret, "agents")`, truncated.
  - The per-chat secret is created once, stored with the chat's metadata and never sent to the model.
  - The nonce still delimits untrusted AGENTS.md text, and stays unguessable to the file author before the chat exists.
  - ACP adopts the same derivation, and `STABLE_AGENTS_NONCE` is removed.
- `main/services/llm-client.ts`: journal the head, AGENTS.md and MCP sections the way the head already is. A section is rebuilt only when its inputs change: the file content hash, or the set of admitted MCP servers.
- `main/services/mcp-tool-discovery-core.ts`: **verify before fixing.**
  - Write a test in which a server is admitted after `MCP_DEFERRED_ADMISSION_WINDOW_MS` and check whether `<mcp_servers>` changes in the middle of a turn.
  - If it does, a late server joins the section at the next user turn instead of the next request.
  - If it does not, record the result in the PR description and change nothing.

**Tests**

- `agents-instructions` unit test:
  - The same chat gets the same nonce on every call; different chats get different nonces.
  - A file containing a guessed nonce still cannot close the section, which is the existing injection oracle extended.
- In `prompt-prefix-stability.test.ts`, switch on "AGENTS.md section is identical across turns" for all three wires. The MCP case already passes (phase 0).
- The MCP late-admission test, whatever it finds.

**As built (2026-11-18).** The code differed from the plan in these ways:

- The per-chat secret is derived, not stored: `HMAC-SHA256(deviceKey, chatId)` (`main/services/prompt-section-secret.ts`). Chat records reach the renderer, paired phones, exports and forks, so a secret in the chat's metadata would travel with them. A derived secret also covers runs with no journal.
  - The device key is 32 random bytes in `prompt-section-key` in the app's data folder, mode 0600. It is written to a private temp file and hard-linked into place, so it appears whole and a concurrent creator's key wins and is read back. A damaged file or a symlink at that path is replaced by a rename, never written through. A stored key others can read is tightened to 0600 and is not trusted if that fails.
  - If the folder cannot be written, the key is random for the process, and Aiden logs that once (no path, no key). The nonce is then stable within a run but changes after every restart, so an ACP chat with AGENTS.md replaces its native session on its first turn of each launch.
- The nonce is `HMAC-SHA256(chatSecret, "agents-instructions")`, cut to 128 bits and written in UUID form, so the block keeps its width. The context estimate draws a random secret of the same shape and never sends it.
- AGENTS.md records are written with every `</` escaped as `<\/`. They decode to the same strings, and a file cannot spell the closing tag even after its author has seen the nonce in an earlier turn of the same chat. The model therefore sees `<\/` wherever an AGENTS.md file says `</`, for example in HTML or XML samples.
- No journaling was needed yet. Each section is a pure function of its inputs (the files' content, the admitted servers), and the managed run folds a turn-start patch into the head (phase 0). A deterministic nonce is enough to make the AGENTS.md section byte-identical across turns on all three wires. This leans on the head collapse; phase 8 must journal the two sections, or otherwise keep them stable, before it removes the collapse.
- Both sections are built by one Electron-free factory, `main/services/chat-prompt-sections.ts` (`createChatAgentsInstructions` from the app data folder and chat ID, `createChatMcpServersSection` from the runtime's inventory and the late-discovery count). llm-client and the prefix harness both call it, the harness with a temp data folder, so the stability suite fails if the secret stops being per chat.
- ACP takes the nonce from the same refresher. `STABLE_AGENTS_NONCE` and the nonce normalization are gone; the host-instruction fingerprint now hashes the delivered text as is. An existing ACP chat with AGENTS.md replaces its native session once, on its first turn after the upgrade, because its stored fingerprint was taken over the normalized text.
- The MCP check found a change in the middle of a turn. llm-client re-rendered `<mcp_servers>` between steps from the runtime's callable inventory, which includes servers whose discovery finished after the admission window. The section is now rendered once per generation, from the servers admitted at turn start (`createChatMcpServersSection`). A server whose discovery finishes later stays out of the section for the rest of that generation, steering turns included, and is listed from the next generation on. It is callable at once through codemode and `tool_search`. When servers are still connecting at turn start and either tool is declared, the section ends with one fixed line: "More services may still be connecting; once connected, find them with codemode or tool_search." (naming whichever of the two the turn has). `mcp-tool-discovery-core.ts` is unchanged.
- `aiden serve` does not use the AGENTS.md refresher or this MCP section, so it needed no change.

## Phase 2: a fixed tool list

**Causes.** The tool list changes between turns:

- Browser discovery is reset per generation (`browser-discovery.ts`, `let requested = false`).
- `on-demand-tools.ts` `initialTools(messages)` adds tools into the head.
- `agent-tool-assembly.ts:187` adds `form_fill` only sometimes.
- Visualize is toggled in `generative-ui-extension.ts`, and the `REMOTE_APP_CONTROL_TOPICS` tools depend on the audience.
- Unattended follow-ups drop tools (`follow-through/notice-delivery-main.ts:95-113`), and so do Bots (`bot-extension.ts` `turnAllows`).
- Tool descriptions embed changing inventories: the `message_bot` peer list (`bot-messages/tool.ts`) and the subagent MCP and model lists (`subagents/subagent-tool.ts:135-178`).
- Bots rewrite `messages[0]` with `renderBotOpenWork` (`bot-session-main.ts:703-704`).

**Changes**

- **Fixed tool set per chat.** The tool set is computed once at chat start from durable inputs: provider capabilities, chat type, enabled MCP servers and settings. It is journaled with the head.
  - Tools that are discovered later (browser, on-demand) are announced by a tool result or an appended message.
  - They are not inserted into the tool list.
  - Browser discovery reads its "already requested" state from the journal instead of a per-generation variable.
- **Gated tools stay declared.** `form_fill`, visualize and the remote app-control tools are always present when the chat type can ever use them. Their availability is enforced in `beforeToolCall`, which returns a clear "not available in this turn" tool result.
- **Unattended limits.** Bot `turnAllows` and unattended follow-ups enforce their limits in `beforeToolCall` instead of removing tools. This keeps the same safety boundary: a blocked call never runs. The approval gate (`main/services/approval-gate/gate.ts`) stays the only decision point.
- **Inventories move out of descriptions.**
  - The `message_bot` peer list and the subagent MCP and model inventories become fixed descriptions.
  - The live list is returned by a cheap `list` action of the same tool, or appended to the turn's prompt tail when it changes.
- **Bots append, never rewrite.** `renderBotOpenWork` output is sent as an appended message at the end of the prompt. It no longer rewrites `messages[0]`.
- **Sorted schemas.** MCP tool schemas are serialized with sorted keys (`mcp-tool-discovery-core.ts`), so a server that reorders its JSON does not change the bytes. This is fix order step 11f, done here because it is local.

**Risk.** A tool that is always declared but blocked costs a wasted model turn when the model calls it.

- Mitigation: the blocked result names the condition, for example "available after you open the browser" or "not available in unattended runs", so the model does not retry.
- The approval-gate decision table tests guard the boundary.

**Tests**

- Prefix test, switched on: "tool list identical across turns" for a workspace chat, a Bot chat, an unattended follow-up and a remote-audience chat.
- Prefix test, switched on: "loading a tool mid-turn leaves the next step's prefix unchanged" and "Bot open work changing between turns does not change system".
- `bot-extension` behavioral test: a disallowed tool is listed, its call is blocked before execution with the stated reason, and no side effect happens.
- Browser discovery test: discovery on turn 1 still holds on turn 2 after a restart that reloads the journal.
- MCP schema test: two servers that send the same schema with different key orders produce identical tool bytes.
- `subagent-tool` and `bot-messages/tool` tests: the description is identical whatever the inventory, and the list action returns the inventory.

**As built (2026-11-18).** No tool set is journaled. Each declaration is now a pure function of the chat and its settings, and each turn's conditions are enforced per call, so the same inputs give the same bytes on every turn. The code differed from the plan in these ways:

- **One refusal point per surface.**
  - Workspace chats: `main/services/chat-turn-tool-policy.ts`. `chatToolOffers(surface)` decides declarations from the chat alone. `chatTurnToolRefusal(surface, turn)` names what this turn refuses: unattended, paired device, or inline visuals On request without /visualize. `chatTurnAudienceFor(options, params)` maps a generation's options and parameters to that turn, so llm-client and the tests share one mapping.
  - llm-client collects the turn's refusals (`turnToolRefusals`, combined by `firstTurnToolRefusal`) and checks them first in `beforeToolCall`, before the Computer Use access check, the approval gate and execution. A refused call is recorded as denied, its timeline row ends as blocked, and it returns `{ block: true, reason }`.
  - Nested codemode calls pass through the same `beforeToolCall`. The approval gate is unchanged and is still the only place approvals are decided.
- **Bots.**
  - Candidates no longer depend on ingress. `turnAllows` (`botIngressAllowsTool` with `withBotMemoryIngress`) is enforced on every call in `authorizeTool`, `admitEffect` and the assembly policy. The refusal text comes from `botIngressRefusal`, for example "only a routine run has a notepad".
  - The `aiden-memory` guidance now follows the `bot_memory` declaration rather than the ingress, so routine and person turns share the system text. A routine's save is refused before it runs. Memory flush before compaction still follows the ingress.
  - Open work is rendered once per person input and appended after it as a request-only tail, memoized in-process. It never rewrites `messages[0]` or the system sections.
- **Inventories.**
  - `message_bot` has a fixed description and an `action: "list"` that returns the peers.
  - The subagent tool's description and parameters depend only on settings flags. The MCP and model inventories come from `action: "list"`, and the host still enforces exact server/tool pairs, lanes, models and efforts before anything launches.
  - A supervisor with no model policy now refuses model and effort requests instead of silently inheriting them. Nested child tools keep a per-run inventory.
  - The `message_bot` offer no longer depends on the ingress chain; the chain limit is refused per call. On the desktop and in the CLI, its declaration depends only on the messaging switch and the Bot's own send setting (`messageBotOffer` in `bot-messages/candidate.ts`, shared by both hosts). It no longer reads every Bot to see whether a peer accepts messages, since `action: "list"` and posting check that per call. A Bot that is the only one accepting messages now declares the tool, and `list` tells it no other Bot accepts messages.
  - The CLI parity test "durable CLI Bots can message each other" no longer drives the refused relay from the reply turn through the model (the refusal is covered by the bot-tool-policy and bot-extension tests). Instead it posts directly from a reply-hop run and expects `chain_too_deep`, with no provider request. It still checks the reply turn declares the same tools as the person's turn. Its pre-existing 10 s reply-wait loop can still time out under very heavy host load, with or without this change: in an alternating run at load 120-175, the pre-fix build failed 1 of 6 and the fixed build 2 of 6, both at that loop. The timeout was not raised.
  - An end-to-end test of llm-client's `beforeToolCall` refusal and head-time `browserDiscovery.prepare` was not added: both run only inside `llmClient.start`, behind about 260 imports and the full desktop setup, and the only existing seam stubs every import and reaches `cancel` alone. Instead, the options-to-audience mapping is one function (`chatTurnAudienceFor`) that llm-client calls and `chat-turn-tool-policy.test.ts` checks for each option combination. Coverage stays split across `chat-turn-tool-policy.test.ts` (the mapping and the decision), the remote-chats tests (the options wiring), `prompt-prefix-stability.test.ts` (the declarations), and `browser-discovery.test.ts` plus the managed-runtime discovery cases in `pi-agent-runtime-harness.test.ts`.
- **On-demand and browser tools.**
  - The transcript head declares only the chat's fixed tools: the everyday set plus `load_tools`. A tool loaded mid-turn is declared by the system message the agent loop appends, which the journal keeps.
  - On wires that append tools, the next step's prefix is unchanged. Other wires take one miss when a tool loads. Both deferrals have an owner and a todo case in `prompt-prefix-stability.test.ts`:
    - Plain Anthropic Messages, mid-turn: owned by phase 8 (deferred tool declarations). Collapsing the load into codemode instead would change which tools the model can call directly, so it is not a cheap fix.
    - Cross-turn: owned by phase 8, because the turn-start head collapse folds the addition into the head.
  - Browser discovery reads "already requested" from the transcript (`browserDiscoveredIn`), so a journal reload keeps the tools from the first step of the next response. The guidance is appended once.
  - Access is checked when the browser tools are offered and again on every call, so a remembered discovery grants nothing new. A compaction that folds the discovery result away after a restart can cost one rediscovery.
- **Gated tools.**
  - Every chat declares all five app tools with the full topic list. A paired-device turn refuses settings reads, changes, `aiden_open` and panels the phone does not show. Each tool refuses again in `execute`.
  - Inline visuals On request keeps `render_artifact` and `render_ui` declared and refuses them without /visualize. Drafts are off in those turns. On request users now run the HTML-store check on every turn, but it no longer blocks a plain turn: a store that is unavailable or holds an unrecovered artifact is logged, the turn answers without drawing, and only a turn that may draw stops on it (`prepareGenerativeUiTurnStore`).
  - The /visualize and paired-device notes still vary the generative UI section of system. The tools cache holds. Moving the notes is phase 3, because `contentOverrides` drops text attachments and section patches fold into the head.
  - `hooks` (paired device and unattended) and `workspace_artifact` (paired device) stay declared and are refused, and their skills are no longer filtered.
  - `form_fill` is unchanged. It is compiled off (`FORM_FILL_MUTATION_AVAILABLE` is false), and its description embeds the turn's attachment IDs. Owner: phase 3, which moves the IDs into the turn tail as frozen per-turn state. That is also a precondition for turning it on. There is no todo case, because no build can reach the tool.
- **Unattended follow-ups** (`UNATTENDED_FOLLOW_UP_GENERATION`) now declare the chat's Computer Use, hooks and subagent tools, and refuse `computer_use`, `form_fill`, `hooks` and `subagent` per call. The Computer Use controller is created lazily and never reached.
  - The subagent tool's description no longer depends on its inventory, so declaring it costs nothing. In an unattended turn, llm-client never resolves the child connector inventory, so no MCP server is connected for a subagent nobody can watch.
  - The stability case builds the follow-up's tools through the real `subagentsAllowedForGeneration` and `assembleAgentTools` path.
  - The chat's connectors (`allowMcpTools: false`) stay withheld, because declaring them would connect servers nobody is watching. Owner: phase 3, which declares them from the chat's frozen inventory without connecting and refuses the calls. Todo case: "an unattended follow-up in a chat with connectors keeps the chat's connector section".
- **Paired-device turns** (`remoteGenerationSurface`) also keep the chat's Computer Use declaration and refuse `computer_use` and `form_fill`, since Computer Use is granted only on the Mac. A device that cannot answer question prompts no longer excludes `ask_user_question`. The surface sets `questionPromptsUnavailable`, the tool stays declared, and `chatTurnToolRefusal` refuses the call. The advisor's model chooser still gets no questionnaire on such a device, so its system note varies with the device. Owner of that note: phase 3, with the other audience notes.
- **Scheduled and Telegram generations** still pass `allowComputerUse: false`. This is not a miss within those chats: every turn on that surface withholds it alike. A person who continues such a chat on the desktop changes the usage source, so the whole tool list changes on that turn. Owner: phase 3, with the owed turn's per-chat declarations.
- **Owed turns** (the one turn a settled run owes its chat) still withhold Computer Use and the hooks tool (`windowOnlyToolNames` in `chat-owed-turn-start.ts`), so that turn costs one tools miss.
  - Folding only those two was not enough. An owed turn's owner has no window (`owner.id` is 0), so `rendererOwner` also drops the question, browser, scheduling, provider-auth connector and design canvas offers.
  - Owner: phase 3, which turns those window-dependent offers into per-chat declarations refused per call. Todo case: "the turn a settled run owes its chat declares the chat's tools". Done in phase 3; see its As built.
- **Sorted schemas.** MCP input schemas are serialized with sorted object keys.
- **Tests.**
  - `prompt-prefix-stability.test.ts` now covers "tool list identical across turns" for: a workspace /visualize turn against a plain turn; Bot routine, person and Telegram turns; an unattended follow-up; and a paired-device turn on all three wires.
  - It also covers a paired device that cannot show question prompts against a turn on this computer.
  - It also covers a tool loading mid-turn on every wire. The plain-wire mid-turn case and the cross-turn cases are phase 8 todos. The follow-up connector and owed-turn cases are phase 3 todos.
  - `chat-turn-tool-policy.test.ts` covers the refusals and their reasons, and `bot-extension.test.ts` covers a refused routine memory save. The subagent, `message_bot`, browser-discovery and MCP schema suites carry the rest.

## Phase 3: hook context and frozen per-chat state

**Causes**

- On the desktop, hook context is injected into the system prompt per request. The CLI already saves it on its user message (`daemon-chats.ts:314`).
- The base prompt embeds state that changes during a chat:
  - git branch, permission mode, memory (`memory-context.ts` around 394)
  - canvas (`llm-client.ts` around 2565, `volatileSystemPrompt`, concatenated in `pi-agent-runtime-harness.ts`)
  - visualize mode and the remote audience (`chat-system-prompt.ts:60-84`)
- Bots re-render the `aiden-memory` section on every request (`memorySection` in the Bot extension). The Bot's own `bot_memory` saves keep it fixed within a session, but a person's edit in the Memory panel (`memory.edit`) changes it on the next request, and the change reaches the wire's system block as a hoisted section patch.

**Changes**

- **Hook context.** Desktop hook output is saved on the user message it belongs to, matching the CLI. This is one shared helper for both surfaces, not two copies.
- **Frozen at chat start.** Branch, permission mode, memory, canvas, visualize mode and audience are read once at chat start and journaled with the head.
  - A later change is sent as a short appended `<state_update>` block at the end of the next user turn.
  - The model always sees the current value, and the head stays fixed.
- **Bounded growth.** Memory edits that happen during a chat are appended as a diff, not the whole memory. After compaction (phase 5) the head is rebuilt with the current state.
- **Deferred from phase 2.**
  - **Follow-up connectors.** Declare an unattended follow-up's connectors from the chat's frozen inventory without connecting, and refuse their calls.
  - **Window-dependent offers.** Make the offers that follow `rendererOwner` per-chat declarations refused per call, so an owed turn, a desktop continuation of a scheduled or Telegram chat, and a turn on this computer declare the same tools. These offers are Computer Use, hooks, questions, browser, scheduling, provider-auth connectors and the design canvas.
  - **Audience notes.** Move the paired-device, /visualize and advisor-chooser notes out of system.
  - **`form_fill`.** Move its attachment IDs out of the description and into the turn tail.
  - The phase 2 todo cases in `prompt-prefix-stability.test.ts` switch on with this work.

**Tests**

- Prefix test, switched on:
  - "branch switch does not change system"
  - "permission mode change does not change system"
  - "memory edit does not change system"
  - "a person's Bot memory edit does not change system" (the Bot's memory change goes out as a turn update, like the workspace memory)
- Behavioral test: after a permission-mode change, the next request carries the new mode in the tail, and the approval gate uses the new mode. The model-visible text and the enforced mode cannot disagree.
- Hook context test: the desktop and the CLI produce the same message shape for the same hook output.

**As built (2026-11-19).** Per-turn host text is journaled as hidden custom messages right after the prompt it belongs to (`turnFollowingMessages` in llm-client, passed as `following` to `runManaged`), in this order: hook context (`aiden-hook-context`), a state update (`aiden-state-update`, `<state_update>`), then one turn note (`aiden-turn-note`, `<turn_note>`). They are `display: false` and live only in the Pi journal. The chat store never saves them, so the desktop transcript, Remote API and the iOS and Android clients never show them as user text. The code differed from the plan in these ways:

- **Hook context** (`hookContextMessage` / `hookContextCustomMessage` in `workspace-chat-hooks.ts`, used by llm-client and the CLI daemon). It is request-only, as before, when the turn has no prompt (owed or continue), carries `inputContext`, runs on the skills-free projection, or retries a prompt the journal already holds. Those turns cost one miss on the next turn.
- **Frozen state** (`main/services/chat-frozen-state.ts`).
  - Head: branch, permission, always-on memory and canvas, journaled as `aiden.chat-head-state.v1` in the same append as the prompt (`chatHeadJournaling`, passed to the session store as the entries that precede it), so a head is never journaled without its turn. Updates are planned against the last announced state, so each change is sent once.
  - Moving between Ask first and Full access keeps the head. Read-only and None change the declared tools, so they re-head, with a corrective update when the context still holds an earlier announcement. The approval gate keeps enforcing the current mode, which the update names.
  - A memory edit that only adds facts goes out as the added facts, marked as untrusted data. The journal records each fact as its id and a hash of its line, never its text.
  - Privacy over cache: removing a fact or turning memory off rebuilds the head, and the update names removed facts by id only. Every request also drops a removed fact's line from earlier updates (`withoutForgottenFacts`, applied by the session wrapper and by `chatStateRequestMessages`), so no later request carries the removed text.
  - A fact the always-on cap (six facts, newest first) pushes out is not a removal. When the journal states a fact the block lacks, the turn reads the scope's still-approved facts from the memory store (`withApprovedMemoryFacts`). A fact still approved keeps the head, and the update says it is no longer always-on but `recall_memory` still finds it. Only a fact the person forgot, or memory turned off, re-heads and is named as no longer approved. That holds even when the fact left the block on an earlier turn, and when a new head was written since. If the store cannot be read, nothing outside the block is confirmed, so those facts take the removal path: named as no longer approved, kept out of the rebuilt head and scrubbed from history. The failure is logged without any fact text.
  - A fact stored across several lines renders as one line, so each fact is one hashed line and its text cannot start a line of its own.
  - No compaction sends a memory fact to the summarizer. Manual or automatic, summarized or compiled locally, every fact line in a `<state_update>` is taken out of the summary input (`withoutMemoryFacts` in `pi-compaction-core.ts`), because a summary is permanent and would keep a fact after the person removes it. The head rebuilt after the compaction states the facts that are still approved. The retained tail is kept as written, and each turn's reading drops what is no longer approved.
  - A compaction inside a run (a split turn) re-attaches the turn's state update after the kept prompt, so the model is not left with a head that no longer matches what is enforced.
  - A retry regenerates from the prompt the journal already holds rather than appending it again, so its head and update are not duplicated.
  - Re-heads also happen after a compaction, on a turn with no prompt, on the skills-free projection and without a journal.
  - Visualize mode and the paired-device audience are turn notes, not head state: they describe the turn, not the chat.
  - Deviation: the design-mode toggle still changes system. Owner: phase 8, with the head-collapse work.
  - Deviation: the CLI's workspace chats do not freeze branch or permission state. Their system prompt is Pi's own and states neither the branch nor the permission mode, so there is nothing to freeze. Owner: phase 6, with `aiden serve` parity.
- **Bot memory.** Deviation, privacy over cache: a person's edit (replace, remove or clear) always removes approved text, so it marks the snapshot stale and the next input re-reads it, which rewrites system once. The Bot's own writes still leave the snapshot cached. The next input's tail names what the person removed by count only (`<bot_memory_update>`, "Removed N entries."), never quoting the text, on the desktop and in the CLI. On a wire that keeps system messages in place, Pi Durable would still send the first snapshot as the head, so the Bot extension drops each earlier `aiden-memory` section that holds an entry the latest one lacks (`withoutRemovedMemory`). Limits: an earlier compaction summary, the model's own replies and earlier tool results can still hold the removed text.
- **Audience notes.** /visualize, a paired-device audience and a turn without the Advisor model chooser are turn notes. The Advisor's system guidance covers both cases, and a call missing both IDs on a turn with no chooser is refused with that reason. The chooser choice per turn is desktop-only; the CLI keeps its fixed no-chooser text. There is no full-Advisor stability case, only the unit tests in `advisor-runtime.test.ts`.
- **Turn notes need a prompt.** No turn note is sent on owed or continue turns; their audience is fixed by the surface that owes them.
- **`form_fill`.** Its description is fixed and the current message's attachment IDs ride in the turn note. Deviation: the tool's presence still follows whether the message has attachments, so the tool list changes then. It is compiled off. Owner: whoever turns on `FORM_FILL_MUTATION_AVAILABLE` must make it a per-chat declaration refused per call.
- **Follow-up connectors.** Each connected generation journals the `mcp_servers` section it showed (`aiden.mcp-servers-section.v1`, only when it changed). An unattended follow-up shows that section unchanged without reading any inventory, and its turn note says the servers are not connected and their tools cannot be called. Deviations, owner phase 8 (deferred tool declarations):
  - Nothing is declared or refused by name. The connector tools stay absent, so nothing listed is callable and no server is reached.
  - This keeps system and tools stable only in the codemode lane, where connectors are reached through codemode and tool_search. A chat whose connector tools are declared directly still loses them on the follow-up.
  - A connector removed since the last connected turn is still listed on the follow-up, under the note.
- **Window-dependent offers.** A workspace chat turn main starts with no window and no paired device (the owed turn and the unattended follow-up; `windowlessChatTurn` in `chat-turn-tool-policy.ts`) now declares what a turn in the chat's window declares (`declaresWindowTools`): Computer Use, form fill, hooks, questions, the to-do list, the advisor, browser, simulators, app settings tools and the design canvas. `chatTurnToolRefusal` refuses those calls before hooks, approvals or execution, naming the fixed set plus the runtime names the turn collects in `windowOnlyToolNames` (browser and discovery, device, app and canvas tools). Nothing a windowless turn can execute changed: the owed turn's request drops its own `allowComputerUse: false` and `windowOnlyToolNames`, and the side effects that need a window are skipped (device shim PATH, canvas and written-page placement, app navigation and live state, the form-fill readiness probe). Deviations:
  - **Scheduled and Telegram turns keep their own policies.** A scheduled run withholds Computer Use, subagents and scheduling by design, and a Telegram turn has its own surface, so their tool lists still differ from the desktop's. What holds is the continuation: a desktop turn after a scheduled run reuses the prefix of the chat's earlier desktop turn.
  - **Provider-auth connectors** stay withheld on windowless turns, because they run on the person's provider credentials only for an attended desktop turn. A chat that uses one can still see its `mcp_servers` section change on the owed turn.
  - **The unattended follow-up's hooks refusal** keeps its earlier "nobody is watching" reason, which is checked first.
- **Tests.** `chat-frozen-state.test.ts`, `chat-prompt-sections.test.ts` (both in `test:compaction` and the CI registry), and in `prompt-prefix-stability.test.ts`: the branch, permission, memory, Bot memory, hook context, audience note, follow-up connector, owed-turn and scheduled-then-desktop cases, all switched on. `chat-turn-tool-policy.test.ts` covers the windowless refusals, which owners are windowless, and which turns declare the app and scheduling tools (`declaresAppTools`, shared by llm-client and the owed-turn case). The hook-context shape is shared by both surfaces through one helper; `daemon-turns.test.mjs` builds its expected text with that helper. Only the Bot memory edit cases run on both a one-system-prompt wire and one that keeps system messages in place. The memory-removal, always-on cap and retry cases use the default wire (the cap case also runs an unchanged eighth turn and an unreadable store), and the split-turn compaction case is a unit test in `chat-frozen-state.test.ts`. The owed-turn case declares its tools through the gates llm-client reads (Computer Use, hooks, questions, browser, simulators, app and scheduling tools, and the design canvas), and the windowless turn refuses each of those. `pi-compaction-core.test.ts` checks that manual, automatic and local compactions send no memory fact to the summarizer and keep the retained tail. `memory-context.test.ts` checks that a fact stored across lines renders as one line.

## Phase 4: side calls share the parent prefix

**Causes**

- btw and advisor (`rpiv-btw/service-core.ts`) send a different system prompt and tool list, so they pay a full cache write on a prefix the parent already cached.
- Calls that run once write cache that is never read: title, dictation, the approval judge, and the four Bot helpers:
  - `bot-learning/routine-reflection.ts:146-150`
  - `bot-memory/compaction.ts:235-248`
  - `bot-memory/tidy.ts:71-75`
  - `bot-memory/review.ts:218-222`

**Changes**

- **btw and advisor.** These are sent as a continuation of the parent:
  - the same tools, system and message prefix
  - the same `tool_choice`
  - their own instruction appended as the final user message
  - "short" retention
- **One-off calls.** These send `cacheRetention: "none"` through one helper (`oneOffCallOptions()`), so a new one-off call cannot forget it. Legacy compaction already does this (`pi-legacy-harness` `compaction.js:60-67`).

**Note from Phase 3.** `pi-compaction-core` runs `withoutMemoryFacts` on the summarizer's input, so no memory fact reaches a permanent summary. Whenever a `<state_update>` in the summarized span holds fact lines, that input differs from the parent's messages from that update on. Side-call prefix sharing must account for this, and so must Phase 5's compaction on the cached prefix. Either send the parent's messages and strip the facts another way, or accept that the shared prefix ends at the first such update.

**Tests**

- Fake-provider test: a btw call made after a parent turn sends a payload whose tools, system and messages prefix are byte-identical to the parent's last request.
- Fake-provider test: each one-off call sends retention "none". This test covers the real call sites, not a list of names.

**As built (2026-11-19).** `main/services/side-call-prefix.ts` holds the parent prefix and the one-off helper.

- **The ledger.** `withSideCallPrefixLedger` wraps llm-client's stream (inside cache warming) and records each foreground request of a workspace chat in `chatSideCallPrefixes`: a copy of its message list with every tool reduced to its declaration (name, description, parameters), the options that shape the prefix (session id, reasoning, thinking budgets, retention, temperature, transport, `toolChoice`), a hash of the model without its headers, and the reply. It keeps only the latest request per chat, for at most 8 chats, in memory only. It never keeps credentials, headers or callbacks, logs nothing and persists nothing. A request it cannot replay faithfully clears the chat's entry: retention "none", headers, `onPayload`, `transformHeaders`, sampling parameters, metadata, env, deferred, or a model with sampling parameters. So does a failed or aborted reply. An entry lapses with the provider's documented short-retention lifetime (`promptCacheTtlMs`), and each new request sweeps lapsed entries. `chat-prompt-cache-state.ts` clears a chat's entry, with its cache-miss attribution, after a completed compaction and in `forgetChatContextProfile`.
- **The memory guard.** The entry keeps the memory fact lines its request stated (in system and in user `<state_update>` messages). Before handing out a prefix that states any, the ledger reads the chat's currently approved fact lines (`approvedMemoryFactLines`, empty when memory is off for the chat) and requires every stated line to be among them. A removed fact, memory turned off, or a store it cannot read drops the entry, so a side call never replays text phase 3 scrubbed; it sends the isolated request instead.
- **The continuation.** `sideCallContinuation` sends the parent's context (tools, system, messages), then the parent's reply, then the side call's own messages, with the parent's replayable options, `cacheRetention: "short"` (or the parent's own retention) and `disableContinuation: true`. The side call supplies its own key, headers, signal, token cap and timeout. No tool call in the reply is ever executed.
- **btw** (`rpiv-btw/service-core.ts`) continues the prefix only when it belongs to this chat, the resolved model has the same hash, and the chat's last message is the recorded reply (same Pi timestamp, provider and model), so no later turn, edit or compaction is missing. Its final user message is `btwContinuationPrompt`: a fixed instruction not to continue the task or call a tool, earlier side questions in the thread, then the question. Otherwise, and whenever the continuation fails, errors or answers no text, it falls back to the isolated, tool-free request with its overflow retry.
- **The advisor** (`advisor-runtime.ts`) continues the prefix only when the selected reviewer is the executor's own provider and model, the recorded reply holds this advisor call, and the resolved runtime has the same model hash. The review must also be at the executor's effort: no effort, or the parent request's reasoning. It appends a tool result for every tool call in that reply: the real result from the live turn for each call before the advisor (tools run in order and the advisor runs alone, so those have finished), "Advisor review requested; the instruction follows." for its own, and "Not run: the task is paused for an advisor review." for each call after it. Then comes `ADVISOR_CONTINUATION_INSTRUCTION`. If an earlier call's result is missing, the review is the separate request. When the continuation fails, errors or answers no text, the separate tool-free review follows; a cancelled or timed-out one does not. It resolves the runtime with the chat's conversation id, as the parent did. Any other reviewer gets the isolated projection as before. `ADVISOR_TRANSFER_NOTICE` now says a same-model review continues that model's own request.
- **One-off calls** go through `oneOffCallOptions()`, which forces `cacheRetention: "none"`. Routed sites:
  - chat title (`chat-title-request.ts`)
  - dictation cleanup (`requestDictationCleanup` in `dictation-cleanup-core.ts`)
  - the approval judge (`approval-judge/model-complete.ts`)
  - vision analysis (`vision-analysis-tool-core.ts`)
  - routine reflection
  - the Bot compaction steered summary
  - memory tidy
  - the last round of a memory review
  - the isolated btw request
  - the isolated advisor review

  The approval judge, vision, btw and advisor already sent "none" inline; they now use the helper. Not one-offs: Bot model and execution passthroughs, `packages/cli/src/bot-durable.ts`, and `pi-compaction-core.ts` (phase 5).
- **Phase 3 note decided.** A continuation sends the parent's messages unchanged, to the provider that already received them, for an ephemeral answer that is never stored. No memory fact reaches a permanent summary that way, so no fact is stripped and the shared prefix is the whole parent request. `withoutMemoryFacts` stays specific to the compaction summarizer; phase 5 must still resolve it there.

The code differed from the plan in these ways:

- **Vision analysis** was a one-off the plan did not list; it is routed.
- **Memory review** sends "none" only on its last round. Its rounds resend the same growing prefix, so each earlier round's cache write is read by the next.
- **Title and dictation** requests moved into testable helpers (`requestChatTitle`, `requestDictationCleanup`) so the tests call the real request code.
- **No documented cache lifetime, no continuation.** Without a TTL a warm prefix cannot be told from a cold one, and a cold continuation costs more than the isolated call. Owner: phase 6 (real TTLs).
- **`aiden serve`** records no ledger, so the CLI advisor and any server side call stay isolated. Owner: phase 6 (`aiden serve` parity).
- **Compaction forgets the ledger.** Right after a compaction btw and the advisor fall back to the isolated request until the next foreground request. Owner: phase 5.
- **Agent harness (ACP) chats and Bot chats** have no side calls on the prefix; their stream is not wrapped. A Bot's memory is edited outside the chat, so a Bot chat's prefix would need that store's guard too.
- **A reasoning override.** An advisor whose effort differs from the parent's reasoning is the separate one-off review, since the thinking settings key the cached prefix.
- **Costs of the fallback.** A btw or same-model advisor continuation that fails falls back to the isolated request, so one side question or review can send two requests.
- **The output cap differs.** A side call sends its own `max_tokens` (btw caps at 4,096). On Anthropic that cap does not key the cache, and the thinking budget the side call derives from it matches the parent's, except near the model's context limit, where the clamp can lower it and the continuation misses.
- **Tool results are resent.** A btw continuation includes the parent's tool results and thinking, which the provider already holds; the btw plan's "visible prose only" contract now applies to the isolated request only.
- **Harness.** `createPromptPrefixHarness` gained `wrapStream`, `model`, `agentState()` and `record(context, at, options?)` so a test can wrap the real stream, read the live turn, and render a side call's request on the same wire with its real thinking, token cap, `tool_choice` and retention. A recorded request also carries its non-prompt `settings` and its `cacheMarkers`.

Tests: `side-call-prefix.test.ts` (in `test:compaction` and the CI registry) runs a parent turn through the prefix harness with the ledger wrapped in, then a real `BtwService` and a real `AdvisorRuntime` against a capturing provider. The btw request's wire extends the parent's request with its tools first and identical bytes, at "short" retention; a same-model advisor review does the same and runs no executor tool. A review after a finished call carries that call's real output; one whose earlier result is missing, or at an effort other than the parent's, is the separate request at "none"; at the parent's effort it continues. A btw or advisor continuation that throws, errors or answers nothing falls back to the isolated request. Rendered with their real options, the btw request and the parent's match in thinking, `tool_choice`, every other setting and the cache markers, apart from `max_tokens`. Without a live prefix, or after a newer chat message, btw sends an isolated request at "none". A parent turn stating a memory fact continues while the fact is approved and, once it is forgotten, sends the isolated request with no fact text; an unreadable store or no reader also blocks it. Ledger cases cover declarations only, TTL lapse, no TTL, unreplayable options, failed replies, a superseded request, the 8-chat limit, `forget`, and clearing through the compaction and forget-profile hooks. Each routed one-off is checked at its real call site: `chat-title-policy.test.ts`, `dictation-cleanup-core.test.ts`, `approval-judge/spend.test.ts`, `vision-analysis-tool.test.ts`, `bot-learning/learning.test.ts` (reflection, tidy), `bot-memory/compaction.test.ts` (steered summary) and `bot-memory/review.test.ts` (last round only).

## Phase 5: compaction on the cached prefix

**Cause.** Compaction (`pi-compaction-core.ts:934-975`) sends a new system prompt and a reformatted transcript, so the summarizing call reads no cache. The next turn then starts cold, after a pause at the limit.

**Changes**

- **Cached-prefix compaction.** The compaction request is the parent's prefix (tools, system, messages) with the summarize instruction appended as the final user message, at "short" retention.
- **Background precompute.** When context use crosses a threshold below the limit, for example 80% of the compaction trigger:
  - The summary is precomputed in the background on the same cached prefix.
  - It is applied at the next turn boundary.
  - If the chat moves on, it is thrown away.
  - It runs only for an attended chat already generating, and never starts a model call on its own for an idle chat.
- **Fresh head.** After compaction the head is rebuilt once, picking up the frozen state from phase 3, and journaled.

**Tests**

- Compaction payload test: the summarize request is a byte prefix extension of the parent's last request.
- Background test, with fake timers and a fake provider:
  - A precomputed summary is used when the chat has not moved.
  - It is thrown away when a message arrived after the snapshot.
  - No call starts for an idle chat.
- The existing compaction behavioral suites stay green, and the replay gate records the compaction turns.

**As built (2026-11-19).** The coordinator (`pi-compaction-core.ts`) gained a `cachedPrefix` reader, an `approvedMemoryFacts` reader and a `precompute` option. `compaction-precompute.ts` holds the background registry.

- **The summary request.** For a threshold or manual compaction with the LLM engine, the coordinator reads the chat's side-call prefix (phase 4's ledger) and uses it only when its model hash matches, the journal's context still ends at the prefix's reply (same Pi timestamp, provider, model and stop reason), the prefix states no memory fact line and the chat has no approved fact. The request is then `sideCallContinuation`: the parent's tools, system, messages and reply, then `cachedPrefixSummaryInstruction` as the final user message, always at "short" retention, even when the parent asked for a longer one, with the output capped at 80% of the reserve. The instruction asks for Pi's checkpoint format, says the latest messages stay word for word, carries any PreCompact hook context as "Additional focus", and says not to restate memory. Pi's read and modified file lists are appended as Pi does. When the request would not fit the window, throws, is cut off, calls a tool or answers nothing, Pi's isolated, scrubbed request (`withoutMemoryFacts`) is sent instead. A cancelled compaction stays cancelled.
- **Wiring.** llm-client passes all three options for workspace chats whose stream the ledger wraps (not agent harnesses, not Bot chats). Manual compaction (`context-lifecycle-service.ts`) passes `cachedPrefix` only when a runtime resolved and the history is not the skills-off projection, which is not the request the cache holds.
- **The memory constraint.** No memory fact text reaches a stored summary, on any path:
  1. A chat with memory facts (stated in the prefix, or approved now) always summarizes with the isolated request. A model told a fact can paraphrase it, and no filter can find a paraphrase, so the summarizer is never shown one. A store it cannot read also sends the isolated request.
  2. The instruction forbids restating memory.
  3. The isolated request's input is scrubbed, as before.
  4. A final filter in `run()` covers every path (cached, isolated, local and precomputed). It removes lines stating any fact line found anywhere in the branch (messages, state updates, tool results, earlier summaries), removed facts included, or any approved fact. A fact still restated throws, so the compaction fails and nothing is stored.
  5. Removed facts are never sent again: the ledger refuses a prefix stating a fact that is no longer approved (phase 4), so the summary request never carries one, and a background summary is keyed on the approved facts.
- **Background summaries.** When an attended turn ends with "stop" between 80% of the trigger (`fraction`) and the trigger itself, the coordinator starts the summary on the cached prefix through `chatCompactionPrecomputes`. It needs a usable prefix, no memory facts (as above), something to summarize, and `allowed`: the generation is current (not stopped, window open), `canWarmForegroundChat` holds (attended desktop surface, not local, not a Bot, not an owed or scheduled turn), and the chat's spending limit does not refuse it (`precomputeWithinSpendingLimit`, asked before the summary starts and again inside `allowed`). The snapshot holds the journal branch's entry ids, a hash and the count of the context messages, the model hash and a hash of the approved fact lines.
  - The summary stays valid while the chat is only appended to: the branch must start with the snapshot's entries, the context with the summarized messages, and the model and approved facts must be unchanged. A follow-up does not abort it, and a valid one is not restarted. At each turn boundary (`prepareForPrompt`) a summary that is no longer valid is discarded. Regenerate, an edit, a branch switch or any other move of the journal, a model change, a memory change, Stop, deleting the chat (`forgetChatPromptCacheState`) and a completed compaction (`chatPromptPrefixCompacted`) all discard it.
  - It is stored only when a threshold compaction comes due. The compaction then stores the background summary with its own kept tail plus every message appended since, with this compaction's token count, and sends no request. When that would break the keep budget (below), or the summary is still being written, it is dropped without an event and the compaction runs as usual, so a turn never waits and no failure is shown.
  - The registry keeps one entry per chat, at most 8 chats, each bounded by a 5-minute timeout, in memory only, and logs nothing.
- **Fresh head.** A compaction ends the journaled head (phase 3), so the next request rebuilds it once from the current frozen state and journals it. Manual compaction now also calls `chatPromptPrefixCompacted`, so the ledger, the miss attribution and any background summary are cleared after either kind.
- **Harness.** `createPromptPrefixHarness` gained a `compaction` option (settings, models, prefix reader, approved facts, precompute), `journal()` and the recorded request options, so a test can run real compactions through the turn.

The code differed from the plan in these ways:

- **The local engine (pi-vcc)** makes no model call, so it has no request to move. It still goes through the final memory filter.
- **Overflow recovery** keeps Pi's isolated request: the prefix it would continue is the one that no longer fits.
- **One request per summary.** A split turn is one cached request, where Pi's isolated path can send two. The cached summary sees the whole conversation, the retained tail included, and is told those messages stay.
- **Chats with memory facts summarize isolated.** The plan put every threshold and manual compaction on the cached prefix. A chat whose prefix states a fact, or which has an approved fact, keeps Pi's isolated, scrubbed request, because a paraphrased fact cannot be filtered out of a summary. Those chats get no cached summary and no background summary. Memory is on by default, so today both reach only chats with no approved facts. Phase 6 accepted this limit (see its As built).
- **The keep budget for a background summary.** `start` is `fraction` of the trigger (80% by default). A background summary is stored only when both hold:
  - The kept tail (its retained messages plus everything appended since, by Pi's estimate, with system messages priced for models that keep them) is at most `keepRecentTokens` plus the smaller of `keepRecentTokens` and `trigger - start`. So a 1M window keeps at most twice `keepRecentTokens`, not the roughly 217k that `keepRecentTokens + (trigger - start)` would allow.
  - The summary, the kept tail and the request's fixed overhead come to less than `start`. The overhead (system prompt and tools) is measured when the summary starts: the provider's count for the summarized prefix minus Pi's estimate of its messages. So the compacted chat lands below the point where the next background summary would start, and a small window never compacts again at once.

  Otherwise the summary is dropped quietly and the compaction runs as usual.
- **Applied at the trigger, not the next turn boundary.** The plan applied a precomputed summary at the next turn boundary and dropped it once the chat moved on. As built, it is kept across appends and applied only when compaction is due, so a chat below the trigger is never compacted early.
- **The final filter can fail a compaction.** A fact split across lines, or a summary line quoting an approved fact's text, removes that line or fails the compaction. A threshold compaction refused this way ends the turn `provider_failed`, as other compaction failures do.
- **Forgotten lines in chatState mode.** The session wrapper hides a removed fact's lines from `getBranch()`, so the final filter cannot see them; they never reach the summarizer input either.
- **No background summary** while the chat has a PreCompact hook configured (`preCompactCompactionOptions` reports it; the hook's context belongs to the compaction that applies it), for remote, phone or Telegram surfaces, for local models, for owed, routine or automation turns, for Bots or for agent harnesses. An unfinished one is discarded, not awaited.
- **Manual compaction with skills off** stays isolated, and manual compaction runs no background summary.
- **Fork summaries** (`fork-summary-service.ts`) and **child agents** (`subagents/child-agent-runtime.ts`) stay isolated. Owner: phase 6.
- **`aiden serve`** keeps no ledger and no background registry, and does not run this coordinator, so its compactions keep their isolated request and get neither the cached prefix nor the final memory filter. Owner: phase 6 (`aiden serve` parity).
- **The replay gate** (`pi-upgrade-replay-runner.ts`) builds the coordinator without a prefix or background summaries, so its compaction cases record the isolated path. A cached-prefix replay case is owner phase 6.

Tests: `compaction-cached-prefix.test.ts` (in `test:compaction` and the CI registry) drives real turns through the prefix harness with the ledger wrapped in. A threshold summary is one request at "short" retention (even under a parent's long retention) whose wire is a byte prefix extension of the parent's last request and ends with the instruction; it is stored and read by the next request, with no network call. A foreign message after the reply sends the isolated request. A chat whose prefix states a fact, or which only has an approved fact, sends the isolated request even with a matching ledger, and no fact text reaches the request or the stored summary; a summary that still restates a fact fails the turn and nothing is stored. After a fact is forgotten, no summary request, stored summary or later request carries its text. A background summary below the trigger is kept and not rewritten; crossing the trigger stores it with its tail plus every later message and no extra call. A follow-up during the write does not abort it. Regenerate (a journal move), a model change and a change in approved facts discard it. It is never started for an unattended chat, a chat over its spending limit or a chat with a PreCompact hook, and one that would break the keep budget is dropped with one ordinary compaction and no failure event: a summary that would leave the chat at its trigger, one whose request is still past the start once its system prompt and tools are counted, and a long kept tail on a window whose trigger is far past the start. A summary that is applied leaves the chat below its trigger, so the next turn does not compact again. Registry cases cover take-once with its snapshot, abort of an unfinished summary, replacement, timeout, the chat limit, Stop (`chatPromptGenerationStopped`) and `forgetChatPromptCacheState`. In `context-lifecycle-service.test.ts`, an operator compaction continues the chat's recorded request at "short" retention, and the finished compaction clears the ledger.

## Phase 6: idle warming on real TTLs, `aiden serve` parity, long retention

**Causes**

- `pi-cache-warming.ts:115-121` gates on `model.promptCache` and uses its TTL instead of Pi's `promptCacheTtlMs`, so some models are never warmed and others are warmed on the wrong period.
- The warmer is disposed in `finally`:
  - `llm-client.ts` around 5985
  - `daemon-chats.ts:462` in the CLI
- `aiden serve` ignores the warming setting and falls back to "streaming" (`daemonSettingsManager`).
- There is no long-retention option for providers that offer one.

**Changes**

- **Real TTLs.** The warmer takes its TTL from `promptCacheTtlMs` for the resolved model and retention, and warms at TTL minus a margin. It is gated by `canWarmForegroundChat` (`llm-client.ts:4176-4210`).
- **Warmer lifetime.**
  - The warmer outlives the generation for an attended chat, until the chat is closed, the window loses the chat, or an idle limit passes.
  - The idle limit is a bounded number of warms, so an abandoned chat stops costing money.
  - Warming never starts for an unattended chat.
- **`aiden serve`.** It reads and honors the same setting. The streaming fallback is removed.
- **Long retention.**
  - A setting offers "long" retention for providers on an allowlist where Pi supports it: Anthropic 1-hour and Bedrock `CacheTTL.ONE_HOUR`.
  - The allowlist lives beside the provider capabilities, not in UI code.
  - The setting follows the settings design system and its existing grouped card.

- **Deferred from phase 5.** Compaction reaches the cache only in chats with no approved memory fact, and memory is on by default. Decided in phase 6: accept the limit (see As built).

**Settings and docs**

- Document the setting and its cost trade-off in the relevant guide.
- No onboarding change: this is a cost tuning option, not first-run setup.

**Tests**

- Warmer unit tests with fake timers:
  - The period follows `promptCacheTtlMs`.
  - Warming stops after the idle limit and on chat close.
  - It never starts for an unattended chat.
- CLI test: `aiden serve` with warming on starts the warmer, and with it off does not.
- Settings test: the long option appears only for allowlisted providers, and choosing it reaches the request options.

**As built**

- **Real TTLs.** `PiCacheWarmer` reads `promptCacheTtlMs(model, retention)` for the resolved model and the retention the request asked for (short, long or none) and refreshes on Pi's schedule ahead of expiry (`getCacheWarmingDelayMs`). It refuses only what Pi cannot replay, so a model with a documented lifetime and no `promptCache` entry is warmed. `promptCacheTtlMs` gained the retention argument: "none" is 0, and "long" is the declared long lifetime or the hour of the allowlisted providers, falling back to the short one where Anthropic's compat refuses the long TTL.
- **Warmer lifetime.** The warmer no longer ends with the agent or in `finally`:
  - A reply that is saved and shown in a window that still has the chat settles into an idle phase (`settleReplyCacheWarmer`): Pi's 15% continuation odds and 30-minute horizon, at most `IDLE_WARM_LIMIT` (3) refreshes, then it stops.
  - A stopped, failed or detached reply, a closed window, or a reply from another window ends it. The chat pane calls `chats:releaseCacheWarming` when it moves away from the chat, and only the window that showed the chat can release its warmer. Each chat keeps one warmer (`adoptChatCacheWarmer`).
  - Every chat write (a new message, a model switch, a compaction) stops it at the next refresh, through the summary revision fence.
  - Unattended chats never create one (`canWarmForegroundChat`).
  - Every refresh, streaming or idle, first asks the spending gate compaction precompute uses (`precomputeWithinSpendingLimit`, after counted usage settles). Once the chat's or Bot's limit refuses, the warmer ends for good.
- **`aiden serve`.** `daemonSettingsManager` follows the profile's `cacheWarmingEnabled` in aiden.json, the switch the desktop saves. On, an attended chat turn warms while the reply streams ("streaming"); off, or for a Bot, Telegram or scheduled run, Pi never sends a refresh. Pi's settings.json `cacheWarming`, and Pi's "idle" default, are ignored. The streaming fallback is gone. `packages/cli/README.md` documents the switch.
- **Long retention.** Settings → Context & Limits gains a **Cache lifetime** group, below the warming group and its footnote, with **Keep chat caches for an hour** (`longPromptCacheRetention`, off by default, carried in portable config). The allowlist is `renderer/shared/prompt-cache-retention.ts` (Anthropic and Amazon Bedrock), with `supportsLongPromptCacheRetention` for the models Pi sends a long TTL for (Claude on Anthropic Messages, and on Bedrock only the Claude models AWS's prompt-caching table lists with a one-hour TTL: Haiku 4.5, Opus 4.5 and later, Sonnet 4.6 and later and the Claude 5 models, not Sonnet 4.5, Sonnet 4 or Opus 4.1; a `ttl` on an unlisted model can be rejected, so those keep five minutes). The switch is unavailable, with a reason, until an allowlisted provider is set up.
  - `chatTurnPromptCache` (`prompt-cache-lifetimes.ts`) decides per turn and puts `withLongPromptCacheRetention` outermost on foreground workspace chats only, so the countdown, miss telemetry, side-call ledger and warmer all see "long". Bots, automations, subagents, agent harnesses and turns a paired device starts keep the default lifetime, and side calls and compaction name their own.
  - Side calls continue a long parent at "short" (they read its entry and write only their own tokens), and one-off calls stay at "none", so long retention never reaches btw, the advisor or other one-offs.
  - The warmer warms at the long TTL when long is chosen.
- **Memory and compaction (from phase 5).** Accept the limit. The facts stay in the system head. A summarize view without them would no longer be a byte prefix and would lose the cache anyway. Moving facts out of only the summarize view changes the bytes the summary request sends, so it would miss the parent's cache entry, which is the reason to continue the prefix at all; moving them out of the head for every request is phase 1's per-request memory section question, not a compaction one. Chats with an approved fact keep phase 5's isolated, scrubbed summary.
- **CLI workspace chats (from phase 3).** No frozen-state change is needed. The server's system prompt is Pi's own, plus a Bot's instructions for a Bot turn, and it states neither the branch nor the permission mode. Hook context already travels on its own message (phase 3).
- **No-TTL continuation (from phase 4).** A side call refuses to continue a parent whose prefix is older than its TTL, and a model with no documented lifetime keeps the ledger's own bound. Covered by `side-call-prefix.test.ts`, with no change in this phase.

The code differed from the plan in these ways:

- **An hour-long cache is never idle-warmed.** Its refresh would fall at 54 minutes, past Pi's 30-minute idle horizon, so a settled chat at long retention relies on the hour itself. It is still warmed while a long reply streams.
- **A title write stops the idle warmer.** Title generation writes the chat, so the summary revision fence stops the idle phase at its first refresh after the first reply. The same holds for any other chat write. Accepted: a fence that ignored some writes could warm a prefix that no longer exists.
- **A background summary can waste idle warms.** A precomputed compaction summary (phase 5) is not applied until the trigger, so the warmer may refresh a prefix the compaction later replaces. The idle limit caps the cost at three refreshes. Accepted.
- **`aiden serve` warms only while streaming,** never idle, and reads the setting once per session, so a change reaches the next turn. Long retention is desktop-only; the server keeps Pi's default retention. Owner: phase 8 ("`aiden serve` idle warming and the hour-long cache").
- **`aiden serve` has no side-call ledger and no compaction coordinator.** Its advisor and side calls stay isolated, and its compactions keep Pi's isolated request without the cached prefix. The server runs Pi's own AgentSession compaction, so adopting the coordinator means replacing it rather than wrapping a stream, and a background summary needs an attended notion the server does not have yet beyond the warming flag above. Owner: phase 8 ("`aiden serve` ledger and compaction coordinator").
- **`aiden serve` compaction applies the desktop's memory filter.** `daemon-compaction-memory.ts` writes a workspace chat's summary in `session_before_compact` with Pi's own `compact()`, using the shared `withoutMemoryFacts` and `withoutStatedMemoryFacts` from `chat-frozen-state.ts`. No fact line reaches the summarizer, and a summary that still states a fact the chat was told (approved now, in the branch, or told earlier and since removed) fails the compaction. Any error cancels the compaction instead of storing an unfiltered summary.
  - Accepted limit: the server's record of the facts a chat was told is in memory only, so a restart forgets facts removed before it. It is not persisted on purpose: a file would keep removed facts on disk, which is what removing them is meant to undo. A fact still approved, or still in the branch, is filtered after a restart.
  - Accepted limit, desktop and server alike: a recall result is tool output in the form "- [citation] Owner-approved fact: …", not a fact line of the always-on prompt, so it reaches the summarizer, and once that fact is removed a summary restating it is kept. A fact still approved is caught either way. Recall output is part of the chat's transcript like any other tool result, which removing a fact does not rewrite either; scrubbing it from summaries alone would not take it out of the chat.
- **Fork summaries stay isolated.** `fork-summary-service.ts` summarizes the branch up to the fork point, while the ledger holds the chat's latest request, so the tail match fails unless the fork is at the newest message; it also resolves its own runtime. Accepted.
- **Child agents stay isolated.** A child runs its own session whose stream the ledger does not wrap (the ledger holds only foreground chats), so there is no recorded parent prefix to continue. Owner: phase 8 ("Child-agent compaction").
- **The replay gate** still builds the coordinator without a prefix or background summaries, so it records the isolated path. Owner: phase 8 ("Cached-prefix replay case").
- **No Remote contract change.** The setting is desktop-local and no Aiden Remote payload changed, so the iOS and Android clients need no update. No onboarding change.

Tests:
- `pi-cache-warming.test.ts` (fake clock): the period follows the lifetime for each retention; the idle phase stops after its limit, on release by the window that showed the chat, and on a chat write; another window cannot release it; an unattended chat never creates one; no refresh is sent once the spending limit refuses, while streaming or idle.
- `prompt-cache-lifetimes.test.ts`: long and none lifetimes, the compat refusal, and the wrapper asking for "long" only on allowlisted models and never overriding a retention a request names.
- `prompt-cache-lifetimes.test.ts` (`chatTurnPromptCache` fixtures): an attended workspace chat on Anthropic or a Bedrock Claude model AWS lists with a one-hour TTL asks for "long" while its side calls stay "short" or "none"; the setting off, a harness, a Bot, an automation, a scheduled run, a subagent, compaction, Telegram, a paired device's turn, OpenRouter routing to Anthropic, a custom endpoint, Bedrock Sonnet 4.5 and an older Bedrock Claude all stay short; every Bedrock Claude model in Pi's catalog keeps an hour exactly when the AWS table lists it.
- `side-call-prefix.test.ts`: a side call after a long parent sends "short" and reads the parent's entry within the hour.
- `config-store-core.test.ts`: the setting survives a save.
- `limits-settings.test.tsx`: the switch can be turned on only with an allowlisted provider; left on after that provider is removed it reads as paused and can still be turned off; it and warming save independently; and the warming footnote sits in the warming group, not the hour's.
- `packages/cli/tests/daemon-turns.test.mjs`: a long reply on `aiden serve` sends a one-token refresh only when the profile turns warming on, and never for a scheduled run or with the setting missing, off or malformed.
- `packages/cli/tests/daemon-turns.test.mjs` (serve compaction): a fact the chat was told and then forgot reaches neither the summarizer nor the stored summary, and a summary still stating a fact across lines fails the compaction and stores nothing.

## Phase 7: screenshot trimming in batches, retire the Gemini explicit cache

**Causes**

- `generation-context.ts` and `bot-images.ts` keep the last 3 screenshots on every step (`keep = 3`), so each new screenshot changes an earlier message and breaks the messages cache on every step.
- `gemini-context-cache.ts` builds an explicit cache per turn. Its key includes values that change all the time: `snapshotLine` size and mtime, and git `uncommitted`, `ahead` and `behind`. So it is rebuilt nearly every turn and pays storage for caches that are never reused, while Gemini's implicit caching would work on a stable prefix.

**Changes**

- **Screenshots.** Trim in batches: when the kept images pass 25 MiB or 8 screenshots, cut down to 15 MiB or 3. Between cuts, earlier messages stay byte-identical. The thresholds are shared by the desktop and Bots.
- **Gemini.**
  - Retire the per-turn explicit cache and rely on implicit caching over the now-stable prefix.
  - Remove the dead code and its settings, if any.
  - Measure with the phase 0 telemetry. If the replay shows Gemini implicit caching is worse than the explicit cache was, record that in the PR and keep an explicit cache keyed only on the journaled head.

**Tests**

- Trimming test: a sequence of screenshots changes earlier messages only at the batch thresholds, and at the cut the kept images are the newest.
- Gemini test: no explicit cache is created, and the request carries no `cachedContent`.

**As built (2026-11-19)**

- **Screenshots.** `main/services/screenshot-trimming.ts` holds the thresholds (`SCREENSHOT_TRIM_LIMITS`: a cut once more than 8 screenshots are kept or they pass 25 MiB, down to the newest 3 within 15 MiB, the newest always kept) and the screenshot tools with each one's note. `generation-context.ts` (workspace chats) and `bot-runtime/bot-extension.ts` (Bots, on the desktop and under `aiden serve`) both trim through `trimScreenshots`; `bot-images.ts` keeps only `withImageReferences`, and its per-tool fixed windows are gone. The cut is simulated over the whole transcript in order, so the same history always cuts at the same screenshot, and a cut image becomes its tool's fixed note, so a replayed or retried request renders the same bytes. Only the request is trimmed; the stored transcript keeps every image.
- **Gemini.** The explicit cache is retired. `gemini-context-cache.ts`, its test and the research probe `context-google-static-cache.ts` are deleted, and llm-client no longer builds a workspace snapshot or wraps the Google request in an `onPayload` hook. There was no setting, IPC channel or renderer surface for it. Requests carry the system instruction and tools inline, and Gemini's implicit cache reads the prefix; `usage-accounting.ts` still meters its `cachedContentTokenCount` as cache-read tokens. Caches created by earlier builds expire on their own one-hour TTL.
- **Why implicit, not a journaled-head explicit cache.** The prefix harness gained the Google Generative AI wire and every per-wire stability case passes on it: the AGENTS.md and MCP cases, tool loops and turn boundaries all extend the previous request byte for byte. Implicit caching therefore covers tools, system and the whole message history, while an explicit cache keyed on the journaled head would cover only tools and system, and would add a create call, storage cost and cleanup. No live replay was run (that needs a paid Google key and the network); the decision rests on the harness and on the old key, which took per-file sizes and mtimes and git `uncommitted`, `ahead` and `behind` counts, so it was rebuilt nearly every turn.

The code differed from the plan in these ways:

- **The screenshot tools share one count.** Computer Use, a Bot's own computer and `browser_snapshot` are counted together against one request limit, since they share one request. Images from any other tool, and images the person attached, are neither counted nor cut.
- **A cut leaves a note, not nothing.** Each cut screenshot becomes a fixed text part ("An older screenshot was left out of this request…", worded per tool), so the model knows to look again and the bytes never vary.
- **Bots now trim host Computer Use screenshots too.** Before, Bots trimmed only their browser and Bot-computer images.
- **Gemini loses its workspace index.** The snapshot of file names, sizes and git state reached Gemini only inside the explicit cache, so retiring the cache drops it, along with the `listWorkspaceFiles` call each Gemini turn made. Gemini reads the workspace through its file tools like every other provider.
- **The benchmark keeps its operation name.** `scripts/benchmark-workspace-metadata.ts` compares a projection of the file index instead of the retired snapshot string (see the dated note in `docs/testing/workspace-metadata-performance.md`).
- **No CLI change.** The server never used the explicit cache; it runs the same Pi Google adapter, and Bot trimming reaches it through the shared `bot-extension.ts`.

Tests:
- `screenshot-trimming.test.ts`: over 24 screenshots, earlier messages change only at steps 9, 15 and 21 and each cut keeps the newest three; the byte limit cuts at its own steps to what fits in 15 MiB; the newest screenshot stays even when it alone passes both limits; the three screenshot tools share one count while file-tool and attached images are untouched.
- `generation-context.test.ts`, `bot-browser-tools.test.ts`, `bot-computer-tools.test.ts`: the workspace and Bot projections cut at the batch thresholds with their tools' notes.
- `prompt-prefix-stability.test.ts`: every per-wire case runs on Google Generative AI too, and a Gemini chat's tool loop and next turn send the system instruction and tools inline, carry no `cachedContent`, extend the previous request byte for byte and make no network call.

## Phase 8: Codex, message threads and provider routing

**Causes and changes**

- **Codex** (`codex-provider.ts`, `generation-runtime.ts:239-257`):
  - Allow the WebSocket transport where Pi supports it, so the server keeps the conversation and its cache.
  - Pass the cache TTL.
  - The transport choice follows the provider capability, with HTTP as the fallback.
- **Anthropic message threads** (`pi-message-threads.ts:13-18`, `withoutMessageThreads`): evaluate turning threads on against the replay gate.
  - If they lower cost and keep replay quality, turn them on.
  - If not, record the numbers in the PR and leave them off.
- **Deferred tool declarations** (from phase 2). On plain Anthropic Messages, a tool loaded mid-turn is folded into the one tool list, so the next step misses. Declare loaded tools without changing the cached tool list, for example through the wire's deferred tool loading, and switch on the todo case "loading a tool mid-turn leaves the next step's prefix unchanged (Anthropic Messages)".
- **Head collapse.** Stop collapsing the head into one block, so a change in a late head section does not invalidate earlier sections. Each journaled section keeps its own block.
  - Depends on phase 1: the AGENTS.md and MCP sections are turn-start patches that stay stable only because the collapse folds them into the head. Journal them (or otherwise keep them stable as their own blocks) before the collapse goes away, and keep the AGENTS.md and MCP cases of `prompt-prefix-stability.test.ts` passing on all three wires.
- **Breakpoints.**
  - Use the 4th Anthropic cache breakpoint: today it is spent on the last tool, the system prompt and the last user message.
  - Add one at the end of the stable head, before the frozen-state tail, applied through the payload hook.
- **Bedrock tools.** Pi adds cachePoints to the system prompt and the last user message only (`bedrock-converse-stream.js:710, 905`). Add a cachePoint after the tools in the payload hook. Also check that `toolChoice: "none"` drops `toolConfig` for Bedrock, and keep tools declared there.
- **`prompt_cache_key` and affinity.**
  - Pi 1.5.2 already sends `prompt_cache_key` from `sessionId` and session-affinity headers through `compat.sessionAffinityFormat` and `sendSessionAffinityHeaders`.
  - Pass `sessionId: chatId` on every path, including side calls and `aiden serve`.
  - Turn affinity on for custom OpenAI-compatible endpoints whose provider entry says they support it. `concentrate-provider.ts:98` is the existing example.
  - Never add a device or account identifier: the key is the chat ID.
- **Forked subagents.** A subagent forked from a parent chat sends the parent's tools and system as its prefix, so its first request reads the parent's cache.
- **`aiden serve` idle warming and the hour-long cache** (deferred from phase 6). `daemonSettingsManager` reads `longPromptCacheRetention` from the profile's aiden.json next to `cacheWarmingEnabled`, and an attended serve workspace chat on an allowlisted model asks for "long" through the same `keepsLongPromptCache` rule the desktop uses (Bots, scheduled runs and Telegram stay short). Idle warming after a reply follows the desktop's limits (three refreshes within 30 minutes, none at long retention), and stops when the chat is written or its last paired client lets go of it, which needs the server's notion of an attended chat.
  - Test: `packages/cli/tests/daemon-turns.test.mjs`, against the fake provider: an attended reply with both switches on asks for the hour on Anthropic and the default on a scheduled run; with warming on and the hour off, a settled chat gets at most three one-token refreshes and none after a new message.
- **`aiden serve` ledger and compaction coordinator** (deferred from phase 6). Replace the server's Pi AgentSession compaction with `PiCompactionCoordinator` wired to a per-chat `SideCallPrefixLedger`, so serve compactions and side calls continue the chat's cached prefix, keeping the memory filter above and its fail-closed cancel.
  - Test: `daemon-turns.test.mjs`: a serve compaction after a turn sends the turn's request bytes as its prefix at "short", and one after a removed fact sends the isolated request.
  - If replacing Pi's compaction would fork its retry or split-turn behaviour, record the measured serve compaction cost on the replay gate in the PR and mark this an accepted limit instead.
- **Child-agent compaction** (deferred from phase 6). A child agent records its own foreground requests in the ledger, keyed by its child session, so its compactions continue its own prefix. Build it only if the replay gate's `child_initial_fork` case shows child compactions above 5% of a session's input tokens; otherwise record the number in the PR and leave children isolated as an accepted limit.
  - Test: `main/services/subagents/forked-context.test.ts`: a child's compaction request extends the child's last request with identical bytes.
- **Cached-prefix replay case** (deferred from phase 6). `pi-upgrade-replay-runner.ts` gains a case that builds `PiCompactionCoordinator` with `cachedPrefix` from a ledger recorded on the replay turns, and the gate reports its cache-read share next to the isolated case.
  - Test: `main/services/pi-upgrade-evaluation.test.ts`: the new case's summary request starts with the recorded prefix and its result passes the same quality checks as the isolated case.

**Pi changes.** Everything above goes through Aiden's existing `onPayload` hook or Pi's documented options, not by patching Pi's dist files.

- If a change cannot be made that way, it goes as an upstream Pi PR plus a version-guarded postinstall patch modelled on `scripts/patch-pi-oauth-branding.mjs`, with its own test.
- The Pi pin stays exactly 1.5.2.

**Tests**

- Payload-hook tests for Anthropic and Bedrock:
  - the breakpoint count is at most 4 and in the expected places
  - the Bedrock tools cachePoint is present
  - the payload is unchanged for providers without caching
- Affinity test: an allowlisted custom endpoint sends `prompt_cache_key` equal to the chat ID; a non-allowlisted one sends none.
- Forked subagent test: the first request's tools and system match the parent's.
- Replay gate run recorded in the PR for threads, Codex and the cached-prefix compaction case.

## Cross-cutting requirements

**CLI parity.** Every phase that touches `llm-client.ts` lands the same behavior in `packages/cli/src/daemon-chats.ts` through the shared `main/services` sources the CLI already bundles, never a copy. `npm run cli:build` and the CLI tests run per phase.

**Remote.** No Remote protocol change is planned.

- The cache figure in the context panel is desktop-only in this PR.
- If a phase changes what the server sends to phones (for example the hook-context message shape), check the iOS and Android consumers. If a change is required, claim the next Remote revision at merge time.

**Network and privacy**

- No new network endpoints.
- Telemetry stores hashes and reasons locally.
- `prompt_cache_key` and affinity carry only the chat ID, which already goes to the provider as the session.

**Test registration.** Each new test file goes into the right `package.json` script and `scripts/ci-test-registry.json` lane, then `npm run test:ci-policy` is run. Window-opening tests run through `npm run test:e2e:space`.

**Docs updated in the same PR**

- `docs/plans/README.md` (this row)
- the providers and settings guide for long retention and warming
- `packages/cli/README.md` for the `aiden serve` warming setting
- `README.md` and `PRODUCT.md`, only if they make a caching claim
- `.memory/` notes for the decisions recorded here

## Risks

| Risk | Mitigation |
| --- | --- |
| Always-declared tools invite calls that are then blocked. | Clear block reasons, approval-gate decision tests, replay gate. |
| State sent in the tail drifts from enforced state. | One source for both, and a behavioral test per state kind (phase 3). |
| Warming costs money on abandoned chats. | Bounded warms, attended chats only, an off switch. |
| Background compaction races the user. | Snapshot check, and the summary is thrown away on change. |
| Threads or Codex WebSocket lower quality. | Replay gate decides; off by default unless it passes. |
| A very large single PR is hard to review. | Self-contained phase commits, review loop per phase, final four-reviewer pass. |

## Out of scope

- An Anthropic-only "compaction API" or other provider features Pi does not expose.
- Changing the models.dev, Artificial Analysis or OpenRouter manual-only network rules.
- A Remote UI for the cache figure.
