import type { SubagentAuthorityV2 } from "./authority-v2.js";

export const MAX_SUBAGENT_NETWORK_BUDGETS = 256;

interface NetworkBudgetEntry {
  signature: string;
  used: number;
  maximum: number;
}

function key(authority: SubagentAuthorityV2): string {
  return `${authority.grantId}\0${authority.runId}\0${authority.authorityRevision}`;
}

function signature(authority: SubagentAuthorityV2): string {
  return JSON.stringify(authority);
}

/** One atomic main-owned budget shared by every outbound proxy for an authority. */
export class SubagentNetworkBudgetV2 {
  private readonly entries = new Map<string, NetworkBudgetEntry>();

  consume(authority: SubagentAuthorityV2): true {
    if (authority.execution !== "foreground") {
      throw new Error("Subagent network access is foreground-only.");
    }
    const identity = key(authority);
    const exact = signature(authority);
    const existing = this.entries.get(identity);
    if (existing && existing.signature !== exact) {
      throw new Error("Subagent network authority changed.");
    }
    if (!existing && this.entries.size >= MAX_SUBAGENT_NETWORK_BUDGETS) {
      throw new Error("Too many subagent network budgets are active.");
    }
    const entry =
      existing ?? {
        signature: exact,
        used: 0,
        maximum: authority.budgets.maxNetworkOperations,
      };
    if (entry.used >= entry.maximum) {
      throw new Error("Subagent network operation budget exhausted.");
    }
    entry.used += 1;
    this.entries.set(identity, entry);
    return true;
  }

  release(authority: SubagentAuthorityV2): boolean {
    const identity = key(authority);
    const entry = this.entries.get(identity);
    if (!entry || entry.signature !== signature(authority)) return false;
    return this.entries.delete(identity);
  }

  used(authority: SubagentAuthorityV2): number {
    const entry = this.entries.get(key(authority));
    return entry?.signature === signature(authority) ? entry.used : 0;
  }
}
