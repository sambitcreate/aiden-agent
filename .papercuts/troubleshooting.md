# Troubleshooting

- 2026-09-21 Subagents layout: this fresh worktree had no `node_modules`; focused `tsx`, TypeScript, and ESLint commands failed on missing packages until `npm ci`. Check dependency installation before interpreting those failures as code regressions.

- 2026-09-20 chat↔PR feature: `DataStore` classifies a file whose normalized `chatId` disagrees with its filename as unsafe — records that keep their own `chatId` would still leak links across a rename, so the file normalizer must drop the payload when `record.chatId` doesn't match the target chat, not just flag the file. Reconciliation intents are durable per-chat state, not in-flight results: attaching "ambiguous" candidates must happen when intents are re-read after `reconcilePending` (a crash between `gh pr create` and the link persists only the intent).

- 2026-09-21 PR #207 follow-up: fully redacting after the ninth settled report preserved secrecy but erased useful long-task findings. Keep all settled text under the existing output budget, sanitize cross-report boundary fragments before final truncation, and bound comparisons with a fail-closed ceiling.
- 2026-09-21 PR #207 follow-up: a sliding window of assistant partials can discard a credential-key prefix while retaining its value. Mark any eviction and fail closed on turn-limit findings, rather than classifying only the retained suffix.
- 2026-09-21 PR #207 follow-up: line-wise credential filtering misses assignment keys split across settled messages. Check bounded adjacent spans with line breaks removed and fail closed on the compact whole report; keep unaffected path lines where possible.
- 2026-09-21 PR #207 Pullfrog follow-up: real V2 authority tests using random UUIDs can trip the renderer-safe opaque-identifier classifier nondeterministically. Inject a known-safe UUID in the persistence fixture, then test the complete authority and ledger path.
- 2026-09-21 PR #207 follow-up: `.memory/` is ignored even when its existing note is tracked; stage note updates with `git add -f` after checking the exact path.
- 2026-09-17 release gate: do not run `npm test` and `npm run build` concurrently in one worktree. Both compile the universal `build/native/aiden-worktree-remover`, and `lipo` races its temporary output. Run build first, then the full suite serially.
- 2026-09-17 release gate: removing the final Live voice-approval sender left `chat:approval-withdrawn` in the preload notification allowlist. Focused Live tests do not own the global sender/allowlist equality contract; run the full suite before publishing renderer IPC changes.
- 2026-09-17 Live motion: do not key canvas layers by caption/action state; remounting restarts the animation and causes jumps. Kept stable duplex layers and separated visual activity from microphone activity so mic-off sessions retain Stop. Production macOS package must be rebuilt separately from the HTML review bundle.

## 2026-09-12 — Listed upstream integration audit

- This worktree has no `.memory/` or `node_modules/`. Read the main checkout's project memory as historical context, but use this worktree's exact HEAD/source as authority. The main checkout's `tsx` binary can execute dependency-free focused suites without installing packages here; suites with runtime package imports still fail module resolution (observed: `entities` in the subagent capability suite). Treat that as an environment limitation, not a product regression or passing test.
- A repository in the earlier compaction reference table is not necessarily an installed integration. Verify runtime imports, vendored artifacts, implementation history, and explicit adoption decisions before proposing package upgrades.

- OpenCode API message dumps can exceed the CLI's output limit and become truncated JSON; use `GET /api/session/{id}/message?limit=1` for the latest completed review, or bounded pagination, rather than dumping every tool result. Verify the returned assistant model metadata when exact-model reviews are required.
- Provider diagnostics must classify `finalized` inside the Pi harness before `closedFailureMessage` replaces the raw error. Reclassifying `runtimeOutcome.finalMessage` in `llm-client` loses model-unavailable/authentication evidence; assert the emitted production event with a real faux-provider harness test.

