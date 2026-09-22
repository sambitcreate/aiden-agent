# Bot-First Aiden On The Go — Phase 2 evidence

Date: August 23, 2026
Status: Complete — main-owned Bot services, protected authority, managed homes, scoped catalogs, Telegram routing, crash recovery, coverage, physical-iPhone verification, and post-remediation reviews passed.

## Delivered boundary

Phase 2 moves Bot identity, access, managed-home, catalog, and lifecycle mutations behind main-owned application services. It does not yet expose the production Remote Bot routes or enforce the effective capability set at every tool effect; those remain Phases 3 and 4.

- Electron Bot handlers call `BotApplicationService`; HTTP never invokes IPC or impersonates a renderer document.
- Every valid new or migrated Bot has one explicit Full/Custom policy and one durable private managed home shared by its chats.
- Managed-home provisioning is owner-only, inode-bound, revalidated before use, and never creates `.git`.
- Bot and chat access changes use optimistic revisions, exact Custom bindings, private catalog facts, policy epochs, and revocable leases.
- Provider/model, approved-location, shell, MCP, Skill, and other capability choices project only bounded public labels and opaque identifiers. Paths, credentials, schemas' private fingerprints, skill contents, and internal incarnations stay main-only.
- Bot-home skills are cataloged only for their owning Bot. New-Bot catalogs include configured/global skills but no existing Bot home.
- Create, chat-create, copy, delete, archive, restore, Telegram binding, and legacy migration use explicit reconciliation or fail-closed repair states.

## Rollback and crash authority

The capability document is authenticated with a device-local opaque key and a Keychain-backed high-water checkpoint. A separate one-way Keychain bootstrap marker allows an existing pre-policy profile to migrate exactly once and prevents later loss of local Bot state plus the rollback anchor from reopening implicit Full authority.

- Protected policy state includes the Bot's active/archived authority and provider/MCP/Skill incarnation generations.
- Archive narrows protected authority before publishing the archived identity. Restore publishes the identity before reactivating protected authority. Every journal checkpoint is restart-idempotent.
- Offline rollback of `bots.json`, the capability document, or a retired incarnation sidecar cannot restore authority.
- Unsupported, corrupt, missing, rolled-back, or future-version identity/policy/home state is preserved and fails closed.
- A deletion that crosses the durable subagent tombstone boundary remains roll-forward-only. Restart completes generic chat deletion before Bot policy cleanup, avoiding an orphan policy.
- Visible commits whose recovery record cannot be finalized poison further live Bot mutations until restart instead of guessing the result.

## Telegram boundary

Telegram retains the external route workspace as context while the Bot backing chat and turn execute in the Bot's managed home.

- Binding resolution revalidates the live Bot, exact managed home, exact backing chat, and Bot-owned chat policy before dispatch.
- Corrupt, malformed, future, or rolled-back binding state never falls back to ordinary full-permission Telegram.
- Binding state uses a separate root-scoped Keychain authority with `pending(previous,next) → file publication → committed(next)` recovery and a one-way bootstrap marker.
- Offline restoration of a pre-unbind binding cannot reactivate the route.
- Bind, profile reset, and profile deletion share a profile-incarnation fence.
- An enabled Telegram backing conversation cannot be deleted until the person disconnects Telegram, so restart cannot resurrect a conversation the UI reported deleted.
- A Bot-storage failure blocks Bot routing safely without taking down unrelated Aiden surfaces.

## Review and remediation

The first integrated review found no P0, but found material rollback, crash, and isolation gaps that green unit tests had not covered:

- deletion could roll back after a durable subagent tombstone and later orphan a policy;
- Telegram backing-chat deletion could be undone by startup repair, and bind could race profile reset;
- corrupt Telegram binding state could demote a previously Bot-bound route into ordinary Telegram;
- Telegram unbind and Bot archive could be undone by restoring valid older JSON;
- unanchored resource incarnations could revive stale Custom grants;
- all managed Bot homes' skills were merged into every Bot's catalog.

The remediation added roll-forward deletion ownership, backing-chat deletion protection, profile fencing, all-or-nothing Telegram health, two-phase Keychain binding authority, protected archive status, protected incarnation generations, strict Bot document versions, and Bot-partitioned skill discovery. Regression tests cover each reported state sequence and all new crash checkpoints. Fresh post-remediation acceptance and security reviewers reported no remaining P0/P1/P2 behavior or authority gap. A final test review's coverage blind spots were closed with application-update behavior tests, a dependency-injected production Telegram validator matrix, a reduction-only Telegram authority facade, and a drift-free Bot coverage runner.

An optional OpenCode review was started as an additional lens but stalled after repository scanning and was interrupted; it did not supply findings or evidence. Independent lifecycle, security, catalog, Telegram, and final post-remediation reviews remain the review authority for this phase.

## Verification

```text
npm run type-check
PASS

npm run lint
PASS

npm run test:bots
PASS — 273/273

npm run test:bots:coverage
PASS — 273/273; 80.76% aggregate lines; BotApplicationService 88.77% lines

npm run test:telegram
PASS — 174/174

npm run test:aiden-service-boundary
PASS — 68/68

npm run test:aiden-remote
PASS — 278 passed, 1 environment-only skip

LAN transport spike (included by test:aiden-remote)
PASS — 7/7

npm run test:ios-release
PASS — Ruby 20 runs / 42 assertions; Node 27/27

jq empty protocol/aiden-remote/v1/openapi.json protocol/aiden-remote/v1/fixtures/contract.json
PASS

git diff --check
PASS
```

### Physical iPhone 13 Pro

The revision-8 Swift contract and shared chat implementation were built, installed, and tested on the connected, unlocked physical iPhone 13 Pro. The later remediation changed only Mac-side TypeScript services and tests; the tested Swift and shared fixture bytes did not change afterward.

- Xcode destination: `00008110-00063CD91E98801E`
- Model: iPhone 13 Pro (`iPhone14,2`)
- OS: iOS 27.0
- Result: 142 passed, 5 configuration-only skips, 0 failures
- Result bundle: `/tmp/aiden-bot-phase2-device.LYLNHN/AidenBotPhase2.xcresult`
- Result status: `Passed`

The selected physical run covered `AidenBotContractTests`, `AidenChatTests`, `AidenRemoteClientTests`, and `AidenRemotePhase0Tests`. The five skips require external live-server or signed-Keychain configuration. No simulator was launched or used.

## Gate result

Phase 2 is complete. Phase 3 must still enforce the selected Full/Custom authority at turn and tool-effect admission, inject the managed-home system instructions, set the runtime working directory, and filter provider, Files, shell, MCP, Skill, and other capabilities on every Bot surface.
