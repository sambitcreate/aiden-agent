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
import type {
  FirstMessageWorktreeInfo,
  FirstMessageWorktreeProgress,
  FirstMessageWorktreeRequest,
  FirstMessageWorktreeResult,
} from "../../renderer/shared/worktree-on-send.js";
import {
  FirstMessageWorktreeError,
  FirstMessageWorktreeSettingsChangedError,
} from "./first-message-worktree.js";

type Owner = Pick<RendererDocumentOwner, "documentId" | "isDestroyed" | "onInvalidated">;

interface Dependencies {
  store: Pick<ReturnType<typeof createChatStore>, "get" | "createWithFirstMessage">;
  beginTurn(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null;
  requiresReconciliation(ownerId: string): boolean;
  markReconciliation(ownerId: string): void;
  clearReconciliation(ownerId: string): void;
  admitWorkspace(workspaceId: string, owner: Owner): WorkspaceOperationAdmission;
  workspaceExists(workspaceId: string): Promise<boolean>;
  resolveSkill(workspaceId: string, invocationId: string): Promise<RegisteredSkill>;
}

/** Own the draft-to-durable handoff independently of renderer navigation. */
export function createFirstMessageCommitter(deps: Dependencies) {
  // Entries live only as long as the bounded turn lease. Their append payload
  // reservation stays charged while the completed receipt is cached, so sends
  // that never hand off to generation cannot bypass the memory budget.
  const pending = new Map<string, { ownerId: string; fingerprint: string; promise: Promise<Chat> }>();

  return (input: ParsedChatFirstMessage, owner: Owner): Promise<Chat> => {
    if (input.worktree) throw new Error("A first message in a new worktree needs the worktree commit path.");
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
        assertCurrent();
        const userMessageId = randomUUID();
        const append = (prepared?: { provenance: SkillProvenanceV1 }) => deps.store.createWithFirstMessage({
          id: input.chatId,
          title: input.title,
          workspaceId: input.workspaceId,
          providerId: input.providerId,
          model: input.metaModel,
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
              // A first send in a new worktree carries a skill chosen (and
              // bound) in the draft's source workspace; resolve it there.
              resolveFresh: (workspaceId, invocationId) =>
                deps.resolveSkill(input.skillWorkspaceId ?? workspaceId, invocationId),
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

const WORKTREE_FAILURE_REASONS = {
  preparing: "Aiden couldn't prepare the new worktree.",
  fetching: "Aiden couldn't fetch the base branch.",
  creating: "Aiden couldn't create the new worktree.",
  ready: "Aiden couldn't create the new worktree.",
} as const;

function worktreeFailure(error: unknown): FirstMessageWorktreeResult<never> {
  if (error instanceof FirstMessageWorktreeSettingsChangedError) {
    const { workspaceId, branch, baseRef, fromOrigin, requestedBranchName } = error.worktree;
    return {
      ok: false,
      code: "worktree-settings-changed",
      reason: error.message,
      worktree: {
        workspaceId,
        branch,
        baseRef,
        fromOrigin,
        ...(requestedBranchName === undefined ? {} : { branchName: requestedBranchName }),
      },
    };
  }
  const phase = error instanceof FirstMessageWorktreeError ? error.phase : "preparing";
  const message = error instanceof Error ? error.message.trim() : "";
  return {
    ok: false,
    code: "worktree-failed",
    reason: WORKTREE_FAILURE_REASONS[phase],
    ...(message ? { detail: [...message].slice(0, 500).join("") } : {}),
  };
}

interface WorktreeCommitDependencies {
  /** The ordinary first-message commit, run against the new worktree workspace. */
  commit(input: ParsedChatFirstMessage, owner: Owner): Promise<Chat>;
  ensureWorktree(
    request: FirstMessageWorktreeRequest,
    seed: string,
    owner: Owner,
    onProgress: (progress: FirstMessageWorktreeProgress) => void,
  ): Promise<FirstMessageWorktreeInfo>;
  /** Resolve a skill selection in the workspace it was chosen in (throws when stale). */
  resolveSkill(workspaceId: string, invocationId: string): Promise<unknown>;
}

/**
 * First send with New worktree: create (or reuse) the draft's managed worktree,
 * then save the chat in it. A worktree failure saves nothing and returns a
 * recoverable `worktree-failed` result; chat-save failures throw as usual and
 * leave the worktree recorded for the retry.
 */
export function createWorktreeFirstMessageCommitter(deps: WorktreeCommitDependencies) {
  return async (
    input: ParsedChatFirstMessage,
    owner: Owner,
    onProgress: (progress: FirstMessageWorktreeProgress) => void = () => undefined,
  ): Promise<FirstMessageWorktreeResult<Chat>> => {
    const { worktree: request, ...plain } = input;
    if (!request) throw new Error("This first message did not ask for a worktree.");
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    if (input.skillReference) {
      // The selection is bound to the draft's (source) workspace. Check it
      // before creating anything, so a stale skill never leaves a worktree.
      await deps.resolveSkill(request.sourceWorkspaceId, input.skillReference.invocationId);
    }
    let worktree: FirstMessageWorktreeInfo;
    try {
      worktree = await deps.ensureWorktree(request, input.content || input.title || "", owner, onProgress);
    } catch (error) {
      return worktreeFailure(error);
    }
    const chat = await deps.commit({
      ...plain,
      workspaceId: worktree.workspaceId,
      ...(input.skillReference ? { skillWorkspaceId: request.sourceWorkspaceId } : {}),
    }, owner);
    return { ok: true, chat, worktree };
  };
}
