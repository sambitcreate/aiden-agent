# Logging and Diagnostics Phase 0 Inventory

Status: Complete; inventory frozen and enforced by the implemented contract/policy tests  
Baseline: `origin/main` at `13748505984aeb9a8f99017a1e7eef5a6452526f`  
Date: 2026-08-27  
Parent plan: [`logging-and-diagnostics-upgrade-plan.md`](logging-and-diagnostics-upgrade-plan.md)

## Purpose

This inventory freezes the implementation baseline before Aiden changes its
logging contracts. It identifies every existing Electron-main logger family,
the direct console bypasses, persistent diagnostic stores, renderer/native
coverage, and the intended migration class for each surface.

This is not an authorization to persist the current arbitrary logger payloads
in production. Existing messages and raw `Error` objects must first be replaced
by typed, allowlisted diagnostic events.

## Exact baseline counts

The clean `origin/main` baseline contains:

- 157 non-test `logger.*` calls across 39 main-process files;
- 1 debug, 25 info, 78 warn, and 53 error calls;
- three direct runtime `console.*` bypasses outside `main/platform.ts`;
- one non-test iOS OSLog category and one log emission;
- zero explicit non-test Android application log calls;
- no Aiden-owned automatic log, analytics, or crash upload path.

Three callsites use a dynamic scope supplied by a main-owned application-service
adapter. That is why literal-scope extraction accounts for 154 calls while the
complete method count is 157.

## Main-process file inventory

| Calls | Debug | Info | Warn | Error | File | Initial migration class |
| ---: | ---: | ---: | ---: | ---: | --- | --- |
| 56 | 0 | 8 | 21 | 27 | `main/index.ts` | Named lifecycle/recovery events; remove raw URLs/paths/errors. |
| 27 | 0 | 5 | 16 | 6 | `main/services/llm-client.ts` | Named generation/provider/persistence outcomes; aggregate success paths. |
| 11 | 1 | 3 | 5 | 2 | `main/services/app-updater.ts` | Named updater outcomes; development adapter for third-party chatter. |
| 7 | 0 | 1 | 5 | 1 | `main/services/telegram/telegram-service.ts` | Named transport outcomes; remove profile interpolation and raw causes. |
| 4 | 0 | 1 | 1 | 2 | `main/services/aiden-remote-service-main.ts` | Request policy plus named service failures. |
| 4 | 0 | 0 | 0 | 4 | `main/services/secrets.ts` | Closed secure-store error categories; no provider IDs or raw errors. |
| 4 | 0 | 0 | 3 | 1 | `main/services/shortcut.ts` | Named registration/persistence/rollback outcomes. |
| 2 | 0 | 2 | 0 | 0 | `main/handlers/chat.ts` | Replace JSON strings/raw stream IDs with operation-scoped events. |
| 2 | 0 | 2 | 0 | 0 | `main/handlers/index.ts` | Development-only registration breadcrumbs or remove. |
| 2 | 0 | 0 | 0 | 2 | `main/handlers/subagents.ts` | Named private-history/control failures. |
| 2 | 0 | 0 | 2 | 0 | `main/services/artificial-analysis-runtime.ts` | Named cache validation/durability categories. |
| 2 | 0 | 0 | 1 | 1 | `main/services/dictation.ts` | Named speech/session outcomes. |
| 2 | 0 | 0 | 2 | 0 | `main/services/legacy-pi-credential-migration.ts` | Named migration outcome; no provider IDs/errors. |
| 2 | 0 | 0 | 0 | 2 | `main/services/mcp-oauth-store.ts` | Closed encrypted-store categories; no server IDs/raw errors. |
| 2 | 0 | 0 | 1 | 1 | `main/services/mcp-oauth.ts` | Named auth/transport/cleanup outcomes. |
| 2 | 0 | 0 | 2 | 0 | `main/services/models-catalog.ts` | Named cache/catalog validation categories. |
| 2 | 0 | 0 | 2 | 0 | `main/services/profile-share.ts` | Named temporary-file cleanup categories; no paths. |
| 2 | 0 | 0 | 2 | 0 | `main/services/provider-credential-rotation.ts` | Named rotation/recovery categories. |
| 2 | 0 | 0 | 1 | 1 | `main/services/schedule-service.ts` | Named engine outcomes; map callback strings at boundary. |
| 1 | 0 | 1 | 0 | 0 | `main/handlers/app.ts` | Remove or development-only; request volume has no diagnostic value. |
| 1 | 0 | 0 | 1 | 0 | `main/handlers/model-insights.ts` | Named cache/fetch outcome with safe source category. |
| 1 | 0 | 0 | 1 | 0 | `main/handlers/shortcuts.ts` | Named handler rejection category. |
| 1 | 0 | 0 | 1 | 0 | `main/platform.ts` | Named IPC notification-delivery category. |
| 1 | 0 | 0 | 0 | 1 | `main/services/chat-application-service-main.ts` | Replace dynamic adapter with typed event port. |
| 1 | 0 | 0 | 1 | 0 | `main/services/chat-title.ts` | Named background-title outcome; no model/error text. |
| 1 | 0 | 0 | 1 | 0 | `main/services/config-store.ts` | Named deferred-startup category. |
| 1 | 0 | 0 | 1 | 0 | `main/services/dictation-cleanup.ts` | Named cleanup category. |
| 1 | 0 | 1 | 0 | 0 | `main/services/local-models.ts` | Development breadcrumb or safe model-family outcome. |
| 1 | 0 | 0 | 1 | 0 | `main/services/mcp-credential-cleanup.ts` | Named credential cleanup category. |
| 1 | 0 | 0 | 1 | 0 | `main/services/mcp.ts` | Named client lifecycle/cleanup category. |
| 1 | 0 | 0 | 1 | 0 | `main/services/pi-credential-store.ts` | Named durability category. |
| 1 | 0 | 0 | 1 | 0 | `main/services/provider-auth-flow.ts` | Existing categorical shape; migrate into event registry. |
| 1 | 0 | 0 | 1 | 0 | `main/services/provider-list-main.ts` | Named auth-status availability category. |
| 1 | 0 | 0 | 1 | 0 | `main/services/schedule-execution.ts` | Named execution cleanup/outcome category. |
| 1 | 0 | 0 | 1 | 0 | `main/services/subagents/subagent-health-metrics.ts` | Internal sink-health event with recursion guard. |
| 1 | 0 | 0 | 1 | 0 | `main/services/usage-store.ts` | Named aggregate-store durability category. |
| 1 | 0 | 0 | 0 | 1 | `main/services/workspace-application-service-main.ts` | Replace dynamic adapter with typed event port. |
| 1 | 0 | 0 | 0 | 1 | `main/services/workspace-worktree-application-service-main.ts` | Replace dynamic adapter with typed event port. |
| 1 | 0 | 1 | 0 | 0 | `main/windows/pill-window.ts` | Remove URL; keep development-only window-load event if useful. |

