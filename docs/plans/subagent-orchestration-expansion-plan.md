# Subagent Orchestration Expansion

Status: In progress. Phases 0–6 and the production-inert Phase 7A durable
background lifecycle core are complete; Phase 7B activation is next.

Spec date: 2026-08-05.

## Goal

Evolve Aiden's safe foreground, fresh-context, read-only children into a native
orchestration system with:

- app-lifetime background agents;
- bounded nested delegation;
- explicit fresh or forked conversation context;
- attended write, shell, web, and exact MCP access;
- durable tree history, controls, approvals, and recovery;
- correctness and release gates that cover the complete Subagents feature.

The implementation remains Aiden-native. It uses embedded Pi `Agent` instances
inside Electron main and does not transplant `pi-subagents`' CLI processes, TUI,
session files, or headless permission behavior.

## Reference baseline

- Aiden baseline: `5bf327fea027408512db6a9a68b09f1baa06d554` on
  `features-jul30`.
- Comparison baseline: `nicobailon/pi-subagents` `main` at
  `6209b8b035f02d031f23f160840131719f115d51`, refreshed 2026-08-05. The
  original triage used 0.40.0 plus `2c78197d3af4d0b361d5647bf2ac37864a256a21`;
  the current 0.41.0 range adds live foreground/background wait progress and
  cross-repository orchestration guidance. It strengthens the later status and
  background UX target without changing the authority-first phase order.
- Existing V1 remains readable throughout rollout. It represents a root,
  foreground, fresh-context, read-only run with no descendants.
- `AIDEN_SUBAGENTS_ENABLED=0` remains the whole-feature emergency rollback.
  Every newly privileged capability also receives an independent rollout flag.

## Non-negotiable invariants

### Authority

The model may request capabilities but cannot grant them. Effective child
authority is always the positive intersection:

`root grant ∩ parent ceiling ∩ role policy ∩ rollout policy ∩ workspace authority ∩ user grant ∩ remaining tree budget`

- Unknown versions, roles, tools, grants, and fields fail closed.
- A descendant may only preserve or narrow its parent's effective authority.
- Workspace Full permission is an upper bound, not automatic child consent.
- A grant binds the tree, run, parent, chat, renderer owner, workspace identity
  and revision, provider/model fingerprint, context revision, tool identities,
  expiry, and resource budgets.
- One-shot approval binds the exact child tool-call ID, canonical argument
  digest, and current authority revision. Replay, mutation, cancellation,
  navigation, configuration drift, or cross-child use invalidates it.
- Privileged tools are built positively after authority resolution. Children do
  not receive ambient parent tools, credentials, or the app process environment.

### Data flow

- Workspace read plus network egress is a combined exfiltration capability, not
  two harmless independent grants. It needs explicit combined consent.
- MCP grants bind exact server IDs, connection fingerprints, tool names, schema
  hashes, and effect classifications. Unknown tools are treated as mutating.
- Web and MCP credentials remain inside host-owned proxies and never enter child
  context, snapshots, errors, or logs.
- Shell is presented as host-wide authority unless an enforceable OS sandbox
  proves narrower filesystem, process, environment, and network boundaries.

### Lifecycle

- Root stop, chat deletion, workspace mutation, permission downgrade, authority
  revocation, and app shutdown reach every managed descendant and active tool
  call. Foreground arbitrary shell owns and drains one process group, but macOS
  cannot guarantee recovery of a command that deliberately creates a new
  session and daemonizes; exact approval and terminal state disclose this
  exception and never claim full process-tree containment or rollback.
- Active and queued limits are global and bounded before any `Agent` is created.
- Tree budgets cover depth, launches, active/queued work, wall time, turns, tool
  calls, tokens, output, and network operations and reserve atomically.
- Background initially means continuing while Aiden is open. App quit reconciles
  unfinished work to `interrupted` unless a later phase proves a safe resumable
  descriptor; it never implies that work survived quit.
- A detached run never waits invisibly for approval. Privileged background work
  is approved before detachment or transitions visibly to `needs_attention`
  without executing the effect.
- Execution success, effect completion, cancellation, and unknown-after-crash
  remain distinct states.

### Privacy and persistence

- Forked context is an immutable, bounded projection of one exact persisted chat
  revision. It excludes reasoning, signed thinking blocks, approval payloads,
  orchestration/control messages, prior subagent calls/results, raw tool payloads,
  secrets, and unsupported attachments.
- Renderer projections remain bounded, owner-checked, versioned, and sanitized.
  Private manifests may contain hashes and fingerprints but never credentials.
- V1 exact parsers are not weakened. V2 uses a dispatcher and migration layer,
  dual-reads V1/V2, writes V2 only after the migration gate, and preserves the
  prior file when migration cannot be proven safe.

## Model-facing contract direction

The launch contract becomes explicit rather than inferring authority from a role:

