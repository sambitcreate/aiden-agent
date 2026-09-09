# Desktop multi-host control

Status: Active — outbound connection foundation implemented; full multi-host experience incomplete; UI proposal approved on 2026-09-09.
Date: 2026-09-09
Source baseline: `e42b147925e0d6ecbe050687eeb272e2e841233e`.

## Intended outcome

Any Aiden desktop can act as the user's control surface for its own work and multiple paired Aiden installations. Chats, providers, tools, files, and execution remain authoritative on their originating host. The client aggregates authorized views and sends actions to that host. A machine can be both client and server; no permanent primary machine or central account is required.

The requested experience includes remote chat discovery and filtering in the existing sidebar, a subtle globe on remote chats, live Aiden activity and control, new chats on another host, and a composer host selector followed by that host's workspace/folder selection. macOS and Linux share the protocol; supported actions depend on host capabilities.

The user authorized implementation and a PR on 2026-09-09 after three GPT-5.6 Sol Medium exploration lanes and two GPT-6 Astra Medium planning lanes. The user approved the Connections/sidebar/composer proposal on 2026-09-09; material departures still require signoff. The first implementation slice is documented below.


## Implementation checkpoint — 2026-09-09

Implemented in this branch:

- Main-process outbound registry with encrypted atomic storage, pinned HTTPS, authenticated installation identity, independent host dispatch and bounded request/queue limits.
- Desktop pairing from the canonical QR payload and manual-payload cryptographic decoder. Mac/Linux client classifications preserve existing grants. Manual bootstrap network acquisition is not yet wired.
- Typed IPC for paired-host management and a closed set of existing remote API operations, with document cancellation and credential-free renderer views.
- Bounded HTTPS JSON and SSE framing. Stream subscription IPC, replay/reconnect reconciliation and renderer consumption remain outstanding.
- Focused transport/registry tests, including real Remote API pairing over HTTPS, native manual crypto fixture, persistence failure, shutdown, cancellation and host isolation.
- An interactive [Connections and sidebar proposal](../design/desktop-connections-proposal.html), using sample data only, approved by the user on 2026-09-09. It is not production UI.

Not implemented: multi-host sidebar aggregation/filtering, ChatPane adapter and host-scoped cache migration, production host/folder selector, cross-origin live run observation/control, terminal leases, remote Environment surfaces, onboarding, and Linux combined-branch validation. Existing remote stream ownership checks and grants remain unchanged. This foundation alone does not deliver desktop-to-desktop chat control in the app.

Validation: TypeScript, lint, production build, remote contract/service suites and focused Android client tests pass (one legacy-port test skipped because port 65535 was occupied). The physical-iPad XCTest attempt failed before execution because Xcode could not mount the developer disk image; simulator use is prohibited by ios/AGENTS.md. Two fresh-context adversarial/security reviewers examined the foundation; their protocol, idempotency, document-lifetime, pairing-lock and shutdown/cancellation findings received fixes and regression coverage.

## Existing foundations and gaps

