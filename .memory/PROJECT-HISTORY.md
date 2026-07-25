# Project History

### 2026-07-24 — Expose model-aware Anthropic/Claude thinking levels

- Reused the composer's Thinking control for exact Anthropic models in Pi's pinned catalog, with Off, Low, Medium, and High on reasoning models; XHigh and Max appear only where the model declares them.
- Omitted Pi's internal `minimal` tier because Claude's current public effort contract maps it to Low, and defaulted unsaved selections to Anthropic's native High default.
- Preserved exact `thinkingLevelMap` and `forceAdaptiveThinking` metadata through Aiden's compatibility runtime so Claude 4.6+ models send adaptive thinking plus native effort rather than legacy budget-token thinking.
- Added atomic exact-model persistence and validation across shared policy, IPC, renderer metadata, and request-time resolution. Anthropic thought content remains outside the renderer boundary.
- Narrowly migrated only Aiden's untouched legacy Anthropic preset to Sonnet 5, Opus 4.8, and Haiku 4.5 so existing installs receive current supported defaults without replacing customized or discovered model lists.

### 2026-07-24 — Expose model-aware ChatGPT/Codex thinking levels

- Reused the composer's accessible Gemini Thinking control for signed-in ChatGPT/Codex models, with exact per-model choices from Pi metadata: Low, Medium, High, and XHigh for the current Codex catalog, plus Max only for GPT-5.6 models.
- Omitted Pi's `minimal` alias because the pinned Codex catalog maps it to the same native `low` effort, and defaulted unsaved Codex selections to Medium rather than presenting a misleading Off state.
- Added atomic main-process persistence keyed by exact Codex model id, strict IPC/model validation, renderer-safe model capability metadata, and runtime gating before the selected effort enters Pi Agent state and the native Codex Responses request.
- Kept Codex thought content outside the renderer boundary; the control changes provider effort without exposing encrypted or provider-hidden reasoning.
- Focused contracts passed 70 tests; the complete suite passed all 661 TypeScript/JavaScript tests and all 41 Rust tests, along with type-check, lint, the production renderer/main/preload build, diff validation, and a live development restart.

### 2026-07-24 — Add honest per-turn Activity trails

- Recast the persisted renderer-safe generation timeline as a per-response inline Activity trail. Active, failed, and warning states default open, successful historical turns collapse, native details/summary preserves keyboard access, and reduced-motion settings remove the chevron transition.
- Added a category-aware deterministic claim checker that attaches an append-only `unverified_success` outcome when concrete success prose conflicts with a relevant failed file, command, Computer Use, schedule, or MCP action. Explicit acknowledgement suppresses the matching failure category while other categories remain independent; failures are not target-matched within one category, and the assistant's response is never rewritten.
- Preserved standard MCP `{ isError: true }` results as failures through Pi so the timeline and claim checker see the provider's actual outcome.
- Verification passed all 660 TypeScript/JavaScript tests, all 41 Rust tests, type-check, lint, production build, and diff validation. The existing large renderer chunk warning remains.

### 2026-07-24 — Add bounded Gemini workspace context caching

- Added main-process explicit caching for native Google workspace turns. The cached prefix is Pi's exact system instruction and tool schema plus a deterministic, metadata-only workspace file/Git index; transcript history and file contents stay outside the cache.
- Reused caches by credential/model/content fingerprint, bounded workspace churn to eight live fingerprints, refreshed on metadata changes, and deleted orphaned entries on eviction, workspace invalidation, and app shutdown.
- Kept cache create/delete requests on Google's fixed endpoint with header-only API-key authentication, an owned deadline, per-waiter cancellation, shared in-flight creation, and fail-open backoff for unsupported, undersized, or unavailable caches.
- Confirmed Pi's `cachedContentTokenCount` becomes cache-read usage without double-counting ordinary input, and added focused coverage for reuse, privacy boundaries, churn, cancellation, timeout, invalidation, shutdown, and cleanup races.

### 2026-07-24 — Add native Gemini thinking controls

- Added a compact per-model thinking control for reasoning-capable native Google models, showing only choices with distinct native outcomes and labeling the no-exposed-thoughts state Hide when Google cannot truly disable thinking.
- Made the per-model preference an atomic main-process mutation so concurrent renderer snapshots cannot discard another model's saved choice; strict validation remains at renderer, IPC, settings, and runtime boundaries.
- Passed the effective level through Pi Agent state so Pi emits the model-appropriate native Google thinking configuration, while unsupported providers and non-reasoning models fail closed to `off`.
- Extended the transcript's reasoning surface to deliberate Google thought deltas, with collapsible live tail-following and a pre-answer shimmer that respects Aiden's Reduce Motion setting.
- Covered the preference contract, accessible control, request parsing, runtime gating, reasoning exposure, and a faux native Google high-effort request payload.

### 2026-07-24 — Move Gemini chat to Pi's native Google transport

- Replaced the OpenAI-compatible `gemini` preset with Pi's built-in `google` provider and exact `google-generative-ai` model/stream dispatch, including native Google model discovery and fixed endpoint/authentication settings.
- Migrated the encrypted API key without decrypting it, plus backend selection, renderer selection, pinned models, Model Pad placement, chat metadata, and scheduled-task provider identities from `gemini` to `google`; every migration is idempotent and preserves an already-native value.
- Kept one-shot Gemini transcription on native `generateContent` while moving its key lookup, and let chat-title routing inherit the native Google transport through the shared runtime resolver.
- Added a faux-endpoint protocol test plus focused configuration, credential-map, runtime, discovery, chat, schedule, and renderer-preference migration coverage.

### 2026-07-24 — Harden Computer Use follow-ups

- Bound focus approvals to the exact resolved pid/window capability, rejected incomplete or undeclared drag-driver argument schemas, made bare captures fail closed, and limited approval-visible type/set-value payloads to 4,000 characters in both runtime validation and the public tool schema.
- Computer Use context retention now preserves the newest three actual screenshots rather than counting image-free Computer Use results; unrelated tool images remain untouched.
- The focused 73-test suite and TypeScript type-check pass.

### 2026-07-24 — MCP preset brand logos

- Replaced the Popular MCPs initial placeholders with official SVG logomarks for Composio (Brand Hub), Notion, and Linear, rendered with `currentColor` so they follow light/dark tokens.
- The same marks appear on configured preset rows and in the Set up / Manage dialog title.

### 2026-07-23 — Establish the 0.27 beta release line

- Reset the package and MCP OAuth client version to `0.27.0`, establishing the `0.27.x` beta line for subsequent CI releases.
- The About surface now explicitly identifies builds as Beta, release documentation records the new versioning policy, and signed installers are titled and named `Aiden Agent Beta` without changing the installed app's product name.

### 2026-07-23 — Branded macOS DMG installer

- Added a 600×448 Finder installer layout with the Aiden app and `/Applications` drop target aligned over the supplied `Presentation slide background (4).png` artwork. The original artwork is retained as the `@2x` asset and a matching 1× variant lets the packaged DMG render sharply on Retina and standard displays.
- The disk image build now finalizes Finder support assets with the native invisible attribute, so the background and volume-icon resources do not appear in normal Finder views. The finalizer is isolated to `.dmg` artifacts, uses a private writable staging image, validates its paths before mutating them, and atomically replaces the artifact only after recompression.
- The focused finalizer test, lint, package verification, image checksum verification, and Developer ID/hardened-runtime signature verification passed for `release/development/Aiden Agent-1.0.0-arm64.dmg`. Notarization remains blocked until the App Store Connect notary credentials are configured.

### 2026-07-23 — Ship Scheduled Tasks through Phase 4

