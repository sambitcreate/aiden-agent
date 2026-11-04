import {
  BOT_APPROVAL_RULES_PER_BOT_MAX, botAlwaysAllowLabel, botApprovalRuleKey, describeBotApprovalRule,
  type BotAllowedEntry, type BotApprovalRuleTarget,
} from "../../../renderer/shared/tool-approval-scope.js";
import { BOT_APPROVAL_RULES_PROFILE_MAX, type ToolApprovalRuleBook } from "../tool-approval-rules.js";
import type { BotApprovalDecision, BotApprovalTallies } from "./bot-approval-tallies.js";
import type { BotApprovals } from "./bot-approvals.js";
import type { BotApprovalSettlement, BotApprovalSettlementContext, BotApprovalSettlementInput, BotAllowListRelease } from "./bot-extension.js";
import type { BotAllowListPort } from "./bot-tool-assembly.js";

export interface BotFolderApprovalReceipt {
  botId: string; decisionId: string; path: string; authorizationFingerprint: string;
  offered: boolean; decidedAt: number; answer: "always"; source: "person";
}
export interface BotFolderApprovalInput {
  botId: string; path: string; decisionId: string; authorizationFingerprint: string; source: "person";
  answer: "once" | "always" | "not_now"; offered: boolean; decidedAt?: number; label?: string;
}
export interface BotAllowList extends BotAllowListPort {
  settle(input: BotApprovalSettlementInput, context?: BotApprovalSettlementContext): Promise<BotApprovalSettlement>;
  decision(botId: string, id: string, fingerprint: string): Promise<BotApprovalDecision | undefined>;
  list(botId?: string): Promise<BotAllowedEntry[]>;
  remove(botId: string, entryId: string): Promise<boolean>;
  folderOffer(botId: string, path: string): Promise<{ count: number } | undefined>;
  settleFolder(input: BotFolderApprovalInput): Promise<{ hint?: string }>;
  /** Read-only authority reconciliation. Missing operations remain pending. */
  reconcile(botId: string, folderReceipts?: readonly BotFolderApprovalReceipt[]): Promise<void>;
  forgetBot(botId: string): Promise<void>;
  onChange(listener: (botId: string) => void): () => void;
  changed(botId: string): void;
}
export interface BotAllowListDeps {
  rules: Pick<ToolApprovalRuleBook, "matchBot" | "grantBot" | "listBot" | "recordBotUse" | "revokeBot" | "forgetBot" | "botConsentRevision" | "botGrantOperation" | "onBotChange">;
  folderEntries(botId?: string): Promise<BotAllowedEntry[]>;
  revokeFolder(botId: string, sourceId: string): Promise<boolean>;
  tallies: BotApprovalTallies;
  approvals: Pick<BotApprovals, "pending" | "releaseFromAllowList">;
  botName(botId: string): Promise<string | undefined>;
  connectionName(serverId: string): Promise<string | undefined>;
  log?(message: string, error: unknown): void;
}
export function botApprovalNudgeHint(input: { label: string; count: number; choice: string; place?: string }): string {
  return `Aiden note: the person has approved “${input.label}” ${input.count} times in the last 14 days. Once, in one short sentence of your own, tell them they can stop being asked: “${input.choice}” on the next card${input.place ? `, or ${input.place}` : ""}. Don't bring it up again.`;
}
/** Startup has no live publication guard. Reconcile history independently for each Bot. */
export async function reconcileBotAllowListHistory(
  service: Pick<BotAllowList, "reconcile">,
  botIds: readonly string[],
  receipts: readonly BotFolderApprovalReceipt[],
  failed: (botId: string, error: unknown) => void,
): Promise<void> {
  for (const botId of botIds) {
    try { await service.reconcile(botId, receipts.filter(receipt => receipt.botId === botId)); }
    catch (error) { failed(botId, error); }
  }
}
export function createBotAllowList(deps: BotAllowListDeps): BotAllowList {
  const listeners = new Set<(botId: string) => void>();
  const changed = (botId: string) => { for (const listener of listeners) { try { listener(botId); } catch { /* observer */ } } };
  deps.rules.onBotChange(changed);
  const log = (error: unknown) => deps.log?.("The Bot's remembered approval could not be saved.", error);
  const clean = (value: string, fallback: string) => value.replace(/(?:https?:\/\/|file:\/\/)\S+/giu, "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200) || fallback;
  async function label(target: BotApprovalRuleTarget, title: string) {
    return target.kind === "connection" ? clean(`${clean(await deps.connectionName(target.serverId) ?? "Connected app", "Connected app")} · ${clean(title, "Action")}`, "Connected app")
      : describeBotApprovalRule({ target, label: title });
  }
  async function currentGrant(botId: string, target: BotApprovalRuleTarget, ruleId: string): Promise<BotAllowListRelease | undefined> {
    const revision = await deps.rules.botConsentRevision(botId, target), rule = await deps.rules.matchBot(botId, target);
    if (!rule || rule.id !== ruleId || revision !== await deps.rules.botConsentRevision(botId, target)) return undefined;
    return { target: structuredClone(target), ruleId, consentRevision: revision };
  }
  const service: BotAllowList = {
    consentRevision: (...args) => deps.rules.botConsentRevision(...args),
    match: async (...args) => { try { const rule = await deps.rules.matchBot(...args); return rule ? { id: rule.id } : undefined; } catch { return undefined; } },
    used: (...args) => deps.rules.recordBotUse(...args),
    decision: (...args) => deps.tallies.decision(...args),
    async offer(botId, target) {
      try {
        if (await deps.rules.matchBot(botId, target)) return undefined;
        const rows = await deps.rules.listBot();
        if (rows.length >= BOT_APPROVAL_RULES_PROFILE_MAX || rows.filter(row => row.botId === botId).length >= BOT_APPROVAL_RULES_PER_BOT_MAX) return undefined;
        return await deps.tallies.nudge(botId, target);
      } catch { return undefined; }
    },
    async settle(original, context) {
      const input = structuredClone(original), { botId, remember, decision } = input;
      const always = decision.source === "person" && decision.answer === "allow_always";
      // A replay's original publication context wins over today's names/title.
      const prior = always ? await deps.tallies.publication(botId, decision.id, decision.authorizationFingerprint) : undefined;
      if (prior && botApprovalRuleKey(prior.target) !== botApprovalRuleKey(remember.target)) throw new Error("The saved approval target changed.");
      if (always && !prior) {
        const saved = await deps.tallies.decision(botId, decision.id, decision.authorizationFingerprint);
        if (saved) {
          if (saved.answer !== decision.answer || saved.source !== decision.source) throw new Error("The saved approval decision changed.");
          log(new Error("The original approval publication context is unavailable.")); return {};
        }
        if (input.requirements && (input.requirements.authorizationFingerprint !== decision.authorizationFingerprint ||
            botApprovalRuleKey(input.requirements.target) !== botApprovalRuleKey(remember.target))) throw new Error("The approval requirements do not match this decision.");
      }
      let publicationContext = prior?.context;
      if (always && !publicationContext) {
        if (prior || !input.requirements?.consentRevision) {
          log(new Error("The original approval publication context is unavailable.")); return {};
        }
        publicationContext = { consentRevision: input.requirements.consentRevision, title: clean(remember.title, "Action"),
          label: await label(remember.target, remember.title) };
      }
      const target = prior?.target ?? remember.target;
      const result = await deps.tallies.record(botId, target, { ...decision, offered: prior?.offered ?? !!remember.offer,
        ...(publicationContext ? { publicationContext } : {}) });
      if (!always) {
        if (decision.source !== "person" || decision.answer !== "allow" || result.hintCount === undefined) return {};
        return { hint: botApprovalNudgeHint({ label: await label(target, remember.title), count: result.hintCount,
          choice: botAlwaysAllowLabel(await deps.botName(botId) ?? "this Bot"), place: "Allowed without asking on your profile" }) };
      }
      let guardRefused = false;
      try {
      const operation = await deps.rules.botGrantOperation(botId, decision.id);
      if (operation) {
        if (operation.targetKey !== botApprovalRuleKey(target)) throw new Error("The saved approval target changed.");
        await deps.tallies.completePublication(botId, decision.id, decision.authorizationFingerprint, operation.status);
        return {}; // Historical acknowledgement never grants or releases a card.
      }
      if (prior && prior.status !== "pending") return {};
      if (!context?.validatePublication || !publicationContext) { log(new Error("A new approval publication needs its live validation guard.")); return {}; }
      let published: Awaited<ReturnType<ToolApprovalRuleBook["grantBot"]>>;
      try {
        published = await deps.rules.grantBot(botId, target, publicationContext.label, decision.id, {
          expectedConsentRevision: publicationContext.consentRevision,
          validatePublication: async () => { try { await context.validatePublication!(); } catch (error) { guardRefused = true; throw error; } },
        });
      } catch (error) {
        if (guardRefused) throw error;
        log(error); return {};
      }
      if (published.status === "revoked") {
        await deps.tallies.completePublication(botId, decision.id, decision.authorizationFingerprint, "revoked"); return {};
      }
      let grant = await currentGrant(botId, target, published.rule.id);
      const receipt = await deps.rules.botGrantOperation(botId, decision.id);
      if (receipt?.status === "revoked") {
        await deps.tallies.completePublication(botId, decision.id, decision.authorizationFingerprint, "revoked"); return {};
      }
      if (!grant) return {};
      await deps.tallies.completePublication(botId, decision.id, decision.authorizationFingerprint, "published");
      for (const prompt of deps.approvals.pending(botId)) {
        if (prompt.waitId === decision.id || !prompt.allowList || botApprovalRuleKey(prompt.allowList.target) !== botApprovalRuleKey(target)) continue;
        grant = await currentGrant(botId, target, published.rule.id);
        if (!grant) break;
        await deps.approvals.releaseFromAllowList(prompt.waitId, grant);
      }
      grant = await currentGrant(botId, target, published.rule.id);
      return grant ? { publication: grant } : {};
      } catch (error) {
        if (guardRefused) throw error;
        log(error); return {};
      }
    },
    async list(botId) {
      const [rules, folders] = await Promise.all([deps.rules.listBot(botId), deps.folderEntries(botId)]);
      return [...rules.map(rule => ({ kind: "rule" as const, id: rule.id, botId: rule.botId, what: describeBotApprovalRule(rule),
        createdAt: rule.createdAt, uses: rule.uses, ...(rule.lastUsedAt ? { lastUsedAt: rule.lastUsedAt } : {}) })),
        ...folders.filter(row => row.kind === "folder" && (!botId || row.botId === botId))]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    },
    async remove(botId, entryId) {
      if (!entryId.startsWith("folder_")) return deps.rules.revokeBot(botId, entryId);
      const sourceId = entryId.slice(7);
      if (!sourceId || !(await deps.folderEntries(botId)).some(row => row.kind === "folder" && row.botId === botId && row.id === entryId)) return false;
      const removed = await deps.revokeFolder(botId, sourceId); if (removed) changed(botId); return removed;
    },
    async folderOffer(botId, folder) { try { return await deps.tallies.nudge(botId, { kind: "folder", path: folder }); } catch { return undefined; } },
    async settleFolder(original) {
      const input = structuredClone(original);
      const decision: BotApprovalDecision = { id: input.decisionId, authorizationFingerprint: input.authorizationFingerprint,
        answer: input.answer === "once" ? "allow" : input.answer === "always" ? "allow_always" : "deny", source: input.source };
      const result = await deps.tallies.record(input.botId, { kind: "folder", path: input.path }, { ...decision, offered: input.offered,
        ...(input.decidedAt === undefined ? {} : { decidedAt: input.decidedAt }) });
      if (input.answer === "always") { await deps.tallies.completePublication(input.botId, decision.id, decision.authorizationFingerprint, "published"); return {}; }
      return input.answer === "once" && result.hintCount !== undefined ? { hint: botApprovalNudgeHint({ label: input.label ?? input.path,
        count: result.hintCount, choice: "Always for this folder" }) } : {};
    },
    async reconcile(botId, folderReceipts = []) {
      for (const receipt of await deps.tallies.pendingPublications(botId)) {
        const operation = await deps.rules.botGrantOperation(botId, receipt.decision.id);
        if (!operation) continue;
        if (operation.targetKey !== botApprovalRuleKey(receipt.target)) throw new Error("The saved approval target changed.");
        await deps.tallies.completePublication(botId, receipt.decision.id, receipt.decision.authorizationFingerprint, operation.status);
      }
      for (const receipt of folderReceipts) {
        if (receipt.botId === botId) await service.settleFolder(receipt);
      }
    },
    async forgetBot(botId) { await Promise.all([deps.rules.forgetBot(botId), deps.tallies.forgetBot(botId)]); },
    changed,
    onChange(listener) { listeners.add(listener); return () => void listeners.delete(listener); },
  };
  return service;
}
