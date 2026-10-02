# Pi 1.0 parity upgrade

Status: implementation and combined validation complete; final focused acceptance fixes and PR review active (2026-10-02). Eight open PRs cover the stable Pi 1.0 integration. No PR has been merged; documented client differences remain intentional.

## Baseline and target

Aiden origin/main: `d2197dfef` (0.51.0). Pi checkout `/Users/sambitbiswas/projects/opp/pi` was fast-forwarded to `581e7ba78`. Published target: exact **1.0.0**, release tag `v1.0.0` / `a13d35a742`. Changes in upstream `Unreleased` are tracked separately, not silently shipped as 1.0. Release: https://github.com/earendil-works/pi/releases/tag/v1.0.0.

The audit covers the delta from Aiden's 0.87.1 pins and the complete stable coding-agent surface. Pi's durable, client/server/protocol and virtual-model APIs are explicitly experimental. Aiden's existing remote protocol, native clients, security policy, journals, and subagent supervision stay authoritative. Matching a feature means delivering its user capability with Aiden's permissions, not replacing a stronger existing implementation.

## Feature and integration inventory

| Surface | Existing Aiden | Pi 1.0 requirement / implementation |
| --- | --- | --- |
| Agent loop and provider transport | Core/AI 0.87.1 | Exact 1.0.0 pins; request hooks, requested thinking levels, provider fixes; serialize and replay offline |
| Sessions, history, branches, compaction | Aiden runtime + Pi experimental v4 journal helpers | Core 1.0 deleted these APIs. Isolate frozen 0.87.1 helper alias behind compatibility adapters, keep live Agent/Models on 1.0, preserve journals and existing replay/rollback gates. Experimental pi-durable migration is separate, not required for stable feature parity |
| Provider model catalogs | Chat-only bundled and optional live catalogs | Update release catalog from installed pi; reject/filter image/classifier records from chat inventory, preserve manual-only models.dev/benchmark policy |
| Sign in with ChatGPT | Existing legacy Codex OAuth | Supply stable device identity for new OpenAI provider login; keep Codex accounts working; expose new login through existing provider UI/onboarding discovery |
| Anthropic sign-in | Existing interactive OAuth | Support 1.0 browser/copy-code interaction and revised branding; test callback paths |
| CLI TUI / settings / input / session exports | Rebranded coding-agent 0.87.1, fullscreen already default | Inherit stable 1.0 TUI, header-only quiet startup, palette/input/history/export fixes, preserve Aiden generated themes/config layout |
| CLI extensions / provider hooks | Aiden built-in extensions, worker loaders | Update 1.0 context types and packaging, preserve capability tiers and disabled worker builtins |
| Codemode / nested tool calls / tool search | No desktop codemode; CLI inherits after bump | Package native CLI worker and helpers, exercise real offline nested calls with permission gates. Desktop adoption must route nested execution through current approval/tool lifecycle, preserve transcript and native consumers |
| Images / classifiers | Existing Aiden image/vision surfaces | CLI inherits unified model API and codemode generation/classification. Desktop inventory remains type-aware; expose tools only through approved credential/runtime paths with usage accounting |
| MCP config / transport / resources | Aiden server IDs, encrypted credentials, scoped resources/instructions | CLI legacy array collides with Pi native object mcp.json: migrate Aiden config safely to own file, preserve native config and separate explicit admin commands. Native MCP remains user configured |
| MCP OAuth | Aiden server-scoped OAuth | Bind callback state and issuer, metadata override and scope preservation where supported; test auth failure before token exchange and independent server identities |
| Skills / templates / AGENTS / plugins | Aiden trust, skill discovery, refresh, slash invocation | Preserve existing host semantics; CLI inherits native plugin/resource features without widening worker permissions |
| Queue / steering / abort / subagents | Existing desktop/CLI/remote implementations | Preserve behavior through 1.0 replay, cancellation and subagent regression gates |
| Onboarding / desktop / iOS / Android | Existing data-driven tour and native protocol | Update only for capabilities actually shipped; inspect native consumers and run mobile suites for any shared contract/transcript changes |
| Experimental durable / remote / virtual models | Aiden equivalent or no production consumer | Explicitly excluded from automatic replacement; record API status and follow-up acceptance criteria |
| Post-release HEAD features | Unreleased OAuth copy shortcut/CIMD/Clef/installer changes | Audit only; no unpublished pin or generated catalog import |

## Execution and PR boundaries (maximum three task worktrees)

