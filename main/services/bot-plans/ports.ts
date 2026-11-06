import type { BotAccessAuthorization } from "../../../renderer/shared/bot-access-requests.js";

export interface BotPlanAuthorization {
  policyRevision: string;
  bindingRevision: string;
  proposalFingerprint: string;
  rules: readonly { id: string; fingerprint: string }[];
  folder?: BotAccessAuthorization;
}

export interface BotPlanBotTurnPort {
  originOf(requestIds: readonly (string | undefined)[]): { originBotId: string } | undefined;
  announceWaiting(botId: string, requestIds: readonly (string | undefined)[], what: string, waitId: string): Promise<{ deadline: number; expired: boolean } | undefined>;
}

export interface BotPlanAccessPort {
  scopeOf(botId: string, path: string, requiredAccess: "read" | "write"): Promise<{
    kind: "inside" | "outside" | "invalid"; authorization?: BotAccessAuthorization;
  }>;
  allowOnce(botId: string, grant: { path: string; access: "read" | "write"; requestIds: readonly string[];
    planId: string; expiresAt: number; authorization: BotAccessAuthorization }): Promise<void>;
  revokePlan(botId: string, planId: string): void;
}