| Area | Existing source and behavior | Required change |
| --- | --- | --- |
| Reachability and trust | `main/services/aiden-remote-service.ts`, `aiden-remote-pairing.ts`, `aiden-remote-tls-identity.ts`, `aiden-remote-tailscale.ts`; per-device credentials, pinned LAN HTTPS, Tailscale route, one-use QR/manual pairing | Desktop outbound client and encrypted paired-host registry; broaden mobile-only client classifications compatibly |
| Mobile client precedent | `ios/AidenOnTheGo/Models/AidenInstallation.swift`; Android installation store and remote client | Reuse installation identity, activation leases, rollback, pinning, bounded decoders, and reconnect semantics |
| Chat discovery | `main/services/aiden-remote-chats.ts`; feature-negotiated, transcript-free summaries, 100 default/200 maximum per page | Multi-host aggregation and event-driven invalidation; no full-transcript list polling |
| Chat execution | Existing atomic idempotent remote turn admission, SSE, attachments, cancellation and approvals | Normalize local and remote operations behind one desktop session interface |
| Observe another origin | `aiden-remote-streams.ts:592` restricts streams to their creating device; `chat-generation-owner.ts` distinguishes renderer/device ownership | Separate host-run observer and controller authority, including locally initiated work |
| Desktop state | `renderer/lib/ipc.ts`, `queries.ts`, `workspace-context.tsx`, `renderer/main/chat-pane.tsx` use local APIs and bare IDs | Host-scoped references, routes, caches, drafts, async leases and action dispatch |
| Composer/sidebar | `renderer/components/composer.tsx` has static Local text; `chat-sidebar.tsx` already has workspace/recent projections and search | Approved host selector, host filter, remote indicator and source-aware actions |
| Files and Git | Existing authenticated workspace/browser/file/Git endpoints | Adapt existing surfaces; never pass remote paths to local APIs |
| Terminals | `main/services/terminal.ts`, `main/handlers/terminal.ts` bind PTYs to renderer documents | Host session ownership, attach/control leases, resumable output and dedicated grants |
| Browser/subagents | Existing desktop Environment surfaces; remote API does not provide full parity | Explicit per-surface remote contracts or visible capability limitations; no implicit local execution |

Ordinary chat summaries exclude reserved Assistant records and Bot homes. “All chats” must account for existing conversation areas and their grants; it must not silently mean only regular chats or expose internal child transcripts.

## Linux evidence

Live branch investigation on 2026-09-09 found:

