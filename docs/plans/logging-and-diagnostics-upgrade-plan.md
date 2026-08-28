# Logging and Diagnostics Upgrade

Status: Implementation complete; signed-release and physical-device acceptance remain release-environment gates
Date: 2026-08-27
Audit snapshot: clean feature worktree based on `origin/main` at `13748505984aeb9a8f99017a1e7eef5a6452526f`
Scope: Electron main/preload/renderer, Aiden Remote, native helpers, iOS, Android, test/build diagnostics, device-local support export, privacy, retention, and release acceptance

## Implementation outcome

All eight delivery phases are implemented in `feature/logging-diagnostics-upgrade`.
The production default is a typed, privacy-projected, owner-only local journal;
renderer faults are admitted and rate-limited by main; high-volume Remote success
traffic is aggregate-only; support can reveal, export, and delete diagnostics;
crash dumps remain explicit and local; and iOS/Android emit the shared categorical
failure vocabulary. No upload path was added.

| Phase | Implemented result |
| --- | --- |
| 0 | Closed event/error/field contracts, prohibited-data rules, inventory, profile, retention, export, and deletion contracts. |
| 1 | Shared sanitizer/projector, structured development journal, active size/age rotation, queue-serialized status/export cleanup, an unref'd long-idle retention sweep, bounded queues/flushes, and direct-console policy. |
| 2 | Production journal, synchronous bounded fatal evidence, renderer/process recovery evidence, crash-loop handling, and explicit local-only Crashpad mode. |
| 3 | Named operational evidence plus content-free 90-day health aggregates; successful Remote requests are aggregate-only. |
| 4 | Global/React/route renderer coverage with synchronous listener install, bounded pre-policy buffering, document authority, and main-owned limiting/references. |
| 5 | Diagnostics status, reveal, manifest-first export, atomic destination replacement, separately confirmed dumps, and exhaustive scoped deletion. |
| 6 | iOS OSLog/MetricKit and Android typed logging/ApplicationExitInfo coverage for auth, network, contract, cache, stream, speech, notification, Live Activity, and prior termination. |
| 7 | Registered focused suite, source/privacy policy, sanitized seven-day CI receipt, production-profile E2E, and post-distribution packaged acceptance that invokes the real preload IPC and proves explicit upload-disabled Crashpad mode before release publication. |

## Verification evidence

The implementation has passed the repository's full desktop test command, the
focused diagnostic contract/policy suite, TypeScript and E2E type checks, ESLint,
the standard Electron E2E matrix, the isolated production-profile diagnostics
E2E, Android lint/build/unit-test gates, and a generic-device iOS
`build-for-testing` with signing and asset compilation excluded. A development-
signed packaged app is rebuilt and exercised through the same artifact-level
acceptance runner wired after signed distribution in release automation. The
runner checks owner-only storage, invokes explicit crash mode through the
packaged renderer/preload/main path, and confirms the real native warning by its
accessibility label before asserting that capture started.

Release-owned evidence still outstanding:

- run the artifact acceptance against the exact signed and notarized release
  app produced by the release job;
- collect fresh-device iOS MetricKit crash/hang delivery and Android
  `ApplicationExitInfo` termination receipts.

Automated implementation evidence is complete. The release environment still owns
two non-code acceptance actions: run the post-`dist` smoke against the actual
signed/notarized artifact, and exercise MetricKit/ApplicationExitInfo behavior on
physical iOS/Android devices. This plan stays outside the completed archive until
those release receipts exist; the gaps do not represent unfinished runtime code.

## Executive decision

Aiden will have one privacy-safe diagnostic architecture across development and
production. Development remains detailed and convenient. Production gains a
small, structured, owner-only local journal containing warning/error/fatal
events and an allowlisted set of lifecycle breadcrumbs. Nothing uploads
automatically.

The implementation must preserve Aiden's current privacy position:

- no prompts, responses, reasoning, transcript text, tool arguments/results,
  terminal output, attachment contents, screenshots, audio, or clipboard data;
- no credentials, headers, cookies, environment values, endpoint query strings,
  local paths, account identities, or stable device identifiers;
