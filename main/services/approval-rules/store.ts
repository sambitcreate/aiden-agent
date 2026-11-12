// The rules page's own rules (docs/plans/bot-ux-simplification.md §3.5):
// `approval-rules.json` in the profile, device-local and never portable. A
// separate file from `tool-approval-rules.json`, so an earlier release, which
// rewrites that document from the fields it knows, never drops a rule here,
// and these rules never mix with the receipts that protect a Bot's allow list.
//
// The previous release does not read this file at all: it keeps every grant
// it had and simply has no rules page.

import { randomUUID } from "node:crypto";
import {
  APPROVAL_RULES_MAX,
  APPROVAL_RULES_MAX_BYTES,
  approvalRuleDecisionsFor,
  approvalRuleOwnerKey,
  approvalRuleTargetKey,
  emptyApprovalRulesDocument,
  type ApprovalRule,
  type ApprovalRuleDecision,
  type ApprovalRuleOwner,
  type ApprovalRuleTarget,
  type ApprovalRulesDocument,
} from "../../../renderer/shared/approval-rules.js";

export interface ApprovalRuleStore {
  load(): Promise<ApprovalRulesDocument>;
  update<R>(mutation: (draft: ApprovalRulesDocument) => R | Promise<R>): Promise<R>;
}

export class ApprovalRuleLimitError extends Error {
  constructor() {
    super(`Aiden keeps at most ${APPROVAL_RULES_MAX} rules. Remove some first.`);
  }
}

function keyOf(owner: ApprovalRuleOwner, target: ApprovalRuleTarget): string {
  return `${approvalRuleOwnerKey(owner)}\u0000${approvalRuleTargetKey(target)}`;
}

function assertBudget(document: ApprovalRulesDocument): void {
  if (Buffer.byteLength(JSON.stringify(document, null, 2) + "\n", "utf8") > APPROVAL_RULES_MAX_BYTES) {
    throw new ApprovalRuleLimitError();
  }
}

export interface ApprovalRuleAdd {
  target: ApprovalRuleTarget;
  decision: ApprovalRuleDecision;
  owner: ApprovalRuleOwner;
  handOff?: boolean;
  label?: string;
}

/** The rules, read fresh on every call, and changed one at a time. */
export class ApprovalRuleBook {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: ApprovalRuleStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => randomUUID(),
  ) {}

  async list(): Promise<ApprovalRule[]> {
    return structuredClone((await this.store.load()).rules);
  }

  /**
   * Add a rule, or change the decision of the rule that already exists for
   * the same owner and target. Returns the saved rule.
   */
  async add(input: ApprovalRuleAdd): Promise<ApprovalRule> {
    if (!approvalRuleDecisionsFor(input.target).includes(input.decision)) throw new Error("Invalid rule.");
    const key = keyOf(input.owner, input.target);
    const handOff = input.handOff === true && input.decision === "ask" && input.target.kind === "text";
    const saved = await this.store.update((draft) => {
      const existing = draft.rules.find((rule) => keyOf(rule.owner, rule.target) === key);
      if (existing) {
        existing.decision = input.decision;
        if (handOff) existing.handOff = true;
        else delete existing.handOff;
        if (input.label) existing.label = input.label;
        assertBudget(draft);
        return structuredClone(existing);
      }
      if (draft.rules.length >= APPROVAL_RULES_MAX) throw new ApprovalRuleLimitError();
      const rule: ApprovalRule = {
        id: this.newId(),
        target: structuredClone(input.target),
        decision: input.decision,
        owner: structuredClone(input.owner),
        ...(handOff ? { handOff: true as const } : {}),
        ...(input.label ? { label: input.label } : {}),
        createdAt: this.now().toISOString(),
      };
      draft.rules.push(rule);
      assertBudget(draft);
      return structuredClone(rule);
    });
    this.notify();
    return saved;
  }

  /** Change a rule's decision or its "Do it myself". Returns false when the rule is gone. */
  async change(id: string, change: { decision?: ApprovalRuleDecision; handOff?: boolean }): Promise<boolean> {
    const changed = await this.store.update((draft) => {
      const rule = draft.rules.find((candidate) => candidate.id === id);
      if (!rule) return false;
      const decision = change.decision ?? rule.decision;
      if (!approvalRuleDecisionsFor(rule.target).includes(decision)) throw new Error("That rule can’t be set to this.");
      rule.decision = decision;
      const handOff = (change.handOff ?? rule.handOff === true) && decision === "ask" && rule.target.kind === "text";
      if (change.handOff === true && !handOff) throw new Error("Only an Always ask rule in your own words can be done by you.");
      if (handOff) rule.handOff = true;
      else delete rule.handOff;
      return true;
    });
    if (changed) this.notify();
    return changed;
  }

  async remove(id: string): Promise<boolean> {
    const removed = await this.store.update((draft) => {
      const index = draft.rules.findIndex((rule) => rule.id === id);
      if (index < 0) return false;
      draft.rules.splice(index, 1);
      return true;
    });
    if (removed) this.notify();
    return removed;
  }

  /** A deleted Bot's or workspace's own rules go with it. */
  async forgetOwner(owner: ApprovalRuleOwner): Promise<number> {
    const key = approvalRuleOwnerKey(owner);
    const removed = await this.store.update((draft) => {
      const before = draft.rules.length;
      draft.rules = draft.rules.filter((rule) => approvalRuleOwnerKey(rule.owner) !== key);
      return before - draft.rules.length;
    });
    if (removed > 0) this.notify();
    return removed;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener's failure never undoes a saved rule.
      }
    }
  }
}

/** An in-memory store for tests and the CLI daemon, which has no rules page. */
export function memoryApprovalRuleStore(initial: ApprovalRulesDocument = emptyApprovalRulesDocument()): ApprovalRuleStore {
  let document = structuredClone(initial);
  let tail: Promise<unknown> = Promise.resolve();
  return {
    load: async () => structuredClone(document),
    update: (mutation) => {
      const result = tail.then(async () => {
        const draft = structuredClone(document);
        const value = await mutation(draft);
        document = draft;
        return value;
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
