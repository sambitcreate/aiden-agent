# Aiden Remote contract tests

The normative API is [`../protocol/aiden-remote/v1/openapi.json`](../protocol/aiden-remote/v1/openapi.json). Cross-platform fixtures live under `../protocol/aiden-remote/v1/fixtures/`.

Desktop and Swift tests must agree on protocol versioning, pairing, error envelopes, bounds, opaque handles, revision/idempotency preconditions, SSE sequence and terminal behavior, and forbidden private fields. A passing decoder test is not permission to add an undocumented endpoint or payload.

Connector-watch coverage lives in `AidenBotWatchTests` and the focused watch methods in `AidenRemoteClientTests`. The Xcode test target copies the shared `bot-watches.json` fixture. Cases cover safe Codable projections, required identity/revision and bounds, private-field rejection, explicit source discovery, typed saved/draft testing, current grant and pairing fences, stale edits, removal, unknown outcomes with frozen mutation identities retained across denied retries and write-grant changes, authoritative settlement racing a denied retry, pause/resume/delete, Run now admission, and older-host capability fallback, protected restart retention and pairing purge, expired replay refusal, and corrupt local attempt fail-closed behavior. Simulator results are regression evidence; they do not substitute for physical pairing, sleep/reconnect or provider/account acceptance.
