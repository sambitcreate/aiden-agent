// The process-wide Bot rules store (`<userData>/bots/<dir>/rules.json`).
// Created on first use, so it is safe to import before the app is ready.

import { app } from "../../platform.js";
import { botStore } from "../bot-store.js";
import { createBotRuleStore, type BotRuleStore } from "./store.js";

let store: BotRuleStore | undefined;

function botRuleStore(): BotRuleStore {
  store ??= createBotRuleStore({
    profileDir: app.getPath("userData"),
    knownBot: async (botId) => (await botStore.get(botId)) != null,
  });
  return store;
}

export const botRules: BotRuleStore = {
  get: (botId) => botRuleStore().get(botId),
  rules: (botId) => botRuleStore().rules(botId),
  update: (botId, revision, change) => botRuleStore().update(botId, revision, change),
  forgetBot: (botId) => botRuleStore().forgetBot(botId),
};
