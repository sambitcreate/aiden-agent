# Durable Bots in the CLI

The CLI can host the desktop durable Bot-session core in a dedicated CLI profile. Enable it explicitly with `aiden bots enable-durable` while the daemon is running, then stop and restart the daemon with the same `serve` options. Enabling starts no inference, routine, self-introduction, or interrupted task. A new durable conversation starts for each Bot; legacy history remains available in its original chat and journal.

## Portable boundary and ownership

`packages/cli/src/bot-durable.ts` supplies the shared session service with a profile directory, bundled native lease helper, current capability admission, provider credentials, tools, approvals, memory, and preset creation. Session state, request deduplication, paused recovery, unsafe-tool replay, deletion fencing, and persistence remain implemented by `main/services/bot-runtime/`. The CLI pins both newly included packages, `pi-durable` and `chord`, to 1.5.2, the desktop's line; the desktop legacy adapter is unchanged. Pi Durable 1.4 upgrades a Bot's SQLite database to its schema version 2 the first time it opens; a CLI built on Pi 1.3.0 or earlier then refuses to open that Bot. Pi Durable 1.5 also moves a conversation's stored state forward the first time it writes to it (its `pi.live` document to version 3), so a CLI built on Pi 1.4.0 cannot read a Bot conversation that 1.5 has written to. Neither upgrade can be undone.

The daemon owns the CLI profile for its lifetime. A Bot's SQLite database and memory live under `<agentDir>/bots/<encodedBotId>/`; records, managed homes and grants remain in `<agentDir>/bot-service/`, and schedules remain in `<agentDir>/schedules.json`. Capability checkpoint anchors remain outside `bot-service`. Never point a CLI daemon at a desktop profile or let old and new daemon binaries write the same profile. Permanent lease guard files must not be deleted, renamed, or restored from backup.

The shared core has no Electron singleton wiring. The bundle build audits the transitive durable-host graph and rejects platform/Electron imports, except DataStore's existing lazy desktop default-root fallback. Every CLI DataStore consumer supplies its own root; the existing Electron stub fails loudly if the fallback is reached. Real bundle tests execute the durable runtime from outside the repository, exercising this boundary and the bundled native helper.

Each model request re-admits the Bot and resolves its current credentials before dispatch. Its signal follows revocation. Each tool effect rebuilds the exact granted tool under a fresh admission; offered tools do not retain released authority. All MCP calls require an explicit approval in this host. Bot-message approvals keep the host-owned delivery deadline and expiry provenance; public approval responses omit private run/input ownership. Approvals can be answered from a paired phone or `aiden bots approve <wait-id> allow|deny`. Granted connection and file tools replay as unsafe; `message_bot` uses the shared durable replay receipt. No catalog refresh, provider connection, or background memory review is introduced.

## Migration and recovery

The explicit switch first writes a `preparing` marker, which blocks new legacy Bot generations, then cancels and drains any active legacy Bot turn. It writes a private backup at `<agentDir>/bot-migration-backups/<uuid>/` containing complete Bot chat records and original Pi journal bytes. A recovery manifest records the format and chat count. Only after those writes succeed does the marker become `enabled`. It does not clear or overwrite any chat, journal, managed home, grant, schedule, or provider credential.

Until the daemon restarts, legacy Bot inference stays blocked and the new Remote features stay unavailable. The next daemon opens paused durable storage and inspects unfinished work. Interrupted conversation work waits for an explicit Resume. The messaging courier then reattaches deliveries the person already authorized; it may start a pending message or reply when its destination is idle. Other existing workspace automation retains its ordinary scheduler behavior.

A failed backup leaves `preparing` in place and inference blocked. Correct the reported storage problem and run `aiden bots enable-durable` again; it makes a fresh backup, preserving the failed attempt for inspection. Repeating a completed switch returns the original backup. The backup contains private conversation content and must be protected like the profile. Recovery backups are retained independently of active Bot deletion; remove them explicitly when rollback is no longer needed.

For rollback, stop the daemon first, retain the whole profile, and move only `bot-durable-v1.json` to a separate recovery filename. Restarting the prior CLI path uses the untouched legacy chats. Durable SQLite conversations remain in place for later recovery; rollback does not merge them into legacy history, and a CLI on Pi 1.3.0 or earlier cannot open them once a Pi 1.4 daemon has. Restore damaged legacy conversation content from `legacy-chats.json` only while stopped and after retaining the damaged originals. Do not restore authority checkpoints, credentials, or lease guards from a conversation backup.

## Supported surface