- `.papercuts/` is ignored even when its troubleshooting file is present in the PR branch, so persisting a required update needs an explicit `git add -f`.
- Layout stabilization must race `animation.finished` against a short timeout because paused or infinite document animations never settle; keep geometry polling as the authoritative E2E readiness check.
- Pi 0.80.10 can choose the oldest oversized user turn as `firstKeptEntryId`, leaving both summary inputs empty and producing a no-op checkpoint. When the journal has a newer turn, retry `prepareCompaction` with a minimal retained-tail budget; still refuse the checkpoint if both summary inputs remain empty.
- `Session.getEntries()` includes abandoned branches. Synchronization markers must be read from `Session.getBranch()` or a rolled-back partial write can still look committed.
- Child-runtime unit tests load outside Electron. Keep usage accounting behind an injected callback (with a production-only dynamic import) instead of statically importing the Electron-backed singleton into the reusable child registry.
- A compaction model can overflow on the very history it is supposed to summarize. Strip binary images first and map-reduce serialized fragments within a conservative fraction of the model window before the final Pi checkpoint call.
- Renderer-safe truncation markers must be normalized before their length is budgeted, then the truncated value must be sanitized again; NFKC expands `…` to `...` and can otherwise invalidate an exact-length snapshot.
- Packaged builds do not initialize `aiden-dev.log`. Subagent process failures instead write one redacted, owner-only JSONL record to `logs/subagent-runtime.log`; correlate its `SA-*` diagnostic ID, closed stage/code, attempts, timing, and exit status with the Pi journal and V2 run store without logging task or report contents.
- Pi 0.80.10's public `AgentHarness` cannot express Aiden's global sequential-tool policy or resume an already-journaled user tail. Keep the low-level Agent behind `PiAgentRuntimeHarness` until Pi's durable Harness implements restore/resume, tool execution policy, and automatic between-turn compaction.
- Pi's remote model catalog can evolve independently of its agent/session runtime. A full package bump from 0.80.10 exposed breaking Session contracts, so backport the bounded provider-catalog wrapper and any explicitly reviewed transport adapters behind Aiden's registry; do not couple a model-list refresh to an unplanned journal/session migration.
- A provider-scoped catalog refresh must not call Pi's mutating `getAuth()` merely to test configuration: expired OAuth can rotate credentials after the caller's timeout. Use the non-refreshing auth check, resolve staleness before auth, keep provider-owned catalogs out of launch polling, cache valid empty/negative results, and bound HTTP generation timestamps against wall-clock skew so a far-future validator cannot freeze recovery.
- Pi awaits `Agent.subscribe()` listeners. Never register an optional renderer/plugin observer as a critical listener: isolate it through the runtime contribution observer path, or its exception can alter the model lifecycle.
- A Pi observer is not passive merely because its return value is ignored: a live `tool_execution_end` event contains mutable result references, and awaiting the observer blocks Pi settlement. Clone observer events and dispatch them outside Pi's serial lifecycle.
- Global extension tools cannot be copied into a child Agent after authority is minted. Keep child contributions disabled until an adapter can include their names, effects, approvals, schemas, and budgets in the immutable child ceiling.
- Pi's internal idle promise can resolve just before the facade's outer prompt operation classifies hook/subscriber faults. Destructive callers must await both boundaries before reset, deletion, or another prompt.
- A Pi `beforeToolCall` block is non-terminal by default: Pi emits an error tool result and can ask the provider again. If the approval/policy hook itself fails, record the host fault and make the next-turn preparation throw so no second request crosses the broken policy boundary.
- Repair retryable assistants before appending the next visible user or opening its crash-recovery envelope. Once a new user is the leaf, exact failed-assistant abandonment is no longer safe.
- Awaiting only the provider signal does not make session I/O cancellable. Race seed, append, context-build, compaction, and retry hooks against the facade's one managed abort signal, while keeping external effect evidence behind the visible-turn rollback repair.
- Rolling back an inner Pi message transaction can delete a later commit for an enclosing visible-turn envelope while leaving its begin marker. When abandoning a committed failed assistant, re-close only enclosing transactions proven committed on the original branch; never close the current in-flight lease.
- A non-abortable journal append can settle after `app_cancelled`. Track it independently of the managed outcome and quarantine that chat's journal until the write settles and rollback/reconciliation completes; resetting the Agent alone is not a storage barrier.
- Foreground prose aggregates multiple Pi assistant/tool turns, while the durable tail contains only the final assistant. Reconcile that aggregate only when the runtime explicitly reports an abandoned terminal Pi message; doing it before every marker duplicates healthy tool-loop context.
- Electron `utilityProcess` does not provide an owned POSIX process group. Patch Node child-process entry points before provider modules load so Bedrock `credential_process` fails closed instead of spawning an unowned descendant, and bind hard-kill escalation to the captured launch identity rather than a reusable raw PID.
- An effect journal is not crash recovery until its uncertain records change future model context. After Pi rolls back an incomplete visible turn, install an idempotent private no-repeat boundary before accepting another prompt; mark the effect recovery-recorded only after that boundary commits.
- Retry a child worker only when the owned process reports a fast nonzero exit before any inbound IPC. Once a hook, protocol frame, model event, or provider diagnostic exists, retrying is no longer a startup recovery and can duplicate billed or effectful work.
- In an Electron UtilityProcess bootstrap catch, `process.exitCode = 1` does not guarantee settlement because the parent IPC handle can keep the process alive. Flush the bounded stderr marker, then force a nonzero exit on a short fallback timer so main can classify and retry the pre-ready failure.
- Run `oxfmt` only on deliberately reformatted files or isolated hunks: the repository baseline contains legacy formatting, so formatting an otherwise small change can create hundreds of unrelated lines of churn.
- "Safer" compaction checks can be compatibility bugs. Before changing Aiden's Pi adapter, pin the exact upstream commit, hash the relevant sources, and mirror its tests and acceptance behavior—including empty/length summaries and usage-anchor skips—instead of preserving stricter local validators that upstream does not have.
- An Electron E2E teardown deadline must exceed the app's sequential bounded shutdown phases. A 10-second fixture timeout can kill and report a healthy process while foreground, subagent, and packaged-soak drains are still inside their documented 6s + 5s + 5s ceilings.
- Image generation can return a baked checkerboard or an opaque/RGB file even when asked for transparent onboarding art. Inspect the generated pixels, dimensions, and alpha channel before copying it into `renderer/assets/onboarding/`; extract the real background and resample only after visual inspection.
- GitHub release create/edit requests can return HTTP 503 after committing server-side state. Publication must re-read the exact tag, target SHA, draft state, and asset set before retrying or reconciling; never treat an unavailable lookup as a missing release.
- A main-process fallback that reads `settings.lastProviderId` as "the app's last provider" is reading a dead key: the UI persists its real selection in renderer localStorage (`aiden-agent.providerId`/`aiden-agent.model`) and only the Telegram flow ever wrote the settings key. Any main-process consumer (scheduler, tools) must either receive the selection explicitly or have attended chat starts seed the settings fallback.
- A physical XCTest transport spike can keep secrets out of the project and scheme: use a private temporary Derived Data directory, create an injected `.xctestrun` copy beside its `Build/Products` payload, inject an ephemeral canonical pairing-bootstrap JSON into that copy, then use `test-without-building`. Xcode still requires the physical device to remain unlocked through preflight and launch.
- A copied `.xctestrun` resolves `__TESTROOT__` relative to its own location. Keep the injected copy beside `Build/Products` (or deliberately rewrite every relative product path), and derive the advertised LAN address from the default-route interface instead of assuming Wi-Fi is `en0`; otherwise Xcode reports a missing test product or the phone silently times out against a link-local adapter.
- Simulator networking does not prove iOS Local Network privacy readiness. A direct physical LAN request fails as `Local network prohibited` when the host app omits `NSLocalNetworkUsageDescription`; lock both that key and the canonical `NSBonjourServices` value with an XCTest that inspects the built application bundle.
- A newly configured Tailscale Serve HTTPS handler can accept TCP before its tailnet certificate is locally available. Verify/request the node certificate through Tailscale's own CLI, retry the exact path-scoped Serve URL, then remove only that path with matching `--https` and `--set-path ... off`; never use `serve reset` as cleanup.
- Before the first handler exists, `tailscale serve status --json` can be `{}` even when tailnet HTTPS is enabled. Validate the exact normalized node DNS name against `tailscale status --json`'s certificate domains; do not require a pre-existing `TCP.443.HTTPS` listener, and still reject an explicitly incompatible 443 listener.
- Tailscale `--set-path` strips the mounted public prefix before reverse proxying. An Aiden `/api/aiden/v1` mount must target the loopback origin plus the exact same canonical API base, not the origin root; verify `/api/aiden/v1/health` through the real tailnet before claiming transport acceptance.
- `PlistBuddy Add ... string <JSON>` can strip JSON quoting when injecting a physical-test pairing payload. Use `plutil -replace ... -string`, compare the injected value's byte count/digest without printing it, and make every secret-bearing xctestrun and payload file owner-only.
- A self-signed `CA:FALSE` TLS leaf cannot be used as an Apple Security trust anchor, and an overlong server-leaf lifetime can fail Apple SSL policy even under a private anchor. Generate an installation-local CA, sign a short-lived `CA:FALSE`/server-auth leaf, present the full chain, anchor only the CA, and pin the leaf SPKI.
- A newly connected physical iPhone can remain an ineligible Xcode destination after pairing until Developer Mode is enabled, the reboot confirmation is accepted, and the phone is unlocked again. Re-read the CoreDevice/Xcode destination list before rebuilding; stale destination errors do not imply a signing failure.
- Foundation and JavaScript do not resolve duplicate JSON object keys the same way. For cross-platform security envelopes, scan raw UTF-8 JSON and reject duplicate keys—including escaped-equivalent names—before either `JSONDecoder` or `JSON.parse`; validating only the decoded object is too late.
- Cross-platform `maxLength` and date parsing need executable shared vectors: Swift `String.count` measures grapheme clusters while OpenAPI/JavaScript limits are Unicode-code-point based, and `ISO8601DateFormatter` accepts forms a strict RFC 3339 parser rejects. Use Unicode scalars for wire bounds and validate the complete timestamp grammar/calendar before constructing `Date`.
- A TTL alone is unsafe when idempotency state is pruned using wall time: after a forward jump and persisted prune, a rollback can make the same key look reusable. Persist a last-observed clock high-water mark with the ledger snapshot and fail closed for new keys until wall time advances beyond it; unresolved in-flight entries still never expire locally.
- Do not retain an unversioned idempotency-array migration path after adding a persisted clock high-water mark: even an empty legacy array is ambiguous and can reopen a pruned operation after rollback. Use an omitted snapshot only for a genuinely fresh ledger and reject every persisted shape that cannot carry the high-water value.
- WHATWG `URL` parsing removes raw and percent-encoded dot segments before exposing `pathname`. Security-sensitive canonical endpoint checks must compare the exact raw path before constructing `URL`, then apply the normal scheme, authority, query, fragment, and normalized-path checks.
- URL libraries also normalize authority bytes: controls may be stripped, Unicode hosts may become punycode, numeric hosts may change form, and padded ports lose their spelling. Cross-platform pairing identity needs a shared conservative raw authority grammar before either Foundation or WHATWG parsing, with the original endpoint string retained for equality checks.
- A `structuredClone`-safe value is not necessarily durable JSON: nested `undefined`, non-finite numbers, `-0`, sparse arrays, accessors, cycles, and nonplain objects can disappear or change. Idempotency results must be recursively validated/cloned into an exact JSON value and tested through `snapshot -> JSON.stringify/parse -> restore -> replay`.
- Entry-count limits alone do not bound durable state. Apply recursive shape limits plus per-result and aggregate serialized-byte budgets before accepting terminal replay data, and give live operation-owner registries an owner-checked terminal release path so the capacity ceiling does not become permanent exhaustion.
- Rork `asc` enables pseudonymous command telemetry by default; use `ASC_TELEMETRY_DISABLED=1` for Aiden operations and `--strict-auth` so stored profiles cannot silently mix with environment credentials. A zero-result app query is only evidence for the active key's scope, not proof of account-wide absence; check product-owned public TestFlight links and reconcile them through the correct account before creating a record. Initial app creation is now `asc web apps create`, requires an authenticated Apple web session, and must remain an explicit owner action.
- `NavigationSplitView` selection can highlight a row without pushing detail on a compact iPhone. Branch explicitly by horizontal size class: use a value-driven `NavigationStack` on compact layouts, retain the split view on regular layouts, and reconcile both selection and path across CRUD and size-class changes.
- Never convert a post-action serialization or snapshot-budget failure into a TTL-bound rejection. The external mutation may already have happened; retain its stable operation reference as an unexpiring unknown/in-flight record until authoritative reconciliation proves a terminal outcome.
- Dependency-injected application services must keep Electron-backed singleton imports type-only. Bind real stores, logging, and platform services in a separate `*-main.ts` module; otherwise focused Node tests load Electron before the pure service can be exercised.
- Web Search existing-auth consent must read Pi's persisted credential store directly. `Models.getAuth()` is not a status-only operation: it can resolve ambient environment credentials and refresh OAuth. Keep the binding service platform-free for tests and bind its owner-only `DataStore`/Pi singletons in `web-search-auth-reuse-main.ts`.
- Local Swift caches should use their own symmetric encoder/decoder rather than the stricter network RFC 3339 decoder. A plain `JSONEncoder` persists `Date` numerically by default, so decoding that file with the wire decoder fails even though the cache is valid.
- Canonical workspace paths can differ textually on macOS (`/var` versus `/private/var`). Managed-worktree authorization must compare the shared realpath-resolved environment identity, not a raw temporary-directory spelling.
- macOS LibreSSL does not support OpenSSL's `-copy_extensions` certificate flag. For an installation-local server leaf, write a bounded temporary extension file with the reviewed SAN/key-usage values and pass it through `-extfile` instead of assuming GNU/OpenSSL CLI parity.
- A private LAN CA cannot satisfy normal iOS server trust from an SPKI fingerprint alone. Keep the leaf pin and carry the installation CA certificate in the locally displayed, versioned pairing envelope so the client can anchor that exact CA before applying hostname, validity, usage, and pin checks.
- A folder-browser selection is not safe merely because its opaque nonce is one-use. Revalidate the approved-root policy, canonical directory identity, and duplicate-workspace state inside the same serialized application-service commit that persists registration; otherwise a root removal or filesystem replacement can win between token consumption and save.
- Durable idempotency must persist the in-flight admission before invoking a workspace mutation and persist the terminal result afterward. A crash between those writes should fail closed as an unknown/in-flight operation rather than allow the same key to execute twice.
- A committed chat append and a started generation are separate durability boundaries. If provider setup fails after the append, return the accepted message with a terminal error stream; if append persistence has an indeterminate outcome, keep the idempotency entry in flight until authoritative reconciliation rather than allowing a duplicate prompt.
- Resumable token streams can produce many events faster than durable storage should be written. Coalesce journal snapshots while preserving monotonic in-memory sequence order, settle the latest snapshot during quit, and close only the revoked device's live responses; an SSE disconnect alone must not cancel server-owned generation.
- An Xcode App Intents localization file reference is not a resource by itself. Adding a missing `AppShortcuts.xcstrings` reference to Copy Bundle Resources makes metadata extraction fail at build-input validation; either provide the real catalog or leave the absent reference out of the shipping resources so extraction and shortcut training use the declared intent phrases.
- After an iOS target rewrite, imported source files can remain in the project navigator without belonging to the shipping target. Verify the active `PBXSourcesBuildPhase` before trusting or testing a configuration/UI file, and make CI compile the renamed scheme for generic hardware when simulator use is prohibited.
- Xcode can also retain unlinked Swift package references and stale `Package.resolved` pins after an imported target is narrowed. Audit the actual target dependency graph, remove unused project package/product references, then keep the resolved pins and bundled third-party notices under the same regression gate.
- `await Activity.update` does not guarantee `activity.content` has already advanced. A Live Activity manager that reduces the next rapid event from that public rendered snapshot can lose semantic transitions. Keep canonical state actor-isolated in the app process, hydrate only when adopting a persisted activity, and test rapid updates on physical hardware before immediate cleanup.
- Separate `xcodebuild test-without-building` invocations normally reinstall an app-hosted XCTest bundle, which removes its Live Activities and invalidates a relaunch-persistence proof. Build and install once, then set `UseDestinationArtifacts` with the destination-relative test bundle for the second phase; verify the first host is gone, keep a cleanup phase, and validate that the CoreDevice UUID and Xcode UDID describe the same physical device.
- A physical XCTest run can pass every test and still print a `devicectl diagnose` collection error while Xcode archives partial diagnostics. Use the XCTest summary and final `TEST EXECUTE SUCCEEDED` result as the gate; treat diagnostic collection as a separate tooling warning rather than a test failure.
- A pairing window can be closed or replaced while durable device issuance is awaiting storage. Rechecking only after issuance is too late because a hidden credential may already exist; pass an exact-session authorization fence into the serialized durable mutation and check it immediately before commit.
- Re-pairing into one fixed Keychain scope makes registry rollback non-atomic because the old credential has already been overwritten. Write each device credential to a versioned scope, durably move the installation-registry pointer, and only then best-effort remove the prior scope.
- CoreDevice and `xcodebuild` can identify the same physical iPhone with different UUIDs. Use `devicectl list devices` only to confirm presence and unlock state, then resolve the actual Xcode destination identifier from `xcodebuild -showdestinations`; passing the CoreDevice UUID directly can report that an otherwise connected phone is unavailable.
- Capability-vocabulary negotiation is not authority. Persist a client's explicit support marker separately from its grants, expose server inventory only to clients that negotiated the additive vocabulary, and require both server support and the exact device grant before enabling the feature.
- Authorizing a classified resource through its full payload reader can leak reconciliation, deletion, or storage state before capability denial. Classify from bounded main-owned metadata first, normalize missing/failed classification at the outer resource boundary, and only then enter payload or effectful services.
- Rewriting a hand-formatted OpenAPI document through a whole-file JSON formatter creates thousands of unrelated diff lines. Preserve its established formatting and make schema changes as narrow patches unless a dedicated formatting migration is intentional.
- A signed high-water file does not prevent rollback when its signing key and authority state live in the same backup domain. Keep the authoritative Bot policy head in an independent macOS Keychain item; use the filesystem head only as a two-phase crash journal, and test restoration of the state, journal, and local key together.
- A durable mutation can become visible before its final lifecycle checkpoint is acknowledged. Reconcile that exact pending operation in the live application service and return the proven committed object; if exact reconciliation fails, fence further mutations until restart instead of letting a retry mint a duplicate identity or chat.
- A capability catalog should not reuse an inventory built for a narrower authority lane. The subagent MCP inventory deliberately excludes stdio and caps servers/tools below the Bot contract; give Bots a fresh inspector over ordinary MCP transports plus their own durable resource and credential incarnations.
- A durable external route and its Bot backing chat live in separate stores, so binding first leaves a crash gap. Reconcile enabled routes under the Bot mutation gate before starting the transport: create only the exact persisted chat id in the managed home, validate existing chat/policy ownership, and durably disable anything that cannot be proven or repaired.
- A soft-disabled external route can be re-enabled by restoring only its older registry file. Bind the complete normalized state digest to an independently protected Keychain generation, but do not simply write either side first: publish `pending(previous,next)`, write the file, then commit `next`; startup may reconcile only an exact previous or next digest. A separate one-way bootstrap marker must prevent anchor loss from accepting the restored file as a fresh baseline.
- Profile reset/delete must invalidate an active Bot bind before waiting for its serialized profile lane, then durably unbind routes before clearing pairing or profile state. Reversing that order can leave an enabled route behind after a partial reset failure.
- Tool-name filtering cannot make an unrestricted shell honor scoped Files access: `run_command` can follow absolute paths, `..`, symlinks, and child-process behavior outside its cwd. Until execution is confined by a sound OS boundary, withhold Custom shell for scoped/off Files and expose it only with the exact Full Mac grant; keep a fresh authority/home/catalog check immediately before every published tool effect.
- A Bot managed-home workspace is intentionally absent from `configStore`, so generic inbound-file storage can mistake its opaque workspace id for a stale ordinary workspace and fall back to a global inbox. Carry the validated Bot identity alongside the backing workspace id, resolve and canonicalize the exact managed home again at storage time, and never allow a Bot-bound failure to enter the ordinary fallback path.
- Ordinary coding tools intentionally allow lazy workspace creation, so their root guard does not pin an inode at assembly. Exact Bot file grants need the same tool factories behind a pinned-root builder; otherwise replacing the entire approved directory between schema publication and execution can silently retarget every routed tool.
- Rebuilding a Bot capability catalog before each effect detects skill drift but cannot interrupt an already-running turn at edit time. Give active Bot turns a separate inventory-generation lease, fence every controlled config/credential publication on both sides, and watch only the exact discovered `SKILL.md` directories admitted into runtime so an external edit aborts immediately without broadly observing the user’s home folder.
- Resource credentials and process credentials intentionally use different fingerprint domains. Join a child MCP process to its grant through a fresh, durable resource/credential incarnation identity while retaining the process fingerprint for execution checks; direct hash equality makes the production join impossible.
- A publication fence is only useful after the new snapshot is synchronously visible to warm readers. Publish the in-memory and disk-cache view first, then advance the inventory generation so a post-fence lease cannot observe stale authority.
- `O_NOFOLLOW` on a Node file open protects only the final component. Replacement-safe writes beneath a mutable Bot home need a native helper that pins the home and every parent with `openat`/`mkdirat`, creates the leaf relative to retained descriptors, and revalidates authority after the write.
- External Bot surfaces must admit the exact protected Bot, chat, audience, provider, and model before appending the user message or consuming a one-shot attachment. Revalidating only at provider dispatch leaves unauthorized durable input behind even when generation is denied.
- A Bot avatar upload needs both bounded container preflight and a real decode/re-encode boundary. Header inspection limits decompression work and rejects MIME confusion; only the independently decoded, center-cropped 512 × 512 PNG may enter the canonical store.
- Once an atomic avatar-manifest rename succeeds, a later directory-fsync error is not a safe rollback signal: deleting the newly named asset would leave a committed manifest dangling. Treat rename as the live publication boundary and let restart validation classify crash durability.
- Do not acquire a paired-device mutation lease before reading a bounded request body. A stalled sender would make revocation wait on attacker-controlled I/O; read and validate the bounded envelope first, then authenticate/acquire immediately before application-service admission.
- Bot capability provider/model IDs are audience-safe opaque selectors, not runtime provider IDs. Resolve them against one fresh main-only catalog snapshot and pass only the exact source identities into chat creation; never persist the opaque selector as runtime configuration or return private catalog resources over Remote.
- A mutation can pass an inventory fence, stage durable Bot policy state, and still publish after the inventory changes. Thread the same `isCurrent` predicate through the final cache-and-disk publication callback so invalidation rejects before either representation becomes visible.
- Favorite ordering spans multiple Bot identities plus one shared ordered list. Acquire Bot mutation gates in stable sorted order before the single process-wide favorites lane, and make desktop archive removal use that same lane, or simultaneous archive/reorder operations can deadlock or resurrect an archived favorite.
- Clearing a submitted mobile draft must be generation-aware: the user can type message B while message A is awaiting acceptance, so A may clear only the exact draft generation it submitted and failures must merge A with the newer text and attachments.
- Durable mobile navigation is not restorable from a chat ID alone. Scope presentation state by the exact installation and paired-device identity, then re-fetch the canonical chat before restoring a path or mutation authority.
- Feature-local Remote clients must forward `credential_revoked` into the coordinator's installation purge path. Handling it only in the main connection loop leaves stale Bot caches and credentials alive after a direct editor or chat request.
- A Bot cache keyed only by Mac instance can expose data from an older phone pairing after re-pair. Include the device identity in its directory, activation token, snapshot validation, and every stale-publication fence.
- Archived Bots may remain identity owners for readable archived conversations even when creation and favorites list only active Bots. Fetch/cache the complete Bot identity projection for inbox validation, then filter archived identities only at actionable controls.
- SwiftUI profile and inbox refreshes can overlap initial tasks, pull-to-refresh, sheet dismissal, and mutations. Fence every assignment and error with a per-load generation, invalidate in-flight loads before mutation, and scope persisted split selection by the exact installation plus paired-device identity.
- A lost create response is still ambiguous when the server returned malformed/truncated success or a mismatched success identity. Retain the exact idempotency key across network, cancellation, invalid-response, 2xx, 408, 429, and 5xx outcomes; unlock an editable draft only after a definite rejection.
- Image Playground's temporary result may be larger than the canonical upload even when it is valid. Bound the system-source admission separately from the normalized output, downsample before full decode, and enforce the smaller transport cap only after metadata-free re-encoding.
- A synchronous copy of a system completion URL creates crash residue before async normalization owns it. Remove only app-owned candidate names at process launch and retry when the editor becomes available because complete file protection can make launch-time cleanup temporarily inaccessible.
- A SwiftUI view hidden with opacity remains mounted and continues running `.task` work. A rollout flag must gate every feature ingress—including cache activation, search, retained-path restoration, deep-link presentation, and mutations—not only navigation or hit testing.
- A per-row canonical-image query can turn a bounded roster into unbounded IPC and renderer memory. Gate roster loads by viewport visibility, cap concurrent reads and retained decoded-byte estimates, prioritize selected surfaces, and ensure an evicted row re-requests when it re-enters the viewport.
- `/usr/bin/security add-generic-password -w` does not reliably consume piped stdin when launched without a controlling terminal; it can print a password prompt and hang until the bounded process timeout. Use `security -i` with a strictly tokenized command and hex value carried only on stdin, then verify the stored value through an independent read.
- Blocking a custom `URLProtocol` handler to stage overlapping responses can serialize the loading queue and make an iOS test look like an app watchdog crash. Defer response delivery without blocking the protocol callback, then release the saved protocol instance after the newer request completes.
- A Messages-like Bot surface becomes ambiguous if a Bot can own multiple writable chats. Treat the Bot identity as the chat identity at every entry point: serialize open-or-create under the Bot mutation gate, recheck after admission, project one deterministic canonical chat, and keep legacy duplicates readable but mutation-blocked.
- Repeated Bot loading can come from overlapping REST refreshes rather than excess SSE. Preserve independently valid cache segments, publish warm state immediately, reuse the active `URLSession`, and reserve animated skeletons for true cold layout loads.
- A provider's generic generation failure can hide a retired saved model. Keep the Bot chat's saved provider/model authoritative, classify the bounded provider diagnostic server-side, and direct the person to Bot Access without exposing raw provider output or silently substituting another model.
- A feature-specific provider catalog can silently diverge from a working chat setup if it reads the portable custom-provider store instead of Aiden's canonical configured-provider inventory. Exercise New Bot against a real built-in provider on a paired physical iPhone, and fence the full durable-to-memory catalog publication so post-refresh leases cannot see stale authority.
- A Full Access Bot policy that omits provider/model leaves the composer or chat metadata as accidental authority. Persist an audience-safe selection plus its exact private binding in the Bot policy, revision and fence every change, atomically rebase only the canonical Custom chat reduction without widening its other grants, and treat chat provider/model fields as a crash-recoverable execution mirror rather than the source of truth.
- A large shared SwiftUI chat body can hit the compiler's type-checking ceiling when a Bot-specific presentation is added inline. Keep the runtime shared, but split transcript, message rows, composer, toolbar, and sheets into bounded view builders so workspace and Bot chrome remain independently readable and compilable.
- Clearing a canonical Bot photo in `onDisappear` defeats both the immutable revision contract and SwiftUI view reuse: ordinary navigation or reconstruction briefly falls back to the semantic avatar and decodes the same bytes again. Keep a bounded decoded-image cache keyed by installation, paired device, Bot, and asset revision; retain the current image across connection-only refreshes and invalidate only when that exact key changes.
- Pi may persist a refreshed OAuth credential during auth resolution. Resolve expired built-in Bot auth before acquiring its inventory lease, then re-read and pin the fresh auth inside the admitted lane; refreshing only after admission invalidates the request's own lease and causes a one-time first-turn failure.
- A Bot configuration save can race a process-wide runtime inventory mutation from provider credentials, MCP configuration, or skill content. Never swallow `BotRuntimeInventoryLeaseInvalidError`: retry the complete snapshot/bind/write transaction under a fresh lease with a small bound, and fail closed without publishing if the inventory keeps changing.
- Bot catalog snapshots embed live facts: credential probes and resource incarnations can legitimately advance their revision after a client loads the editor. Rebase the stale client request onto one fresh audience-scoped snapshot, revalidate every opaque selection against that exact snapshot, and persist only its revision; do not add a second unleased read that can itself race.
- When a capability ships on remote/iOS first (e.g., Edit Bot owning model selection), audit the Mac renderer for the same surface before declaring the feature done. The Mac editor had no access section, no catalog IPC, and no updateBotAccess path; desktop-created bots silently got a main-chosen default model.
- A Remote stream projection reset is followed by a cumulative replacement, not an append-only delta. Reconcile durable chat and clear any feature-local ephemeral accumulator before consuming that replacement; otherwise each reconnect/reset can duplicate the same assistant progress even when the provider emitted every sentence only once. Keep final-answer projection separate from disclosure-only progress so copy, accessibility, completed, and streaming paths agree.
- A successful mobile image upload does not prove the saved model can see it. Project the configured model's image-input capability to the client and revalidate pending attachment kinds before consuming their one-shot handles or appending the turn; otherwise stale or incorrect runtime metadata can silently downgrade an image to a text-only request and prompt misleading filesystem exploration.
- A Compose screen nested inside a parent `Scaffold` can inherit safe-drawing insets a second time, creating a large unexplained gap below the parent's app bar. Make the product shell the single system-inset owner and set nested list scaffolds to `WindowInsets(0, 0, 0, 0)`; likewise, do not add an IME inset when `adjustResize` has already moved the window above the keyboard.
- When more than one adb transport exposes the same Pixel, always select the physical USB serial explicitly for install, launch, UI dump, and screenshots. This avoids deploying to a stale wireless transport or reading UI state from a different device connection.
- A MockWebServer cancellation test for a never-ending SSE response should throttle a response body instead of relying on `setBodyDelay`: delaying only the start can leave the queued body alive and make server shutdown wait even after the production OkHttp call was correctly cancelled.
- Gradle `connectedDebugAndroidTest` can uninstall the debug target package at the end of its managed lifecycle, deleting its app-private Remote pairing credential and caches. For a paired physical device, either use a disposable application ID/device or manually install the already-built target/test APKs and run `am instrument`; always verify pairing state and reinstall the final target afterward.
- A Compose feature screen can miss an in-place pairing transition when its only load trigger is view-owned and navigation immediately changes. Let the lifecycle ViewModel observe the authenticated client plus `CONNECTED` state directly, claim its single-flight marker before launching, and never translate a missing authoritative snapshot into a valid empty account. Server request logs are the fastest way to distinguish “route returned empty” from “route was never called.”
- `windowSoftInputMode` declared on `<application>` does not make a Compose activity an IME-resize owner; a physical device can still resolve it to `adjust=pan` and cover bottom controls. Put the policy on the exact activity, choose one owner (`adjustNothing` plus consumed Compose IME/navigation insets for edge-to-edge), and compare composer bounds against the real IME frame on-device.
- A bounded raw-audio limit is not the HTTP JSON limit: 60 seconds of 16 kHz PCM16 is 1,920,000 raw bytes but 2,560,000 base64 bytes before envelope overhead. Derive and test both boundaries together or the advertised final seconds fail with 413.
- Speech-recognition callbacks can arrive after cancellation/destruction. Fence native callbacks, Mac preparation, capture, and transcription with one monotonically increasing session generation; lifecycle stop must invalidate it before releasing the microphone so an old completion cannot write into a newer draft.
- Codex non-login shells may not inherit either Java or Android SDK discovery even when Android Studio and the SDK are installed. For Gradle verification, point `JAVA_HOME` at Android Studio’s bundled JBR and `ANDROID_HOME` at the configured SDK; do not add machine-local `local.properties` to the repository.
- React Doctor can fail to recognize uncommitted changes in a linked Git worktree and silently fall back to a full-repository scan, even with `--scope changed`. Confirm its scope banner, inspect findings in the actual changed files, and rely on focused tests plus direct diff review rather than treating unrelated full-scan diagnostics as regressions.
- Generic iOS `build-for-testing` can stall in asset-catalog processing in this repository even when the changed Swift sources compile. For a source/test compilation gate, disable signing and exclude `*.xcassets` plus `AppIcon.icon`; keep physical-device behavior and the real signed asset/package build as separate release acceptance.
- A production-profile Playwright run is useful for exercising the packaged policy branch without signing, but it is not evidence about a signed `.app` bundle. Name the gate accurately and keep signed distribution plus physical-device termination APIs as release-environment acceptance rather than silently treating them as local passes.
- When several long-lived mobile branches overlap, do not merge their histories blindly into a release PR. Preserve unique detached commits first, start from a clean `main` worktree, squash the reviewed mobile baseline, then cherry-pick only independently scoped follow-ups; resolve documentation by combining current facts instead of reviving stale build records.
- Electron `utilityProcess.fork` script arguments are delivered to the Node service but may be absent from the packaged macOS Helper command line. Authenticate the loaded worker over its private IPC channel, and reserve `ps` PID/start identity for compare-before-signal cleanup; a smoke that forks the worker directly does not cover production launcher admission.
- A read-only status surface must not merge two independent external snapshots. Tailscale node identity, Serve state, and route classification now come from one bounded command pair; a redundant second inspection can turn one transient CLI failure into a false “Unavailable” state even when the first snapshot was healthy.
- Onboarding dismissal spans a renderer compatibility marker and a main-owned outcome. An explicit provider skip must persist `deferred`, clear any stale selected-provider identity, and teach both launch visibility and the Settings re-entry path that `deferred` is intentionally dismissed but never provider-ready.
- A Tailscale setup failure can originate before Tailscale: production and development Aiden profiles may share a persisted Remote Access port pair. Check the live listeners and per-profile `aiden-remote-v1.json` files first; preserve fail-closed startup and expose relocation only as a confirmed action that cannot orphan an owned or pending Serve route.
- Pi's provider `Context` is structurally typed, so `AgentTool` values with `execute` callbacks can reach a field declared as provider-only `Tool[]`; the agent loop can likewise spread lifecycle callbacks into provider options. Before Electron UtilityProcess IPC, positively project provider-facing tool definitions and documented stream options, then normalize the complete frame to the strict JSON wire contract.
- Generative UI guest HTML is untrusted. Keep iframe `sandbox` at `allow-scripts` only and deny guest `connect-src`. Do not use `iframe srcDoc` in the privileged renderer: Chromium inherits the parent CSP, so guest inline scripts and `aiden-genui:` host libraries never run unless parent `script-src` is widened (forbidden). Serve wrapped HTML from `aiden-genui://preview/<token>` with CSP as a response header and point the iframe `src` at that URL. Host Chart.js/Plotly/KaTeX must load from the allowlisted exact `aiden-genui://` library names or be inlined on export—never from a CDN, and never via a scheme-wide `aiden-genui:` script-src. `protocol.registerSchemesAsPrivileged` has to run before `app.whenReady`.
- A streamed artifact card flickers when its React identity conflates content with position. Keying the card list by content hash made every same-title replace remount the whole chrome, and clearing the iframe `src` before the replacement resolved flashed a placeholder through a fixed-height slot. Key by the stable `mediaId`, fetch first and swap `src` in place, and during the persisted-message reveal window let the live streaming card win while the persisted copy stays hidden so the transition is one atomic swap instead of unmount/remount in two frames.
- An in-chat "Thinking" shimmer can die while the sidebar spinner keeps spinning because the two key off different truths: the sidebar uses stream ownership, the transcript uses content shapes (`!content`, `streamingText.length`). Dropping pi-ai's `toolcall_*` assistant events made the model's longest phase (writing tool-call arguments, e.g. a whole HTML artifact) invisible for every provider; Codex is worst because it often streams no reasoning summaries at all. Consume `toolcall_start` (the partial block carries the final `toolCall.id`, so execution events upgrade the same step), derive the ReasoningBlock's active state from an open thinking step rather than `!content`, and gate "Responding…" on recent text deltas so stale prose cannot pin a static row.
- Sequential `lstat` checks cannot secure a multi-component path against a rename between checks; each accepted ancestor has to remain pinned while the next component opens. For workspace artifact reads, extend the native descriptor-relative helper and test a deterministic mid-walk directory swap instead of relying on timing-sensitive JavaScript races.
- Moving an existing iframe or one of its ancestors between DOM parents can reload its document in Chromium even though React preserves the component identity. Positioning the unchanged host over a portaled modal also fails when transcript `isolate`/`mask-image` stacking contexts trap it below the opaque portal. Promote the unchanged host with the Popover API into Chromium's top layer, override the UA's closed-popover `display:none` plus fixed geometry for its inline state, and browser-test stacking, one-frame count, mutable guest state, small viewports, and Escape relayed from the exact sandbox window.
- A mobile verification shell may know the Android SDK through `android info` while Gradle still lacks both Java and `ANDROID_HOME`. On this workstation, use Android Studio's bundled JBR as `JAVA_HOME` and the SDK path reported by `android info` as `ANDROID_HOME`; do not write a developer-specific `local.properties` into the repository.
- An unscoped desktop chat list includes reserved or stale workspace records in addition to user workspaces. Build a workspace-ID whitelist first and project chats through it; filtering only `botId` is insufficient because the reserved Assistant home and removed-workspace orphans are not Bot chats.
- A unified mobile chat outline can amplify an old transport cost without changing the endpoint: the current global home read carries complete transcripts. Keep the first UI delivery on the compatible read, measure real payload/decode/memory, and treat a bounded paginated summary endpoint as a coordinated server+iOS+Android follow-up rather than silently adding a second background fetch.
- A generic-hardware `xcodebuild build-for-testing` can finish compiling Swift app/test sources and then remain silent in a stuck `ibtoold` finalization pass. Distinguish that local Xcode tooling hang from a Swift compile failure, retain the generic `platform=iOS` destination (never substitute a simulator), and let the clean CI hardware-target compile provide the terminal gate.
- A dictation stop can arrive before microphone or Live-session startup finishes, and a Live transcript can be visible before its finalization handshake succeeds. Latch stop intent by operation identity, keep one wall-clock budget across Live and batch fallback, preserve committed Live text, and ensure cancellation remains callable after audio capture disconnects.
- Release-time and live validators for the same downloaded catalog can drift even when both look strict. Keep one shared acceptance corpus that runs every payload through both validators, including optional display strings and numeric bounds, so packaging cannot emit a snapshot the runtime will reject.
- A post-merge updater should not run dependency installation or repository scripts with `contents: write`. Verify and test under read-only permissions, transfer a hashed artifact, and give only a minimal publish job write access with checkout credentials disabled and the token scoped to its final push command.
- A clean `npm ci` can leave the `electron` package installed without its `dist/Electron.app` payload even when npm reports dependency scripts enabled. Before diagnosing the macOS dev-runtime preparation step, check `node_modules/electron/dist` and rerun Electron's package install script when the payload is absent.
- Computer Use can expose an Electron popover's accessibility tree while returning no screenshot for the open native menu state. Use the fresh accessibility state to verify menu contents and supplement visual-state verification with focused source/tests when pixel capture is unavailable.
- The root working agreement requires consulting and updating `.memory/`, but this PR worktree contains no `.memory` directory or files. Treat current plans, normative protocol docs, source, and tests as the available project history, and call out the missing checkout memory instead of inventing it.
- Parallel server/iOS/Android contract work can briefly diverge on seemingly small constants such as activity vocabulary, cursor bounds, and unknown-field behavior. Freeze those values in one explicit coordinator message before client model tests hard-code them; here the final contract is `idle|active`, 512-character cursors, tolerant harmless additions, and fail-closed required/private fields.
- A cache can satisfy the wire-item bound but still block the UI when every paginated page rewrites one maximum-size aggregate on the main thread. Size the native summary cache against the full 10,000-row contract, move encode/read/fsync work off the UI executor, and commit pagination state only after durable persistence succeeds.
- A connected iPhone is not enough for XCTest acceptance when the local provisioning profile omits the app's App Group entitlement. Keep generic-device `build-for-testing` as the compile gate, report the signing boundary honestly, and rerun device metrics only after `group.sbtbiswas.AidenOnTheGo` is provisioned.
- Adding a derived field to the canonical chat-list projection can leave exact-shape resilience and shipping-source assertions stale even when focused feature tests pass. Search every full-suite assertion over that projection before the first push, and derive expected compatibility values through the production helper rather than duplicating the hash contract.
- The primary checkout can remain on a feature branch whose upstream was deleted, making an otherwise clean hotfix look detached from its delivery path. Check `git status --branch` and worktree registration before editing, then keep diagnosis and verification local unless branch or push authority is explicit.
- A large exact-context documentation patch can fail atomically on one wrapped paragraph. Re-read the numbered lines and retry with the smallest stable context instead of assuming earlier terminal wrapping matches the file.
- `npm ci` reports the aggregate advisory count, which can widen a release hotfix unnecessarily when every finding is development-only. Confirm the shipped graph with `npm audit --omit=dev` before changing dependencies; this hotfix had zero production advisories.