1. **Runtime foundation PR** — worktree A (coordinator current checkout for plan initially; runtime implementation worktree B): exact core/AI pins, named legacy helper boundary, lockfile, compatible model catalog and branding, replay/compaction/session/provider/subagent tests. No journal format rewrite. PR must clearly name remaining compatibility debt.
2. **CLI parity PR** — worktree C: exact coding-agent/chord 1.0, generated bundle chunks and codemode worker, MCP config migration/coexistence and command routing, TUI/branding, real nested-call permission tests. Stack on runtime foundation once ready so both pin lines match.
3. **Provider and MCP integration PR** — worktree A: new OpenAI login identity and focused MCP OAuth parity/hardening. Independent agents own disjoint files. Stack on runtime foundation if new interfaces require it.
4. **Desktop stable capability parity** — reuse the same three worktrees after earlier work is committed; implement missing codemode/tool discovery/image/classifier surfaces with Aiden permission/transcript/usage integration, updating onboarding and both native clients when shared behavior changes. Keep these acceptance items open until implemented and tested; do not label a dependency upgrade full desktop parity.

Agents audit first, then implement their assigned lane in different worktrees. No fourth task worktree. Existing unrelated worktrees are untouched. Shared PR branches merge origin/main; no rebases/force pushes. Every created PR is attached to this task.

## Validation and completion criteria

- Reproducible root and standalone CLI lockfiles, exact pins, root and CLI TypeScript, focused behavior suites, relevant lint and build checks.
- Existing seven upgrade replay cases, session v3/v4 migrations and retained rollback backups, compaction/VCC, provider serialization, MCP and full subagent suites.
- CLI production bundle starts offline and exercises codemode worker, deferred/nested tool execution and denied capability tiers; MCP migration never drops, overwrites or leaks existing config/credentials.
- OAuth tests use fake local callbacks/tokens, verify stable private identity, state/issuer rejection and cancellation without network/provider credentials.
- Mobile suites mandatory for shared remote/transcript changes; no claim of physical-device or signed-package validation without running it.
- Plan stays active while any stable desktop capability acceptance is missing. Archive only after all required implementation and validation finish. PR descriptions report exact local results, remaining gaps and any CI failures; do not merge unless separately requested.

## Progress

