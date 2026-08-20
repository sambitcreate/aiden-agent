# Aiden Remote contract tests

The normative API is [`../protocol/aiden-remote/v1/openapi.json`](../protocol/aiden-remote/v1/openapi.json). Cross-platform fixtures live under `../protocol/aiden-remote/v1/fixtures/`.

Desktop and Swift tests must agree on protocol versioning, pairing, error envelopes, bounds, opaque handles, revision/idempotency preconditions, SSE sequence and terminal behavior, and forbidden private fields. A passing decoder test is not permission to add an undocumented endpoint or payload.