- Added a first-class Electron-main scheduler with `croner`, serialized per-task lifecycle changes, launch catch-up without stacked missed windows, pre-execution next-run advancement, global and per-task pause/resume, bounded 50-run history, task-specific chats, macOS notifications, and privacy-safe `"scheduled"` usage attribution.
- Added bounded script execution from workspace/global `.aiden/scripts` roots, basename and realpath confinement, timeout/output limits, and TERM-to-KILL process-group cancellation that still reaches descendants after the direct leader exits. Script tasks require explicit Full permission.
- Added `/scheduled`, sidebar navigation, search/status tabs, suggestions, create/edit/delete/run-now controls, cron/timezone previews, global defaults, recoverable authoritative-load errors, notification-to-chat navigation, and workspace-authoritative follow-up chat behavior.
- Added the compressed `schedule_task` agent tool for create/list/pause/resume/remove/run-now. Interactive mutations always require the existing live hash-bound approval surface; scheduled runs cannot recurse. Prompt guards cover injection, hidden Unicode, secret access/exfiltration, and conservative mutation recommendations.
- Hardened unattended execution after two fresh source/memory-aware reviews: read-only runs withhold mutating built-ins and unknown-capability MCP connectors, MCP and command calls receive cancellation, workspace permission/removal changes stop jobs and settle runs without a late-dispatch gap, app shutdown waits through a bounded barrier, concurrent chat generations are rejected, stale/deleted task chats recover, workspace changes reset chat identity, malformed persisted schedules quarantine as disabled `Needs attention` tasks, and malformed IPC permissions fail closed.
- Focused Scheduled Tasks coverage is 32 tests. Final verification passed type-check, lint, production build, the full 625-test TypeScript/JavaScript suite, all 41 Rust tests with fmt/clippy, and a fresh hardened signed arm64 development package. The existing Vite large-chunk warning and electron-builder duplicate-dependency noise remain.

### 2026-07-23 — Resolve runtime limits from Pi and the bundled model catalog

- Replaced the hardcoded text-only `128K/8192` non-Codex runtime model with field-by-field resolution from connection-discovered per-model overrides, provider-scoped Pi exact metadata, the packaged offline model snapshot, and the conservative fallback.
- Matched Pi's provider composition: mapped built-in providers retain their model metadata when routed through a proxy, while unknown custom provider IDs cannot borrow Pi or bundled entries from another provider.
- Made the resolved runtime model's input capabilities the sole image gate for generation and chat titles, so display-only Artificial Analysis metadata cannot re-enable images or Computer Use.
- Added a one-shot shared packaged-catalog loader that fails closed on missing, malformed, or diagnostic failures without adding runtime models.dev or Artificial Analysis requests. Native Google transport remains deferred to Gemini Phase 1.
- Covered catalog hit/miss/partial resolution, proxy routing, connection overrides, provider isolation, actual bundled Gemini limits, loader failure/concurrency, transport preservation, and image gating. Two fresh adversarial reviews found no remaining issue; all 629 TypeScript/JavaScript tests, all 41 Rust tests, type-check, lint, production build, and diff validation pass.

### 2026-07-23 — Animate the terminal drawer opening

- The workspace terminal now expands upward from the chat edge over 300ms with the app's existing enter easing, using its persisted drawer height instead of appearing abruptly.
- The closed terminal remains unmounted, and both the app's explicit setting and the system Reduce Motion preference open it immediately.
- The UI detector, type-check, lint, and production build pass; the existing large-renderer-chunk warning remains.

### 2026-07-23 — Bound Pi agent context during tool-heavy generations

- Added a model-aware Pi `transformContext` to every Aiden generation. Pi's provider usage stays anchored through the assistant response that measured it while trailing tool results use per-message estimates; the system prompt, serialized tool schemas, response reserve, and a safety margin are included in the budget.
- Adapted OpenCode's retention policy to Aiden's fresh-per-generation agent: keep the two newest user turns and roughly 40K tokens of recent completed tool evidence, replace older tool payloads with neutral already-completed placeholders, and remove only complete assistant/tool-result batches so provider protocol pairs remain valid.
- Kept compaction deterministic and local instead of adding a second summarization model request. The Agent's stored state and persisted chat are not mutated; only the request context is transformed, oversized results retain bounded head/tail evidence and images, an active turn that cannot fit becomes a bounded non-tool recovery notice, and an impossible static prompt/tool set fails before provider I/O.
- Added a regression reproducing the reported 38-read/8-search Codex loop against a 128K context window, plus prefix-anchored provider usage, trailing results, images, oversized active requests, tiny static contexts, history retention, protocol pairing, non-mutation, and observer-failure coverage. The focused suite, type-check, lint, production build, all 623 TypeScript/JavaScript tests, and all 41 Rust tests pass.

### 2026-07-23 — Adversarial dictation, MCP OAuth, and dev-log hardening

- Replaced the dictation lifecycle with a tested serialized state machine covering cold pill startup, duplicate readiness, cancellation during transcription, and delivery-before-restart ordering. Pending microphone starts and late transcription results are generation-gated, and cloud/UI transcription paths have bounded 120-second deadlines.
- Made auto-paste one compiled AppleScript transaction: it captures the complete native pasteboard record, revalidates the exact frontmost process and focused element immediately before ⌘V, and restores only if the transcript is still on the clipboard, preserving rich clipboard content and user copies.
- Restricted dictation result/error/cancel/ready IPC to the current pill main document and moved the pill to a least-privilege preload exposing only settings read, microphone access, transcription, and dictation lifecycle channels.
- Added the Apple Events automation entitlement to the main signed Electron executable and pinned it in package verification.
- Bound MCP OAuth tokens and dynamic registration to the normalized protected-resource endpoint, stripped public-client DCR secrets, blocked background OAuth mutations while interactive PKCE owns a server, and serialized/atomically replaced the encrypted OAuth map.
- Removed MCP query-order fallthrough into the custom editor, refreshed preset state after key tests, added explicit stored-key removal, and refresh Accessibility status after returning from System Settings.
- Added development-only file logging with serialized rotation, bounded renderer messages, credential redaction, and no packaged-runtime writes.
- Added focused regressions for the lifecycle races, paste transaction compilation, pill sender/preload boundaries, OAuth endpoint/PKCE behavior, preset query ordering, Accessibility refresh, timeouts, and log redaction.

### 2026-07-23 — Global dictation pill with auto-paste

- The dictation hotkey (default `⌘⇧D`, unchanged setting) no longer raises Aiden and dictates into the composer; it now toggles system-wide dictation into whatever app is focused, modelled on handy's architecture (`TranscriptionCoordinator` + overlay window + clipboard-swap paste).
- `main/services/dictation.ts` is a serialized idle → recording → transcribing coordinator. It drives a new transparent, non-focusable, always-on-top pill window (`main/windows/pill-window.ts`, `pill.html` vite entry, `renderer/pill/`) positioned bottom-center of the display containing the cursor. The pill renderer owns MediaRecorder capture (`backgroundThrottling: false`), so dictation works with the main window closed or hidden; it signals subscription readiness via `dictation:ready` so a freshly created pill never misses the first "recording" broadcast.
- Recording/transcription logic was extracted from `use-voice-recorder.ts` into `renderer/lib/voice-recorder-core.ts` (`ensureMicrophoneAccess`, `transcribeBlob`), shared by the composer mic button and the pill. The stale "whisper.cpp" comment is corrected to sherpa-onnx.
- `main/services/dictation-paste.ts` (Electron-free, unit-tested) delivers the transcript: save clipboard → write transcript → System Events role check of the focused UI element → ⌘V via `osascript` + clipboard restore for text-entry roles (`AXTextField/AXTextArea/AXSearchField/AXComboBox`), otherwise the transcript stays on the clipboard and the pill shows "Copied to clipboard". Failures never throw; they degrade to the clipboard fallback.
- Accessibility access for the main app is new: `aiden:accessibility:status`/`request` native channels wrap `systemPreferences.isTrustedAccessibilityClient`, with a Grant row in Settings → Voice; the TCC prompt is shown at most once per session, and packaged builds declare `NSAppleEventsUsageDescription` for the System Events keystroke.
- IPC: new `dictation:` invoke prefix (`result`/`error`/`cancel`/`ready`), `dictation:state` notification replaces the removed `app:dictate-toggle`; the composer's hotkey subscription is gone (its mic button is unchanged). The IPC contract test passes against the new surface.
- Pill UI follows the design docs' motion contract: 200ms `.98`-scale/4px entrance, popover elevation, design tokens, reduced-motion safe; states are recording (9-bar waveform + elapsed + cancel), transcribing, pasted, copied, error.
- Verification: type-check, lint, production build (pill chunk emitted), IPC contract tests, and 5 focused paste tests pass.

