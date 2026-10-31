// Spending limits on phones (`spending-limits-v1`): a chat's or Bot's limit,
// what it has spent, and "Allow $X more" once it is reached. The Mac's one
// spending ledger answers; this file only projects it for the wire.

import { createHash } from "node:crypto";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { SpendingStatusView } from "../../renderer/shared/spending.js";

export interface AidenRemoteSpendingProjection {
  /** `chat`: the whole chat. `month`: the Bot's current month. */
  period: "chat" | "month";
  state: "under" | "nearing" | "reached";
  /** The limit as set, in US dollars. */
  limitUsd: number;
  /** The limit plus what was allowed since, in US dollars. */
  allowedUsd: number;
  spentUsd: number;
  /** What one "Allow more" adds: the limit again. */
  allowMoreUsd: number;
  /** For `month`: when the month started and when it starts over (ISO 8601). */
  periodStart?: string;
  periodEnd?: string;
  /** Send as `If-Match` with Allow more; it changes when the allowance or the month does. */
  revision: string;
}

export interface AidenRemoteSpendingResponse {
  /** Null: no limit applies to this chat or Bot. */
  spending: AidenRemoteSpendingProjection | null;
}

export interface AidenRemoteSpendingLedger {
  status(kind: "chat" | "bot", id: string): Promise<SpendingStatusView | undefined>;
  allowMoreIf(
    kind: "chat" | "bot",
    id: string,
    current: (view: SpendingStatusView) => boolean,
  ): Promise<{ view: SpendingStatusView | undefined; accepted: boolean }>;
}

export interface AidenRemoteSpendingDependencies {
  spending: AidenRemoteSpendingLedger;
  /** Throws `not_found` for a Bot that does not exist. */
  requireBot(botId: string): Promise<void>;
}

const cents = (usd: number) => Math.round(usd * 100);

function revisionOf(view: SpendingStatusView): string {
  const key = JSON.stringify([view.period, view.periodStart ?? null, cents(view.limitUsd), cents(view.extraUsd)]);
  return `sp_${createHash("sha256").update(key).digest("base64url").slice(0, 22)}`;
}

export function projectAidenRemoteSpending(view: SpendingStatusView | undefined): AidenRemoteSpendingResponse {
  if (!view) return { spending: null };
  return {
    spending: {
      period: view.period,
      state: view.state,
      limitUsd: cents(view.limitUsd) / 100,
      allowedUsd: cents(view.limitUsd + view.extraUsd) / 100,
      spentUsd: cents(view.spentUsd) / 100,
      allowMoreUsd: cents(view.limitUsd) / 100,
      ...(view.periodStart !== undefined ? { periodStart: new Date(view.periodStart).toISOString() } : {}),
      ...(view.periodEnd !== undefined ? { periodEnd: new Date(view.periodEnd).toISOString() } : {}),
      revision: revisionOf(view),
    },
  };
}

export class AidenRemoteSpendingService {
  constructor(private readonly dependencies: AidenRemoteSpendingDependencies) {}

  async chat(chatId: string): Promise<AidenRemoteSpendingResponse> {
    return projectAidenRemoteSpending(await this.dependencies.spending.status("chat", chatId));
  }

  async bot(botId: string): Promise<AidenRemoteSpendingResponse> {
    await this.dependencies.requireBot(botId);
    return projectAidenRemoteSpending(await this.dependencies.spending.status("bot", botId));
  }

  async allowMoreChat(chatId: string, expectedRevision: string): Promise<AidenRemoteSpendingResponse> {
    return this.allowMore("chat", chatId, expectedRevision);
  }

  async allowMoreBot(botId: string, expectedRevision: string): Promise<AidenRemoteSpendingResponse> {
    await this.dependencies.requireBot(botId);
    return this.allowMore("bot", botId, expectedRevision);
  }

  /**
   * Adds the limit once more while the chat or Bot is at or near it. The
   * revision makes a repeated or crossed tap a conflict instead of a second
   * allowance; a chat or Bot still under its limit is returned unchanged.
   */
  private async allowMore(kind: "chat" | "bot", id: string, expectedRevision: string): Promise<AidenRemoteSpendingResponse> {
    const { view, accepted } = await this.dependencies.spending.allowMoreIf(
      kind,
      id,
      (current) => revisionOf(current) === expectedRevision,
    );
    if (!view) {
      throw new AidenRemoteServiceError("not_found", "No spending limit applies here.", 404);
    }
    if (!accepted) {
      throw new AidenRemoteServiceError(
        "revision_conflict",
        "The spending limit changed. Refresh it before trying again.",
        409,
        false,
        { currentRevision: revisionOf(view) },
      );
    }
    return projectAidenRemoteSpending(view);
  }
}
