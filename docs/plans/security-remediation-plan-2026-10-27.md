# Security remediation plan

Status: In progress. Implementation and stacked PR delivery authorized October 27, 2026.

Owner decisions, October 29, 2026, after a review of the draft stack:

- W1 Telegram pairing (#605) is closed without merging, because Telegram is being removed from Aiden. Its changes are taken back out of the later PRs in the stack.
- W5 Remote admission (#607) ships as written: unknown computers can ask to pair only while Add device is open, and the request setting defaults to off.
- W3a private configuration (#609) also accepts a symlinked configuration folder when the link, the folder holding it and the folder it points to belong to the person, instead of blocking dotfile-managed setups. A symlinked config file stays refused, because an atomic save would replace the link with a plain file.
- W12 (#614) ships the production renderer CSP change. The AppImage updater keeps today's feed checksum check and does not require the GitHub CLI; publisher verification in the updater stays an open design question.
- The stack lands bottom-up, one PR at a time, each after main is merged in and CI is green on its exact head. UI changes (#608, #612) are shown as screenshots first.

We should first close Telegram owner bootstrap and CLI scheduling approval gaps, then protect portable configuration and external mobile voice entry points. The remaining work is split into independently reviewable changes, validation tasks and explicit product decisions. Each change must preserve existing Bot policies, provider bindings, revocation and manual-only network behavior.

This plan covers all 23 findings in the October 27 audit and incorporates the T3 Code comparison. The owner authorized implementation, stacked PRs and fresh-context GPT-6.1 Sol high review on October 27, 2026. Publishing releases, merging and credential rotation remain outside this implementation request.

## Evidence and implementation baseline

| Input | Revision or location | What it establishes |
| --- | --- | --- |
| Original audit | /Users/sambitbiswas/projects/aiden-security-audit-20261027/docs/security/security-audit-2026-10-27.md; report checkout 86ca11c70f83ee1ecac0d9018c94470dabde549b; reported base 2cfebc915 | The supplied claims and their original severity labels. |
| Aiden source reviewed against main | 76bc16a2f9f561216f2ad7ab86c6decf1ba368fe | Current approval, pairing, credential, rendering and mobile entry-point implementations at planning time. |
| Retained claim review | audit-claim-review-2026-10-27.md and audit-claim-triage-2026-10-27.json in this chat's Codex Security artifacts | Eleven claims confirmed at a narrower scope, ten requiring evidence or a policy decision, two defeated by current controls. Confirmation does not mean runtime exploitation was reproduced. |
| T3 Code comparison | /Users/sambitbiswas/projects/opp/t3code at c294d63b2135771dd74f0a2b57af5b501043a74b | Concrete examples of pairing grants, permission ceilings, secret-file permissions and contrasting product policies. |
| Remote policy | [Aiden Remote threat model](../security/aiden-remote-threat-model.md) and [iOS security policy](../../ios/SECURITY.md) | Host-owned authority, explicit grants, revocation, filesystem identity and mobile privacy constraints. |
| Existing product decisions | [Telegram workspace authority](../superpowers/specs/2026-08-11-telegram-workspace-authority-design.md), [scheduled tasks](completed/scheduled-tasks-plan.md), [workspace artifacts](../workspace-artifacts.md) | Existing intentional authority choices and contracts that fixes must account for. |

The supporting review was static, with read-only upstream source and GitHub configuration checks. No exploit, application launch, device recording, packaged binary verification or credential inspection was performed. Before implementing each slice, fetch and compare the current source and revalidate any live configuration on which its disposition depends.

The live release environment allowed only the main branch when checked. That observation is a dated mitigation, not a permanent property of the workflow source. Dependency versions and fixed-release advice must also be refreshed before changing lockfiles.

## Security invariants

1. An unpaired actor cannot establish ownership by being first to contact an enabled integration.
2. Model-originated persistent automation mutations require the surface's explicit approval contract, including in a Full workspace. A model argument never creates an authority grant.
3. Approved work remains bound to the reviewed target, executable selection, provider connection and effective permissions. Changes while approval is open or before execution fail closed.
4. Credentials do not remain in broadly readable configuration files, temporary files or migration copies. Existing encrypted storage and credential destination binding remain authoritative.
5. An external URL cannot start microphone capture. A navigation request is not consent to record or silently create remote state.
6. Model-authored artifact sources obey the same secret-file policy as other model file readers.
7. Untrusted transcript content cannot initiate an external image request before the person chooses to load it.
8. Existing Bot access policies and managed-workspace semantics remain intact. Telegram or ordinary-workspace fixes must not change the generic permission resolver indiscriminately.
9. Failed migration, cancellation, revocation or downgrade must not silently restore weaker admission rules.

## Scope and delivery strategy

We will strengthen the existing main-owned services and state machines, reuse their storage and approval boundaries, and add behavioral coverage at those boundaries. We will not introduce a new authorization service or replace the agent runtime.

A broader shared authorization layer could reduce future desktop/CLI drift, but it would affect Bots, scheduled work, Remote and provider-specific behavior together. That is a separate architectural decision after the scoped fixes have shipped and their contracts are stable.

| Approach | Security effect | Engineering cost and risk | Decision |
| --- | --- | --- | --- |
| Strengthen existing admission and execution boundaries | Closes the verified gaps locally; shares narrowly reusable policy functions where their contracts match. | Several services still need independent integration tests; lower migration and rollback scope. | Recommended for this plan. |
| Consolidate desktop, CLI, Telegram, Bot and scheduled authority into a new common resolver | Could reduce drift if one representation can express all existing grants and lifetimes. | High compatibility risk, larger release scope, more complex migration and unclear performance benefit. | Defer. Do not make immediate fixes depend on this redesign. |

The recommended approach has no new background network requests or permanent worker processes. Runtime cost should be limited to bounded validation and filesystem identity checks. Measure any new hashing, migration or image-loading cost before release; no latency or memory improvement is assumed.

## Finding disposition and work assignment

The original IDs remain traceable below. Implementation order reflects exposure, confidence and delivery scope, rather than the audit's severity labels alone.

| Finding | Verified assessment | Planned work |
| --- | --- | --- |
| H-1, unsolicited Remote requests | Admission and broad host-approved grants are real. The supplied attack does not demonstrate a broken SAS comparison or approval bypass. Remote itself defaults off. | W5: host-initiated request window and clearer grant consent; preserve the committed-nonce comparison. |
| H-2, CLI persistent scheduling | Confirmed approval-parity gap within an already Full workspace. | W2: mandatory mutation approval and target/argument binding. |
| M-1, Telegram owner bootstrap | Confirmed first-non-bot-private-message ownership assignment. | W1: host-issued single-use pairing code. |
| M-2, Telegram workspace permission override | Full selected-workspace automation is explicitly documented. Whether No Access is a global ceiling needs a product decision. | D1: choose Telegram-specific semantics; implement and document them without a global resolver change. |
| M-3, portable config permissions and MCP env | Confirmed conditional plaintext exposure; actual modes depend on umask and directory ancestry. | W3a: private modes and migration. W3b: safe sealing of pending MCP env. |
| M-4, Pullfrog supply chain | Mutable action refs are real; ten secret references do not prove ten configured keys. OIDC is used. Runtime bootstrap also needs pinning. | W9: action and executed-runtime integrity, followed by provider-key inventory. |
| M-5, script selection and inherited environment | Runtime can change from a global script to a matching workspace script. Full environment inheritance is real. | W6: approved selection binding and environment policy. |
| M-6, automatic Markdown images | Confirmed external-image request mechanism. Exact loopback reachability remains browser-dependent. | W8: consent before external image loading. |
| M-7, external voice links | Confirmed source path to chat creation and voice start, subject to connection and OS permission state. No automatic send established. | W4: trusted internal actions separated from external URLs on both clients. |
| M-8, iOS viewer allegedly missing CSP | Not actionable as reported. The host embeds CSP and iOS already uses a nonpersistent data store. | Preserve controls; no remediation PR for the supplied claim. |
| L-1, client-asserted device type | Mechanism exists; an intended mobile/desktop grant boundary needs definition. | D2: host-owned grant selection, coordinated with W5 if adopted. |
| L-2, Tailscale limiter fairness | Shared loopback source bucket can deny legitimate pairing. | W11: preserve global caps and validate trusted source attribution. |
| L-3, Zod availability advisory | Affected version present; exact hostile collection path is unproven. App source does import Zod. | W10: trace the parser and apply an evaluated fixed-version change. |
| L-4, CLI undici advisories | Affected version and Pi dispatcher installer exist; entrypoint/API reachability needs completion. | W10: trace TUI/daemon initialization, then a bounded update with replay checks. |
| L-5, non-main macOS signing | Current release environment blocks non-main. Workflow-level guard is still useful. | W9 follow-up: explicit branch conditions; preserve environment policy. |
| L-6, AppImage update provenance | Checksum validation lacks independent publisher/workflow verification. | W12: design and test independent update authenticity. |
| L-7, production free-text redaction | Missing bare-token formats remain. The subagent sanitizer already handles namespaced x-api-key assignments. | W11: reduce free text and test persisted redaction through the full sanitizer chain. |
| L-8, artifact secret-file reads | Confirmed secret-read policy bypass into local snapshot/display; model exfiltration is not established. | W7: source admission and execution-time credential-path checks. |
| L-9, remembered approval folder identity | Key lacks folder incarnation; complete the path through existing admission checks before claiming exploitation. | V1: replacement/recreation validation, then a scoped fix if established. |
| L-10, production CSP and file fuse | Hardening opportunity; no standalone injection path established. | W12: split production CSP first; custom-protocol migration separately. |
| L-11, broad macOS entitlements | Exceptions exist; no attacker-controlled native loading path established. | V2: packaged compatibility and entitlement necessity review. |
| L-12, iOS draft backup eligibility | Eligibility confirmed; actual upload, backup contents and policy violation unproven. | D3: decide retention, then exclude drafts if device-only storage is required. |
| L-13, CLI socket bind/chmod ordering | Default newly created private directory mitigates another uid; unsafe existing directory case needs validation. | V3: validate existing-directory deployment, then enforce safe directory ownership/modes before bind. |

## Work for the first delivery session

| Order | Deliverable | Completion boundary |
| --- | --- | --- |
| First | W1, Telegram pairing | No unsolicited private message can establish owner identity; focused behavioral tests pass. |
| Second | W2, CLI schedule approval | Denied or unavailable approval cannot persist a mutation; approval is bound to the exact proposal. |
| Third | W3a, private portable configuration | Existing and new owned config files have private permissions, including failure-path coverage. |
| Fourth | W4, external mobile voice handling | Both clients implement the same consent boundary and pass their focused tests. Physical-device acceptance is recorded separately. |

If only two changes can be completed, finish W1 and W2. Do not combine them into one large PR. W3b can follow W3a because secret sealing has more migration and launch-approval implications than mode enforcement. W4 can proceed independently but requires both native clients before the shared behavior is complete.

## W1: Require a host-issued Telegram pairing code

Observed boundary: the bridge currently persists the first eligible private sender as owner. Knowing a bot handle must not be sufficient to acquire this authority.

Proposed behavior:

- The person explicitly starts pairing from Settings for one Telegram profile. Main generates a cryptographically random, short-lived, single-use code and presents the bot link or /start instruction.
- Bind the pending challenge to the profile and current bot configuration identity. Store only a verifier where persistence is necessary; prefer an in-memory challenge that expires on restart.
- A matching /start code atomically consumes the pending challenge and binds the owner. Plain /start, arbitrary text, callback queries and edited messages never establish ownership.
- Use a five-minute challenge window with bounded attempts per profile and a total attempt cap. A wrong code leaves ownership unset; expiry requires a new host action.
- Reset pairing invalidates the owner and pending challenge, fences queued work and requires a new explicit pairing action. Disable, disconnect, bot-token/profile changes and shutdown invalidate pending challenges.
- Preserve existing configured owners. The migration does not silently grant or revoke a valid owner, and it does not open pairing automatically for an unowned enabled profile.
- Never include the challenge in logs, telemetry, Remote DTOs, chat history or model-visible settings.

Primary files: main/services/telegram/telegram-service-core.ts, telegram-config.ts, telegram-profile-config.ts, main/handlers/telegram.ts, renderer/components/settings/telegram-settings.tsx and the existing Telegram ownership/profile tests.

Behavioral proof: unsolicited message and plain /start rejected; wrong, expired, reused and cross-profile codes rejected; two simultaneous valid claims produce one owner; reset and configuration races cannot publish stale ownership; existing-owner continuity holds; no challenge appears in captured outbound DTOs or persisted diagnostics.

Blast radius: Telegram connection/reset experience and profile state. Bot-bound authority remains separately enforced. Run npm run test:telegram and the touched handler/UI tests. Perform an attended real-bot pairing check with a second account only during implementation acceptance.

## W2: Require approval for model-originated CLI schedule mutations

Observed boundary: Full workspace access returns early from the generic approval hook, while the schedule tool can save enabled Full work. We retain Full workspace access and add the promised persistence decision.

Proposed behavior:

- Classify save, pause, resume and remove as schedule mutations. List, preview and run-history inspection do not acquire new authority.
- Route schedule mutations through one owned approval path before the generic Full-tier return. A tool description is not enforcement. Keep direct person-invoked administrative CLI commands available.
- Resolve the target workspace and existing task in trusted code. Build an immutable proposal containing action, task identity/version, workspace identity, cadence/timezone, prompt, enabled state, task permission, provider/model binding and relevant connectors.
- Present the consequential values in the approval UI. Denial, missing UI, cancellation or an oversized undisplayable proposal leaves durable state unchanged.
- Recheck proposal equality, target existence, workspace access, existing task version and provider binding after approval and before publication. A changed proposal needs new approval.
- A schedule cannot elevate its workspace or inherit connectors added later. Task Full permission remains bounded by separately granted workspace execution access.
- Avoid duplicate publication when a tool result or daemon response is uncertain. Use an existing idempotency/version mechanism where available, or add a bounded operation receipt at the schedule mutation boundary.
- Do not let a second approval mechanism silently bypass this path through codemode, extension registration or a future scheduling alias.

Primary files: packages/cli/src/extensions/session-parity.ts, extensions/schedule-tool.ts, schedules.ts, scheduled-inference.ts, tests/extensions.test.mjs and tests/parity.test.mjs. Reuse compatible desktop scheduling policy concepts from main/services/schedule-tool.ts without importing Electron.

Behavioral proof: a real model-tool invocation under Full waits for approval; denial/no UI produces no task; altered inputs and changed workspace/provider state fail; approved creation persists exactly once; task permission and connector scope survive daemon restart; ordinary user CLI administration remains available.

Blast radius: CLI model tool approvals and schedule persistence. Run the focused CLI suites, CLI type-check/build/bundle tests, and desktop scheduling suites if shared code changes. Register any new test in the CLI package test chain. Keep Pi pinned.

## W3a: Enforce private portable configuration permissions

Proposed behavior:

- Configure the portable store to publish owner-only files with mode 0600. Create the owned portable root with mode 0700 and validate ownership/type before hardening an existing directory.
- Apply the migration to existing config files and owned migration/corrupt-file copies that can contain the same secrets. Preserve data and fail visibly on an unsafe root or permission error.
- Reject symlink or ownership surprises according to the existing config-root contract. Never chmod the user's home directory, unrelated ancestors or a whole shared tree recursively.
- Keep the change local to the portable store unless a narrowly reusable directory-mode API is required. Do not change every DataStore caller by default.
- Ensure atomic staging, cancellation, external-change detection and directory fsync behavior remain intact. A failed save cannot replace valid config with defaults.

Primary files: main/services/portable-config-core.ts, portable-config.ts, aiden-config-dir.ts, data-store.ts if an option is needed, and existing portable/DataStore resilience tests.

Behavioral proof: newly created and existing permissive files become private under a permissive test umask; already-private data survives; unsafe symlink/owner and chmod failures fail safely; temporary/corrupt copies do not leak bytes; rejected writes preserve previous bytes and cache.

Blast radius: desktop portable configuration and any CLI consumer sharing that root. POSIX mode guarantees require macOS/Linux checks; do not claim equivalent Windows ACL enforcement from chmod tests. Run npm run test:portable-config.

## W3b: Seal unapproved MCP env without changing launch consent

We should decouple credential storage from permission to launch a server. Private file modes reduce immediate exposure, but do not prevent usable credentials travelling in config copies.

- Seal pending stdio env values into the existing encrypted credential namespace, including edits/imports and hand-edited config ingestion.
- Keep an unapproved server unapproved after sealing. Derive launch consent from the effective command, args, destination and environment semantics, with markers resolved only inside trusted code.
- Show secret names and stored-secret indicators in Settings. Reveal a value only through an explicit existing trusted editor action; do not expose it in generic launch previews.
- Preserve credential destination fingerprints and cleanup journals. A storage-format rewrite must not transfer a secret to a changed command/address or authorize a new connection.
- Stage encrypted values first, publish marker-only config atomically, then prune obsolete secrets. On failure retain a recoverable private state and leave launch blocked.
- Handle missing keychain entries, Linux unavailable/basic-text storage, corrupt markers, concurrent hand edits and downgrade explicitly. Never fall back to plaintext as a successful migration.

Primary files: main/services/mcp-server-save.ts, mcp-field-secrets-core.ts, mcp-field-secrets.ts, mcp-stdio-approvals.ts, portable-config-core.ts and the MCP settings editor.

Behavioral proof: unapproved env values are absent from durable config bytes; server remains unapproved; approval refers to the same effective launch; destination edits cannot inherit credentials; failed staging/publication does not lose working credentials or silently start a process. Run npm run test:mcp and npm run test:portable-config, including CLI consumers if shared representations change.

## W4: Separate external mobile navigation from voice actions

Implementation update (2026-10-27): both native clients retain the latest public new-chat navigation through connection/workspace readiness, parse public voice URLs as navigation-only, and require frozen-target, single-use in-app creation consent before switching installations or writing a host chat. iOS App Intents use a bounded in-process foreground handoff; notification/widget existing-chat navigation remains unchanged. Focused native checks and separate physical-device acceptance are recorded in `.memory/security-mobile-consent.md`.

- Parse externally supplied URLs into a navigation-only request. Discard any instruction to record.
- Require explicit in-app confirmation before an external link creates a chat on the paired host. Show the installation and workspace that will be affected. Cancel leaves remote state unchanged.
- Preserve intentional internal notification/widget/App Intent actions through trusted native action routing or a private intent extra. A guessable URL flag cannot assert that the caller is internal.
- Revalidate paired installation, workspace, connection and presentation state after consent. Reject stale/revoked targets and duplicate delivery; do not switch installation and create state without informed consent.
- Starting voice remains a visible in-app action, subject to OS permission and the selected transcription mode. Do not auto-send recognized text.
- Preserve ordinary existing-chat navigation and intended first-party shortcuts. Share parsing/provenance fixtures across iOS and Android where useful.

Primary files: iOS ContentView.swift, LiveActivities/AidenDeepLink.swift, Features/Remote/AidenWorkspaceShellView.swift and AidenChatFeature.swift; Android MainActivity.kt, notifications/AidenDeepLink.kt, navigation request handling and features/chat/AidenChatDetailScreen.kt. Inspect notification and widget producers before changing their contracts.

Behavioral proof: externally opened voice URL creates no recording; external new-chat cancellation creates no host chat; forged internal marker is ignored; genuine internal shortcut works; existing mic permission does not skip the new boundary; revoked/disconnected and repeated-link cases fail safely.

Run focused XCTest and Android parser/navigation tests, then launch links on physical iOS/Android devices from another app with mic permission both granted and denied. Observe host chat counts and recording indicators. Simulator/parser success is not physical privacy acceptance. A client-only fix needs no Remote protocol revision unless a wire contract actually changes.

## W5: Make Remote admission host-initiated

This is a consent hardening change. We should preserve the committed-nonce SAS flow: both endpoints knowing the code is expected, and comparing the intended device binds the channel.

- Default unsolicited connection-request admission off for new installations. Define an explicit, short-lived Add device window owned by main.
- Recommended migration: preserve paired devices and transport configuration, but require the person to open the new window before accepting future unknown requesters. Explain this behavioral change in Settings/release notes.
- Refuse create/reveal/approval outside a live window. Closing it, expiry, disabling Remote and shutdown cancel pending requests; a race cannot commit a device after admission closes.
- Show requester-supplied names as unverified labels and state the capabilities being granted. Explain what to do when the person did not initiate pairing.
- Do not replace SAS with a challenge returned through the same unauthenticated requester channel. Preserve existing credential sealing, rollback and revocation fencing.
- Keep QR/manual pairing compatible where its host-opened window already satisfies the new requirement. Recheck desktop/CLI peer-host clients and both native clients before changing wire shapes.

Primary files: main/services/aiden-remote-pairing-request-host.ts, aiden-remote-pairing-requests.ts, aiden-remote-service.ts, aiden-remote-router.ts, main/handlers/aiden-remote.ts and renderer/components/remote-pairing-request-sheet.tsx.

Behavioral proof: no window means no admitted request/device; expiry and concurrent Allow/close/disable fail closed; old devices remain usable; request codes still match the intended peer and grants remain sealed to its key. Run request-host/router/service suites and npm run test:aiden-remote, then LAN and Tailscale checks with real supported clients.

## W6: Bind approved scheduled scripts and define their environment

- Persist the selected root and canonical script selection at task approval. Display workspace/global location clearly. Do not let a later workspace basename shadow an approved global script.
- Revalidate path containment, selected-root identity and regular-file identity immediately before execution. Preserve process cancellation, output/time limits and safe interpreter invocation.
- Decide whether edits within the approved script are intended to take effect automatically. Recommended first scope: bind executable selection and root; require renewed consent when selection changes. Do not claim this pins contents.
- Device/inode alone does not prevent in-place content changes, and normal atomic editor saves can replace an inode. If content immutability is required, design a reviewed immutable copy/content digest with a safe execution handoff and clear update UX.
- Use agentShellCommandEnvironment or an equally strict explicit script environment. Retain necessary PATH/runtime variables; stop inheriting Aiden credential namespaces.
- Inventory existing scripts that intentionally consume exported credentials. Add an explicit per-task secret reference mechanism only as a separate design, rather than retaining ambient secrets silently.
- Migrate existing script tasks to a visible review-required state until selection/environment are approved. Preserve their definitions and avoid unattended migration execution.

Primary files: main/services/schedule-script.ts, schedule-execution.ts, schedule-store-core.ts, schedule-tool.ts, shared task types/editor, and packages/cli/src/schedules.ts. Inspect iOS/Android schedule DTO consumers if persisted fields cross Remote.

Behavioral proof: a newly added workspace shadow file cannot replace a global selection; replacement/symlink races fail safely; legitimate reviewed edits follow the chosen policy; AIDEN_IMAGE and other withheld credentials are absent in a fixture child; cancellation and interpreter failures remain bounded. Run npm run test:scheduled, npm run test:assistant-automations and applicable CLI/mobile contract tests.

## W7: Apply model secret-file policy to artifact sources

- Validate model-authored file-source paths against environment and protected-credential rules at creation/update and again after canonicalization immediately before read.
- Apply the same rule to existing artifacts and refreshes. A source accepted before an upgrade cannot bypass the new check.
- Keep human file-editor access separate. Adding a broad deny to readWorkspaceFile would change the human editor and Remote contracts beyond this fix.
- A denied refresh must not retain a previous secret-bearing snapshot as visible good data. Purge or invalidate affected source entries using source metadata; avoid scanning or logging arbitrary file contents.
- Keep Ask-mode command approval digests, parameter validation, refresh cancellation and workspace removal cleanup unchanged.

Primary files: renderer/shared/workspace-artifacts.ts, main/services/workspace-artifacts/tool.ts, runner.ts, main.ts and store.ts, plus a narrowly shared credential-path policy extracted from coding-tools.ts if needed.

Behavioral proof: .env, protected credential names, canonical aliases and symlink targets are denied; ordinary data files still render; no secret bytes enter snapshots/results after denial; an existing cached source is invalidated; None and concurrent workspace changes remain blocked. Run npm run test:workspace-artifacts and focused coding-tool policy tests.

## W8: Require consent to load external transcript images

Recommended option: a placeholder with Load image for each external URL. This preserves a clear consent boundary without introducing a proxy service.

- Treat HTTP, HTTPS and protocol-relative image URLs as external. Initial render, streaming updates, history restore and image-gallery construction must not fetch them.
- Preserve existing generated images, authenticated Aiden asset references and safe embedded data under their current policies. Audit CSS thumbnails, sizing probes and preload paths as well as the img component.
- Keep an approval decision scoped to the displayed message/URL and current document lifetime. Do not add a global allow-all preference in this slice.
- Block loopback/private destinations unless an explicit separately designed local-content flow authorizes them. A string-only hostname check is insufficient for DNS/redirect safety.
- If private-address blocking cannot be reliably enforced in Chromium's direct path, use a main-owned bounded image fetcher with the existing SSRF transport policy. Recheck every redirect and response type/size; do not introduce an unrestricted image proxy.
- Preserve keyboard focus, alt text, layout stability, gallery behavior, theme tokens and reduced motion.

Primary files: renderer/components/markdown.tsx, message-bubble.tsx, streaming Markdown/gallery consumers and markdown-math.test.tsx; main transport/asset handling only if the proxy option is required.

Behavioral proof: a test HTTP server receives zero image requests before consent during streaming and reload; the exact allowed image loads after consent; changed URL requires new consent; local/private/redirect cases follow the chosen transport policy; generated assets still display. Use rendered behavior and Playwright network observation, not source-text assertions.

## W9: Pin the CI execution chain and make release gates explicit

- Pin Pullfrog and checkout actions to reviewed commit SHAs.
- Inspect the selected Pullfrog launcher's executed package path. Its reviewed version can bootstrap a caret-ranged npm package; an action SHA alone is not a complete runtime pin.
- Choose a supported exact-runtime mechanism, reviewed fork/patch or locked local bootstrap. Verify package integrity and dependencies as appropriate. Do not set an undocumented environment variable and assume it pins execution.
- Retain id-token: write while Pullfrog uses OIDC for GitHub token exchange. Reducing it requires a proven compatible authentication alternative.
- Inventory provider usage without reading or printing secret values. Remove unused secret bindings after identifying supported model/review configurations. Keep the workflow-dispatch boundary and narrow token permissions.
- Update CI policy tests to enforce the desired immutable inputs, replacing assertions that lock in floating tags. Verify a real authorized review run before claiming operational acceptance.
- In a separate small change, add explicit main-ref gates to macOS release and publish. Preserve the live release-environment main-only rule and Linux attestation gates. Validate dispatch conditions without signing a test build from an untrusted branch.

Primary files: .github/workflows/pullfrog.yml, .github/workflows/release.yml and scripts/check-ci-policy.test.mjs; a pinned-runtime helper only if required. Run npm run test:ci-policy and the existing workflow validation. Do not cancel main CI.

## W10: Apply bounded dependency maintenance

- Re-query official advisories and the current root/CLI lockfiles. Treat the original version/fix list as dated.
- For Zod, trace the actual SDK/schema collection path, including response limits and whether the vulnerable API is used. Its presence is enough to justify maintenance, not to claim a reproduced Aiden DoS.
- For CLI undici, trace TUI and daemon initialization through the actual installed Pi package to the selected fetch/dispatcher. Evaluate content-encoding, EventSource and integrity APIs separately.
- Prefer an exact evaluated fixed-version override where compatible. Do not use a broad npm audit fix that downgrades Pi, changes electron-builder outside its supported patch contract or silently updates unrelated packages.
- Run desktop/CLI replay, provider streaming, cancellation, proxy/custom TLS, MCP transport and bundle checks appropriate to the dependency changed. Inspect every resolved copy, not only the hoisted package.
- Recheck Electron releases for the tracked Node security fixes. The previously reviewed 43.8.3, 44.9.3 and 45.0.0 tags all declared Node 24.22.0; refresh this fact before selecting a release.

Primary files: package.json/package-lock.json, packages/cli/package.json/package-lock.json and the existing dependency update record. Use a separate PR for runtime dependency changes so rollback does not undo behavioral fixes.

## W11: Improve diagnostics and pairing availability

Create separate changes for these independent behaviors.

Diagnostics:

- Trace the entire subagent sanitizer pipeline before changing patterns. Namespaced x-api-key assignments already pass through sanitizeSubagentText.
- Prefer removing arbitrary production detail where typed stage/code/category is sufficient. If text remains, share a bounded token grammar and cover missing bare formats without relying only on known prefixes.
- Test the actual persisted log output with a synthetic credential corpus, including encoded/multiline assignments and provider errors. Confirm support exports still omit private detail.
- Run npm run test:diagnostics and focused subagent runtime tests. Never use real credentials as fixtures.

Tailscale pairing availability:

- Reproduce the shared-loopback bucket topology with a local trusted-proxy fixture and a live read-only transport check.
- Preserve global attempt/open-request/expiry caps. Do not solve fairness by removing limits.
- Use per-peer identity only if it comes from a verified trusted Serve boundary. Client-supplied forwarded headers are not proof of identity.
- Test that a noisy peer cannot starve ordinary pairing within the chosen fairness policy, and that aggregate resource bounds still hold.

Primary files: diagnostics-contract.ts, main/shared/redaction.ts, renderer/shared/subagent-safe-text.ts, subagents/subagent-runtime-diagnostics.ts; pairing-requests.ts, aiden-remote-router.ts and aiden-remote-service.ts for rate limits.

## W12: Strengthen distribution and renderer hardening

These changes follow the first security deliveries and require packaged evidence.

AppImage authenticity:

- Compare verifying a release-workflow attestation for the exact downloaded bytes with a dedicated publisher signing key distributed independently of the update feed.
- Document trust roots, offline behavior, verification dependencies, key/workflow rotation, release availability and rollback before implementing either option.
- Verify before atomic replacement. Preserve existing filename, identity, eligibility, checksum, cancellation and rollback checks.
- Test an asset plus checksum forged by the same feed, wrong repository/workflow/ref, expired/unavailable verification material and a valid release. Do not silently fall back to checksum-only installation.
- Update docs/linux.md to describe the actual guarantees and installation/update differences.

Production CSP:

- Remove development localhost script/style origins from shipped renderer HTML at build time while retaining the local development workflow.
- Inventory required connect-src destinations before narrowing them. Keep declared inference/custom-provider behavior working.
- Verify every shipped window and the production build output. Unit tests against source strings alone do not establish the packaged policy.
- Move the renderer to a custom protocol only in a separate compatibility change. Disable GrantFileProtocolExtraPrivileges after that migration proves asset loading, navigation, workers, preload and platform behavior.

Primary files: main/services/app-updater.ts, app-updater-linux.ts, main-window.html and other shipped windows, vite.config.ts, main/windows/window-paths.ts, scripts/configure-electron-fuses.mjs and distribution tests.

## Decisions and validation tasks

| Item | Recommended direction | Required evidence before implementation |
| --- | --- | --- |
| D1, Telegram versus workspace permission | Make No Access block regular-workspace Telegram admission. For Ask workspaces, either reject unattended use or require an explicit separately displayed Telegram automation grant. Preserve Bot policy ownership. | Read the current selector, command path, queued/active-turn behavior and Bot bindings; agree the user-facing rule and revocation behavior. No generic min(options.permission, workspace.permission) patch. |
| D2, desktop/mobile device grants | Host chooses consequential grants; client device type remains display metadata. | Inventory existing host/simulator/mobile grants, compatibility and notice requirements. Coordinate with W5; do not demand unverifiable hardware attestation. |
| D3, mobile draft backups | Chosen: exclude unsent drafts and pending-send text from backup to retain them only on the original device. Implemented as privacy hardening, without claiming previous upload or a proven policy violation. | iOS marks existing storage during unconditional app startup without opening a chat and rechecks before every protected write; tests cover migration, pending sends, deletion/recreation and exclusion failures. Backup restore does not migrate these records. Android backup/device-transfer exclusions remain unchanged. |
| V1, remembered approval identity | Validate a normal workspace deleted/recreated at the same path and a rebuilt managed worktree. Add incarnation binding only where current admission does not already reject it. | Reproduce approved exact-command reuse with a surviving workspace record. Include workspace removal, path relocation and normal atomic file changes. |
| V2, macOS entitlement necessity | Retain exceptions until their necessity is measured per process/helper, then narrow where supported. | Packaged macOS launch, native addons, JIT, automation, terminal, Accessibility, Screen Recording, microphone and helper checks. T3 uses similar exceptions; that is compatibility context, not proof they are required here. |
| V3, CLI control socket | Enforce a safe, owned private agent directory before bind and reject unsafe existing roots. Evaluate portable peer-uid checks after defining supported platforms. | Test another uid with a permissive pre-existing directory/umask; verify actual socket permission semantics. New private directories and same-uid callers do not establish the reported boundary violation. |

Each validation task ends with a disposition, source/test evidence and a bounded follow-up if necessary. Do not expand a conditional finding into a large redesign without that result.

## What we borrow from T3 Code

| T3 source at c294d63b | Observed pattern | Planned use |
| --- | --- | --- |
| apps/server/src/auth/http.ts and PairingGrantStore.ts | Host-issued expiring credentials; delegation cannot exceed issuer scopes. | W1/W5 and D2. |
| apps/server/src/mcp/OrchestratorMcpService.ts and McpToolAccess.ts | Schedule modes derive from caller limits; updates check task/bound-thread ceilings. | Additional authority checks in W2; retain Aiden's own persistence approval contract. |
| apps/server/src/serverSettings.ts and auth/ServerSecretStore.ts | Sensitive values separated from settings; private directory/files. | W3a/W3b storage separation and migration; preserve Aiden encryption. |
| apps/mobile/src/Stack.tsx and voice-input/ComposerDictationControl.tsx | Inspected routes navigate to threads/drafts; recording has an explicit start action. | W4 separation of navigation and recording. |
| packages/client-runtime/src/markdownImages.ts and web ChatMarkdownMedia.tsx | Ordinary remote images render directly. | No privacy control to adopt; W8 remains necessary under the proposed Aiden policy. |
| apps/server/src/http.ts | Generated HTML CSP sandboxes origin but does not enforce Aiden's network-deny policy. | Preserve Aiden's stricter viewer CSP; M-8 remains closed as reported. |
| docs/internals/environment-auth.md and docs/user/permission-modes.md | Environment-wide filesystem trust; initial Full thread default. | Clarify the policy difference; do not import these choices into Aiden implicitly. |
| scripts/build-desktop-artifact.ts and mobile draft persistence | Similar runtime exceptions and no established stronger draft-backup control. | V2/D3 need Aiden-specific evidence. |

## Documentation and onboarding work

Every implementation slice updates affected current guidance in the same PR. Dated audits, completed plans and old TestFlight records remain history; add a dated follow-up rather than rewriting their original claims.

| Slice | Required documentation review |
| --- | --- |
| W1 and D1 | README.md, PRODUCT.md, Telegram Settings/help and current Telegram guide/design references. Explain explicit pairing, reset and workspace authority. |
| W2/W6 | packages/cli/README.md, current schedule help, schedule editor/approval copy, shared schedule contracts and native client guidance where applicable. |
| W3 | README.md and current config/connector help; explain device-local secrets and pending launch consent without exposing values. |
| W4/W5/D2 | docs/aiden-on-the-go-remote-access.md, docs/aiden-remote-api-v1.md if contracts change, docs/devices.md where affected, ios/README.md, mobile metadata/privacy descriptions and current Remote threat model. |
| W7/W8 | docs/workspace-artifacts.md, image/visual help and relevant accessibility behavior. |
| W9/W10/W12 | Current release/distribution/installation guidance, docs/linux.md, version/pin records and the applicable maintainer commands. |
| All | docs/plans/README.md status, relevant project .memory records only when implementation/decisions change, and small adjacent stale claims discovered in the same scope. |

For UI work, first read GUI.md, docs/design-guide.md, docs/settings-design-system.md and both ChatGPT inspiration/specimen references; use the applicable Graphical skill. Keep semantic tokens, shared action shapes, neutral keyboard focus and existing text-input focus behavior.

Review onboarding where pairing, permissions or privacy setup changes. Update the final feature gallery only if a durable core capability or its advertised behavior materially changes. Preserve code-drawn themed art, keyboard/hover behavior and reduced motion.

## Verification matrix

Commands below are implementation-time checks, not evidence already obtained by writing this plan. Recheck package scripts before execution and register new tests in the existing chains/CI registry.

| Area | Local automated verification | Acceptance beyond unit tests |
| --- | --- | --- |
| Telegram | npm run test:telegram; touched IPC/settings behavioral tests | Attended pairing/reset with real bot and two accounts, no token logging. |
| CLI scheduling | Focused extensions/parity suites; CLI type-check/build and package test chain; npm run test:scheduled if shared code changes | Interactive approval and restart persistence, plus no-UI refusal using isolated CLI state. |
| Config/MCP | npm run test:portable-config; npm run test:mcp | Existing-permission migration on macOS/Linux; encrypted-store unavailable/failure cases; pending connector never launches. |
| Remote | npm run test:aiden-remote; request-specific tests first | LAN/Tailscale pairing, expiry, disable and revocation with current clients. |
| Scripts | npm run test:scheduled; npm run test:assistant-automations; applicable CLI checks | Isolated real child process, environment capture using synthetic values, cancellation and replacement races. |
| Artifacts | npm run test:workspace-artifacts; focused coding-tool path-policy cases | Rendered existing/new artifact refresh and cached-denial behavior. |
| Images | Focused markdown-math/render tests; targeted Playwright network test with fail-on-flaky-tests | Production Chromium verifies no request before consent and safe redirect/private-host behavior. |
| Mobile | Focused XCTest and Android navigation/voice/draft tests; cross-client fixtures | Physical devices with external app links, permissions granted/denied, reconnect and installation switching. |
| CI/dependencies | npm run test:ci-policy; relevant replay/bundle/transport suites | Exact-head hosted CI and a real authorized Pullfrog review; packaged runtime where ABI/SDK changes matter. |
| Logs | npm run test:diagnostics; focused subagent log tests | Inspect isolated production-profile persisted bytes and exported support bundle with synthetic secrets. |
| Updates/CSP/entitlements | Existing updater/build/fuse tests; platform-specific packaged checks | Signed macOS launch/TCC/helper checks; real Linux AppImage valid/forged update acceptance in isolation. |

Use existing native test targets discovered from the project, an explicitly selected device destination and the local Android toolchain. The iOS project is ios/AidenOnTheGo.xcodeproj with scheme AidenOnTheGo. Do not invent a generic Swift package test command or treat a desktop suite as native-client coverage.

Tests must assert observable behavior: denial leaves no state, credentials are absent from bytes, a child receives only allowed environment values, a network server receives no request, or the native recording action does not fire. Avoid source grep, copied constants, exact class strings and mock-call-only assertions as the primary oracle.

## PR boundaries and sequencing

Each work item is independently reviewable. W3a and W3b, dependency updates and CI pins, and AppImage/CSP/protocol migration should remain separate PRs.

- W1, W2, W3a and W4 have no implementation dependency on one another. Execute them in the priority order above; concurrent edits require isolated worktrees and explicit coordination.
- W3b follows W3a. W6 and W7 can reuse a narrowly shared policy helper only after its contract is clear; neither should depend on a new global authorization framework.
- W5 can be designed alongside D2, but an unproven device-type policy change must not delay basic host-window admission.
- W9/W10 are separate maintenance changes after local checks. V1/V2/V3 and D1/D3 produce evidence/decisions before their fix PRs.
- Run narrow suites before requesting hosted reviews. After every push or main merge, require green CI on that exact head and no unresolved actionable review threads.
- Merge origin/main into shared PR branches; never rebase or force-push them. Recheck the root test chain by union and claim the next live Remote revision only if the change actually alters its wire contract.

## Migration, release and rollback

No migration may start inference, launch MCP, download a catalog, start a VM, contact a provider, or send Telegram messages merely to inspect state.

| State changed | Forward migration | Safe rollback behavior |
| --- | --- | --- |
| Telegram pairing | Keep existing owners; unowned profiles wait for explicit host challenge. | Do not roll back to first-message-wins for an exposed unpaired profile. Disable bridge if an older binary cannot enforce new admission. |
| CLI approvals | New model mutations require the owned approval path; existing schedules retain their reviewed configuration. | Preserve valid schedules and operation receipts; avoid an old client silently restoring mutation bypass. |
| Config modes/secrets | Private permission repair; staged encrypted values followed by marker-only publication. | Keep modes private and credentials encrypted. Missing support must block affected connector launch, not materialize plaintext. |
| Mobile links | External URLs lose authority to record/create silently; internal actions carry trusted provenance. | Maintain navigation compatibility without restoring automatic external recording. |
| Remote requests | Preserve devices; unknown requesters require the new host window. | Existing devices remain revocable. Older code must not reopen unsolicited admission silently. |
| Script tasks | Existing definitions become review-required until selection/environment are bound. | Pause unsupported tasks; preserve definitions for reapproval. Do not discard new binding fields into a broader legacy task. |
| Artifact sources | Enforce secret policy and invalidate affected cache entries. | Do not restore a purged secret snapshot. Other artifact data remains intact. |
| Distribution trust | Versioned verifier/trust material with an intentional rotation path. | Restore a verified previous release; never fail open to unchecked replacement. |

Keep public diagnostics content-free. Track only bounded stage/result codes needed to tell pending, approved, denied, expired, migration-failed or verifier-unavailable states apart.

The release gate is per slice: local source/tests, exact-head CI/reviews, packaged app, physical devices and live networks are separate evidence. Mark each as passed, failed or pending with its exact revision/build. A merged PR is not proof that the installed app or a phone build contains the fix.

After a slice lands, update this plan and its index row with the PR/head and outstanding acceptance. Move this plan into completed/ only when every item has a recorded disposition, selected fixes have shipped through their required gates, and remaining decisions/validation tasks have explicit owners or linked follow-ups. Do not mark a deferred task complete merely because the first four fixes shipped.

## Execution record

- W10 implementation candidate: bounded fixed versions in both lockfiles; root and CLI audits report zero known advisories. Pi and electron-builder pins retained. See docs/security/dependency-maintenance-2026-10-27.md. Local verification: root/CLI types and builds, 146 CLI tests plus the built-CLI hostile-response/gzip probe, 352 MCP tests, 8 provider-failure tests, Markdown rendering and scoped lint pass. The Electron Node 24.22.1 fix landed separately on main (#632). 2026-10-29: updated with current main, lockfiles regenerated with no drift, and `@hono/node-server` 2.1.5 added for a new advisory; both audits report zero. Fresh review, exact-head CI and proxy/custom-TLS production acceptance are tracked separately.

- W5 implementation candidate: unknown desktop requests require a current host-opened Add device window, are bound to its incarnation and are cancelled on close/renewal/expiry. New installations default off; existing paired devices and saved settings remain. Fresh review closed an expiry-during-sealing gap with a final publication check and rollback; 129 focused tests, root types and lint pass. Existing already-approved sealed grants remain collectable after closing the admission window; no pending request can gain new authority. Hosted and real-client acceptance remain pending.

- W2 implementation candidate: foreground schedule consent, unchanged request/target/provider binding, cancellable expiring publication receipt, task revision checks and duplicate-submission refusal. CLI type-check, build, scoped lint and all 146 CLI tests passed. Three existing daemon tests now await explicit readiness instead of racing bounded filesystem polling. Fresh independent review found and closed Ask-mode read approval bypass, oversized existing-task confirmation and rejected-persistence cron restoration gaps. Desktop scheduling (238 tests), automation suites and root types passed. Exact-head hosted CI remains pending.
- W2 consent-display follow-up (2026-10-27): save confirmation now presents frozen effective inputs, including defaults and an edited task's retained timezone; publication consumes that prepared input. Resume presents stored prompt/script, execution mode and connector/provider/workspace scope with enabled true. Undisplayable resumes fail before confirmation, while pause/removal and shortening a long old prompt remain available. Generic model-tool saves refuse specialized feature-owned edits; direct administration is unchanged. CLI type-check, fresh build, scoped lint and all 153 package tests passed, including eight focused cases/subcases. A separate offline Bot-routine probe also refused the generic edit before confirmation and preserved its stored bytes. README, PRODUCT, plan-index and schedule documentation claims were checked; only the CLI guide and plan index needed changes. Shared scheduling/native clients are unchanged. Fresh review and exact-head hosted CI remain pending; this is source/test evidence, not packaged or live acceptance.

## Completion checklist

- [ ] Refresh source/configuration baselines and retain the original audit as history.
- [ ] W1 Telegram pairing implemented and accepted.
- [ ] W2 CLI scheduling approval implemented and accepted.
- [ ] W3a private config modes migrated and accepted.
- [ ] W3b pending MCP secrets sealed without launch/credential-binding regression.
- [ ] W4 external mobile voice/state mutation boundary accepted on both clients.
- [ ] W5 host-initiated Remote admission implemented, or its revised consent design explicitly recorded.
- [ ] W6 script selection/environment policy implemented with migration.
- [ ] W7 artifact secret policy and cached-data handling implemented.
- [ ] W8 external image loading consent and transport behavior accepted.
- [ ] W9 action/runtime pins and explicit release conditions accepted.
- [ ] W10 dependencies evaluated, updated where applicable and replay-verified.
- [ ] W11 diagnostics and Tailscale fairness work accepted or separately tracked.
- [ ] W12 update authenticity/CSP work accepted or assigned explicit follow-up plans.
- [ ] D1, D2 and D3 decisions recorded with their effects on docs and tests.
- [ ] V1, V2 and V3 validations resolved with evidence and bounded follow-ups.
- [ ] M-8 and currently mitigated L-5 remain accurately described; no false-positive fix is claimed.
- [ ] Documentation, onboarding where applicable, exact-head reviews and release evidence are current.