### 2026-07-23 — First-class MCP providers (built-in preset catalog)

- Added a built-in MCP provider catalog (`main/services/mcp-presets.ts`, Electron-free and unit-tested) with Composio (streamable HTTP `https://connect.composio.dev/mcp`, official `x-consumer-api-key` header), Notion (`https://mcp.notion.com/mcp`, OAuth), and Linear (`https://mcp.linear.app/mcp`, OAuth). Adding a provider requires a catalog entry plus an explicit allowed origin.
- `McpServer` gained an optional `presetId`; preset API keys are stored encrypted in the keychain-backed secrets store under `mcp:<serverId>` and injected as the preset's auth header at connect time by `resolveAuth` in `mcp.ts` — keys never touch `config.json` or the renderer. Custom server headers/env remain plaintext as before (explicit non-goal).
- Main now validates a preset's deterministic ID, declared preset, transport, auth mode, and exact official HTTPS origin before it reads or sends credentials. Provider-specific API-key requests refuse HTTP redirects so a cross-origin redirect cannot retain the custom key header.
- New IPC: `mcp:presets` (catalog + per-preset configured/enabled/ready state) and `mcp:setPresetKey` (save/clear + forced reconnect); `mcp:remove` now also deletes the preset secret. `parseMcpServer` passes through `presetId`.
- Settings → MCP Servers redesigned after the LM Studio "Connected Apps" reference: a configured-server list (preset rows open a Manage dialog), a Popular MCPs card grid with Set Up, and a Manual setup footer hosting the existing custom `McpEditor`. The new `PresetSetupDialog` mirrors the reference setup sheet — race-safe status toggle, name, editable provider-owned server address (e.g. Composio Tool Router session URLs), encrypted access-token field with keychain help link for API-key presets, and browser OAuth for Notion/Linear. Connect/Test stay disabled until the required key or completed OAuth login exists, and cards say Ready rather than claiming an unverified live connection.
- Explicit OAuth re-authorization starts a fresh browser flow while retaining dynamic client registration. The prior encrypted token/session snapshot is restored if browser authorization, token exchange, or the verification connection fails; changing an OAuth endpoint requires a fresh authorization in the dialog.
- The agent loop is unchanged: preset connections are ordinary enabled `McpServer` records flowing through `collectMcpAgentTools`.
- Verification covers catalog shape, the official Composio header, identity/origin/auth-mode rejection, redirect refusal, OAuth re-authorization session behavior, renderer credential readiness/badges, and `presetId` parsing. Type-check, lint, the production build, all 592 TypeScript/JavaScript tests, and all 41 Rust tests pass. Live OAuth/API-key connect is not smoke-tested because no provider credentials were used.

### 2026-07-23 — Close high-value test-coverage gaps (Phase 1)

- Audited the whole app's test coverage with three parallel explorations (main/services, renderer, build/integration) and prioritized gaps by bug-catching value.
- Added `main/services/computer-use/safety.test.ts` (29 tests) covering the Computer Use security surface end-to-end: destructive key-combo blocklist, dangerous-shell-text regexes (pipe-to-shell, fork bomb, `rm -rf /`) across both typing actions, obfuscation normalization, approval fingerprinting, and the `ComputerUseGrantLedger` prepare/authorize/consume/expiry lifecycle. `safety.ts` went from 0% to 98.52% line / 93.01% branch coverage.
- Added `main/handlers/ipc-contract.test.ts` (5 tests), which walks production TypeScript with the compiler AST to derive every literal `ipcMain.handle`, broadcast, and renderer-send channel. It proves the inventory changes under mutation, checks the 22 `INVOKE_PREFIXES`, exact native bridge channels, and the 21 `NOTIFICATION_CHANNELS`, while production notification APIs now accept the shared channel union at compile time.
- Extracted the pure helpers out of three Electron-importing handler files into testable siblings — `chat-params.ts`, `voice-codec.ts`, `phase2-parse.ts` — and added focused tests for each. Chat parsing now copies and structurally validates attachment envelopes, count/size limits, image MIME/base64 data, and decoded-size metadata before they cross the IPC boundary; empty MCP argument arrays normalize to `undefined`; the voice string test now states the whitespace-preserving contract accurately. The handler files re-export the helpers so the IPC surface stays queryable from one module.
- Added `main/services/data-store.resilience.test.ts` (12 tests) pinning the corruption/failure behavior of the on-disk stores: corrupt, missing, wrong-root-shape, or partially malformed `index.json`/`config.json` data falls back or filters safely, `get()` returns null for an unparsable chat file, and forward-compat/unknown-field/minimal-message loads do not throw. These are the regression sentinels for a future schema-version/migration change.
- Added `main/services/artificial-analysis-catalog-core.test.ts` (23 tests) for the previously-untested 336-line catalog core (`parseArtificialAnalysisUserCache` validation, `findArtificialAnalysisModel` alias/creator/canonical-name resolution, `artificialAnalysisRanking` shaping) and `main/services/foundation-models-connection-core.test.ts` (12 tests) covering the response-parser branches the sibling test missed (success-with-title, empty-result, non-object result, invalid title, malformed system version, `model_preparing` retryable).
- Introduced a non-gating `npm run test:coverage` script using Node's `--experimental-test-coverage`. `pretest` and `pretest:coverage` now delegate to one canonical `test:preflight` manifest, keeping the Artificial Analysis catalog and all other preflight-only suites in both paths. Overall TypeScript/JavaScript coverage is 91.22% lines / 84.42% branches / 86.01% functions.
- Production hardening accompanies the new regression tests: `set_value` shares typed-text safety validation, chat index reads recover from structurally invalid JSON, text truncation respects its total bound, attachment IPC inputs are bounded and copied, and renderer notification sites use the shared channel union. Type-check, lint, the 572-test TypeScript/JavaScript suite, and the 41-test Rust suite pass.

### 2026-07-23 — Make streaming reveal visible for fast local responses

- Changed short prose to settle at safe sentence or line boundaries so LM Studio and Ollama replies produce visible, prefix-stable reveal units without exposing unfinished inline Markdown.
- Replaced the reset-on-chunk timeout with a persistent reveal schedule, preventing fast continuous streams from starving the animation. Completion drains through bounded waves, waits for the final entrance to settle, and retains a guarded emergency fallback.
- Removed the overlapping source/final Markdown crossfade. Streaming and persisted answers now use the same canonical Markdown renderer, reserve identical action-row geometry, and hand off without a cursor-induced height jump.
- Kept inline prose on a 160ms opacity-only entrance so baselines never move or blur; complete semantic blocks retain a restrained 180ms 4px rise. Reduce Motion reveals immediately without resetting progress.
- Keeps fenced code, lists, and tables visible while they grow under stable block keys; synthetic fence closure preserves canonical code layout without remounting on the real closing newline, and code source formatting is no longer mutated by validity-sensitive JSON prettifying. Long run-on prose reveals in stable word groups instead of arriving as one large completion jump.
- Preserved final buffered text and reasoning on error, retains the only rendered answer and timeline when persistence fails, co-located live tool steps with the transient assistant shell, and bounded exiting status layers to prevent ghost stacks.
- Added pure scheduler/parser regressions and source/CSS motion contracts for starvation, text retraction, open-structure growth, closing-fence key stability, persistence-error retention, canonical Markdown handoff, reduced-motion toggles, stable geometry, and cursor removal. The full 491-test TypeScript/JavaScript suite, 41-test Rust suite, type-check, lint, and production build pass.