- `execution`: `foreground | background`;
- `context`: `fresh | fork`, defaulting to `fresh`;
- `capabilities`: positive requests for workspace read, workspace write, shell,
  web, exact MCP server/tool scope, and delegation;
- `tasks`: role, label, task, and optional narrower capability/context choices;
- management actions: status, wait, stop, retry, and steer, each owner-checked and
  bound to opaque run IDs.

`fork` is selected when the user asks for it or the delegated task depends on
conversation decisions that cannot safely be restated. Reviewers and scouts stay
fresh by default. Failure to capture or sanitize the requested revision is an
explicit error; Aiden never silently substitutes fresh context.

New writer/research roles are presentation defaults only. Role names never grant
authority. Capability resolution remains the sole authority boundary.

## Runtime direction

- Replace flat generation ownership with a tree authority object containing
  `treeRootId`, `parentRunId`, `depth`, immutable ceilings, budgets, and one root
  cancellation controller.
- Use depth `0` for the parent generation, `1` for direct children, and `2` for
  one nested grandchild level. The first nesting release stops at depth `2`.
- Refactor concurrency so a parent waiting in its delegation tool does not hold
  the only local/hosted execution lease needed by its descendant. Admission must
  be inference-aware or hierarchically re-entrant without allowing parallel
  siblings to bypass deployment limits.
- Persist private launch/effect manifests separately from renderer-safe snapshots.
- Preserve deterministic task ordering while allocating bounded result space
  fairly to every child and every nested branch.

## Delivery protocol

Every phase follows the same mandatory loop:

1. Implement only the phase scope and focused tests.
2. Run the phase's focused type, lint, unit, integration, UI, and package gates.
3. Send the exact diff to two fresh independent reviewers: one
   runtime/security/lifecycle lane and one contracts/UI/testing lane.
4. Fix every evidence-backed blocker.
5. Repeat with two fresh reviewers until both return clean verdicts.
6. Update this plan, `docs/plans/README.md`, and project memory before advancing.

Broad passing tests do not overrule a credible blocker. A phase is not complete
until its rollback flag and migration behavior are also proven.

Run-specific override (2026-08-05): after the first Phase 5A independent review
and its complete correction loop, the user explicitly stopped further review-
subagent delegation. Remaining slices continue with implementation, direct root
inspection, focused/aggregate automated gates, and correction of observed
failures, but no additional independent review-subagent waits.

## Phases

| Phase                                | State          | Scope                                                                                                                                                                                                    | Required gate                                                                                                                                                                                      |
| ------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Repair the foreground foundation  | Complete       | Context capacity/compaction, terminal-result fidelity, fair aggregation, thinking propagation, global admission cap, capability bootstrap retry, semantic chips/model visibility, CI release coverage    | Focused regressions, current Subagents suite, type-check, lint, foreground packaged smoke, two clean fresh reviews                                                                                 |
| 1. Authority and persistence V2      | Complete       | Staged versioned launch/capability/lineage/management contracts, immutable grants, control and approval cores, and lossless V1-to-V2 migration; no production activation or new tools                    | Parser/property tests, replay/drift/cancellation tests, migration/rollback fixtures, bounded privacy audit, two clean reviews                                                                      |
| 2. V2 activation and forked context  | Complete       | Wire main-owned authority/store/control into foreground children, add rollback flags, then exact chat revision capture, sanitization, independent parallel forks, compaction, and fresh/fork UI metadata | Production reachability/rollback tests, concurrency capture, secret/signed-thinking corpus, tool-history stripping, small-context tests, two clean reviews                                         |
| 3. Foreground outbound reads         | Complete       | Host-proxied bounded web, then classified read-only MCP; explicit read-plus-egress consent                                                                                                               | Abort/timeout/redirect/byte ceilings, credential non-disclosure, fingerprint/schema drift, prompt-injection and exfiltration tests, two clean reviews                                              |
| 4. Foreground write/edit             | Complete       | Separate child mutation tools with one-shot approval and atomic verified commits; automatic dedicated-worktree creation remains deferred                                                                 | Root/path/link/race tests, conflict detection, crash-safe atomicity, exact approval replay tests, two clean reviews                                                                                |
| 5. Foreground shell and mutating MCP | Complete       | Durable external-effect journal; exact no-retry mutating MCP; signed minimal-environment host shell with truthful host-wide authority and process-group limits                                           | Crash reconciliation, config/effect drift, unknown outcomes, secret-free environment, command/cwd digest, owned-group cancellation, daemon-escape truth, flood bounds, two clean reviews per slice |
| 6. Bounded foreground nesting        | 6A–6B complete | Depth-2 trees, shared budgets/ceilings, deadlock-free scheduler, semantic tree UI, subtree stop/retry                                                                                                    | Simultaneous fan-out reservation, deadlock, escalation, root cancellation, nested ordering, keyboard/VoiceOver tests, two clean reviews                                                            |
| 7. App-lifetime background agents    | Planned        | Durable accepted/running/attention/terminal state, detach/status/wait/stop/steer, notifications and deep links; read-only first                                                                          | Crash-point reconciliation, stale lease/double launch, chat navigation, shutdown interruption, no hidden approvals, packaged UI smoke, two clean reviews                                           |
| 8. Preauthorized background effects  | Planned        | Approved dedicated-worktree writes first; separately approved egress/MCP; unsupported high-risk cross-products remain denied                                                                             | Idempotency/unknown-outcome tests, drift/revocation, crash-before/after effect, subtree cancellation, long soak, two clean reviews                                                                 |
| 9. Release and parity gate           | Planned        | Remove temporary rollout limits only after complete matrix; documentation and operator controls                                                                                                          | Full test/build/package verification, real Electron UI journey, accessibility pass, production dependency audit, 100-cycle foreground/background/nested soak, final two clean reviews              |

