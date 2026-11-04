import type { BotAccessChoice } from "../../../renderer/shared/bot-access-requests.js";
import type { BotFolderGrantInput } from "../bot-folder-grant-journal.js";
import { BotRuntimeAuthorityError } from "../bot-runtime-authority.js";
import type { BotAccessResolution } from "./bot-access-target.js";
import { BotAccessRequestStaleError, type BotAccessAuthorizationReceipt, type BotAccessRequestPrompt, type BotAccessTallyProof } from "./bot-access-requests.js";
import { BOT_RUN_ACCESS_MAX_AGE_MS, type BotRunAccess, type BotRunAccessGrant } from "./bot-run-access.js";
import type { BotAdmission } from "./bot-tool-assembly.js";

/** Shared pure wiring so both admission phases are exercised without Electron. */
export function createBotAccessRevalidator(deps: {
  policyRevision(botId: string): Promise<string>;
  canonicalChatId(botId: string): Promise<string | null | undefined>;
  admit(botId: string, chatId: string): Promise<BotAdmission>;
}): BotAccessAuthorizerDeps["revalidate"] {
  return async (botId, expectedRevision) => {
    const stale = () => new BotAccessRequestStaleError("This Bot's access changed. Ask for access again.");
    if (await deps.policyRevision(botId) !== expectedRevision) throw stale();
    const chatId = await deps.canonicalChatId(botId);
    if (!chatId) throw new BotAccessRequestStaleError("This Bot's task is no longer available.");
    const admission = await deps.admit(botId, chatId);
    try {
      if (admission.authority.accessMode !== "custom" || admission.authority.files.mode !== "scoped" ||
        await deps.policyRevision(botId) !== expectedRevision) throw stale();
      await admission.revalidateBeforeEffect();
    } finally {
      admission.release();
    }
  };
}