## Packaged Electron consent acceptance without a shipped bypass

Artifact-level diagnostics acceptance needs to exercise renderer ownership,
preload IPC, the main handler, and `crashReporter.start()` while a native
confirmation is waiting for input. Do not compile an environment-variable
consent bypass into customer builds. Launch the disposable packaged process
with a loopback Chromium debugging port, invoke the public action through the
real preload bridge, use System Events to click the real native button by its
exact accessibility label, and verify a post-start diagnostic event plus
`uploadToServer: false`.

## Pi journal promotion recovery

A promoted v4 journal may legitimately retain a `.v3-backup` after its migration
receipt is lost in a crash window. Recovery must inspect the authoritative journal
header before choosing a decoder: decode the backup as v3 and the live journal as
v4. Treating every backup-bearing path as v3 makes the next packaged restart fail
on the already-promoted v4 header.

## Stacked release worktree setup

An execution command cannot start with a workdir that the same command is meant
to create. Add the detached worktree from an existing checkout first, then run
stack assembly inside it.

A fresh `npm ci` installs Playwright's package but not its Chromium binary, so
the full suite stops at Generative UI containment before assertions run. Mirror
CI with `npx playwright install chromium` before the first full local gate.

## Hosted MCP OAuth verification

The Dropbox origin-level protected-resource endpoint can return 429 while the
resource-path endpoint advertised by `WWW-Authenticate` succeeds. Verify hosted
MCP setup through that advertised RFC 9728 URL and the SDK's DCR redirect flow.

## Release preflight environment

`npm run release:preflight` intentionally fails outside the release runner when
Apple notarization credentials are absent. Treat local consumer/branding tests
as code gates and the credentialed GitHub release job as the signing gate.

## Cross-client global settings

Remote has feature-specific settings routes but no general settings contract.
An authoritative global preference therefore needs a narrow server-owned
endpoint; storing it only in iOS or Android would not change Mac agent behavior.

## Worktree verification dependencies

This worktree has no local `node_modules`; `npm run type-check` initially fails
with `tsc: command not found`, so verification needs the bundled runtime or a
dependency install before TypeScript suites can run.

Android Gradle also does not discover the installed SDK in this worktree;
verification needs `ANDROID_HOME=/Users/sambitbiswas/Library/Android/sdk`.

The full iOS `AidenRemoteClientTests` target currently has two unrelated
failures in chat-summary/private-child validation; focused memory tests are
needed to separate this change from that baseline noise.
- Verification initially referenced a guessed OpenAPI path; the canonical files are under `protocol/aiden-remote/v1/`.
- Focused Android tests need Android Studio's bundled JDK because this shell has no default Java runtime.
- URLProtocol request bodies can arrive through `httpBodyStream`; iOS request tests must use the existing `bodyData` helper.
- In zsh, a loop variable named `path` overwrites the executable search path; file-by-file commit scripts must use a non-reserved name.
- Parallel `xcodebuild` invocations share DerivedData and can lock `build.db`; run simulator build and test gates sequentially or isolate derived-data paths.
- New focused tests can pass locally yet be absent from `npm test`; register every new test script in the CI entry chain.
- Revision checks around settings writes need an explicit serialized lane; async read-then-write alone permits stale concurrent mutations.
- Backticks in `gh api -f body=...` are evaluated by zsh before submission; use single-quoted plain text or standard input for review replies.
- A merged feature does not auto-increment releases; bump both package manifests before merging when the current tag already exists.

## Codex-hosted UI reference work

Codex blocks Computer Use from automating its own `com.openai.codex` host. Use
the supplied screenshot and inspect the installed app bundle for behavior and
styling evidence instead of treating self-host automation as available.

A fresh linked worktree can lack `node_modules`: `npx` may fetch `tsx`, but
React-backed renderer tests still fail to load. Run `npm ci` before the focused
Quick View and Environment verification gates.

In this linked worktree, `npm ci` installed the Electron package without its
`dist/Electron.app` payload, so `npm run dev` reached Vite but failed in the
macOS runtime preparation `lipo` step. Run Electron's package installer before
attempting dev-app visual acceptance.

The project instructions reference a `.memory/` folder, but this linked
worktree does not contain one. Use the repository plan and UI reference docs as
the local source of truth, and record the missing folder rather than inventing
project history.

Adding or changing exports in the Environment or Terminal providers makes Vite
invalidate Fast Refresh and remount the renderer. An open terminal can then
briefly reference a main-process session that the remounted provider no longer
owns; reopen the terminal before judging the final live state.
- Source-regex coverage made the first Quick View split look independent even though both controls still shared one `open + tab` state. Add reducer transition coverage whenever two UI routes are meant to coexist.
- Simultaneous right-edge surfaces need measured workbench geometry, not window breakpoints; the app sidebar changes the available allocation without changing the window width.
- Final dev-window automation was unavailable while macOS was locked; the renderer and Electron process launched, but visual acceptance still requires an unlocked desktop.
- The deterministic Electron E2E still targeted the retired Environment summary role after the toolbar controls split. Floating surfaces can also cover their toolbar triggers, so smoke tests must use the visible surface-local Show Quick View and Close controls while verifying the toolbar state changes behind them.

- 2026-09-04: A mounted live-region test with only floating/pinned panels missed Quick View covering an open tools panel. Exercise inert/aria-hidden containment and persistent DOM identity in real Electron, plus message updates while the sibling panel is hidden.

- 2026-09-04: The diagnostics forged-record fixture aged past journal retention, so export pruned it before the rejection assertion. Use current timestamps for validation fixtures; keep fixed clocks for explicit retention tests.

## Design audit evidence (2026-09-04)

- The original standalone report copied palette values and hand-entered ratios, so runtime contrast fixes did not update its matrix. Generate measurements from the current appearance resolver and label compositing assumptions explicitly.
- The original report verification scripts logged failed checks without setting a failing process exit code. A successful command exit alone did not establish that their assertions passed; use enforceable assertions rather than console-only checks.
- Source-contract tests establish selected implementation rules, not rendered accessibility or full workflow coverage. Keep measured contrast, Electron interaction checks, and manual acceptance distinct.
- Archive untracked audit documents before a substantial rewrite: Git cannot restore their earlier contents. This run replaced the old `docs/DESIGN.md` with a scoped current reference; a complete original was not recoverable, so no purported historical archive was created.

- 2026-09-04: Full verification exposed a diagnostics fixture timestamp fixed to August 27; after journal retention elapsed, export correctly pruned it before the rejection assertion. Forged-record fixtures now use the current timestamp so the tests exercise validation instead of aging out.

- 2026-09-04: Tailwind 4 emits individual `scale` for scale utilities; transitioning/resetting only `transform` does not cover press feedback. Transition and reset the emitted property explicitly, including both reduced-motion sources.

- 2026-09-04: Electron CI intermittently retained the scheduled-task query after Playwright selectText + Backspace, then passed on retry. Reset this exploratory filter with fill("") while retaining input-value and result assertions; keyboard focus/navigation regressions remain separate. Completed-job REST logs were available before gh run view exposed whole-run logs.

- 2026-09-04: Substring selector edits can match the tail of a compound focus selector and strand base geometry in focus-only styles. Anchor standalone-selector assertions and measure resting preview boxes in Electron; computed colors alone do not prove that a preview renders.

## 2026-09-04 — pi-vcc integration

- The clone has an MIT declaration in README but no separate license file;
  retain that attribution and full MIT terms in packaged THIRD_PARTY_NOTICES.
- pi-vcc assumes numeric references and legacy retained IDs. Adapt its pure
  compiler; use v4 canonical active lineage and fail on an unprovable tail cut.
  Unknown/LLM summary-only gaps must bypass its format-specific merge parser.
- Vendor typing needs Intl.Segmenter typings and optional isWordLike; intentional
  control-byte regexes need a narrow lint exception, not broad lint suppression.
- Package verifier tests must realpath macOS temporary directories because /var
  is a symlink to /private/var and the production verifier rejects symlink paths.
- Android focused tests require Android Studio's bundled JDK plus ANDROID_HOME.
  iOS activity tests were run on physical iPhone 13 Pro, not a simulator.
- React Doctor's deprecated --diff invocation scanned the whole repository and
  reported existing ref-in-render/cleanup diagnostics outside this feature;
  TypeScript, ESLint and feature suites are tracked separately.
- Packaged Settings acceptance must seed profile readiness with profile:setName
  and app:setOnboardingProgress before deferring onboarding; settings:set ignores
  profile fields. Wait for and click the Settings button instead of racing the
  initial keyboard-command listener.
- PR review found cancellation coupled to the legacy status string. Use explicit
  compaction activity, and exercise engine override commands with IPC held open
  in Electron so fast local completion cannot hide the regression.
- Worker errors must preserve bounded, known causes without relaying arbitrary
  exceptions that could include history. Fixed codes allow operation-specific
  recall copy; Object.hasOwn is unavailable in this project's TypeScript lib.

## 2026-09-05 — 0.38.1 release signing

- Main CI passed, but the macOS release failed at security set-key-partition-list.
  app-builder-lib 26.15.3 incorrectly passes the certificate import password to
  unlock the temporary keychain. Upstream #10101 fixes this; stable v26 packages
  inspected through 26.16.0 still carry the old code. Keep the existing lockfile
  and apply the narrow version/source-guarded postinstall backport, with a
  platform-independent test that exercises both certificate and keychain paths.
- A changelog search conflated the stable and prerelease lines. Verify published
  package code before assuming a release contains the upstream patch.
- The environment-browser checkout has no `.memory/` directory despite AGENTS guidance; use current source, existing design references, and the scoped browser parity document as implementation evidence.
- t3code's browser spans profiles/import, recording, annotations, device emulation, and agent control across desktop/server/web. Track a source-backed feature matrix before porting; a navigation-only webview would silently miss the requested parity.
- `npm ci` completed without Electron's macOS payload in this worktree; `node node_modules/electron/install.js` restored `Electron.app` before UI testing.
- T3's hardcoded `source3` Playwright extraction points at a different bundle string in installed Playwright 1.62.1; locate the named generated module to preserve selector-engine parity.
- Generated onboarding art had real alpha but a 1254px canvas despite the requested 1024px; normalize the final PNG to the repository's exact 1024px contract and validate its alpha.
- System `java_home` has no registered JDK, but Android Studio's bundled JBR works for Gradle; use its `Contents/jbr/Contents/Home` and the existing Android SDK explicitly for focused mobile tests.
- No physical iOS device is connected for this run, and repository guidance prohibits simulators. Generic iOS `build-for-testing` with signing disabled compiles the app/tests; actual XCTest execution remains a physical-device check.
- Electron 43 emits the console-message payload on the event object; reading the legacy second argument as that payload threw during first navigation and blocked the test app behind an exception dialog. Use the current typed event and verify in real Electron, not just service mocks.

- 2026-09-07: Native Browser views sit above renderer menus/dialogs. Presentation now observes visible overlays and serializes tab show/hide across remounts so delayed cleanup cannot hide the replacement view.
- Renderer-only Playwright captures omit native WebContentsViews; use the exact worktree Electron.app with CUA for visual proof. Several installed Electron copies share a bundle ID, so resolve the full app path.
- Streaming reveal briefly renders duplicate final message text; E2E assertions must target the visible transcript occurrence and independently check the scripted tool scenario completed.
- Browser preflight exposed two existing source-contract mismatches in unchanged provider badges and button press-feedback tests. Keep that baseline distinct from browser regression results.
- Responsive emulation letterboxes inside the native slot. Crop captures to the rendered viewport before translating annotation coordinates; using the full slot silently distorts vertical selections.

## 2026-09-07 — Browser integration verification

- Floating placement measured the workbench wrapper and covered the Environment close control. Measure the chat viewport and visible side surfaces; retain a normal pointer-click regression.
- Approval summaries and tool admission both use browser policy helpers. Full-mode E2E misses Ask-mode summary errors; retain TypeScript validation and an actual approval-loop regression.
- Reverting live styles during the preview debounce must still enqueue the restored desired state; comparing only the last completed key leaves an in-flight change applied.
- Native visual verification exposed empty-chat composer overlap and CDP visible-size ownership. Reserve every composer and use `dontSetVisibleSize` so device emulation cannot override the measured native slot.
- Browser tab titles and renderer selection can lag the main state response. E2E waits for `aria-selected`, closes the intended row, and canonicalizes URLs when finding the native guest.
- Launching the shared Dev profile hit existing artifact/history recovery errors. Browser testing uses `build/browser-dev-profile/` with separate portable/user-data roots, copied provider setup, and a fresh workspace history.
- Live browser test: agent tried `browser_open(file:///tmp/sample.html)` and received HTTP(S)-only rejection, then recovered with a Python server serving all of `/tmp` on port 8899. UI workspace `open_file` is not exposed to agent tools; add explicit local-preview guidance and a bounded file-preview route through existing tools, including intentional handling of user-requested files outside the workspace and server cleanup.

## Browser lifecycle and progressive disclosure — 2026-09-08
- An agent-created Python preview outlived its document. Verified the exact task-owned PID/start/cwd/port, terminated it, confirmed the HTML was absent, and removed its log. Managed exact-file previews now replace that fallback.
- Review found queued actions could resume after human takeover, approvals could outlive page identity, and hover overlays could intercept semantic clicks. Added focused regression coverage and fixes. A cursor-cleanup review incorrectly read evaluate's isolated-world argument; the live cursor test caught the regression, and cleanup was restored to the creation context.
- Progressive disclosure must install executable tools and update both outbound and durable-compaction budgets at a turn boundary. A setup-return wiring mistake was caught by TypeScript/review before Electron validation.
- `tsx -e` uses CommonJS here and cannot load Pi's ESM-only export; use `node --import tsx --input-type=module` for measurement scripts.
- Host preparation runs after a tool turn, and Pi journals an aborted assistant on Stop. Cancellation tests must reach that boundary and preserve its journal record; an abort rejection must not become a policy fault, while an independent host failure must still fail closed.