| Capability | Desktop host | CLI after explicit switch |
| --- | --- | --- |
| Durable Send, Resume, Dismiss, Stop, hard delete | Supported | Shared core and existing Remote endpoints |
| Stable request deduplication and paused restart | Supported | Shared core |
| Bot messaging (phase A) | Supported | Shared tool, private ledger, courier and Remote switches; no desktop delivery funnel |
| Folder access requests (`request_access`, phase B) | Desktop host only | The CLI does not offer access cards or temporary run grants; its saved Custom grants still apply |
| Plan approval (`propose_plan`, `plan_step`, phase C) | Desktop and capability-gated paired phones | No plan tools, coverage or `bot:plans` capability |
| Allow list (phase D) | Pending implementation | Unavailable |
| Bot memory tools, recall, person edits | Supported | Shared store and existing Remote endpoints |
| Routines | Supported | Shared routine service/executor; paused turns are skipped |
| Pause and unpause (the person's switch) | Supported | `aiden bots pause` and `unpause` through the shared core and its pause file: a running turn is stopped and waits for Resume or Dismiss after unpause. Paired devices see a paused Bot as unavailable, and an open session stream hears the change at once. Devices can't pause or unpause a CLI Bot (those routes need `bot:handoffs`) |
| Hand-offs, `sign_in`, Bot rules, Bot computers | Supported (Bot computers on Apple silicon only) | Unavailable; `bot:handoffs` is not advertised |
| Starter presets | Supported | Shared crash-safe starter and creation-key store |
| Connection approvals | Supported | Local CLI or paired Remote approval response |
| Codemode scripts over connection, file, shell and lookup tools | Supported | Shared core (Pi Durable codemode); each scripted MCP call asks for approval like a direct one, and a pending one survives Resume |
| Rarely used tools load on demand (`load_tools`) | Supported | Shared core; see [tool-loading.md](tool-loading.md) |
| Automatic memory review/compaction steering | Supported | Unavailable; no background review is started |
| Proactivity proposals and notification feed | Supported | Unavailable; feature withheld |
| Rich activity, staged attachments, connection setup | Supported | Unavailable; features withheld |
| Companion-image inspection and read-only subagent forks | Supported | Calling durable conversation supplies the immutable transcript and attachment snapshot |

Capability negotiation advertises only wired endpoints. Existing native clients use their established feature fallbacks. Messaging uses Remote revision 54 and the `bot:messaging` capability. A capable device receives `list.messaging.enabled` and `detail.botMessaging` with `receive` and `send`; identity patches accept either per-Bot switch and `PUT /bots/messaging` accepts `{enabled: boolean}`. Older devices retain the shared transcript fallback and receive no messaging settings fields. Pause support arrived with revision 37, which the CLI serves without `bot:handoffs`.

The Bot CLI additionally exposes `session`, `send`, `resume`, `dismiss`, `stop`, `delete`, `approvals`, and `approve`. Send takes a JSON file containing `text` and a stable `requestId`; Resume and Dismiss take a stable request ID as their third argument. Keep the same ID when retrying an uncertain result.

## Bot messaging

Messaging is profile-local and defaults on. The global switch reads `botMessaging` from `<agentDir>/aiden.json`; only `false` is stored. Per-Bot receive/send switches use the same false-only representation in the shared Bot store. Turning a switch off blocks new sends; accepted deliveries retain their original deadline. The CLI keeps its granted tool list and memory tools, and adds `message_bot` only under the shared ingress and switch rules. Reply, routine, Telegram, intro and hop-2 turns cannot send messages, and scripts cannot call the tool.

The ledger is `<agentDir>/bots/bot-messages.json`, written atomically with mode `0600`. Immutable deletion markers live in `bots/.bot-messages.json.pending-purges/`. The courier purges a deleted Bot before its managed home and Bot record are erased, starts after session initialization, and disposes before runtime shutdown. It never resumes or interrupts the person's work to deliver a message. Corrupt messaging bookkeeping disables messaging while leaving other Bot features available. A roster check reads only local authority, model grants, pause state and spending; it starts no session or model request and fails closed for an unreadable Bot.

Bot responses count toward the Bot that runs them in the profile-local `spending.json`. Monthly and routine limits use the shared spending rules and `aiden.json` spending settings. Spending reads and the messaging roster make no provider or catalog requests. This host has no desktop delivery funnel or proactive notification feed.

## Acceptance

The bundled parity suite exercises preservation, failed-backup recovery, duplicate requests, memory persistence, routine deduplication, process-death Resume/Dismiss, paused routine refusal, pausing and unpausing from the CLI (a running turn stopped and left for Resume, the pause surviving a restart, and an open session stream hearing it), and revocation. Shared desktop runtime tests cover the same core. macOS and Linux bundle/runtime acceptance, native capability fallback, and physical pairing/background behavior are separate gates; passing local storage tests does not establish physical-device acceptance.

## Optional desktop management

Accepted scheduled inputs retain host-issued routine provenance verified against the CLI scheduler’s task/run store; a public send cannot claim that origin.

Open work’s protected store/tool and linked execution helpers are shared-core code, but the Electron host owns the current Open work management integration. The standalone CLI does not advertise `bot:open-work` or serve its optional routes. This does not add an interactive CLI or a second scheduler.

Routine-model configuration and its `bot:routine-models` management capability are also wired by the Electron host only. Shared scheduler claim hooks remain optional so the CLI keeps its current model defaults and existing durable routine flow. The standalone CLI does not offer the desktop’s protected routine grants or unconfirmed-cost acknowledgement controls.

Bot peers and their `bot:peers` capability are also Electron-host features. The CLI does not install the pair authority or delivery actor, expose pair/exchange management, or offer `message_peer`. Paired clients leave those controls unavailable for a CLI host.
The bundled parity suite uses a local fake SSE provider for an Alpha-to-Beta message, Beta's Pong answer and both projected transcript rows, then checks capability-gated HTTPS list/detail responses, global and per-Bot switches, false-only persistence and public approval redaction. It also checks spending attribution and unreadable spending state. The existing suite exercises preservation, failed-backup recovery, duplicate requests, memory persistence, routine deduplication, process-death Resume/Dismiss, paused routine refusal, pausing and unpausing from the CLI (a running turn stopped and left for Resume, the pause surviving a restart, and an open session stream hearing it), and revocation. Shared desktop runtime tests cover the same core. macOS and Linux bundle/runtime acceptance, native capability fallback, and physical pairing/background behavior are separate gates; passing local storage tests does not establish physical-device acceptance.
