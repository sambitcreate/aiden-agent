# Ordinary chat archive contract

The host advertises `chat-archive-v1` in `/server.features`. Clients must gate Archive/Restore on that feature when connected to older hosts.

`PATCH /chats/{chatId}` accepts exactly one of `{ "title": "New title" }` or `{ "archived": true }` / `{ "archived": false }`, with the existing `If-Match` revision and `chat:write` authorization. The response is the normal Chat projection. `archivedAt` is an optional ISO 8601 timestamp in Chat and ChatSummary; active responses omit it. Archive/restore changes the revision. This operation applies to ordinary chats; Bot lifecycle authorization remains unchanged.

`GET /chats` and `GET /chat-summaries` exclude archived chats by default. `includeArchived=true` includes both active and archived chats, allowing an Archived screen to filter and restore. Summary pagination requires the same filter for each cursor request. Detail reads remain available while archived. No transcript is deleted and a previously accepted assistant response may finish. New user-message appends are rejected inside the serialized store mutation until an explicit restore, preventing a send/archive race from creating a hidden turn.

Desktop internal lists remain inclusive. A remotely archived chat displays an explicit Restore chat action and disables sending without unmounting its composer. Typed `chats:restore` IPC calls the same host application mutation and returns the normal private-protocol-stripped projection. Host change notifications invalidate current desktop details as well as list metadata.

Verification: focused Remote/store/application/protocol tests cover revision mismatch, mixed mutation rejection, active/all filtering, persisted metadata, restoration, blocking user appends while permitting accepted assistant completion, malformed timestamps, feature advertisement and denied write capability. IPC/UI contract guards cover safe restore projection and retained composer. Native authors separately validate their consumers. No production account or physical device was modified for these tests.
