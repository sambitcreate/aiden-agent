import { createHash, randomUUID } from "node:crypto";
import type { ParsedChatFirstMessage } from "../handlers/chat-first-message-params.js";
import type { Chat } from "./types.js";
import type { ChatTurnLease } from "./chat-turn-admission.js";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";
import type { WorkspaceOperationAdmission } from "./workspace-operation-registry.js";
import type { createChatStore } from "./chat-store-core.js";
import { isChatCreateReconciliationRequiredError } from "./chat-store-core.js";
import { AppendReconciliationRequiredError } from "./chat-append-commit.js";
import { appendReconciliationFailureMessage } from "../../renderer/shared/chat-message-contract.js";
import { commitSkillInvocationForAppend } from "./skill-invocation-turn.js";
import type { RegisteredSkill } from "./skill-registry.js";
import type { SkillProvenanceV1 } from "../../renderer/shared/slash-commands.js";

type Owner = Pick<RendererDocumentOwner, "documentId" | "isDestroyed" | "onInvalidated">;

interface Dependencies {
  store: Pick<ReturnType<typeof createChatStore>, "get" | "createWithFirstMessage">;
  beginTurn(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null;
  requiresReconciliation(ownerId: string): boolean;
  markReconciliation(ownerId: string): void;
  clearReconciliation(ownerId: string): void;
  admitWorkspace(workspaceId: string, owner: Owner): WorkspaceOperationAdmission;
  workspaceExists(workspaceId: string): Promise<boolean>;
  requireComputerUseReady(signal: AbortSignal): Promise<void>;
  resolveSkill(workspaceId: string, invocationId: string): Promise<RegisteredSkill>;
}

/** Own the draft-to-durable handoff independently of renderer navigation. */
export function createFirstMessageCommitter(deps: Dependencies) {
  // Entries live only as long as the bounded turn lease. Their append payload
  // reservation stays charged while the completed receipt is cached, so sends
  // that never hand off to generation cannot bypass the memory budget.
  const pending = new Map<string, { ownerId: string; fingerprint: string; promise: Promise<Chat> }>();

  return (input: ParsedChatFirstMessage, owner: Owner): Promise<Chat> => {
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    if (deps.requiresReconciliation(owner.documentId)) {
      throw new Error(appendReconciliationFailureMessage("blocked"));
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const inFlight = pending.get(input.chatId);
    if (inFlight) {
      if (inFlight.ownerId !== owner.documentId || inFlight.fingerprint !== fingerprint) {
        throw new Error("This draft is already sending a different message.");
      }
      return inFlight.promise;
    }
    const turn = deps.beginTurn(input.chatId, input.turnId, owner.documentId);
    if (!turn) throw new Error("Wait for the previous response to finish saving before sending again.");
    turn.onReleased(owner.onInvalidated(turn.release));
    try {
      turn.reserveAppendPayload(input.retainedBytes);
      if (input.skillReference) turn.reserveSkillPreparation();
    } catch (error) {
      turn.release();
      turn.settleAsyncWork();
      throw error;
    }
    const entry = { ownerId: owner.documentId, fingerprint, promise: undefined as unknown as Promise<Chat> };
    pending.set(input.chatId, entry);
    turn.onReleased(() => {
      if (pending.get(input.chatId) === entry) pending.delete(input.chatId);
    });
    entry.promise = (async () => {
      let committed = false;
      let workSettled = false;
      let workspace: WorkspaceOperationAdmission | undefined;
      try {
        workspace = deps.admitWorkspace(input.workspaceId, owner);
        const admittedWorkspace = workspace;
        const abortTurn = () => turn.release();
        workspace.signal.addEventListener("abort", abortTurn, { once: true });
        turn.onReleased(() => {
          admittedWorkspace.signal.removeEventListener("abort", abortTurn);
          // Revocation must drain an in-flight store write before the owning
          // workspace may be deleted or repurposed.
          if (workSettled) {
            admittedWorkspace.release();
            turn.settleAsyncWork();
          }
        });
        if (workspace.signal.aborted) abortTurn();
        const isCurrent = () => turn.isActive() && !owner.isDestroyed() && !workspace!.signal.aborted;
        const assertCurrent = () => {
          if (!isCurrent()) throw new Error("The workspace or message turn changed before the chat could be saved.");
          if (deps.requiresReconciliation(owner.documentId)) {
            throw new Error(appendReconciliationFailureMessage("blocked"));
          }
        };
        const existing = await deps.store.get(input.chatId);
        assertCurrent();
        if (existing) {
          if (existing.firstMessageCommit?.turnId !== input.turnId ||
              existing.firstMessageCommit.fingerprint !== fingerprint) {
            throw new Error("This draft identifier has already been used for a different message.");
          }
          // A replay after the original lease settled confirms delivery but
          // must not authorize a second generation for the same user message.
          return existing;
        }
        if (!(await deps.workspaceExists(input.workspaceId))) {
          throw new Error("The selected workspace is no longer available.");
        }
        if (input.computerUseEnabled) await deps.requireComputerUseReady(workspace.signal);
        assertCurrent();
        const userMessageId = randomUUID();
        const append = (prepared?: { provenance: SkillProvenanceV1 }) => deps.store.createWithFirstMessage({
          id: input.chatId,
          title: input.title,
          workspaceId: input.workspaceId,
          providerId: input.providerId,
          model: input.metaModel,
          computerUseEnabled: input.computerUseEnabled,
          turnId: input.turnId,
          fingerprint,
          message: {
            id: userMessageId,
            content: input.content,
            model: input.messageModel,
            attachments: input.attachments,
            skill: prepared?.provenance,
          },
          assertCurrent,
        });
        const chat = input.skillReference
          ? await commitSkillInvocationForAppend({
              invocationId: input.skillReference.invocationId,
              role: "user",
              content: input.content,
              attachments: input.attachments,
              workspaceId: input.workspaceId,
              userMessageId,
            }, {
              resolveFresh: deps.resolveSkill,
              isCurrent,
              prepareLease: (prepared) => turn.prepareSkillInvocation(prepared),
              append,
            })
          : await append();
        committed = true;
        return chat;
      } catch (error) {
        if (isChatCreateReconciliationRequiredError(error)) {
          deps.markReconciliation(owner.documentId);
          owner.onInvalidated(() => deps.clearReconciliation(owner.documentId));
          throw new AppendReconciliationRequiredError();
        }
        throw error;
      } finally {
        workSettled = true;
        if (!committed) turn.release();
        if (!turn.isActive()) workspace?.release();
        // A successful receipt remains in pending until handoff/abandon/expiry.
        // Keep its payload capacity reserved for exactly that same lifetime.
        turn.settleAsyncWork({ retainAppendPayloadUntilRelease: committed && turn.isActive() });
      }
    })();
    return entry.promise;
  };
}
