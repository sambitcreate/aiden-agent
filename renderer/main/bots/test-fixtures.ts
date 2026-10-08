import { BOT_FULL_ACCESS_NOTICE_VERSION, type BotCapabilityCatalog } from "../../shared/bot-capabilities";
import { DEFAULT_BOT_AVATAR, type BotDefinition } from "../../shared/bots";

export function botFixture(overrides: Partial<BotDefinition> = {}): BotDefinition {
  return {
    id: "bot-1",
    revision: "rev-1",
    name: "Planner",
    description: "Plans trips",
    instructions: "Plan trips.",
    avatar: { ...DEFAULT_BOT_AVATAR },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function catalogFixture(options: { models?: boolean; accepted?: boolean } = {}): BotCapabilityCatalog {
  const models = options.models ?? true;
  return {
    revision: "catalog-1",
    providers: models
      ? [
          {
            id: "prov-text",
            label: "Text Service",
            available: true,
            models: [{ id: "model-text", label: "Writer", available: true, supportsImages: false }],
          },
          {
            id: "prov-vision",
            label: "Vision Service",
            available: true,
            models: [{ id: "model-vision", label: "Seer", available: true, supportsImages: true }],
          },
        ]
      : [],
    fileScopes: [],
    shellAvailable: true,
    connections: [{ id: "conn-mail", label: "Mail", available: true }],
    skills: [],
    otherCapabilities: [],
    notice: options.accepted === false
      ? { version: BOT_FULL_ACCESS_NOTICE_VERSION, requiresAcknowledgement: true }
      : {
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          requiresAcknowledgement: false,
          acceptedAt: "2026-10-01T00:00:00.000Z",
          acceptedDecision: "continue_full",
        },
  };
}