### 2026-07-23 — Show local-model reasoning in the transcript

- Routed Pi `thinking_delta` events from the explicit LM Studio and Ollama presets through a dedicated, document-owned IPC channel while keeping hosted-provider and redacted reasoning outside the renderer boundary.
- Persisted local reasoning only on trusted main-process assistant messages, retained it across cancellation and provider errors, and continued to reject renderer-authored or non-assistant reasoning metadata.
- Added a compact borderless reasoning surface with semantic muted fill, keyboard scrolling, live tail-following, scroll-edge gradient masks, and Reduce Motion-aware entrance behavior; the final answer remains visually dominant below it.
- Verified the flow live against LM Studio's Gemma 4 reasoning stream and after reopening the saved chat. The pinned Pi adapter contract also covers OpenAI-compatible `reasoning` deltas used by local endpoints. Type-check, lint, the UI detector, production build, 491 TypeScript/JavaScript tests, and 41 Rust tests pass.

### 2026-07-22 — Gate Designer Mode behind preview, identity, and trust proofs

- Reworked the Designer Mode proposal against current Aiden and Onlook source with three independent review lanes. The product loop remains point → ask → approve → Action Review, but implementation is blocked on a Phase 0 preview-containment and DOM↔source identity proof.
- Scoped the first supported slice to Vite + React + Tailwind, moved Next.js and direct manipulation post-MVP, replaced ordinary Pi writes with an always-approved, hash-bound Designer Action transaction, and replaced whole-worktree Git checkpoints with exact action-ledger undo plus an optional managed worktree before mutation.
- Recorded the sandboxed iframe as the preferred preview candidate, a dedicated main-owned preview-server lifecycle, main-owned selection resolution, action-specific Review, packaged security/fixture gates, Apache-2.0 provenance obligations, and a revised 6–9 engineering-week MVP estimate. No Designer Mode implementation exists yet.

### 2026-07-22 — Animate streaming answers and agent milestones

- Added block-aware streaming reveal for prose, Markdown, lists, tables, and code so stable semantic units fade into place without repeatedly reparsing the whole transcript or exposing unfinished markup.
- Projected Pi tool events into a versioned, renderer-safe timeline with opaque local IDs, bounded relative targets, stable parallel ordering, approval states, and correct completed/failed/blocked/cancelled settlement.
- Replaced transient status pills with compact, unboxed agent milestones and grouped adjacent discovery work; live event, label, approval, error, and activity changes now crossfade with explicit Reduce Motion behavior.
- Moved assistant response and timeline persistence into the main-process generation owner. Safe terminal steps survive reload, renderer-supplied timelines are rejected, and old chats without timelines remain compatible.

### 2026-07-22 — Show meaningful agent activity motion

- Centered the transcript's scroll-to-bottom control above the composer and raised its surface opacity for clearer separation from conversation content.
- Replaced the generic running spinner with the inline `thinking-orbs` canvas states, driven only by Aiden's real preparing, thinking, responding, discovery-tool, working-tool, approval-wait, and stopping lifecycle signals.
- Removed the activity-row pill containers and reserved a restrained, Reduce Motion-aware text shimmer for the Thinking state.
- Kept completion, denial, and failure static; respected Aiden's explicit appearance and Reduce Motion preferences; and added pure precedence/mapping coverage plus the packaged MIT notice.

### 2026-07-22 — Prepare the repository's public presentation

- Reworked the README around a concise product story, a real Aiden screenshot, the privacy and Computer Use trust boundaries, essential development commands, and links to the detailed release and architecture documents.
- Added explicit public-readiness guidance with recommended GitHub description/topics and owner decisions for licensing, source visibility, contribution policy, history scanning, and repository protections.
- Completed the package's public-facing description, homepage, issue URL, and search keywords while retaining `private: true` to prevent accidental npm publication.
- Replaced developer-specific absolute checkout paths in public design and provider documents with their upstream repository links; remaining absolute user paths are synthetic test fixtures.
- Confirmed that the current source tree has no `LICENSE`; the repository therefore does not claim to be open source, and choosing licensing terms remains an owner decision.

### 2026-07-22 — Align macOS window controls with the sidebar toggle

- Lowered the native traffic-light cluster within the hidden titlebar so its center matches the renderer's 52px sidebar header and toggle. The sidebar geometry and all other toolbar controls remain unchanged.

### 2026-07-22 — Add a compact Settings About view

- Added an App → About destination with the Aiden icon, runtime version/build type, and one external GitHub repository link. The view reuses the existing app-info bridge and settings visual vocabulary without adding explanatory copy or a new privileged IPC surface.

### 2026-07-22 — Prepare branded publishing and automatic updates

- Replaced the neuron app artwork with Raychat's compiled Aiden mascot icon, including a matching grayscale Dock variant, and made the hot-reload runtime rebrand the main and helper bundles as Aiden Agent with a separate development bundle ID and ad-hoc signature.
- Preserved development security semantics despite Electron treating a renamed executable as packaged: hot reload still uses development-only native helper, Computer Use, resource, and updater paths.
- Added packaged-only `electron-updater` checks with a quiet native menu action, background download, ready notification, six-hour polling, and install-on-normal-quit behavior.
- Added pinned-action macOS CI plus a gated main-push release workflow that derives monotonic versions, runs full gates before loading secrets, builds/signs/notarizes/verifies the DMG and ZIP, generates version-bound update metadata, and publishes only verified assets to a separate public binary repository.
- Kept publication disabled until the public feed and protected Apple/GitHub secrets are explicitly configured through `RELEASES_ENABLED=true`; documented bootstrap, trust boundaries, recovery, and version-line changes in `docs/releasing.md`.

### 2026-07-22 — Remove duplicate composer readiness guidance

- The unavailable-model message now appears once as the empty textarea placeholder, then moves below the draft only after the user starts typing so the disabled send state remains explained without duplicate copy.

### 2026-07-22 — Clarify Model Pad selection feedback

- Removed the Pad puck's positional and press-scale transitions so previews snap directly to their target; the white puck now transitions only to the current theme accent over 250ms after pointer release, Enter, or Space.
- Kept the feedback local to the picker without a toast. Preview movement clears the confirmation color, reduced-motion preferences collapse the transition through the shared motion contract, and the existing selected option state remains authoritative for assistive technology.

### 2026-07-22 — Make the Model Pad personal and user-arranged

- Replaced the Artificial Analysis gate with a device-local Personal Model Pad in Settings. Users choose a curated set of their usable chat models, drag them vertically by personal capability and horizontally by perceived response pace, or use accessible arrow-key nudging, then explicitly save the layout.
- The picker now opens the Pad when saved placements exist and otherwise opens the complete searchable List. Only saved models are plotted; the List still exposes every usable chat model, and temporarily unavailable saved placements are preserved for their return.
- Reframed Artificial Analysis as an optional suggestion source for unplaced hosted models. Suggestions never override personal positions, remain visibly attributed, and disconnecting the benchmark cache leaves the saved Pad unchanged.
- Added a versioned fail-closed local layout contract, deterministic open-position placement, stale embedding-ID filtering, and pure regression coverage for parsing, persistence, geometry, and saved-only plotting. Live Electron QA verified add, keyboard movement, save, Pad-first display, complete List fallback, and removal; the temporary test preference was cleared afterward.

