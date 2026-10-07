# Google Antigravity provider over ACP

Status: Proposed (2026-10-06, revised the same day after a T3 Code review). This is a feasibility study; nothing is implemented.

## References

Both references are MIT-licensed.

- **[`zacbemis/pi-antigravity-acp-provider`](https://github.com/zacbemis/pi-antigravity-acp-provider)**
  - Version 0.1.12, commit `07e369b`, cloned to `~/projects/opp/pi-antigravity-acp-provider`.
  - A Pi provider written in plain TypeScript. It is the best fit for Aiden's provider seam.
- **T3 Code**
  - Commit `f870c419fc`, at `~/projects/opp/t3code`.
  - Has a dedicated Antigravity driver: `apps/server/src/provider/{AntigravityInstallation,AntigravityAuth,antigravityAuthSupport,antigravityCallback,antigravityRelease}.ts`, `provider/acp/Antigravity*.ts` and `orchestration-v2/Adapters/AntigravityAdapterV2.ts`.
  - Its runtime, install, auth and protocol handling are more mature than the Pi package's.
  - It is written in Effect, so Aiden ports its behavior rather than its code.

Following the [rpiv-todo](rpiv-todo-integration-plan.md) precedent, Aiden does not load the upstream Pi extension, its slash commands, its config files or its updater.

## Verdict

**Feasible. Recommended as a hybrid native port, with lower risk than the first draft of this plan assumed. Estimated at roughly 3–4 engineer-weeks for desktop v1.**

| Layer | Source | Why |
| --- | --- | --- |
| Pi provider seam | Pi package | A pi-ai 1.0.3 `Provider` that plugs into `registerAidenBuiltinProviders` (`main/services/provider-registry.ts`). It already handles Pi stream events, binding fingerprints, effort-collapsed models, and parked MCP tool continuations that Aiden's own Agent loop executes. Against pi-ai 1.0.3 it has only 6 type errors, and all 102 of its tests pass. |
| Runtime, install, auth, protocol | T3 Code | Fixes most of what the first draft listed as gating risks: credential location, the system-Node dependency, the security boundary for file edits, flattened activity, and remote manifests. |

The desktop app cannot load Pi extensions, so a port is required in either case.

**Architecture note.** T3 runs Antigravity as an *agent harness*: it drives an entire external agent per thread, the same way it drives Codex and Claude Code. Aiden has no harness concept. Its chats run Aiden's own Pi Agent loop over model providers, so Antigravity goes in as a provider whose `streamSimple` drives an ACP session. That gives model switching, the journal, usage and Remote projection without a second chat runtime.

**Scope check.** Aiden's `google` provider already serves Gemini models through an API key. Antigravity adds subscription-billed access (Google account quotas) and Antigravity's own agent harness. If neither matters, this work is not needed.

## What T3 changes compared with the first draft

| Issue in the first draft | What T3 shows | New decision |
| --- | --- | --- |
| Tokens are kept in `~/.gemini/antigravity-acp/` | `GEMINI_HOME=<state>/providers/antigravity/<hash>` plus `AGY_ACP_FORCE_FILE_STORAGE=1`, because the macOS keychain item is otherwise shared | Use an isolated profile under `userData`; `~/.gemini` is never touched |
| A Node supervisor requires system `node` | Direct spawn in a detached process group, with SIGTERM to the group on close. Node is used only for a `BROWSER` helper and a stdio MCP bridge. | Spawn directly from main. Replace both Node uses (see D3, D8). |
| Native edits bypass Aiden | T3 advertises ACP `fs.readTextFile`/`writeTextFile`, so **T3 performs Antigravity's file I/O**, confined to cwd plus attachments with symlink-safe realpath checks. `terminal` is not advertised. | Aiden performs file I/O with stronger checks (D6). Only shell commands stay native. |
| Native activity is flattened into thinking text | A structured mapping: `execute`→command, `edit`/`delete`/`move`→file change, `search`/`fetch`→web search, plus diffs, locations, plans, `start_subagent` batches and payload bounds (8k text, 64k chars per payload, data-URI images dropped) | Adopt it (D9) |
| The author's Ed25519 manifest is fetched from GitHub | The release is pinned in source (`antigravityRelease.ts`), and every install gets a live ACP `initialize` identity check | Pin in source; no runtime manifest or registry fetch (D2) |
| The 32k-character reconstruction after rewind | `supportsConversationRollback: false`, so revert and edit-resubmit are hidden | Disable rewind and edit-resubmit for Antigravity chats (D10) |
| `session/load` restores sessions | `session/resume` is preferred, because load replays every tool call slowly. A failed resume falls back to a fresh session. | Adopt it |
| Not in the first draft | The PyInstaller one-file bundle **unpacks about 1 GB into `TMPDIR` on every launch**, and a force kill leaves it behind | Per-process `TMPDIR`, a startup sweep and a process cap (D3, D11) |
| Not in the first draft | 1.1.1 prints its sign-in URL on **stdout**, which corrupts JSON-RPC | Strip that line in a stdout transform |
| Not in the first draft | `request_permission` with a `toolCallId` starting `interaction_` is a **question**, not an approval. `allow_always` carries `_meta["agy.security.warning"]`. | Route questions to Aiden's question UI and show the warning (D7) |

**Things not to copy from T3:**

- **Auto mode auto-approves.** T3's Auto mode maps to native `default` but auto-approves via `acpOperationDisposition`, while its docs say it asks.
- **Unused code:** `AcpCoreRuntimeEvents.ts`, `preferResumeSession` and `buildAntigravityPrompt`.
- **Remote manifest fetch:** the GitHub model-manifest fetch with a one-hour TTL.
- **Unredacted keys:** API keys stored in settings as plain text.

## Upstream facts

**Runtime**
- Google's `agy_acp_server.par` speaks ACP v1. It reports `protocolVersion: 2` in a v1-shaped response, which the client has to accept.
- The `localharness_external` file must sit beside it, and `ANTIGRAVITY_HARNESS_PATH` points at it.
- Linux needs the `--uid=` argument.

**Size**
- macOS arm64: 316 MB archive, 802 MB server, 117 MB harness, about **920 MB installed**, plus about **1 GB of `TMPDIR` per running process**.
- Linux x64: 682 MB archive and a 1.88 GB server.
- **There is no Intel macOS build.**

**Versions**
- T3 pins 1.1.1. The Pi package's catalog also includes 1.2.1.

**Auth**
- Methods: `oauth-personal`, `oauth-business` (GCP project and location), `gemini-api-key` and `agent-platform`.
- The server accepts `authenticate` methods it did not list, so authenticate eagerly.
- ACP `logout` is available behind `agentCapabilities.auth.logout`.

**Models**
- Models come from the session's `model` config option. Thinking tiers are separate slugs, for example `gemini-3.8-flash-{low,medium,high}`.
- Context and usage come from `usage_update`.
- Neither reference has reliable quota limits. The Pi package reads `_meta.quota` when it is present.

## Decisions

1. **Port as a hybrid.**
   - Put it in `main/services/antigravity/`, behind `AIDEN_EXPERIMENTAL_ANTIGRAVITY`, with attribution to both MIT sources.
   - Start from the Pi package's provider, stream writer, model projection and MCP bridge. Replace its process, install, auth and event-mapping modules with ports of T3's behavior.
   - Fix the pi-ai 1.0.3 `SystemMessage` and `JsonObject` errors. The first is a real bug: a system message gets formatted as a "Tool result".
2. **Pin the runtime in source; install only on an explicit action.**
   - Store a `antigravity-release.ts` table with version, `dl.google.com` URL, SHA-256, archive size and exact member sizes.
   - Download only when the user clicks Install. Before downloading, check free space: archive plus binaries plus 256 MiB, with a warning about the per-session `TMPDIR` cost.
   - Stream the download with a byte cap and verify hash and size. Extract only the two expected members, then run a live `initialize` check (agent name, version, `loadSession`, `resume`, `logout`, `oauth-personal`).
   - Write it to `userData/antigravity/runtime/<sha>/` and commit through an atomic pointer.
   - Running processes hold a lease on the runtime, so Remove refuses while one is active.
   - New pins ship with Aiden releases, with no background checks. Add this network rule to `AGENTS.md` next to the models.dev rule.
   - An advanced custom binary path accepts an existing `agy_acp_server.par` that has the harness beside it, after the same validation.
3. **Spawn directly, never through Node.**
   - Main spawns the binary with an allowlisted environment, stripping `GEMINI_API_KEY`, `GOOGLE_*`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`, `AGY_*`, `BROWSER` and `ELECTRON_RUN_AS_NODE`.
   - It injects `GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE=1`, `ANTIGRAVITY_HARNESS_PATH`, `PYTHONUNBUFFERED=1` and a per-process `TMPDIR=userData/antigravity/tmp/run-*`. Choose a path with no spaces or colons, because Python splits `BROWSER` on `:` and shell-splits its contents.
   - The process runs in a detached group and is stopped with SIGTERM, then SIGKILL after 1 s.
   - Aiden adds what T3 lacks: a pid ledger and a startup sweep of orphaned processes and `run-*` directories.
   - Aiden's packaged fuses set `runAsNode: false`, so T3's `ELECTRON_RUN_AS_NODE` helpers cannot run. The `BROWSER` hook is a tiny `/bin/sh` script; Aiden ships on macOS and Linux only.
4. **Isolate the profile.**
   - `GEMINI_HOME=userData/antigravity/profile` (mode 0700), with `settings.json` rewritten on each launch and no credentials in it.
   - Aiden sign-out calls ACP `logout` with admission closed and all processes stopped, then clears the profile.
   - v1 does not symlink user skills from `~/.gemini`. That stays a later opt-in.
5. **Sign in through the existing provider auth flow.**
   - The `BROWSER` shim writes the URL to stderr, where Aiden strictly validates it: `accounts.google.com/o/oauth2/v2/auth`, a single state, `response_type=code`, and a loopback `redirect_uri` on port 1024 or higher.
   - Aiden emits the existing `providers:auth` `auth_url` event and opens the URL with `shell.openExternal`. The agent never opens a browser itself.
   - Strip the stdout sign-in line.
   - Confirm sign-in only after `session/new` lists models.
   - Map `SUBSCRIPTION_REQUIRED` and `access_denied` to specific messages.
   - Keep a callback-paste fallback, ported from `antigravityCallback.ts`.
   - v1 offers Google sign-in only. Enterprise and Vertex can come later; API-key users already have the direct `google` provider.
6. **Aiden performs all file I/O.**
   - Advertise `fs.readTextFile` and `fs.writeTextFile`, not `terminal`.
   - Main handles file reads and writes confined to the workspace and attachment roots, using realpath and final-symlink checks with an 8 MiB read limit.
   - Unlike T3, Aiden also enforces its workspace permission inside the handler: Read-only or None denies writes whatever the native mode says.
   - Writes are recorded in Aiden's changed-files and checkpoint tracking.
7. **Permissions follow Aiden's workspace setting. Never default to `yolo`.**

   | Aiden permission | Native mode | Behavior |
   | --- | --- | --- |
   | Ask | `default` | Approval requests go to `ToolApprovalCoordinator` |
   | Full | `yolo` | Disclosed to the user first (U7) |
   | Read-only / None | `default` | Edit, delete, move and execute requests are auto-denied |

   - Approvals use the native options: Allow once, Allow for this chat (with the `agy.security.warning` text), and Deny.
   - `interaction_*` requests go to Aiden's `ask_user_question` UI.
   - The mode is applied through `session/set_config_option` (category `mode`), falling back to `session/set_mode`.
8. **Expose Aiden's tools over the Pi package's HTTP MCP bridge.**
   - It uses loopback with a bearer token. Bridged calls are parked and executed by Aiden's Agent loop, through `beforeToolCall`.
   - The Pi package qualified this live against Antigravity. T3's stdio bridge needs `ELECTRON_RUN_AS_NODE`, which Aiden's fuses forbid.
   - Use MCP-over-ACP when the agent advertises `mcpCapabilities.acp`.
   - Expose only tools that Antigravity does not already have: MCP servers, browser, todo, artifacts, schedules and memory. File and shell tools are left out.
9. **Map native activity to structured rows.**
   - Port T3's normalization: kind mapping; command, cwd, output and exit code; diffs; locations; plans; subagent batches; payload bounds.
   - pi-ai 1.0.3 has no content block for tools the provider executed (`nestedCalls` exists only on tool results). Native activity therefore travels through an Aiden side channel into the generation timeline, and is persisted as Aiden-owned activity records keyed to the assistant message. It must never become a Pi `toolCall`, which Aiden would execute.
10. **Antigravity owns the conversation context.**
    - Restarts use `session/resume`.
    - Mid-chat model switches into Antigravity, forks, and failed resumes reconstruct context with a token-aware budget, and the user sees a notice.
    - Rewind and edit-resubmit are disabled for Antigravity turns.
    - Antigravity's own compaction maps to Aiden's "Context compacted" row, and Aiden's compaction is deferred for this provider.
11. **Bound the cost of processes.**
    - Each process costs a cold start (up to two minutes) and about 1 GB of temp space.
    - Cap live Antigravity processes at 2 and evict idle ones after 10 minutes. The next turn resumes the session.
    - Cancel sends `session/cancel`, waits up to 15 s for the prompt to settle, then kills the process.
12. **Models.**
    - Keep the Pi package's effort collapse, so Aiden's thinking control picks low, medium or high instead of separate slugs.
    - Models come from the session's config options. The context window comes from `usage_update`.
    - Saved models are never silently replaced.
13. **v1 covers attended desktop chats only.**
    - Excluded: Bots, Telegram, scheduled runs, subagents (`subagent-inference-worker.ts` resolves only built-in pi-ai providers), Aiden Live, and Remote-started runs.
    - Those pickers show Antigravity models as disabled, with a reason.
    - The CLI reuses the module later through `registerNativeProvider`.

## Phases

| Phase | Work | Exit gate |
| --- | --- | --- |
| 0. Spike (no product code) | On this arm64 Mac, with consent: install 1.2.x into a scratch `GEMINI_HOME`, and sign in through a `BROWSER` shell script. Then verify: <br>• Antigravity routes edits through `fs/write_text_file` when the capability is advertised, under 1.2.x as well as T3's 1.1.1<br>• HTTP MCP<br>• `session/resume`<br>• `TMPDIR` size and cold start<br>• whether `_meta.quota` appears<br>• idle network traffic<br>Also confirm Google's terms for third-party ACP clients. | Spike notes recorded; go/no-go |
| 1. Core port | Process, transport, profile, stdout transform, provider and stream writer, model projection, pi-ai 1.0.3 fixes. Fake-agent suites ported to Aiden's runner, with a `test:antigravity` script added to the `package.json` test chain. | Stream, cancel, resume and continuation suites pass |
| 2. Runtime install | Pinned release, free-space check, verified extract, live validation, leases, remove, orphan sweep, Settings install card | Install, cancel, corrupt archive, low disk and remove-while-running paths covered; no network before the click |
| 3. Sign-in and models | `BROWSER` capture, URL validation, `providers:auth`, paste fallback, logout, model refresh, picker metadata, icon | A live sign-in lists real models |
| 4. File I/O and permissions | fs handlers with permission enforcement, mode mapping, approval and question bridge, MCP bridge | Ask-mode writes wait for the card; Read-only denies writes; bridged MCP passes `beforeToolCall` |
| 5. Activity and context | Structured activity side channel and persistence, plans, subagent batches, compaction rows, rewind gating, notices, usage | Activity survives reload; rewind is hidden; notices show |
| 6. Polish and rollout | Send-blocking states, onboarding entry, diagnostics export, mobile picker and activity (iOS and Android), docs, packaged signed Mac acceptance, flag on by default | Packaged build passes; mobile suites pass |
| 7. Later | CLI parity, Enterprise and Vertex sign-in, skills and native slash commands, Remote-started runs, Bots and schedules | Separate plans |

## UI/UX changes

Before building any of these, review `docs/settings-design-system.md`, `docs/design-guide.md`, `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html`. Use the semantic tokens and the shared squircle buttons. T3's equivalents are cited where they informed the design.

### U1. Settings → Providers → Google Antigravity

The card has two rows, Runtime and Account, plus secondary actions.

**Runtime row**

| State | What the user sees |
| --- | --- |
| Unsupported | "Google doesn't publish Antigravity for this Mac." No action. |
| Not installed | A short disclosure before the action: "316 MB download from Google · needs about 1.2 GB free". **Install** button. This is an explicit consent step, which T3 lacks. |
| Installing | Determinate "Downloading X of Y MB", then "Checking the download", "Extracting" and "Validating", with **Cancel**. |
| Installed | Version, with **Update** when an Aiden release brings a newer pin. |
| Failed | A specific message (disk space, integrity, activation) with **Retry**. |

**Account row**

| State | What the user sees |
| --- | --- |
| Signed out | **Sign in with Google** |
| Signing in | "Finish signing in in your browser", with **Copy link**, **Cancel**, and a disclosed field: "If the final page doesn't load, paste its URL here." |
| Signed in | "Signed in" (Antigravity exposes no email) and **Sign out**. Sign-out confirms that it stops running Antigravity chats. |
| Failed | A specific error such as "This Google account needs an eligible Antigravity subscription." |

**Secondary actions**
- **Remove runtime (frees about 0.9 GB)**, with a confirm. It is disabled with a reason while chats are running.
- A Diagnostics disclosure.
- A read-only line: "Permissions follow each workspace's setting."

### U2. Provider listing
- An icon slug and logo, subject to Google's brand-asset terms. Use a neutral mark if they don't allow it.
- Listed under "More" while experimental.

### U3. Model picker
- A "Google Antigravity" group, labelled "Agent · runs its own commands · subscription". T3 relies only on the icon, which is too weak when the same Gemini names appear under the `google` provider.
- The thinking control offers only the advertised tiers, with no Off.
- **Inline setup prompts**, as T3 does: "Install Antigravity in Settings" or "Sign in to Antigravity", linking to the card.
- In Bot, schedule, subagent and Live pickers, these rows are disabled with a reason.
- A saved model that disappears stays selected and is marked "Unavailable".

### U4. Composer send-blocking

A disabled Send button with a tooltip and an inline link to Settings, as in T3's `ChatView.logic.ts`:
- "Install Antigravity in Settings before sending."
- "Sign in to Antigravity…"
- "That model is no longer available for this Google account."

### U5. Startup and stop status
- "Starting Antigravity…" during a cold start, which can take up to two minutes.
- "Stopping Antigravity…" while the 15 s cancel settles.

### U6. Activity rows

Activity uses existing row styles, with a quiet "Antigravity" origin label:

| Native activity | Row |
| --- | --- |
| Commands | Command, cwd, collapsed output and exit code |
| File changes | Inline diff, with paths that open Quick View. Writes also appear in Aiden's changed-files review. |
| Search and fetch | Search row |
| Plan updates | Checklist row |
| `start_subagent` | "Antigravity subagents" batch row |

Failures use soft status fills.

### U7. Approvals and questions
- The existing approval card titles requests "Command approval", "File change approval" or "File read approval".
- Primary buttons are Deny and Allow once. **Allow for this chat** sits in an overflow menu, with ⚠ and the agent's prompt-injection warning text.
- If the process died: "Antigravity stopped. Stop or retry the turn to continue."
- `interaction_*` requests render as Aiden's question prompt: single choice, no free text.

### U8. Full-access disclosure

A one-time notice the first time Antigravity runs in a Full workspace: Antigravity runs shell commands without asking, and those commands are not limited to the workspace. File edits still go through Aiden and stay inside the workspace.

### U9. Context
- Rewind and edit-resubmit are hidden on Antigravity turns, with the tooltip "Antigravity can't undo its history. Start a new chat instead."
- A quiet notice when Antigravity starts from a summary: after a model switch, a fork, or a failed resume.
- The context meter reads from `usage_update` and is labelled "Managed by Antigravity".

### U10. Attachments

Antigravity takes images natively (10 MiB or less). Other files go to it as paths, and unsupported types get T3's message.

### U11. Usage dashboard
- Tokens are recorded at $0 and labelled "Google subscription".
- A quota card appears only if Phase 0 shows that `_meta.quota` is supplied. T3 has no quota UI.

### U12. Errors

| Error | Recovery |
| --- | --- |
| Signed out or expired | A chat banner with **Open provider setup** |
| Subscription required | Specific copy, no retry |
| Runtime missing or incomplete | **Reinstall** |
| Crash | The next turn restarts and resumes. Details stay in Diagnostics. |

### U13. Onboarding
- Listed under "More providers" through `BuiltinProviderEditor`, with the install disclosure first and **Set up later** prominent.
- No bento tile while the feature is experimental. T3 also leaves Antigravity out of onboarding.

### U14. Mobile (iOS and Android)
- Picker rows with the same disabled and unavailable reasons. A selection is never silently replaced, matching T3's mobile behavior.
- Native activity rows in both typed activity timelines. If an origin field is needed, claim the next Remote protocol revision and update iOS, Android and the fixtures together.
- Sign-in stays desktop-only in v1.

## Risks and open questions

**Security boundary**
- Shell commands still run natively with the user's OS privileges, under `yolo` or after approval.
- File edits are now confined to the workspace (D6), which narrows the gap that first-draft Decision 4 left open but does not close it.
- Mitigations: U7 and U8.

**Disk and startup**
- About 920 MB installed, about 1 GB of `TMPDIR` per live process, and cold starts of up to two minutes. D11 bounds this.
- The free-space check must include the `TMPDIR` cost.

**Upstream churn**
- Two pinned versions already differ between the references. Gate every bump with the fake-agent suites plus one live qualification run.

**Undocumented behavior**
- The quirks listed above come from T3's observations of 1.1.1, not from Google's documentation: the stdout sign-in line, version 2 in a v1-shaped response, `interaction_*` questions, `start_subagent`, and `agy.security.warning`.
- Phase 0 re-checks them on 1.2.x.

**Open questions**
- **Terms:** whether third-party ACP clients and automated downloads are allowed.
- **Idle telemetry:** unknown.
- **Linux:** the managed runtime is untested on Fedora with SELinux.

## Out of scope

- Loading arbitrary Pi packages or ACP registry agents in the desktop app.
- The upstream slash commands, background updates, and remote manifests.
- Account rotation or quota workarounds.
- API-key, Enterprise and Vertex sign-in in v1.
- Windows.