## Phase 0 detailed work

Completed 2026-08-05. The ordinary `npm test` path now includes the complete
Subagents suite. Focused and aggregate Subagents tests, TypeScript, ESLint,
`git diff --check`, the full 1,173-test repository suite, 32 native worktree
remover tests, and 41 Rust broker tests passed. Two fresh independent reviews
returned clean with no P0/P1/P2 findings.

1. Install the parent's resolved thinking level in every child Agent.
2. Install the same model-aware capacity assertion and context transform used by
   parent generations.
3. Treat the terminal assistant message as the child result. Intermediate turns
   remain telemetry only and cannot evict the conclusion.
4. Preserve the head and conclusion when an individual final answer is truncated.
5. Allocate the combined tool-result budget across children so every task keeps
   its identity, status, and bounded evidence.
6. Reject excess app-global children before `Agent` allocation; bound and drain
   both active and queued work. Phase 1 moves reservation ahead of any future
   privileged tool construction.
7. Make renderer capability discovery retry after transient main IPC failure.
8. Add `role="group"` to chip collections and display the effective child model
   in the inspector.
9. Put the complete Subagents suite in ordinary CI and release execution.

Exact foreground child stop/retry belongs to Phase 1's owner-bound management
contract. Phase 2 activates live foreground Stop; Retry remains hidden until the
Phase 7 app-lifetime coordinator can launch a fresh run without accidentally
creating detached foreground work. Steering remains API-only until that same
coordinator owns delivery beyond the parent tool call.
The complete packaged/browser/accessibility journey remains the Phase 9 release
gate, while Phase 0 retains the existing packaged lifecycle smoke and contract
suite.

## Phase 1 detailed work

Completed 2026-08-05. Phase 1 shipped staged, production-inert V2 contracts and
cores for strict authority intersection, owner-bound approval, exact management,
foreground control, lossless V1 migration, canonical V2 storage, and rollback
dispatch. It intentionally added no privileged tools and did not expose dormant
feature switches. The full Subagents suite, type-check, lint, and diff checks
passed; independent storage and security reviews returned clean after correction
loops for crash ordering, manifest exactness, authority drift, capacity release,
mandatory stop fences, and transactional terminal admission.

- Add a strict V2 request parser and a pure capability-intersection engine.
- Add lineage and authority revisions without exposing private IDs or fingerprints
  to the renderer.
- Add a host-owned child `beforeToolCall` broker. The broker owns canonical
  argument hashing, owner-bound approval IDs, one-shot authorization, and audit.
- Define and adversarially test exact owner-bound foreground child stop and retry
  as a main-owned control core. Phase 2 wires Stop after V2 authority,
  persistence, and renderer ownership share one production lifecycle. Phase 7
  wires Retry through its app-lifetime coordinator; it is always a new run linked
  to the prior terminal run and never reuses approval.
- Add states `needs_attention` and `stopped`; keep detachment as presentation,
  not a terminal state.
- Add exact V1 adapters and V2 store fixtures. Rollback leaves V1 history readable
  and ignores V2-only UI fields rather than deleting them.
- Add property/fuzz tests proving `effective child ⊆ parent ⊆ root`.

## Phase 2 detailed work

Completed 2026-08-05. Production now defaults to fail-closed canonical V2 with
an effective V1 rollback switch, immutable authority and capacity reservations
before launch, owner-bound durable Stop, and exact V1/V2 history projections.
Fork mode captures one persisted revision, positively projects and secret-scrubs
visible prose/validated attachments, clones independent sibling transcripts,
and compacts before the first provider request. The final aggregate gate passed
432 TypeScript tests, 8 native-store tests, 31 soak contracts, type-check, lint,
and diff checks; two independent reviews returned clean after race, rollback,
privacy, MIME, UI reachability, and partial-write correction loops.

- Activate V2 authority, persistence, approval, and owner-bound management in
  the production foreground path behind real rollback switches. No switch is
  shipped while it has no production effect.
- V1 rollback rejects forked launches explicitly and never copies conversation
  history while presenting a legacy fresh-context projection.
