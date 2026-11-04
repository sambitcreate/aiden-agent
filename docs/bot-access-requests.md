# When a Bot asks for a folder

A Bot with Custom access limited to selected folders can ask to read and change files outside those folders. Its card names the folder, shows its location and explains why it is needed. New Bots still start with Full access, so this does not add a first-run permission step.

The choices are:

- **Allow once** lets the current task use that folder for at most an hour. A new task, quitting Aiden or changing the Bot's access ends the grant. A person's steer that joins the same task can use it; a queued follow-up starts a new task and cannot inherit it.
- **Always for this folder** adds that exact folder to the Bot's saved Custom access. It also lets the current task continue. The Bot keeps its other saved choices. If it was saved just as the task ended, Aiden reports **Folder approval recorded** and does not grant temporary access to the ended task. This acknowledges the earlier approval; replaying it never restores access you later removed.
- **Not now** leaves access unchanged. The Bot carries on without that folder and does not ask for it again in the same task.

Each task can have one extra temporary folder at a time. Approving another folder replaces the previous Allow once grant. Saved Always folders remain part of the Bot's Custom access. Requesting an already available saved folder does not replace a different Allow once grant. A folder saved from an unattended issue becomes available to later tasks; the original unattended task carries on without it.

A temporary grant from an access card is unavailable while an unattended routine, Telegram or Bot input joins that run. A person's joined steer remains supported. A temporary validation-read failure stops that file call, but does not discard a still-live task approval. Retrying must pass the current owner, permissions and deadline checks again.

A request for **your whole Mac** offers only Allow once and Not now. It is never saved as an Always grant. File access turned off is not a route to requesting more access; change that choice yourself in the Bot's Advanced settings.

Folder cards that offer Always can show how often you allowed that exact
folder in the last two weeks. After three approvals without a recent denial,
a later Allow once can prompt one brief reminder about **Always for this
folder**, at most once a week. Whole-Mac requests never count; folders without
an Always choice never offer the reminder. Retries keep the original choice
and count it once. If an earlier Always was saved before its acknowledgement
arrived, a later retry records that earlier approval without restoring access
you removed. See [Allowed without asking](bot-rules.md#allowed-without-asking).

## What an approval covers

The grant applies to the file tools and the folder shown on the card. It does not grant a connection, browser sign-in, computer control or permission to approve another card. Bot file tools cannot overwrite Aiden’s remembered approvals or folder-publication journal. Protected Aiden storage stays protected, including during temporary Home or whole-Mac access and recursive file searches.

The model supplies a requested path, but the host resolves it and checks the real folder. A file path resolves to its containing folder. A symlink into Aiden's private storage is refused. If the folder is inside a larger approved root, Always is not offered for the larger root instead. Aiden does not widen the requested folder.

If you change the Bot's permissions, replace the folder or change overlapping folder approvals while a card waits, an old answer grants nothing. The old attempt closes without recording a decline, and the Bot can make a fresh request. Aiden does not silently approve the new scope. If the saved-grant journal is unreadable, Always fails closed while Allow once and Not now still use the normal current-permission checks. A request that no longer matches those permissions closes and can be made again.

## When nobody is watching

A routine, Telegram turn or message from another Bot does not open an access card. It leaves a Needs you issue in the Bot's chat and carries on without access.

A persistable folder issue can offer **Allow this folder**. That saves access for future work; it does not resume the original task or restore an expired Allow once grant. A whole-Mac request points you to the Bot's access settings. Every access issue also offers **Not now**, which dismisses it without granting access. A later request with changed permissions or folder identity gets a fresh issue. If you grant the folder separately through a card or Settings, an earlier issue can remain until the Bot requests it again. Use Not now to clear that earlier issue; it does not remove the separately saved access. If an Allow action saved its grant before an interrupted answer, and you later remove that grant or replace the folder, retrying the old issue closes it as superseded. It does not restore access or report a new grant.

## Phones and other hosts

Supported iOS and Android clients can answer access cards and folder issues on the paired desktop. The host remains responsible for validating the original card and granting access. An older phone or paired desktop gets a line telling you to answer on the Mac. Access issues and their alerts are shown only to clients that support them; hidden access issues do not increase older clients’ issue counts.

A folder approved for a Bot does not appear in the phone's file browser or its list of shared folders. Other Custom Bots may list it as an available choice in their access settings, but they receive no grant until you select it for them. Approving the same folder explicitly for phone browsing makes it a normal shared folder. You can also approve a containing folder for phones; the Bot keeps its original narrower selection.

The CLI host does not offer `request_access`. Configure its saved Bot grants through the existing administration controls. See [durable CLI Bots](cli-durable-bots.md).

Startup finishes interrupted Bot deletions even when a folder approval still needs cleanup. Removing an unused approval record never deletes the person’s folder. If a permission save cannot finish its storage checkpoint, access changes stay paused until restart can verify the committed state; Aiden keeps the pending approval instead of treating it as absent.

The [implementation plan](plans/bot-messaging-plan.md) tracks phase B review and acceptance. Local tests and simulator checks are separate from physical-device, live-provider and release acceptance.

On supported paired iOS and Android clients, a repeated folder card shows its approval count only while the host grants both `bot:access-requests` and `bot:allowed`. Older clients keep the same access choices without that count. A live Allow once can earn a short weekly hint even when settlement happens after the original choice. Historical recovery never earns a new hint; retrying an exact choice retains its original result.