### 2026-07-22 — Correct composer context-strip depth

- Isolated the attached context-strip/composer stack and assigned explicit local layers so the translucent, backdrop-blurred strip stays behind the raised composer edge. The existing overlap, darker theme-aware surface, and compact geometry remain unchanged.

### 2026-07-22 — Add Command-number chat switching

- Added native-style ⌘1–⌘9 chat navigation. Holding Command for half a second reveals quiet, theme-aware shortcut chips beside the first nine chats, while the shortcuts themselves work immediately.
- Shortcut assignment projects from the sidebar's canonical ordered sections instead of maintaining a second recency sort. Search does not renumber chats, and future pinned or user-selected sorting can change the section order without changing keyboard handling.
- Added pure regression coverage for order preservation, the nine-chat cap, exact modifier handling, key repeat/composition rejection, and the 500 ms reveal contract.

### 2026-07-22 — Simplify sidebar chat rows

- Removed the repeated speech-bubble icon from ordinary chat rows so titles align directly with their time-bucket labels and the conversation-first sidebar reads more quietly. The temporary Apple rename spinner remains as a meaningful progress indicator.

### 2026-07-22 — Repair theme safety and composer context layering

- Corrected the Slate light accent so every built-in light/dark preset passes the same canvas-and-raised contrast checks enforced by the Appearance UI. Named presets now normalize back to their current canonical palette, migrating stale cached Aiden colors without changing explicit custom themes.
- Replaced the composer context strip's compounded low-alpha control fill with a dedicated semantic surface derived from each theme's darker sidebar layer at exactly 80% opacity plus restrained backdrop blur, preserving the recessed visual register while preventing conversation text from reading through it.
- Added preset-migration, runtime-safety, and light/dark context-token regressions. Strengthened `AGENTS.md` so every new or materially restyled UI element must consult both UI reference documents and reuse the shared semantic design tokens.

### 2026-07-22 — Refresh composer prompt state

- Replaced the fixed empty-chat `Do anything` placeholder with ten approved task-starter prompts, selected deterministically from the chat ID so the copy remains stable while a chat is open.
- Once a chat has a persisted message, the composer now says `Follow up`; unavailable-model and setup guidance retains priority over conversational placeholder copy.
- Added pure placeholder-policy regression coverage, registered it with the standard test suite, and updated the companion UI specimen.

### 2026-07-22 — Complete hardened Computer Use release acceptance

- Separated development packages, distribution staging, and canonical release output so stale DMG/ZIP files cannot look current. Release cleanup rejects symlinked ancestors, staging promotes atomically only after verification, and private acceptance receipts are create-only, identity-bound, and invalidated before a new package or release attempt.
- Added fail-closed Developer ID and notarization preflight, requiring exactly one complete notary strategy and the pinned signing team. Release verification now requires the Developer ID identity, hardened runtime, notarization, stapling, Gatekeeper acceptance, and full inspection of the current DMG and ZIP; each embedded app must match the verified staging bundle/version, CDHash, and ASAR SHA-256.
- Added a capability-authenticated loopback packaged harness that seeds both Computer Use gates off, launches one uniquely titled disposable TextEdit process, correlates exact tool-call results, validates list/app/window and AX/vision/SoM captures, requires separate one-use approvals for typing and save, rejects a stale element before approval, and proves the saved marker.
- Typed cancellation provenance now distinguishes the visible Stop control from lifecycle cancellation. Acceptance requires the explicit renderer Stop audit event, observes the packaged helper set, proves it stays continuously empty while Aiden remains alive, then requires a normal quit and another clean helper window. Emergency cleanup uses exact package-owned executable identities with repeated TERM-to-KILL sweeps that cover late broker/driver races.
- Three independent final reviewers returned ACCEPT after deterministic regressions closed the late-driver, late-helper, and exit-during-final-sample races. The final 450-test TypeScript/JavaScript suite, 41 Rust tests with strict clippy, 4 Swift tests, type-check, lint, targeted formatting, diff check, production build, and hardened package verification pass; the reviewed source landed as `ab691bc`.
- Live packaged acceptance passed on 2026-07-22 with `cua-driver` 0.8.3 ready, exact disposable TextEdit PID/window binding, two visible Allow once decisions, successful saved marker, stale-action rejection, visible Stop teardown while Aiden remained open, normal app quit, and no surviving package-owned helper. The private `0600` receipt binds the development artifact's bundle identity, CDHash, and ASAR hash. Developer ID notarized distribution remains an operational gate because this Mac has no release identity/notary credentials; the release path rejects that environment before building artifacts.

### 2026-07-22 — Add fail-closed Computer Use activation and permission UX

- Added a persisted global Computer Use beta gate and a separate persisted per-chat opt-in, both off by default. Production creates the generation-owned `cua-driver` controller only when both gates, the generation revision, the exact model image capability, signed-helper readiness, and macOS permissions are current.
- Added Settings readiness/status/error/retry states, host-owned Accessibility and Screen Recording requests, a keyboard-reachable composer control, explicit provider data-policy copy, and one-action approval UI. The pinned embedded driver is launched with the signed broker's exact `--host-bundle-id`, and permission reports attributed to any other host fail closed.
- Bound status, permission, chat-setting, stream, cancellation, and approval work to the exact renderer document or generation AbortSignal so navigation cannot relaunch a stale helper or permission prompt. Per-chat opt-ins stage to a temporary file and atomically rename only while the owner remains current.
- Serialized every config read-modify-write through one fresh-snapshot transaction queue. Disabling closes the live generation gate synchronously, cancels only Computer Use generations, persists even if its renderer exits, and latches a fail-closed state that a failed or stale enable cannot clear.
- Sealed and verified disabled-state durability before quit, kept the renderer alive with a native error when persistence fails, settled unload vetoes before irreversible service shutdown, and added a tested renderer-close barrier. A successful enable clears the fail-closed latch only after persistence and final owner validation.
- Added status, permission, ownership, configuration-race, shutdown, stale-enable, composer-keyboard, query-error, and quit-lifecycle regressions. The full and focused Computer Use suites, 41 native Rust tests with strict clippy, type-check, lint, diff check, and production build pass. Three independent final reviewers returned ACCEPT for integration/lifecycle, adversarial security, and upstream/product mapping.

### 2026-07-22 — Add the Hermes-style cua-driver Computer Use adapter

- Added one sequential, model-agnostic `computer_use` AgentTool over the authenticated external `cua-driver` boundary. The adapter supports capture, app/window discovery, exact focus, pointer/drag/scroll, typing/keys/value changes, and bounded waits without adding any Swift GUI automation implementation.
- Mapped Aiden's `som`, vision, and accessibility modes to the pinned 0.8.3 schemas; preserved zero-based indices and opaque element tokens; converted element drags only from exact current screenshot dimensions; resolved desktop requests only to exact on-screen OS shell identities; and surfaced a sanitized `verified`/`effect`/`path`/`code`/`degraded`/`escalation` verdict for the background-to-pixel-to-foreground loop.
- Added Pi-native transient image content and one positive generation capability snapshot so legacy vision metadata and Pi serialization cannot diverge. Screenshots never enter attachments, IPC, logs, details, or persisted chat data, and Agent transcript/image state is synchronously reset before bounded helper/provider teardown.
- Made every non-read-only action approval-gated regardless of workspace permission. Prompts include the exact app, title, pid, and window; one-use grants bind generation, normalized arguments, and the prompt-time target revision; ambiguous targets and intervening captures fail closed; dangerous shell-like typing and destructive system shortcuts are blocked before approval; and every successful mutation invalidates stale elements/pixels.
- Hardened cancellation and setup ownership across initializing/active map transitions, duplicate stream IDs, Agent construction/subscription failures, queued approvals, helper poisoning, and app shutdown. Follow-up capture failures report that the action already completed and explicitly prevent blind replay.
- Expanded adapter, approval, capability, lifecycle, pinned-schema, desktop false-positive, Retina drag, structured-verdict, image-sanitization, cancellation, packaging, and native containment coverage. The full 379-test TypeScript/JavaScript suite and 39-test native suite, focused Computer Use/package/native gate, type-check, lint, diff check, and production build pass. Three fresh post-fix reviewers returned ACCEPT for lifecycle/integration, security/approval, and pinned-driver mapping.
- Production construction remains intentionally disabled until Phase 3 adds persisted beta enablement, permission/status controls, and chat-facing state.