- no analytics SDK, hosted relay, remote crash reporter, or background upload;
- full Electron crash dumps remain off by default because process memory can
  contain sensitive data;
- diagnostics leave the device only after an explicit user export action.

This plan is the focused implementation track for the local diagnostics work
already called for by Phase 0 of
[`performance-stability-efficiency-plan.md`](performance-stability-efficiency-plan.md).
That plan remains authoritative for performance scenarios and budgets; this
plan owns the logging contracts, sinks, privacy rules, support UX, native parity,
and rollout.

## Audit baseline

| Surface | Current behavior | Material gap |
| --- | --- | --- |
| Electron main | 157 non-test `logger.*` calls: 1 debug, 25 info, 78 warn, 53 error. Every level writes to `console.*`. | No level policy, structured schema, or dependable packaged-production sink. |
| Development file | `aiden-dev.log`; serialized appends, ISO timestamps, 4,096-character line cap, partial credential redaction, startup-only rotation after 2 MiB. | Raw console output precedes redaction; file mode is not explicitly enforced; a long session can grow without bound; ordinary queued writes are not flushed on shutdown. |
| Production file | No general application journal. | Failures commonly disappear when console output is unavailable. |
| Renderer | Development-only global `error` and `unhandledrejection` forwarding. React boundaries show a fallback without recording caught failures. | Packaged renderer failures lack durable evidence; build-time `import.meta.env.DEV` can disagree with the main-owned runtime profile. |
| Electron lifecycle | Renderer exit/unresponsive/load/preload failures, child-process exits, and quit lifecycle are logged. | Production records are console-only and have no crash-loop history. |
| Subagents | `subagent-runtime.log` is structured, owner-only, strongly sanitized, actively rotated at 2 MiB, and available in both profiles. Aggregate health metrics retain at most 90 days. | This good design is isolated rather than shared by the rest of the app. Its focused diagnostics test is not registered in a package test script. |
| Aiden Remote | Every request records request ID, route, status, latency, device-ID suffix, and safe error code through the main logger. | Persisting every successful request would be noisy; suffixes should not become durable identifiers. |
| iOS | One OSLog error event records only a voice failure category. | Connection, persistence, contract, stream, and prior-termination failures are nearly invisible. |
| Android | No explicit non-test application logging. | Cache, network, contract, and prior-termination failures are nearly invisible. |
| Native helpers | Protocol stdout is generally clean; helpers emit terse fatal stderr. | Host diagnostics are inconsistent and may preserve unstructured helper text. |
| Build/CI | Test and build commands produce ordinary stdout/stderr; selected Playwright/APK artifacts have retention. | No common sanitized failure receipt, content scan, or focused result-bundle policy. |

## Goals

- Make a packaged production failure diagnosable without reproducing it under a
  development build.
- Ensure every diagnostic sink receives only data that already passed a shared
  privacy projection.
- Keep production storage, write amplification, and idle work predictably
  bounded.
- Correlate startup, generation, persistence, network, renderer, and helper
  failures within one app session without persisting user identity.
- Give users a clear local **Reveal diagnostics** and **Export diagnostics**
  workflow with a reviewable manifest and no implicit upload.
- Bring iOS and Android to categorical diagnostic parity for their shared Remote
  contracts while respecting platform-native privacy and retention behavior.
- Turn deterministic diagnostic contracts into release gates rather than
  relying on manual console inspection.

## Non-goals

- Product analytics, engagement tracking, cohorting, feature adoption, or
  developer-accessible telemetry.
- Automatic crash upload, remote log streaming, a hosted support backend, or a
  new account identity.
- Logging model inputs/outputs, tool traffic, repository contents, terminal
  content, HTTP bodies/headers, or user-visible draft/error strings.
- Adopting a third-party logging or analytics SDK when the bounded local need can
  be met with repository-owned code.
- Replacing authoritative application stores with logs or using diagnostics as
  a replay/event-sourcing system.
- Enabling full production crash dumps by default.
- Advertising diagnostics in onboarding or the final feature-tour gallery. It
  is a repair/support capability, not first-run setup or first-session value.

## Architecture

### 1. One event envelope

Every retained event uses a versioned closed schema. Callers choose an event
definition and supply typed allowlisted fields; they do not submit an arbitrary
message plus arbitrary objects.

