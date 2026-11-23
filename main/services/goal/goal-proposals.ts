/**
 * Goals the agent suggested (`propose_goal`), one per chat, waiting for the
 * person. The card above the composer shows it with Start and Not now; only
 * Start sets the goal (the renderer sends the objective as the person's
 * message, as `/goal` does). Proposals live in memory: a restart forgets them.
 */
import { validateGoalProposal, type GoalProposalView } from "../../../renderer/shared/goal.js";

export interface GoalProposalsDependencies {
  now(): number;
  onChange(chatId: string, proposal: GoalProposalView | null): void;
  /** Why the chat can't take a goal now (a Bot, no model, a goal already working), or undefined. */
  refusal(chatId: string): Promise<string | undefined>;
}

export class GoalProposals {
  private readonly proposals = new Map<string, GoalProposalView>();

  constructor(private readonly deps: GoalProposalsDependencies) {}

  get(chatId: string): GoalProposalView | null {
    return this.proposals.get(chatId) ?? null;
  }

  /** Shows the card, replacing an earlier proposal. Throws why it can't (an invalid objective, a goal at work). */
  async propose(chatId: string, objective: string): Promise<GoalProposalView> {
    const valid = validateGoalProposal(objective);
    if (valid.kind === "invalid") throw new Error(valid.message);
    const refusal = await this.deps.refusal(chatId);
    if (refusal) throw new Error(refusal);
    const proposal = { chatId, objective: valid.objective, proposedAt: this.deps.now() };
    this.proposals.set(chatId, proposal);
    this.deps.onChange(chatId, proposal);
    return proposal;
  }

  /** Not now, a goal being set, or the chat going away: the card goes. */
  dismiss(chatId: string): void {
    if (!this.proposals.delete(chatId)) return;
    this.deps.onChange(chatId, null);
  }
}