- Electron main-process evaluation cannot dynamically import a module from the Playwright utility world. The delayed-acquisition regression uses `process.getBuiltinModule` and synchronizes builtin ESM exports so its filesystem gate actually reaches the production namespace import; restored in test cleanup.
- Final dev restart exposed Browser mounting with a fabricated default workspace while workspace data loaded. Mount it only after the selected workspace exists; verify cold startup and the existing Environment/browser integration suites.

## PR99 hosted CI follow-up — 2026-09-08
- Diagnostics source scanning treated console calls in the serialized Playwright guest runtime as executable main-process logging. Use syntax-aware scanning with regression cases, retaining the reviewed-sink boundary.
- Hosted CDP returned redacted object keys in a different order; the test incorrectly tied collision suffixes to boolean values. Verify distinct sanitized keys and preservation of both values without relying on enumeration order.

- Pullfrog identified silent sensitive guest permissions and a workspace-wide local-preview origin. Restrict guest grants and serve exact pinned document/asset sets with distinct origins; keep declared workspace-file authorization while blocking unrelated siblings.
- Ad-hoc `tsx -e` selected CommonJS and rejected the ESM-only Pi package exports. Use `node --import tsx --input-type=module` for token-estimate probes.
- Matching-first input probing showed Chromium suppresses the duplicate injected keyDown, so a timing-only expectation could swallow the only physical event. Use Electron's native debugger-source flag for keyboard input, and interrupt unexpected repeats. Mouse-down/up omit this flag and retain a bounded documented collision fallback.
- The next hosted Electron gate exposed immediate recording stop before the encoder produced a frame (both attempts). Validate recorder readiness instead of weakening the WebM assertion. Completed-job logs during an active run require the jobs/logs API; gh run view waits for whole-run completion.
- Independent Chromium reproduction showed per-port preview cookies leaked to other localhost ports because cookies ignore ports. Replace cookies with native frame/origin-scoped request authorization, strip inherited headers and legacy cookies, and test redirects against a controlled server.

## PR99 direct-preview follow-up — 2026-09-08
- Exact-grant hardening left path-only Files/chat/terminal previews unable to load local sidecars. Derive a bounded static resource set for user-originated opens only, preserve strict explicit agent grants, and test the actual path-only entry point.
- Static-discovery review found a sidecar symlink could target an excluded HTML/PDF, and same-content rewrites could reuse an older modification-time fingerprint. Reject canonical document targets and include pinned source metadata in grant identity.

## 2026-09-04 — Queued composer controls

- Pi harness queueSteer/queueFollowUp are not exposed through the foreground durable transcript path. Use Stop, a persistence barrier, and normal append for desktop Steer.
- E2E TypeScript uses an older lib target; use reverse/find rather than Array.at in new test helpers.
- Appearance persistence uses the `settings` envelope in settings.json; verify the preference from that envelope after relaunch.
- Queue removal confirms durable append, not provider receipt. Wait for the exact provider request before asserting conversation history.
- Joined actions need explicit square inner seams, shared outer squircle radii, visible focus overflow, and observable hover/focus tests.

## 2026-09-06 — Settings and global Skills verification

- Responsive Model Pad sizing must use the actual Settings scrollport and account for titles, controls, axes, legends, zoom, and scroll position.
- Gate both skill inventory readers before and after asynchronous discovery, and recheck at execution time; disabled projection must cover inference, compaction, recall, Telegram queues, and every Bot catalog/edit surface.
- Keep full tests and production builds sequential in one checkout because both build native helpers and concurrent runs can race over universal binaries.
- Route Bot-scoped catalog identity end to end and isolate per-Bot iOS caches; Android has no persistent catalog cache.

## 2026-09-08 — 0.39.0 four-PR integration

- Zsh does not split scalar loop values by default; use explicit delimiters in pairwise merge probes so branch names are not accidentally concatenated.
- Standalone green PRs still conflicted in shared settings, test registries, and UI fixtures. Assemble the exact combined stack and retain every feature's test registration before merging to main.
- UX review (2026-09-05): the active Xcode installation rejects tools until its license is accepted. Git and desktop C helpers can use the separately installed Command Line Tools via `DEVELOPER_DIR=/Library/Developer/CommandLineTools`; helper build scripts replace the child environment, so this run compiled their unchanged C sources with the same flags directly. iOS physical-device discovery/test remains blocked; do not claim it passed.
- Electron E2E failure diagnostics called `app.process()` outside their try/catch; a closed Electron target hid the original launch error. Keep that call within the best-effort diagnostic block. The isolated E2E profile also cannot establish native Bot Keychain authority; the editor test injects a test-owned IPC catalog and captures the submitted access, while storage/authority tests run separately.

## 2026-09-10 — Google catalog PR validation

The main checkout's shared node_modules matched Pi's pinned version but lacked
postcss-value-parser and @xterm/addon-web-links required by this worktree. The
resulting type errors disappeared after replacing the temporary dependency
symlink with this checkout's own npm ci. Full type-check and lint then passed.

## 2026-09-09 — Draft chat planning

- The checkout has no `.memory/` directory despite AGENTS.md referencing it; used current source and the plan index for project context.
- Native verification: no physical iOS device is online and local Java/Android SDK tools are unavailable. Run generic iOS build-for-testing and shared Remote contract suites; device XCTest and Android runtime acceptance remain unavailable locally.
- Draft lifecycle regression tests intercepted `chats:appendMessage` for first-send failures; updated that fault injection to the new atomic `chats:createWithFirstMessage` boundary.
- Empty-chat migration must distinguish header-only Pi journals (created by the old Todo snapshot read even before Send) from real private records; preserving every journal would leave ordinary abandoned chats behind.
- Completed Pi v3-to-v4 promotion adds lane/navigation records even for a header-only source. Empty cleanup must validate the real receipt, backup digest, and exact migration scaffolding rather than treating all promoted records as user history.

## 2026-09-10 — PR #102 readiness

- The initial source-scanning theory incorrectly credited explicit 1x encode arguments that are already Electron's defaults. Exercise the actual fix with a valid oversized PNG through `providers:save`, relaunch, and verify the recovered, decodable 64px-or-smaller result.
- Treat user-supplied provider PNGs as original-color artwork; an alpha mask turns fully opaque icons into solid squares and disagrees with native clients.
- Model Pad animation settling must ignore infinite animations and retain a bounded timeout so hosted Electron runs cannot wait forever.
- The cold hosted responsive matrix can reach its last 390px case only as the shared 90-second test budget expires, while a warm retry passes in 24 seconds. Give this exhaustive case an explicit bounded 180-second budget without relaxing geometry assertions.
- On hosted Electron, Playwright `fill("")` can leave a controlled search unchanged; use the native value setter plus a bubbling input event for deterministic test cleanup.

## 2026-09-10 — PR96 readiness rebase

- The branch predated the unified Settings work and conflicted in headings, accessible switch names, shared test fixtures, and the tracked-but-ignored papercut log. Resolve these contracts additively and use `git add -f` for the already tracked `.papercuts/troubleshooting.md`.
- A parent save handler showed a toast but resolved its promise, making the editor's inline retry state unreachable. Propagate the rejection after the toast so the review dialog keeps the user's choices and exposes the error.
- Progressive disclosure made two inherited E2E locators inaccessible: tests must open the exact Remote or Telegram details before asserting the controls inside, rather than spending the full timeout waiting for hidden semantics.
- A single rollback `try` coupled external Tailscale route cleanup to local listener/state cleanup; keep independently knowable cleanup steps best-effort and report external versus local uncertainty separately.
- Distinct cleanup messages need branch-specific regressions: cover both newly enabled access being disabled and pre-existing access staying enabled when route removal fails.
- Hosted Electron can leave a controlled scheduled-task search unchanged after Playwright `fill("")`; use the native value setter plus a bubbling input event for deterministic cleanup.

## 2026-09-10 — PR #81 readiness rebase

- The stale terminal migration conflicted with newer browser-link integration and expanded package scripts; preserve current `main` scripts and link routing, then layer the Ghostty-specific test/build hooks back in before regenerating the lockfile.
- `npm ci` completed without Electron's macOS payload, and the first focused Playwright command omitted this repo's explicit config; install the payload with `node node_modules/electron/install.js` and pass `--config=playwright.config.ts`.
- Canvas terminal link detection and host navigation policy had separate truth sources, so unsupported file-like text gained a dead click affordance. Pass the host policy into the surface and filter hover and activation together.
- Ghostty correctly encodes modified keys, but Meta chords belong to the host; suppress unhandled Meta press/release pairs after terminal copy and paste handling. Do not key this off `navigator.platform`: Chromium may reduce it even in a macOS Electron renderer.
- The terminal Playwright fixture launches compiled renderer output; rebuild before interpreting a focused E2E failure after source edits, or the test exercises the previous bundle.

## 2026-09-11 — 0.40.0 integration

- E2E chat-title expectations assume the deterministic chat-model route. On a Mac where the native Foundation Models helper reports `ready`, automatic titles come from Apple Intelligence instead, so `chat-message-queue` sidebar-title lookups fail locally while passing in CI; probe the helper or move it aside before treating those failures as regressions.
- `git add` on the tracked-but-ignored `.papercuts/troubleshooting.md` still needs `-f` after conflict resolution.

# Custom model options

- Fresh worktree has no `.memory/` or dependencies; inspected existing implementation and installed dependencies before validation.
- Video input is not supported by Aiden's chat attachment transport. The capability option must describe server support without advertising video uploads.
- Review found capability consumers outside the desktop/native picker (Bot inventory and Telegram) and assistant artifact images in raw history; added projection and role-aware image-limit regressions.
- Frozen runtime contribution snapshots require a copied tool policy; added a real harness test covering base and extension tools.
- Hosted verify hit a pre-existing Git cancellation fixture race: a short marker poll expired while push was still running, then cleanup removed its wrapper. Replaced delay/count coordination with a bounded marker handshake and awaited cancellation cleanup.

## 2026-09-12 — MCP maintenance implementation

- MCP SDK1.30.0 closes HTTP transports during OAuth redirection but expects finishAuth to reuse the same object and discovered metadata. Restart only its exchange request lifetime, retaining owner cancellation.
- SDK OAuth metadata GETs also send MCP-Protocol-Version; a protocol header alone does not identify a timed MCP RPC. Classify actual request semantics and test the real SDK helpers. SSE per-frame limits apply only to successful requested streams, never arbitrary MIME-labeled JSON/error bodies.
- Physical-iPhone native verification found three failures in unchanged RemoteClient fixture tests (catalog expectation, invalid JSON __SwiftValue, and legacy fallback invalidResponse). See the maintenance acceptance record; Android52 passed, iOS198 passed/3 skipped/3 failed.

- Production provider 400s are untriageable from `logs/aiden.log` alone: the real error text survives only in `userData/pi-compaction-sessions/*.jsonl` (per-message `errorMessage`), because the diagnostic journal strips provider messages outside the development profile. Check the journals before assuming a classification.
- `@earendil-works/pi-ai` transports merge `model.headers` into every outgoing request and merge `options.headers` last — a per-conversation header can be attached once at runtime-model resolution instead of threading it through each call site.

## 2026-09-12 — Production provider-failure investigation

- The 0.40.0 production diagnostic log collapsed a concrete OpenCode Go 400 into duplicate `unknown` generation failures; correlate the Pi journal to recover historical provider causes. PR #110 improves future evidence but cannot reconstruct old redacted logs.
- A renderer exception during final streaming can detach a generation and miss its one-shot terminal payload. The durable run and chat settle correctly, but `chats:settled`/authoritative refetch does not clear the retained detached-stream owner, leaving “Response continues in the background…” and the sidebar activity ring until the renderer restarts.
- A parallel read-only diagnostic command used a stale worktree path and failed before inspection; validate the active checkout path before dispatching concurrent repository reads.
- The repository script is `npm run type-check`, not the common `typecheck` spelling; inspect `package.json` before chaining validation commands so a typo does not skip later linting.

## 2026-09-13 — GitHub PR checks sidebar dev launch

- `npm ci` completed successfully but left `node_modules/electron/dist/Electron.app` absent; restore the macOS payload with `node node_modules/electron/install.js` before running `npm run dev`.
- The default development user-data profile contained unreadable visual-artifact state and disabled chat mutations; use isolated `build/peer-dev-profile` and `build/peer-dev-config` paths for branch testing without modifying shared state.
- Whole-file formatting reflowed unrelated JSX and broke whitespace-sensitive sidebar source assertions; keep those assertions tolerant of formatter line wrapping during focused UI edits.
- OpenCode Workers passed the removed `opencode run --dir` flag to OpenCode v2.0.3, so the isolated review had to run directly from the worker worktree.

- Mobile progress implementation (2026-09-14): this worktree had no node_modules; initial type-check was dependency-incomplete. Run npm ci before interpreting its missing-module output as source failures. Dedicated progress SSE uses the snapshot directly as payload; do not wrap it or reuse device-owned parent turn events.

## 2026-09-15 — Gemini Live orb shell

- Rebasing the long-lived Gemini Live branch replayed 79 commits and conflicted in the frequently updated plan index; preserve the current `origin/main` inventory and reapply only the missing Gemini Live row.
- The published `thinking-orbs` 0.3.1 package includes `breathing` but not the repository's newer `color` prop. Reuse its canvas animation and apply Aiden's blue tint at the presentation layer until the tint API is published; do not vendor unreleased package internals.
- Pullfrog's incremental review retained two must-address findings from the prior head: fail closed when a Computer Use result lands during Live transport rotation, and re-read authoritative status after audio-start rollback so a stopped session remains restartable.
- Replacing a window-level surface can leave unreachable components and motion selectors behind; remove the retired Assistant panel files and assert the dock does not regain those imports or styles.
- `gh api graphql -F name="$VALUE"` does not read an unexported shell placeholder; pass resolved review-thread variables directly with `-f` before replying or resolving.
- Deleting the Assistant panel also removed the only listener for Scheduled Tasks' compose handoff; keep entry-point events covered end to end through draft creation, navigation, and composer seeding before removing their prior owner.
- The full Electron E2E gate still encoded the retired Assistant panel and old Aiden settings destination even though focused source-contract tests passed; update user-journey E2E whenever a top-level surface is replaced, not only its component tests.
- A clean latest Pullfrog summary can coexist with unresolved older inline threads; query `reviewThreads` directly before declaring the review gate clear.
- Replacing a shipped surface must update the authoritative plan index and add an explicit supersession note to the historical plan; code and tests alone leave misleading implementation claims.

## 2026-09-15 — 0.41.0 launch incident

- A signed, notarized, Gatekeeper-accepted app can still remain at `_dyld_start` with a 96 KB footprint on macOS 27; sample the process and inspect ShipIt before blaming Electron startup or profile migration. On build 26A5425a, fresh Aiden 0.40.1/0.41.0, Electron 43.7.1/44.4.0, and Cursor all reproduced the same pre-main suspension, while native IINA launched. Preserve the blocked bundle and updater logs, and keep this beta-OS gate separate from release artifact verification.

### 2026-09-15 — Release review caught a stale Gemini Live gate

- The beta UI and README were ready to ship while `geminiLiveEnabled()` still required an undocumented opt-in environment variable.
- Treat user-visible beta activation and its main-process capability gate as one release contract; keep `AIDEN_EXPERIMENTAL_GEMINI_LIVE=0` only as an emergency rollback.

## 2026-09-16 — Aiden Live 0.41.2

- A clean release worktree has no dependencies, so `npm run type-check` fails with `tsc: command not found`; run `npm ci` before interpreting validation output.
- The UI-context helper uses its invoking directory, not a newly created worktree path mentioned in the same shell command; invoke design tooling from the target worktree after creation.
- Running Prettier directly rewrites large legacy files that use the repository's established formatting; audit the diff immediately and use targeted patches for this release.
- This worktree has no project `.memory/` directory despite the repository instructions; keep durable implementation status in the plan inventory instead of inventing the missing store.
- Exact-head CI intermittently missed a watched filesystem edit within the test's one-second deadline while the same watcher test passed 10/10 locally; distinguish infrastructure timing from feature regressions before changing unrelated release code.

## 2026-09-16 — Aiden Live voice actions

- The installed Google SDK exposes Live `interactionStatus` inside `serverContent`, while newer Extended Thinking examples describe status alongside tool-call lifecycle events; pin protocol handling to the installed typed wire contract and cover `IDLE` explicitly when adopting the new model.
# Release coordination

- Screen-share work was based on an older Live contract. Integration must retain the exact Computer Use authorization token, extended-thinking model, async thread finalization, direct-action policy, device routing, and empty-envelope fix; add screen intent without replacing these later changes. Original screen worktree remains unchanged.

- Live device picker visual check found two interacting issues: settings action-cluster CSS wraps every direct `.flex` child, including combobox triggers, and Radix Select.Value strips className/style. Scope a no-wrap override to Live device triggers and truncate their actual value spans; static markup tests alone did not catch geometry.

- Live device routing must retain one audio dependency/player instance across capability refresh; otherwise start preflight can configure a different player from the hook's retained playback ref. Keep capabilities separate from audio ownership.

- Audio selectors: Radix SelectValue has no selected-item text in static rendering until its item collection mounts; supply an explicit selected label so unavailable-device and initial-render states are readable and testable.

- Pullfrog took just over one hour to review PR #132 after first-party CI was green; keep exact-head checks separate so the long external review does not obscure test status.
- Moving Live from default-on to acceptance-gated correctly hid the dock but invalidated the local UI E2E; keep default-off rendering covered separately and opt the isolated provider-free E2E harness into the experimental surface explicitly.
- The hosted full Electron suite marked the unrelated chat-switch queue test flaky after it passed on retry, and `--fail-on-flaky-tests` failed the whole gate; rerun the exact failed job before changing unrelated product behavior, while preserving the strict gate if the flake repeats.
- A distant Environment source-contract test asserted Aiden Live's two-argument command registration, so focused Live tests missed the intentional capability gate; search all source-contract assertions when changing a shared command signature.
- Signed Live test build: `isPackagedRuntime()` is false for an isolated development profile, causing Computer Use to search inside app.asar/build instead of Contents/Helpers. Resolve physical helper layout using `app.isPackaged`; profile identity must not determine package resource locations.
- Live cue tests must flush passive React effects after microphone and stop state updates before asserting audio feedback. The repo has no local Prettier binary; use its configured ESLint validation instead.
- Real signed Live session reached open/microphone-ready/input-first-packet, then Google emitted an empty top-level envelope at 00:20:01 UTC on 2026-09-17. Rejecting `{}` caused the observed silent disconnect. Admit exact empty envelopes as rate-limited no-ops without extending idle timeout; keep unknown populated fields rejected. Terminal error HUDs must remain visible after active becomes false.
- The Mac's default input was Bose Mini II while output was MacBook speakers. Packet flow alone does not prove intelligible user speech or audible playback; retain separate operator verification.
- Pullfrog completed only after GitHub had already accepted the exact-head merge, and it found release-blocking screen-capture races. Keep publication cancellable until external review finishes, even when first-party CI and the merge gate are green.
- Electron exposes setters but no getters for session permission handlers. Scope the Live handler to the lifetime of exact display bindings, explicitly admit only display capture and microphone for that bound document, then restore the default handlers when the last binding disappears.
- Electron's `media` permission covers camera as well as microphone; check `mediaType` on permission checks and exact `mediaTypes: ["audio"]` on permission requests instead of treating the permission name as audio-only.
- A green external-review check can race a final inline comment by seconds. Re-read unresolved review threads after the check completes and make the merge command conditional on an empty result rather than chaining inspection and merge unconditionally.
- React effect cleanup marks the hook unmounted before revoking picker authority; reconfiguration needs the replacement effect setup to reset UI ownership, while final unmount must not schedule state recovery.
- A release can contain a fully tested user-facing feature while still hiding it from Finder launches if its main-process capability defaults to an environment-only opt-in. Add a focused default-environment regression whenever changing a shipping feature gate.
- For a default-on environment gate, do not use trimmed-value truthiness to detect absence: an unset variable may enable the default, but explicitly empty or whitespace-only overrides must remain fail-closed.
- E2E migration fixtures that edit persisted chat files while Electron is still running can be overwritten by shutdown drains. Seed disk state only after the app closes and before the replacement process launches.