- [x] Pull Aiden origin/main and pi checkout; parallel runtime, CLI, stable-feature audits.
- [x] Record target, feature inventory, architecture decisions and three-worktree PR plan before edits.
- [x] Runtime foundation and replay gates — PR #299.
- [x] CLI stable 1.0 upgrade and offline bundle/permission gates — combined into PR #299 so desktop and CLI pins change atomically. Review follow-up covers migrated MCP revocation readers.
- [x] Provider login and MCP metadata/OAuth/rich-result integration — PR #302; explicit device-local provider credential consent — PR #305.
- [x] Desktop codemode/tool search (#302), image generation/reference inputs and classifiers (#303), local llama.cpp classifier opt-in (#306), complete bounded MCP inventory (#307).
- [x] Exact model compaction budgets (#301) and off-default foreground cache warming (#304).
- [x] Combined local validation and reviewable PR stack; hosted checks and merge remain pending as recorded below.


## Implementation checkpoints

- [PR #299](https://github.com/sambitcreate/aiden-agent/pull/299): atomic desktop/CLI 1.0 upgrade. The separate CLI PR #300 was superseded and closed after CI proved that mixed desktop/CLI versions break standalone types. Frozen journal helpers remain an explicit compatibility boundary.
- [PR #301](https://github.com/sambitcreate/aiden-agent/pull/301): exact provider/model compaction budgets across foreground, child, nested, manual and idle paths; Memory settings save/reset. Real Electron save/relaunch/reset passed.
- Desktop scripts execute in QuickJS without ambient filesystem/network access. Nested calls reuse approval, schema validation, durable effects and public activity IDs. Final admitted MCP schemas are deferred only when codemode is enabled; search returns schemas for execution inside codemode. Excluding codemode restores direct MCP tools. Bots, assistant mode and child supervisors retain their existing tool inventories.
- OpenAI OAuth receives a private, lazily generated installation identity. First-run login prefers the new OpenAI provider while preserving legacy Codex selections. MCP callbacks validate state/issuer and preserve scope consent. Small JSON structured results and validated raster images survive tool conversion.
- Focused desktop script/discovery/runtime tests pass (418 compaction suite tests at the first integrated checkpoint). iOS 230 and Android 62 tests passed, with follow-up public activity-ID fixtures rerun. No native wire change or physical-device validation is claimed.
- Model operations include paid-operation disclosure, bounded current-chat reference images, shared artifact accounting and single provider-call usage metering. Local classification requires an explicit saved custom-provider opt-in and uses fresh credentials without probing/downloading/loading models.
- Provider-backed MCP requires a separate encrypted device-local grant for the exact HTTPS server endpoint. Each attended discovery/tool/resource operation uses a fresh short-lived client, fresh provider credentials and configuration/owner/cancellation checks; authorization ends before teardown. Bots, children, background and Remote runs cannot reuse this grant.
- MCP tool inventories follow bounded pagination (512 tools, 64 pages, 30 seconds), checking freshness between pages. Full-inventory validators preserve earlier-page output schemas and block task-required tools before dispatch.
- Desktop warming targets active foreground generations only, defaults off, and uses bounded provider cost eligibility, fresh credentials, cancellation and separately attributed usage. Real Electron persistence checks passed for compaction, warming and local classifier controls.

## Onboarding illustration provenance

`renderer/assets/onboarding/features/tool-scripts.png` was generated with the imagegen skill/tool and resampled to the required 1024 × 1024 transparent PNG. Prompt: premium 3D clay Aiden Tool Scripts illustration; friendly purple ghost, navy script console with cyan brackets, blue folder, purple magnifying glass, coral result card, short purple cables and a small gold padlock; matte lavender/navy/blue/coral palette, centered with generous transparent margin, no floor, background, text, frame or brain imagery. The onboarding asset contract validates the shipped image.

## Stable capability coverage by client

| Published Pi surface | Aiden CLI 1.0 | Aiden desktop/native adaptation |
| --- | --- | --- |
| TUI/fullscreen, quiet header, terminal palettes, keybindings, copy/paste, export | Inherited from exact coding-agent/chord 1.0; Aiden themes and branding retained | Existing Electron/native interface stays authoritative; terminal settings are CLI features |
| Sessions/branching, compaction, queue/steering, cancellation | Native Pi behavior with Aiden wrappers and capability gates | Existing durable journals and queue ownership retained; exact model compaction budgets in #301 |
| Provider transport, thinking, retries, auth, catalog types | Inherited 1.0 | Live Models/Agent 1.0; new OpenAI identity, callback branding, chat-only picker filtering; custom runtime constraints retained |
| Codemode/tool search/deferred MCP schemas | Native Pi sandbox/worker, permission-tested offline | Approved nested host lifecycle, final admitted inventory, sequential effects; schemas remain callable through codemode rather than activating new direct declarations |
| MCP tool exposure configuration | Native per-server/per-tool direct, deferred and hidden rules | Existing Aiden admission/exclusion controls and codemode-wide deferred exposure remain authoritative; no equivalent per-server/per-tool Pi pattern editor is added |
| Image generation/classification | Native models APIs including image inputs | #303 adds paid-operation approval, bounded current-chat reference images and outputs, shared artifacts and single usage accounting |
| MCP transports/OAuth/resources | Native Pi config plus separate Aiden server store/admin commands | Explicit metadata/client-name overrides, scope/state/issuer checks, bounded JSON/text/raster/resource-link results; provider credential sharing requires the separate device-local grant in #305; #307 paginates and validates the complete bounded inventory |
| Skills/templates/AGENTS/packages/extensions and programmatic CLI modes | Native Pi 1.0 resources, SDK/RPC/JSON/print surfaces with Aiden trust/capability gates | Existing Aiden skills/plugins/native protocol remain authoritative; no arbitrary terminal extension UI injected into Electron |
| Cache warming | Native settings include while-running and idle modes | Off by default, active foreground generations only, bounded economics/lifetime, cancellation and usage accounting; no idle/background warming |
| llama.cpp router management/local classifiers | Inherited built-in llama.cpp extension | #306 adds explicit local classifier opt-in with fresh configured endpoint/auth; full router/download/load/unload management remains CLI-only |
| Radius setup | Native Radius login and MCP setup convenience | Generic provider login exists; Radius service is early alpha, convenience auto-configuration is CLI-only |
| Experimental virtual models/durable/client/server/protocol | Upstream APIs remain available where shipped by CLI dependencies | No automatic replacement of Aiden security, remote protocol or journals |

Functional parity preserves Aiden's stronger admission boundaries. It does not imply copying terminal UI into native clients or exposing every extension SDK primitive as a desktop setting. In particular, desktop MCP connections still use Aiden's admitted snapshot rather than Pi's lazy background connection timing, and codemode serializes effects. These differences are explicit rather than silently advertised as byte-identical behavior. Desktop scripts call approved host tools rather than exposing Pi’s `models.*` JavaScript API directly, and use fixed safety budgets rather than configurable `// @options`.

## Integrated validation checkpoint

The first broad `npm run test` covered 7,680 cases: 7,673 passed, 5 skipped, 2 failed. The introduced onboarding `text-sm` token was replaced by the semantic `text-small` token; all 18 appearance tests then passed. The untouched Git timeout reconciliation test failed under concurrent load and passed its single focused rerun. This is not a claim that the broad run was green. Both native chat suites were rerun successfully (230 iOS / 62 Android). A real Electron Node runtime smoke started the installed Pi sandbox worker/WASM, dispatched one offline tool, and verified absent ambient `process`/`fetch` globals. Signed-package, physical-device, and live paid-provider calls have not been exercised.

## Review and merge sequence

All eight PRs use the same three task worktrees. They are stacked in this order, using normal merges to preserve published history and the tested integration resolutions:

| Order | PR | Scope | Base |
| --- | --- | --- | --- |
| 1 | [#299](https://github.com/sambitcreate/aiden-agent/pull/299) | Atomic runtime/CLI 1.0, journals adapter, worker packaging and MCP migration | main |
| 2 | [#302](https://github.com/sambitcreate/aiden-agent/pull/302) | Desktop codemode/discovery, provider login, MCP OAuth and rich results | #299 |
| 3 | [#301](https://github.com/sambitcreate/aiden-agent/pull/301) | Exact provider/model compaction budgets | #302 |
| 4 | [#304](https://github.com/sambitcreate/aiden-agent/pull/304) | Opt-in foreground cache warming | #301 |
| 5 | [#303](https://github.com/sambitcreate/aiden-agent/pull/303) | Approved image/classifier tools and reference images | #304 |
| 6 | [#306](https://github.com/sambitcreate/aiden-agent/pull/306) | Explicit local llama.cpp classifier capability | #303 |
| 7 | [#305](https://github.com/sambitcreate/aiden-agent/pull/305) | Device-local provider-backed MCP consent and operation lifetime | #306 |
| 8 | [#307](https://github.com/sambitcreate/aiden-agent/pull/307) | Complete bounded MCP inventories and per-tool result validation | #305 |

Retarget each successor to main as predecessors merge; do not merge these PRs without release-owner authorization. The active plan remains here until review/merge is reconciled.

Additional deliberate differences: the live pi.dev overlay remains chat-only; non-chat operation inventory uses the pinned 1.0 runtime. Idle cache warming, full llama.cpp router management and Radius convenience configuration remain CLI capabilities. No experimental durable/protocol/virtual-model migration or post-1.0 HEAD feature is claimed.

A synthetic unsigned ASAR smoke also started the packaged Pi sandbox worker and QuickJS WASM under Electron and returned an offline result. This verifies worker/unpack wiring, not a signed distributable.

## Final combined validation (2026-10-02)

The combined implementation at `1fa603db5` passed `npm run test` under Node 22.22.3: **8,521 TAP cases, 8,516 passed, 5 skipped, zero failures**, plus **41 native Rust tests**. Root TypeScript, full ESLint, production build, and 47 CI policy tests passed. Both mobile chat suites passed earlier against the shared activity changes: **230 iOS and 62 Android tests**. Independent agent reviews found no blocking MCP lifecycle/pagination or model/classifier/warming integration issues.

The final feature audit identified and corrected server-description tool-search ranking and Windows/Linux onboarding disclosure. Follow-up acceptance checks cover those fixes, keyboard access and long-copy sizing in the gallery, and bounded raster images from MCP resource reads. These focused checks are recorded separately from the full-suite baseline.

CI history is retained honestly: mixed root/CLI pins were combined atomically; a stale migrated MCP reader, missing second test-registry registration, and an HTTP-only helper accidentally applied to stdio were fixed. One earlier Linux install failed with `ECONNRESET` before tests, and an external review job failed to parse its own output. PR #299 subsequently passed all required CI lanes; remaining PR checks are independently tracked on GitHub.

Desktop MCP resource reads retain opaque generation/server-scoped handles and bounded content. Non-image binary blobs are explicitly omitted: the resource-read capability does not authorize automatically writing arbitrary server bytes to temporary files. Pi's CLI retains its native binary-resource file behavior. This is a deliberate host capability difference.

### Final acceptance and CI follow-up

- Final combined discovery/resource/onboarding suites: **62 passed**; root TypeScript passed again after the resource-image and gallery changes. Full MCP suite: **151 passed**.
- Real Electron gallery checks passed keyboard traversal and complete description bounds at 1000, 600 and 390 pixel widths. Gallery focus uses the neutral ring, and reduced-motion behavior is preserved.
- PR #302 CI run `37033148466` hit an existing test false positive: `/adb|android/` matched `adb` inside a generated hexadecimal session ID. The final PR scopes that assertion to whole words, covers the exact failing session ID, and passes 14 unit tests plus the real Electron device-agent scenario.
- PR #304 CI run `37033546177` exposed a missing prerequisite: the runtime/subagent lane's zero-retained-context test invokes the VCC worker, but only the core/Git lane built it. A controlled missing-worker reproduction matched CI. The prerequisite and regression coverage are corrected from PR #301 through the stack. The full local suite had built this worker earlier, explaining why it passed.
- The same #304 run's renderer job failed during `npm ci`, before tests, when macOS rejected the esbuild executable (`EBADMACHO`). This is recorded as an infrastructure failure, not a passing renderer run. No blind hosted retry was used.

The final stack has focused acceptance evidence after the broad green baseline. Hosted checks are still running on updated heads; this plan does not claim all eight PRs have green CI or that any have merged.
