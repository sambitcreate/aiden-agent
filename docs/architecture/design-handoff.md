# Design handoff architecture

Status: Implemented. Coordinator, production effects, startup recovery, IPC, chat/model context,
renderer confirmation, cancellation, recovery, and project linkage are connected.

## Boundary

**Continue in workspace** graduates one immutable Prototype revision into an ordinary workspace task. It does not turn the Design Project into a source-writing authority. The handoff coordinator has no filesystem, Git, command, model, provider, staging, commit, push, pull-request, deployment, or application-source write API.

The only content crossing the boundary is a parsed `DesignHandoffPacketV1`:

- Design Project ID and compare-and-swap revision;
- immutable source bundle, lineage, and revision IDs plus its SHA-256 and byte size;
- content-addressed reference asset IDs;
- bounded, normalized design-decision summaries; and
- bounded desktop, tablet, and phone dimensions.

The exact-key parser rejects unknown fields. In particular, there is no field for a prompt, transcript, internal project JSON, provider/model credentials, absolute path, arbitrary source bytes, tool authority, or source-write instruction. Decision text is conservatively rejected when it resembles a credential, absolute path, or serialized internal JSON. The installed packet is explicitly untrusted design context; subsequent implementation uses normal workspace chat permissions, file-tool approval, and Review.

## Target confirmation

The durable journal is path-free. Both target variants contain a renderer-safe four-label preview (`workspaceId`, workspace label, repository label, and branch label) and a SHA-256 digest of that exact preview. A production `verifyTarget` port must re-resolve authoritative main-process state immediately before any effect and return the same parsed target.

The default target is an Aiden-managed worktree. The confirmation records committed `HEAD`, whether the source checkout was dirty, and the exact disclosure acknowledgment when dirty: uncommitted source-checkout changes are not included. `prepareWorkspace` must use the existing managed-worktree application service, create from that committed `HEAD`, and return matching `createdFromHead` evidence.

An existing authorized workspace is accepted only with the exact strong-warning acknowledgment and target-preview digest. Main revalidates the workspace ID and the preview before use. This path reuses the existing workspace; it does not create or remove a worktree.

## Journal and publication boundary

`DesignHandoffJournalStore` owns `design-handoffs.json` under Electron `userData`. It uses `DataStore` atomic replacement, mode `0600`, a 2 MiB read ceiling, strict versioned parsing, a maximum of 128 records, compare-and-swap revisions, external reload before writes, and fail-closed corrupt/unsafe-file handling. It retains active and recoverable records; the oldest terminal record may be evicted only when the bound is reached.

The coordinator advances these durable stages:

```text
prepared
  -> workspace-ready
  -> chat-ready
  -> context-ready
  -> published
```

Every effect receives the stable operation ID and must be idempotent by that ID. A crash after an effect but before its journal checkpoint therefore repeats discovery of the same worktree, chat, context installation, or project link rather than creating another one. Illegal stage skips, identity replacement, cancellation clearing, and stale revisions are rejected.

Project-link publication is the visible commit boundary. A publication call with an unknown outcome is reconciled with `inspectPublication(operationId)` before retry or rollback. The published linkage records the project, workspace, chat, task, and branch display identity. Publication does not grant the Prototype future workspace authority.

## Cancellation and recovery

Before publication, cancellation is journaled and rollback is attempted in reverse order:

1. remove the installed handoff context;
2. remove the new chat/task; and
3. roll back the new managed workspace.

Rollback ports also discover effects solely by operation ID. This covers cancellation or a crash between an external effect and its journal checkpoint. Each rollback returns a proof result. If any result is unknown or false, the coordinator stops destructive rollback, preserves the remaining workspace, and records a renderer-safe `recoverable` reason. It never reports the repository unchanged without proof.

If publication is observed—or cancellation arrives after the published checkpoint—the coordinator preserves the linked workspace and records `recoverable`. Startup can call `resumeRecoverable()` to resume nonterminal records idempotently. Terminal `published` and `rolled-back` entries are not replayed.

## Production port mapping

The core deliberately defines injected ports. Production integration should map them as follows:

- `verifyTarget`: authoritative config/workspace/Git-state resolution, including dirty state and committed HEAD;
- `prepareWorkspace`: existing `workspaceWorktreeApplicationService.create` for managed targets, or authoritative lookup for the explicitly acknowledged existing workspace;
- `createChat`: existing chat application service, tagged durably by handoff operation ID;
- `installUntrustedContext`: a bounded main-owned task-context record, not a hidden user prompt or source write;
- `publishProjectLink`: one compare-and-swap Design Project update that makes the task linkage visible;
- `inspectPublication`: authoritative Design Project lookup by operation ID;
- rollback ports: existing chat/worktree cleanup services plus durable proof that the operation-owned effect is absent.

The production adapters must preserve the operation ID in their own effect records so “idempotent” is a verified property, not a coordinator assumption. They must not shell out directly; Git and worktree work stays behind existing application services.

## Production effect integration

`DesignHandoffEffectStore` owns a second owner-only, bounded ledger, `design-handoff-effects.json`. The coordinator journal records the cross-store state machine; this effect ledger records the operation-keyed identities needed to rediscover effects after a crash. It stores only workspace/chat/task IDs, renderer-safe labels, the parsed handoff packet, and the published linkage. It does not store repository paths, source bytes, prompts, credentials, Git capabilities, or tool authority.

The existing managed-worktree and chat application services do not accept a caller-owned effect ID. The production adapter therefore derives a deterministic `feature/design-handoff-<digest>` branch and a visible `Design handoff · <digest>` chat title from the operation ID. Before creating either effect it searches authoritative main-owned records for that tag. The effect ledger then binds the discovered/generated workspace and chat identities to the operation. An ambiguous discovery fails closed.

Managed target inspection pairs the current Review snapshot with the cohesive committed Git `HEAD`. `verifyTarget` repeats that inspection immediately before any effect and requires the exact preview, dirty state, and commit the person confirmed. Worktree creation remains behind `workspaceWorktreeApplicationService.create`; its returned `createdFromHead` must equal the confirmation. A new managed handoff workspace is changed to `ask` permission before chat creation, so ordinary source writes and shell work retain Aiden's approval gates. An existing workspace retains its already-authorized permission and is never deleted by handoff rollback.

The workspace chat is an ordinary non-Bot chat. Aiden currently has no separate durable Task entity, so the published `taskId` is the chat ID; both identities remain explicit in the linkage. The packet is installed in the main-owned effect ledger as untrusted task context, not appended as a hidden system/user prompt. `contextForChat(chatId)` adds that bounded context to the visible task and accepted model turn.

Before context installation and again at publication, the production binding verifies the Design Project CAS revision, generated-artifact lineage/revision membership, committed source byte length and SHA-256, and the existence and project ownership of each content-addressed reference asset. Publication writes a separate project-indexed linkage in the effect ledger; it does not grant workspace authority back to the prototype or modify the project snapshot.

`designHandoffApplicationService.initialize()` initializes the effect ledger. `reconcileAtStartup()` is an explicit startup hook that resumes every nonterminal journal independently, returning renderer-safe failures while logging private diagnostics. The service also exposes target previews, begin/cancel/resume, project links, and chat context for the main handler layer.

## Current limitations

Handoff creates or reuses a local workspace and an ordinary Aiden chat/task. It does not implement
hosted collaboration, deployment, pull-request creation, or automatic source writes. Recoverable
records remain explicit and can be resumed or cancelled from the owning project.