## 2026-09-18 — CI feedback optimization

- A fresh `npm ci` on this Mac again left Electron's executable absent; run `node node_modules/electron/install.js` before local E2E. The initial shard command stopped before starting any tests.
- The host defaults to Node 26, while CI pins 22.22.3. Validate registry parsing and process behavior with the installed Node 22 path.
- Workflow text tests can pass while referenced CLI arguments or package scripts are missing; validate the actual matrix commands and package entry points before pushing.
- Filename-only lane balancing initially placed native helper tests away from their build prerequisites. Keep binary-dependent tests with those builds and cover that association in registry checks.
- Local browser E2E encountered an assistant overlay intercepting an Add to chat click. Preserve the strict test and compare hosted behavior before changing product or fixture code.
- Some `.mjs` regressions import TypeScript modules with `.js` specifiers. Keep ordinary lane tests under the original tsx resolver; plain Node loses that resolution behavior.
- Moving release eligibility from per-step conditions to an admission job requires updating existing distribution and diagnostics policy tests to assert the new job boundary.
- The core lane's browser-file regression also launches Chromium. A warm local browser cache hid the missing hosted prerequisite; declare browser installation on both core and renderer matrix entries and check it against preserved browser modes.

- 2026-09-19 provider-streams: fresh worktree omits ignored `.memory`; read canonical checkout project context and will add a lane-specific note. Installed private node_modules with scripts disabled to avoid concurrent native/Electron builds.
- 2026-09-19 provider-streams: explicit `git add` reported ignored `.papercuts` even while staging its tracked file; used explicit force-add for required lane artifacts.
## 2026-09-19 — upgrade compaction checkpoint recovery

- Worktree has no `.memory/` or dependencies; used checked-in plans and installed isolated dependencies with scripts disabled.
- `.papercuts/` is ignored but its troubleshooting file is tracked. Restored its full existing contents after detecting an accidental replacement during diff review; appended only this entry.
## 2026-09-19 — upgrade 03-subagents
- Fresh worktree omits ignored `.memory`; read relevant project history from the primary checkout and create a lane-specific memory note locally.
- `aiden-plugins` is a collection rather than a Git root; pin the nested `pi-subagents` repository.
- No worktree dependencies; install a private node_modules with lifecycle scripts disabled for focused TypeScript tests (no Electron packaging needed).
- Explicit staging of `.papercuts/troubleshooting.md` hit the ignored parent-directory rule; force-stage only the authorized lane feedback and memory files.
## Upgrade 04 MCP

- Fresh worktree omits ignored `.memory`; consulted main checkout PROJECT-CONTEXT and DIAGNOSTICS-CAUSES, and will write a lane-specific note locally.
- Dependencies absent in isolated worktree; installing locally with Electron payload download skipped because tests need only SDK/TypeScript.
## Upgrade campaign: Web access

- Fresh worktree has no `.memory` (gitignored); consulted primary checkout project notes and web-access plan.
- `aiden-plugins` is a collection, not a Git repo; use the nested `pi-web-access` repository for baseline hashes.
- Dependencies are absent; install locally without Electron lifecycle downloads for focused service tests.

- Restored existing troubleshooting history after detecting an overwrite in diff review; lane notes are appended.
## 2026-09-19 — upgrade-06-skills
- Fresh worktree has no ignored `.memory/`; read canonical project context/history and the completed skill plan, then create a lane-specific memory note locally.
- Broad service searches hit a large generated browser source string; restrict searches to skill files to keep inspection usable.
- Dependencies installed locally with lifecycle scripts disabled; this service-only lane needs no Electron/native build.
- YAML AST map `get()` generic inference narrowed scalar text to `never`; treat the retrieved node as `unknown` and narrow through `isScalar` plus a string check before reading metadata.
## Upgrade git worktrees — 2026-09-19

- Fresh worktree has no ignored `.memory/` or dependencies. Read relevant canonical project memory; install isolated dependencies with `npm ci --ignore-scripts` and explicitly build only the native worktree-remover needed by Git tests.
- Git service and its tests are large; use targeted function/range reads to avoid truncated investigation output.
- Explicit `git add` rejected the ignored `.papercuts/` parent even though the log is tracked; stage the tracked log with `git add -u -- .papercuts/troubleshooting.md`.
## 2026-09-19 terminal startup upgrade

- Fresh worktree has no `.memory/` because the folder is ignored; read canonical checkout terminal history and create a lane-specific local note.
- Fresh worktree has no dependencies; installed lockfile dependencies locally without building or packaging Electron.
- Initial papercut write replaced the existing tracked log; diff review caught it and restored all baseline entries before appending this section.
## Upgrade 09 attachments
- Fresh worktree omits ignored `.memory/`; read main checkout project context/history and create a unique lane note.
- Initial broad source reads were truncated; use targeted ranges for attachment investigation.
- TypeScript targets a pre-ES2022 library: regression fixtures must use indexed access instead of `Array.at`.
## 2026-09-19 — upgrade-10-schedules
- This fresh worktree has no `.memory/` directory or installed dependencies. Read the current scheduler recovery plan and prior scheduler notes; create the lane memory file and install private worktree dependencies.
- Whole-file `oxfmt` rewrote unrelated existing scheduler formatting; restored untouched lines to keep the PR focused. New tests use current formatter output.
- Explicit `git add` rejects the tracked troubleshooting path because its parent is ignored; use `git add -u -- .papercuts/troubleshooting.md` and force-add only the requested new lane memory.
## 2026-09-19 — Upgrade 11: memory expiry

- Fresh worktree omits ignored `.memory/` and dependencies. Read main-checkout memory and checked-in plans; installed dependencies locally with lifecycle scripts disabled for scoped tests.
- `aiden-plugins` is a container directory; use the nested `context-mode` Git SHA for reference evidence.
- Diff review caught a troubleshooting-file overwrite; restored the existing entries and appended this lane instead.
- GitHub refused the full #121 diff because it exceeds 20,000 lines; the paginated PR-files API supplied the memory-store patch for overlap review.
## Upgrade 12 desktop UI — 2026-09-19
- Fresh worktrees omit ignored `.memory` context; read the canonical project's command-system history and create a lane-specific note here.
- No local dependencies are present; install this worktree's dependencies before renderer regression validation.
- `npm ci` omitted Electron's executable; restored with its install script. Renderer/main-only bundles then exited before first window, so focused UI validation needs the normal native helper build prerequisites too.
- Command-system aggregate has a pre-existing stale source assertion in `main/services/renderer-readiness-core.test.ts`: it expects a no-argument crash callback immediately resetting readiness, while main now records crash diagnostics first. Reported to campaign coordinator; preserve renderer-only scope.
- Palette regression assertions must inspect loaded chat content because the desktop router uses memory history; the file URL does not change on chat navigation.
## 2026-09-19 — Android upgrade lane
- Fresh origin/main has no `.memory/` directory; read the mobile plan and create the required lane-specific memory note.
- OkHttp `responseBodyStart` fires after its first underlying read; use a tracked source to coordinate cancellation before a deliberately stalled read in the regression test.
## Upgrade 15 Linux

- Fresh worktree has no ignored `.memory/`; read canonical project context, then create the lane-specific note locally.
- `gh pr view --json files` truncates PR #71 at 100 files; use paginated REST files to check overlap against its full change list.
- Troubleshooting log is tracked despite its ignore rule; preserved baseline entries and appended lane notes.
- This checkout does not include Prettier; matched existing formatting manually and used repository ESLint.
## 2026-09-19 — Android SSE EOF regression

- Fresh worktree has no `.memory/`; read main checkout context and create a lane-specific memory note.
- Three existing RemoteClient tests used `trimIndent()` SSE fixtures without a final blank line, silently relying on the EOF flush bug; terminate those fixtures explicitly.

## 2026-09-19 — Campaign integration validation
- Fresh validation worktree omits ignored project memory and dependencies; read canonical project context and install a private dependency tree.
- Independent lane appends conflict in the tracked troubleshooting file; preserve both three-way append histories. Package test registrations and yaml dependency merged cleanly without lock regeneration.
- Avoid full troubleshooting/toolchain dumps in tool output; retain exact logs and print bounded summaries.
## Lane 17 readiness regression

- 2026-09-19: Fresh worktree has no ignored `.memory/` or dependencies. Read relevant project memory from the saved project and install isolated dependencies with scripts skipped; this test-only lane requires no Electron/native builds.
- Baseline crash-handler assertions still require pre-diagnostics callback parameters and pre-backoff reload shape; scope matching to the crash callback while retaining recovery checks.
- Lint requires `{2}` for the callback-closing indentation in source-contract regex (`no-regex-spaces`). Corrected and reran lint.
- npm ci completed without Electron executable; ran node_modules/electron/install.js explicitly before Electron E2E.
## 2026-09-19 iOS upgrade

- This isolated checkout has no `.memory/`; read the source checkout project context and create a lane-specific memory note.
- `xcrun devicectl list devices` hangs without output; use bounded device discovery and retain physical acceptance as an explicit gate if unavailable.
- Stable Xcode stalls in `xcodebuild -runFirstLaunch`; per-command `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer` builds successfully. The available physical iPhone remains in Xcode device-symbol preparation, blocking focused XCTest launch.
- Physical XCTest retry also reported missing compatible DeviceSupport symbols and remained preparing beyond its destination timeout; stopped it and recorded hardware execution as outstanding. A temporary macOS probe reproduced the baseline framing bug and verified the fixed production parser/decoder/byte loop.
- Central review found that startup ownership was checked before, but not inside, runtime persistence. Added a deferred commit fixture to reproduce stale failure quarantine and next-run writes; carry authority into the existing DataStore commit guard.
- Full combined npm test passed with one environment skip: legacy endpoint port 65535 is occupied on this host. Preserve that skip instead of stopping another process or claiming complete port coverage.

- SDK 1.30 remote transports report failures through `onerror`, not `onclose`; the EventSource onerror property callback runs before dispatch, so its event target is still null. Its pinned terminal response errors carry a numeric HTTP code, whereas reconnectable EOF/network errors do not. HTTP reconnect callbacks can schedule a timer after error notification, requiring teardown after those callbacks settle.
- Pullfrog identified a separate stale Cron error callback path. Reproduced deferred lookup, run-history publication, and runtime publication; bind failure recording to current job ownership and carry the guard through both stores.
- Reproducing the shared-store renewal race needs deterministic interleaving: a test-local SQLite exec hook lets a second real connection commit immediately before lock acquisition without sleeps or production hooks.
- Test coverage inventory must recurse npm lifecycle and nested scripts: memory-store runs through pretest/test:compaction, and scheduler core runs directly in test:assistant-automations. A direct-string scan of only pretest/test falsely labels those scopes omitted.
- Pullfrog follow-up: `yaml@2.9.0` `uniqueKeys` checks scalar equality but admits alias-equivalent duplicate mapping keys. Validate root key node types before extraction; retain unrelated alias values without expansion.
- Pullfrog caught callback-slot starvation: OkHttp 4.12 releases its per-host async slot only after `onResponse` returns. Validate concurrent stalled responses as well as individual cancellation.
- HTTP GET-stream retry exhaustion is not whole-session failure: reproduce a subsequent `tools/list` POST before recommending eviction. The pinned SDK successfully serves POST discovery on the retained session after both optional GET retries fail.
- Pullfrog caught a missing established-chat boundary: attachment intake must check the synchronous pending-send ref before optimistic-clear recovery can restore its payload. Mounted regression reproduced 23 restored attachments from a 20-attachment draft.
- Reviving the August iOS picker through `git rebase --rebase-merges` replayed September's obsolete desktop/settings merge topology and produced broad conflicts unrelated to the picker. Verify branch ancestry first, then port the still-missing native delta onto current `main` while retaining current chat contracts and tests.
- The nested iOS working agreement excludes simulator evidence. A focused simulator run completed before that nested instruction surfaced, so it is not counted as acceptance; all physical iPhones were offline and physical XCTest/camera verification remains open.
- Pullfrog found two cross-lifecycle attachment races in the restored branch: AVFoundation delegate results must be fenced to the exact capture generation, and PhotoKit continuations must retain/cancel their request ID while commit-card cleanup consumes the matching selection generation only.
- Mounted Composer fixture must explicitly externalize React in esbuild; repository TypeScript wildcard paths can otherwise bundle a second hook runtime despite packages=external.
- Pullfrog found cmdk 1.1.1 retains keyword aliases while item `value` stays unchanged. Dynamic rows need a value including identity plus current metadata, not merely new `keywords` props.
- A separate cmdk automatic-selection active-descendant gap reproduces on the unchanged initial PR head before metadata updates; reported centrally. The focused regression preserves explicit arrow-navigation accessibility checks.
- Follow-up catch-up audit found two missed-run advances: job setup and dispatch claim. Guarding only the claim would still lose due state. Preserve overdue nextRunAt through setup, require authority on every automatic dispatch, and settle a cancelled predecessor before restart admission.
- Lock-wait expiry regressions can stay deterministic: advance the injected clock while the competing SQLite connection owns its transaction, then admit the store without wall-clock sleeps.
## 2026-09-19 — lane 18 browser lifecycle
- Fresh worktree lacks the gitignored `.memory/` directory; read relevant project history from the primary checkout before creating a lane-specific note.
- Crash recovery regression needs controlled Electron event/timer delivery: wall-clock sleeps cannot reliably put navigation inside the 300 ms retry window. Tests hold handler-created timers, then deliver stale callbacks deterministically against real guests.
- Full browser Electron run reached an annotation click timeout: Aiden Live's floating app-icon launcher intercepts `Add to chat` at browser.spec.ts:89. New crash regressions pass; checking the unchanged baseline separately before classifying the broader failure.
- Confirmed identical annotation interception on unchanged baseline `5cc831a`; screenshot visibly shows the Live launcher over Add to chat. Reported to campaign root and attachment owner; retain this as an explicit suite limitation.
## 2026-09-19 voice upgrade
- This fresh main worktree has no `.memory/` directory; inspected the completed dictation plan and current source, and will add a scoped implementation note.
- Renderer build passes with pre-existing Ghostty mixed static/dynamic import and large-chunk warnings; no voice build failure. Repository `.memory/` is ignored, so the scoped delivery note requires explicit force-add.
- 2026-09-19 auth lane: fresh worktree has no ignored .memory directory; read canonical project context and create a lane-specific note. Installed isolated dependencies with npm ci.
- 2026-09-19 lane 21: Fresh worktree has no .memory or dependencies; consulted canonical project memory and installed isolated dependencies with lifecycle scripts disabled for server-only tests.
- 2026-09-19 lane 21: Repository ignore rules cover .papercuts and .memory; explicitly force-staged only the requested lane memory and troubleshooting file.
- 2026-09-19 (22-telegram): Fresh worktree omits ignored .memory and dependencies; read relevant project memory from primary checkout and install isolated dependencies. Hermes Telegram adapter moved from gateway/platforms to plugins/platforms/telegram/adapter.py.
## 2026-09-19 diagnostics lane
- Fresh main worktree has no `.memory/` directory; used diagnostics plan/inventory as current architecture evidence and will add a scoped implementation note.
- Node test `mock.method` does not contextually type async filesystem replacements here; annotate wrappers with `Parameters<typeof original>` so the regression tests pass strict TypeScript.
### 2026-09-19 — workspace file read investigation
- Fresh worktree has no `.memory/` directory or dependencies. Read the current Quick View plan and source; installed isolated dependencies with `npm ci` and will create a lane-specific memory note.
- Android has no system Java registration; focused native tests pass using Android Studio bundled JBR via explicit `JAVA_HOME`.
- `xcrun devicectl list devices` stalled; stopped only that discovery process and used bounded `xcodebuild -showdestinations`. iOS verification uses isolated unsigned build-for-testing to avoid installing over the user app.
- Repository ignores `.memory/`; explicitly stage the requested unique lane note with `git add -f`.
## 2026-09-19 — updater lane 25
- Fresh worktree has no .memory directory or dependencies; read canonical project history and install isolated dependencies with scripts disabled for simulated updater tests.
- Hosted queue-image E2E raced send settlement: Stop generating appeared before attachment admission reopened; synthetic paste was intentionally rejected. The test must await the production Attach button enabled state.
- In-progress workflow logs require the direct jobs/logs API; gh run view refuses them and gh api needs --allow-escape-sequences when writing colored logs to a local file. Hosted artifacts intentionally contain only sanitized receipts.
- SDK 1.30 legacy SSE reauthentication has no public settled callback; failed refresh/redirect can strand a CLOSED receive stream while HTTP POST remains usable. Isolated the pinned `_authThenStart`/`_eventSource` compatibility hook, rejected unknown shapes, and tested actual auth failure versus successful and transient recovery. Recheck this seam on SDK/EventSource upgrades.

## 2026-09-19 — Integration wave 2
- Batch expansion requires archiving the frozen original receipt and using a separate log namespace; never carry the original 17-head test counts into a 25-head validation claim.
- Keep PR discovery capped at the authorized batch while new lanes are dispatched; optional later lanes need an explicit scope update before local integration.
- Second Pullfrog regression: metadata-sensitive values refreshed search but cleared selection on the highlighted record. Reproduced zero selected rows for live selected-chat title, timestamp, and model-provider label updates. Use controlled selection reconciled through the stable record ID and require Enter activation without recovery arrows.
- Pullfrog exposed a timer-only deadline blind spot: synchronous encoding prevents timeout callbacks from running. Added monotonic pre-dispatch expiry checks and deterministic tests that advance elapsed time without running timers.
- 2026-09-19 lane26: Fresh worktree omits ignored `.memory` and dependencies; read canonical project memory, installed lockfile dependencies. Electron postinstall omitted macOS payload; restoring with its install script before isolated E2E.
- 2026-09-19 lane26: Minimum-width Electron resize correctly collapses the sidebar persistently; restore it through Show sidebar before continuing the existing browser scenario into Settings. Initial extended run passed new overlap checks but failed that later navigation.
## 2026-09-19 — Upgrade lane 27 journal

- Fresh worktree has no dependencies or ignored `.memory` notes; installing locked dependencies locally and reading lane 23 diagnostics context from its existing worktree before editing.
# Upgrade 28 catalog refresh

