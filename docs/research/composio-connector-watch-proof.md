# Restricted Composio watch adapter: proof boundary

Research date: 2026-11-03. Status: candidate contracts identified; authenticated schema and exact-account execution proof remain pending. This record supports plan D8 and does not enable Calendar or claim live mail/calendar acceptance.

## What was actually inspected

- The configured, enabled built-in connector uses the catalog's fixed `https://connect.composio.dev/mcp` endpoint and `x-consumer-api-key` authentication. Its credential and binding exist in the desktop encrypted secret store. No key, ciphertext or account identifier was copied into this report.
- The already running installed Aiden app's Settings → Connectors → Composio → Tools list exposes twelve meta-tools, including Search Tools, Get Tool Schemas and Multi Execute. Its rows contain names and access switches, with no input-schema disclosure or invocation control. No access switch, Test, Connect, Manage or sign-in control was used. The original app view was restored.
- No authenticated MCP request, app-tool call, account/calendar listing, email read or event read was performed. No production configuration or credential was changed. The credential loader is Electron-owned and includes a possible legacy-binding migration; it was not invoked from an external research process. No Keychain extraction or replacement credential helper was attempted.

The app-owned foreground inspection is now wired to **Find sources** in the watch editor. It uses the existing approved live connector and its bound credential without exporting it. A separate Settings → Connectors → Composio → Tools → Check watch support action now supports an owner-run inspection without changing Bot grants; this avoids saving new Custom bindings into a profile used by an older installed app. It retains only closed structural evidence in `composio-watch-inspection.json`, not account identities or raw schema prose. Running either check against the configured account remains pending; the installed MCP executor’s actual `account` support and upstream response shapes are still unverified.

## Account routing: documented possibilities, not installed proof