### 2026-07-22 — Establish the external cua-driver Computer Use foundation

- Archived the discarded Pi/Swift prototype on `archive/pi-computer-use-prototype-20260721` and pivoted to Hermes's intended architecture: Aiden uses the external Rust `cua-driver` MCP backend, while a small Rust/Objective-C helper supplies only macOS trust, permission, transport, and lifecycle boundaries. No Computer Use capture or input implementation lives in Swift.
- Exact-pinned the pre-release `cua-driver` 0.8.3 universal artifact, archive and binary hashes, source tag/commit, signing identifier, Team ID, and cross-architecture CDHashes. The vendor flow never uses a moving installer or `PATH`, disables telemetry/update checks, and bounds descendants across success, timeout, and owner crash.
- Added a separately identified `CuaDriver.app` broker that authenticates Aiden, bridge, broker, and driver process incarnations with kernel audit tokens and signed-code requirements. The broker owns the TCC identity, launches untouched `cua-driver mcp --embedded`, filters MCP to the exact reviewed 20-tool allowlist, and uses anonymous pipes plus a one-shot bridge-held lease.
- Hardened constrained launch and teardown around `NSTask.launchRequirementData`, independent pre-auth guards, child-scanning watchdogs, occupied containment groups, retained child audit tokens, early fd-3 parent-death monitoring, exact process signaling, bounded TERM-to-KILL escalation, descriptor ownership, and strict startup-error frames. Candidate-owning launch-failure, PID-mismatch, and pre-return lease-revocation paths all terminate the occupied driver group.
- Added bounded MCP framing, serialized per-session calls, exact start/end lifecycle, permanent catalog incompatibility errors, retryability-preserving diagnostics, immediate queued-cancellation poisoning, local oversize rejection without SDK handler leaks, and a test-only host excluded from production bundles.
- Added hardened Electron fuses, minimal helper entitlements, exact helper-tree/resource/plist verification, nested signing rules that preserve the upstream driver signature, macOS 14.4 deployment enforcement, license/provenance packaging, and development package verification. Developer ID notarization/stapling remains Phase 4 work.
- Final verification passed 350 TypeScript/JavaScript tests, 39 native tests with strict clippy, type-check, lint, production build, signed-package verification, and two signed real-driver smokes. The live boundary reported `cua-driver` 0.8.3, schema 1, exactly 20 tools, 175 installed apps, healthy session state, clean shutdown, and no surviving helper process. Three fresh post-fix reviewers returned ACCEPT for native containment, TypeScript lifecycle, and packaging/provenance.
- The foundation remains intentionally absent from the production agent tool list until Phase 2 adds the Hermes-compatible adapter and Phase 3 adds persisted enablement, permissions/status, and UI.

### 2026-07-21 — Add the paired light and dark Appearance workbench

- Replaced the one-choice native theme screen with a full Appearance workbench: visual System/Light/Dark cards, live light-versus-dark code preview, four paired theme presets, independent light/dark colors, font families, sidebar translucency, contrast, JSON import/copy, and app-wide preference controls.
- Added a versioned shared appearance contract plus startup cache/prepaint. Semantic colors now reach the complete renderer, syntax highlighting, terminal, file/editor code, and review diffs; UI/code size, pointer cursors, font smoothing, explicit diff markers, and resolved reduce-motion preferences update live.
- Raised the default dark canvas from near-black to graphite `#181B21` with visibly layered sidebar and raised surfaces. Custom themes require readable text and accent contrast; unsafe drafts remain recoverable in the editor but cannot replace the applied or saved theme.
- Added real color and monochrome Aiden Dock choices, packaged both PNG assets, restored the saved icon and native theme before window creation, and made native/save failures non-destructive and visibly retryable.
- Completed two fresh independent architecture and UI reviews, then fixed their validated startup fallback, hydration race, full native-theme broadcast, strict import schema/version, named-preset mismatch, reduce-motion override, roving-radio keyboard, provider-context mount, and save-order findings.
- Live isolated Electron QA passed in light and graphite dark modes, including clean Appearance navigation, unsafe-color recovery, native Reduce Motion override, keyboard focus, and Dock swaps. All 151 tests, type-check, lint, production build, signed arm64 packaging, strict deep signature verification, and packaged-app Appearance/Dock smoke checks pass; the existing renderer chunk-size warning remains.

### 2026-07-20 — Bundle local-first and Artificial Analysis model metadata

- Changed explicit LM Studio and Ollama discovery to use their native model endpoints, persist provider-reported names, model type, vision/tools/reasoning, context, parameters, and format, and exclude embedding models from chat selection.
- Added bundled models.dev and Artificial Analysis snapshots with one guarded manual/release updater. The runtime precedence is local discovery metadata for local models, Artificial Analysis for hosted matches, then models.dev for missing models or fields; no public catalog runs inside the app.
- Derived fixed capability and median end-to-end response-time percentiles for the spatial pad, added visible Artificial Analysis attribution, and kept local models off hosted benchmark positions. Unknown capability flags remain unknown so an unmatched catalog row no longer incorrectly blocks images.
- Made snapshot refresh fail before network access without an API key and explicit redistribution-rights confirmation. The repository therefore carries a validated empty Artificial Analysis placeholder until an authorized refresh is available.
- Added native-discovery, precedence, parser, ranking, pagination, licensing, packaging, embedding-filter, and pad-integration coverage. All 150 TypeScript/JavaScript tests, type-check, lint, production build, signed unpacked package, direct `app.asar` snapshot inspection, targeted formatting, and diff checks pass; the existing renderer chunk-size warning remains.

### 2026-07-21 — Add ChatGPT / Codex sign-in and Pi-native runtime

- Exact-pinned `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` at `0.80.10`, adopted Pi's built-in `openai-codex` provider and seven-model catalog, and kept the seven existing API-key providers on their compatibility runtime without exposing a duplicate generic Codex card.
- Added an encrypted, atomic, serialized type-tagged credential store and single-instance app boundary. Plaintext OAuth credentials stay in Electron main; renderer APIs expose only configuration/health snapshots and app-owned flow identifiers.
- Added owner- and document-bound browser/device-code OAuth orchestration with sanitized prompts/events, HTTPS-only external links, opaque select values, cancellation/cleanup timeouts, explicit credential commit point-of-no-return, awaited quit durability, logout, and cross-window status broadcasts.
- Added a compact dedicated ChatGPT Settings card with status, sign-in, device-code/copy/link, manual-code/text/secret/select prompts, cancellation/retry, repair, and confirmed sign-out. Reducer/session generations prevent stale callbacks or secret drafts from crossing prompt/flow boundaries, and focus/live-region behavior covers every asynchronous state.
- Routed Codex chat and title requests through Pi's native provider stream with Pi-authoritative capabilities, per-Agent-turn OAuth refresh, a 60-second expiry safety window, bounded caller and shared-operation deadlines, guarded late one-time-token reconciliation, credential-generation dispatch barriers, automatic rotation, backend health, stale-model rejection, and chat-session identity. Pi `0.80.10` Codex requests are forced to SSE until its lazy WebSocket path checks cancellation before handshake construction.
- Distinguished app-requested cancellation from credential-change interruption so partial old-generation responses are saved with an error instead of ordinary completion. Hardened abort fan-out and already-cancelled promise observation against Electron main-process crashes and unhandled rejections.
- Implemented in five phases on an isolated worktree branch, with two independent memory/source-aware reviewer passes after every phase and repeated adversarial loops until both lanes were clean. Final verification passed 177 TypeScript tests, 4 Swift tests, type-check, lint, production build, `npm audit --omit=dev` with zero vulnerabilities, signed arm64 packaging, strict deep signature verification, asar content/version checks, and isolated packaged-app preload/provider/Codex IPC smoke. No live OAuth exchange or push was performed.

