# Aiden integrated upstream audit — 12 September 2026

## Decision context and audit boundary

This report answers which of the ten supplied links require work in Aiden, what to change, and how to validate that work. The two MattDevy links point to one monorepo, so the list contains nine distinct projects/package sources.

The audited product is Aiden 0.40.0 at commit `a4c85c6d8`, in `/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent`. This is a fixed source snapshot, not an assertion about subsequent main-branch commits, other open worktrees, or a running installed application. Research clones are under `/Users/sambitbiswas/projects/opp`. Their refreshed commit identities are recorded below. Product source, dependency pins, credentials, deployed releases, and rollout stages were not changed by this audit.

Aiden embeds `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, both at **0.84.4**, and the MCP SDK at **1.30.0**. None of the supplied third-party plugin packages is a direct installed dependency. The meaningful maintenance scope is Aiden's native implementations that deliberately adopted ideas or contracts from those projects. Updating a research clone does not update the application.

The scope check used `package.json`, the lockfile, runtime imports, vendored resources, integration documentation, implementation history, and the existing upstream audit table. Mere presence in that table does not establish an integration. In particular, a common name such as Computer Use, Memory, or permissions does not prove that the corresponding external plugin powers the feature.

Project memory was read from the main checkout because this worktree initially had no `.memory/` directory. That memory is historical context; the audited worktree's source and tracked plans take precedence where they differ. The earlier reference audit is dated **31 August 2026**, while the subagent expansion plan also records a **5 August** baseline. Findings distinguish changes since these dates from older, deliberately unfinished Aiden work.

## Verification performed

This is a research and implementation-planning audit, not a completed upgrade or release acceptance run.

- Executed the current MCP result and approval suites: **9 tests passed**.
- Executed the current memory-store and web-search-core suites: **14 tests passed**.
- Reproduced a foreground MCP normalizer defect using synthetic data: a text-plus-image result returned only its text; a result containing one million synthetic base64 characters became a **1,000,063-character** JSON text block. No real screenshots, credentials, or external tool calls were used.
- Attempted the subagent request-capability suite. It could not load because this worktree has no installed dependencies and the runtime import of `entities` was unresolved. That is an environment limitation, not a confirmed product test failure. The successful suites used the existing main checkout's `tsx` executable without installing or changing dependencies.
- Full desktop, native mobile, signed-package, credential-backed provider, and background-soak suites were not run. Their relevant acceptance requirements are specified with the proposed work.

The MCP reproduction demonstrates loss of content and absence of a bound in that normalizer. It does **not** establish an application crash or unlimited model context. `generation-context.ts` has a 32,000-character tool-text reduction, but it runs only after `shouldCompact(...)` becomes true; lower-pressure requests bypass it. It is therefore not an unconditional tool-result limit. Applying that later reduction cannot recover discarded images or structured evidence, and it does not prevent the earlier JSON-string allocation.

The successful commands were run from the audited worktree using `/Users/sambitbiswas/projects/aiden-agent/node_modules/.bin/tsx --test`, first with `main/services/mcp-tool-result.test.ts main/services/tool-approval.test.ts`, then with `main/services/memory-store.test.ts main/services/web-search-core.test.ts`. The additional attempted file was `main/services/subagents/request-capabilities-v2.test.ts`. The installed runner was only a test launcher; it did not substitute another checkout's product source.

## Executive decision

**Do a focused maintenance pass on Aiden's native MCP integration. Do not run a blanket plugin upgrade.** The highest-priority finding is configured service headers crossing an OAuth origin boundary. A second confirmed defect loses multimodal and structured MCP evidence. OAuth network deadlines deserve a companion reliability change. Web access already covers the relevant upstream fixes examined. Context-mode has no source change to adopt. Subagents need a narrower capability-contract investigation and a background-lifecycle design refresh, rather than importing hundreds of upstream changes.

These findings do not establish that a secret has actually leaked, that users have suffered a crash, or that the current release is universally broken. They identify reproducible code paths and the conditions under which they matter. No incident history or production telemetry was examined.

| Order | Decision | Priority and confidence | Delivery boundary |
| --- | --- | --- | --- |
| 1 | Scope configured MCP service headers to their intended origin, including OAuth discovery and redirects | P1; confirmed conditional disclosure path with mocked SDK discovery | Aiden-owned transport fix and regression tests |
| 2 | Replace lossy/unbounded MCP result normalization with a bounded, explicit content policy | P1; reproduced content loss and early large allocation | First-party normalizer, transport admission, projection tests |
| 3 | Bound OAuth network requests without shortening the human sign-in window | P2; source-supported reliability gap | Same transport workstream, separately testable change |
| 4 | Investigate effective child-tool/prompt disagreement and add a narrow regression | P2; source concern, production reachability must be proven | Subagent assembly/prompt contract; no authority expansion |
| 5 | Refresh background-subagent acceptance requirements before existing Phase 7 activation | P2 prerequisite for that feature, not an active-runtime release blocker | Existing orchestration plan and lifecycle tests |
| 6 | Keep current web-provider implementations; record upstream fixes already covered | No code change established by this comparison | Provenance update only |
| 7 | Keep context-mode-derived memory and current local compaction ownership | No required update | No dependency or engine changes |
| 8 | Exclude nonintegrated plugins and newly added upstream providers | Out of this maintenance scope | No installation, migration, or feature expansion |

Here P1 means address in the next focused maintenance cycle; P2 means planned reliability work or a prerequisite before exposing the affected feature. No P0 emergency or proven active exploitation was established.

## Integration inventory and explicit exclusions

| Supplied source | Actual relationship to Aiden | Audit disposition |
| --- | --- | --- |
| `mksglu/context-mode` | Design-derived native memory/retrieval; no imported package or MCP owner | Compare the adopted source concepts; no source delta |
| `nicobailon/pi-subagents` | Deliberate native adaptation with Aiden-owned tools, approvals, persistence and UI | Compare applicable behavior; selective follow-up |
| `nicobailon/pi-web-access` | Native provider/search adaptation and catalog research | Compare shipped provider behavior; retain current implementations |
| `nicobailon/pi-mcp-adapter` | Reference for Aiden's existing native MCP feature; independent SDK lifecycle | Use relevant upstream fixes as evidence to inspect Aiden; no plugin bump |
| `DietrichGebert/ponytail` | Workflow/simplicity reference only | Excluded |
| `@gotgenes/pi-permission-system` | Policy reference; native one-shot approval machinery is independent | Excluded as a package update |
| `MattDevy/pi-extensions` | Memory confidence/feedback and review research only | Excluded |
| `MattDevy/pi-extensions/packages/pi-simplify` | Same monorepo; code-review reference, not context compaction | Excluded |
| `narumiruna/pi-extensions` | Provider-native compaction research; deliberately deferred | Scope checked; no integrated package to update |
| `injaneity/pi-computer-use` | Media/replay research reference | Excluded; not Aiden's Computer Use driver |

The authoritative adoption decisions are in [the reference ledger](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/docs/plans/pi-compaction-memory-upgrade-implementation-notes.md:65) and [the research scope](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/docs/plans/pi-compaction-memory-upgrade-plan.md:74). The latter explicitly separates research from permission to install third-party extensions.

The Computer Use distinction matters. Aiden uses **trycua/cua driver 0.8.3**, source `0612c26b2c7b8556f6de7f6b4f3927ecac914e4f`, behind its own authenticated Rust broker. Its model-facing contract came from Hermes. The originating Aiden commit is `34bbc84274c34dfe13f41f82c7638ee73047aaad`, dated 22 July. This is recorded in [the Computer Use architecture](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/docs/computer-use-integration.md:3) and [the pinned artifact manifest](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/resources/computer-use/cua-driver-artifact.json:3). Updating injaneity's plugin would not update that driver. A separate CUA currency audit was not added to the user's supplied scope.

Likewise, Aiden's native confidence field does not establish an installation of pi-continuous-learning, and the existing Allow once/Deny machinery does not establish an installation of gotgenes' permission package. Their recorded versions are research artifacts, not production pins. None of those excluded repositories was cloned merely to enumerate unrelated changes.

## Refreshed source ledger

These are the exact research snapshots, not proposed production dependencies. All five research checkouts were clean at verification. Existing checkouts were inspected before pulling; absent repositories were cloned into the requested `opp` directory.

| Repository and local directory under `opp` | Recorded comparison baseline | Refreshed HEAD | Refresh outcome |
| --- | --- | --- | --- |
| `pi-subagents` | Expansion: `6209b8b035f02d031f23f160840131719f115d51`; later compaction audit: `3f879722f96fdec19364ccd9a18f8176d797fedc` | `940406c0d48890060d1f5f5280925c8f5a5c7389` | Existing clean checkout fast-forwarded from `f6a4caccfddcce04e18afd7fcf28d225ac5b45ad`; v0.67.0 plus 23 commits |
| `pi-web-access` | `5741f303a4f5b89fed18e02ec3fed038844e0e98` | `192ac1875e3b8f88c78953dbc314949ec9fcaa27` | Existing clean checkout fast-forwarded from v0.27.0-era `8f11a0a`; current package v0.29.0; 33 commits after ledger baseline |
| `pi-mcp-adapter` | `ff234b862359e722bf4dc1c99cde62278d4b8eb3` | `6f4a8f86f2da5f2acaa8e536396c61296752310b` | New clone; v2.33.0 plus one commit; 40 commits after baseline |
| `context-mode` | `6b8bf61f83abed6c3faf4e7c3ba02c162fadfedf` | `0c57e6e5a167c19da33e29f1c6158c39728ba260` | New clone; only generated statistics changed |
| `narumiruna-pi-extensions` | `36c2421544f0defaebd3d44b793d39b2a7f5fb47` | `07ac1d7446deb28472030770a537590427da2dae` | New clone for bounded compaction/scope verification; relevant package 0.51.3 → 0.52.0 |

Upstream source comparisons: [subagents since the August expansion baseline](https://github.com/nicobailon/pi-subagents/compare/6209b8b035f02d031f23f160840131719f115d51...940406c0d48890060d1f5f5280925c8f5a5c7389), [web access](https://github.com/nicobailon/pi-web-access/compare/5741f303a4f5b89fed18e02ec3fed038844e0e98...192ac1875e3b8f88c78953dbc314949ec9fcaa27), [MCP adapter](https://github.com/nicobailon/pi-mcp-adapter/compare/ff234b862359e722bf4dc1c99cde62278d4b8eb3...6f4a8f86f2da5f2acaa8e536396c61296752310b), [context-mode](https://github.com/mksglu/context-mode/compare/6b8bf61f83abed6c3faf4e7c3ba02c162fadfedf...0c57e6e5a167c19da33e29f1c6158c39728ba260), [Narumi](https://github.com/narumiruna/pi-extensions/compare/36c2421544f0defaebd3d44b793d39b2a7f5fb47...07ac1d7446deb28472030770a537590427da2dae).

## 1. MCP: prevent configured service headers crossing OAuth origins

**Finding.** Both [normal MCP transport construction](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/mcp.ts:115) and [interactive OAuth transport construction](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/mcp-oauth.ts:207) pass configured `server.headers` as SDK `requestInit.headers`. In pinned SDK 1.30.0, the transport constructs `createFetchWithInit(fetch, requestInit)` and supplies that merged fetch to OAuth discovery. Its merge attaches the base headers without checking the destination origin.

An MCP service can legitimately advertise an authorization server on a different origin. If the configured MCP headers include a service-specific API key or tenant credential, that unrelated authorization origin can receive it. This concerns configured service headers on the relevant HTTP/SSE OAuth path. It is not evidence that every Pi inference key, every encrypted MCP token, or every connection is affected.

**Reproduction.** A fake fetch returned protected-resource metadata for `https://service.example/mcp` declaring `https://auth.example` as its authorization server. The real SDK discovery function ran through its real `createFetchWithInit` helper, with `X-Service-Key: synthetic-marker` as the configured base header. The fake recorded that header on both origins. No socket was opened and no real credential was used. This independently corroborates the source trace; it is not a live exploit of Aiden.