Composio documents an execution parameter named `account`, accepting a connected-account ID or alias. With explicit selection enabled, it is required when several active accounts exist. Otherwise the default may be the most recently connected account. Names and default selection therefore cannot establish a watch binding. Aliases are mutable; store the chosen immutable account ID privately. These facts describe the vendor's multi-account product, not the configured Connect executor's input schema. [Multiple connected accounts](https://docs.composio.dev/docs/authentication/managing-multiple-connected-accounts).

A project-managed session can pin one account per toolkit using `connectedAccounts`, and its configuration has a version. Such session management and tool execution require corresponding project-key permissions. There is no evidence here that the configured consumer credential authorizes those project REST/SDK operations, so it must not be reused against another endpoint. Concurrent session updates also require an appropriate version fence; an account mapping observed before a call is not an immutable binding. [Configuring Sessions](https://docs.composio.dev/docs/configuring-sessions), [Session reference](https://docs.composio.dev/reference/sdk-reference/typescript/session).

The published Multi Execute page exposes a `tools` array and workflow/session fields, but does not establish where an exact account selector lives in the installed schema. A host adapter must prove the selector's semantics before executing; adding an undocumented `account` field or checking the account only after reading is insufficient. Cardinality must be exactly one, and the operation slug and arguments must be host-constructed. [Multi Execute](https://docs.composio.dev/toolkits/meta-tools/multi_execute_tool).

## Candidate read operations

The following names and parameters come from public vendor references, including the Markdown reference snapshots used in W0. They are discovery candidates, not an executable allowlist or a verified installed response schema. No operation below was called.

| Workflow | Candidate | Published contract to verify |
| --- | --- | --- |
| Gmail source selection | `GMAIL_LIST_LABELS`, `GMAIL_GET_PROFILE` | Exact account metadata and stable label IDs; never select by mailbox display name. |
| Gmail ID traversal | `GMAIL_FETCH_EMAILS` | `user_id: "me"`, exact `label_ids`, bounded `max_results`, `ids_only: true`, `include_payload: false`, exact `page_token` continuation. |
| Gmail selected metadata | `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | Exact returned `message_id`, `format: "metadata"`; no body, attachment, raw or full format. |
| Gmail changes | `GMAIL_LIST_HISTORY` | Numeric `start_history_id`, bounded pages, optional label/history filters; invalid/expired history requires a full baseline repair. |
| Calendar source selection | `GOOGLECALENDAR_LIST_CALENDARS` | Stable returned calendar IDs, bounded `max_results`, exact `page_token`; exclude insufficient read roles. |
| Calendar window | `GOOGLECALENDAR_EVENTS_LIST` | Explicit `calendarId`, `timeMin`, `timeMax`, `timeZone`, `singleEvents`, `showDeleted`, bounded `maxResults`, `pageToken` and partial-response `fields`. |
| Calendar change/occurrence follow-up | `GOOGLECALENDAR_EVENTS_LIST`, `GOOGLECALENDAR_EVENTS_GET`, `GOOGLECALENDAR_EVENTS_INSTANCES` | Separate change/instance contracts; do not assume the window call is a complete cancellation feed. |

Gmail's optimized detail fetch can skip individual 404/429/503 failures. Treating the shorter returned array as a complete mailbox would be unsafe. An IDs-only traversal plus explicitly checked metadata results is a possible design; its total read/deadline budget and error behavior still need proof. Public outputs remain generic action envelopes, not sufficient validators. [Gmail toolkit](https://docs.composio.dev/toolkits/gmail). Google's metadata format supports selected headers, but the Composio wrapper must independently expose and preserve that behavior. [Gmail message read](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

The Calendar wrapper uses different casing across operations: list-calendars uses snake_case, while events-list uses camelCase. `calendarId` must be a returned calendar ID, not a Composio `ca_…` ID, empty value or the mutable `primary` alias. Its published output envelope still does not prove event/page representation. [Google Calendar toolkit](https://docs.composio.dev/toolkits/googlecalendar).

## Calendar semantics the adapter must preserve

Google's window bounds concern event overlap: `timeMin` limits event end and `timeMax` limits event start. Filter normalized results again for the product's upcoming-start window. Continue through `nextPageToken` even when a page is empty. Incremental `syncToken` cannot be combined with the rolling time bounds or several other filters; keep sync parameters consistent and handle HTTP 410 with a fresh baseline. A bounded design must separately account for an observed event moving outside the window. [Events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

For recurring instances, `recurringEventId` and immutable `originalStartTime` identify the occurrence despite a reschedule. Preserve the actual event ID too. A cancelled recurring exception may contain only those identity fields and its ID; an ordinary deleted event may contain only its ID. A parser requiring title/start/end on every cancellation would discard valid evidence. Absence from a rolling window does not prove cancellation. [Event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events).

## Next foreground proof

1. Add a reviewed app-owned inspection port restricted to the configured trusted Composio origin, existing bound credential and the two schema/meta-read operations. It must perform no credential migration, sign-in, connection creation/removal or app-data read.
2. Obtain the actual complete MCP inventory. Search separately for the mail and calendar read workflows. Request input and output schemas only for slugs returned by Search; bound responses and retain only safe structural facts and fingerprints. The published references explicitly do not guarantee stable meta-tool schemas. [Get Tool Schemas](https://docs.composio.dev/toolkits/meta-tools/get_tool_schemas), [Meta-tool compatibility](https://docs.composio.dev/toolkits/meta-tools).
3. Prove exact account selection before constructing a single-operation executor. If the actual executor exposes no enforceable selector or immutable account-bound session, return an unavailable template with an actionable reason. Do not substitute default-account routing, arbitrary proxy execution or a new developer credential silently.
4. Only after explicit owner source selection, verify bounded calendar/mail metadata and the real result envelopes. Add independent fixtures for incomplete pages, account drift, cancellation, recurring exceptions, rescheduling and restart. Keep Calendar gated until these checks pass.

`COMPOSIO_MANAGE_CONNECTIONS` is excluded from inspection: it can initiate authentication or mutate connection state. A schema probe must not call it to discover whether an account already exists. [Manage Connections](https://docs.composio.dev/toolkits/meta-tools/manage_connections).

## W1b foreground probe implementation — 2026-11-03

The owner's subsequent D9 decision groups Composio behind one agent-facing tool and one connection permission. The probe's internal catalog operations use that service grant; they do not introduce twelve separate owner grants or pin the entire changing vendor inventory as Bot authority.

`main/services/bot-routine-events/connector-watch-composio-probe.ts` now implements a pure host adapter. Its port requires foreground provenance, current service authorization, raw inventory pages and only Search/Get Schemas calls. It neither owns credentials nor connects a transport. The parent host must construct the port only for an explicit foreground action, apply the same authority check at the actual send, and propagate document closure, Bot pause, source changes and cancellation. Startup, watch polling and model tools must never invoke it.

Inspection reads at most four inventory pages with 128 tools per snapshot, checks metadata again before the second operation, and sends at most two catalog calls. Each reply is limited to 256 KiB, aggregate replies to 1 MiB, and the total operation to fifteen seconds. A noncooperative port cannot hold the result open or start a later operation after timeout. Meta input schemas and constructed arguments must fit an understood, bounded JSON Schema subset; remote references, custom formats and arbitrary regex constraints are refused. This prevents guessing arguments for an unfamiliar contract.

Host-written queries contain no person data. Requested app slugs are the intersection of a fixed read-candidate vocabulary and the corresponding Search result; a returned write operation or an unreturned candidate is never forwarded. The parser recognizes the documented `data.results`, `data.tool_schemas`, `data.session` and connection-status structures, followed by Get Schemas' `data.success`/schema map. Output schemas are requested only when the current input schema supports that selector. Explicit partial/offloaded results, missing definitions and tool errors fail closed. [Search Markdown contract](https://docs.composio.dev/toolkits/meta-tools/search_tools.md), [Get Schemas Markdown contract](https://docs.composio.dev/toolkits/meta-tools/get_tool_schemas.md).

Retained host-private evidence contains hashes, allowlisted field names, read-hint declarations and coarse connection-status booleans. It excludes raw schemas, defaults, examples, descriptions, planner instructions, user information, session IDs and connected-account IDs. The separate public projection exposes constant status/reason text only. An executor or upstream schema declaring `account` remains structural evidence: **every probe result has `available: false`** until independently reviewed account-routing and app-response semantics are implemented and accepted.

The focused suite has seventeen behavioral cases using explicitly synthetic documented-contract fixtures, including cancellation, grant loss after an awaited read, metadata drift, noncooperative deadlines, slug restrictions, response limits, complete MCP representations, malformed/offloaded data and secret-free projection. Focused ESLint passes. No authenticated live inspection, execution adapter, Calendar activation or real-account acceptance was performed by this work. The host invokes it only from explicit **Find sources**, under the initiating renderer document or paired request lifetime and the Bot’s current service grant. The private diagnostic is stored beside that Bot’s session; ordinary listing, polling, startup and recovery do not inspect Composio.


## Foreground host review gate — 2026-11-03

The single-tool projection and migration passed GPT-6.1 Sol high review. Foreground inspection separately passed that review after fixing document/request invalidation, production pagination, deadline placement and access ordering. The fifteen-second budget begins before the first await and includes offline access checks, authority admission, metadata reads and guarded publication. A late admission lease is released once and cannot restart work. Offline current policy, service identity, exact connection binding and Schedules access are checked before any metadata request and again at each boundary. Current Settings exclusions and disabled scheduling also refuse inspection for Full Access Bots.

Production Composio metadata reads stop before a fifth page, enforce 128 tools, 256 KiB per raw reply and 1 MiB total, including reads performed during authority admission. General MCP inventory bounds remain unchanged. The initiating renderer document or Remote request/device grant owns the inspection; closing, disconnecting or revoking it stops later reads and publication without cancelling accepted watch mutations. The owner agreed to run the prepared foreground check. That live check, exact-account semantics and app-data acceptance remain pending.

## Foreground launch correction — 2026-11-03

The owner ran the prepared immutable Settings-check snapshot (`e19c88bf8`) using the branded development runtime with a production profile override. That attempt reported macOS Keychain error `-25308` (`errSecInteractionNotAllowed`), followed by unavailable provider credentials, Bot rollback authority and paired-device storage. These are secure-storage launch failures, not a Composio schema result. No successful authenticated inspection or app-data read is established by that log. The owner was advised to quit the check copy and reopen installed Aiden without resetting credentials or access settings.

Read-only signature inspection established that installed Aiden is Developer ID signed as `com.sambitcreate.aiden-agent`, team `5WP229CBB8`, while the first runtime was ad hoc signed with the `.dev` identifier. Electron requires a consistent signature for reliable macOS safeStorage behavior; Apple describes designated requirements as the basis for code identity. This mismatch is a supported explanation, rather than proof that a particular Keychain item was inspected. [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [Apple code identity guidance](https://sosumi.ai/documentation/technotes/tn3127-inside-code-signing-requirements).

A separate task-owned runtime was then prepared with the existing Developer ID signing identity, production bundle name/identifier and standard Aiden entitlements. Both it and the installed app satisfy each other's designated requirements, and its deep strict signature verification passes. The installed app, credential stores and access settings were not modified, no private key was exported, and preparation did not launch the app. The same reviewed source snapshot remains separate from later private-state changes. A new owner-run check is still required to establish secure-storage availability and the actual Composio result; Calendar remains gated meanwhile.


## Cold Settings metadata connection correction — 2026-11-03

The owner-run signed check reached Settings, and the existing saved Composio credential passed **Test connection**. **Check watch support** still failed immediately without a structural record: its eligibility check required the main agent's cached client, while Test connection deliberately uses and closes a separate status client. A successful status test therefore could not satisfy the inspection's cache precondition. No access switch, Bot grant or saved connection setting was changed during that diagnosis.

The Settings-only correction uses a disposable authenticated MCP metadata session at the saved canonical consumer endpoint. It reads only an already bound saved credential, performs no credential adoption or cleanup, and closes the session after completion, failure or cancellation. The private document lifetime, exact configuration snapshot, configuration lease and disposable-client generation fence credential resolution, transport start, metadata requests and structural publication. Its raw port permits only Search Tools and Get Tool Schemas under the existing bounds. It never populates the agent/watch cache; background watches and Bot source discovery retain their existing live-connection requirement. Account-routing verification and Calendar remain pending.


## Live foreground takeover — 2026-11-03

At the owner's explicit request to take over the visible Composio check, Codex used native computer use with the reviewed signed diagnostic. The replacement snapshot (`1afe1ceea`) contains only the pre-Open-work watch implementation and the reviewed cold-Settings connection correction. Its build, focused Settings cases, signed native-terminal preflight and disposable-profile startup passed before opening the normal profile. The installed app was not replaced; credentials, saved connection settings and access switches were left unchanged.

The actual **Check watch support** action now writes the private structural record and reports `unavailable / unsupported_meta_schema`. The metadata connection reaches the probe; the rejected contract and exact account-routing semantics are not yet established. Calendar remains unavailable while this mismatch is investigated. The public generated Search/Get Schemas input schemas fit the probe's current keyword subset; that public snapshot does not establish the installed connection's schemas or annotation hints.

Current Composio guidance says an unpinned session resolves active accounts at execution time and that an explicit connected-account override does not fall back. Its multi-account execution contract can select an account by ID or alias. Those capabilities are not proof that this existing consumer connection exposes the same enforceable selector. The adapter must verify the installed metadata and bind an immutable account ID before any app-data acceptance read. [Tool Router account selection](https://docs.composio.dev/kb/guide/mcp-tool-router-sessions), [Multiple accounts](https://docs.composio.dev/docs/authentication/managing-multiple-connected-accounts).


## Observed metadata declaration — 2026-11-03

The reviewed V3 diagnostic (`2e1266847`, isolated from the later feature state) identifies the actual initial rejection: `COMPOSIO_GET_TOOL_SCHEMAS` declares a read-only hint and a canonical JSON Schema draft-07 `$schema` annotation. Its root object, required-field vocabulary, tool-slug array and session field satisfy the probe's expected structural shape. The probe rejected the annotation itself before calling Search or Get Schemas. This is an observed installed-metadata fact, rather than an inference from the public snapshot. A narrowly bounded draft-07 compatibility correction is being reviewed; account routing and Calendar remain unverified.


## Bounded draft-07 correction — 2026-11-03

The probe now accepts only the four canonical HTTP/HTTPS draft-07 root annotations, with or without the trailing fragment marker. It normalizes that annotation to Ajv's bundled draft-07 identity and compiles synchronously without a schema loader or network request. Other dialects, nested annotations, references, identifiers, patterns and custom formats remain refused. This changes metadata compatibility only: every result still leaves account routing and execution unavailable until independently verified.

The Bot-specific inspection writer also rechecks the initiating authority after its final directory, realpath and target checks, immediately before atomic publication. Revocation during any of those awaited checks preserves prior evidence and removes the staging file. Both changes passed the requested GPT-6.1 Sol high review; independent focused suites passed88/88 and strict probe types and lint passed. Live verification of the corrected snapshot follows separately.


## Live metadata response check — 2026-11-03

The corrected V4 snapshot (`3e1b6ad2e`) passed its build,80 snapshot tests, signed-runtime preflight and isolated startup. Native computer use confirmed the running V4 build before the explicit Settings check. That check now advances past the draft-07 declaration and reports `invalid_response`. Its returned metadata format has not yet been established; no app-data operation or account selection was attempted.

A separate closed `responseRejection` diagnostic now records the fixed validation stage, field and reason; call progress; completed-inventory flags; and capped type/count facts for known envelope fields. It retains no returned strings, numeric values, map keys, session identifiers, account information or vendor prose. Already-read account-selector declarations remain booleans and do not verify routing. Parsing, public output and all watch gates remain unchanged. The requested Sol high review is clear, with163 independent focused cases and strict types/lint passing. Live response evidence follows from a new isolated reviewed snapshot.


## Observed Search compatibility — 2026-11-03

V5 (`197227780`) passed its build,155 snapshot cases, signed preflight and isolated startup, then ran the explicit normal-profile Settings check under native computer use. Its closed evidence shows a complete inventory, read-only Search/Get Schemas hints, a declared executor-item account selector, and a successful Search returning two results. The consumed result structure is present; the first rejection is missing `reasoning`, and `task_difficulty` is also absent. Neither planning field supplies routing or permission authority. No account ID or vendor content is retained in the evidence.

The probe now permits either unused planning field to be absent. Present values must still be bounded, well-formed strings. Consumed result correlation, toolkit/slug checks, completeness, schema validation and all account/execution gates remain unchanged. The requested Sol high review is clear with180 independent cases, strict narrow types and lint passing. The selector's declaration does not establish its semantics, and no Calendar execution is enabled by this correction.


## Observed connection metadata compatibility — 2026-11-03

V6 (`cd88a759b`) passed its build,172 snapshot tests, signed preflight and isolated startup. The explicit normal-profile check advanced through the successful Search results and rejected a missing legacy `connection_details` object on a status whose `has_active_connection` flag is true. That object supplies no account authority to the diagnostic. The metadata reader now permits its absence; present objects still undergo completeness checks.

The current Search v3.1 reference also describes an `accounts` list and account-selection metadata. The private diagnostic now records only known account-field types/counts, an exact ACTIVE-status boolean and a conservative ID-format category. It retains no account ID, alias, default choice or routing authority. Installed account-list presence still needs live verification. The requested Sol high review is clear with203 independent cases, strict narrow types and lint passing. [Current Search contract](https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSessionBySessionIdSearch).


## Installed account-list and schema-label check — 2026-11-04

V7 (`6762e18ad`) passed its build,195 snapshot tests, signed preflight and isolated startup, then ran the explicit normal-profile check. Search and Get Schemas both completed successfully. The closed account metadata shows an ACTIVE Calendar account with the documented account-list fields; the account identifier itself is not retained. The conservative diagnostic classifies its ID syntax as other, which is not an account-authority decision. The executor-item selector remains declared.

Schema validation next rejected a toolkit label for an exact curated Gmail slug. The metadata reader now accepts only ASCII casing variants of the expected Gmail or Google Calendar namespace, still bound to the unchanged requested slug. Wrong namespaces, padding, punctuation and lookalikes remain refused. A closed exact/case-variant/other classification permits verification without saving the returned label. The Sol high review is clear with223 independent cases, strict narrow types and lint passing. Exact account selection and Calendar reads remain unverified.

### V8 foreground check — 2026-11-04

The owner-authorized native UI run used immutable pre-Open-work snapshot `32e4dcd29` at `/tmp/aiden-composio-foreground-v8`, with only the reviewed known-toolkit casing change over V7. The full build,215 focused snapshot cases, signature/native PTY preflight and isolated-profile startup passed. The actual Settings action completed with **schemas inspected / account_routing_unverified** (`checkedAt:1793769069024`). Search and GetSchemas completed with the item-level account-selector declaration; Calendar account metadata reported one ACTIVE account. The returned curated Calendar schemas covered `GOOGLECALENDAR_LIST_CALENDARS` and `GOOGLECALENDAR_EVENTS_LIST`; Get and recurring instances were not selected by the Search intersection, so their installed schemas remain unverified. Credentials, switches and Bot grants were unchanged. No executor or app-data operation ran. Exact account-routing semantics, invalid-account refusal and bounded Calendar response acceptance remain required before enabling the adapter.

### Gated Calendar translation review — 2026-11-04

The pure Calendar adapter now constructs only one of three curated reads with an explicit immutable account and calendar. Its synthetic behavioral coverage checks empty-page traversal, recurrence moves, minimal cancellations, bounded follow-up reads for missing future events, strict source-bound persisted history, zero Search calls in accepted polling and zero executor calls when current admission is refused. The requested GPT-6.1 Sol high review was clear, with24 independent adapter tests, narrow types and lint passing. The root test script registers this suite. This review does not prove installed account routing or nested result representation, and no production transport is enabled by it.

### Calendar read-check review corrections — 2026-11-04

The foreground read checker now requires the executor's declared output schema as well as all three curated upstream input/output schemas. Every schema is compiled through the same bounded, loader-free restricted compiler before an executor request may be sent; arbitrary regular expressions, references and unfamiliar dialects are refused. Returned executor actions are checked against that declared output schema, including a genuine failed item used by the separate strict no-data account-selection oracle. Successful reads additionally require exact item correlation, their upstream output validator and the Calendar semantic parser. Contract fingerprints detect drift; neither hashes nor saved diagnostic records authorize a read.

Acceptance now uses a rolling window of at most one day and requires one GET of a timed event actually returned from the selected account/calendar. The GET must match that event and its stable recurring-occurrence identity under the current input/output and source-admission checks. An empty window reports `get_proof_incomplete`, sends no fabricated event lookup and cannot report verified acceptance. Closed progress retains only a GET-start flag and verified count, alongside existing stages/counts/hashes; no event identity or content is saved. These corrections are covered by synthetic offline fixtures and remain subject to the requested review and owner-run live acceptance. Calendar availability is unchanged.

### V9 foreground read-contract check — 2026-11-04

The reviewed explicit read check used immutable pre-Open-work snapshot `92b71d414` (root implementation `0478a890a`). Full build,336 snapshot cases, signature/native preflight and isolated startup passed. The root Settings journey passed in a Cua Space with its600px screenshot reviewed; the Sol high fix loop cleared the metadata-only regression, restricted executor-output compilation and required actual-event GET proof. Native Calendar data-flow tests passed29/29 on iOS and15/15 on Android.

The owner-authorized actual Calendar check completed unavailable/unsupported_contract at executor/missing (`checkedAt:1793771203588`). Both Search and GetSchemas completed and one ACTIVE Calendar account was parsed, but no invalid-account, Calendar-list, events or GET executor call ran. A separate metadata-only action still returned schemas inspected/account_routing_unverified. The installed MCP SDK makes outputSchema optional; a reviewed candidate can apply a strict host-authored bounded executor contract when that declaration is absent, while rejecting malformed or unsafe present declarations before dispatch. That correction and authenticated account/read acceptance remain pending; no availability, credential or access change is claimed.

### Optional executor output declaration — implementation amendment, 2026-11-04

The contract now uses a fixed versioned host executor schema on every read. It permits exactly one curated result at index zero, with coherent one-success or one-failure counts, no offload/partial fields and no app payload beside a failure. An absent executor `outputSchema` selects `host_contract`; a present declaration, including null or a malformed schema, never silently takes that fallback. Present schemas must pass the same restricted compiler before dispatch and additionally validate the reply. The exact successful-operation correlation, strict account-failure oracle, upstream schemas and Calendar occurrence parsers remain separate mandatory checks.

The binding fingerprint includes the host schema/version, `declared` versus `host_contract`, current executor input and any declared output, so changing the declaration source stops a previously bound watch. Closed diagnostic proof records only that output-source enum and fixed executor input/output/account-selector failure fields. Offline tests cover absent-declaration list/events/GET acceptance, malformed/unsafe present declarations with no executor I/O, contradictory counts, payloads beside failure and declaration-source drift. This is an implementation checkpoint awaiting Sol high rereview and owner-run exact-account proof; Calendar remains unavailable.

### V10 optional executor-output compatibility — 2026-11-04

The compatibility fix was clear after Sol high rereview (105 independent cases, strict types/lint0) and committed as `a97da0659`. Immutable pre-Open-work snapshot `6e6fcf803` at `/tmp/aiden-composio-foreground-v10` passed its full build,341 snapshot cases, native/signature preflight and isolated startup. The owner-authorized live check confirmed `executorOutputSource:host_contract`, so the installed executor does omit its optional output-schema declaration. It then refused a Calendar read-output schema (`read_response`, unsupported, keyword previously collapsed to other, no dialect; `checkedAt:1793772012829`). Search/GetSchemas completed and one ACTIVE Calendar account was parsed; every executor-call count remained zero. No credential/access changes or app-data reads occurred. More precise closed compiler diagnostics are independently reviewed before the next foreground check; schema acceptance remains unchanged.
