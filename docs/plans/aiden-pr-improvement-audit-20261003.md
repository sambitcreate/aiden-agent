# Aiden PR inventory and improvement audit — 2026-10-03

Status: research complete; implementation recommendations are proposed.

## Scope and evidence

- Repository: `sambitcreate/aiden-agent` only. All **304** PR records were retrieved, including titles, descriptions, status, base/head branches, timestamps and size. Counts: **263 merged, 31 closed without merge, 10 open**. These are GitHub states, not claims that every merged PR reached main.
- Checked-out main: `3f86d41af16ea653e907606fb2952d3f67b2dd6e` (0.52.0 plus the offline catalog refresh). `git pull --ff-only origin main` reported already current; the checkout was clean.
- Pi reference: `/Users/sambitbiswas/projects/opp/pi`, `a276dabe57911253350bffb93cb7d7aff6a73261`. Fetch confirms this matches upstream main. Published package versions and latest GitHub release were checked separately: **1.0.0**.
- All ten open PRs received file-inventory, description, current-head CI and review-thread checks. Runtime, skills, settings, CLI packaging, Pi source and the upgrade stack plan received targeted source inspection. Historical PRs were assessed through their descriptions and current implementation/plan evidence; this is **not a fresh line-by-line correctness review of all 304 diffs**.
- CI is a read-only snapshot from 2026-10-03. No PRs were merged, reviews requested, comments posted, jobs retried or branches deleted. Local application suites were not rerun for this documentation-only audit.
- Fourteen merged PRs targeted another feature branch. In particular #300 merged into #299's branch, not main. The upgrade plan's old wording that #300 was closed is stale; GitHub reports MERGED. Main still pins desktop core/AI and CLI coding-agent/chord to 0.87.1.

## Current open PRs