Upstream addressed the same class in [origin-scoped service-header forwarding](https://github.com/nicobailon/pi-mcp-adapter/commit/08299641c6378381d4634dd6bb5a1cde42300ce3). The useful update is that policy, implemented inside Aiden's existing lifecycle.

**Implementation.** Introduce one shared, testable fetch policy used by ordinary HTTP, SSE, interactive authorization, token completion/refresh, and verification connections. Attach configured service headers only to the exact configured service origin. Do not leave secret headers in a shared base initializer that the SDK can reuse for other destinations. Handle redirects explicitly so an originally approved request cannot carry arbitrary custom headers to a different origin. Preserve SDK-generated OAuth authentication for its legitimate destination: simply rejecting all cross-origin OAuth discovery would break normal deployments.

Retain existing generation checks, document ownership, cancellation, credential observers/redaction, no-redirect preset behavior, and the stronger bounded subagent fetch. A new general transport wrapper must compose with those controls, not replace them. Avoid persisting headers or full request objects in diagnostics.

**Acceptance.** Add a fixture with separate MCP and authorization origins; verify a synthetic service header exists only at the MCP origin. Exercise HTTP and SSE, initial discovery, dynamic registration where used, token exchange, refresh, and final authenticated connection. Include same-origin discovery, cross-origin redirects, mixed-case header names, token-specific Authorization headers, and server URL/header edits during authorization. The old valid session must survive a failed replacement authorization. This change can be implemented without new product UI or mobile wire fields.

**Release assessment.** Prioritize this fix first. A live credential check, if desired after deterministic tests, should use a disposable test service and disposable credentials. This audit establishes the conditional path; it does not establish an actual disclosure incident or justify asserting one to users.

## 2. MCP: preserve meaningful results and bound them before context projection

**Finding.** [mcp-tool-result.ts](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/mcp-tool-result.ts:3) collects text blocks and returns them if any text exists. Images, audio, resource links, embedded resources, and separate structured content are then omitted. If there is no text, it serializes the whole result as JSON, including inline binary/base64 content. The normal [MCP tool call path](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/mcp.ts:382) uses this function.

The synthetic mixed response contained text, an image, and `structuredContent: { answer: 42 }`. The result retained only the text. The image-only reproduction generated a 1,000,063-character string from one million synthetic base64 characters. The existing three MCP tests cover identity, a normal text result, and `isError`; all pass, and none tests this content matrix.

**Impact.** The agent can lose the evidence needed to answer correctly, or consume a base64 dump as text instead of seeing an image or an explicit unsupported-content notice. Late context truncation cannot restore discarded evidence. It also occurs after the conversion allocated the large JSON string. The separate 32,000-character reduction is conditional on compaction pressure, so a below-threshold request can retain a larger string. This does not establish a crash or unlimited prompt size. The amount retained in every journal and presentation path should be measured during implementation rather than assumed.

The subagent MCP path already applies stricter bounds and explicit result policy. Preserve that smaller authority surface. Upstream's [bounded-output work](https://github.com/nicobailon/pi-mcp-adapter/commit/4444b49fbfb23e9ed058ed89f88673b1a54193a3) is a useful reference, but its scripting engine is not needed.

**Implementation.** Replace the implicit text-or-JSON fallback with a versioned, explicit normalizer policy. Keep bounded text; preserve bounded structured evidence when it adds information; validate and deliver images through Aiden's existing allowed image path only when the receiving model/surface supports them. Return a clear bounded descriptor for unsupported content. Never use an automatic stringify fallback for arbitrary binary envelopes, and never automatically fetch a returned resource link.

Define aggregate bytes, per-block bytes, text length, media count, and decoded-image limits. Use stable truncation or omission markers rather than presenting an incomplete value as complete. Keep resolved `isError: true` as a tool failure, and bound/sanitize its message. Inspect admission before JSON/body materialization separately: a post-parse result cap does not cap transport memory. HTTP, SSE, and stdio need policies compatible with their transport semantics; a large stdio response cannot be fixed by an HTTP wrapper.

Do not silently change the read-only child MCP contract to permit images, resources, or broader network activity. Where normalization code is shared, select the policy from host-owned authority and surface capabilities.

**Acceptance.** Add text-only, mixed text/image, image-only, structured-only, text-plus-structured, audio, embedded resource, resource link, empty, malformed, oversized, and error fixtures. Assert no raw base64 enters model text. Check the declared bounds before provider invocation, the resulting journal entry, text-only-model behavior, and cancellation while receiving a result. Retain existing stable tool identity and terminal failure tests.

Because this may affect transcript/activity/media projection, inspect both iOS and Android consumers and run their focused suites even if the eventual public wire format stays unchanged. Reuse existing attachment/artifact contracts where practical; any new field must be versioned and backward-compatible.

## 3. MCP OAuth: bound network work separately from user sign-in

**Finding.** Aiden has generation fencing, transactional session replacement, cancellation, and a five-minute callback wait. These controls do not establish a dedicated deadline for each OAuth discovery, registration, or token fetch. The source has no explicit per-fetch policy for those phases. A stalled request can keep sign-in pending until a broader timeout or cancellation occurs. Upstream added [composed OAuth HTTP timeouts](https://github.com/nicobailon/pi-mcp-adapter/commit/6ba7d360fcc67a77ccbbb4921586614798020a7a).

**Implementation.** Extend the shared transport policy from item 1 with an explicit OAuth-request deadline, initially using upstream's 30-second value as a candidate to validate. Compose the request deadline with existing owner/operation cancellation. Clear timers and abort listeners on every settlement path. Keep the human browser sign-in allowance separate; waiting for the user is not a stalled network request. Preserve the transactional old session when discovery, registration, exchange, or verification fails.

**Acceptance.** Use a controlled never-resolving fetch for each phase, verify bounded failure and actual request abortion, and prove retry/sign-in is possible afterward. Test owner reload, configuration edits, cancellation during token completion, and a successful browser callback near the human deadline. Expose a stable retryable category without raw provider text or request headers. Do not add periodic reconnection or sign-in background work as part of this fix.

### Other MCP upstream changes: disposition

The 40-commit delta contains important changes that do not map to Aiden's implementation. Recording why they were excluded avoids treating the three selected fixes as an incomplete blanket sync.

| Upstream change | Why it is not immediate Aiden work |
| --- | --- |
| Cross-process OAuth credential transactions | Aiden owns an in-process mutation queue and per-server operation/configuration generations. No equivalent shared adapter credential-file writer was found. Revisit if that ownership changes. |
| Remove inherited `bearerTokenStore` on transport switches | Aiden's server schema has no such inherited field or adapter config-merging system. Its own connection fingerprints and credential cleanup remain the relevant tests. |
| Session-scoped grants and approval-broker ordering | Aiden's one-shot approvals and immutable child ceilings have different owners and semantics. Importing session grants would change authority. |
| MCP script intermediates, namespace proxies, direct-tool search, plugin loading and panels | Those adapter execution/UI modules are not integrated. Their absence is not a regression. |
| Custom CA bundles and disabling inherited stdio environment | Potential separate product/hardening controls. No adopted contract currently promises them; adding them requires explicit configuration and compatibility design. |
| Stale OAuth-client re-registration | Include a failing-case check during the OAuth work, but do not alter Aiden's transactional credential lifecycle without reproducing the same failure. |
| Dynamic callback ports | Aiden has a stable callback URI and explicit port-conflict failure. Changing that requires registration/compatibility work, not an automatic patch port. |
| Node 20 compatibility, extension peer pins, config CLI parsing, TUI themes and install flows | Upstream packaging/runtime-specific changes with no matching Aiden dependency or feature. |

These dispositions are source-based maintenance decisions, not assertions that the corresponding Aiden areas could never be improved. The pinned MCP comparison in the ledger provides the complete upstream history.

## 4. Subagents: selective contract hardening, not an extension transplant

Aiden's [native integration plan](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/docs/plans/completed/aiden-native-subagents-plan.md:7) deliberately uses embedded Pi children and Aiden-owned authority. The active feature has positive capability selection, exact mutation approvals, bounded tree budgets, safe fork projection, and isolated provider execution. Current upstream adopted [native foreground sessions](https://github.com/nicobailon/pi-subagents/commit/d9bc62f8eb82cb67edcdef09ccc4dcad46e5e42d), which aligns with Aiden's direction but does not make its implementation interchangeable.

The refreshed upstream is v0.67.0 plus 23 commits. Even against the more recent 31 August ledger baseline, the comparison contains 221 commits and changes 416 files. These counts describe upstream churn, not required Aiden work. Its movement from Aiden's older 0.41.0 expansion reference is substantial, but raw commit volume exaggerates Aiden's update burden: much of it concerns upstream CLI/TUI workflows, custom agents, schedules, steering, and detached-run infrastructure that Aiden does not expose.

**Effective tools and prompt truthfulness.** Upstream now diagnoses [requested inspection tools that disappear from the effective child tool plan](https://github.com/nicobailon/pi-subagents/commit/6f68c6971ec8153b1e68161f1d3804859c9b6702). In Aiden, [capability-tools.ts](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/subagents/capability-tools.ts:26) can return an empty tool list after capability intersection. The V2 child prompt can separately derive workspace-read wording from the requested authority boolean in [subagent-child-runner.ts](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/subagents/subagent-child-runner.ts:585).

That is a contract question worth testing, but an empty list alone is not a bug. A fork-only analysis, explicitly tool-free task, or MCP-only child may be valid. The initial specialist suggestion to fail all affected roles was therefore narrowed: first prove a reachable production case where the request expects workspace inspection but the final tool list cannot supply it, then derive prompt claims from the assembled tool set or return a precise unavailable-capability result. Never infer new authority from `scout`, `planner`, or `reviewer` labels.

Tests should distinguish missing expected tools from intentionally unavailable workspace tools, and cover fresh/fork, legacy/V2, MCP-only, write-only, and nested inheritance. This is P2 pending that production trace, not a confirmed P1 failure in ordinary foreground use.

**Thinking and Pi compatibility.** Upstream fixed [fork behavior that should preserve requested thinking after signed blocks are removed](https://github.com/nicobailon/pi-subagents/commit/a0b8c6de98f642c808e4a36a91124d0fd8f02d46). Aiden already strips hidden/signed reasoning from child context and separately passes its thinking setting. Upstream's new native implementation expects newer Pi seams, but that is not evidence that Aiden's custom harness must immediately upgrade from 0.84.4. Keep a signed-Anthropic-fork regression on the next planned Pi upgrade; require a reproduced Aiden defect or a consciously adopted new seam before expanding this audit into a dependency migration.

**Background lifecycle.** Aiden's [plan index](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/docs/plans/README.md:35) and [orchestration plan](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/docs/plans/subagent-orchestration-expansion-plan.md:25) leave app-lifetime background activation as follow-on work. The coordinator exists in source/tests but is not wired as a production owner. This is pre-existing unfinished scope, not a newly broken foreground feature.

Before activation, adopt regression requirements informed by upstream's [durable result publication ordering](https://github.com/nicobailon/pi-subagents/commit/c4a3a3c7b948a126e929d7f50540296bb1aba4d5), [steering-consumption tracking](https://github.com/nicobailon/pi-subagents/commit/57278d82a72983aebda4c966830c5b8d7ef9f183), and [final drain](https://github.com/nicobailon/pi-subagents/commit/808387a206b668b590720050ae4f637d69b6b80c). Specifically: accepted runs must be immediately queryable; durable results must precede completion notifications; queued steering must be distinguishable from consumed steering; descendant/tool/process drain must precede ancestor completion and capacity release; unresolved effects must remain unknown rather than being retried; unchanged status must not repeatedly wake the parent.

Exercise crash points between acceptance and start, result commit and notification, steering enqueue and consumption, and stop request and terminal proof. Add a packaged depth-two scenario with cancellation during handoff. Preserve exact rollback flags and the existing migration receipts.

**Do not absorb adjacent feature work.** Upstream structured report schemas and bounded pre-tool provider recovery are useful future ideas. Neither is necessary to maintain Aiden's current text-result and fixed-authority contract. Do not add automatic model/provider fallback, ambient extension discovery, custom CLI agents, schedules, or global context inheritance in this maintenance pass. Model fallback and retries after unknown effects are especially incompatible with an unreviewed authority change.

The Mac currently owns child detail. Desktop Remote filtering and the iOS/Android contracts preserve parent-only projections; Telegram explicitly disables subagents. A background refresh should retain that boundary unless a separate child-resource protocol is designed. Shared transcript/status changes still require both native-client suites under AGENTS.md.

## 5. Web access: relevant upstream fixes are already covered

The existing native implementation is documented in [the Web Access plan](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/docs/plans/web-access-rehaul-plan.md:104). Its source was compared against the refreshed upstream v0.29.0, including the 33 commits since the August audit baseline.

| Upstream change | Aiden comparison | Decision |
| --- | --- | --- |
| [Tavily plan exhaustion is a quota error](https://github.com/nicobailon/pi-web-access/commit/2cd4f79e5d5d4a0b998d59d62b57ad70998dc8ab) | `web-search-tavily-adapter.ts` already passes 432/433 as quota statuses; focused fixtures assert both | Already covered |
| OpenAI credential origin mismatch protection (`6dff041`) | Native OpenAI adapter and auth-reuse path bind endpoint/credential identity and revalidate after I/O | Preserve existing stronger binding; no blind cherry-pick |
| Preserve cited Perplexity sources (`2f5b0bc`) | Aiden deliberately returns bounded source evidence, with search-result and citations-only coverage, rather than upstream's full answer/report contract | No matching regression established |
| Explicit-only Mistral search (`7ca5cdc`) and SerpApi (`734ab55`) | These are additional upstream providers, not shipped Aiden integrations | Excluded from the requested update scope |
| Extraction, video, repo cloning, response persistence and fan-out changes | These do not belong to Aiden's native search contract | Excluded |

The relevant code is [Tavily](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/web-search-tavily-adapter.ts:120), [its tests](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/web-search-wave1-adapters.test.ts:371), [OpenAI](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/web-search-openai-adapter.ts:76), and [Perplexity](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/web-search-perplexity-core.ts:291). Exact upstream changes can be inspected in the pinned web comparison in the ledger.

Do not expand the provider list just to match upstream's count. Aiden's reviewed providers, explicit-only routing, credential isolation, request bounds, and user-selected fallback categories are product constraints. A catalog comment claiming to enumerate every current upstream ID can be dated or clarified without adding a new selectable provider.

The plan still records credential-backed installed acceptance as outstanding. That is an existing release-owner gate, separate from this source audit. The five current web-search-core tests passed here; they do not replace the live provider matrix. This investigation establishes no necessary provider implementation change from the reviewed delta.

## 6. Context and memory: no context-mode source update

Between `6b8bf61...` and `0c57e6e...`, context-mode changed only `stats.json`. Its `src` tree object is identical at both revisions: `259a184cf3e6946d449741b81bb70d7e9bd493bb`. The five files previously audited by Aiden—store, truncation, session database, snapshot and purge—are byte-identical. This is stronger evidence than an unchanged version number: there is no source patch in that comparison to port.

Aiden's native [memory store](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/memory-store.ts:190) already implements private SQLite/WAL, scoped FTS5/BM25 retrieval, bounded facts and metadata, provenance, expiry/supersession, exact-scope deletion, and source-chat cleanup. [Memory tools](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/memory-context.ts:144) use Aiden's owner approval boundary. The nine memory-store tests passed. Context-mode's generic MCP server, hooks, analytics, sandbox/indexing and session ownership were not adopted.

Keep the existing native memory implementation. Do not introduce another session owner, a package install, fuzzy indexing, or global purge UI under the label of updating context-mode. Those would be separate feature decisions and no new upstream delta requires them.

## 7. Narumi compaction: scope verified, defer remains valid

The relevant upstream package changed from 0.51.3 to 0.52.0 and added [Responses compaction API routing](https://github.com/narumiruna/pi-extensions/commit/ac745429d668d252ae32c1df772a39fd14f78555) for OpenAI/Azure alongside Codex Remote V2. This was checked because Aiden's prior research ledger names it. It remains unintegrated and therefore receives no update work in this report.

Aiden's [provider-native defer decision](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/docs/testing/pi-compaction-phase7-rollout-gates.md:90) requires proof of checkpoint ownership, model/provider changes, retry/fork behavior, deletion, offline reconstruction, and cross-surface reconciliation. Broader API support alone does not satisfy those requirements. The current extension still relies on coding-agent hooks and opaque remote checkpoints with portability/lifecycle limits; Aiden owns a different harness and local journal.

Aiden's experimental `pi-vcc` is also not this extension: [its provenance](/Users/sambitbiswas/.codex/worktrees/c65a/aiden-agent/main/services/pi-vcc/UPSTREAM.md:1) points to another source. No new remote engine, automatic fallback, provider request, Pi version bump, or onboarding change is warranted by this scope check. Preserve the original audit baseline as history; this report supplies the dated follow-up observation.

## Delivery sequence and acceptance gates

**Change A — OAuth transport isolation.** Implement the origin/header policy and deterministic separate-origin tests first. The primary files are `mcp.ts`, `mcp-oauth.ts`, and a new pure fetch-policy module if needed. Deadline handling can be a second commit in this workstream, with independently passing tests. Run `npm run test:config-recovery`, the new registered transport tests, relevant MCP/subagent fetch tests, and a packaged HTTP/SSE sign-in smoke using disposable test credentials. Verify the old credential transaction remains intact on every failure.

**Change B — MCP output contract.** Implement the bounded result policy and pre-materialization checks as a separately reviewable change. Run the extended `mcp-tool-result` tests, `npm run test:preflight`, relevant child MCP read/mutation tests, `npm run test:compaction`, and focused transcript/artifact suites. Inspect both native clients and execute their applicable tests. Test text-only and vision models and a synthetic oversized server response in packaged Electron. Keep backward-compatible storage/projection or provide explicit migration tests.

**Change C — Subagent contract investigation.** First add a failing regression only if the claimed expected/effective tool mismatch is reachable. Fix prompt/tool agreement or return a typed unavailability result without changing authority. Run `npm run test:subagents:inventory`, `npm run test:subagents:phase5b`, `npm run test:subagents:phase6b`, then the full relevant subagent suite and packaged foreground smoke. Keep intentionally tool-free tasks valid.

**Change D — Existing background plan refresh.** Record the new upstream reference and settlement tests in the existing orchestration plan before activation work. Run existing crash/migration and packaged soak gates when that feature is implemented. Do not report this document update as completion of the background feature. Do not advance the Pi runtime rollout or install a newer Pi package merely to match upstream plugin development pins.

Register every new test file in the appropriate `package.json` script. If any change touches shared server contracts or transcript/activity behavior, inspect and test both iOS and Android; a desktop-only origin wrapper that leaves those contracts untouched does not itself require mobile UI work. Internal maintenance fixes need no new onboarding tile. A later user-visible capability or privacy/configuration change must follow the onboarding and design rules, but none is proposed here.

Keep the two confirmed MCP fixes independent enough to revert separately. Prefer ordinary code rollback for stateless transport policy. Do not casually undo a persisted result-envelope change after writing new data: either keep its public/persisted shape backward-compatible or specify reader compatibility and rollback acceptance before release. Do not advance any existing background or compaction feature flag as a side effect of these changes.

## Research execution and limitations

The requested model was used: three GPT-5.6 Sol subagents at medium effort completed the initial subagent, web/MCP, and context comparisons. The runtime imposed a hard limit preventing a fourth distinct subagent even after a completed assignment was interrupted. Two subsequent assignments reused those Sol agents for exclusion verification and an adversarial challenge pass, producing five specialist assignments in total. The parent independently checked key source paths, commit references, focused tests, the MCP content reproduction, and the SDK header-origin reproduction.

The original plan requested four to five distinct explore agents; that exact headcount was not possible under the tool limit. The report does not represent reused agents as additional independent agents. No full dependency install, live-service audit, broad security scan, signed release, mobile build, or production incident investigation is claimed.

The deliverable changes only this report, local project memory, and a troubleshooting note. Existing implementation-plan statuses are unchanged because this audit did not implement or complete those plans. The next authorized implementation task can use the delivery sequence above without rediscovering the integration inventory.
