# Durable Bots in the CLI

The CLI can host the desktop durable Bot-session core in a dedicated CLI profile. Enable it explicitly with `aiden bots enable-durable` while the daemon is running, then stop and restart the daemon with the same `serve` options. Enabling starts no inference, routine, self-introduction, or interrupted task. A new durable conversation starts for each Bot; legacy history remains available in its original chat and journal.

## Portable boundary and ownership

`packages/cli/src/bot-durable.ts` supplies the shared session service with a profile directory, bundled native lease helper, current capability admission, provider credentials, tools, approvals, memory, and preset creation. Session state, request deduplication, paused recovery, unsafe-tool replay, deletion fencing, and persistence remain implemented by `main/services/bot-runtime/`. The CLI pins both newly included packages, `pi-durable` and `chord`, to 1.4.0, the desktop's line; the desktop legacy adapter is unchanged. Pi Durable 1.4 upgrades a Bot's SQLite database to its schema version 2 the first time it opens; a CLI built on Pi 1.3.0 or earlier then refuses to open that Bot.

The daemon owns the CLI profile for its lifetime. A Bot's SQLite database and memory live under `<agentDir>/bots/<encodedBotId>/`; records, managed homes and grants remain in `<agentDir>/bot-service/`, and schedules remain in `<agentDir>/schedules.json`. Capability checkpoint anchors remain outside `bot-service`. Never point a CLI daemon at a desktop profile or let old and new daemon binaries write the same profile. Permanent lease guard files must not be deleted, renamed, or restored from backup.

The shared core has no Electron singleton wiring. The bundle build audits the transitive durable-host graph and rejects platform/Electron imports, except DataStore's existing lazy desktop default-root fallback. Every CLI DataStore consumer supplies its own root; the existing Electron stub fails loudly if the fallback is reached. Real bundle tests execute the durable runtime from outside the repository, exercising this boundary and the bundled native helper.

Each model request re-admits the Bot and resolves its current credentials before dispatch. Its signal follows revocation. Each tool effect rebuilds the exact granted tool under a fresh admission; offered tools do not retain released authority. All MCP calls require an explicit approval in this host. Approvals can be answered from a paired phone or `aiden bots approve <wait-id> allow|deny`. Tools replay as unsafe. No catalog refresh, provider connection, or background memory review is introduced.

## Migration and recovery

The explicit switch first writes a `preparing` marker, which blocks new legacy Bot generations, then cancels and drains any active legacy Bot turn. It writes a private backup at `<agentDir>/bot-migration-backups/<uuid>/` containing complete Bot chat records and original Pi journal bytes. A recovery manifest records the format and chat count. Only after those writes succeed does the marker become `enabled`. It does not clear or overwrite any chat, journal, managed home, grant, schedule, or provider credential.

Until the daemon restarts, legacy Bot inference stays blocked and the new Remote features stay unavailable. The next daemon opens paused durable storage and inspects unfinished work; only an explicit Send or Resume starts inference. Other existing workspace automation retains its ordinary scheduler behavior.

A failed backup leaves `preparing` in place and inference blocked. Correct the reported storage problem and run `aiden bots enable-durable` again; it makes a fresh backup, preserving the failed attempt for inspection. Repeating a completed switch returns the original backup. The backup contains private conversation content and must be protected like the profile. Recovery backups are retained independently of active Bot deletion; remove them explicitly when rollback is no longer needed.

For rollback, stop the daemon first, retain the whole profile, and move only `bot-durable-v1.json` to a separate recovery filename. Restarting the prior CLI path uses the untouched legacy chats. Durable SQLite conversations remain in place for later recovery; rollback does not merge them into legacy history, and a CLI on Pi 1.3.0 or earlier cannot open them once a Pi 1.4 daemon has. Restore damaged legacy conversation content from `legacy-chats.json` only while stopped and after retaining the damaged originals. Do not restore authority checkpoints, credentials, or lease guards from a conversation backup.

## Supported surface

| Capability | Desktop host | CLI after explicit switch |
| --- | --- | --- |
| Durable Send, Resume, Dismiss, Stop, hard delete | Supported | Shared core and existing Remote endpoints |
| Stable request deduplication and paused restart | Supported | Shared core |
| Bot memory tools, recall, person edits | Supported | Shared store and existing Remote endpoints |
| Routines | Supported | Shared routine service/executor; paused turns are skipped |
| Pause and unpause (the person's switch) | Supported | `aiden bots pause` and `unpause` through the shared core and its pause file: a running turn is stopped and waits for Resume or Dismiss after unpause. Paired devices see a paused Bot as unavailable, and an open session stream hears the change at once. Devices can't pause or unpause a CLI Bot (those routes need `bot:handoffs`) |
| Hand-offs, `sign_in`, Bot rules, Bot computers | Supported (Bot computers on Apple silicon only) | Unavailable; `bot:handoffs` is not advertised |
| Starter presets | Supported | Shared crash-safe starter and creation-key store |
| Connection approvals | Supported | Local CLI or paired Remote approval response |
| Codemode scripts over connection, file, shell and lookup tools | Supported | Shared core (Pi Durable codemode); each scripted MCP call asks for approval like a direct one, and a pending one survives Resume |
| Automatic memory review/compaction steering | Supported | Unavailable; no background review is started |
| Proactivity proposals and notification feed | Supported | Unavailable; feature withheld |
| Rich activity, staged attachments, connection setup | Supported | Unavailable; features withheld |
| Companion-image inspection and read-only subagent forks | Supported | Calling durable conversation supplies the immutable transcript and attachment snapshot |

Capability negotiation advertises only wired endpoints. Existing native clients use their established feature fallbacks. The durable CLI switch itself changed no Remote protocol fields or revision; pause support arrived with revision 37, which the CLI serves without `bot:handoffs`.

The Bot CLI additionally exposes `session`, `send`, `resume`, `dismiss`, `stop`, `delete`, `approvals`, and `approve`. Send takes a JSON file containing `text` and a stable `requestId`; Resume and Dismiss take a stable request ID as their third argument. Keep the same ID when retrying an uncertain result.

## Acceptance

The bundled parity suite exercises preservation, failed-backup recovery, duplicate requests, memory persistence, routine deduplication, process-death Resume/Dismiss, paused routine refusal, pausing and unpausing from the CLI (a running turn stopped and left for Resume, the pause surviving a restart, and an open session stream hearing it), and revocation. Shared desktop runtime tests cover the same core. macOS and Linux bundle/runtime acceptance, native capability fallback, and physical pairing/background behavior are separate gates; passing local storage tests does not establish physical-device acceptance.
