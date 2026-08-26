# GPUI End-to-End Parity

Status: Active | Reference: Electron `origin/features-jul30` (`1d019f3`) | Native branch: `gpui-rust`

## Goal

Make the Rust/GPUI application behaviorally and visually equivalent to the Electron reference for supported macOS workflows. A Rust module or passing unit test counts as groundwork, not parity, until the normal user path reaches it from the GPUI UI and its lifecycle is owned by the application.

## Parity rule

Each row is complete only when all four gates pass:

1. the feature is reachable through the normal GPUI workflow;
2. durable state and migration behavior remain compatible;
3. focused tests cover the user-visible contract and failure states;
4. a manual smoke or workflow-level test verifies the integrated path.

## Workflow matrix

| Workflow | Electron reference | GPUI state | Status | Acceptance check |
| --- | --- | --- | --- | --- |
| Normal coding chat | `main/services/llm-client.ts`, composer | Workspace prompt + seven coding tools + MCP + configured/filesystem Agent Skills + optional Exa web search + model-aware thinking + deterministic per-round context compaction + validated attachment replay; one-shot Ask approvals and Full/None policy | Partial | Computer use, subagents, and user-reachable Codex sign-in join the same generation owner; integrated workflow smoke passes |
| Multi-round MCP chat | Pi Agent loop | Bounded 10-round loop with ordered transcript, aggregate usage, and exact connection leases | Partial | A deterministic two-round driver/persistence harness and manual workflow smoke verify the integrated path |
| Composer controls | `renderer/components/composer.tsx` | Text/model/send/stop, native multi-file attachment picker/chips/previews, and per-model Gemini/Codex/Claude thinking effort with persisted preferences and busy-state fencing | Partial | Permission, computer-use, voice, full focus/screen-reader semantics, and remaining busy/blocked states match |
| Environment workbench | Environment/Review/Files components | Workspace/Git header only | Missing | Overview, diff review, files/editor, dirty guards, compact overlay, and focus restoration work |
| Provider auth | Provider settings + onboarding | API keys plus a boot-instantiated, process-owned exact-Pi Codex browser/device OAuth host, v2 versioned-Keychain durability, shared late-refresh reconciliation, revision-CAS, and mutation-epoch stream cancellation; no GPUI sign-in surface yet | Partial | Wire user-facing sign-in/sign-out/re-auth, surface the detection-only Electron-profile notice, refresh the picker, and complete onboarding |
| Settings | 12 destinations | 8 destinations, including configured Skills CRUD/discovery and encrypted Web Search key/enable controls | Partial | Providers, Model Data, Skills, MCP, Web Search, Computer Use, Scheduled, Aiden, Voice, Shortcuts, Appearance, About are functional |
| Onboarding | Full first-run provider/setup flow | Reduced flow with contradictory ChatGPT copy | Partial | Every presented choice works and permissions/privacy copy reflects actual runtime capabilities |
| Scheduled tasks | Runtime, Run Now, history, notifications | CRUD UI; Run Now is a placeholder | Partial | Scheduler starts with app, runs now/on cron, records history, notifies, and shuts down cleanly |
| Subagents | Normal-chat tool + live supervisor/panel | Crates exist; chat does not spawn; app uses memory source | Partial | Chat can spawn/manage runs and panel projects the durable live store |
| MCP configuration | stdio/http/SSE, OAuth, presets | stdio CRUD/test only | Partial | All transports, headers, OAuth lifecycle, presets, edits, and reset paths work |
| Dictation/voice | Composer mic, global shortcut, model manager | Pill works only with preinstalled model; shortcut is in-app | Partial | Fresh install can acquire a model; composer and global shortcut work outside app focus |
| Usage/profile | Name, ranges, share PNG | Fixed 30-day usage view | Partial | Editable identity, range selection, and local share export match |
| Command system | 25 effective bindings | 5 hardcoded runtime bindings | Partial | Every advertised binding controls its command and updates transactionally |
| Native lifecycle | Single instance, scheduler, updater, close guards, cleanup | Window boot only plus partial services | Partial | App lifetime owns every service and clean shutdown/second-launch/update flows pass |
| Transcript | GFM, code/copy, math, attachments, reasoning | Generic Markdown/reasoning plus bounded attachment images/file chips and attachment-only turns | Partial | Tables, code copy/highlighting, math fallback/renderer, selection, and streaming reveal match |
| Responsive/accessibility | Resizable/collapsible split, compact layouts | Fixed sidebars | Partial | Minimum window, compact navigation, keyboard/focus, reduced motion, and screen-reader labels pass |

