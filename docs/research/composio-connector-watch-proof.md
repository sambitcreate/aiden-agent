# Restricted Composio watch adapter: proof boundary

Research date: 2026-11-03. Status: candidate contracts identified; authenticated schema and exact-account execution proof remain pending. This record supports plan D8 and does not enable Calendar or claim live mail/calendar acceptance.

## What was actually inspected

- The configured, enabled built-in connector uses the catalog's fixed `https://connect.composio.dev/mcp` endpoint and `x-consumer-api-key` authentication. Its credential and binding exist in the desktop encrypted secret store. No key, ciphertext or account identifier was copied into this report.
- The already running installed Aiden app's Settings → Connectors → Composio → Tools list exposes twelve meta-tools, including Search Tools, Get Tool Schemas and Multi Execute. Its rows contain names and access switches, with no input-schema disclosure or invocation control. No access switch, Test, Connect, Manage or sign-in control was used. The original app view was restored.
- No authenticated MCP request, app-tool call, account/calendar listing, email read or event read was performed. No production configuration or credential was changed. The credential loader is Electron-owned and includes a possible legacy-binding migration; it was not invoked from an external research process. No Keychain extraction or replacement credential helper was attempted.

The concrete blocker is the absence of an app-owned read-only diagnostic invocation surface, rather than a missing configured credential. A foreground inspection port inside Aiden can use its existing bound credential without exporting it and obtain the missing schemas. Until then, the installed MCP executor's actual `account` support and upstream response shapes are unverified.

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