- Capture one persisted chat revision before launching parallel children.
- Convert only user-visible user/assistant prose into independent child message
  arrays; attachments are copied only through existing validated bounded forms.
- Strip system/control/approval/subagent artifacts and every reasoning or signed
  thinking block.
- Include the context mode and captured revision hash in the private launch
  manifest and a safe `Fresh context`/`Forked conversation` label in the UI.
- Apply static-context capacity checks before provider I/O and normal compaction
  before every subsequent child turn.

## Phases 3–5: privileged foreground tools

Phase 3 completed 2026-08-05. Foreground V2 children can now receive explicit,
independently rollbackable web and exact classified read-only MCP grants. The
host owns credentials, redirects, request/response ceilings, live authority,
shared network budgets, schema projection, effect-time approval, and credential
redaction. MCP discovery is deadline-bounded and credential-aware; authenticated
transports are remote-only and closed per operation. OAuth refresh races retain
every distinct transport-observed credential redactor behind process-keyed
deduplication and fail-closed ceilings. The final gate passed 508 scoped
TypeScript tests, 8 native-store tests, 4 isolated inventory tests, 31 soak
contracts, type-check, lint, and diff checks. Independent security and contract
reviews returned clean after the final credential-race and SSE-reconnect bounds
corrections.

### Web

- Move Exa execution behind a child-safe host proxy with `AbortSignal`, fixed
  timeout, `redirect: "error"`, request/result byte ceilings, safe error text,
  and no credential-bearing logs.
- Approve read-plus-egress when a query may contain workspace-derived content.

### MCP

- Resolve exact configured servers in main, bind connection fingerprints, tool
  identities and schema hashes, and classify each tool as read-only or mutating.
- Unknown or changed tools fail as mutating and require a fresh exact approval.

### Write/edit

Phase 4 completed 2026-08-05. Foreground V2 children can now positively request
exact `write_file` and `edit_file` authority. Every call is inspected and pinned
descriptor-relatively by a dedicated universal native helper, converted into an
immutable effect digest, displayed in a structured owner-bound approval, and
committed once only if authority, workspace revision, arguments, target
revision, renderer ownership, and workspace-operation admission still match.
Replacement recovery remains attributable and crash-preserved until verified
finalization. Unsupported symlinks, hardlinks, special files, ACLs, flags, and
unknown xattrs fail closed; the ordinary macOS `com.apple.provenance` attribute
is the sole bounded metadata exception and is copied and verified exactly.

The final gate passed 538 scoped TypeScript tests, 8 native run-store tests, 25
native mutator tests, registered inventory/write/soak pretests, five repeated IO
stress runs (60/60), type-check, lint, and diff checks. Independent security and
contracts reviews returned clean after correction loops for recovery
durability/metadata, process leaks, replay and alias races, effective read-only
ceilings, lifecycle cleanup, renderer-safe display bounds, and truthful
fresh/fork/read/write prompt copy. Automatic per-child worktree creation remains
deferred to the background-effect authority and recovery design.

- Do not reuse the current parent mutation path unchanged. Use pinned workspace
  identity, no-follow validation, atomic verified replacement, expected-content
  revisions, and conflict errors for concurrent children.
- Parent Full permission alone remains insufficient.
- Phase 4A adds a positive `workspaceWrite` request and an independent V2-only
  rollback. Requested-but-unavailable write fails explicitly; it is never
  silently downgraded to read-only.
- Phase 4B uses a dedicated main-owned native mutator for descriptor-relative
  `openat` traversal, strict no-follow regular-file checks, expected SHA-256
  revisions, exclusive create, atomic swap replacement, verification, fsync,
  and conflict/recovery preservation. Parent `fs.writeFile` tools are not reused.
- Phase 4C binds the prepared preimage/postimage effect digest to the exact
  owner-bound one-shot approval and renders a structured create/replace/edit
  approval. Deny retains initial focus; every mutation says that no command will
  run and that drift makes Aiden refuse the write.
- Phase 4D runs the complete symlink, hardlink, special-file, sibling, external
  race, cancellation, replay, crash-point, rollback, UI, and regression gates,
  followed by two clean independent reviews.
- Automatic per-child worktree creation is deferred. Phase 4 writes only to the
  exact current workspace; an already selected Aiden-managed worktree remains
  eligible and is identified truthfully in approval. Automatic dedicated
  worktrees require a separate authority, handoff/apply, cleanup, and recovery
  lifecycle and remain part of the later background-effect design.

### Shell

Phase 5 was refrozen after three independent design lanes found that the prior
three shell bullets were insufficient for either arbitrary command execution or
remote mutations. Shell and mutating MCP have separate contracts, flags,
brokers, approval cards, and activation diffs. Every slice receives the normal
focused gate and two clean independent reviews before the next slice begins.

#### 5A: shared revocation and durable effect foundation