## Delivery phases

### Phase 1 — truthful baseline and runtime correctness

- Keep this matrix and the plan index current.
- Replace single-follow-up MCP behavior with a bounded protocol-correct loop.
- Add workflow-focused seams and tests before expanding UI.

### Phase 2 — core coding-agent path

- Route normal chat through the Rust agent runner and one generation owner.
- Wire coding tools, system prompt, context compaction, workspace permission, approval bridge, attachments, thinking level, MCP, skills/web search, computer use, and subagents.
- Wire usable Codex authentication.

### Phase 3 — composer and environment workbench

- Complete composer controls and attachment lifecycle.
- Add Environment overview, Review, Files/editor, mutation guards, responsive overlay, and focus restoration.

### Phase 4 — settings and onboarding

- Deliver all 12 settings destinations and complete MCP/provider/voice flows.
- Make onboarding behavior, migration, permissions, and privacy copy match the connected runtime.

### Phase 5 — background/native lifecycle

- Start scheduler and durable subagent sources.
- Connect the full command system, global shortcuts, single-instance behavior, updater/install, notifications, menus/tray, close guards, and bounded shutdown.

### Phase 6 — profile, transcript, and release verification

- Finish profile/share and transcript rendering.
- Run responsive, accessibility, visual, migration, packaging, and end-to-end workflow gates.
- Mark the port complete only after every matrix row is Complete or explicitly removed from the product scope by a recorded decision.

## Current phase

Phase 2 is active. Phase 1 established the truthful baseline and bounded protocol-correct tool loop. The first Phase 2 slices now expose workspace-scoped read/list/glob/grep/edit/write/command tools, a generation-pinned Agent Skills registry, optional Exa web search, per-model thinking controls, Electron-compatible outbound context compaction, and the frozen Electron attachment lifecycle in normal chat. Attachment selection is native multi-file picker only (the Electron baseline has no drop/paste contract): reads are bounded/cancellable, admission is canonical and aggregate-capped, the user turn is durable before provider I/O, model vision is generation-pinned, history replay preserves text/image order, retry never duplicates bodies, and transcript rendering uses bounded decoded-image caches. The registry combines configured skills with bounded, symlink-safe discovery from compatible global and workspace folders; the native Skills settings destination supports configured create/edit/enable/remove and separately previews discovered entries as read-only. Web Search is off by default, stores its key in the machine keychain, snapshots enablement plus the usable key coherently for each generation, bounds requests/responses, and redacts reflected credentials from model-visible failures. Thinking preferences are capability-filtered and generation-pinned; Gemini/Codex/Claude defaults and effort lists match the Electron contract, Anthropic adaptive/budget payloads are model-aware, and Claude/Codex raw reasoning stays out of the transcript while timeline timing remains. Before provider I/O, the generation validates the exact pinned prompt/tool/model capacity; every provider pass transforms only a disposable transcript copy, keeps tool-call/result pairs intact, and disables tools on the recovery fallback without mutating or persisting compacted history. The prompt reports the generation's managed or detected Git branch, pins the prompt/provider/workspace/MCP connection for the generation, and gates every Ask-mode mutation with a one-shot inline approval. Cancellation fences staged file commits, kills command process groups, and terminalizes persisted timelines. Tool-only activity is retained, and multi-pass text/reasoning is separated consistently in live and persisted output. Codex now has a boot-instantiated, process-owned exact-Pi browser/device OAuth host layered over the v2 versioned-Keychain document, durable orphan cleanup, shared late-refresh reconciliation, atomic dispatch epochs, and stream cancellation on credential mutation; the host is invisible and production still lacks sign-in/re-auth UI plus the legacy-profile probe. Computer Use now has an internal exact-schema controller, hardened settings/status/host foundations, and a fresh-verified production runtime composition: subprocess environments are explicit and secret-free, probes and launches are caller-drop/panic safe, helper validation is repeated per host request, shutdown seals admission and shares an idempotent completion, and temporary resources are drained. It deliberately remains unavailable until the GPUI app owner, provider content-block loop, approval surface, settings/composer gates, packaging, and TCC acceptance land. The larger unified agent path remains partial until those Computer Use layers, subagent host orchestration, user-reachable Codex auth, and an end-to-end deterministic driver/persistence harness land.
