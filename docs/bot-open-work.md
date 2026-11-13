# Open work

On the desktop, open **Open work** from the Bot's **Advanced** tab (click the Bot's name in its chat); the Activity tab also links to it and shows its active count. On iPhone or Android, open the Bot's **Profile → Open work**.

When Tasks is enabled in the Bot’s access, it can record responsibilities it accepts from your current request or an accepted routine, including a manual Run now. The host binds each record to the actual input. Future ideas, hidden introductions and self-generated wake-ups cannot create owner-authorized work this way. Recording work uses a tool during the existing turn; there is no extra extraction model or background scan. Turning Tasks off also removes the work summary from the Bot’s context. You can still manage its records yourself.

**Add work** saves a responsibility for the Bot’s next turn. It does not submit a message or schedule a run. Titles, notes and states can be edited on every client:

- **Open** means unfinished.
- **Waiting** includes a short reason.
- **Done** says who marked it done and offers a supporting reply when one is available.
- **Dismissed** keeps it in History. Dismissing does not stop execution.

Running, queued and interrupted labels come from the owning host’s current execution state. They are not saved claims that stay “running” after a crash. A completed turn does not automatically mark its work done. **View request** and **View reply** open the actual linked entries, including retained entries from before compaction. Large entries show an explicitly labelled excerpt. The model and clients cannot supply arbitrary source paths or result receipts.

Approved [Bot messaging](bot-messaging.md) also links incoming and outgoing responsibilities to their exchange. **View exchange** opens its request, outcome and retained evidence. These records identify a Bot source and do not impersonate your own request. Older paired clients omit peer-sourced work and peer links until they support `bot:peers`.

**Undo last change** is available for an applicable reversible change for up to twenty-four hours, including after restarting an app. A later edit or Stop prevents an older Undo from overwriting it. Undoing Add moves the record to Dismissed so its identity and source remain retained. Undo never reverses an external action.

**Stop linked run** targets only the item’s linked input. Other queued messages are preserved and continue under their own access and spending checks while the Bot is running. A paused or interrupted Bot is never automatically resumed. If a run combines several inputs, Aiden explains that it cannot stop one separately here. **Stop and dismiss** dismisses only after the host confirms the linked work stopped or was already finished. While any device’s Stop is pending, other item edits and Undo wait for acknowledgement. A reopened paused Bot may need an explicit Resume before its cancellation can finish. A missing acknowledgement stays uncertain; it does not mean that work is done or that earlier effects were undone. Stop has no Undo.

Edits use the saved revision. A conflicting change returns the current state and keeps your draft for review. Before transmitting a mutation, each client saves its identity and exact contents on that device. A lost response or an unavailable storage outcome keeps that request for an explicit same-request retry. Reading equal-looking text never proves that a change happened. A current host receipt can confirm it. Ordinary retry receipts are retained for at least twenty-four hours; pending Stop receipts remain until settled or the Bot is deleted.

Each Bot keeps at most 64 active and 128 terminal records. Applicable Undo and pending Stop records are protected from history pruning. Full history or retry capacity refuses a change rather than dropping unfinished work. Unreadable storage is reported and is not replaced with an empty list.

Desktop pending changes are removed after confirmed Bot deletion, including saved Resume and Bot messaging requests and when a window reopens after deletion. Cleanup requires the Bot to be absent from both the host’s stored identities and its authenticated authority state; a filtered list, missing row or storage error cannot trigger it. Pending changes for other Bots remain intact, and late callbacks cannot recreate requests for the deleted Bot. Phones also invalidate that Bot’s pending controllers on confirmed deletion and clear their host-scoped journals when their pairing is removed.

The owning desktop stores the records privately. Phones need the negotiated **bot:open-work** capability with Bot and chat read access; mutations also require Bot write access. An older or unsupported host cannot offer management. The standalone **aiden serve** host does not advertise these optional management ports yet. Open work is available on macOS and Linux desktops wherever Bots are available.