| PR | Scope | Head | Base | Checks at snapshot | Unresolved threads | Contains current main |
| --- | --- | --- | --- | --- | --- | --- |
| [#299](https://github.com/sambitcreate/aiden-agent/pull/299) | Upgrade Aiden desktop runtime and CLI to Pi 1.0 | `1487c8d74` | `main` | 24 success | 0 | No |
| [#301](https://github.com/sambitcreate/aiden-agent/pull/301) | Add per-model compaction budgets across Aiden runtimes | `ed8c88a3a` | `codex/pi-1-integrations` | 23 success | 0 | No |
| [#302](https://github.com/sambitcreate/aiden-agent/pull/302) | Add approved Pi scripts, deferred MCP discovery and provider login parity | `56cb16aba` | `codex/pi-1-runtime` | 24 success | 0 | No |
| [#303](https://github.com/sambitcreate/aiden-agent/pull/303) | Add approved desktop image generation and classifier tools | `fba4dfbb2` | `codex/pi-1-cache-warming` | 23 success | 0 | No |
| [#304](https://github.com/sambitcreate/aiden-agent/pull/304) | Add opt-in cache warming for active desktop chat runs | `8be7bebaf` | `codex/pi-1-compaction` | 24 success | 0 | No |
| [#305](https://github.com/sambitcreate/aiden-agent/pull/305) | Add explicit provider credential approval for attended MCP connections | `12dd1eadf` | `codex/pi-1-local-classifier` | 24 success | 0 | No |
| [#306](https://github.com/sambitcreate/aiden-agent/pull/306) | Add opt-in desktop llama.cpp classifier operations | `43afed230` | `codex/pi-1-model-tools` | 23 success | 0 | No |
| [#307](https://github.com/sambitcreate/aiden-agent/pull/307) | Complete Pi 1.0 MCP inventory, resource images, and acceptance polish | `04c10551e` | `codex/pi-1-provider-mcp` | 24 success | 0 | No |
| [#310](https://github.com/sambitcreate/aiden-agent/pull/310) | feat(remote): host run observer bus and coalesced stream persistence | `4756f7b14` | `main` | 24 success | 0 | Yes |
| [#311](https://github.com/sambitcreate/aiden-agent/pull/311) | feat(sidebar): needs-attention view and sort orders (multi-host PR 5a) | `54093f7df` | `main` | 24 success | 0 | Yes |

The eight Pi PRs have green reported checks on their current heads, but none contains main `3f86d41af`. This makes those results historical relative to a future integration merge. Merge main normally, run the touched suites locally, then wait for green CI on each resulting head. #310 is green and contains current main; its description retains two flaky-test incidents. #311 contains current main and all 24 reported checks are green at the final same-head read. Resolved threads and a CLEAN merge state do not establish release acceptance.

## Recommended treatment of each open PR

| PR | Recommendation and improvement opportunity |
| --- | --- |
| #299 | Keep atomic desktop/CLI pins. Preserve the explicitly named frozen 0.87.1 journal helper boundary; publish an owner and exit criteria for removing it. Update from main and rerun replay, migrations, package startup and CLI types. Correct #300's status in the active upgrade plan. |
| #302 | Reuse its codemode and discovery pipeline for app tools, preserving direct availability when scripts are disabled. Investigate the post-1.0 output accumulation fix before release: Aiden truncates returned text after sandbox execution, which does not itself bound host-side accumulation during execution. This is source-supported exposure requiring a bounded behavioral reproduction, not a reproduced Aiden crash. |
| #301 | Retain model-specific compaction budgets across all runtimes. App help and action results must fit the same context accounting. Add app-action settings to this budget UI only in a separate future slice, after the upgrade lands. |
| #304 | Keep cache warming opt-in and foreground-only. Product knowledge must explain cost and scope; turning it off through a future action must cancel active warming, not merely change the stored flag. |
| #303 | Keep operation-specific image/classifier approvals and usage accounting. The help registry must distinguish chat models, image models and classifiers, and avoid advertising unconfigured operation tools. |
| #306 | Preserve explicit llama.cpp classifier setup. The help/action layer should report configured capability and explain setup without probing endpoints, downloading or loading models. Full router management remains a separate CLI capability. |
| #305 | Preserve endpoint-specific device-local provider credential consent. Future app actions may open the existing connection flow; they must not manufacture provider-backed MCP grants or silently connect a server. |
| #307 | Preserve complete bounded MCP inventories and per-tool result validation. Use final admitted tools for live capability answers; incomplete inventory must be surfaced as incomplete. Reconcile the stack plan after actual integration. |
| #310 | Reuse host-qualified run identity and the observer bus when app state needs active-run facts. Keep durable terminal-event flush and replay acceptance. Resolve the recorded queue and relaunch flakes in their owning behavioral suites; a passed retry remains a flake. |
| #311 | Reuse its pure sidebar projection and typed view/sort preferences for a later “show chats needing attention” action. Current preferences live in renderer storage, so exposing them needs an owner-fenced UI adapter rather than a main-process config write. Its final same-head check read is green; retain that evidence when integrating. |

## Prioritized improvement backlog

| Priority | Improvement | Evidence | Concrete next delivery |
| --- | --- | --- | --- |
| P0 integration | Land and reconcile the already implemented stable Pi stack | #299 → #302 → #301 → #304 → #303 → #306 → #305 → #307; main remains 0.87.1 | Normal main synchronization, narrow local suites, fresh hosted checks, release-owner integration and signed-package acceptance. The audit does not authorize merging. |
| P0 release check | Bound codemode output while it is produced | Pi commit `319fecb89`; #302's `pi-codemode.ts` limits final result text after `sandbox.execute` | Reproduce in a killable isolated process with bounded loops and memory accounting; verify CLI and Electron paths. Prefer next exact released fix or an explicitly reviewed pinned patch with license/provenance; no wholesale unpublished upgrade. |
| P1 product | Add built-in Aiden help and interactive settings inside chat | #4/#11 assistant foundation; #97 skills controls; #121 CLI; current settings tools absent; default desktop prompt says Pi; existing HTML artifact mobile fallback | Execute the [expanded knowledge/actions plan](aiden-app-knowledge-actions-plan.md) and [json-render/control specification](aiden-chat-controls-json-render-research.md): offline help, shared real settings services and contextual controls on desktop, native iOS/Android and CLI TUI. Mobile parity is MVP acceptance. |
| P1 maintenance | Extract settings mutation behavior into reusable application services | `providers.ts` skills revocation/appearance broadcasts, `phase2.ts` Web Search revision seam, dedicated Computer Use handler | Share validation, durable commit, cancellation and effect invalidation between UI and agent calls. Keep per-domain adapters instead of a generic raw settings patch. |
| P1 reliability | Consolidate race/ownership lessons into lifecycle contracts | #27/#115/#208 generation ownership; #150/#213 attachments; #225–#242 and #294–#296 mobile response/upload ownership | Focus on public owner/epoch/revision transitions and joinable cancellation, retaining existing behavioral tests. New features must reuse these seams. |
| P1 acceptance | Close installed/physical/operator evidence gaps | Active CLI, Linux, durable-run, subagent, devices, read-aloud and compaction plan rows | One dated acceptance matrix per release, naming exact build/platform/device and pending owner gates. Implementation-complete is distinct from accepted or shipped. |
| P1 performance | Measure current packaged behavior before reprioritizing the old whole-app audit | #282–#288 bounded-work fixes; #310 journal coalescing; performance plan still quotes a July snapshot | Refresh findings against 0.52.0 and define measured startup, idle work, main-loop delay, disk bytes, long-chat heap and Stop latency budgets. Do not restate old P0 findings as current defects. |
| P2 architecture | Give frozen journal helpers an exit plan | #246 transcript migration; #299 helper alias; existing seven-case replay harness | Inventory helpers, stop new callers, define backup/reopen/deletion/rollback parity, then separately evaluate pi-durable. Upstream marks those APIs experimental. |
| P2 execution | Complete production durable runs deliberately | #243 is a ledger/lease foundation, not enabled runtime recovery | Runtime-port and Bot rollout acceptance from the existing durable-jobs plan; app help must label the foundation as unshipped. |
| P2 scope | Finish multi-host integration without mixing local and remote actions | #104 foundation; #310 observer; #311 sidebar; broader plan remains active | Typed host-qualified targeting and reconnect/replay before exposing cross-host controls in natural language. |
| P2 test quality | Continue replacing source-grep or flaky fixture checks with behavioral oracles | #128/#279/#311 examples; #299/#310 current flake records; AGENTS rules | Extend existing suites around observable lifecycle phases and hold/release fixtures. Do not raise retries/timeouts or add source-string snapshots. |
| P2 documentation | Separate shipped capabilities, feature flags, open stacks and historical plans | Upgrade plan still says #300 closed; plan index pre-dates 0.52.0; product summary still emphasizes Mac despite Linux/CLI | A versioned product capability manifest plus short user docs; refresh plan statuses when implementation actually changes. |

## Pi release and unreleased-source watchlist

- Stable target: [Pi 1.0.0 release](https://github.com/earendil-works/pi/releases/tag/v1.0.0), tag `a13d35a742`. It adds/refines codemode, image operations, OAuth, fullscreen/header startup, prompt size and transcript memory. Aiden already has the eight-PR adaptation stack; a second upgrade implementation would duplicate it.
- [Output accumulation fix](https://github.com/earendil-works/pi/commit/319fecb89b17b7bf8a4b62734de9a6cc6ceabe49): unreleased output character/item budgets. Highest-priority source delta to evaluate for the pending release.
- `eeac84ca9`: fail ChatGPT sign-in when callback port is occupied. Add/confirm user-visible recovery rather than starting a broken login.
- `69f0be6f0`: drop stale thinking blocks during Bedrock Claude replay. Evaluate provider serialization fixtures if Bedrock is supported in the release.
- `0495646a8`: direct brace-expansion 5.0.12 pin. Inspect actual root/CLI lockfile dependency graphs and audit results before describing either build as affected; removal of upstream shrinkwrap is also unreleased.
- `a276dabe5`/`672000c80`: non-PNG terminal images and WezTerm scrolling; primarily CLI presentation checks.
- `1387af7b4`: project overrides for global MCP enabled/exposure settings. Preserve Aiden project-trust and global-grant boundaries if adopted in a later released pin.
- `1499466d8`: MCP Client ID Metadata Documents; `ced72c2f0`: copy sign-in URL shortcut. Future convenience work; no implicit network consent.
- Cloudflare Clef classifiers, pricing/model-ID updates, inline Anthropic tool handling and capacity retries belong to a future pinned-provider evaluation. Ordinary help reads must never refresh models.dev or benchmark catalogs.

## Full PR inventory

Every PR returned by the authenticated repository listing appears below. Dates are UTC merge/close/create dates as supplied by GitHub. A merged feature-base entry is explicitly marked; historical classifications describe PR scope, not a newly verified defect.

| PR | State | Date | Base | Title |
| --- | --- | --- | --- | --- |
| [#311](https://github.com/sambitcreate/aiden-agent/pull/311) | open | 2026-10-03 | `main` | feat(sidebar): needs-attention view and sort orders (multi-host PR 5a) |
| [#310](https://github.com/sambitcreate/aiden-agent/pull/310) | open | 2026-10-02 | `main` | feat(remote): host run observer bus and coalesced stream persistence |
| [#309](https://github.com/sambitcreate/aiden-agent/pull/309) | merged | 2026-10-02 | `main` | Release Aiden Agent 0.52.0 |
| [#308](https://github.com/sambitcreate/aiden-agent/pull/308) | merged | 2026-10-02 | `main` | fix(ios): await ActivityKit content delivery instead of a 2s poll |
| [#307](https://github.com/sambitcreate/aiden-agent/pull/307) | open | 2026-10-02 | `codex/pi-1-provider-mcp` | Complete Pi 1.0 MCP inventory, resource images, and acceptance polish |
| [#306](https://github.com/sambitcreate/aiden-agent/pull/306) | open | 2026-10-02 | `codex/pi-1-model-tools` | Add opt-in desktop llama.cpp classifier operations |
| [#305](https://github.com/sambitcreate/aiden-agent/pull/305) | open | 2026-10-02 | `codex/pi-1-local-classifier` | Add explicit provider credential approval for attended MCP connections |
| [#304](https://github.com/sambitcreate/aiden-agent/pull/304) | open | 2026-10-02 | `codex/pi-1-compaction` | Add opt-in cache warming for active desktop chat runs |
| [#303](https://github.com/sambitcreate/aiden-agent/pull/303) | open | 2026-10-02 | `codex/pi-1-cache-warming` | Add approved desktop image generation and classifier tools |
| [#302](https://github.com/sambitcreate/aiden-agent/pull/302) | open | 2026-10-02 | `codex/pi-1-runtime` | Add approved Pi scripts, deferred MCP discovery and provider login parity |
| [#301](https://github.com/sambitcreate/aiden-agent/pull/301) | open | 2026-10-02 | `codex/pi-1-integrations` | Add per-model compaction budgets across Aiden runtimes |
| [#300](https://github.com/sambitcreate/aiden-agent/pull/300) | merged (feature base) | 2026-10-02 | `codex/pi-1-runtime` | Bring Aiden CLI to Pi 1.0 with codemode and MCP coexistence |
| [#299](https://github.com/sambitcreate/aiden-agent/pull/299) | open | 2026-10-02 | `main` | Upgrade Aiden desktop runtime and CLI to Pi 1.0 |
| [#298](https://github.com/sambitcreate/aiden-agent/pull/298) | merged | 2026-10-02 | `main` | feat(steer): desktop and Telegram Steer through shared run-input admission |
| [#297](https://github.com/sambitcreate/aiden-agent/pull/297) | merged | 2026-10-02 | `main` | docs(plans): refresh plan index and status for 0.51.0 |
| [#296](https://github.com/sambitcreate/aiden-agent/pull/296) | merged | 2026-09-30 | `main` | fix(ios): await progress observer completion instead of a 1s poll |
| [#295](https://github.com/sambitcreate/aiden-agent/pull/295) | merged | 2026-09-30 | `main` | fix(android): keep image attachment state writes on the UI thread |
| [#294](https://github.com/sambitcreate/aiden-agent/pull/294) | merged | 2026-09-30 | `main` | fix(ios): join upload revocation claimed by removal cleanup |
| [#293](https://github.com/sambitcreate/aiden-agent/pull/293) | merged | 2026-09-30 | `main` | fix(deps): bump js-yaml to 4.3.2 (CVE-2026-84375) |
| [#292](https://github.com/sambitcreate/aiden-agent/pull/292) | merged | 2026-09-30 | `main` | chore: stop tracking papercuts |
| [#291](https://github.com/sambitcreate/aiden-agent/pull/291) | merged | 2026-09-30 | `main` | test(e2e): stop browser annotation spec from interrupting its own style preview |
| [#290](https://github.com/sambitcreate/aiden-agent/pull/290) | merged | 2026-09-29 | `main` | Release Aiden Agent 0.51.0 |
| [#289](https://github.com/sambitcreate/aiden-agent/pull/289) | closed | 2026-09-30 | `main` | fix: upgrade js-yaml to patched version (CVE-2026-84375) |
| [#288](https://github.com/sambitcreate/aiden-agent/pull/288) | merged | 2026-09-30 | `main` | perf(tools): bound foreground filesystem work and cancellation |
| [#287](https://github.com/sambitcreate/aiden-agent/pull/287) | merged | 2026-09-28 | `main` | perf(git): share validated display reads and bound review IO |
| [#286](https://github.com/sambitcreate/aiden-agent/pull/286) | merged | 2026-09-28 | `main` | perf(files): bound concurrent workspace metadata and legacy identity checks |
| [#285](https://github.com/sambitcreate/aiden-agent/pull/285) | merged | 2026-09-28 | `main` | perf(remote): avoid full journal snapshots during event accounting |
| [#284](https://github.com/sambitcreate/aiden-agent/pull/284) | merged | 2026-09-29 | `main` | perf(android): prepare selected images off Main with bounded ownership |
| [#283](https://github.com/sambitcreate/aiden-agent/pull/283) | merged | 2026-09-28 | `main` | perf(ios): publish refreshed chats independently of model catalogs |
| [#282](https://github.com/sambitcreate/aiden-agent/pull/282) | merged | 2026-09-28 | `main` | perf(browser): throttle idle guests with owned activity exceptions |
| [#281](https://github.com/sambitcreate/aiden-agent/pull/281) | closed | 2026-09-28 | `main` | docs(performance): refresh whole-app audit and track optimization batch |
| [#280](https://github.com/sambitcreate/aiden-agent/pull/280) | merged | 2026-09-30 | `main` | feat(chats): chat row states and honest unread markers |
| [#279](https://github.com/sambitcreate/aiden-agent/pull/279) | merged | 2026-09-30 | `main` | feat(dictation): Parakeet idle unload/warm-up, tap-or-hold mode, custom dictionary |
| [#278](https://github.com/sambitcreate/aiden-agent/pull/278) | merged | 2026-09-29 | `main` | feat(web-search): pool Tavily API keys with failover and cooldowns |
| [#277](https://github.com/sambitcreate/aiden-agent/pull/277) | merged | 2026-09-29 | `main` | feat(mobile): worked-for, timestamps, copy, and Ask about this in transcripts |
| [#276](https://github.com/sambitcreate/aiden-agent/pull/276) | merged | 2026-09-30 | `main` | feat(mobile): Live Activity freshness chips and Bot chat deep links |
| [#275](https://github.com/sambitcreate/aiden-agent/pull/275) | merged | 2026-09-30 | `main` | feat(remote): interrupt subagents from Aiden On The Go (contract revision 16) |
| [#274](https://github.com/sambitcreate/aiden-agent/pull/274) | closed | 2026-10-01 | `main` | docs(plans): refresh plan index and status for 0.50.0 |
| [#273](https://github.com/sambitcreate/aiden-agent/pull/273) | merged | 2026-09-30 | `main` | feat(approvals): once, this chat and always tool approval scopes |
| [#272](https://github.com/sambitcreate/aiden-agent/pull/272) | merged | 2026-09-30 | `main` | feat(chat): queue messages while compaction runs |
| [#271](https://github.com/sambitcreate/aiden-agent/pull/271) | merged | 2026-09-29 | `main` | feat(subagents): live child context window in subagent status |
| [#270](https://github.com/sambitcreate/aiden-agent/pull/270) | merged | 2026-09-29 | `main` | feat(ask-user): timed waits with late-reply handling |
| [#269](https://github.com/sambitcreate/aiden-agent/pull/269) | merged | 2026-09-28 | `main` | feat(transcript): sticky section headers, preparing tool stage, turn footers |
| [#268](https://github.com/sambitcreate/aiden-agent/pull/268) | merged | 2026-09-29 | `main` | feat(mobile): remember model, provider and thinking level per paired Mac |
| [#267](https://github.com/sambitcreate/aiden-agent/pull/267) | merged | 2026-09-30 | `main` | feat(dictation): warn when macOS Secure Input blocks paste |
| [#266](https://github.com/sambitcreate/aiden-agent/pull/266) | merged | 2026-09-29 | `main` | feat(subagents): show a waiting child's pending question instead of "Needs attention." |
| [#265](https://github.com/sambitcreate/aiden-agent/pull/265) | merged | 2026-09-30 | `main` | feat(appearance): add a chat width setting |
| [#264](https://github.com/sambitcreate/aiden-agent/pull/264) | merged | 2026-09-30 | `main` | fix(mcp): normalize schemars numeric formats in tool input schemas |
| [#263](https://github.com/sambitcreate/aiden-agent/pull/263) | merged | 2026-09-28 | `main` | fix(devices): prefer device tools without banning shell simulator tooling |
| [#262](https://github.com/sambitcreate/aiden-agent/pull/262) | merged | 2026-09-30 | `main` | fix(bots): never raise the macOS "Keychain Not Found" prompt |
| [#261](https://github.com/sambitcreate/aiden-agent/pull/261) | merged | 2026-09-29 | `main` | fix: prevent chat failures on Macs without Xcode |
| [#260](https://github.com/sambitcreate/aiden-agent/pull/260) | merged | 2026-09-26 | `main` | test(e2e): clear the onboarding toast before driving Environment tabs |
| [#259](https://github.com/sambitcreate/aiden-agent/pull/259) | merged | 2026-09-26 | `main` | ci(catalog): publish the models.dev snapshot with a deploy key |
| [#258](https://github.com/sambitcreate/aiden-agent/pull/258) | merged | 2026-09-26 | `main` | ci(ios): run Aiden On The Go XCTest on a hosted simulator |
| [#257](https://github.com/sambitcreate/aiden-agent/pull/257) | merged | 2026-09-26 | `main` | docs(agents): add PR, CI, and branch hygiene rules |
| [#256](https://github.com/sambitcreate/aiden-agent/pull/256) | merged | 2026-09-26 | `main` | Release Aiden Agent 0.50.0 |
| [#255](https://github.com/sambitcreate/aiden-agent/pull/255) | merged | 2026-09-26 | `main` | Carry remaining #217 mobile stream-recovery work onto main |
| [#254](https://github.com/sambitcreate/aiden-agent/pull/254) | merged | 2026-09-26 | `main` | fix(linux): reveal chat shortcut hints on the primary modifier |
| [#253](https://github.com/sambitcreate/aiden-agent/pull/253) | merged | 2026-09-26 | `main` | Add rich link previews to Chats and Bots |
| [#252](https://github.com/sambitcreate/aiden-agent/pull/252) | merged | 2026-09-26 | `main` | feat(devices): iOS Simulator environment tab (Phases 0–7) |
| [#251](https://github.com/sambitcreate/aiden-agent/pull/251) | merged | 2026-09-26 | `main` | feat(on-the-go): mid-flight operations — steer/queue, questions, skills, quiet chat, perf |
| [#250](https://github.com/sambitcreate/aiden-agent/pull/250) | merged | 2026-09-26 | `main` | Pin chats and task lists to the latest content on open |
| [#249](https://github.com/sambitcreate/aiden-agent/pull/249) | merged | 2026-09-26 | `main` | Fix Environment Browser Google sign-in and overlay blanking |
| [#248](https://github.com/sambitcreate/aiden-agent/pull/248) | merged | 2026-09-26 | `main` | Keep todo steps clear of chat content at the bottom |
| [#247](https://github.com/sambitcreate/aiden-agent/pull/247) | merged | 2026-09-26 | `main` | feat(subagents): implementer role with Full/Ask run-scoped write and shell grants |
| [#246](https://github.com/sambitcreate/aiden-agent/pull/246) | merged | 2026-09-26 | `main` | chore(pi): bump @earendil-works/pi-* 0.84.4 → 0.87.1 and migrate transcript system prompts |
| [#245](https://github.com/sambitcreate/aiden-agent/pull/245) | merged | 2026-09-26 | `main` | feat: add Gemini read-aloud with desktop-owned native playback |
| [#244](https://github.com/sambitcreate/aiden-agent/pull/244) | merged | 2026-09-26 | `main` | Recover oversized compaction summaries and log safe causes |
| [#243](https://github.com/sambitcreate/aiden-agent/pull/243) | merged | 2026-09-26 | `main` | Add SQLite ledger and lease foundation for durable Bot runs |
| [#242](https://github.com/sambitcreate/aiden-agent/pull/242) | merged | 2026-09-26 | `main` | Integrate native stream recovery and repair persistence/control regressions |
| [#241](https://github.com/sambitcreate/aiden-agent/pull/241) | merged | 2026-09-26 | `main` | docs: ban tautological tests in AGENTS.md and drop CLAUDE.md |
| [#240](https://github.com/sambitcreate/aiden-agent/pull/240) | merged | 2026-09-26 | `main` | Add explicit busy chat composer controls |
| [#239](https://github.com/sambitcreate/aiden-agent/pull/239) | merged | 2026-09-23 | `main` | Release Aiden Agent 0.43.0 |
| [#238](https://github.com/sambitcreate/aiden-agent/pull/238) | merged (feature base) | 2026-09-26 | `feature/ios-rename-response-ownership` | Preserve iOS Home pages across competing responses and local edits |
| [#237](https://github.com/sambitcreate/aiden-agent/pull/237) | merged | 2026-09-23 | `main` | test(git): synchronize post-push cancellation fixture |
| [#236](https://github.com/sambitcreate/aiden-agent/pull/236) | merged (feature base) | 2026-09-26 | `feature/ios-workspace-response-ownership` | fix(ios): preserve accepted rename titles and coherent chat revisions |
| [#235](https://github.com/sambitcreate/aiden-agent/pull/235) | merged | 2026-09-23 | `main` | Handle early shell helper stdin failures without uncaught errors |
| [#234](https://github.com/sambitcreate/aiden-agent/pull/234) | merged (feature base) | 2026-09-26 | `feature/ios-bot-response-ownership` | fix(ios): preserve newer detail state across workspace list responses |
| [#233](https://github.com/sambitcreate/aiden-agent/pull/233) | merged (feature base) | 2026-09-26 | `feature/mobile-stream-recovery` | Preserve iOS Bot navigation and live permission ownership |
| [#232](https://github.com/sambitcreate/aiden-agent/pull/232) | merged | 2026-09-23 | `main` | Refresh trusted AGENTS guidance at model turn boundaries |
| [#231](https://github.com/sambitcreate/aiden-agent/pull/231) | merged | 2026-09-23 | `main` | Stabilize detached shell fixture with a bounded readiness handshake |
| [#230](https://github.com/sambitcreate/aiden-agent/pull/230) | merged | 2026-09-23 | `main` | Add scoped MCP resource discovery and reads |
| [#229](https://github.com/sambitcreate/aiden-agent/pull/229) | merged | 2026-09-23 | `main` | Scope MCP service guidance to admitted generation tools |
| [#228](https://github.com/sambitcreate/aiden-agent/pull/228) | merged | 2026-09-23 | `main` | Fix semantic compaction budgets for small model contexts |
| [#227](https://github.com/sambitcreate/aiden-agent/pull/227) | merged (feature base) | 2026-09-26 | `feature/mobile-response-ownership` | Preserve Android turn receipts across response ownership changes |
| [#226](https://github.com/sambitcreate/aiden-agent/pull/226) | merged | 2026-09-23 | `main` | Preserve advertised MCP capabilities in connection status |
| [#225](https://github.com/sambitcreate/aiden-agent/pull/225) | merged (feature base) | 2026-09-26 | `feature/mobile-stream-recovery` | Fence Android chat reads and Home summary admission |
| [#224](https://github.com/sambitcreate/aiden-agent/pull/224) | merged | 2026-09-23 | `main` | Chronological chat activity and smoother streaming motion |
| [#223](https://github.com/sambitcreate/aiden-agent/pull/223) | closed | 2026-10-02 | `main` | Add capability-gated native Bot Queue and Steer controls |
| [#222](https://github.com/sambitcreate/aiden-agent/pull/222) | merged | 2026-09-26 | `main` | Browse native workspace files with bounded lazy pages |
| [#221](https://github.com/sambitcreate/aiden-agent/pull/221) | merged | 2026-09-23 | `main` | Harden managed worktree creation and restore disk admission |
| [#220](https://github.com/sambitcreate/aiden-agent/pull/220) | closed | 2026-10-01 | `main` | Add shared active-run input admission and true steering |
| [#219](https://github.com/sambitcreate/aiden-agent/pull/219) | merged | 2026-09-23 | `main` | Add scoped tool output recovery and produced-file provenance |
| [#218](https://github.com/sambitcreate/aiden-agent/pull/218) | merged | 2026-09-23 | `main` | Harden native approval and Stop controls |
| [#217](https://github.com/sambitcreate/aiden-agent/pull/217) | closed | 2026-09-26 | `main` | Fix native stream replay and optimistic send recovery |
| [#216](https://github.com/sambitcreate/aiden-agent/pull/216) | merged | 2026-09-23 | `main` | Harden Telegram busy input and canonical Bot controls |
| [#215](https://github.com/sambitcreate/aiden-agent/pull/215) | merged | 2026-09-23 | `main` | Fix model-bound compaction pressure and concurrent startup recovery |
| [#214](https://github.com/sambitcreate/aiden-agent/pull/214) | merged | 2026-09-23 | `main` | Honor model and user skill invocation permissions |
| [#213](https://github.com/sambitcreate/aiden-agent/pull/213) | merged | 2026-09-23 | `main` | Fix pending attachment cleanup across chat deletion |
| [#212](https://github.com/sambitcreate/aiden-agent/pull/212) | closed | 2026-09-30 | `main` | chore: prepare 0.42.2 release |
| [#211](https://github.com/sambitcreate/aiden-agent/pull/211) | merged | 2026-09-22 | `main` | test: stabilize 0.42.2 release gates |
| [#210](https://github.com/sambitcreate/aiden-agent/pull/210) | merged | 2026-09-21 | `main` | Release Aiden Agent 0.42.1 |
| [#209](https://github.com/sambitcreate/aiden-agent/pull/209) | merged | 2026-09-21 | `main` | Keep Bot managed homes operational across volume remounts |
| [#208](https://github.com/sambitcreate/aiden-agent/pull/208) | merged | 2026-09-21 | `main` | Restore controls for revisited active chats |
| [#207](https://github.com/sambitcreate/aiden-agent/pull/207) | merged | 2026-09-21 | `main` | Preserve partial subagent findings at read-only turn limits |
| [#206](https://github.com/sambitcreate/aiden-agent/pull/206) | merged | 2026-09-26 | `main` | Keep truncation notice on failed turn-limit subagent findings |
| [#205](https://github.com/sambitcreate/aiden-agent/pull/205) | closed | 2026-09-26 | `main` | Fix Bot managed homes after filesystem remount |
| [#204](https://github.com/sambitcreate/aiden-agent/pull/204) | merged | 2026-09-26 | `main` | Fix agent CLI PATH for macOS GUI launches |
| [#203](https://github.com/sambitcreate/aiden-agent/pull/203) | merged | 2026-09-26 | `main` | Move Subagents roster above details |
| [#200](https://github.com/sambitcreate/aiden-agent/pull/200) | merged (feature base) | 2026-09-26 | `devin/1789967380-simplified-theme-picker` | Simplify mobile appearance settings to theme tile pickers |
| [#199](https://github.com/sambitcreate/aiden-agent/pull/199) | merged | 2026-09-26 | `main` | Simplify Appearance settings to a theme tile picker |
| [#198](https://github.com/sambitcreate/aiden-agent/pull/198) | merged | 2026-09-21 | `main` | feat(ios): restore attachment picker and camera |
| [#197](https://github.com/sambitcreate/aiden-agent/pull/197) | closed | 2026-09-30 | `main` | docs: plan for PostHog anonymous analytics on desktop + mobile |
| [#196](https://github.com/sambitcreate/aiden-agent/pull/196) | closed | 2026-09-30 | `main` | iOS: adopt published ThinkingOrbs Swift package, drop vendored port |
| [#195](https://github.com/sambitcreate/aiden-agent/pull/195) | merged | 2026-09-23 | `main` | Add local form scorer groundwork; block unsafe document-unbound filling |
| [#193](https://github.com/sambitcreate/aiden-agent/pull/193) | closed | 2026-09-26 | `devin/1789865426-worktree-snapshot-delete` | Restore snapshotted managed worktrees without polluting branch history |
| [#192](https://github.com/sambitcreate/aiden-agent/pull/192) | closed | 2026-09-26 | `devin/1789865426-worktree-provisioning` | Snapshot dirty managed worktrees before deletion |
| [#191](https://github.com/sambitcreate/aiden-agent/pull/191) | closed | 2026-09-26 | `devin/1789865426-worktree-safe-creation` | Provision managed worktrees from .worktreeinclude and gate the setup script |
| [#190](https://github.com/sambitcreate/aiden-agent/pull/190) | closed | 2026-09-26 | `devin/1789865426-worktree-lifecycle-contracts` | Disable repository automation and require disk admission for managed worktrees |
| [#189](https://github.com/sambitcreate/aiden-agent/pull/189) | closed | 2026-09-26 | `main` | Add managed worktree lifecycle contracts (snapshot registry, journal snapshot fields) |
| [#188](https://github.com/sambitcreate/aiden-agent/pull/188) | merged | 2026-09-26 | `main` | Add Aiden Agent e2e testing skill for Linux VMs |
| [#187](https://github.com/sambitcreate/aiden-agent/pull/187) | merged | 2026-09-26 | `main` | feat: composer context meter |
| [#186](https://github.com/sambitcreate/aiden-agent/pull/186) | merged | 2026-09-26 | `main` | Remove duplicate Compacted context activity disclosure |
| [#185](https://github.com/sambitcreate/aiden-agent/pull/185) | merged | 2026-09-21 | `main` | feat: P0 managed worktree lifecycle (issue #118) |
| [#184](https://github.com/sambitcreate/aiden-agent/pull/184) | merged | 2026-09-23 | `main` | feat: durable chat pull request links |
| [#183](https://github.com/sambitcreate/aiden-agent/pull/183) | merged | 2026-09-20 | `main` | Allow large Pullfrog reviews to finish |
| [#182](https://github.com/sambitcreate/aiden-agent/pull/182) | closed | 2026-09-30 | `main` | chat: unblock composer during detached drain; resurrect missing chats as drafts |
| [#181](https://github.com/sambitcreate/aiden-agent/pull/181) | merged | 2026-09-20 | `main` | Release Aiden Agent 0.42.0 |
| [#180](https://github.com/sambitcreate/aiden-agent/pull/180) | merged | 2026-09-20 | `main` | test: wait for Settings sidebar layout after resizing |
| [#179](https://github.com/sambitcreate/aiden-agent/pull/179) | merged | 2026-09-20 | `main` | Fix Quick View menu focus hiding the selected Environment tool |
| [#178](https://github.com/sambitcreate/aiden-agent/pull/178) | merged | 2026-09-20 | `main` | fix: preserve window restore state when quitting minimized |
| [#177](https://github.com/sambitcreate/aiden-agent/pull/177) | merged | 2026-09-20 | `main` | fix: discover and launch external editors on Linux |
| [#176](https://github.com/sambitcreate/aiden-agent/pull/176) | merged | 2026-09-20 | `main` | fix: keep profile sharing bound to its initiating window |
| [#175](https://github.com/sambitcreate/aiden-agent/pull/175) | merged | 2026-09-20 | `main` | test: repair baseline Computer Use startup deadline fixture |
| [#174](https://github.com/sambitcreate/aiden-agent/pull/174) | merged | 2026-09-20 | `main` | fix(android): preserve recovered drafts after failed sends |
| [#173](https://github.com/sambitcreate/aiden-agent/pull/173) | merged | 2026-09-20 | `main` | fix(ios): preserve composer edits during draft restoration |
| [#172](https://github.com/sambitcreate/aiden-agent/pull/172) | merged | 2026-09-20 | `main` | fix: keep suggested chat export filenames visible |
| [#171](https://github.com/sambitcreate/aiden-agent/pull/171) | merged | 2026-09-20 | `main` | Keep scheduled task results intact when notifications fail |
| [#170](https://github.com/sambitcreate/aiden-agent/pull/170) | merged | 2026-09-20 | `main` | fix: keep disposed Bot skill watchers closed |
| [#169](https://github.com/sambitcreate/aiden-agent/pull/169) | merged | 2026-09-20 | `main` | harden: close tool approval admission after cancellation |
| [#168](https://github.com/sambitcreate/aiden-agent/pull/168) | merged | 2026-09-20 | `main` | Fix obsolete catalogs across account changes and refresh modes |
| [#167](https://github.com/sambitcreate/aiden-agent/pull/167) | merged | 2026-09-20 | `main` | Fix Telegram HTML chunk integrity for long replies |
| [#166](https://github.com/sambitcreate/aiden-agent/pull/166) | merged | 2026-09-20 | `main` | Fix diagnostic journal deletion racing accepted writes and exports |
| [#165](https://github.com/sambitcreate/aiden-agent/pull/165) | merged | 2026-09-20 | `main` | Keep floating Environment controls clear of the Live launcher |
| [#164](https://github.com/sambitcreate/aiden-agent/pull/164) | merged | 2026-09-20 | `main` | Fix stale browser crash recovery reloading newer pages |
| [#163](https://github.com/sambitcreate/aiden-agent/pull/163) | merged | 2026-09-20 | `main` | Fix deleted diagnostic health history returning during concurrent flushes |
| [#162](https://github.com/sambitcreate/aiden-agent/pull/162) | merged | 2026-09-20 | `main` | Fix workspace editor size limit bypass during file growth |
| [#161](https://github.com/sambitcreate/aiden-agent/pull/161) | merged | 2026-09-20 | `main` | Fix remote SSE backpressure and stalled connection cleanup |
| [#160](https://github.com/sambitcreate/aiden-agent/pull/160) | merged | 2026-09-20 | `main` | Fix updater work continuing after shutdown disposal |
| [#159](https://github.com/sambitcreate/aiden-agent/pull/159) | merged | 2026-09-20 | `main` | Fix late voice transcription requests after timeout |
| [#158](https://github.com/sambitcreate/aiden-agent/pull/158) | merged | 2026-09-20 | `main` | Fix cancelled provider credential operations mutating stored sign-in |
| [#157](https://github.com/sambitcreate/aiden-agent/pull/157) | merged | 2026-09-20 | `main` | Fix Telegram final delivery after unchanged or missing previews |
| [#156](https://github.com/sambitcreate/aiden-agent/pull/156) | merged | 2026-09-20 | `main` | fix(ios): preserve SSE replay cursors across incomplete frames |
| [#155](https://github.com/sambitcreate/aiden-agent/pull/155) | merged | 2026-09-20 | `main` | Fix stale renderer crash readiness regression assertions |
| [#154](https://github.com/sambitcreate/aiden-agent/pull/154) | merged | 2026-09-20 | `main` | Fix Android SSE replay state on truncated frames |
| [#153](https://github.com/sambitcreate/aiden-agent/pull/153) | merged | 2026-09-20 | `main` | Fix command palette keyboard selection for duplicate labels |
| [#152](https://github.com/sambitcreate/aiden-agent/pull/152) | merged | 2026-09-20 | `main` | fix(android): cancel REST body reads and close rejected responses |
| [#151](https://github.com/sambitcreate/aiden-agent/pull/151) | merged | 2026-09-20 | `main` | Fix YAML skill descriptions and nested metadata identity collisions |
| [#150](https://github.com/sambitcreate/aiden-agent/pull/150) | merged | 2026-09-20 | `main` | Fix stale composer attachment completion and capacity races |
| [#149](https://github.com/sambitcreate/aiden-agent/pull/149) | merged | 2026-09-20 | `main` | Fix re-approval of expired memory facts |
| [#148](https://github.com/sambitcreate/aiden-agent/pull/148) | merged | 2026-09-20 | `main` | Fix scheduled-task startup races with disable and restart |
| [#147](https://github.com/sambitcreate/aiden-agent/pull/147) | merged | 2026-09-20 | `main` | Fix web search hangs during response cleanup |
| [#146](https://github.com/sambitcreate/aiden-agent/pull/146) | merged | 2026-09-20 | `main` | Fix managed worktree creation racing an external checkout |
| [#145](https://github.com/sambitcreate/aiden-agent/pull/145) | merged | 2026-09-20 | `main` | Restore prior context when compaction checkpoint publication fails |
| [#144](https://github.com/sambitcreate/aiden-agent/pull/144) | merged | 2026-09-20 | `main` | fix(browser): honor Linux profile configuration directories |
| [#143](https://github.com/sambitcreate/aiden-agent/pull/143) | merged | 2026-09-20 | `main` | Fix subagent inference shutdown escalation and ownership |
| [#142](https://github.com/sambitcreate/aiden-agent/pull/142) | merged | 2026-09-20 | `main` | Fix terminal startup output loss and concurrent session admission |
| [#141](https://github.com/sambitcreate/aiden-agent/pull/141) | merged | 2026-09-20 | `main` | Fix Codex cancellation during stalled request hooks |
| [#140](https://github.com/sambitcreate/aiden-agent/pull/140) | merged | 2026-09-20 | `main` | fix(mcp): recover discovery after cached transport closes |
| [#139](https://github.com/sambitcreate/aiden-agent/pull/139) | merged | 2026-09-23 | `main` | Reduce CI feedback time with complete test sharding and conservative gates |
| [#138](https://github.com/sambitcreate/aiden-agent/pull/138) | merged | 2026-09-17 | `main` | Stabilize draft migration E2E relaunch seeding |
| [#137](https://github.com/sambitcreate/aiden-agent/pull/137) | merged | 2026-09-17 | `main` | Enable voice-only Aiden Live by default in 0.41.5 |
| [#136](https://github.com/sambitcreate/aiden-agent/pull/136) | merged | 2026-09-17 | `main` | Clear cancelled Aiden Live picker state before 0.41.4 |
| [#135](https://github.com/sambitcreate/aiden-agent/pull/135) | merged | 2026-09-17 | `main` | Fix Aiden Live screen-capture lifecycle before 0.41.4 |
| [#134](https://github.com/sambitcreate/aiden-agent/pull/134) | merged | 2026-09-17 | `main` | Aiden Live screen sharing, audio polish, and 0.41.4 |
| [#133](https://github.com/sambitcreate/aiden-agent/pull/133) | closed | 2026-09-30 | `main` | Add Cursor as an Aiden-owned Pi provider via pi-cursor-sdk |
| [#132](https://github.com/sambitcreate/aiden-agent/pull/132) | merged | 2026-09-16 | `main` | Aiden Live voice actions and 0.41.3 |
| [#131](https://github.com/sambitcreate/aiden-agent/pull/131) | merged | 2026-09-16 | `main` | Aiden Live workspace and 0.41.2 |
| [#130](https://github.com/sambitcreate/aiden-agent/pull/130) | merged | 2026-09-16 | `main` | Release Aiden Agent 0.41.1 |
| [#129](https://github.com/sambitcreate/aiden-agent/pull/129) | merged | 2026-09-15 | `main` | Replace Aiden Assistant with Gemini Live orb |
| [#128](https://github.com/sambitcreate/aiden-agent/pull/128) | merged | 2026-09-26 | `main` | feat: type-to-focus composer and Command-hold chat shortcut hints |
| [#127](https://github.com/sambitcreate/aiden-agent/pull/127) | merged | 2026-09-15 | `main` | Release Aiden Agent 0.41.0 |
| [#126](https://github.com/sambitcreate/aiden-agent/pull/126) | merged | 2026-09-15 | `main` | Harden mobile progress contracts and roster recovery |
| [#125](https://github.com/sambitcreate/aiden-agent/pull/125) | merged | 2026-09-15 | `main` | Fix Android SDK setup after tools retirement |
| [#124](https://github.com/sambitcreate/aiden-agent/pull/124) | closed | 2026-09-15 | `feature/mobile-task-progress-subagents` | Harden mobile progress contracts and roster recovery |
| [#123](https://github.com/sambitcreate/aiden-agent/pull/123) | merged | 2026-09-15 | `main` | Add mobile task progress and subagent inspection |
| [#122](https://github.com/sambitcreate/aiden-agent/pull/122) | closed | 2026-09-30 | `main` | Align ask-user-question composer with lettered A–D card |
| [#121](https://github.com/sambitcreate/aiden-agent/pull/121) | merged | 2026-09-26 | `main` | feat(cli): standalone Aiden CLI with daemon, QR pairing, notifications, and shared memory |
| [#120](https://github.com/sambitcreate/aiden-agent/pull/120) | merged | 2026-09-15 | `main` | Refine durable todo visibility and scope |
| [#119](https://github.com/sambitcreate/aiden-agent/pull/119) | closed | 2026-09-30 | `main` | test(ios): fix Phase 6 suite failures and add Live Activity state coverage |
| [#117](https://github.com/sambitcreate/aiden-agent/pull/117) | merged | 2026-09-13 | `main` | Release Aiden Agent 0.40.1 |
| [#116](https://github.com/sambitcreate/aiden-agent/pull/116) | merged | 2026-09-26 | `main` | Remove onboarding Web Search card and add Other ways icons |
| [#115](https://github.com/sambitcreate/aiden-agent/pull/115) | merged | 2026-09-13 | `main` | Fix stale background response state after renderer recovery |
| [#114](https://github.com/sambitcreate/aiden-agent/pull/114) | merged | 2026-09-13 | `main` | fix(providers): send OpenCode session attribution header |
| [#113](https://github.com/sambitcreate/aiden-agent/pull/113) | merged | 2026-09-13 | `main` | Harden MCP transport and result handling |
| [#112](https://github.com/sambitcreate/aiden-agent/pull/112) | merged | 2026-09-13 | `main` | Add custom provider model selection and capability options |
| [#111](https://github.com/sambitcreate/aiden-agent/pull/111) | merged | 2026-09-13 | `main` | Surface GitHub PR checks in the sidebar |
| [#110](https://github.com/sambitcreate/aiden-agent/pull/110) | merged | 2026-09-13 | `main` | Fix task-state availability and production diagnostics |
| [#109](https://github.com/sambitcreate/aiden-agent/pull/109) | merged | 2026-09-11 | `main` | Release Aiden Agent 0.40.0 |
| [#108](https://github.com/sambitcreate/aiden-agent/pull/108) | merged (feature base) | 2026-09-11 | `feature/google-legacy-catalog-policy` | Verify Google catalog exclusions reach mobile clients |
| [#107](https://github.com/sambitcreate/aiden-agent/pull/107) | merged | 2026-09-11 | `main` | Exclude legacy Gemini families from Google chat catalogs |
| [#106](https://github.com/sambitcreate/aiden-agent/pull/106) | merged | 2026-09-11 | `main` | Make composer access and thinking menus opaque |
| [#105](https://github.com/sambitcreate/aiden-agent/pull/105) | merged | 2026-09-11 | `main` | fix: scheduled-task provider resolution, journalless Pi rollout generation, remote 4xx evidence |
| [#104](https://github.com/sambitcreate/aiden-agent/pull/104) | merged | 2026-09-11 | `main` | Add desktop peer connection foundation |
| [#103](https://github.com/sambitcreate/aiden-agent/pull/103) | merged | 2026-09-11 | `main` | Keep new agent chats as drafts until the first message is sent |
| [#102](https://github.com/sambitcreate/aiden-agent/pull/102) | merged | 2026-09-11 | `main` | Fix custom provider icons in the model picker and Model Pad |
| [#101](https://github.com/sambitcreate/aiden-agent/pull/101) | merged | 2026-09-11 | `main` | Fix Settings switch geometry and stabilize Model Pad chrome |
| [#100](https://github.com/sambitcreate/aiden-agent/pull/100) | merged | 2026-09-08 | `main` | Release Aiden Agent 0.39.0 |
| [#99](https://github.com/sambitcreate/aiden-agent/pull/99) | merged | 2026-09-08 | `main` | Add shared Environment browser with progressive agent tools |
| [#98](https://github.com/sambitcreate/aiden-agent/pull/98) | closed | 2026-09-08 | `main` | Fix Remote Access IPC errors and set October 2026 public dates |
| [#97](https://github.com/sambitcreate/aiden-agent/pull/97) | merged | 2026-09-08 | `main` | Unify Settings, fit Model Pad, and add global Skills controls |
| [#96](https://github.com/sambitcreate/aiden-agent/pull/96) | merged | 2026-09-11 | `main` | Simplify setup journeys with guided phone pairing and bot creation |
| [#95](https://github.com/sambitcreate/aiden-agent/pull/95) | merged | 2026-09-08 | `main` | Add queued-message controls and shared squircle styling |
| [#94](https://github.com/sambitcreate/aiden-agent/pull/94) | closed | 2026-09-08 | `main` | Fix Model Pad picker overlap and double focus chrome |
| [#93](https://github.com/sambitcreate/aiden-agent/pull/93) | merged | 2026-09-05 | `main` | Fix keychain signing for the 0.38.1 macOS release |
| [#92](https://github.com/sambitcreate/aiden-agent/pull/92) | merged | 2026-09-04 | `main` | Release Aiden Agent 0.38.0 |
| [#91](https://github.com/sambitcreate/aiden-agent/pull/91) | merged | 2026-09-05 | `main` | Add selectable LLM and experimental pi-vcc compaction |
| [#90](https://github.com/sambitcreate/aiden-agent/pull/90) | merged | 2026-09-04 | `main` | Polish borderless controls, accessible focus, and theme previews |
| [#89](https://github.com/sambitcreate/aiden-agent/pull/89) | merged (feature base) | 2026-09-12 | `feature/linux-desktop-support` | fix(linux): Wayland Vulkan warning and Tailscale pairing/connect errors |
| [#85](https://github.com/sambitcreate/aiden-agent/pull/85) | closed | 2026-09-30 | `main` | Design Studio: durable exploration, verified prototypes, and reviewed handoff |
| [#84](https://github.com/sambitcreate/aiden-agent/pull/84) | merged | 2026-09-04 | `main` | Publish Android APK artifacts only from main |
| [#83](https://github.com/sambitcreate/aiden-agent/pull/83) | merged | 2026-09-04 | `main` | Fix Figma MCP authorize 403 and hosted catalog auth |
| [#82](https://github.com/sambitcreate/aiden-agent/pull/82) | merged | 2026-09-04 | `main` | Add independent Quick View and Environment tools |
| [#81](https://github.com/sambitcreate/aiden-agent/pull/81) | merged | 2026-09-11 | `main` | Replace xterm.js with Ghostty libghostty-vt in the workspace terminal |
| [#80](https://github.com/sambitcreate/aiden-agent/pull/80) | merged | 2026-09-01 | `main` | Make durable memory agent-driven and configurable |
| [#79](https://github.com/sambitcreate/aiden-agent/pull/79) | closed | 2026-09-12 | `main` | Design Workspace: local-first projects and dedicated Design mode |
| [#78](https://github.com/sambitcreate/aiden-agent/pull/78) | merged | 2026-09-01 | `main` | fix: make subagent migration reboot-safe |
| [#77](https://github.com/sambitcreate/aiden-agent/pull/77) | merged | 2026-09-01 | `main` | Release 0.37.0 |
| [#76](https://github.com/sambitcreate/aiden-agent/pull/76) | merged | 2026-09-01 | `main` | Fix production subagent failure recovery |
| [#75](https://github.com/sambitcreate/aiden-agent/pull/75) | merged | 2026-09-01 | `main` | Add Codex official plugins to the Settings Plugins page |
| [#74](https://github.com/sambitcreate/aiden-agent/pull/74) | merged | 2026-09-01 | `main` | Upgrade Pi compaction, journal migration, and durable memory |
| [#73](https://github.com/sambitcreate/aiden-agent/pull/73) | merged | 2026-08-30 | `main` | Make scheduled tasks chat-native across clients |
| [#72](https://github.com/sambitcreate/aiden-agent/pull/72) | merged | 2026-09-01 | `main` | Unify workspace and chat navigation across clients |
| [#71](https://github.com/sambitcreate/aiden-agent/pull/71) | merged | 2026-09-26 | `main` | feat(linux): bring desktop support up to date |
| [#70](https://github.com/sambitcreate/aiden-agent/pull/70) | merged | 2026-08-30 | `main` | Integrate native rpiv extensions and question composer |
| [#69](https://github.com/sambitcreate/aiden-agent/pull/69) | merged | 2026-08-30 | `main` | Release Aiden Agent 0.36.0 |
| [#68](https://github.com/sambitcreate/aiden-agent/pull/68) | merged | 2026-08-30 | `main` | Add provider model visibility and catalog refresh controls |
| [#67](https://github.com/sambitcreate/aiden-agent/pull/67) | merged | 2026-08-30 | `main` | Stabilize scrollbars, focus styling, and menu hierarchy |
| [#66](https://github.com/sambitcreate/aiden-agent/pull/66) | merged | 2026-08-28 | `main` | Release Aiden Agent 0.35.77 |
| [#65](https://github.com/sambitcreate/aiden-agent/pull/65) | merged | 2026-08-28 | `main` | Fix packaged Tailscale CLI detection |
| [#64](https://github.com/sambitcreate/aiden-agent/pull/64) | merged | 2026-08-28 | `main` | Honor exact declared release versions |
| [#63](https://github.com/sambitcreate/aiden-agent/pull/63) | merged | 2026-08-28 | `main` | Fix Generative UI containment in macOS release CI |
| [#62](https://github.com/sambitcreate/aiden-agent/pull/62) | merged | 2026-08-28 | `main` | Upgrade local logging and diagnostics for 0.35 |
| [#61](https://github.com/sambitcreate/aiden-agent/pull/61) | merged | 2026-08-28 | `main` | Add chat-scoped Generative UI HTML artifacts |
| [#60](https://github.com/sambitcreate/aiden-agent/pull/60) | merged | 2026-08-27 | `main` | Refine composer and palette controls |
| [#59](https://github.com/sambitcreate/aiden-agent/pull/59) | merged | 2026-08-26 | `main` | chore(release): publish 0.34.1 |
| [#58](https://github.com/sambitcreate/aiden-agent/pull/58) | merged | 2026-08-26 | `main` | Enable all provider credential flows in onboarding |
| [#57](https://github.com/sambitcreate/aiden-agent/pull/57) | merged | 2026-08-26 | `main` | Fix Remote dev port isolation and Tailscale Serve inspection |
| [#56](https://github.com/sambitcreate/aiden-agent/pull/56) | merged | 2026-08-26 | `main` | Harden Gemini voice setup and dictation delivery |
| [#55](https://github.com/sambitcreate/aiden-agent/pull/55) | merged | 2026-08-26 | `main` | ci: skip Android build for unrelated changes |
| [#54](https://github.com/sambitcreate/aiden-agent/pull/54) | merged | 2026-08-26 | `main` | chore(release): start 0.34 line |
| [#53](https://github.com/sambitcreate/aiden-agent/pull/53) | merged | 2026-08-26 | `main` | feat: upgrade Model Pad with OpenRouter benchmark insights |
| [#52](https://github.com/sambitcreate/aiden-agent/pull/52) | merged | 2026-08-26 | `main` | Add Gemini 3.5 live voice transcription |
| [#51](https://github.com/sambitcreate/aiden-agent/pull/51) | merged | 2026-08-26 | `main` | Use Aiden brand icons across chat surfaces |
| [#50](https://github.com/sambitcreate/aiden-agent/pull/50) | merged | 2026-08-26 | `main` | Improve response formatting and transcript typography |
| [#49](https://github.com/sambitcreate/aiden-agent/pull/49) | merged | 2026-08-26 | `main` | Brand ChatGPT authentication callback pages |
| [#48](https://github.com/sambitcreate/aiden-agent/pull/48) | merged | 2026-08-26 | `main` | Polish onboarding, buttons, and Tailscale setup |
| [#47](https://github.com/sambitcreate/aiden-agent/pull/47) | merged | 2026-08-26 | `main` | Fix Pi-style subagent reliability and mobile projection parity |
| [#46](https://github.com/sambitcreate/aiden-agent/pull/46) | merged | 2026-08-26 | `main` | fix(bots): unblock Custom create after catalog churn |
| [#45](https://github.com/sambitcreate/aiden-agent/pull/45) | merged | 2026-08-25 | `main` | fix(release): publish Electron 0.31.0 and document TestFlight |
| [#44](https://github.com/sambitcreate/aiden-agent/pull/44) | merged | 2026-08-25 | `main` | fix(images): harden staged artifact recovery |
| [#43](https://github.com/sambitcreate/aiden-agent/pull/43) | merged | 2026-08-25 | `main` | test(subagents): stabilize detached fixture PID polling |
| [#42](https://github.com/sambitcreate/aiden-agent/pull/42) | merged | 2026-08-25 | `main` | Improve dictation capture, paste, and on-device transcription isolation |
| [#41](https://github.com/sambitcreate/aiden-agent/pull/41) | merged | 2026-08-25 | `main` | feat(mobile): ship iOS, Android, and Bots companion apps |
| [#40](https://github.com/sambitcreate/aiden-agent/pull/40) | closed | 2026-08-25 | `feature/bots-and-ios` | docs: 2026-08-24 performance and efficiency deep dive |
| [#39](https://github.com/sambitcreate/aiden-agent/pull/39) | closed | 2026-08-25 | `feature/bots-and-ios` | docs: missing test coverage audit and iOS Remote caching plan |
| [#38](https://github.com/sambitcreate/aiden-agent/pull/38) | closed | 2026-08-22 | `main` | feat: add Pi-powered Bots mode with Telegram control |
| [#37](https://github.com/sambitcreate/aiden-agent/pull/37) | closed | 2026-09-30 | `main` | feat: complete Create Images Node Banana parity roadmap |
| [#36](https://github.com/sambitcreate/aiden-agent/pull/36) | merged | 2026-08-25 | `main` | feat: display Pi image artifacts inline |
| [#35](https://github.com/sambitcreate/aiden-agent/pull/35) | closed | 2026-08-25 | `main` | feat: harden Aiden On The Go setup and remote pairing |
| [#34](https://github.com/sambitcreate/aiden-agent/pull/34) | merged | 2026-08-17 | `main` | chore: enforce the legacy download redirect |
| [#33](https://github.com/sambitcreate/aiden-agent/pull/33) | merged | 2026-08-17 | `main` | fix: discover unpublished GitHub release drafts |
| [#32](https://github.com/sambitcreate/aiden-agent/pull/32) | merged | 2026-08-17 | `main` | fix: recover transient GitHub release publication |
| [#31](https://github.com/sambitcreate/aiden-agent/pull/31) | merged | 2026-08-17 | `main` | feat: match Pi thinking disclosure |
| [#30](https://github.com/sambitcreate/aiden-agent/pull/30) | merged | 2026-08-17 | `main` | Show active chats in the sidebar |
| [#29](https://github.com/sambitcreate/aiden-agent/pull/29) | merged | 2026-08-16 | `main` | test(e2e): honor bounded Electron shutdown |
| [#28](https://github.com/sambitcreate/aiden-agent/pull/28) | merged | 2026-08-16 | `main` | fix(pi): align compaction with upstream |
| [#27](https://github.com/sambitcreate/aiden-agent/pull/27) | merged | 2026-08-17 | `main` | Fix unintended generation cancellation on renderer lifecycle |
| [#26](https://github.com/sambitcreate/aiden-agent/pull/26) | merged | 2026-08-16 | `main` | Fix packaged subprocess lockdown verification |
| [#25](https://github.com/sambitcreate/aiden-agent/pull/25) | merged | 2026-08-16 | `main` | Harden Pi runtime harness and subagent execution |
| [#24](https://github.com/sambitcreate/aiden-agent/pull/24) | merged | 2026-08-15 | `main` | Harden Pi compaction, turn lifecycle, and session durability |
| [#23](https://github.com/sambitcreate/aiden-agent/pull/23) | merged | 2026-08-17 | `main` | feat: add Telegram remote control |
| [#22](https://github.com/sambitcreate/aiden-agent/pull/22) | merged | 2026-08-11 | `main` | Fix packaged terminal helper resolution |
| [#21](https://github.com/sambitcreate/aiden-agent/pull/21) | merged (feature base) | 2026-08-11 | `fix/terminal-posix-spawnp-mac` | feat(terminal): shell fallback retry + persisted sanitized history |
| [#20](https://github.com/sambitcreate/aiden-agent/pull/20) | merged (feature base) | 2026-08-11 | `feature/playwright-e2e-lmstudio-attachments` | fix(terminal): resolve 'posix_spawnp failed.' on macOS terminal creation |
| [#19](https://github.com/sambitcreate/aiden-agent/pull/19) | merged | 2026-08-11 | `main` | Add deterministic Electron E2E and harden local model attachments |
| [#18](https://github.com/sambitcreate/aiden-agent/pull/18) | merged | 2026-08-10 | `main` | Guard external release consumers |
| [#17](https://github.com/sambitcreate/aiden-agent/pull/17) | merged | 2026-08-10 | `main` | Add slash commands and active skill invocation |
| [#16](https://github.com/sambitcreate/aiden-agent/pull/16) | merged | 2026-08-10 | `main` | Fix stalled automatic update downloads |
| [#15](https://github.com/sambitcreate/aiden-agent/pull/15) | merged | 2026-08-09 | `main` | Ship complete onboarding flow for Aiden 0.28 |
| [#14](https://github.com/sambitcreate/aiden-agent/pull/14) | merged | 2026-08-09 | `main` | Harden macOS updates, microphone access, and Computer Use |
| [#13](https://github.com/sambitcreate/aiden-agent/pull/13) | merged | 2026-08-09 | `main` | fix: harden child compaction journal writes |
| [#12](https://github.com/sambitcreate/aiden-agent/pull/12) | merged | 2026-08-09 | `main` | feat: add Pi-native context compaction |
| [#11](https://github.com/sambitcreate/aiden-agent/pull/11) | merged | 2026-08-09 | `main` | feat: ship Assistant safety, subagent orchestration, and onboarding |
| [#10](https://github.com/sambitcreate/aiden-agent/pull/10) | merged (feature base) | 2026-08-06 | `features-jul30` | feat: add first-run onboarding flow |
| [#9](https://github.com/sambitcreate/aiden-agent/pull/9) | merged (feature base) | 2026-08-06 | `features-jul30` | Add first-run onboarding flow |
| [#8](https://github.com/sambitcreate/aiden-agent/pull/8) | closed | 2026-08-31 | `main` | Record the Xcode version in .xcode-version |
| [#7](https://github.com/sambitcreate/aiden-agent/pull/7) | closed | 2026-08-31 | `main` | Add a Nix dev shell so Node and Rust match CI |
| [#6](https://github.com/sambitcreate/aiden-agent/pull/6) | merged | 2026-07-30 | `main` | docs: add Homebrew install and generated release notes |
| [#5](https://github.com/sambitcreate/aiden-agent/pull/5) | merged | 2026-07-30 | `main` | fix: recover malformed split config startup |
| [#4](https://github.com/sambitcreate/aiden-agent/pull/4) | merged | 2026-07-29 | `main` | feat: add Aiden Assistant, native subagents, and unified commands |
| [#3](https://github.com/sambitcreate/aiden-agent/pull/3) | merged | 2026-07-29 | `main` | feat: portable Aiden config under ~/.aiden |
| [#2](https://github.com/sambitcreate/aiden-agent/pull/2) | merged | 2026-07-24 | `main` | Add Scheduled Tasks phases 3 and 4 |
| [#1](https://github.com/sambitcreate/aiden-agent/pull/1) | merged | 2026-07-24 | `main` | Use catalog-driven runtime model limits |