Completed 2026-08-05. The final correction gate passed 556 TypeScript Subagents
tests, 8 native run-store tests, 25 native file-mutator tests, all registered
inventory/write/Phase-5A/soak pretests, type-check, targeted lint, and diff
validation. The completed slice includes two-sided config/credential publication
fences; immediate connect/list/call leases; strict hostile-object parsing;
native-authority digest binding; dispatch-time expiry; crash/unknown semantics;
cross-store deletion preflight; and an owner-checked bounded external-effect
projection in the native inspector.

- Add a main-owned per-server configuration epoch/abort lease. Accepted config,
  endpoint, enablement, transport, credential-account, or OAuth reauthorization
  changes synchronously invalidate the old lease before publication. The exact
  lease is checked without an `await` immediately before raw MCP dispatch. Use
  the same fence to close the existing read-lane disable/repoint TOCTOU; post-call
  drift detection remains defense in depth.
- Activate the reserved private V2 `approvals` and `effects` collections using
  strict exact parsers, identifier uniqueness, bounded cardinality, monotonic
  transitions, run/chat ownership, and digest-only evidence. Raw commands,
  arguments, responses, credentials, headers, and SDK errors are never durable.
- Persist an effect through
  `prepared → authorized → dispatch_started → completed | remote_error | cancelled_before_dispatch | unknown`.
  A durability barrier precedes process spawn or MCP request bytes. Startup maps
  leftover `prepared`/`authorized` to `cancelled_before_dispatch` and leftover
  `dispatch_started` to `unknown`; it never retries. A failed pre-dispatch
  persistence barrier prevents dispatch. A failed post-dispatch terminal write
  remains locally and visibly `unknown`.
- Project bounded sanitized effect activity and unknown outcomes through the
  main-owned run snapshot/inspector path. Chat deletion removes matching terminal
  evidence only through the existing durable tombstone lifecycle; active or
  unknown evidence cannot be silently evicted for capacity.
- Move wrong-tool outbound approval mismatch through common ledger denial and
  cleanup. This shared hardening is production-safe before mutation activation.

#### 5B: mutating MCP contracts, classification, and approval

Completed 2026-08-05 as a production-inert slice. The final gate passed the
104-test focused Phase-5B suite, the 563-test aggregate TypeScript Subagents
suite, 8 native run-store tests, 25 native file-mutator tests, all registered
inventory/write/Phase-5A/Phase-5B/soak pretests, type-check, targeted ESLint,
format validation, and diff validation. Mutation requests remain absent from
the model schema and production tool assembly; the independent mutation flag is
default-off and has no execution call site.

- Add a separate optional positive `mcpMutations` request containing only logical
  server/tool names. It is disjoint from read `mcp`, task requests can only
  narrow their root lane, stale or unavailable requests fail explicitly, and
  omission means no mutation authority. Fingerprints and effect metadata remain
  main-private.
- Classify a tool as read-only only for a structurally valid explicit
  `readOnlyHint: true`. Explicit false, absent, malformed, accessor/proxy,
  conflicting, or unknown annotations enter the mutating inventory, never the
  read lane. Destructive, idempotent, open-world, and task-support annotations
  are untrusted display/profile hints; no hint reduces approval, proves rollback,
  or enables retry. Required MCP task support remains unavailable.
- Bind authority to server ID, connection fingerprint, tool name, canonical
  input/output schema hash, `read | mutating` classification, and a recomputed
  effect-profile fingerprint. Capability intersection compares every field.
- Add strict `SubagentMcpMutationApprovalDetails` and a dedicated deny-first,
  `Allow once` card. It shows the complete safely escaped canonical arguments,
  exact logical target, digest prefixes, classification/profile, timeout, and
  fixed copy that the configured server controls the effect, data outside Aiden
  may change, rollback is unavailable, timeout/cancellation may be unknown, and
  automatic retry is disabled. Malformed details remove Allow.
- Canonical arguments are plain bounded JSON, snapshotted before asynchronous
  work, at most 64 KiB at execution and 8 KiB before safe display escaping.
  Credential redaction changing the canonical arguments is a hard denial.

#### 5C: mutating MCP execution and foreground activation

Completed 2026-08-05. The exact fresh-client, two-inspection, durable
prepare/authorize/dispatch, synchronous final-fence, single raw-call, zero-retry,
bounded-result, conservative-unknown, and production foreground activation
contracts below are implemented. The registered Phase 5C suite passes 96 tests;
the aggregate subagent gate passes 567 TypeScript, 8 native-store, and 25 native
mutator tests.

- Use a fresh isolated remote client per call; stdio MCP remains excluded because
  it is process authority. Reinspect server, connection/account revision, schema,
  classification, effect profile, and task support before and after owner
  approval. The final synchronous fence checks signal, expiry, live authority,
  config/credential lease, immutable binding, ledger, and network budget, marks
  dispatch locally, then invokes the raw SDK without another `await`.
