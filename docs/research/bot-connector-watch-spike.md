# Connector-watch spike — 2026-11-03

Phase W0 of [Bot continuity](../plans/bot-continuity-plan.md) has an executable, offline mail/calendar adapter and semantic fixtures in `main/services/bot-routine-events/connector-watch-imcp{,.test}.ts`. This is source verification and synthetic acceptance, not a live-account result. There is no connector polling, installation, launch, sign-in, scheduler integration, UI, phone contract or model call in this spike. It does not make connector watches a shipped feature.

## Verified contracts

| Integration | Exact tools | Evidence and disposition |
| --- | --- | --- |
| iMCP Mail | `mail_mailboxes_list`, `mail_messages_search` | Read-only annotations and implementation verified against iMCP source `ec7bef349e032574aecc8660ca427ba9489e8cc1`. Mailbox `@id` is the exact search filter; its nested account `@id` binds the selected account. Adapter implemented; installed-version and real-account acceptance remain. |
| iMCP Calendar | `calendars_list`, `events_fetch` | Same source revision. Calendar lookup is by case-insensitive **name**, not immutable calendar ID. Adapter checks all listed names for uniqueness and the selected source/title before fetching, using NFC canonical equivalence to match Swift string equality. Source-backed prototype implemented; immutable account/calendar binding is not proved by this API. |
| Composio Gmail | Published candidate `GMAIL_FETCH_EMAILS` | Official documentation identifies filters and pagination, but only generic `data`/`error`/`successful` output fields. Authenticated raw-tool schema request returned HTTP 401 without credentials. No verified live output schema or adapter. |
| Composio Google Calendar | Published window-workflow candidates `GOOGLECALENDAR_LIST_CALENDARS`, `GOOGLECALENDAR_EVENTS_LIST` | Official documentation describes calendar ID selection, `timeMin`/`timeMax`, `singleEvents`, `showDeleted` and exact `pageToken` continuation. Generic output declarations are insufficient for strict normalization. No authenticated tool inspection, live response or adapter. |

Primary evidence:

- [iMCP Mail implementation at the reviewed revision](https://github.com/mattt/iMCP/blob/ec7bef349e032574aecc8660ca427ba9489e8cc1/App/Services/Mail.swift), including declared schemas, read annotations, local-index limitations, result encoding and explicit `nextCursor`.
- [iMCP Calendar implementation](https://github.com/mattt/iMCP/blob/ec7bef349e032574aecc8660ca427ba9489e8cc1/App/Services/Calendar.swift), including name matching, EventKit overlap queries and the graph encoder.
- [iMCP Tool/JSONLDGraph encoder](https://github.com/mattt/iMCP/blob/ec7bef349e032574aecc8660ca427ba9489e8cc1/Shared/Models/Tool.swift) and [its dependency pins](https://github.com/mattt/iMCP/blob/ec7bef349e032574aecc8660ca427ba9489e8cc1/iMCP.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved).
- Pinned Ontology `7e3937c46057ec9afcfb347da2241033d311bd34`: [Event encoding](https://github.com/mattt/Ontology/blob/7e3937c46057ec9afcfb347da2241033d311bd34/Sources/Ontology/Types/Event.swift), [JSON-LD header rules](https://github.com/mattt/Ontology/blob/7e3937c46057ec9afcfb347da2241033d311bd34/Sources/Ontology/JSON-LD.swift), [nested-type tests](https://github.com/mattt/Ontology/blob/7e3937c46057ec9afcfb347da2241033d311bd34/Tests/OntologyTests/JSONLDTests.swift), and [DateTime encoding](https://github.com/mattt/Ontology/blob/7e3937c46057ec9afcfb347da2241033d311bd34/Sources/Ontology/Types/DateTime.swift).
- Pinned Envelope `edccf6c528e94ffcadf678faff50f1e8b96c76e3`: [Mail fetch/cursor contract](https://github.com/mattt/Envelope/blob/edccf6c528e94ffcadf678faff50f1e8b96c76e3/Sources/Envelope/Mail/FetchRequest.swift) and [snapshot boundaries](https://github.com/mattt/Envelope/blob/edccf6c528e94ffcadf678faff50f1e8b96c76e3/Sources/Envelope/Mail/Store.swift).
- [Official Composio Gmail toolkit](https://docs.composio.dev/toolkits/gmail) and [Google Calendar toolkit](https://docs.composio.dev/toolkits/googlecalendar), reviewed 2026-11-03. These are research leads, not evidence of a configured Aiden connection's tool inventory, read metadata or output schema.

The `Event` model emits `@id`, `name`, `calendar`, `startDate`, `endDate`, optional `location`, and optional `eventStatus` (`EventCancelled` for an EventKit canceled status). The outer result is `{"@context":"https://schema.org","@graph":[...]}`. iMCP sets `JSONLD.omitsNestedTypesKey = true`, so graph entries normally **omit** `@type`; the adapter accepts absence or `Event` and refuses an explicit different type. Nested dates encode as strings with explicit offsets. iMCP overrides their display timezone with the host timezone; normalization compares absolute instants rather than offset spelling.

## Host eligibility contract

`IMCP_WATCH_ADAPTER` exports the reviewed contract revision and exact four-tool inventory. It is not an installed-server attestation. `ImcpWatchPort` is scoped to one host-owned binding and requires `assertEligible(tool, signal)` before every call, including mailbox/calendar listing and every Mail page. W1 must implement that gate using current authority; it must throw if any of these are absent or changed:

1. The exact Bot grant, connection/account selection and explicit unattended watch approval.
2. Trusted integration identity, including Aiden's existing signed iMCP launch path, and an installed version/schema combination compatible with this reviewed contract.
3. The exact tool with an understood input/output contract and affirmative read metadata from that trusted integration.
4. Existing, already granted service permissions. In particular, Calendar's implementation calls `requestFullAccessToEvents`; the host must prove permission is already granted and refuse in the background if it is not. This spike does not call it.

Generic batch tools, dynamically selected dispatchers, shell, arbitrary HTTP and an arbitrary server's `readOnlyHint` cannot meet this contract. The gate must not launch, install, reconnect, prompt or sign in as a repair action. Aiden must abort the supplied signal on pause, deletion, authority loss, sleep or loss of process eligibility, and fence any delayed callback with the current watch revision. The adapter checks the signal before and after each awaited eligibility/read step and rejects late results; a 15-second total deadline also rejects a non-cooperative port. W1 remains responsible for transport cancellation and lifecycle authority.

Calendar names and source titles are mutable, and two distinct sources can share a source title. Checking `calendars_list` before each fetch rejects known ambiguity and drift, including NFC/NFD-equivalent names in different accounts, but does not establish an immutable account ID or make selection atomic with the later fetch. **Do not admit this Calendar prototype as an exact-account production watch until a trusted connector exposes stable calendar/account selection, or an explicitly reviewed product contract addresses these limitations.** A trusted upstream change adding those IDs or an authenticated, verified Composio adapter can close the gap. A calendar alias alone cannot.

## Host-owned template vocabulary

The prototype accepts only these closed shapes. It rejects extra fields before reading:

- Mail: fixed mailbox ID and account ID; optional sender-address substring, subject substring, and unread-only boolean. Search filters combine with AND. These IDs remain host-side; client controls should receive opaque host options with safe account/mailbox labels.
- Calendar: exact calendar title and source title, `lookAheadMinutes` from 15 to 1,440, and a validated IANA timezone. Every poll constructs `[hostNow, hostNow + lookAheadMinutes)` with explicit UTC timestamps and `includeAllDay: false`. This is elapsed-minute look-ahead, including across DST. The selected timezone controls presentation; it does not move an absolute occurrence or convert this template into local-midnight/all-day matching.

W1 descriptors should expose a template ID/revision, typed bounded controls and opaque connection/account options. The host constructs tool arguments. Never send raw MCP arguments, secrets, executable fields or internal fingerprints to phones. Intervals, lifecycle, approval summaries and native management belong to W1, not to the adapter.

## Comparison and bounds

Mail lists the chosen mailbox/account before searching. Each search page requests 50 messages and reuses every filter with the exact opaque `nextCursor`. Only explicit `nextCursor: null` terminates successfully. Missing/repeated cursors, repeated message identities, an empty nonterminal page, wrong mailbox, invalid selected fields, unknown index metadata, page errors or a sixth required page fail the entire check. No partially collected items escape on failure. At most 250 messages and five pages are accepted; a person must narrow a larger watch.

Envelope uses newest-first keyset pagination by received timestamp and row ID. Each page is its own local-index read snapshot; the traversal is not an atomic server snapshot. New messages above an in-progress cursor can appear on the next poll. Ordering and local index counts do not affect comparison. Mail signatures include nullable subject, nullable sender email, received instant and read state. The initial result establishes a baseline; later additions and meaningful edits produce changes. Disappearance updates the local baseline without a deletion wake: Mail explicitly reports server sync status as **unknown**, so an empty local index never proves a server mailbox is empty. There is no message-body or attachment fetch.

Calendar fetches at most 250 graph entries and rejects unsupported outer pagination/truncation fields. It validates entries before filtering EventKit's already-started overlaps. Only timed occurrences starting inside the current half-open window participate. Identity is an unambiguous tuple of provider event ID and absolute occurrence start, since recurring occurrences share the EventKit ID. Signatures contain title, start/end instants, location and known status. Equivalent timezone offsets and incidental metadata do not change the signature.

`compareImcpWatch` can admit current noncancelled Calendar entries on the first check. Its returned Calendar baseline is an occurrence ledger, preserving seen signatures when windows shrink, timezone labels change or the process restarts. The ledger retains entries for one day after their start and caps at 2,000; overflow fails rather than evicting a future identity and repeating it. W1 must persist this ledger atomically with the immutable pending transition, and must handle a host clock reversal larger than this retention explicitly rather than silently replaying old occurrences. Output records are copied so later caller mutation cannot alter a previous baseline.

An explicit canceled status produces one cancellation change for an observed active occurrence. A missing event never proves cancellation. A changed occurrence start produces a new identity; a title/location/end/status edit at the same occurrence produces an update. EventKit may remove canceled events rather than return them, and this API exposes neither an original recurrence start nor a deletion/change cursor. The prototype therefore cannot guarantee deletion reporting, distinguish every recurrence exception from a reschedule, or observe a reschedule/cancellation outside the fetched window. W1 must address those requirements before promising complete calendar-change watches.

Every raw result and MCP envelope/decoded JSON is bounded to 256 KiB, 10,000 visited nodes and depth 16. The adapter refuses cycles, accessors, sparse arrays, malformed JSON, non-text MCP content, multiple content parts, tool errors and conflicting text/structured representations. Mailbox/calendar option lists cap at 500. Titles, identifiers, cursors and selected fields have individual bounds. There is no content execution, model invocation or error payload interpolation.

## Validation and remaining acceptance

Run the executable synthetic spike with:

```sh
npm exec -- tsx --test main/services/bot-routine-events/connector-watch-imcp.test.ts
```

The focused suite covers account binding, exact cursor traversal and overflow, first-mail baseline, stable reordering/metadata, meaningful edits, local disappearance, malicious/incomplete envelopes, duplicate calendar names, relative window entry, overlap boundaries, occurrence identity, persistent comparison across restart/window changes, explicit cancellation, rescheduling, spring/fall DST, ledger overflow, revocation between pages, deadline and delayed-result fencing. Fixtures use invented `.test` addresses and independent expected epoch values; no personal connector data was recorded. Root `npm run type-check` and narrow ESLint also passed during W0 implementation.

Before W1 production admission: inspect an explicitly configured real connector's installed tool inventory and schemas; verify its trusted read metadata and already-granted permissions; complete the Calendar exact-account/recurrence/cancellation gaps above; test multiple accounts, duplicate names, pagination, local Mail indexing, disconnected/permission-revoked failures and installed-version drift. Real-account testing must follow a person's explicit configured connection and approval. No background sign-in or permission prompt is acceptance. Composio requires authenticated schema/response evidence before a vendor adapter can be implemented. Runtime authority, durable comparison/delivery integration, full desktop/iOS/Android management and lifecycle tests remain W1 work.

## Foreground installed-inventory observation (2026-11-03)

A read-only inspection of Aiden’s existing Composio Tools drawer found generic orchestrators including `COMPOSIO_GET_TOOL_SCHEMAS`, `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL` and `COMPOSIO_PROXY_EXECUTE`, with no direct Gmail/Calendar readers. No credentials, email or event contents were read and no connector settings changed. This confirms that the currently configured route does not satisfy the original direct-read-only-tool policy. A follow-up owner question asks whether to add a host-constructed, one-operation, exact-account Composio read adapter or keep Calendar gated until a direct trusted connector closes the identity gap. Neither option has been treated as approved yet.