- [PR #71](https://github.com/sambitcreate/aiden-agent/pull/71), `6a397578cb2f127284ef17d1b12359ef47d77022`, open and conflicting with current main. The branches have 178 main-only and 222 Linux-only commits. Its earlier successful checks do not validate today's combined state.
- [PR #89](https://github.com/sambitcreate/aiden-agent/pull/89), `e0f4836667316d9921ab91d02985ac30f0b6a102`, draft follow-up with failing Linux/verification checks at inspection. It includes Wayland Vulkan and Tailscale operator-error handling.
- The branch contains AppImage/deb/rpm support for x64/arm64, X11/Wayland handling, Linux credential-store safeguards and Tailscale executable discovery. Inspect its `docs/linux.md` and `main/services/host-platform-capabilities.ts` during integration.
- Its capability gates disable Bots, computer use, Apple Foundation Models, accessibility paste, hold-to-talk dictation and some native integrations. Do not advertise them merely because a Mac controller supports them.

Build the protocol/platform seams against current main. Validate against an isolated combined Linux checkout before declaring Linux support. Branch reconciliation is a dependency, not an already completed deliverable.

## Backend architecture decisions

### Host identity and dispatch

- Use authenticated server `instanceId` as remote identity. Display name and endpoint are mutable metadata, not identity. Local execution has a stable adapter identity; reject accidental pairing back to the same installation.
- Every chat, workspace, run, terminal, attachment, browser/artifact reference, query, draft and navigation selection carries `{hostId, resourceId}`. Include host identity in persisted UI state and event envelopes.
- Place a typed host router and remote connection manager in Electron main. The renderer gets safe metadata and typed operations; it never receives bearer credentials or implements trust exceptions.
- Retain the local IPC fast path through the same interface. Do not send local actions through HTTP. Adapt one ChatPane rather than creating separate local and remote chat products.
- Capture host identity when an operation starts. Switching selection cannot retarget it. Fence late responses with connection/activation generations and cancel obsolete reads.
- Sidebar filter, selected conversation host and new-chat composer host are separate state. Never implement a global IPC destination toggle: it would also retarget unrelated windows, delayed mutations and local Settings.
- Existing chats remain host-bound in the recommended baseline. Selecting another host affects a new chat context; migration, replication and automatic failover require separate requirements.
- Model selection, skills, tools and workspace permissions come from the execution host. Never substitute a similarly named local provider or copy inference credentials.

### Connections and security

- Reuse LAN/Tailscale and current manual pairing first. Tailscale supplies reachability; Aiden's revocable credential still authorizes each request.
- Persist credentials through the platform credential abstraction; Linux must reject insecure plaintext fallback. Publish a paired registry entry only after credential persistence succeeds, with rollback on failure.
- Validate canonical endpoints, TLS identity, response bounds and negotiated features. Do not forward authorization across redirects or automatically replace a changed server identity.
- Pairing direction is explicit: A controlling B does not authorize B to control A or C. Outbound connection enablement is separate from inbound Remote Access enablement.
- Keep protocol v1 endpoints and existing mobile grants intact. Add negotiated host observation/control/terminal capabilities; neither client type nor an old broad chat grant silently implies new authority.
- On old hosts, use existing supported reads/actions and explicitly identify unavailable capabilities. Never simulate host-wide control by weakening device-owned stream checks.

### Live work and control

- Add a host-run registry fed by the main-owned runtime lifecycle. Include local desktop and paired-device origins; inventory Bot, schedule, Telegram and child-run paths so visible activity is complete within granted conversation scope.
- Keep generation ownership separate from observation and control. New host-level observers receive safe projections; controllers send commands validated against current grants, run identity, revision and original owner.
- Preserve current stream device checks. Do not forge a renderer owner or convert another device's credential into the controller's authority.
- Stop and approval decisions require atomic race handling. Repeated requests use the same idempotency identity; conflicting approval decisions resolve once. Host-only approvals remain host-only unless their exact policy is deliberately extended.
- Disconnection detaches the view and does not cancel a running turn. Revoking an observer removes its authority without cancelling unrelated local work. Restart reports actual interrupted/recoverable state and never retries inference automatically.
- Add resumable host metadata events with epoch, sequence and a snapshot watermark. A journal gap triggers an explicit bounded resync; opening the snapshot and subscription cannot lose intervening changes.

### Terminals and process meaning

The proposed baseline covers Aiden-managed work: chat runs, parent/subagent activity and interactive terminals. Arbitrary OS process management is a separate scope decision.

Terminal scope remains pending the user's answer. The existing remote security contract explicitly excludes generic remote terminals/client-authored shell execution. Including interactive terminals therefore requires a deliberate new capability, updated threat model and version-negotiated contract; existing chat grants cannot acquire shell authority implicitly.

- Introduce host-owned terminal sessions with local and remote attachment adapters. Maintain workspace and grant validation before input/resize/close operations.
- Define a single input/resize controller lease; additional authorized clients can observe. Lease loss, transfer and competing input need deterministic behavior.
- Keep sequence-numbered bounded output, replay-gap signals, input/output byte limits, per-host/per-device caps and slow-consumer backpressure.
- Disconnecting a client does not kill its remote PTY. Session close, explicit stop, expiry policy, revocation and host shutdown have separate tested semantics. Output history is not a surviving process after reboot.
- Add safe subagent summary/control operations through the existing coordinator if required by the signed-off scope; do not expose private child prompts, credentials or journals.

### Full surface audit

| Surface | Routing and scope requirement |
| --- | --- |
| Chat history, search, rename, delete, archive, retry/edit | Host-qualified reads/actions with complete pagination; enumerate actual supported remote operations before enabling controls |
| Composer, models, skills and tools | Execution-host inventory and authority; atomic remote start; host-qualified drafts and attachment staging |
| Runs, approvals and structured questions | Host-run discovery, audience-safe projection and exactly-once decisions; some sensitive questions/approvals may remain host-only |
| Subagents | New scoped coordinator adapter for agreed status/stop/retry/steer behavior, preserving mobile's exclusion of child internals |
| Files, Git and artifacts | Existing file/Git contracts plus authenticated bounded artifact retrieval; local download/preview is an explicit client action, never remote-path interpretation |
| Terminal | New session ownership, observation, writer arbitration and security contract as described above |
| Browser tabs | Existing `WebContentsView` is local native UI. Remote folder browsing is unrelated. Viewing/controlling a remote browser requires a separate capture/input design; do not promise parity or quietly open a local tab as if remote |
| Bots and schedules | Reuse existing APIs where advertised, preserve separate product areas and host-specific availability; include their runs in authorized observation |
| Settings | Appearance/shortcuts/connections remain client-local. Execution settings belong to the selected host; full remote Settings administration needs an explicit scope decision |
| Voice, computer use and native integrations | Capability-gate by actual execution host. Remote screen control and host microphone access are not implied by chat control |

The complete first-release action matrix must be reviewed before UI implementation. An unsupported action needs approved treatment rather than a silent local fallback. Remote browser viewing and full remote Settings administration are unresolved scope, not hidden implementation promises.

## UI signoff inventory

The user supplied three Connections Settings screenshots as visual direction. Reuse their separation between inbound and outbound control, compact device rows, status, Add, toggles and revoke/reconnect actions, adapted to Aiden's settings system. Use platform-neutral wording where appropriate. SSH and keep-awake are pictured but are not automatically included features.

| Decision | Proposed direction, not signed off |
| --- | --- |
| Settings organization | Connections with Control this device and Control other devices; decide whether to rename/relocate Remote Access |
| Sidebar | All authorized hosts in the existing workspace/recent projection with a host filter; exact default/filter placement pending |
| Remote marker | Small soft-colored globe on remote chat rows; placement, tooltip/accessibility name and duplicate host names need approval |
| Composer | Turn existing Local label into host selector; show the selected host's workspaces and folder browser |
| Host changes | Existing chat stays host-bound; decide whether unsent text follows the user or each host restores its own draft |
| Offline/reconnect | Cached content remains identifiable as stale; mutations unavailable; approve presentation and retry/re-pair states |
| Process/control scope | Confirm Aiden-managed terminals/subagents versus arbitrary OS processes, and authority over work started elsewhere |
| Conversation areas | Confirm whether “all chats” includes Bots and Assistant in their existing surfaces; maintain conversation access boundaries |
| Optional features | SSH, keep-awake, chat migration, remote screen control and headless daemon are separate decisions |
| Environment scope | Confirm remote browser viewing and full remote Settings administration separately from Aiden run/file/Git control |

Before implementation, provide concrete mockups of Settings, sidebar/filter, composer/folder selection, and offline/capability states for user signoff. Follow `docs/design-guide.md`, `docs/settings-design-system.md`, `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. Preserve semantic tokens, shared action shapes and focus behavior. No new UI is implied approved by this plan.

## Delivery sequence and gates

1. **Contract and surface inventory.** Freeze host/resource identity, operation coverage, ownership, capabilities, recovery and numeric resource limits. Map every action reachable from a remote chat. Record approved UI scope separately. Exit: explicit supported/unsupported surface matrix and old-client compatibility fixtures.
2. **Desktop connection core.** Implement encrypted registry, pairing, bounded HTTP/SSE client, main-process routing and activation leases. Exit: two test servers with colliding IDs, pin/revocation failures, connection switching and interrupted pairing pass without renderer secrets.
3. **Local adapter and remote chat vertical slice.** Refactor existing local behavior behind host interfaces, then connect summary/detail/model/workspace reads and atomic create/send/cancel/approval flows. Exit: same ChatPane handles both adapters; no reachable action silently runs on the wrong host.
4. **Host-wide live work.** Add runtime observation, metadata feed, explicit cross-origin control and authority races. Address stream persistence amplification in this slice. Exit: a locally started run on B is observed and controlled from A with correct grants; legacy clients retain their isolation.
5. **Environment parity.** Integrate remote files/Git/attachments/artifacts and agreed subagent/terminal contracts. Exit: signed-off process scope works, remote resources never open through unintended local handlers, all unsupported surfaces have approved capability treatment.
6. **Approved UI and onboarding.** Implement the approved Connections, selector, sidebar and state designs over completed backend contracts. Update onboarding and the data-driven tour with a dedicated optimized transparent 1024×1024 illustration only when the feature ships; approve illustration/UI beforehand.
7. **Combined platform acceptance.** Integrate with the reconciled Linux branch and test Mac↔Mac, Mac→Linux, Linux→Mac and Linux→Linux, including a client that also serves another peer. Exit: functional, security, recovery, performance and packaged operator evidence pass.

These are implementation milestones, not permission to call the first remote chat demo complete. Host-wide observation/control and agreed Environment support are part of the requested outcome.

## Efficiency requirements

- One shared lightweight host feed per enabled connected host, not one stream per sidebar row. Share main-process connections between windows/surfaces. Fetch detailed transcript/run/terminal content only while needed.
- Use paginated summary indexes, bounded caches and bounded concurrent host refresh. Never scan transcript files to fill sidebar metadata or recursively crawl folders on host selection.
- Disabled connections generate zero traffic. Suspend detailed hidden-view subscriptions; foreground reconnection is coalesced with exponential backoff and jitter. Retain only lightweight background notifications required by the approved behavior.
- Bound cache bytes, detailed subscriptions, queues, active hosts, requests and replay retention explicitly before implementation. Slow consumers cannot grow host memory without limit.
- Current remote stream storage clones/persists growing snapshots during event append. Fix or amortize this before multi-host load; flush durable control/terminal boundaries and preserve idempotency/recovery. Document bounded RAM-only text replay loss if batching is chosen.
- Current full chat response has a 1 MiB cap. Add feature-negotiated bounded transcript paging/recent-window reads for large desktop histories; do not simply lift the global response limit. Preserve legacy endpoints.
- Batch token rendering and metadata invalidations. Do not poll full chat bodies, launch per-chat Git watchers or repeatedly enumerate providers while merely showing remote status.
- Measure production-equivalent local-only and 1/5/10-host cases: startup, idle CPU/wakeups, memory after eviction, wire bytes, disk bytes during streaming, metadata freshness and slow-client recovery. Set numerical baseline-relative release budgets from those measurements; do not invent hardware performance claims.

## Verification matrix

- Register new tests in `package.json`; run focused remote/protocol/router/stream/pairing/workspace/terminal/sidebar/composer suites and normal required checks during implementation.
- Update normative API docs/schema/shared fixtures and inspect/test both Swift and Kotlin consumers for shared contract or transcript/activity changes. Old grants and strict decoder behavior must remain valid.
- Two servers with identical chat/workspace/provider names and IDs; rename host; same host at a verified alternate address; self-pair; A→B→A late responses; forget/revoke then re-pair.
- Local-owner, remote-owner, Bot/schedule/Telegram origin coverage as authorized; observer-only denial; cross-owner stop; two-controller approval races; host-only approval restrictions; revoked subscriptions and attachment handles.
- Lost acknowledgement and same-key retry without duplicate turn; no offline mutation queue that silently runs later; host crash; sleep/resume; journal gap; terminal detach, replay/backpressure, lease conflicts and restart truthfulness.
- Remote root policy changes, symlink replacement, expired handles and revision conflicts; attachments upload to the chosen host; paths/artifacts/browser actions cannot cross host boundaries.
- Existing local-only behavior remains unchanged when no peers are configured. Confirm Quick View/Environment state stays separate and source-scoped.
- Packaged real two-machine LAN and Tailscale checks, then combined Linux X11/Wayland and secure credential-store checks. No claim of Linux completion from separate historical CI.

## Work performed for this plan

Source and live branch investigation only. No implementation, deployment, branch checkout, or functional test run. Updated this plan and its index, and logged the missing project-memory directory and agent handoff friction in `.papercuts/troubleshooting.md`.
