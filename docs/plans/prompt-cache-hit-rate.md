# Prompt cache hit rate: keep the cached prefix byte-stable

Status: In progress (2026-11-18): phase 0 implemented. Delivered as one PR with one stacked commit series per phase, branch `feat/prompt-cache-stability`, cut from `main` at f2fd27640.

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
| 1 | 1 | Stable nonce and journaled system sections |
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
- Before each run, `prepareForPrompt` rebuilds the context from the journal and `installCompactedMessages` folds the head and the system patches of the turn's first prepare into one system message. So a section patch added at turn start ends up in the head on every wire, including those with mid-conversation system messages. The phase 0 harness did not model this fold, which made the unchanged MCP section look like a miss on OpenAI Responses.
- Each changing case is driven through the real builders: branch and permission through the base prompt, memory through `createMemoryExtension`, on-demand tools through `load_tools`, and Bot open work through `composeBotSystemSections` and `renderBotOpenWork`. Each `todo` case also asserts, outside the stability check, that the changed value still reaches the request, so deleting the value cannot pass as a fix.
- The Bot case joins the composed sections into one prompt. Production sends them as keyed Pi Durable sections, so the real telemetry label for that miss may name the section, not `system:base`.
- Browser discovery is not modelled: it lives in llm-client's generation setup, outside the assembly. Per-request hook context is not modelled either (phase 3).

**Already stable:**

- a plain two-turn chat on Anthropic Messages, Anthropic Messages with in-place system messages, and OpenAI Responses with in-place system messages
- an unchanged MCP section on all three wires, because it is folded into the head at turn start
- a tool loop within one turn
- a chat with no AGENTS.md
- an on-demand tool loaded in one turn, which stays declared from the start of the next (`initialTools`)

**Baseline: the `todo` cases, all failing today.** Each row gives the first changed wire segment and what the telemetry reports.

| Case | First changed segment | Telemetry reports |
| --- | --- | --- |
| AGENTS.md nonce, all three wires | system | `system:agents-instructions` |
| On-demand tool loaded mid-turn (step 2 against step 1) | tools | `tools` |
| Bot open work in the base prompt | system | `system:base` |
| Branch switch | system | `system:base` |
| Permission mode change | system | `system:base` |
| Memory edit | system | `system:base` |
| Fourth `computer_use` screenshot trims an earlier image | messages | `messages` |

## Phase 1: stable nonce and journaled system sections

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

## Phase 3: hook context and frozen per-chat state

**Causes**

- On the desktop, hook context is injected into the system prompt per request. The CLI already saves it on its user message (`daemon-chats.ts:314`).
- The base prompt embeds state that changes during a chat:
  - git branch, permission mode, memory (`memory-context.ts` around 394)
  - canvas (`llm-client.ts` around 2565, `volatileSystemPrompt`, concatenated in `pi-agent-runtime-harness.ts`)
  - visualize mode and the remote audience (`chat-system-prompt.ts:60-84`)

**Changes**

- **Hook context.** Desktop hook output is saved on the user message it belongs to, matching the CLI. This is one shared helper for both surfaces, not two copies.
- **Frozen at chat start.** Branch, permission mode, memory, canvas, visualize mode and audience are read once at chat start and journaled with the head.
  - A later change is sent as a short appended `<state_update>` block at the end of the next user turn.
  - The model always sees the current value, and the head stays fixed.
- **Bounded growth.** Memory edits that happen during a chat are appended as a diff, not the whole memory. After compaction (phase 5) the head is rebuilt with the current state.

**Tests**

- Prefix test, switched on:
  - "branch switch does not change system"
  - "permission mode change does not change system"
  - "memory edit does not change system"
- Behavioral test: after a permission-mode change, the next request carries the new mode in the tail, and the approval gate uses the new mode. The model-visible text and the enforced mode cannot disagree.
- Hook context test: the desktop and the CLI produce the same message shape for the same hook output.

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

**Tests**

- Fake-provider test: a btw call made after a parent turn sends a payload whose tools, system and messages prefix are byte-identical to the parent's last request.
- Fake-provider test: each one-off call sends retention "none". This test covers the real call sites, not a list of names.

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

## Phase 8: Codex, message threads and provider routing

**Causes and changes**

- **Codex** (`codex-provider.ts`, `generation-runtime.ts:239-257`):
  - Allow the WebSocket transport where Pi supports it, so the server keeps the conversation and its cache.
  - Pass the cache TTL.
  - The transport choice follows the provider capability, with HTTP as the fallback.
- **Anthropic message threads** (`pi-message-threads.ts:13-18`, `withoutMessageThreads`): evaluate turning threads on against the replay gate.
  - If they lower cost and keep replay quality, turn them on.
  - If not, record the numbers in the PR and leave them off.
- **Head collapse.** Stop collapsing the head into one block, so a change in a late head section does not invalidate earlier sections. Each journaled section keeps its own block.
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
- Replay gate run recorded in the PR for threads and Codex.

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