- Fresh worktree omits ignored `.memory` and dependencies; read canonical project notes and auth-lane note, and reused the matching installed dependency tree for focused checks.
- Scoped-refresh comment still cites Pi 0.80; pinned 0.84.4 supports provider filters, but its native refresh also resolves/rotates OAuth credentials, unlike Aiden's explicitly non-mutating scoped path.

- Initial local note creation replaced tracked troubleshooting history; diff review caught it immediately and restored the original history before appending this lane.
- Node runtime supports Promise.withResolvers, but repository TypeScript target does not; synthetic gates use a compatible deferred helper.
## 2026-09-19 — Telegram HTML chunks (lane 29)
- Fresh worktree has no dependencies or local `.memory`; read canonical project Telegram history, install lockfile dependencies with lifecycle scripts disabled for pure service tests.
- Repository ignore rules reject staging the required campaign memory/papercut notes; add only the two explicit documentation paths with `git add -f`.
- Review follow-up: raw code-point safety still splits combining/ZWJ graphemes; segment only the bounded decoded chunk plus one code point, with explicit oversized-grapheme progress coverage. Reviewer task is a multi-agent subagent, so app-server direct messages are rejected; route updates through the campaign root.
- Clock-ordering expiry regressions advance the injected clock in a second-connection transaction that commits before the target BEGIN. This tests post-admission timestamp sampling, not an actually blocked SQLite lock wait.

## 2026-09-19 — Integration wave 3 palette failure
- Strict combined Electron validation exposed an intermittent model-provider filter result: 0 rows instead of 2. Three unchanged isolated repeats produced two passes and one failure; retain the failed status instead of treating retries as a clean result.
- Playwright clears its output directory on a new invocation. Copy screenshots, traces and error context into the batch log directory before reproducing a failure.
- Pullfrog follow-up: Electron 43 posts native crash notifications asynchronously and omits document identity. Added a real renderer-crash probe that holds notification delivery across pending/committed replacement navigation, instead of relying solely on synthetic crash events.
- 2026-09-19 lane 21 review: Terminal subscribers remain registered until drain; aggregate eviction must account for pending delivery, not just terminal generation state. Added cross-stream pressure/drain/deadline regressions.

- Integration review found `deleteAllDiagnosticData` repeats live journal removal after its queue barrier; add support-level coverage and leave active journal cleanup with its owner while retaining inactive/legacy allowlist cleanup.
- Lane 30 export investigation: fresh worktree omits ignored `.memory` and dependencies. Read the canonical checkout's relevant project context and reuse its installed dependencies through a worktree-local symlink for scoped checks.
- Lane 30: artifact-descriptor budget omission is bounded in normal operation by the upstream 40-artifact/chat limit; rejected the artificial large-metadata candidate. Linux filename probe over the configured bitcreate.cloud SSH host could not authenticate; no credentials or settings changed.
- Lane 30: reusing canonical dependencies exposed `thinking-orbs` 0.1.1 against this worktree's locked 0.3.1, yielding three unrelated orb-state type errors on both baseline and patched source. Replaced only this worktree's dependency symlink with a lockfile-local installation; canonical dependencies remain untouched.

- Integration wave4 status schema: lane31 represented its PR as an integer, unlike prior URL entries. Normalize both forms in the validation helper; exact fetched-head verification remains required.

- Review exposed fatal reset bypassing an earlier queued snapshot. Fatal writes, reset, retention and bounded snapshot reads must all finish synchronously at admission; queue only general-file work and immutable fatal snapshot publication.
## 2026-09-19 — Lane 31 tool approval
- Fresh worktree omits ignored `.memory` and dependencies; consulted primary checkout project memory and will reuse matching installed dependencies for scoped verification.
- Initial broad search used a nonexistent `main/ipc*` glob; switched to actual `main/handlers` paths.
- Extended broker checks initially lacked the native file-mutator helper; built it with the repository script, then all 45 checks passed.
- Reusing primary checkout dependencies exposed thinking-orbs 0.1.1 versus locked 0.3.1 and unrelated OrbState type failures; installing this worktree lockfile independently.
### 2026-09-19 — Upgrade lane 32 notifications
- Fresh detached worktree omits ignored `.memory` and `node_modules`; read canonical project memory and linked the existing matching dependency installation without changing it.
- No execution test seam existed for scheduled notification failures. The existing registered notification suite now bundles the real execution module with synthetic service ports, avoiding Electron, scripts, network and user data.
- Shared checkout dependencies were stale (`thinking-orbs` 0.1.1 vs locked 0.3.1), causing unrelated OrbState type errors. Replaced only this worktree's dependency symlink with an isolated `npm ci --ignore-scripts`; shared installation remains untouched.
# Upgrade lane 33

- Fresh worktree omits ignored `.memory/`; read canonical checkout project context and keep a unique lane note here. Dependencies also absent; installing lockfile dependencies before real watcher regressions.
- Real fs baseline reproduced two disposal failures; pre-existing warm-cache immediate-write test also timed out once. Stabilize its setup boundary so queued creation events cannot masquerade as the edit under test. Directory replacement already works on this macOS host; do not generalize inode-watcher assumptions into speculative code.
- Git rejects staging the ignored `.papercuts` path with ordinary add in this worktree; force-add the explicit note path together with the required unique `.memory` note.
- Third Pullfrog regression: an unmatched static root selection survived direct submode entry. Render and reconcile all selectable static and dynamic rows from complete mode inventories, including disabled and force-mounted retry controls.
- Integration palette flake reproduced deterministically: providers resolved before settings, but the model memo omitted settings readiness and stayed empty when hidden-model preferences remained undefined. Include settings data in the memo dependencies and gate settings delivery in an Electron regression.

- PR168 review proved admitted obsolete durable writes can return through Radius offline startup hydration; reproduce with real DataStore restart and pinned Radius before replacing the documented limitation with serialized retirement.
- 2026-09-19 lane 21 follow-up: Byte-budget trimming can leave the stream registry full after delivery ends; deferred eviction must release count capacity at subscriber settlement without waiting for another append.
- Lane 33 review: callback counts alone cannot prove which filesystem mutation was observed or whether a suppressed watcher was closed. Correlate observed content, stage outside the watched directory, and assert actual native close plus its close event; validate with omitted-close/missed-edit mutants.
- Lane checkout had been removed between review turns; recreated the existing branch worktree at its original path before continuing.
- Pullfrog run-slot finding reproduced for stale arrival and deferred lookup. Reclaiming stale preparation also exposes delayed workspace cancellation by task ID; fence cancellation by the exact state object to protect replacement execution.
# Lane 34 iOS state

- Worktree has no tracked `.memory/`; read the shared checkout's project context and will add a unique lane note.
- Physical-device XCTest would install the app, which this campaign prohibits; use unsigned generic build-for-testing plus a host Swift probe, and report execution limits explicitly.
## 2026-09-19 — Android draft recovery lane 35
- Fresh isolated checkout has no tracked `.memory/` directory or Android-specific AGENTS.md; read canonical project memory and root/native guidance, then add a unique lane note.
- Failed-send restoration bypasses `updateDraft`, so visible recovery never reaches the draft file. Use real ViewModel/HTTP regression and reopen the store to distinguish memory from persistence.
- Regression harness initially used `sendMessage`; Android exposes the action as `send`. Corrected the test entry point before collecting baseline behavior.
- `.memory/` and `.papercuts/` are ignored by default; explicit force-add is needed for the authorized lane note and troubleshooting update.
- 2026-09-19 lane 21 replay review: Socket teardown does not establish terminal delivery; reserve capacity reclamation for response finish. Abort/timeout must preserve replay despite renewed pressure, with count/byte/retention bounds.
- Lane 33 causal review: fs.watch offers no operation identity; even callback-time content plus a quiet interval can misattribute delayed events. Use controlled delivery of the real listener for causal assertions and limit native-filesystem tests to smoke/continuity claims.
- Independent review found expected automatic/manual overlap is still classified as failure. Reproduced real Cron error publication and startup rejection; distinguish a typed automatic skip from genuine executor errors, including identical error text.
- Base ESLint no-redeclare rejects TypeScript overload declarations; dispatch now returns an explicit admission outcome with a separate completion promise, avoiding overloads and error-string classification.

- PR168 Luna re-review found production full Settings/command refresh still delegated to Pi without account ownership checks; expand the real-wrapper regressions to full refresh, trace startup separately, and preserve native OAuth resolution through a public SDK refresh context.
- Shared auth-lane dependency directory was removed; installed this worktree lockfile with npm ci --ignore-scripts before revalidation.
- Unified refresh supersession exposed overlay coalescing that joined an already-aborted request; a deferred fetch regression proves it. Retain the active request signal and only join live work.
- Luna follow-up reproduced a current-renderer crash during the initial held main-frame response: native loading stays true after process death. Subsequent navigation supplies a complementary recovery control. Replaced the broad loading guard with native crash state captured when navigation begins; active main-frame recreation/commit reset that ownership marker.
- Initial-before-commit renderer crashes reject Playwright's guest-target initialization even when driven from Electron's main process. Kept zero-history native coverage in a standalone Electron child, discovered by the ordinary E2E script. Its ESM entry must schedule `app.whenReady().then(...)`, not top-level-await readiness (which blocks Electron startup).
- The native probe bundle needs Electron explicitly external and no inherited wildcard TS paths. Generate its temporary module under ignored `build/` and remove it afterward, so lint never scans generated test artifacts.
- Forced retry rows bypass cmdk registration/filtering; treating forceMount as an unconditional match retained a retry after the query changed to Refresh. Audit ordinary-match precedence separately from fallback visibility, including error, loading, and disabled controls.
- Actual error-state reproduction: a simple Retry-to-Refresh query edit self-corrected through cmdk scheduling, but after a failed in-flight refresh became enabled again with the same query, retry stayed selected indefinitely. Regression requires ordinary selection and Enter activation after re-enable; ordinary matches must outrank forced fallbacks on state changes too.
- Loading-state Electron fixtures cannot await the composer while holding initial chat/provider IPC reads; the composer depends on them. Wait for the shell Settings control before opening the palette during a pending read.
- Initial provider loading gates the whole shell (unlike pending chats). Model retry tests must let the provider query reach its error state before opening the palette; loading exclusion is exercised through chats and the shared contract matrix.
- ASCII no-match sentinels can fuzzily match the concatenated model inventory of an unavailable provider. Error-recovery tests use an emoji absent from fixture metadata to guarantee no ordinary search match.

- Fresh PR168 review found write rejection after rename skips retirement. Reproduce commit-then-reject, deletion failure, fallback durability rejection, and queued publisher/restart outcomes; preserve original failure evidence.
- Repository TypeScript lib predates AggregateError/Error.cause; retain original plus cleanup failures in a small compatible CatalogPublicationError rather than widening compiler targets.

- Lane 34 review exposed a text-only restoration fence gap: attachment admission/removal/send can leave text unchanged. Expanded the existing held-read fixture to hold upload/turn responses and cover these actual view-model actions without physical installation.
### 2026-09-19 — lane36 startup deadline fixture
- Isolated worktree omits ignored `.memory`; read canonical project context/history without editing that checkout and keep lane notes locally.
- Baseline startup deadline test depends on a child-owned log that may never initialize before termination; replace cleanup evidence with parent-observed real children and control the deadline phase.
- Explicit `git add` of the tracked troubleshooting file is rejected because its parent directory is ignored; stage its tracked update with `git add -u`.
- Lane 37: isolated checkout omits ignored `.memory/` and dependencies; read project memory from the saved repository and install this checkout with `npm ci` before validation.

- Integration lane37: test and coverage registration shared long-line conflicts. Preserved all existing script tokens and dependency fields, adding only the new profile-share test once per affected script; merged independent troubleshooting histories.
- 2026-09-19 lane38: isolated checkout lacks `.memory` and dependencies; read canonical checkout memory and installed this worktree with `npm ci`. Type-check targets pre-ES2022 libs, so test helpers must avoid `Array.at` / `Object.hasOwn` even though the host Node supports them. Linux regression fixtures must assert discovery before launching, otherwise the unfixed macOS service can open an actual installed Mac editor.
- Luna79da0580 review identified destructive retirement after known pre-publication failures. Add actual DataStore size/pre-rename/post-rename controls and carry an explicit publication receipt instead of guessing from a generic rejected promise.

- Pullfrog f62 review found initial credential read errors masked as supersession; test actual Radius full/offline phases against missing-credential controls. A separate custom AuthContext report has no current production caller; verify default env/file resolution before choosing scope.
# Lane 39
- Fresh worktree has no ignored `.memory/`; read primary project context for persistence/lifecycle before changes.
- Fresh worktree has no dependencies; install own lockfile dependencies for isolated validation.
- esbuild stdin requires explicit TypeScript loader even with a .ts sourcefile; corrected native harness builder after initial parse failure.
- Native harness cleanup raced Chromium Session Storage teardown; moved temporary-directory cleanup to the parent after Electron exits.
- Initial papercut write replaced a tracked history file; restored original contents before appending this lane.

- Lane 34 picker follow-up: view-local photo/file conversion happened before model upload ownership. Moved the shared preparation lifetime to the model and expanded proof to the actual picker callback plus held transfer, including cancellation ownership and Send blocking.

- Independent review confirmed custom-context helper compatibility (not a production outage). Root authorized an explicit shared AuthContext option; parity tests avoid private SDK state and keep registry defaults unchanged.
- Failed-navigation probe: HTTP 204 ends navigation through native `did-stop-loading` without `did-fail-load`; a connection reset instead commits a live error page and emits `did-fail-load`. Observe both terminal paths and native renderer state before assigning crash ownership. The first 204 failure-event assertion was invalid and is not product regression evidence.
- A native current crash during a held subsequent response emits `did-stop-loading` before `isCrashed()` reflects death. Clearing the target synchronously regresses recovery to the old page. The pinned native process handle is cleared before observer delivery, so require a nonzero `getOSProcessId()` synchronously instead of relying on a deferred callback; keep held-response and zero-history cases as controls.

- Integration browser validation recorded a6.7h runtime gap: Electron launched in1s, firstWindowwait lasted24,131,892ms despite30s timeout, failing fixture setup before assertions. Original15pass/1fail trace retained; one unchanged fresh strict16-case run passed in1.7m. No timeout or product edit; exact gap cause unproven.

- 2026-09-19 lane38 review: Zed's documented Linux binary can be `zeditor`; resolve aliases inside each PATH directory so aliases do not override user PATH precedence. Cursor's agent installation docs do not define desktop editor routing, and vendor support reports both version-dependent `--classic` support and Linux AppImage launchers ignoring it; keep Cursor outside this new Linux support instead of guessing flags/version thresholds.
- 2026-09-19 closeout: macOS native fullscreen minimize emitted no minimize event within the probe deadline. Retained timeout evidence; separate event-model regression and passing ordinary native lifecycle coverage instead of claiming native reproduction.
## Lane 40 Environment focus

- Fresh isolated worktree omits ignored `.memory/` and dependencies; read canonical project memory and install worktree-local dependencies without touching primary checkout.
- Held Git IPC test must dismiss the modal branch picker before querying Quick View controls, and release the gate in `finally` to avoid teardown shutdown timeouts.
- Radix close autofocus runs after a timeout: checking destination availability after canceling autofocus loses fallback focus. A still-connected but inert Quick View trigger is also unusable; preserve newer focus or use the app root when abandoning the handoff.
- 2026-09-19 lane41: Fresh baseline worktree has no .memory directory or node_modules; read primary-checkout project notes and install isolated dependencies before Electron validation.

- 2026-09-19 lane41: Sidebar state assertions must locate Settings navigation with includeHidden:true; ordinary role queries intentionally stop matching after aria-hidden collapse. Initial strict repeats failed at this locator and were not accepted as product regressions.
- Closeout review: a healthy WebContents-wide loading stop still lacks main-frame navigation ownership. Electron43 does not emit a provisional failure for HTTP204; a native probe observes ERR_FAILED loadURL rejection and later request completion. Use request-id-scoped no-document headers/errors and navigation generation rather than another loading-state or timer heuristic; preserve the existing session header-auth callback.
- Final local-abort coverage must await the guest's committed URL before looking up its WebContents: browser `create` returns while the initial navigation is still pending. The first probe failed at guest lookup, before exercising either abort; corrected the fixture's readiness boundary.
- Exact-be7 local-abort control: timeout case demonstrably reloads the abandoned URL. The expired-preview control instead lost its Electron application, so that run is retained as inconclusive rather than counted as product regression evidence; the corrected two-case run passes.

- 2026-09-19 PR167 closeout: original637b worktree was absent and no longer registered (cause unknown); recovered existing branch at exacta4c9447f into `/tmp/aiden-pr167-closeout`, preserving all other worktrees. Used existing locked dependencies read-only for focused validation; no install or dependency mutation. Prior parsed-text-only stress checks missed Telegram's separate32KiB raw UTF-8 input cap; primaryserver source and converter regression now cover it.

- PR167 final hosted review found first-grapheme byte seams and formatted bare-link equality were missing from the earlier stress matrix; exactc37 red cases now cover both, including a formatted grapheme exactly at the byte cap and equivalent numeric/named entities.
- Final Pullfrog ownership boundary: a command without its own native start can time out after a newer same-URL or different-URL load starts. The old +1 generation allowance stops that newer load. Native regressions must delay the command start, retain the newer held response, then crash its actual renderer; URL matching cannot prove command ownership.
- Native controls reject a synchronous-start ownership shortcut: direct, redirected, and beforeunload loads all emit their start after loadURL returns. Use explicit command intent invalidated by renderer/user/popup entry paths; native request-count fixtures must exclude favicon requests.
- Replace the new native fixtures' 500ms deadlines with controlled command deadlines released after HTTP admission. Otherwise slow CI can fail an ownership assertion before Chromium starts the request.

# Agent CLI PATH diagnosis (2026-09-21)

- The warning lived in a chat transcript, not the structured app log; inspect both when a user quotes agent output as a log.
- zsh's unmatched globs aborted broad source searches; use `rg --glob` for optional file patterns.
- Fresh-worktree Git cleanup tests require the native remover; its build script pins a minimal environment, and this host's default Command Line Tools SDK has an incompatible `arm64e.x1` stub. An explicit Xcode `-isysroot` compiles the helper, but the script still fails until that SDK selection is repaired.
- `.memory/` ignores new files; append this work's context to a tracked memory note so it reaches the PR.
- `git add` rejected paths inside ignored `.memory/` and `.papercuts/` even though their files are tracked; use `git add -u` for those updates.
- A PATH regression test using `gh` can resolve a host-installed binary first; give fixture executables unique generated names to keep CLI lookup tests portable.
- 2026-09-21 PR #206 review: project instructions require friction in this tracked troubleshooting file. A separate lane note was easy to overlook; duplicate the native SDK/pretest limitation here and test the runner's four-note eviction plus 8,000-character projection at the event boundary.
- `test:subagents` native pretest selects a Command Line Tools macOS 27 SDK that Xcode 26.6 cannot link; the build script replaces its child environment, so an outer SDK pin is ineffective. Focused TypeScript, mobile consumer, type-check, and lint validation remain separate from this native gate.
- 2026-09-21 PR #206 Pullfrog review caught an omitted-provenance edge case: four retained short notes can be under the character cap after a fifth note is evicted. Track count eviction separately from character truncation and test both boundaries.
- Lane form-fill-specialist: pure `-core.ts` modules cannot own electron-bound singletons — `FormFillArtifactStore` constructor deps like `onStatusChanged` must be wired in a thin electron-importing shim (`artifacts.ts`), not the testable core.
- Approval row deselection travels the decision-payload path (`approvals.decide` → `takeDecisionPayload` in `beforeToolCall`), never tool arguments; validate each option field at the `chat:approve` IPC edge (`Number.isSafeInteger` predicates) rather than passing `unknown` through.
- `ipc-contract.test.ts` scans `main/**/*.ts` automatically: handlers must use literal channel strings and `ipcMain.broadcast` for contract coverage; no manual registry edits.
- The form-fill review card IS the approval surface: `approvalFor` extracts, captures, scores, and mints the plan digest in one step so the approved digest covers exactly what the user saw. Splitting planning from minting breaks that invariant.