- Durably publish `authorized` and `dispatch_started` before raw call bytes. One
  shared network-operation unit is charged at dispatch and never refunded.
  Transport/auth retries are disabled. Server-declared idempotency never permits
  automatic retry or crash replay.
- A valid response becomes `completed`/server-reported success or
  `remote_error`/server-reported error; the latter warns that partial mutation
  may still have occurred. Any post-dispatch timeout, abort, transport/protocol
  failure, malformed or oversized response, credential/config/schema drift, or
  terminal-persistence failure becomes `unknown`. Late responses cannot upgrade
  unknown. A same-effect retry after unknown needs a fresh distinct approval
  that explicitly calls out the prior unknown outcome.
- Bound raw transport, result parts, sanitized model-visible text, close/drain,
  and all credential encodings. Prefix returned server data as untrusted and use
  fixed mechanism-neutral errors.
- Activate only behind independent
  `AIDEN_SUBAGENT_CHILD_MCP_MUTATIONS_ENABLED`, V2, foreground execution, base
  MCP rollout, exact inventory, live owner approval, journal, and network budget.
  Flag-off/V1/background/stdio paths expose no mutation schema or tool and stale
  positive requests error instead of downgrading.

#### 5D: production-inert native shell broker

Completed 2026-08-05. The universal helper, framed host adapter, frozen empty
environment, canonical root binding, helper-side output caps, occupied-group
cleanup, explicit outcomes, adversarial limitation fixture, and release
build/sign/package verification are implemented without model schema, tool,
flag, UI, or runtime activation.

- Do not reuse parent `run_command`. Build and package a dedicated signed
  universal `aiden-subagent-shell-runner`. It opens the exact canonical workspace
  root with `O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`, verifies approved device and
  inode, then `fchdir`s before execution. Cwd is a proven initial directory, not
  a filesystem sandbox.
- Execute the exact bounded command with fixed `/bin/zsh -f -c`, passing command
  bytes over a framed pipe rather than argv/environment. Reject NUL, malformed
  UTF-8, over-limit input, bidi controls, ESC/C1, CR/Unicode line separators, and
  C0 controls other than LF/TAB without trimming or normalization. Command stdin
  is `/dev/null`; there is no PTY.
- Construct environment from empty state with a fixed PATH, C locale, private
  `0700` HOME/TMP/XDG directories, noninteractive Git/package-manager controls,
  disabled askpass, and no copied host HOME, proxy, provider, OAuth, MCP, Aiden,
  SSH-agent, cloud, package, Electron, Node, or dynamic-loader variables. This
  prevents ambient inheritance only; it does not stop deliberate host access.
- Enforce 512 KiB each stdout/stderr before bytes reach Electron, bounded
  head/tail model output, invalid-UTF-8 sanitization, timeout, closed file
  descriptors, fixed protocol size, and a main watchdog. Raw command/output are
  absent from argv, environment, logs, timeline, and durable state.
- Keep the helper as an occupied process-group member. Cancellation, timeout,
  output flood, parent-control-pipe EOF, app shutdown, and normal direct-shell
  exit send group TERM, wait one second, then group KILL and drain. A deliberately
  daemonized new session can escape this boundary; the tests prove the limitation
  rather than pretending containment.

The 5D helper is supervision and ambient-authority reduction, not an OS sandbox.
Its adversarial `setsid`/double-fork fixture deliberately escapes the occupied
process group, proves that such a process survives group cleanup, and then
self-cleans the fixture process. Phase 5E approval copy must retain this limit.

#### 5E: truthful shell contract and foreground activation

Completed 2026-08-05. Positive root/task capability narrowing, independent
rollback and packaged-helper gates, exact attended approval, workspace/root
revalidation, durable one-shot dispatch, bounded untrusted output, cancellation
and unknown cleanup truth, production assembly/shutdown, and the structured
deny-first approval surface are active for V2 foreground children only.

- Add optional positive root/task `shell`; omission is false and a task can only
  preserve or narrow its root grant. The child-facing tool remains
  `run_command { command }`, but it is assembled only for an effective V2
  foreground shell grant with live owner approval and packaged helper.
- Bind one-shot approval to exact command bytes, fixed shell/options, canonical
  environment profile and ephemeral directories, root path/device/inode,
  workspace and authority revisions, owner/tree/run/child/chat/tool-call IDs,
  timeout/output ceilings, rollout revision, and expiry. Revalidate before and
  after approval; consume once immediately before the durable dispatch boundary.
- Add strict `SubagentShellApprovalDetails`. Show the entire exact command in a
  bounded scrollable block, exact initial cwd/shell/digests/limits/worktree, and
  fixed copy: the command is not OS-sandboxed, has the macOS user's filesystem,
  process, system-tool, Keychain/API, and network reach, is not rolled back, sends
  output to the configured model, and deliberately detached processes may
  survive cancellation. Malformed details remove Allow; Deny retains initial
  focus and the only positive action is `Allow once`.
