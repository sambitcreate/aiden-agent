# Pi 1.0.3 upgrade and stack reconciliation

Status: active, 2026-10-05. Implementation integrated on `feature/pi-1.0.3-upgrade`; local acceptance complete; exact-head hosted acceptance and merge pending in [PR #357](https://github.com/sambitcreate/aiden-agent/pull/357). The plan was committed first as `9a5d67d7`. This supersedes the individual open stack PRs with one replacement PR, preserving their commit ancestry. Historical implementation evidence remains in [Pi parity](pi-1-parity-plan.md).

## Verified baseline

- Aiden main: `43d8adb02`, version 0.53.0, live desktop and standalone CLI pins 0.87.1.
- Pi target: exact 1.0.3, tag `v1.0.3`, commit `d78dc83d633229d12f8b79631384c4c2717c399f`. Read the local reference with `git -C /Users/sambitbiswas/projects/opp/pi show v1.0.3:<path>`; do not change its checkout or pin upstream main.
- Published 1.0.3 packages verified: pi-agent-core, pi-ai, pi-codemode, pi-coding-agent, chord, pi-mcp. pi-env@1.0.3 is unpublished; evaluate only.
- Foundation #299 at `aa337d714` conflicts with current main. #300 was merged into #299 and remains closed. Recorded #299 and #307 checks are green only for their old heads.
- Preserve the stack order: #299 runtime/CLI → #302 integrations → #301 compaction → #304 warming → #303 model tools → #306 classifier → #305 provider MCP → #307 inventory. Successors are clean against their current bases, not proven against current main.

## Boundaries

Keep host-managed Pi Agent children, Aiden journals and native plugin ports, OpenCode as a provider, Mac pairing authority, Ask/Full/None permissions and Remote approvals. No Pi fork, vendored source, pi-durable migration, Chord transport or virtual models. Keep manual-only models.dev/benchmark networking. The user explicitly authorized creating the replacement PR, watching exact-head CI, and auto-merging when green. Release publication and rollout advancement remain separate.

Live direct Pi dependencies move together to exact 1.0.3. The named `@aiden/pi-legacy-harness` alias remains on 0.87.1, with its compatible dependency subtree and SDK overrides. Preserve historical version records and migration fixtures; never globally replace 0.87.1 strings or force the legacy subtree onto new APIs.

## Execution

### 1. Reconcile the shared foundation

- [x] Fetch main and all stack refs; inspect worktrees and preserve unrelated work.
- [x] Commit this plan, update the inventory and project memory.
- [x] Merge `origin/main` into `codex/pi-1-runtime` without rebasing or force-pushing.
- [x] Resolve by retaining both current-main behavior and the legacy harness boundary. Pay special attention to chat forks, provider aliases, runtime context, CLI direct shared-source imports and worker packaging.
- [x] Union root test scripts and CI registry entries; preserve the newer main test runner. Keep root and CLI lockfiles reproducible.
- [x] Run root/CLI types, focused replay/compaction/session, provider, MCP, subagent and CLI tests before publishing or requesting review.
- [x] Superseded propagation: merge the reconciled foundation into a new branch based on #307, preserving the entire stack ancestry (`b0f4f5ce`). Other worktrees and PR branches remain untouched. Retire superseded PRs only after the replacement lands.

### 2. Upgrade the integrated stack to 1.0.3

- [x] On the reconciled tip, update direct live pins in root and CLI, OAuth branding version gate, runtime catalog freshness metadata and any worker/WASM packaging requirements.
- [x] Regenerate each lockfile using npm install (or npm install --package-lock-only), then validate with npm ci. npm ci is not a lockfile generator.
- [x] Ship the Azure migration in the same final upgrade acceptance boundary; a standalone pin bump is not releasable.
- [x] Preserve 0.87.1 journal reopen, backup, rollback and compaction compatibility; inspect real production bundle resolution of both versions.

### 3. Azure identity migration

- [x] Inventory all provider-keyed state before editing: encrypted desktop Pi credentials, Pi model cache, settings (last selection, hidden models and exact-model budgets), alias resolution, historical chats, Bots and schedules; CLI auth.json/models.json/settings.json under Aiden's actual configurable paths.
- [x] Map the built-in provider `azure-openai-responses` to `azure`. Keep API id `azure-openai-responses`, AZURE_OPENAI_* variables, custom connection intent and custom: IDs unchanged. Existing custom alias routes take precedence.
- [x] Define collision handling when both IDs exist; never overwrite a different credential/endpoint. Make migration restart-safe, idempotent and durable before consuming renamed identities; avoid partial updates or plaintext secret exposure.
- [x] Test encrypted credential reload, restart/idempotence, both-ID collisions, model preferences, existing chat/schedule resolution, CLI auth/config migration and custom-provider preservation with real stores and fixtures.
- [x] Update desktop/iOS/Android display aliases and subagent Azure environment selection. Inspect and run focused native suites; protocol revision changes only if the wire contract changes.

### 4. Integrate the remaining stable deltas

- [x] Codemode output caps are inherited from pi-codemode 1.0.1: verify runaway output terminates while retaining Aiden's smaller displayed-result limits and host approval/cancellation boundaries.
- [x] Image temp-file saving is implemented by the coding-agent extension, not the sandbox package. Verify CLI inheritance; explicitly adapt desktop image output through Aiden's private artifact lifecycle or record an intentional difference.
- [x] Anthropic inline tool changes and CIMD landed in 1.0.1. Desktop MCP uses @modelcontextprotocol/sdk, not Pi's OAuth interface: evaluate interoperability without mechanically renaming SDK methods. Explicitly decide CIMD support and project MCP overrides per client.
- [x] Thread samplingParamsByThinkingLevel through supported custom-model configuration, serialization and provider requests, with an independent request-level test; record any deliberate desktop defer instead of claiming parity.
- [x] Verify rotated OAuth tokens survive cancelled refresh through Aiden's encrypted store. Review callback branding against the published package.
- [x] Preserve existing stack features: approved image/classifier tools, local classifier opt-in, foreground-only warming, exact model compaction budgets, provider MCP grants, bounded pagination and native activity.
- [x] Review onboarding and design references for any newly shipped UI; preserve shipped gallery assets and keyboard/reduced-motion behavior.

### 5. Acceptance and documentation

- [x] Node 22.22.3: root and CLI type checks, lint, test:compaction, test:mcp, test:subagents, test:cli, focused provider/config recovery, test:ci-policy, full npm test and npm run build. Register new tests in CI; use behavioral tests, not production-source matching.
- [x] Run native suites for shared transcript/contracts and changed provider identity consumers. Verify CLI worker/WASM and Electron packaged sandbox wiring offline; distinguish unsigned/synthetic checks from signed/device acceptance.
- [ ] For an installed-candidate evaluation, supply absolute AIDEN_PI_UPGRADE_RECEIPT_DIR and AIDEN_PI_UPGRADE_EXECUTABLE to npm run test:compaction:evaluate. Local replay fixtures alone do not establish installed/signed acceptance. Do not run pi-upgrade:advance without deliberate rollout authorization, valid receipts and an explicit target stage.
- [ ] Revalidate exact-head hosted CI after main merges; never reuse old green results. A flaky rerun is still recorded as a bug, at most one rerun.
- [x] Update parity plan, pin memory, plan index and release notes with actual results and intentional client differences. Add a short pi-env evaluation note without production dependency or execution integration.
- [ ] Keep plans active until implementation and required acceptance finish; archive completed plans and update the index together. Do not claim hosted, signed, paid-provider or physical-device results that were not run.

## Progress log

- 2026-10-05: reviewed the proposed brief against current main, upstream tag/source, npm and GitHub. Corrected Azure migration coverage, desktop/CLI ownership of upstream changes, lockfile commands and replay receipt prerequisites. Beginning foundation reconciliation in this task's existing checkout; other task worktrees remain untouched.
- Foundation merge resolutions preserve main's lazy CLI entry and command dispatch, move native Pi MCP routing/migration into cli-runtime, and place the codemode worker and new OAuth providers into the single shared chunk graph. NewEntry and fork summary generation cross the frozen harness adapter; provider requests still use current Models. Existing behavioral suites caught and verified both the fork-summary import incompatibility and the moved OAuth bundle location.
- Main's new production-dependency graph test found the foundation's unused desktop pi-codemode dependency. Removed it and its premature unpack entries from #299. **When propagating to #302, explicitly restore exact pi-codemode plus codemode/QuickJS unpack entries with the desktop consumer**; a clean Git merge alone will not restore a dependency unchanged on the successor.
- Local checks passed: root/CLI/e2e types, lint, clean root/CLI installs, production desktop/CLI builds, compaction (22 VCC + 411 cases), MCP (130), provider/chat-copy checks (117), complete subagent script, CLI (74), CI policy (55), and real Electron chat-fork test (1). Initial broad unit run had one deterministic production-dependency failure, corrected above; no flaky rerun. All preserved modes (browser, generative UI Chromium, terminal coverage, iOS release policy, native helpers, Rust and CLI) passed. Final clean-install npm test passed end to end: all three unit lanes (6,820 cases, 6,818 passed, 2 skipped) plus all preserved modes, including the 74-test CLI suite. Hosted/signed/mobile-device/paid-provider/installed-rollout acceptance not claimed.

- Final integration: all live desktop/CLI Pi packages and OAuth branding gate are 1.0.3; clean installs regenerated both lockfiles. Frozen 0.87.1 remains separate. Azure migrations cover encrypted credentials (current identity wins, legacy ciphertext retained), desktop preferences, catalogs and historical resolution, and CLI global/project settings. Different CLI endpoint collisions fail closed. Native icon aliases and subagent environment handoff use Azure's new provider id.
- Sampling by thinking level is supported through bounded portable custom-model configuration, catalog normalization and actual provider requests. Arbitrary request fields are rejected. Tests verify off/high request differences, portable round trips, restart/collision handling, logout non-resurrection, OAuth rotation after cancellation and sandbox output overflow.
- See [release notes](../pi-1.0.3-release-notes.md) for intentional desktop image handling, deferred Aiden-managed CIMD/project MCP overrides, and exact-identity Bot grant reauthorization. Native Pi MCP/CLI behavior is inherited. The pi-env evaluation is in `.memory/pi-env-evaluation.md`; no runtime integration was added.
- Local integration checks to date: CLI 78/78, compaction 22 VCC plus 463 cases, MCP 174/174, full subagent scripts, CI policy 55/55, OAuth/approval 24/24, desktop build, focused Android model/chat/protocol tests and iOS chat/protocol simulator suites passed. iOS's signed-device-only test skipped by design. React Doctor reported 82/100, 13 warnings: test JSON-roundtrip oracles, intentionally ordered authority/tool operations, bounded lookups and a mixed export; no new actionable React defect established.
- The broad run caught a contradictory source-grep assertion brought over from main for the gallery's keyboard focus. Removed that assertion; the existing real Electron keyboard/reduced-motion/narrow-width gallery test is the behavioral oracle. Its assertions passed but its first local run hit a 35-second Electron shutdown timeout; rerun status and final full-suite results are recorded below/ in the PR. No timeouts or retry policy were relaxed.
- Merged current main `6a12fdc35` via `cbd3db949`; only catalog CI/workflow changes, no protocol/test-chain conflicts. Root/e2e types and lint pass. The gallery's sole rerun passed (4 seconds), so the original shutdown timeout is recorded as a local flake, not erased. The other 19 Electron cases passed on their first run. Final broad run follows this main merge.

- Final local acceptance after merging `6a12fdc35`: clean `npm test` passed all three unit lanes (6,991 cases; 6,989 pass, 2 skip), all preserved browser/generative-UI/terminal/native/Rust modes, and the 78-test CLI suite. Root, e2e and CLI types and lint passed. Full logs are `/tmp/pi103-full-test-final.log`; the original gallery teardown failure and sole passing rerun remain recorded. PR #357 is the exact-head CI/merge record. The plan stays active for hosted acceptance and the separately scoped installed-candidate release gates; do not infer signed acceptance from these local results.

- Final migration review found and closed a CLI cross-file collision: a legacy endpoint cannot inherit a different current Azure credential, including after encrypted credential migration retained the old entry. Endpoint publication shares the credential writer lease and fails before changing either configuration. The extended CLI suite passes 79/79; no timeout/retry changes.

- PR #357 review follow-up: complete JSON-quoted image prompts replace the 240-character disclosure preview; the shared desktop card supports keyboard scrolling and Remote image approvals remain deny-only. Saved MCP descriptions and discovery now share character validation without relaxing serialized byte budgets. Corrected the branding version-rejection oracle to 1.0.3. Behavioral approval/dispatch, Unicode inventory and native denial checks cover the changes; exact-head CI remains pending.

- Follow-up validation: 161 initial focused cases and branding suite passed; root types/lint, iOS chat and new Android approval cases passed. The final focused run passed 91/92, with an existing search-bounds test reaching the 5-second deadline before its 200-match cap. That case and a separate Android held-turn mock-response timeout each passed one isolated rerun. Both are recorded as local flakes in PR #357 and memory, alongside the original Electron teardown flake; no timeout/retry weakening. All new behavioral coverage passed.

- Recovery/main integration: GitHub's 2026-10-05 hosted-runner incident prevented steps from starting on head 7f9c4d65 (CI 37364260942, release consumer 37364260902, reviewer 37364264471). The incident resolved at 22:49 UTC. Before retrying, main advanced to 5c094875c (#349 Remote forks and #352 provider settings/native creation), so integrate it through a normal merge and validate the new head instead of spending retries on obsolete runs. Keep all historical failure evidence in PR #357.
- Main merge resolution retains both remote model test groups and moves the classifier reset handlers into main's Connection options controls. Existing classifier save coverage now uses main's Manage/Model options labels and also verifies that changing API format or deployment clears the opt-in. Test scripts are a union; main's protocol revision 22 and native/fixture contracts are unchanged by the Pi delta.

- Merge validation passed: 222 focused tests, CLI 79/79 and types, root/e2e types, lint/build, CI policy 55/55, Android remote/client/Bot contracts and iOS remote client/protocol tests. Electron 6/7 initially; provider-removal assertions passed but teardown exceeded 35 seconds, then its sole isolated rerun passed (31.7 seconds). Preserve this additional local flake in PR #357 and memory. No timeout/retry changes. Fresh hosted acceptance is still required.