```ts
interface DiagnosticEventV1 {
  version: 1;
  at: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  area: DiagnosticArea;
  event: DiagnosticEventName;
  sessionId: string;
  operationId?: string;
  durationMs?: number;
  outcome?: DiagnosticOutcome;
  code?: DiagnosticCode;
  fields?: DiagnosticSafeFields;
}
```

Contract rules:

- `sessionId` is random at launch and expires with the session.
- `operationId` is random and operation-scoped. Existing request/stream IDs may
  be mapped in memory, but raw chat, workspace, generation, device, account, or
  provider credential identifiers are not persisted.
- Event names, areas, outcomes, and codes are finite unions reviewed in code.
- Production `fields` accept booleans, bounded numbers, enums, semantic
  versions, byte/duration buckets, and explicitly safe bounded strings only.
- No arbitrary `unknown[]`, object spread, raw `Error`, stack, URL, or path can
  reach a production event constructor.
- The serialized event has a hard byte cap. Oversized fields are rejected or
  replaced with a safe truncation marker before enqueueing.
- Every envelope includes a schema version so future readers can ignore unknown
  records without treating the journal as authoritative state.

### 2. Safe error projection

Introduce one `projectDiagnosticError` boundary. Production projection is
allowlist-first:

- preserve a reviewed error category, stable safe code, retryability, and the
  originating subsystem;
- preserve an error class only when it is a platform/library name rather than
  caller-controlled text;
- map known provider, network, storage, process, IPC, and cancellation failures
  to closed outcomes;
- fingerprint normalized safe frames only when a useful, path-free fingerprint
  can be computed;
- omit raw messages and stacks from production by default;
- allow development stacks only after credential, URL, path, environment,
  control-character, and encoding sanitization.

The strong sanitizer used by subagent runtime diagnostics should inform the
shared grammar, but general events should avoid generating sensitive strings in
the first place. Regex redaction remains defense in depth, not the primary
privacy boundary.

### 3. Profile-aware policy

| Profile/surface | Console | General local journal | Detail policy |
| --- | --- | --- | --- |
| Desktop development | `debug` and above | `debug` and above | Sanitized stacks may include repository-relative source locations only; absolute local paths remain prohibited and development-only detail never enters an export. |
| Desktop production | Optional concise warn/error console | Allowlisted info plus warn/error/fatal | No paths, URLs, stacks, stable user/device IDs, content, headers, or arbitrary messages. |
| Renderer development | Global, React caught/recoverable, route failures | Forwarded to main under the runtime-profile policy | Sanitized component/route/module context; no props or rendered content. |
| Renderer production | No raw browser-console dependency | Safe categorical failures forwarded to main | Error category, route identifier, build, recovery outcome, opaque reference ID. |
| iOS debug | OSLog debug/info/warn/error | Platform unified log | Private-by-default interpolation; reviewed public enums only. |
| iOS production | OSLog warn/error/fault plus selected lifecycle info | Platform unified log and local categorical aggregate where required | No user content or persistent identity. |
| Android debug | Logcat debug/info/warn/error | Debug system log | Sanitized categories; no request/response logging. |
| Android production | Warn/error plus selected lifecycle outcomes | Small app-owned categorical ring if system history is insufficient | No content, endpoints, tokens, stable identity, or raw throwable messages. |

Runtime profile, not Vite build mode, is the authority for renderer forwarding.
Main exposes a read-only diagnostic-policy capability during renderer bootstrap;
the renderer cannot widen it.

### 4. Desktop journal

Add a repository-owned JSONL journal under the profile-specific `logsPath`:

- production filename: `aiden.log`;
- development filename may remain `aiden-dev.log` during migration, then adopt
  the same schema;
- directory `0700`; every current, rotated, temporary, and exported source file
  explicitly `0600`;
- serialized append queue with bounded in-memory backlog;
- rotate before append at 2 MiB;
- retain at most four files and at most seven days;
- total general-journal budget at most 8 MiB per runtime profile;
- atomic rotation with deterministic names and safe recovery from stale temp or
  interrupted rotation state;