### 2026-07-21 — Add privacy-safe native profile sharing

- Added a Profile-toolbar Share action and a live, theme-matched 3:4 SVG preview that rasterizes locally to a fixed 1200×1600 PNG. The curated image contains the chosen profile name and aggregate usage only; it never adds prompts, chats, workspace names, paths, or generated content.
- All-time snapshots keep all-time totals while clipping only the activity heatmap to the latest inclusive 365 days. Shorter selected ranges retain their own calendar window, and the card bounds long names/model labels, sanitizes bidirectional controls, compacts streaks, and preserves readable light/dark text contrast.
- Hardened the renderer/main boundary with canonical base64 and complete PNG chunk/CRC validation, native decode plus re-encode, fixed-dimension checks, one active native ShareMenu, a live parent-window requirement, private `0700`/`0600` temp artifacts, delayed post-menu cleanup, a maximum session lifetime, and stale-crash cleanup.
- Added focused share-data, self-contained SVG, complete PNG, malformed payload, private-file, and stale-cleanup tests. The full 94-test suite, type-check, lint, production renderer/main/preload build, and `git diff --check` pass. Live Electron acceptance verified the profile, responsive toolbar/month labels, accessible 3:4 preview, 1200×1600 raster path, and native macOS share-services menu without selecting an external destination.

### 2026-07-21 — Add private, device-local model-usage accounting

- Added a serialized `usage.json` aggregate ledger with rolling 7/30/90-day, one-year, and all-time summaries, active-day streaks, per-model rankings, exact reported token breakdowns, and hosted cost totals only when pricing is known. Prompts, transcripts, chat/workspace identifiers, paths, and generated content never enter the record contract or persisted buckets.
- Count every Pi assistant `message_end`, including tool-loop, terminal-error, and abort turns; also count chat-model and Apple Foundation Models title requests, OpenAI/Gemini cloud transcription, and on-device Parakeet transcription. Local and otherwise unmetered calls remain visible in request/activity totals while local cost is always excluded.
- Hardened locality around the actual loopback endpoint rather than provider names or authentication mode, separated Gemini cached prompt tokens from uncached input, and retained failed/invalid-response transcription attempts without double-counting.
- Await best-effort ledger writes at model-call settlement boundaries so fast shutdown cannot drop completed calls. The in-memory mutation tail survives transient save failures, malformed/impossible persisted dates are discarded, corrupt local cost fields are stripped, and the main/preload/renderer IPC boundary exposes only privacy-safe summaries.
- Added 9 focused accounting tests covering aggregation, inclusive ranges and streaks, concurrency/privacy, tool-loop/error/abort outcomes, local/hosted cost semantics, OpenAI/Gemini usage fields, corrupt data, and transient write recovery. The full 80-test suite, type-check, lint, and production build pass.

### 2026-07-20 — Add a spatial, magnetic model picker

- Replaced the composer model dropdown with a Photographic Styles-inspired square Pad plus the preserved searchable List view. Horizontal position runs Faster → More deliberate; vertical position runs Everyday → More capable.
- Assigned every usable provider/model pair to a unique, evenly spaced lattice cell nearest its desired ranking position. The reference 11×11 grid expands automatically for catalogs above 121 models, so active dots never overlap and pinning never changes geometry.
- Added a high-contrast white puck with nearest-model hysteresis and magnetic animation. Hover and drag update the model details live, pointer-leave restores an uncommitted preview, pointer release commits, arrow keys move spatially, Enter commits, Escape restores the selected model, and reduced-motion removes decorative easing.
- Kept the picker close to the old list footprint: a 316px main surface (about 10% wider than the prior 288px menu) containing only accessible `List`/`Pad` tabs and their active content. Provider/capability/context metadata moved into a separate 224px read-only hover/focus sidecar outside the picker; ranking copy, title/count/reset chrome, visible axes, and help copy were removed from the visual surface while remaining accessible where needed.
- Added an optional fixed-snapshot `ModelRanking` seam without introducing runtime network access. Artificial Analysis research identified it as the best unified intelligence/response-time source, but customer-facing redistribution requires a Commercial agreement; current name/size estimates are labeled Estimated and unknown/local models are Unranked.
- Verified exact live dimensions (316×350px main surface, 300px Pad, 224px sidecar), magnetic hover and restoration without changing the committed model, searchable List sizing, and roving tab keyboard access in Electron through the DevTools protocol. Added pure ranking/navigation/lattice tests; the full 71-test suite, type-check, lint, formatting check, and production build pass.

### 2026-07-20 — Rename existing chats with Apple Foundation Models

- Added `Rename with Apple` to each chat row's existing context menu, gated by the main-owned Apple Foundation Models availability state and paired with disabled, in-progress, success, unchanged, refusal, and recoverable-error feedback.
- Built a bounded on-device rename prompt from the original user request, attachment names, and up to eight recent user/assistant messages; system instructions and attachment contents never enter the native request.
- Reused the signed LaunchServices helper and metadata notification path, including the existing accessible title reveal, while compare-and-set persistence ensures a manual rename made during generation always wins.
- Live isolated Electron QA verified the enabled menu item, row-level busy state, native refusal preservation, a successful 1.36-second on-device rename to `Add compact rename to chat rows`, and the completion toast. All 129 TypeScript tests, four native tests, type-check, lint, production build, and diff checks pass; the existing renderer chunk-size warning remains.

### 2026-07-20 — Separate the Environment summary from Review and Files

- Replaced the integrated Overview tab with a detached 380px top-right Environment card that leaves the chat at full width, interactive, and undimmed in both wide and compact layouts.
- Kept Review and Files in the existing persistent, resizable work surface. Their wide inline and compact inert-overlay behavior is unchanged, and the mounted Files editor preserves its selected file and draft while the summary card is visible.
- Made the toolbar and `⌘⇧E` open the summary first; Changes and Compare deep-link to Review, the header action exposes Review/Files/Compare destinations, and the expanded surface has a dedicated Summary control.
- Preserved layered Escape and focus return, added a quiet `.98`/4px card entrance with a reduced-motion override, removed the hidden inline panel's residual border width, and kept only one accessible Environment overview mounted at a time.
- Closed the Phase 4 two-reviewer loop after separating preferred and rendered width state, protecting a 560px minimum conversation region, isolating every compact-overlay background sibling, trapping focus, and retaining the card for its 120ms exit animation. Both fresh re-reviewers returned SHIP.
- Updated both ChatGPT/Codex UI reference artifacts to document and demonstrate the detached summary plus expanded work-surface topology.
- Live isolated-renderer checks passed for card geometry, non-modal conversation behavior, compact overlay and wide inline modes, Review/Files transitions, action menu, mounted editor state, and fresh-cycle Escape focus restoration. All 127 tests, type-check, lint, and the production renderer/main/preload build pass; the existing renderer chunk-size warning remains.

### 2026-07-20 — Add the thread-adjacent Environment Review and Files workbench