- Distinguish exited, signaled, timed out, output limited, cancelled, spawn or
  protocol failure, and cleanup unconfirmed. Never describe timeout/cancellation
  as rollback. If helper/group cleanup cannot be proved, return
  `cleanup_unconfirmed`. Shell does not consume the web/MCP network counter
  because one approved host command may perform unbounded network operations.
- Activate behind independent `AIDEN_SUBAGENT_CHILD_SHELL_ENABLED`. Disabled,
  V1, background, permission-none, missing-approval, or missing-helper paths do
  not evaluate the factory/broker and reject positive requests explicitly.

#### 5F: aggregate adversarial and release gate

Completed 2026-08-05. The registered Phase-5A through Phase-5E, inventory,
workspace-write, package/sign, soak, and repeated native-shell gates all passed.
The full Subagents aggregate passed 572 TypeScript tests plus 8 native store and
25 native mutator tests. The full repository gate passed 1,181 tests, 32 native
worktree-remover tests, and 41 Rust Computer Use broker tests with no failures.
Type-check, targeted lint/format, package parsing, and diff validation remained
clean. Per the run-specific user override, no further review subagents were
launched after the corrected Phase 5A gate.

- MCP matrix: every annotation shape; config/endpoint/transport/account/schema/
  effect-profile drift at every boundary; execute-then-401/500; zero automatic
  retries; timeout/abort/ignored abort; response and credential floods; crash at
  every journal transition; startup no-replay reconciliation; prior-unknown
  explicit retry; current read-lane revocation regression.
- Shell matrix: exhaustive ambient-secret corpus; rc/PATH/askpass resistance;
  cwd replacement/symlink races; exact multiline/bidi approval; closed stdin/no
  TTY; inherited-FD proof; infinite mixed output; invalid UTF-8; pipe-holding
  grandchildren; TERM-ignoring jobs; successful leader with background jobs;
  `setsid`/double-fork limitation fixture; parent SIGKILL/app quit; protocol and
  helper crash points; zombie/FD/PGID reuse soak; missing/wrong packaged helper.
- Integration/UI: effective read-only ceiling, owner navigation, permission and
  rollout downgrade, chat/workspace deletion, exact accessibility/focus, visible
  unknown outcome, V1 and independent rollbacks, packaged Electron journey,
  full Subagents/repository/type/lint/package gates, repeated process/IO soak,
  and two clean independent reviews after every slice plus the aggregate diff.

## Phase 6: nesting

### Phase 6A: production-inert nesting core

Completed 2026-08-06. Added an optional positive root/task `delegate` request
with omission false and task-narrow-only validation, while keeping the
production model schema, supervisor, persistence, renderer, and rollout surface
unchanged. The isolated core derives immutable main-session depth `0`, direct
child depth `1`, and nested child depth `2` identities, shares exact frozen
workspace/runtime/context ceilings, and permits only narrower capability and
tool ceilings. One tree-owned synchronous ledger now atomically accounts for
depth, launches, active/queued work, tokens, tool calls, wall time, and output.
Its scheduler reserves fan-out all-or-nothing and converts a waiting parent's
execution lease into a reserved resume slot, so local limit `1` and hosted limit
`2` descendants cannot deadlock. Root cancellation immediately settles public
work even when an active task ignores abort. The registered Phase 6A gate,
Subagents aggregate, type-check, targeted lint, and diff validation passed.

### Phase 6B: production activation

Completed 2026-08-06. An independent default-on/exact-zero rollback gate now
exposes the positive `delegate` schema only to eligible foreground V2 launches.
Only exact live depth-1 authorities receive a child-safe tool; fresh depth-2
authorities persist `parentRunId`, revalidate their exact parent and workspace,
reject every capability escalation, and never receive delegation.
The production scheduler and runtime both yield parent capacity while awaiting
descendants, so local concurrency one cannot deadlock. Root cancellation,
deadline expiry, and telemetry budget exhaustion cancel the scheduler and
terminalize active plus queued nested runs. Fan-out reservation is synchronous
and all-or-nothing before projection. The registered Phase 6B gate, complete
Subagents aggregate, type-check, targeted lint/format/diff validation, and
package dry-run passed.

Phase 6B defines one budget scope per generation-scoped supervisor/tree. Each
model `subagent` tool call gets a short-lived scheduler execution graph because
its exact immutable context/capability root can differ, while launches, tokens,
tool calls, output, and wall time are debited cumulatively across every call in
that generation. Repeated calls therefore cannot reset shared tree budgets.

- Only tasks with the resolved `delegate` capability receive a child-safe
  delegation tool.
- Descendants inherit the exact workspace/runtime/context ceiling and may request
  only narrower capabilities.
- One tree owns all depth, launch, token, tool, wall-time, output, active, and
  queued budgets.
- Scheduler tests must prove that local limit one and hosted limit two cannot
  deadlock when parents wait for descendants.

### Phase 6C: forked descendants and semantic inspector