- synchronous best-effort fatal tombstone path with a much smaller closed record;
- bounded flush during normal quit; timeout or write failure never blocks quit;
- persistence failure increments an in-memory health counter and surfaces only
  through a safe support status, without recursive logging.

Keep `subagent-runtime.log` separate initially because it has a narrower private
failure contract and working production recovery value. Export can merge its
sanitized records logically without rewriting the source. Revisit physical
consolidation only after one release proves equivalent privacy and retention.

### 5. Crash evidence

Always-on production crash evidence is limited to tombstones:

- app/build/runtime profile, OS/Electron/architecture versions;
- process kind and categorical exit reason/code;
- session ID, uptime bucket, recent recovery count, memory bucket;
- last bounded sequence of safe lifecycle event names;
- no stack, memory image, arguments, environment, URLs, or paths.

Electron full crash dumps are an explicit diagnostic-mode option:

- off by default;
- local capture only, `uploadToServer: false`;
- user-visible explanation that memory dumps can contain sensitive data;
- automatic disable after a bounded duration or next restart unless the user
  deliberately extends it;
- retain at most three dumps or seven days;
- separate consent when including dumps in an export;
- a **Delete diagnostic data** action removes journals, tombstones, and dumps
  without touching chats, settings, credentials, or other app state.

iOS should use MetricKit payloads only for local categorical crash/hang summaries
unless a future separately reviewed privacy decision authorizes more. Android
should inspect `ApplicationExitInfo` at launch and reduce it to the same safe
prior-termination categories. Neither client uploads reports.

### 6. Aggregates versus event logs

Use event records for recent causal debugging and closed daily aggregates for
longer health trends. Aggregate schema must not contain identities, event text,
or per-operation timestamps.

Initial aggregate candidates:

- launches, ready, failed startup, and crash-loop entries;
- renderer exits, recovery attempts, recovery successes/failures, unresponsive
  transitions;
- generation starts and terminal outcome categories;
- provider failure categories and retry exhaustion, never provider payloads;
- datastore read/write/corruption/recovery categories by store class, not path;
- updater checks/download terminal outcomes;
- scheduled-task engine start/run terminal categories without task identity;
- Remote Access request status classes, slow-request buckets, listener start
  outcomes, and pairing/revocation contract failures without device identity;
- Telegram transport lifecycle outcomes without chat/user identity;
- MCP connection lifecycle categories without server URL or tool data;
- helper launches/exits/timeouts by helper kind;
- native Remote connection, cache, stream, speech, notification, and Live
  Activity categories.

Retain at most 90 daily rows, matching the existing content-free subagent health
store. These metrics remain device-local and export only on explicit request.

### 7. Support export contract

Settings gains a compact **Diagnostics** surface with:

- status: approximate retained size, oldest/newest record date, diagnostic-mode
  state, and whether any sink has failed;
- **Reveal diagnostics folder**;
- **Export diagnostics…**;
- **Delete diagnostic data…** with confirmation;
- optional, separately confirmed inclusion of local crash dumps;
- no toggle for automatic upload because automatic upload does not exist.

Before implementation, review
[`../chatgpt-desktop-ui-inspiration.md`](../chatgpt-desktop-ui-inspiration.md) and
[`../chatgpt-ui-element-specimen.html`](../chatgpt-ui-element-specimen.html), then
use Aiden's semantic appearance tokens and existing Settings interaction
patterns.

Export builds a staged archive outside authoritative state, validates it, then
lets the user choose a destination. The archive includes:

- `manifest.json`: export/schema versions, app/build/platform versions, time
  range, included file classes, record counts, and omitted-data declarations;
- bounded sanitized general-journal records;
- bounded sanitized subagent runtime records;
- closed aggregate health snapshots;
- optional crash tombstones;
- optional full dumps only after the separate consent;
- no configuration files, databases, chats, usage records, credentials,
  terminal history, caches containing model/provider responses, or source paths.

The export validator reparses every JSONL line, rejects unknown files, scans for
credential/path/URL/content indicators, enforces aggregate byte limits, and
fails closed. Failed staging is removed best-effort and never replaces the
source diagnostics. The app never sends the archive.

## Event coverage matrix