- PR #198 picker review: the isolated worktree lacks the ignored `.memory/` notes, so read the primary checkout's project context before editing. Xcode 26.6 emitted DeviceSupport lookup and post-test CoreDevice diagnostics warnings for the physical iPhone 16 Pro Max; both signed XCTest runs passed, so use the result bundles rather than diagnostics warnings to determine test status.
- PR #198 hosted review: Greptile applied the Electron-only squircle control rule to native SwiftUI camera buttons. The cited design guide names `renderer/components/ui.tsx` and CSS tokens; verify platform scope against `ios/AGENTS.md` and the approved native picker visuals before restyling.
- PR #198 validation: repeated full iPhone runs intermittently failed two ActivityKit persistence tests and one snapshot window-scene precondition; all three passed immediately in an isolated physical-device rerun. Keep the failed `.xcresult` evidence and distinguish host/order instability from the focused picker regressions.
- PR #198 follow-up: Pullfrog found a degraded PhotoKit callback could also carry cancellation or error; check terminal flags before discarding previews, and test the picker result-application seam rather than its generation helper alone.
- PR #198 hosted E2E reached test 103/103 but GitHub canceled the 30-minute job before its last test/report completed. Increase this job's bound to 45 minutes without reducing coverage; keep CI runner-time cost visible.
## 2026-09-21: Issues 202 and 201

- 2026-09-21: OpenCode Workers doctor passed, but the worker exited immediately because its launcher sends `--dir` to `opencode run` v2.0.3, which rejects that flag. Use a direct CLI review until the wrapper is updated.
- 2026-09-21: Fresh isolated worktree lacked `node_modules`; installed with `npm ci` before validation.
- 2026-09-21: `npm run test:subagents` pretest stops in native worktree-remover linking: CLT's `MacOSX.sdk` targets 27.0 and libSystem.tbd declares unsupported `arm64e.x1`. The build script supplies a restricted environment, so setting SDKROOT externally does not select Xcode's SDK. Run focused TS tests independently; full native gate remains unverified.


- 2026-09-21 revisit controls: fresh worktree lacked installed dependencies, so the first focused run failed loading `entities` and `react` before those suites executed; install from the lockfile before treating the suite as product evidence. OpenCode lists DeepSeek V4 Flash but no exact 4.1 Flash model identifier.
- Local `xcrun` resolves the CommandLineTools macOS 27 SDK despite Xcode 26.6's selected developer path; native helper linking rejects `arm64e.x1`. The native build scripts intentionally replace the child environment, so a command-scoped `SDKROOT` pin does not propagate. Build the ignored helper binaries directly with the installed Xcode 26.5 SDK for local E2E without changing shipped build scripts.
- Held-response E2E sidebar title remains the user prompt until completion; selecting by the completed response text timed out before exercising the revisit. The first live steer test then exposed a real stuck “Stopping…” pane flag after detached settlement; release that flag before queue delivery resumes.
- OpenCode Workers doctor passed, but the worker launcher failed before model execution: it supplied `opencode run --dir`, which its OpenCode v2.0.3 rejects as an unrecognized flag. The shell's separate OpenCode v1.18.5 CLI ran the same DeepSeek V4 Flash review directly in the plugin-created isolated worktree, read-only; it reported no findings.
- PR208 terminal-handoff follow-up: an initial regression assertion used `Array.at`, but this project's TS target does not include it. Use length-based indexing in focused tests and rerun type-check before pushing.
- PR208 follow-up: guarding controls with the cached assistant tail exposed an earlier transcript-read race. Cancel exact-chat in-flight reads before publishing a durable append, then hold and release an old assistant read in a focused regression to verify it cannot overwrite the new user turn.
- PR208 hosted verify: the narrow chat suite passed locally, but the full JS suite caught a stale Environment/Subagents source assertion against the old readiness expression. Update cross-component source contracts when moving transcript guards and run the broader test inventory.

- 2026-09-20 worktree lifecycle: `git show-ref --verify --hash <ref>` exits 128 ("not a valid ref") for a missing ref on git 2.55 — not exit 1. For exists-or-undefined branch/ref probes use `git for-each-ref --count=1 --format=%(objectname) <ref>`, which exits 0 with empty output.
- 2026-09-20 worktree lifecycle: the managed-worktree remover helper builds only on macOS (`build/native/aiden-worktree-remover` is absent on Linux), so git.test.ts cases that reach the real remover fail with `io_failed` on this platform. That is a baseline limitation, not a regression — verify against a stashed baseline before assuming a change broke them.
- 2026-09-20 worktree lifecycle: `git status --porcelain` v1's leading column space is load-bearing (`M ` staged vs ` M` unstaged); trimming stdout erases it. Use `--porcelain=v2 -z` and parse `1 .M`-style records for staged/unstaged assertions.
- 2026-09-20 worktree lifecycle: `captureProvisionedFile` writes `files/<sha256>` blobs and requires the `files/` directory to exist under the snapshot dir first — create it when provisioning the snapshot directory.
- 2026-09-20 worktree lifecycle: containment checks that compare `fs.realpath(root)` against `path.resolve(target)` reject legitimate paths on macOS because `/var` resolves to `/private/var`. Canonicalize not-yet-created targets through their parent realpath + basename (and join provisioned destinations under the canonical worktree) instead of string-prefixing raw paths.
- 2026-09-21 worktree lifecycle review fixes: Pullfrog's three remaining findings were (1) `restore.json` published before its bytes were written, (2) the application-service advisory ignored-path expansion running before the `options.force` branch, and (3) Git-object capacity admission probing `managed.repositoryPath` instead of the object store. The fix publishes the first journal through a temporary file plus `link` (keeping the EEXIST first-writer claim), skips the advisory expansion when force is explicit, and admits object bytes against `repositoryPaths(...).commonDir`.

- 2026-09-21 PR #185 Greptile findings: Greptile's first review of this PR returned 2/5 with four findings — (1) safe deletion never re-verified that `refs/aiden/snapshots/<id>` still described the captured tree, so a vanished anchor let an unrestorable deletion proceed; (2) `restoreProvisionedFiles` removed the inflight temp and read/chmodded an existing destination before its only realpath containment check, so a snapshot-materialized symlink ancestor could redirect those operations outside the worktree; (3) the provisioner verified the source identity and then copied by pathname, leaving a swap-and-restore TOCTOU; (4) a failed manifest publication left the synthetic ref and private blobs behind. Fixes: verify the anchor tree at admission and again at the destructive boundary, verify containment before every mutation (nearest existing ancestor, then the canonical parent after mkdir), open the source with `O_NOFOLLOW` and read through that descriptor, and roll back the ref plus the snapshot directory when manifest persistence fails. The (3) race window is not deterministically reproducible in a test; the other three carry regressions that fail against the previous behavior.

- 2026-09-21 #185 native file helper: `xcrun clang` selected the malformed CLT macOS 27 SDK (`unknown architecture arm64e.x1`) despite `xcode-select` pointing at Xcode. Passing `--sdk macosx` to xcrun selected the full Xcode SDK and fixed the local build; plain xcrun selected CLT.
- 2026-09-21 #185 validation: running `git.test.ts` before building `aiden-worktree-remover` produced 16 helper-launch failures that resembled deletion regressions. Building the helper with explicit `xcrun --sdk macosx` made all 99 Git tests pass.
## 2026-09-21: Issue 201
- OpenCode Workers doctor passed, but the second worker also exited before editing: its launcher sent an unsupported `--dir` flag to `opencode run` v2.0.3. Use the direct CLI for requested review.
- The Bot home has two persisted incarnation copies. Accepting a remount requires keeping receipt and manifest exactly consistent while comparing each to the live home under the owned-volume check.
- `npm run test:bots` stops before tests because the native inbox writer links against the CLT macOS 27 SDK with unsupported `arm64e.x1`; `npm --ignore-scripts run test:bots` passes 446 TypeScript tests, but native-helper-dependent pretests remain unverified.
- Deep OpenCode review exposed the receipt-written/manifest-unpublished crash window after remount: publishing the live device would disagree with the old receipt. Preserve the receipt token in the durable manifest and return a separately re-inspected live token.
- PR #209 review: Pullfrog required either a remount-stable volume identity or an explicitly documented, tested trust assumption. Node's `fs.statfs` exposes no `f_fsid`, so a real volume identity needs a native probe or a `diskutil` subprocess; the documented assumption is the patch-release choice, so the accepted substituted-volume case and the checks that still fail closed are now stated in `sameHomeByInode` and named in the remount regression.

## 2026-09-21 — CI refresh
- Reconciled PR #139 with current main in a new worktree; stale registry lacks newly shipped regression files and the worktree file-I/O helper prerequisite.
- Removed the draft release-admission rewrite from this CI optimization scope to avoid overlapping the active release-hardening work.
- Local full validation hits the existing CLT MacOSX27 SDK / linker architecture mismatch in the bot inbox writer build. TypeScript/lint and CI-policy tests pass; use pinned Xcode 26.6 hosted native/Electron validation without changing global developer-tool selection.
- Adversarial review: added full-validation fallback for empty diffs, restricted documentation skips to prose extensions, and checked non-file execution modes/build prerequisites so registry coverage cannot silently lose Rust, browser, coverage, Ruby or native work.
- Greptile caught iOS-only selection omitting shipping/TestFlight policies held by a desktop lane. Added conditional Node/install/policy steps to the selected iOS job and an invariant test; full runs keep the existing single preserved policy execution.

## 2026-09-21 — 0.42.2 release gates

- Hosted CI run 35643207134 marked `chat-message-queue` flaky because its first attempt read `settings.json` before that file existed (ENOENT); the retry passed. Poll for the file's first durable write, retrying only ENOENT.
- The `setsid` fixture wrote its PID from the detached grandchild after scheduling; publish it from the intermediate process, allow a bounded 20s wait under CI load, and arrange cleanup even when the test assertion fails.
- Local shell-runner native builds selected the incompatible CLT macOS 27 SDK unless `xcrun --sdk macosx` was explicit.
- Local focused Electron repetition launched but every test exited before `firstWindow` on this host; the installed production Aiden was left running. Treat this as a host launch blocker and rely on exact-head hosted E2E for the gate fix; do not attribute it to the queue assertion.
- Post-#185 main CI 35669501413 hit a new `--fail-on-flaky-tests` browser-lifecycle retry: the replacement page title was visible while `isLoadingMainFrame()` was still true. Wait for both the title and main-frame completion before delivering the queued stale-crash notification.

## MCP resources — 2026-09-22
SDK UriTemplate.variableNames preserves duplicates: deduplicate before exact input-key validation. resources/read content URIs may differ from the requested URI; bound/project as data without minting handles. Cache only successful inventory or clear the same failed discovery promise so cancellation does not poison later calls.

## 2026-09-23 — shell helper early-exit stdin error

- Workspace identity validation may exit before reading the control frame. A child-process error listener does not catch stdin EPIPE: install a stdin listener before writing, record transport failure, close control, and still await close/watchdog before rejecting. Keep write inside try/finally so synchronous failure also cleans timers/abort listeners/streams. Retain an error listener through stream destruction for late events.

- Child `close` is not stdin write settlement. Await the write callback alongside helper close before decoding a valid frame; retain the independent error listener and bound a missing callback with the existing watchdog. Test close-first with valid response bytes and late callback/stream failure.
## 2026-09-23 — Git cancellation fixture handshakes

- A three-second marker poll can expire before the intended cancellation window begins. Wait for the actual marker with the existing bounded helper, and abort/drain the outstanding operation before removing its temporary repository.
- A 1200ms post-marker exit timer can race a delayed test process and set upstream before abort. Use a bounded release-file handshake; abort before release and always release/drain in finally. Controlled pre-push and post-marker delays reproduce each separate race.
- Fresh worktrees need `npm run build:worktree-remover` and `npm run build:worktree-file-io` before invoking the Git test file directly; the normal pretest script supplies these prerequisites.
## 2026-09-22 — setsid fixture readiness race

- A PID published by the intermediate process is still insufficient if the first parent exits before that process reaches setsid: production group cleanup can kill it. A controlled one-second pre-detachment delay reproduces the missing-marker failure. Synchronize first-parent exit with a bounded pipe acknowledgment after marker publication; keep the production cleanup, detached-child alarm, and test liveness assertions intact.
- Build native test helpers before standalone shell tests; otherwise ENOENT is only a missing prerequisite, not a valid reproduction.

- Fixture timeout cleanup cannot rely on group/direct signal ordering across setsid+fork. A parent-owned grant pipe makes persistence conditional on success, and EOF closes the late-fork race. Test absent-readiness-marker cleanup using a separate PID witness; mark ESRCH cleanup complete so an after-hook cannot signal a reused PID.
## 2026-09-22 Telegram run-control audit

- Task began on stale release 0.42.0 checkout; fetched main c8c09e0d2 before work.
- Initial workspace sandbox blocked shared Git metadata and tsx IPC socket. Used
  required approval path; later task permissions changed to full access/never.
- Plain bridge stop() intentionally lets already admitted work settle; shutdown
  stopAndSettle() and user Stop cancel dispatch preparation. Keep tests distinct.
- Pi harness queueSteer is not a public foreground input API: host transcript
  projection and exact-run admission must be implemented before native controls.
## 2026-09-22 — attachment lifecycle worktree validation

- Reusing the coordinator checkout's node_modules produced unrelated Live orb type errors because thinking-orbs was 0.1.1 while fresh main locks 0.3.1. Install this worktree's lockfile before claiming type-check results.
- The local Codex and T3 source clones predate the cited September research. Verify upstream PR/files directly before concluding the research applies to Aiden's current implementation.
- Full hosted verification also runs the subagent deletion source-contract test; expanding its one-line admission-release statement requires updating the literal matcher to preserve both release-order assertions.
## 2026-09-22 MCP session scope reconciliation

The earlier skill slice covered model-context body loading, not lazy filesystem reads or request-boundary instruction refresh. Audit exact production calls rather than assuming available SDK methods or Pi hooks are wired: main has no resource/getInstructions/AGENTS loader path. Keep metadata-only status separate from runtime authority changes, and preserve the green skill branch in a new worktree.
## 2026-09-22 skill invocation policy validation

- Isolated worktree Git metadata lives outside the writable sandbox; branch creation needed the existing git-switch escalation. tsx CLI also needs local socket permission.
- Native validation needs explicit local SDK paths: `ANDROID_HOME=/Users/sambitbiswas/Library/Android/sdk`, Android Studio JBR, and `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer`. System xcode-select points at CommandLineTools; do not change it globally. Coordinate the physical iPhone slot with the upgrade coordinator.
## 2026-09-22 MCP guidance test compatibility

The repository TypeScript library target does not include Array.at; use slice(-1)[0] in fixtures without raising the target. Onboarding's source fixture is already loaded with readFileSync; reuse it for copy assertions instead of adding an unimported async reader. These test-only errors were corrected before commit.
## 2026-09-22 — Pi budget and recovery audit

- Worktree Git metadata lives outside its writable root; fetch/branch operations needed ordinary sandbox escalation. The `tsx` CLI also needs its temporary IPC socket, so `npm run test:compaction` needed escalation after EPERM. Locked `npm ci --ignore-scripts` and direct `node --import tsx` focused tests worked in the sandbox.
- A startup race fixture initially intercepted `DataStore.load`, which is also called internally during normal store operations and deadlocked the fixture. Intercept the startup-only corruption check instead to hold a second recovery sweep deterministically.
- Model ownership must gate usage counters, not transient retry/reset handling. Independent review caught that coupling; preserve provider retries even when a response reports a model alias.

- PR #215 hosted review: resetting an initialization promise does not clear DataStore corruption/unsupported-shape quarantine. Keep that authority fence, explicitly limit retry to transient recovery failures, and test operator repair with a fresh owner as well as actual durable-write failure.
## 2026-09-22 — Small-context semantic budgets

- Default Pi reserve/tail values can exceed a custom model window even though generation preflight is safe. Apply the already-used VCC bounds only to infeasible pairs; keep feasible and exact-fit defaults.
- A retained-tail regression using one enormous first user entry cannot prove target-budget enforcement: Pi deliberately retains whole cut-point groups. Use several complete turns to prove prefix reduction without changing upstream pairing/cut semantics.
- The child compatibility test expected a needless final compaction checkpoint after active-output projection. Update it to assert exactly two provider requests and no checkpoint, preserving bounded output before the second inference.

- PR #228 review exposed fake-provider summary fixtures exceeding their own windows. Capacity preflight must inspect Pi's assembled hidden prompt, not just retained-tail budgets. Calibrate fixture window/usage together; do not weaken the fence to preserve impossible mock requests. Pi's char/4 estimate also undercounts Unicode, so the summary fence adds UTF-8 allowance and documents its remaining heuristic limit.

## 2026-09-22 — durable tool outputs

- Fresh isolated worktree lacked node_modules; installed locked dependencies with npm ci --ignore-scripts before meaningful TypeScript checks. tsx requires its local pipe outside this task’s workspace sandbox.
- Gradle requires the existing user cache and ANDROID_HOME=/Users/sambitbiswas/Library/Android/sdk; default Xcode selection points to CLT, so use DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer.
- Physical iPhone tests are queued through the coordinator: device is locked; do not retry or use prohibited simulators. Unsigned generic iOS build succeeds but is not device execution evidence.
- Canonical /private/var vs lexical /var paths caused valid new-file provenance to be discarded. Resolve the parent directory before forming the relative path; normalize Windows separators.
## 2026-09-22 — chat state wireframe review
- Browser automation blocked the local Downloads `file://` preview (request-header error, then explicit URL-policy block). Do not retry through another browser surface; validate syntax and leave visual review to the user.
- OpenCode lists `opencode-go/deepseek-v4-flash` but no exact `v4.1-flash` model; label the available V4 Flash substitution.
- OpenCode Workers launched two isolated worktrees but failed on unsupported `opencode run --dir` in v2.0.3. Direct CLI review from each worktree worked; use the absolute NVM v2 binary because a worktree shell resolves Homebrew OpenCode v1.18.5 first.

## 2026-09-22 — chronological chat motion
- Fresh Aiden worktrees need `npm ci` before `npm run type-check`; the dependency install completed locally.
- Android Gradle needed both Android Studio's JBR as `JAVA_HOME` and `~/Library/Android/sdk` as `ANDROID_HOME` in this shell.
- `npm run build` reached the Bot inbox native helper, where plain `/usr/bin/xcrun clang` selected the malformed CLT macOS 27 SDK (`arm64e.x1`). Setting `SDKROOT` alone did not change that selection; validate Vite/Electron separately and use hosted CI for the full build gate.
- The full `npm run test` pretest initially stopped at an iOS source-contract regex that assumed the old activity-first branch. Update this contract when the chronological branch changes, while preserving whole-reply Copy actions.
- Local Electron Playwright smoke tests closed before the first window on this host, before any chat assertion ran; use hosted CI for that gate.
- Re-running the focused iOS simulator suite on the already booted iPad became unreliable after a parallel clone launch; Xcode reported `Application failed preflight checks: Busy`. The first focused run passed before the final test refinement; use a clean simulator or hosted iOS CI for the final gate.
- PR #224 Android CI passed its unit gate but one unrelated scheduled-task Compose test saw no hierarchy on its emulator. Rerun the exact commit before changing scoped code.
- PR #224 verify retained a source-contract assertion for the removed 700 ms Visualizing hold; update it to assert the chronological activity owner and rerun.
## 2026-09-22 — Mobile Bot controls verification

