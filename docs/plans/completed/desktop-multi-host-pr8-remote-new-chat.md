# Multi-host PR 8: new chat on a remote machine, and remote Bots

Status: **Complete**; merges with the multi-host stack. Row 8 of the [desktop multi-host control plan](desktop-multi-host-control-plan.md) (§5 Renderer). Stacked on PR 7 ([remote control](desktop-multi-host-pr7-remote-control.md)).

PR 7 made an existing remote chat controllable. This PR lets this Mac start work on a paired Mac: choose the machine in the composer, pick or create one of that Mac's projects, pick one of its models, attach files, and send. It also lists the paired Macs' Bots so their chats can be opened from here. Acceptance: a new chat runs on B in B's project, and no remote path reaches a local API.

## Scope

- **Machine picker.** A new local, non-Bot chat shows a machine picker when paired hosts exist (`RemoteMachinePicker` in `renderer/components/remote-new-chat-pickers.tsx`). Choosing a paired Mac navigates to `/host/$hostId/new`. The machine list (`newChatMachines` in `renderer/lib/hosts/new-chat-targets.ts`) names why a Mac cannot be used: offline, still connecting, or no `chat:write` grant. Disabled hosts are not listed. The sidebar's host menu gains **New chat on <Mac>**.
- **Remote new-chat pane** (`renderer/main/remote-new-chat-view.tsx`). It renders the real `Composer` with the remote surfaces, plus a project picker, a model picker and the machine picker. It states which Mac the chat runs on. Sending is held back, with the reason shown, until a project is chosen, the host is reachable and the control is connected. The workbench, terminal and browser are suppressed on every `/host/...` route.
- **Projects and the folder browser.**
  - Projects come from the host feed's workspaces, newest first.
  - **No project** creates a scratch project on send, which then becomes the selection.
  - **Choose a folder…** opens a browser over the host's shared roots (`/workspace-browser/roots`, `/children`). Locations are opaque `loc_` tokens. A single-use `sel_` selection is minted just before `POST /workspaces` (`selected-folder`), once per intent: after a lost answer, choosing the same folder again replays the original body and key.
  - Project management needs `workspace:manage`, and browsing needs `workspace:browse`.
- **Models.** The picker lists the host's `/models` catalog, hiding hidden models, and preselects the host's default. The choice travels in `POST /chats` as `providerId` and `modelId`.
- **`RemoteNewChatControl`** (`renderer/lib/hosts/remote-new-chat.ts`). A framework-free control bound to one host:
  - `start(target, text, uploads)` creates the chat with a pending idempotency key, stages the uploads into it, then sends the first message with its own key.
  - `createWorkspace` and `openBotChat` are keyed intents.
  - Every request goes through PeerHostManager and the remote host adapter. Nothing falls back to a local call.
- **Attachments.** `POST /chats/{id}/attachments` stages each file on the host. The turn names the staged `att_` IDs, and the host consumes them. The composer's attach button, drop and paste are offered whenever the adapter has `attach` (`chat:write`), both for an existing remote chat and a new one. The peer transport raises its request cap only for this operation, to 12 MiB.
- **Skills.** An existing remote chat offers the host's skills (`$`) when the host shares `chat-skills-v1` and grants `skills:invoke`. A new remote chat offers none, because skills are per chat. Local `/` commands stay off for remote chats.
- **Per-host drafts.** The new-chat draft key is `hostResourceKey({hostId, resourceId: "draft:new-chat"})`, so each Mac keeps its own draft and none collides with the local new-chat draft.
- **Remote Bots** (`renderer/main/remote-bots.tsx`, `renderer/components/remote-bots-section.tsx`).
  - The Bots area lists each paired Mac's Bots below the local roster, grouped by Mac. Archived Bots are excluded.
  - Opening one calls `POST /bots/{botId}/chats`, which needs `bot:read`, `bot:write` and `chat:write`, then navigates to the chat at `/host/$hostId/chat/$chatId`.
  - The Assistant stays host-local and is not listed.