| Area | Required production breadcrumbs | Required failure events |
| --- | --- | --- |
| Startup | bootstrap started, profile configured, Electron ready, main window created, renderer ready, providers ready | import failure, required store failure, window load/preload failure, startup timeout |
| Renderer | navigation/reload/recovery outcome | uncaught, unhandled rejection, React caught/recoverable, unresponsive, render-process-gone |
| Generation | admitted, provider dispatch, terminal outcome, cancellation origin category, compaction start/finish | provider category, persistence failure, durable-effect acknowledgement failure, stuck/unknown outcome |
| Persistence | store class read/write/recovery outcome and duration bucket | corrupt/schema/permission/disk-full/atomic-write/directory-sync category |
| Aiden Remote | listener start/stop, connection mode, request status/latency aggregates | listener collision, TLS/pairing/auth/revocation/route/stream failure category |
| Updater | check/download/install-handoff terminal outcomes | validation, network, timeout/stall, installer launch, rollback category |
| Schedules | engine start/stop and aggregate terminal outcomes | missed-run recovery, execution, persistence, shutdown timeout category |
| Telegram | service start/stop/reconnect terminal outcomes | polling/auth/rate-limit/delivery/persistence category |
| MCP | client connect/close outcome and duration bucket | auth, transport, schema, timeout, cleanup category |
| Voice | permission/start/transcription terminal category | microphone/audio/session/provider/local-helper category |
| Computer Use | broker/bridge/session lifecycle category | binary/signature/permission/protocol/timeout/cleanup category |
| Subagents | existing structured failure plus aggregate lifecycle | launch/bootstrap/protocol/provider/runtime/cleanup categories |
| Native mobile | launch, paired connection, cache hydration, stream resume, speech/notification lifecycle | contract/cache/network/auth/stream/speech/Live Activity/prior-termination category |

Successful high-frequency operations must not create unbounded records. Remote
2xx requests, IPC traffic, stream deltas, terminal chunks, filesystem bytes, and
render frames use aggregation or sampled benchmark instrumentation rather than
one durable event per unit.

## Delivery phases

### Phase 0 — Freeze privacy and event contracts

Implementation inventory:

- [`logging-and-diagnostics-phase-0-inventory.md`](logging-and-diagnostics-phase-0-inventory.md)

Deliverables:

1. Inventory every current logger/direct-console callsite and classify it as:
   migrate to a named event, development-only, aggregate-only, or remove.
2. Define `DiagnosticEventV1`, level policy, area/event/code registries, safe
   field types, byte budgets, and safe error categories.
3. Add a prohibited-data matrix covering credentials, paths, URLs, identities,
   content, headers/bodies, environment values, stacks, and crash memory.
4. Define runtime-profile negotiation for main and renderer.
5. Define exact storage, retention, file-mode, export, and deletion contracts.
6. Update public/privacy documentation only if the final implementation changes
   any user-facing statement. Local-only diagnostics with explicit export should
   not be described as developer collection.

Tests and gates:

- type tests prevent arbitrary objects/errors from entering production events;
- fixture corpus covers provider/network/storage/process error families;
- adversarial privacy cases cover encoded credentials, Basic/Bearer auth,
  cookies, JWTs, AWS/GitHub/npm/provider keys, credential URLs, Unicode/control
  splitting, POSIX/Windows/UNC paths, and query strings;
- architecture review signs off before a file sink is enabled in production.

Exit gate:

- every retained field and every exception to the prohibited-data matrix is
  explicit, tested, and documented.

### Phase 1 — Shared logger and development migration

Deliverables:

1. Implement the event registry, safe serializer, error projector, sink
   interface, queue/backpressure behavior, and recursion guard.
2. Adapt the existing `logger` API temporarily so callsites can migrate in
   bounded slices without losing current console coverage.
3. Sanitize once before fan-out to console or file.
4. Replace the three direct runtime `console.*` bypasses.
5. Move development logging to active rotation, explicit modes, bounded flush,
   and the versioned JSONL envelope.
6. Preserve readable developer console formatting derived from the already-safe
   event rather than treating console as the canonical record.
7. Add an ESLint restriction against direct runtime console use outside the
   reviewed sink and intentionally protocol-owning CLI/helper entry points.