## Scope inventory

Literal logger scopes group into these migration batches:

| Batch | Current scopes | Current calls | Target policy |
| --- | --- | ---: | --- |
| Core lifecycle | `main`, `electron-lifecycle`, `renderer-lifecycle`, `main-window`, `ipc`, `handlers`, `app`, `pill`, `dev-log` | 49 | Production breadcrumbs only for state transitions and terminal recovery outcomes; remove routine request/registration noise. |
| Generation | `pi`, `chat`, `chat-title`, `assistant`, `scheduled-tasks` | 32 | Named operation outcomes with ephemeral correlation; successful high-frequency activity aggregates. |
| Providers and credentials | `providers`, `secrets`, `provider-auth`, `pi-credential-store`, `artificial-analysis`, `models-catalog`, `model-insights`, `local-models` | 18 | Closed provider/cache/credential categories; no raw IDs, endpoints, messages, or errors. |
| Background services | `updater`, `telegram`, `schedule`, `mcp`, `mcp-oauth`, `dictation`, `terminal`, `profile-share`, `usage` | 41 | Named lifecycle/terminal outcomes; adapters map library strings before the shared logger. |
| Remote, workspaces, and subagents | `aiden-remote`, `subagents`, `git`, `bots`, plus three dynamic service scopes | 17 | Request failure/slow/aggregate policy; typed application-service event ports; preserve the private subagent diagnostic contract. |

The batch total is 157, including the three dynamic application-service calls.

## Direct console bypasses

These calls must be routed through the safe core in Phase 1:

| File | Current call | Decision |
| --- | --- | --- |
| `main/services/parakeet-engine.ts` | `console.error` for native engine load failure | Map to a closed local-speech engine category; development may retain a sanitized module-relative stack. |
| `main/services/renderer-document-owner.ts` | `console.error` for callback failure | Map to renderer-document lifecycle failure without document IDs or payloads. |
| `main/services/skills-discovery.ts` | `console.warn` for discovery failure | Map to a skill-discovery category without paths or raw exception text. |