- Isolated worktree Git metadata and Gradle's shared cache remain outside the effective writable sandbox; use the configured execution approval mechanism after actual `index.lock`/Gradle lock failures. Xcode package resolution likewise needed network-enabled execution.
- This host's default developer directory lacks `devicectl`; use `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer` with isolated `/tmp/aiden-bot-ios-derived`.
- Coordinator's physical-device run reports `com.apple.dt.deviceprep Code=-3`, `Unlock Sambit’s iPhone to Continue` for `00008110-00063CD91E98801E`. Do not count unsigned test compilation as XCTest execution or repeatedly launch a locked-device run.
- A held MockWebServer disconnect exposed OkHttp's default connection retry replaying approval POSTs. Disable transport retries specifically for approval/Stop; keep unknown-outcome UI and authoritative reads instead of restoring captured cards.
## 2026-09-22 — managed worktree stack audit

- Fresh main already merged #185 while #189–193 remain open with incompatible duplicate contracts. A trial main→#189 merge conflicted in Git journals, provisioning metadata and package scripts; aborted it without discarding any PR work. Audit current architecture before transplanting dated research/stack fixes.
- This task retained workspace-write despite global full-access configuration. Ordinary Git metadata writes, clang temporary output and tsx local IPC were blocked; required tool escalation was used without changing permission settings.
- `st_dev` inequality does not prove independent APFS free-space pools. A read-only `diskutil info -plist` probe stalled and was stopped; keep admission conservative for unknown relationships instead of introducing a platform-discovery dependency. Git also collapses disabled filter/encoding attributes into literal sentinel values, and worktree-only `includeIf` makes source-config inspection unsafe.
- 2026-09-22 PR #184: a branch-list lookup is not authoritative negative evidence after an unknown GitHub create. Preserve pending intent on empty/retargeted/advanced-head results, and publish a link plus intent settlement atomically so a crash cannot later undo an unlink. Post-push PR operations must carry the frozen push endpoint's repository; gh's workspace inference can select another remote.

- 2026-09-22 PR #184 automated follow-up: evicting a per-chat DataStore does not revoke delayed provider callbacks or admitted writes. Mark deletion before queue drain, fence publication, and remove the file only after the barrier. Notify pending-create cache consumers after the create outcome, not while the remote request is still active.

- 2026-09-22 PR #184 recovery follow-up: draining DataStore updates does not await initial load recovery. Join existing.load() after revoking admission, then drain writes and remove the file.

- 2026-09-22 PR #184 recovery cleanup: DataStore.load can settle while leaving an unreadable held candidate eligible for a later recovery. Chat deletion must consume exact chat .held/.previous artifacts, including when no store was loaded, and fail if cleanup cannot finish.

- PR #184: Recovery filename prefixes are ambiguous for valid dotted chat IDs. Match the full basename plus fixed recovery fields in both load and deletion; test dotted siblings in both directions.
- 2026-09-22 PR #195 remediation: pinned cua-driver 0.8.3 tokens are snapshot-scoped, not stable AX identities. Repeated captures legitimately change tokens; tests must use real `sXXXX:index` rollover and bind full reviewed structure plus unique exact semantics and geometry before accepting a fresh token. Unknown/missing metadata fails closed.
- PR #195 native tests: Command Line Tools cannot resolve XCTest on this host; full Xcode-beta succeeds. Enabling the pinned-model tests exposed an incorrect Bundle fixture subdirectory hidden by prior skips. All 17 native tests now run with SHA-verified model artifacts under /tmp.
- PR #195 source audit: the FluidAudio Swift reference is Apache-2.0 at the pinned revision, while the CUA model artifact is MIT. Corrected misleading MIT comments and included both notices; no FluidAudio runtime dependency was added.

- 2026-09-22 / PR #195: pinned cua-driver 0.8.3 snapshot tokens and identical AX trees cannot prove document continuity. Do not substitute URLs/titles or invent an advertised capability. Disabled form-fill admission/mutation pending an upstream atomic document-bound write contract; retained local scorer groundwork and cleanup only. Strict removal also needs retained teardown errors because ordinary controller close intentionally suppresses cleanup failures.
## AGENTS refresh — 2026-09-22
The existing native read-html operation reads bounded UTF-8 regular files descriptor-relatively; extension/HTML validation lives in its UI caller, allowing AGENTS.md reuse without a new native protocol. Keep first-turn refresh separate from Pi prepareNextTurn (only subsequent logical turns), and add a provider-dispatch scope fence without mutating in-flight/retry bodies. Preserve the onboarding workspace queue/steering disclosure when adding AGENTS copy.

- 2026-09-25 on-the-go slice D: the Android unit-test fixture is a checked-in copy at `android/app/src/test/resources/contract.json` — it does NOT track `protocol/aiden-remote/v1/fixtures/contract.json` automatically (iOS references the shared file directly via pbxproj). Every contract-revision bump must `cp` the canonical fixture into the Android copy; slice B's review and slice D both caught drift here.

## 2026-09-24 — Gemini TTS review hardening

- AbortSignal alone is not a terminal transition: the deliberately noncooperative provider test kept the job generating until the timeout callback itself marked failure. Test late resolutions as well as rejected aborts.
- A bounded read is not full consumption. Marking a segment read after its first 64 KiB allowed eviction during continuation reads; retention now tracks contiguous bytes and rejects unread overflow atomically.
- Generation completion precedes audible completion; wiring Settings preview directly to synthesis produced no audio. Use the same gesture-primed, job-owned controller and fence pending start/read/decode across Stop and navigation.
- One authority child completed. UI child reached its turn limit without a reliable report; parent covered that gap. Final follow-up batch was refused at admission by the tree deadline, so fresh independent final sign-off remains open rather than retrying it.
- Android chat/progress initially ran 56/57: failedSendRestoresDurableDraftAfterRestart raced Dispatchers.Main reset. No Android changes; chronology/progress isolation passed 20/20, then the same full selection passed 57/57 on confirmation. Preserve the flake evidence rather than treating the first run as green.
- Physical iOS AidenChatTests ran on the available paired iPhone and passed 114/114; no simulator test run was used. Vite build passes with its chunk-size and Ghostty mixed-import warnings; release/package/live-Google gates were not run.

- 2026-09-24 TTS dev launch: several C-helper build scripts replace the environment and discard DEVELOPER_DIR, selecting the malformed CLT SDK. Built those same helper sources/flags with an explicit full-Xcode xcrun environment, then ran build:electron and the renderer/Electron dev commands directly; no global xcode-select change.
- This checkout had the Electron npm package but no app binary. Running its existing install.js restored Electron 43.1.1. Aiden Agent Dev now launches; startup separately reports unavailable Generative UI artifact recovery and blocked chat mutations. Do not reset or delete dev-profile data to hide that warning.
- 2026-09-24 TTS dev profile diagnosis: the shared development artifact store contains newer designOwnership/designPublication record fields. This branch correctly rejects that schema; removing the fields could destroy ownership/publication semantics. With explicit user approval, launched a clean per-test --user-data-dir plus separate AIDEN_CONFIG_DIR instead. Existing profiles were not modified; fresh startup has no artifact-recovery warning. Ordinary npm run dev still uses the shared profile.
- 2026-09-24 TTS saved-key lookup: built-in Google uses piCredentialStore, not secrets.getKeyStrict("google") (legacy/custom-provider map). A configured provider plus enabled Read Aloud still redirected to setup until that runtime binding was corrected. Added managed-store regression; 109 TTS tests and type/lint checks pass.
- 2026-09-24 replay: retrieved-segment eviction destroys replay prefixes. Retain whole soundbites and evict only inactive jobs; keep attempt tombstones after byte eviction. Reusing job IDs also requires inactive renderer surfaces to ignore later events and replacement to emit playback cancellation without cancelling the retained synthesis record. Existing native /speech routes are STT, not TTS. Follow-up replay reviewer was not admitted due to tree deadline.


- 2026-09-24 native TTS: Android mirrors `protocol/aiden-remote/v1/fixtures/contract.json` in test resources; update it byte-for-byte or the native contract gate fails. iOS uses the shared fixture directly. OpenAPI route allowlists also need the additive paths.
- 2026-09-24 native TTS: the available physical Smbt16ProMax was locked, so xcodebuild compiled/signed but waited before XCTest launch. Terminated the wait; unsigned `build-for-testing` passed, but it is not physical playback/test acceptance. Unlock the phone before rerunning.
- 2026-09-24 native TTS review: fresh backend/native reviewer batch was rejected before admission by the subagent tree deadline. No completed independent review/sign-off exists for these changes.

- 2026-09-25 PR245: shared `contract.json` has no usage entry; usage-label tests must construct typed usage totals, not assume a fixture exists. Initial tests exposed this incorrect assumption and were corrected.
- 2026-09-25 PR245 simulator: the reused iOS26.4 simulator launched the app but did not inject/connect XCTest on a second run (sample showed idle app, no XCTest). Terminated only that test runner/app; an isolated iPhone17 simulator completed 232 tests (5 skipped). Do not reset unrelated simulators or count the stalled run as a pass.
## 2026-09-25 — rich link previews

- Fresh worktrees have no `node_modules`, so focused `tsx` tests fail immediately. Run `npm ci --ignore-scripts` from the lockfile before renderer verification.
- Review status can pass while an actionable inline finding remains. Inspect unresolved threads explicitly; content equality is not sufficient handoff identity when an unpersisted partial can repeat older assistant text.
# 2026-09-24 implementer run-grant worktree

Fresh managed worktrees have no `node_modules`; `npm ci --no-audit --no-fund`
was needed before type checking. Direct workspace-write tests initially failed
because their native file-mutator test binary had not been built. Run
`npm run build:subagent-file-mutator` and
`node scripts/build-subagent-file-mutator.mjs --test` before the focused suite.

## Composer busy controls — 2026-09-23

- Pi's managed initial user input is not re-emitted, but Steer input is. The queued-user projection must be written before Pi's awaited `message_end` listener returns, and its Pi journal append must include the visible chat-message marker in the same transaction. Otherwise the next generation's visible-history sync duplicates the guidance.
- This host defaults to Command Line Tools, where `simctl` is unavailable. Set `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer` and use an iPhone simulator for iOS tests; no physical-device unlock is needed.
- Pullfrog follow-up: Pi's `reset()` silently drops steer input it never emitted, and the queued-user projection runs inside Pi's serialized `message_end` delivery, so a stalled ChatStore write would block `cancelAndSettle`. Route the projection through `waitForManagedPromise` (quarantine it as detached durability on Stop) and ask the harness for undelivered accepted input before `reset()`. That collection must be synchronous: awaiting the quarantined write before the terminal re-creates an indefinite "Stopping"; report it as a separate `late` promise and return failed late saves on `chat:guidance-returned`. Also keep that cancelled projection in `pendingDurabilitySettlement()` after it settles: the detached-durability set drops settled entries, so a save landing before `runManaged()` returns would otherwise commit the turn without the guidance in Pi and the next sync would append it after the assistant. The renderer restores it from the terminal payload through both the attached `startGeneration` listener and the detached terminal sync.
- 2026-09-24 compaction budget repair: generic `generation-degraded` and `context_management` entries hid the local guard cause and token budget. Emit fixed reason/stage plus aggregate counts at the coordinator; keep raw provider and summary text out of diagnostics. VCC workers previously returned fixed error messages without typed codes, so preserve the closed code for useful failure logs.
- 2026-09-24 build: bare `xcrun` selected Command Line Tools MacOSX27.0 SDK and failed linking `libSystem.tbd` (`arm64e.x1-macos` unknown architecture), despite `xcode-select -p` reporting Xcode. The Bot inbox helper's `execFile` uses a fixed environment and drops a scoped `DEVELOPER_DIR`, so retrying the full build with Xcode beta set in the parent still fails. Verify the renderer/Electron build separately until this native build seam is repaired.
- 2026-09-25 PR #244 review: `pi-compaction-core.test.ts` recovery cases use the real VCC worker at `build/main/pi-vcc-worker.js`; in a fresh worktree they fail with "VCC compilation worker failed" until `npm run build:electron` has run. Pi's `findCutPoint` also retains the message that crosses `keepRecentTokens`, so an oversized fixture placed just before a tiny tail ends up retained rather than summarized.
## 2026-09-24 — production todo diagnosis

- The diagnostic log records subagent failures but not their admission reason or the task status they affect. Correlating the private Pi journal showed a final review request rejected at the tree deadline and task 12 still `in_progress`. A bounded, content-free task transition diagnostic would make this easier to diagnose without exposing chat text.
- The isolated worktree had no `node_modules`, so the first focused test and type-check attempts failed before execution. `npm ci --ignore-scripts` restored the locked JavaScript toolchain; reruns passed.
- The focused todo suite missed an older source-shape assertion in the renderer preflight suite. Hosted CI and two review bots caught it; update that contract and run preflight when changing the shared `ScrollArea`.
## 2026-09-25 — Simulator devices Phases 0–2

- Worktree-isolated sessions refuse Bash with `$(...)`, computed binaries, or `cd … && <heredoc>`; put scratch scripts in the session scratchpad and run `bash <file>`, and use Edit/Write for source changes. BSD `sed -i ''` multi-line substitutions fail silently.
- A `show: false` Electron window never resolved a WebCodecs `isConfigSupported` probe; use a visible window with an `app.exit` timeout and write results to a file.
- `agent-device snapshot` returns `SESSION_NOT_FOUND` until `agent-device open <bundleId> --session <s>` runs; the first open also builds the Apple runner (~4s here).
- The repo has no Prettier dependency or config; `npx prettier` fetches an unpinned release and reformats to 80 columns. Do not run it — revert with `git checkout -- <file>` and reapply the edit.
- E2E fixtures had no per-test app environment; `appEnvironment` option and `relaunch(afterClose, appEnvironment)` now exist for experimental flags.
- A WebSocket test client hung waiting for the first frame: Node can deliver it inside the `upgrade` event's `head` buffer. Decode `head` when it is non-empty before listening for `data`.
- `tsc` targets a lib older than ES2022: `Array.prototype.at` and `new Error(message, { cause })` fail type-check even though `tsx` runs them. Use index access, and assign `cause` with `declare readonly cause: unknown` as `managed-worktree-file-io.ts` does.
- Handler modules import `../platform.js` (Electron), so they cannot be unit-tested under `tsx`. Put the IPC registration behind an injected `handle`/`owner`/`service` seam in a services file, and keep the handler as Electron wiring only.
- Writes to `/Users/…/aiden-macos/.memory/` are refused in a worktree session; edit the worktree's own `.memory/` copy.

## 2026-09-25 — Simulator devices Phase 3

- E2E: right after a chat reply, the streaming-reveal layer briefly duplicates the response text, so `getByText` hits a strict-mode violation. Wait for `.streaming-reveal` to reach count 0 first.
- `tests/e2e/*.mjs` get no ESLint Node globals. Import `Buffer`, `URL`, and the timers from `node:*` explicitly.
- Hub E2E without a production seam: seed `userData/devices/tools/expo-device-hub/<v>/…/cli.mjs` (it imports the fake), `.install-complete`, and `consent.json`, then put a fake `xcrun` on PATH through `appEnvironment`.
- Playwright `request.allHeaders()` showed no `Origin` on the `file://` renderer's stream fetch. Don't assert `Origin: file://`.
- `local-device-host.test.ts` `waitFor` (200 `setImmediate` turns) flaked under the loaded CI lane. It is now bounded by 5s of wall time.
- `cd … && python3 - <<'EOF'` passed the worktree guard this time, where a plain heredoc had been refused.
- A manual test on a real simulator failed with "stream refused access". expo-device-hub routes WebSockets by exact path, so the input socket is `/vendor/serve-sim/helper/ws?device=<udid>`, not the per-device `wsUrl` in serve-sim's config. The fake hub had copied our wrong assumption, so the E2E passed anyway. Check fakes against the real hub's routing (`cli.mjs` `webSocketRoutes`).
- `npm run dev` port 4143 was taken by another worktree's dev server. Run vite on another port and set `AIDEN_RENDERER_URL` to match (the device proxy allowlists that origin). The E2E uses the built renderer, so run `npm run build` after renderer changes.

## 2026-09-25 — Simulator devices Phases 3.5–4

- The faux LM Studio matched scenarios against the latest user message. pi-ai sends tool-result images to OpenAI-compatible APIs as an extra user message ("Attached image(s) from tool result:"), so image-returning tools ended the scenario early. The fixture now skips that carrier.
- The Environment tabpanel stays mounted and reports visible after **Close environment panel**. Assert on the `Environment work surface` complementary region and the tab's `aria-selected` instead.
- A fake agent-device must detach its daemon: the host awaits `devices --json` with a timeout and only polls `daemon.json`. Kill the daemon in `finally` from `agent-state/daemon.json` so a failed run leaves nothing behind.
- `String.prototype.replaceAll` also fails `tsc` under the old lib; use `split().join()`.
- `assert.throws(fn, /regex/)` matches against `String(error)`, which includes `Error: `. Anchor as `/^Error: …$/u`, not `/^…$/u`.
- A fixed `consent.json.<pid>.tmp` let two saves racing each other rename a partial file. Chain the saves and use a unique temp name.

## 2026-09-25 — Simulator devices Phase 5 (paired Macs)

- The desktop protocol test compared the shared mobile fixture with the full capability list. A desktop-only capability must stay out of that fixture, because iOS checks fixture capabilities against its `v1Known` list. Compare with the vocabulary minus the desktop-only members instead.
- `openapi.json` mixes inline and expanded arrays, so `json.dumps` rewrote about 2,600 lines. Edit it by inserting text at object boundaries.
- `PeerTransport` maps 401/403 to `authentication_required`, not `request_failed` with a status. Tests that fake an auth failure must use that code.
- Raw-socket WebSocket tests can read the refusal status line directly. `createAidenRemoteUpgradeHandler` writes `HTTP/1.1 403 Refused`, not `Forbidden`.

## 2026-09-25 — Simulator devices Phase 6 (3D frames)

- three.js geometry, `Texture`, `Raycaster` and `PerspectiveCamera` all run under Node, so projection and UV tests need no WebGL. Only `WebGLRenderer` needs a browser; keep it in `phone-viewer.ts`, which is loaded lazily.
- `fitCamera` returns the same distance at aspects 0.5 and 2 for a 1:2 device, because both are height-bound in one direction and width-bound in the other. Pick test aspects that differ in the binding axis.
- Touch projection returns points in the displayed frame (visual up is `y < 0.5`) in every orientation, not raw framebuffer coordinates. Assert that invariant rather than per-orientation formulas.
- The worktree guard refuses running a scratchpad `.ts` file that imports worktree files by absolute path. Put short probes inside the worktree and delete them.
- 2026-09-26 main merge: 15 `git.test.ts` managed-worktree removal tests fail locally with "could not safely remove the managed worktree quarantine"; this is the same host native-remover SDK issue above, not the PATH change.
- 2026-09-26 PR #206 reconciliation: #207 on main superseded the runner-side four-note tail, so the merge took main's runner and kept only the projector gap (failed results with `summaryTruncated` lost the `report_truncated` notice because the gate predated failed summaries).