Tests and gates:

- serializer determinism, truncation, unknown-field rejection, queue overflow,
  write failure, recursive failure, active rotation, stale rotation recovery,
  modes, and shutdown timeout;
- sink parity proves console and disk derive from the same sanitized event;
- existing development E2E failure attachments remain useful;
- `npm run lint`, focused logging tests, and `npm run type-check` pass.

Exit gate:

- no Electron runtime diagnostic reaches a sink before privacy projection, and
  development logging has a real total storage bound during long sessions.

### Phase 2 — Production desktop journal and crash tombstones

Deliverables:

1. Enable the owner-only bounded general journal in the production runtime
   profile.
2. Install production-safe fatal monitors that observe without replacing native
   exception/signal semantics.
3. Persist renderer/child-process/app lifecycle failures and renderer recovery
   outcomes.
4. Add crash-loop detection with bounded retry/backoff evidence aligned with the
   broader performance/stability plan.
5. Keep full crash dumps disabled; implement the explicit bounded diagnostic
   mode and cleanup contract behind a main-owned settings API.
6. Ensure bootstrap failures can synchronously write a minimal tombstone even
   before the asynchronous logger is ready.

Tests and gates:

- packaged-production fixture verifies file creation, level filtering,
  retention, owner-only modes, and absence of development detail;
- injected main fatal, renderer exit, child exit, unresponsive/recovery, preload
  failure, disk-full, and unwritable-log-root cases;
- dump opt-in/expiry/count/delete tests and a proof that upload remains disabled;
- signed/unpacked acceptance verifies diagnostics under the production profile.

Exit gate:

- a packaged main/renderer/child failure leaves bounded local categorical
  evidence without enabling remote collection or default memory dumps.

### Phase 3 — Structured operational coverage and aggregates

Deliverables:

1. Migrate startup, generation, persistence, updater, schedules, Telegram, MCP,
   Remote Access, voice, Computer Use, and helper lifecycle to named events.
2. Map raw provider/library failures at their ownership boundary rather than
   logging downstream arbitrary exceptions.
3. Introduce session/operation correlation without durable user identity.
4. Change Aiden Remote production request policy:
   - durable event for 4xx/5xx, cancellation, and slow latency buckets;
   - aggregate 2xx counts by stable route name/status class;
   - full request breadcrumbs only in development;
   - no durable raw device suffix.
5. Add bounded aggregate health storage for the approved counters.
6. Forward native-helper stderr as stable host-owned codes; keep helper protocol
   stdout free of logging noise.
7. Add the deterministic performance counters required by Performance Plan
   Phase 0 without converting high-frequency activity into an event flood.

Tests and gates:

- per-area contract tests assert allowed event names/fields and terminal outcome
  coverage;
- high-volume Remote/IPC/stream/terminal fixtures prove bounded record counts and
  disk bytes;
- correlation tests prove one operation can be followed without exposing raw
  chat/workspace/device IDs;
- aggregate normalization, 90-day bound, corruption recovery, and no-content
  schema tests;
- inspect iOS and Android consumers whenever a shared Remote/transcript contract
  changes, per repository policy.

Exit gate:

- every P0/P1 service family has structured terminal evidence, while successful
  high-frequency work remains aggregate-only or benchmark-only.

### Phase 4 — Renderer fault coverage

Deliverables:

1. Replace `import.meta.env.DEV` authority with main-owned diagnostic policy.
2. Capture global uncaught errors and unhandled rejections in both profiles.
3. Add React root `onUncaughtError`, `onCaughtError`, and
   `onRecoverableError` integration where supported by the pinned React API.
4. Add `componentDidCatch`/equivalent instrumentation to repository-owned
   subtree boundaries and router error handling.
5. Project route/component identifiers from a static registry; never include
   props, DOM text, arbitrary error messages, rendered Markdown, or provider
   content.
6. Show users safe app-owned recovery copy plus an opaque diagnostic reference
   when appropriate.
7. Rate-limit repeated identical renderer failures and record suppression
   counts rather than flooding IPC or disk.

Tests and gates:

- development, packaged-development, unpackaged-production, and packaged-
  production profile matrices;