Completed 2026-08-06. A depth-1 child now captures an explicit nested `fork`
at the tool boundary before releasing its inference lease: only descriptor-safe
user-visible prose and validated user images enter a bounded immutable snapshot;
thinking, tool protocol, orchestration controls, secrets, private paths, and
later transcript mutations do not. Depth-2 receives that isolated capture once,
never rereads the parent, and still cannot delegate.

The inspector now reconstructs only exact V2 parent lineage as a semantic
collapsible tree. Legacy, orphaned, and owner-mismatched records remain visible
roots. It has roving keyboard navigation, `treeitem` hierarchy metadata,
stable selection/focus across revisions, active-branch grouping, explicit
collapse with hidden-descendant counts, reduced-motion-safe transitions, and
the existing batched live announcements. A depth-1 Stop truthfully says
“Stop subtree”; a depth-2 Stop affects only that node. Retry remains absent
until Phase 7 can start a fresh app-lifetime run safely.

Focused live-fork/tree/UI tests passed 90/90. The complete Subagents aggregate,
native helper gates, TypeScript, lint, and diff checks passed after updating the
former Phase 6B schema expectation that correctly changed when nested fork
became available.

## Phases 7–8: background

### Phase 7A: production-inert durable lifecycle core

Completed 2026-08-06. A self-contained lifecycle core requires immutable fresh,
depth-1, workspace-read-only background authority and denies write, shell, web,
MCP, mutation, fork, and delegation. Acceptance is acknowledged only after an
atomic durable queued record. Revision-guarded compare-and-swap owns exact
owner/chat/workspace/revision management and every transition; bounded wait,
steering, and event ledgers cannot bypass required terminalization. Hooks run
only after durable intent, and ambiguous hook outcomes become `unknown`.
Startup reconciliation records active runs interrupted and never restarts them;
explicit stop, chat deletion, workspace revocation, and shutdown durably settle
matching work. No model schema or background executor is activated in 7A.

### Phase 7B1: canonical lifecycle storage seam

Completed 2026-08-06. Canonical V2 storage now owns a bounded private background
record beside its matching renderer-safe snapshot and native authority manifest.
Every compare-and-swap lifecycle write updates all three atomically; legacy V2
files parse with an empty background collection. Startup reconciliation appends
the bounded interruption evidence to both representations, while chat deletion
removes the paired private record in the same tombstone transaction. The 40-test
focused lifecycle/store gate and TypeScript passed. Actual coordinator/schema
activation remains the next 7B slice.

### Phase 7B2: app-lifetime coordinator core

Completed 2026-08-06. The injected coordinator accepts durably before child
allocation, keeps a detached run after its parent returns, and owns unique
admission, terminal/timeout waits, safe-boundary steering acknowledgement,
owner stop, revocation, shutdown, and no-restart behavior. It remains isolated
from Electron, model schemas, and renderer exposure until production wiring.
Focused coordinator tests passed 3/3 with TypeScript clean.

- Launch acknowledgement follows durable acceptance, not merely object creation.
- State machine:
  `queued → starting → running ↔ needs_attention → completed | failed | timed_out | stopped | interrupted | unknown`.
- Chat switching and renderer navigation do not stop detached work. Chat deletion,
  workspace revocation, explicit stop, and app shutdown do.
- Notifications supplement, never replace, persisted status. Selecting one deep
  links to the exact tree node in the Subagents inspector.
- Initial background work is read-only. Privileged background work is launched
  only after the foreground parent obtains an immutable preauthorization.
- Dedicated-worktree writes ship before background shell or mutating MCP.
- Automatic restart resume remains disabled until a later design proves safe
  executable checkpoints, leases, idempotency, and authority revalidation.

## Verification matrix

Every final gate includes:

- strict TypeScript and lint;
- all normal tests plus the complete `test:subagents` suite;
- V1/V2 parser, migration, rollback, and corruption fixtures;
- capability intersection, replay, expiry, drift, and revocation tests;
- context-window, secret corpus, prompt-injection, and exfiltration tests;
- process, filesystem, symlink, replacement, cancellation, and crash races;
- mounted production renderer components and accessibility-tree assertions;
- a real Electron journey for chips, tree, approvals, detach/navigation,
  notification deep links, restart interruption, and history replay;
- short pull-request packaged smoke, longer nightly soak, and release soak;
- production dependency audit with subagent-reachable advisories triaged.

## Alignment target

After Phase 9, Aiden should align strongly with the valuable `pi-subagents`
semantics: foreground/background execution, fresh/fork context, nesting, bounded
tree status and controls, capability ceilings, and deterministic results.

Aiden deliberately diverges where its desktop host can be safer:

- unknown tools deny rather than allow;
- shell is an explicit high-risk capability rather than passed through;
- live approvals remain main-owned and renderer-owner-bound;
- credentials and private execution artifacts never enter child context;
- background privileged effects require durable preauthorization;
- the native inspector replaces Pi's Fleet TUI and filesystem status artifacts.