export interface BotAccessAuthorizerDeps {
  now(): number;
  audienceId: string;
  runAccess: BotRunAccess;
  resolveTarget(path: string): Promise<BotAccessResolution>;
  /** Fresh scoped Custom admission and exact policy revision, released by the caller. */
  revalidate(botId: string, expectedRevision: string): Promise<void>;
  /** Returns the exact journaled publication revision, never an unconstrained current read. */
  grantFolder(input: BotFolderGrantInput, owner: { assertCurrent(): void }): Promise<string>;
  folderCommitted?(botId: string, operationId: string): Promise<boolean>;
  changed(botId: string): void;
  /** Capture only after exact live owner/policy/path validation. */
  captureDecision?(prompt: BotAccessRequestPrompt, choice: BotAccessChoice): BotAccessTallyProof | undefined;
}
export function createBotAccessAuthorizer(deps: BotAccessAuthorizerDeps) {
  return async (prompt: BotAccessRequestPrompt, choice: BotAccessChoice): Promise<void | BotAccessAuthorizationReceipt> => {
    // A retained prompt may belong to a publication whose receipt read failed.
    // Acknowledge history before consulting today's owner or policy.
    if (prompt.target === "folder" && prompt.grant && prompt.choices.includes("always")) {
      try {
        if (await deps.folderCommitted?.(prompt.botId, prompt.waitId)) return { savedForFuture: true };
      } catch (error) {
        // Always needs exact history to prevent another publication. Other
        // choices can proceed only through the live owner/policy/target checks
        // below, which refuse an earlier publication's changed policy.
        if (choice === "always") throw error;
      }
    }
    const auth = prompt.authorization,
      owner = prompt.owner;
    const assertOwner = () => {
      if (
        !owner ||
        owner.signal.aborted ||
        !Number.isFinite(owner.deadline) ||
        deps.now() >= owner.deadline
      )
        throw new BotAccessRequestStaleError("This access request is no longer active. Ask again.");
    };
    assertOwner();
    await owner!.validate();
    assertOwner();
    if (
      !auth.requestIds.length ||
      !auth.choices.includes(choice) ||
      auth.target !== prompt.target ||
      (choice === "always" &&
        (auth.target !== "folder" ||
          !prompt.grant ||
          prompt.grant.folderPath !== auth.root ||
          prompt.grant.rootId !== auth.rootId))
    )
      throw new Error("That answer doesn't match the card.");
    try {
      // Both admission and revalidateBeforeEffect may detect definite drift.
      // Only the real classified error has this meaning; I/O stays retryable.
      await deps.revalidate(prompt.botId, auth.policyRevision);
    } catch (error) {
      if (error instanceof BotRuntimeAuthorityError)
        throw new BotAccessRequestStaleError(error.message);
      throw error;
    }
    const target = await deps.resolveTarget(auth.target === "whole_mac" ? "whole_mac" : auth.root);
    if (
      target.kind !== auth.target ||
      (target.kind === "folder" &&
        (target.root !== auth.root ||
          target.device !== auth.identity?.device ||
          target.inode !== auth.identity?.inode ||
          target.inventoryRevision !== auth.inventoryRevision ||
          (choice === "always" &&
            (target.always.kind === "none" ||
              (target.always.kind === "existing" ? target.always.rootId : undefined) !==
                auth.rootId))))
    )
      throw new BotAccessRequestStaleError("That folder changed. Ask for access again.");
    assertOwner();
    const tally = deps.captureDecision?.(prompt, choice);
    const decisionReceipt = tally ? { tally } : undefined;
    if (choice === "not_now") return decisionReceipt;
    let revision = auth.policyRevision;
    if (choice === "always") {
      try {
        revision = await deps.grantFolder(
          {
            audienceId: deps.audienceId,
            botId: prompt.botId,
            folderPath: auth.root,
            ...(auth.rootId ? { rootId: auth.rootId } : {}),
            expectedRevision: auth.policyRevision,
            expectedIdentity: auth.identity!,
            ...(auth.inventoryRevision ? { expectedInventoryRevision: auth.inventoryRevision } : {}),
            operationId: prompt.waitId,
            ...(tally ? { approvalTally: { version: 1 as const, ...tally } } : {}),
          },
          { assertCurrent: assertOwner },
        );
      } catch (error) {
        // Receipt lookup itself may fail after publication. Only the exact
        // durable operation can turn that ambiguous result into success.
        if (!(await deps.folderCommitted?.(prompt.botId, prompt.waitId))) throw error;
        try { deps.changed(prompt.botId); } catch { /* observer only */ }
        return { savedForFuture: true, ...(tally ? { tally } : {}) };
      }
    }
    // An Always changes the policy. Its exact publication receipt is the only
    // acceptable replacement revision; a fresh unrelated revision is refused.
    try {
      await deps.revalidate(prompt.botId, revision);
      await owner!.validate();
      const finalTarget = await deps.resolveTarget(
        auth.target === "whole_mac" ? "whole_mac" : auth.root,
      );
      if (
        finalTarget.kind !== auth.target ||
        (finalTarget.kind === "folder" &&
          (finalTarget.root !== auth.root ||
            finalTarget.device !== auth.identity?.device ||
            finalTarget.inode !== auth.identity?.inode ||
            (choice === "once" && finalTarget.inventoryRevision !== auth.inventoryRevision)))
      ) {
        throw new BotAccessRequestStaleError("That folder changed. Ask for access again.");
      }
      assertOwner();
      const now = deps.now();
      const grant: BotRunAccessGrant = {
        requestIds: auth.requestIds,
        target: auth.target,
        key: auth.target === "whole_mac" ? "whole_mac" : auth.root,
        root: auth.root,
        label: prompt.label,
        ...(auth.identity ? { identity: auth.identity } : {}),
        policyRevision: revision,
        access: "write",
        owner: { kind: "access", id: prompt.waitId },
        grantedAt: now,
        expiresAt: Math.min(owner!.deadline, now + BOT_RUN_ACCESS_MAX_AGE_MS),
      };
      deps.runAccess.grant(prompt.botId, grant);
      // Only a successful live Always, at its exact publication revision,
      // supplies this proof. Receipt recovery and fresh fixed reads never do.
      if (choice === "always") deps.runAccess.recordPublication(prompt.botId, grant, owner!);
    } catch (error) {
      // Publication is the durable effect. Later owner/policy/path failure
      // must acknowledge the save without creating temporary run authority.
      if (choice !== "always") throw error;
      try { deps.changed(prompt.botId); } catch { /* observer only */ }
      return { savedForFuture: true, ...(tally ? { tally } : {}) };
    }
    try {
      deps.changed(prompt.botId);
    } catch {
      /* An observer cannot undo a validated answer. */
    }
    return decisionReceipt;
  };
}