- global, promise, caught, recoverable, route, and repeated-error fixtures;
- IPC size/rate bounds and destroyed-renderer behavior;
- React UI tests preserve accessible fallback and reset behavior.

Exit gate:

- every renderer failure class leaves a safe categorical record under the
  main-owned profile policy without exposing rendered content.

### Phase 5 — Support UX and export

Deliverables:

1. Add the Settings diagnostics surface, using existing design tokens and
   accessibility/motion conventions.
2. Add strict main-owned handlers for status, reveal, export, diagnostic-mode
   enable/disable, and deletion.
3. Build the manifest-first staged export and fail-closed validator.
4. Require separate confirmation for crash dumps and explain their sensitivity.
5. Make deletion exhaustive for diagnostic artifacts but incapable of touching
   authoritative product state.
6. Replace existing vague “open the developer log” copy with an actionable
   navigation/reveal path that works in production.
7. Do not add onboarding or feature-tour content.

Tests and gates:

- IPC contract/authorization/parameter bounds;
- export allowlist, path containment, symlink/race resistance, staged failure,
  cancellation, disk-full, deletion, and manifest validation;
- secret/path/URL/content scanner over generated archives;
- Settings keyboard, screen-reader, reduced-motion, and destructive-confirmation
  behavior;
- E2E export from both development and packaged-production profiles.

Exit gate:

- a user can reveal, inspect, export, and delete bounded diagnostics without any
  automatic transmission or inclusion of prohibited application data.

### Phase 6 — iOS and Android parity

Deliverables:

1. Define a shared semantic category list for Remote connection/auth, contract,
   cache, stream, speech, notification, Live Activity, and prior termination.
2. iOS:
   - repository-owned OSLog wrapper with private-by-default interpolation;
   - categorical lifecycle/failure events;
   - local MetricKit crash/hang reduction;
   - bounded local aggregate only where unified-log retention is insufficient.
3. Android:
   - repository-owned typed logger with debug/release policy;
   - categorical lifecycle/failure events;
   - `ApplicationExitInfo` prior-termination reduction;
   - bounded local aggregate only where system history is insufficient.
4. Keep network request/response logging disabled on both clients.
5. Add native diagnostic export only if it can meet the same manifest/privacy
   contract; otherwise keep the first release to platform-native local inspection
   and categorical aggregates rather than ship a weaker exporter.

Tests and gates:

- focused Swift/Kotlin unit tests for category mapping and privacy projection;
- compile-time/source policy test preventing public interpolation of unreviewed
  strings and direct `Log.*`/`print` use in application code;
- cache corruption, auth failure, contract rejection, SSE resume, speech failure,
  Live Activity failure, and prior-termination fixtures;
- run applicable iOS and Android suites, plus physical-device acceptance for
  platform crash/termination APIs when simulator behavior is insufficient.

Exit gate:

- both native clients provide categorical evidence for shared contract failures
  without logging payloads, endpoints, tokens, or stable identities.

### Phase 7 — CI, release evidence, and rollout

Deliverables:

1. Register every diagnostics test, including
   `subagent-runtime-diagnostics.test.ts`, in an appropriate package script.
2. Add a CI policy check that inventories direct logging calls and rejects
   unregistered sinks/events.
3. Generate a small sanitized failure receipt for major build/test stages with
   explicit short retention; do not retain raw verbose output by default.
4. Scan uploaded CI artifacts for repository-defined credential/content/path
   indicators before publication.
5. Add packaged soak scenarios:
   - long-running journal rotation;
   - renderer crash/recovery loop;
   - high-volume Remote requests;
   - repeated provider failures;
   - unwritable/full diagnostic storage;
   - export and deletion after failure.
6. Roll out in stages:
   - development structured logger;
   - internal packaged production journal;
   - support export;
   - native categorical logging;
   - final production default.
7. Keep rollback flags for the production journal and renderer forwarding for at
   least one release. Rollback disables new writes but preserves read/export/delete
   support for already-written records.
8. Update plan status, project memory, privacy/support documentation, and release
   notes at each milestone.

Tests and gates:

- complete `npm run test`, `npm run type-check`, `npm run lint`, relevant
  packaged E2E, native iOS/Android suites, and release-policy suites;
