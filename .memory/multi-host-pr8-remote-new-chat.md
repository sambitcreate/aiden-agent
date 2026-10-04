# Multi-host PR 8: new chat on a paired Mac, remote Bots — 2026-10-04

Branch `feat/multi-host-pr8-remote-new-chat`, stacked on PR 7 (`feat/multi-host-pr7-remote-control`). Plan doc: `docs/plans/completed/desktop-multi-host-pr8-remote-new-chat.md`.

## Where things live

- `renderer/lib/hosts/remote-new-chat.ts`: `RemoteNewChatControl`. It creates the chat with a pending key, stages uploads, then sends with a fresh key. `createWorkspace`, `createFolderWorkspace` and `openBotChat` are keyed intents. Pending keys and the unresolved first turn live in the window-lifetime `remoteNewChatMemory` (per host); the first turn itself is a `send` intent in PR 7's `chatIntentLedger`, so the opened chat's `ChatSessionControl` shows and retries it.
- `renderer/lib/hosts/host-resources.ts`: the model catalog and `defaultHostModel`, folder pages, skills, and the `hostResultValue` helpers.
- `renderer/lib/hosts/remote-attachments.ts`: converts composer attachments into upload bodies.
- `renderer/lib/hosts/new-chat-targets.ts`: the machine list with disabled reasons, the project choices and the Bot groups.
- `renderer/main/remote-new-chat-view.tsx`: the `/host/$hostId/new` route, pane and folder browser dialog.
- `renderer/main/remote-bots.tsx`: the paired Macs' Bots, shown below the local roster in the Bots area.
- `main/services/peer-operation.ts`: adds the `uploadAttachment` operation (unkeyed, request cap raised to 12 MiB) and the `removeAttachment` operation.

## Invariants to keep

- A remote route never reaches a local API. Every `/host/...` route suppresses the workbench, terminal and browser.
- A lost create keeps its key for the same project and model, so a retry returns the same chat. A definite refusal releases the key.
- A lost first message is reconciled by main with one `GET /chats/{id}` and is never replayed automatically. Retry reuses the same key, from the new-chat route or the opened chat.
- A folder project's selection is minted once per intent; a retry after a lost answer replays the original body and key (a new selection would be refused as `already_exists`).
- `ChatIntent.attachmentIds` carries a send's staged uploads; dismiss and a definitely refused retry release them (host limit: 20 unused uploads per device and chat).
- Uploads are unkeyed. An ambiguous upload is `upload_failed`, and an unconfirmed upload expires on the host.
- Queue and steer refuse attachments and skills.
- Drafts are per host: `hostResourceKey({hostId, resourceId: "draft:new-chat"})`.
- The Assistant stays host-local. Remote Bot chats are canonical per Bot.

## Testing

- The shared harness `main/services/peer-remote-chat-test-host.ts` takes per-host `capabilities` and `features`, a `routes` hook (return `UNHANDLED` to fall through) and `idempotent()` over its ledger. `peer-remote-new-chat.test.ts` uses these to model projects, the folder browser, chats, uploads and Bot chats with schema-valid answers.
- Throwing `PeerTransportError("unavailable")` after the host applied a change simulates a lost answer.
- A host refusal reaches the renderer as `code: "request_failed"` with `remoteCode` set to the host's code, for example `not_found`.
