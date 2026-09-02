# Design Project lifecycle transactions

Design Projects own a durable chat, immutable HTML artifact revisions, links to
content-addressed reference images, comments, and ephemeral Designer Actions.
Those records live in separate stores, so duplicate and delete are coordinated
by `design-project-lifecycle.ts` and the owner-only
`design-project-lifecycle.json` recovery journal.

## Duplicate commit boundary

1. Mint the target project and deterministic target chat identities.
2. Journal `preparing` before any dependent write.
3. Use `chatStore.copyVisibleHistory(...beforeInstall)` and
   `generativeUiArtifactStore.prepareSelectedCopy()` so every copied artifact
   byte exists before the copied chat becomes visible.
4. Commit the prepared artifact rows, rename the copied chat, and journal
   `prepared`.
5. `DesignProjectStore.duplicate()` compare-and-swap publishes the project row.
6. The lifecycle wrapper clears the journal only after that call returns.

On restart, an installed target project proves commit and preserves the copied
chat. Without that row, recovery removes the copied chat first and its artifact
bytes second. Reference images are immutable and content-addressed, so a
duplicate shares the bytes and receives its own project links.

Callers must use the lifecycle coordinator's `duplicate()` method rather than
calling the configured project's `duplicate()` method directly; the project
store preparation port deliberately has no post-commit callback.

## Delete commit boundary

1. `planDelete()` captures the project/database revisions plus the exact chat,
   artifact, reference-image, comment, and Designer Action identities.
2. Persist the `planned` journal record before deleting anything.
3. Compare-and-swap remove the project row. This publication is the irreversible
   roll-forward boundary.
4. Remove comments and Designer Actions captured by the plan, then route the
   chat through the ordinary main-owned chat deletion service so its private
   subagent, staged artifact, Pi effect, compaction, and chat payload stores use
   their existing recoverable deletion contract.
5. Re-read every remaining project and delete only confirmed reference-image
   candidates that are still unreferenced.
6. Clear the lifecycle journal.

If Aiden stops after step 3, startup sees the project row is absent and finishes
the cascade. If it stops before step 3, the row remains and startup removes only
the uncommitted journal record. Per-store cascade deletes accept a subset of the
captured identities for idempotent recovery, but fail closed if a new comment or
Designer Action appeared after confirmation.

All project mutations and lifecycle recovery must share the coordinator's
process-local serialization lane. The coordinator's own duplicate/delete APIs
already enter it; update, rename, reference attachment, comment creation, and
Designer Action creation handlers use `runProjectMutation()`. This prevents an
in-process attachment or comment update from racing a captured cascade or the
final live-reference recheck used for reference-image cleanup. The durable
project database revision remains the cross-restart concurrency fence.

## Ordinary chat deletion

`routeChatDeletion()` resolves the authoritative project by chat ID. Ordinary
chats continue through the existing delete callback. A project-owned chat
instead raises `DesignProjectDeletionConfirmationRequiredError`, which carries
the exact bounded cascade plan. Deletion proceeds only when the caller returns
the matching project ID and project revision from that confirmation. This keeps
the sidebar chat action from silently stranding a project or bypassing the
Design library's cascade preview.

## Main-process integration

`design-project-store-main.ts` should construct the graph in this order:

1. lifecycle journal;
2. delegating duplicate port and comment/action cascade planner;
3. `DesignProjectStore` configured with both ports;
4. cascade port using the project store, chat application service, comment
   store, action service, and reference-asset store;
5. lifecycle coordinator;
6. `await lifecycle.recover()` after every dependent store initializes and
   before Design IPC is admitted.

The Design handlers should use coordinator `duplicate`, `previewDelete`, and
`deleteProject`. The ordinary chat removal handler should use
`routeChatDeletion`; it must return the confirmation-required payload to the
renderer instead of translating it into a generic delete failure.

Use `createIdempotentDesignProjectChatDelete({ chats: chatStore, application:
chatApplicationService })` for the cascade's chat callback. It avoids turning a
restart after the chat payload was already removed into a false recovery
failure while still routing an existing chat through all private-store cleanup.