- disk, CPU, wakeup, and startup comparison shows no material idle regression;
- exported diagnostic fixtures pass an independent privacy review;
- signed production acceptance confirms correct paths, modes, retention,
  diagnostic-mode expiry, reveal/export/delete, and zero upload traffic.

Exit gate:

- production diagnostics are supportable, bounded, privacy-safe, reversible,
  tested across desktop/native clients, and reflected accurately in public
  privacy statements.

## Test inventory to add or extend

| Test layer | Required coverage |
| --- | --- |
| Pure unit | event registry, serializer, safe fields, error mapping, redaction defense, fingerprints, byte caps, retention selection, aggregate normalization |
| Storage | mode/ownership, append ordering, active rotation, crash during rotation, stale temp, ENOSPC/EACCES, queue overflow, shutdown flush timeout, deletion |
| Main integration | runtime policy, sink fan-out, fatal tombstones, renderer/child lifecycle, service event mappings, Remote aggregation/rate policy |
| Renderer | global/promise/React/router failures, runtime-profile matrix, rate limiting, safe fallback/reference UI |
| Export security | containment, symlink/file-identity changes, unknown files, archive budgets, scanner, manifest, crash-dump consent, cancellation, cleanup |
| Native | Swift/Kotlin category maps, privacy annotations/policy, cache/network/contract/stream failures, prior termination |
| Packaged/E2E | production paths and modes, long-session bound, crash recovery, export/delete, zero network upload |
| Release policy | no analytics/crash-upload SDK, no automatic endpoint, registered tests, artifact scanner and retention |

## Rollback and compatibility

- Keep the legacy `logger` facade while callsites migrate, but make it route
  through the safe core immediately after Phase 1.
- Preserve bounded, recent legacy development evidence under owner-only
  `aiden-dev.legacy*.log` names. Reveal/status/delete include it, while structured
  export excludes it because it predates the privacy contract. Preserve the
  structured `subagent-runtime.log` history without rewriting it.
- Unknown event versions are ignored by readers/exporters and never mutate
  application state.
- If the production sink proves unstable, a rollback flag stops new general
  writes while leaving fatal tombstones, export, and deletion available as
  separately reviewed capabilities.
- If renderer forwarding causes instability, main can disable it through the
  read-only policy without rebuilding the renderer.
- Native logging additions must not change Remote wire contracts.
- Diagnostic persistence failure must never block chat, generation, Remote
  service, scheduled work, shutdown, or app launch.

## Privacy review checklist

Before every phase is marked complete, verify:

- no prompts, responses, reasoning, tool/terminal/file/media/clipboard content;
- no raw error, stack, path, URL, header, body, cookie, credential, environment,
  configuration object, or stable identity;
- no full request/device/chat/workspace/generation/provider credential IDs;
- every field is allowlisted, bounded, and covered by a fixture;
- console is not a pre-redaction bypass;
- journal/export/temp/dump modes and retention are correct;
- exports are user-initiated, previewable by manifest, and never uploaded;
- dump consent is separate and defaults off;
- deletion cannot affect authoritative state;
- mobile platform logs use private-by-default interpolation;
- CI artifacts have explicit retention and pass the privacy scanner;
- App Store privacy and public support claims remain accurate.

## Definition of done

The plan is complete only when:

1. Packaged desktop production retains a bounded, structured, owner-only,
   privacy-safe diagnostic journal and fatal tombstones.
2. Console, files, OSLog, Logcat, exports, and CI receipts all consume data after
   the same class of privacy projection.
3. Renderer caught/uncaught/recoverable failures and Electron process failures
   leave categorical evidence with bounded recovery history.
4. Aiden Remote and other high-volume paths cannot flood the journal.
5. Users can reveal, export, and delete diagnostics, with crash dumps separately
   opt-in and no automatic upload.
6. iOS and Android cover their shared connection/cache/contract/stream failure
   categories without payload logging.
7. Long-session storage, idle work, shutdown, crash, export, and adversarial
   privacy gates pass in packaged production.
8. Every focused test is registered in CI, relevant full desktop/native/release
   suites pass, and documentation/memory accurately describe the shipped state.