- Expanded the ChatGPT/Codex desktop audit into an explicit state inventory for the right-side shell, responsive modes, Git Review, unified diffs, file indexing, full-file editing, dirty/saving/conflict flows, and bounded/error states; added an interactive Review/Files tour to the HTML specimen.
- Added a persistent, keyboard-accessible Environment panel with Review and Files tabs, `⌘⇧E`, pointer/keyboard resizing, wide inline and compact overlay layouts, focus return, reduced motion, and mounted drafts across tab/panel visibility changes.
- Added workspace-authorized Git review and bounded per-file diffs for staged/unstaged, untracked, rename/copy, conflict, deletion, binary, truncated, clean, non-repository, loading, and recoverable-error states.
- Added a bounded workspace tree and UTF-8 full-file editor with search, narrow list/detail navigation, native undo/redo, line gutter, wrap, `⌘S`, atomic SHA-256 version-checked saves, stale-file refusal, and destructive confirmation before discarding edits.
- Verified the specimen and live Electron shell at wide and compact sizes. All 75 TypeScript tests, type-check, lint, and renderer/main/preload production builds pass; the existing large renderer-chunk warning remains.

### 2026-07-20 — Normalize model names and disclose picker metadata

- Refreshed the release-only models.dev snapshot and now prefer its canonical display names throughout the composer picker and Provider Settings without altering the exact IDs sent to providers.
- Added deterministic name cleanup for unlisted and local models, including versions, parameter sizes, quantization/file-format tags, and common model-family capitalization.
- Added a compact collision-aware details card for the active pointer or keyboard row with provider, inputs, capabilities, context, output limit, raw ID, and metadata provenance; equivalent summaries remain available to screen readers inside the menu.
- Kept search compatible with friendly names, provider labels, raw IDs, and format tags. The live packaged picker and keyboard navigation pass alongside 67 tests, type-check, lint, and a signed DMG/ZIP distribution build.

### 2026-07-20 — Animate generated chat-title replacements

- Added a quick character-by-character reveal only when the background title-generation notification replaces a temporary chat title; initial list rendering and manual renames remain static.
- Used a dependency-free two-stage sequence: the temporary title fades out for 200ms, then the replacement runs a 500ms opacity and 2px-rise character reveal without moving surrounding layout.
- Kept one unsplit screen-reader label while hiding visual character spans from accessibility APIs, and disabled the decorative animation under `prefers-reduced-motion`.
- Added focused ordering and duration-bound tests. The 64-test TypeScript suite, type-check, lint, and production build pass.

### 2026-07-20 — Add on-device Apple Foundation Models chat titles

- Added a macOS-only Apple Foundation Models connection for background chat titles, with macOS 26, Apple silicon, Apple Intelligence, and model-readiness gates exposed as serializable main-owned status.
- Added a SwiftPM background helper app with a versioned, bounded JSON protocol, fresh one-shot `LanguageModelSession` use, guided `@Generable` output, mapped availability/generation errors, immediate request-file deletion, and native protocol tests.
- Added Automatic, On-device only, and Selected chat model routing. Apple never appears in the composer, On-device only never falls back to a network model, stale readiness is downgraded after native availability failures, and existing manual-rename/compare-and-set title safety remains intact.
- LaunchServices uses a private per-request exchange directory. The helper publishes its process ID, checks a cancellation marker before generation, and is terminated and cleaned on timeout, abort, or app quit.
- Added the native status card and title-provider selector to Provider Settings, including preparing polling, manual refresh, accessible live/busy status, and visible save/refresh failures.
- Limited packaged build inputs to renderer/main/preload output, declared the nested helper as an additional macOS signing input, and removed Swift release/test/module-cache residue and the duplicate helper from `app.asar`.
- Completed two fresh, independent reviews against the Foundation Models skills repository and T3 Code, then fixed every validated finding covering helper ownership, cached readiness, Settings errors, package residue, and nested signing structure.
- Verification passes with 61 TypeScript tests, 4 Swift tests, type-check, lint, production build, unpacked macOS packaging, strict nested-helper signature validation, clean asar inspection, and real on-device generation from both development and packaged helpers. Aiden's older app-wide sealed-resources verification issue remains separate from this feature.

### 2026-07-20 — Make model metadata release-only

- Replaced runtime catalog fetching and user-data TTL caching with a static model-capabilities JSON asset read locally from the application package.
- Removed the refresh IPC path so neither settings nor chat startup can invoke a public capability-catalog request.
- Added a release-only snapshot updater and made the distribution command run it before building artifacts; development and unpacked-package flows retain the checked-in snapshot without network access.

### 2026-07-19 — Harden Git operations and add isolated worktree workspaces

- Replaced arbitrary renderer-path Git IPC with workspace-ID-scoped resolution that rechecks the persisted folder, directory availability, and workspace permission in Electron main.
- Moved folder grants to a main-process system picker; permission changes, workspace removal, and renderer teardown now abort active Git operations.
- Rebuilt the Git service around direct argument arrays, a stable noninteractive environment, typed and redacted errors, output and timeout bounds, process-group aborts, inherited Git-routing-variable removal, NUL-safe porcelain parsing, a bounded one-second cache with mutation epochs, and per-common-directory mutation serialization shared by linked worktrees.
- Added richer local repository state—detached and unborn refs, upstream, ahead/behind counts, remote-derived default branch, remotes, and local/remote refs. Tracking state is explicitly local-only/last-fetched and the app never performs an implicit network fetch.
- Added managed isolated worktrees under Electron user data. Creation uses a collision-resistant repository/branch path, preserves nested workspace scope, transactionally rolls back the checkout/branch when later steps fail, preserves the source checkout, and opens the result as a separate Aiden workspace inheriting the source permission.
- Added explicit managed-worktree cleanup that refuses dirty checkouts and deletes the branch only if it still points to its original creation commit; otherwise the branch and its commits remain intact.
- Extended the existing compact branch menu using the documented ChatGPT/Codex menu, context-strip, motion, focus, and progressive-disclosure references; no new page, modal, or component system was introduced.
- Completed three independent backend, correctness, and UI reviews against T3 Code and the documented ChatGPT/Codex references, then resolved their authorization, cancellation, rollback, cache-race, process-tree, managed-cleanup, and interaction-state findings.
- Expanded to 15 focused real-repository Git tests covering unusual NUL-delimited paths, shell-safe refs, local-only checkout, remote divergence/default refs, common-directory concurrency, linked and nested worktrees, cache/mutation races, transactional rollback, descendant termination, inherited environment isolation, credential redaction, unborn repositories, and non-repositories. The full 37-test suite, type-check, lint, and production renderer/main/preload build pass. A live Electron pass verified the compact menu and layered creation/Escape behavior before the final review fixes; the post-review GUI recheck was blocked by the locked Mac and completed from source/build evidence instead.

### 2026-07-19 — Require UI reference review for new elements

- Updated the agent guidance so any new UI element or component begins with a review of the ChatGPT/Codex desktop inspiration audit and interactive UI specimen, while adapting those references to Aiden's established visual language.

### 2026-07-19 — Add the new-chat workspace plate and scratch folders

- Turned the composer’s folder chip into a searchable, keyboard-accessible workspace plate only while the current chat is untouched; established chats retain the existing open-in-Finder action.
- Added a serialized empty-chat workspace move that updates the chat file and shared index together, validates the target workspace in main, and refuses to move any chat after its conversation has begun.
- Added “Don’t work in a workspace” as an explicit scratch action backed by exclusive private directory creation under `~/aiden`, with readable random three-word names such as `day-game-run`, collision retry, Ask-mode workspace persistence, and cleanup if persistence fails.
- Added focused scratch-name/directory and chat-move tests. The 22-test suite, type-check, lint, production build, and live Electron workspace search/selection checks pass.

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

### 2026-07-19 — Match branch creation action density

- Matched “Create and checkout new branch…” to the branch-row typography and compacted its padding so it stays on one line in the branch picker.
- `npm run type-check`, `npm run lint`, and `npm run build` pass.
