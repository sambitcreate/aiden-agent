// Keep this singleton independent of session/tool-source initialization. The
// desktop supplies authority ports before offering plans; the CLI supplies none.
import { app } from "../../platform.js";
import { botStore } from "../bot-store.js";
import { createBotPlans, type BotPlans, type BotPlansOptions } from "./plans.js";

export type BotPlanAuthorityPorts = Pick<BotPlansOptions, "revalidate" | "revokeAccess">;
let authority: BotPlanAuthorityPorts | undefined;
let service: BotPlans | undefined;

export function configureBotPlanAuthority(ports: BotPlanAuthorityPorts): void {
  authority = ports;
}

function currentService(): BotPlans {
  service ??= createBotPlans({
    profileDir: app.getPath("userData"),
    knownBot: async (botId) => (await botStore.get(botId)) != null,
    revalidate: async (botId, proposal) => {
      if (!authority) throw new Error("Bot plan approval is unavailable.");
      await authority.revalidate(botId, proposal);
    },
    // No ephemeral plan grant can be installed before authority is configured.
    revokeAccess: (botId, planId) => authority?.revokeAccess(botId, planId),
  });
  return service;
}

export const botPlans: BotPlans = {
  request: (request) => currentService().request(request),
  grantFreshAccess: (botId, planId, apply) => currentService().grantFreshAccess(botId, planId, apply),
  respond: (botId, planId, decision) => currentService().respond(botId, planId, decision),
  cover: (botId, check) => currentService().cover(botId, check),
  admit: (permit, start) => currentService().admit(permit, start),
  markStep: (botId, requestIds, step, status) => currentService().markStep(botId, requestIds, step, status),
  endRuns: (botId, reason) => currentService().endRuns(botId, reason),
  current: (botId, planId) => currentService().current(botId, planId),
  onChange: (listener) => currentService().onChange(listener),
  forgetBot: (botId) => currentService().forgetBot(botId),
};