- **No contract change.** Only existing contract revision operations are used. The peer operation table gains `uploadAttachment` and `removeAttachment`, both validated against the existing OpenAPI responses. iOS and Android are unaffected.

## Decisions

- **Lost answers.**
  - A lost create (`outcome_unknown`) surfaces as a retryable `create_unconfirmed`. The pending key is kept while the target (project and model) stays the same, so a retry returns the chat the host already made. A definite refusal releases the key.
  - A lost first message shows the unresolved banner with **Retry**, **Dismiss** and **Open chat**. Main reconciles a send with one `GET /chats/{id}` and never replays it. **Retry** resends with the same key, so the host returns the original turn.
  - The first message is recorded in PR 7's window-lifetime chat intent ledger under the new chat, so **Open chat** shows the same banner in the chat itself and its **Retry** replays the original key and uploads.
  - The pending create key and the unresolved first message also live in a window-lifetime `RemoteNewChatMemory` per host, so leaving the route or a grants change that rebuilds the adapter cannot mint a new key and create a second chat.
  - A lost answer to a folder project keeps the original request (with its selection) and key per folder location. Choosing the same folder again replays them, so the host answers from its idempotency record rather than refusing the folder as already registered. A new selection is minted only for a new intent or after a definite answer.
  - A refused first message keeps the empty chat for the next attempt.
  - Dismissing an unresolved send, or a retry the host definitely refuses, releases the uploads that send was staged with, in both a new and an existing chat, so they never count against the host's limit of 20 unused uploads.
- **Uploads are unkeyed.** An ambiguous upload becomes a retryable `upload_failed`. The client releases the uploads the host confirmed. An unconfirmed upload is never named in a turn and expires on the host.
- **Queue and steer refuse attachments and skills** on a remote run, because the run-input contract carries text only.
- **Bot chats are canonical.** The host returns a Bot's existing chat, so opening it twice lands in the same chat.
- **The machine picker appears only on a new local chat.** It is not offered inside a Bot chat or an existing chat, because those already belong to a machine.
- **No onboarding tile.** Starting work on another Mac requires pairing, which onboarding does not cover yet.

## Tests

- `main/services/peer-remote-new-chat.test.ts` covers the whole path end to end. It runs the new-chat control over the real remote adapter, main's live IPC handlers, peer operation encoding, response contract validation and PeerHostManager. The host behind them uses the real idempotency ledger and real projections. The suite covers:
  - a new chat lands in B's project with B's default model, and its upload is staged and consumed on B, with every request sent to B;
  - a lost create is retried into exactly one chat;
  - a refused project leaves nothing behind;
  - a lost first message is retried without a second turn;
  - a lost first message is offered in the opened chat, whose retry sends it once with its uploads;
  - a browsed folder becomes B's project, and a lost answer still makes one project;
  - a Bot's chat opens canonically;
  - a host without the grants refuses before anything is sent.
- The shared harness `peer-remote-chat-test-host.ts` gains per-host capabilities and features, a suite route hook and access to its idempotency ledger.
- `renderer/lib/hosts/remote-new-chat.test.ts`: key retention and release, staging order, unresolved retry and dismiss, recovery after the control is rebuilt, folder replay after a lost answer, and upload release on dismiss or a refused retry.
- `renderer/lib/hosts/host-resources.test.ts`: the model catalog and default model, folder pages and skills.
- `renderer/lib/hosts/chat-session-control.test.ts`: attachment staging for an existing remote chat, and upload release when an unresolved send is dismissed or refused on retry.
- `renderer/lib/hosts/new-chat-targets.test.ts`: machine availability reasons, project ordering, Bot grouping and search-parameter parsing.
- `renderer/main/remote-new-chat-view.test.tsx`: the pane's machine, project and model controls; blocked reasons; the unresolved banner; the folder list; and remote Bot grouping.
- `renderer/components/composer-attachments-mounted.test.tsx`: a remote new chat attaches and sends a file without this Mac's workspace access control.