/** D bookkeeping around B's real authorization. Only primitive receipts survive
 * a retry; no owner callback or temporary authority is reconstructed here. */
export function createBotAccessDecisionSettlement(deps: {
  now(): number;
  allowList: Pick<import("./bot-allow-list.js").BotAllowList, "decision" | "settleFolder">;
  receipts(botId: string, decisionId: string): Promise<readonly import("./bot-allow-list.js").BotFolderApprovalReceipt[]>;
}) {
  const pendingAlways = new Map<string, BotAccessTallyProof>();
  const offered = (prompt: BotAccessRequestPrompt) => prompt.choices.includes("always") && prompt.approvalCount !== undefined;
  const choiceOf = (answer: import("./bot-approval-tallies.js").BotApprovalAnswer): BotAccessChoice => answer === "allow" ? "once" : answer === "allow_always" ? "always" : "not_now";
  return {
    captureDecision(prompt: BotAccessRequestPrompt, choice: BotAccessChoice): BotAccessTallyProof | undefined {
      if (prompt.target !== "folder" || !prompt.authorizationFingerprint) return undefined;
      const previous = choice === "always" ? pendingAlways.get(prompt.waitId) : undefined;
      if (previous) return { ...previous };
      const proof = { authorizationFingerprint: prompt.authorizationFingerprint, offered: offered(prompt), decidedAt: deps.now() };
      if (choice === "always") pendingAlways.set(prompt.waitId, proof);
      return proof;
    },
    forgetInactive(waitIds: ReadonlySet<string>) {
      for (const id of pendingAlways.keys()) if (!waitIds.has(id)) pendingAlways.delete(id);
    },
    async authorize(prompt: BotAccessRequestPrompt, choice: BotAccessChoice,
      authorize: (prompt: BotAccessRequestPrompt, choice: BotAccessChoice) => Promise<void | BotAccessAuthorizationReceipt>): Promise<void | BotAccessAuthorizationReceipt> {
      if (prompt.target === "folder" && prompt.authorizationFingerprint) {
        const saved = await deps.allowList.decision(prompt.botId, prompt.waitId, prompt.authorizationFingerprint);
        if (saved?.source === "person") return { effectiveChoice: choiceOf(saved.answer), ...(saved.answer === "allow_always" ? { savedForFuture: true as const } : {}) };
      }
      return authorize(prompt, choice);
    },
    async settle(prompt: BotAccessRequestPrompt, choice: BotAccessChoice, receipt: BotAccessAuthorizationReceipt | undefined): Promise<BotAccessAuthorizationReceipt | undefined> {
      if (prompt.target !== "folder" || !prompt.authorizationFingerprint) return receipt;
      if (choice === "always") {
        // The original journal context is authoritative even on Once/Not now
        // taps recovering an earlier publication. Legacy receipts skip D.
        const records = await deps.receipts(prompt.botId, prompt.waitId);
        for (const record of records) await deps.allowList.settleFolder(record);
        return receipt;
      }
      const result = await deps.allowList.settleFolder({ botId: prompt.botId, path: prompt.authorization.root,
        decisionId: prompt.waitId, authorizationFingerprint: prompt.authorizationFingerprint, source: "person", answer: choice,
        offered: receipt?.tally?.offered ?? offered(prompt), label: prompt.label,
        ...(receipt?.tally ? { decidedAt: receipt.tally.decidedAt } : {}) });
      return { ...receipt, ...result };
    },
    async reconcileAbsent(botId: string, decisionId: string): Promise<boolean> {
      const records = await deps.receipts(botId, decisionId);
      for (const record of records) await deps.allowList.settleFolder(record);
      return records.length > 0;
    },
  };
}