Protocol-owning native/CLI stdout and stderr are not part of these three bypasses.
They need a separate allowlist so the future lint rule does not break helper
protocols or ordinary build-script output.

## Existing persistent diagnostic stores

| Store | Profiles | Current bound | Initial decision |
| --- | --- | --- | --- |
| `aiden-dev.log` | Development | Startup rotation after 2 MiB, one previous file; current session not actively bounded | Migrate to the safe event core and active rotation in Phase 1. |
| `subagent-runtime.log` | Development and production | Current and previous file, each at most 2 MiB; `0600`; structured and strongly sanitized | Preserve separately through the first production-journal release and reuse its security patterns. |
| `subagent-health-metrics.json` | Subagents enabled | At most 90 daily aggregate rows | Preserve; use its closed no-content schema as the aggregate template. |
| Electron Crashpad | Development only | Local capture, upload disabled; no plan-owned retention | Keep production full dumps off by default; add categorical tombstones first. |

## Renderer and native inventory

### Renderer

- `renderer/lib/ui-utils.ts` initializes no logger.
- `renderer/lib/dev-log.ts` forwards global errors and unhandled rejections only
  when build-time `import.meta.env.DEV` is true.
- main accepts `devlog:write` only outside packaged-production behavior, while
  the runtime profile can be explicitly overridden. The two authorities can
  disagree.
- repository-owned React/router boundaries display failures but do not emit a
  caught-error event.

Initial decision: main owns a read-only diagnostic policy, production renderer
events are categorical, development stacks are sanitized and module-relative,
and repeated failures are rate-limited before IPC.

### iOS

- one `Logger` category: `VoiceInput`;
- one error emission: a public enum-like voice failure category;
- no general connection/cache/contract/stream/prior-termination wrapper.

Initial decision: preserve the current safe voice event and build a
private-by-default OSLog wrapper around reviewed categorical fields.

### Android

- no explicit non-test application logging calls;
- no typed logging wrapper or prior-termination reduction.

Initial decision: add a typed wrapper only after the shared category registry is
frozen; do not enable HTTP request/response logging.

## Prohibited current payload shapes

The following existing patterns cannot be copied into the production journal:

- raw `Error` and library error objects;
- arbitrary callback messages from updater, Telegram, schedule, dictation, MCP,
  and application-service adapters;
- raw stream IDs, server IDs, provider IDs, device suffixes, or profile names;
- renderer, preload, workspace, staging, temporary, or executable paths;
- full URLs, validated URLs, or blocked external URL values;
- JSON-formatted message strings standing in for structured events;
- provider/runtime diagnostics that may contain headers, endpoints, request
  fragments, environment values, or credential-shaped text.

Phase 0 must map each of these to a closed event/code/field contract before the
production sink is enabled.

## Initial classification rules

| Class | Meaning | Examples |
| --- | --- | --- |
| Named retained event | A recent state transition or terminal failure needed for causal diagnosis | startup ready/failure, renderer exit/recovery, provider terminal category, datastore failure, updater terminal outcome |
| Aggregate-only | Useful as bounded health evidence but too frequent or identity-bearing per operation | Remote 2xx, successful IPC, generation starts/completions, stream/terminal byte counts |
| Development-only | Useful while engineering locally but not worth production retention | handler registration, app-info requested, raw third-party debug chatter |
| Remove | Noise, duplicated evidence, or inherently unsafe with no categorical value | URL load messages, redundant free-form wrapper errors after an owned terminal event |

## Phase 0 delivered artifacts

1. `DiagnosticEventV1` field and byte-budget decision record.
2. Finite area, event-name, outcome, and safe-code registry.
3. Safe error-category matrix for Node/Electron, provider, network, storage,
   process, cancellation, and native Remote failures.
4. Prohibited-data/adversarial fixture corpus.
5. Runtime-profile negotiation contract for main and renderer.
6. Exact journal rotation, retention, fatal-tombstone, export, and deletion
   contracts.
7. Machine-readable inventory/policy test that rejects new direct runtime
   console calls and unregistered sinks without treating protocol/build output
   as application logging.

These artifacts now live in the typed diagnostics contract, journal/support
services, renderer bridge, native wrappers, and `test:diagnostics` policy suite.
Adversarial tests prevent arbitrary objects, open categorical strings, unsafe
errors, credentials, paths, symlink/hardlink targets, and unbounded evidence from
entering retained production data.
