// Production wiring of settings from chat (plan §4.6): the real Bot and
// access stores behind `createBotSettingsPorts`.

import type { JsonValue } from "@earendil-works/chord/json";
import { BOT_COMPUTER_SHARED_ID } from "../../../renderer/shared/bot-computers.js";
import { app, ipcMain } from "../../platform.js";
import { botApplicationService } from "../bot-application-service-main.js";
import { botComputers, botComputersEnabled } from "../bot-computers/bot-computers-main.js";
import { BOT_DESKTOP_AUDIENCE_ID } from "../bot-runtime-authority-main.js";
import { createBotSettingsPorts } from "./ports.js";
import { createBotSettingsChangeService } from "./service.js";

export const botSettingsChanges = createBotSettingsChangeService(createBotSettingsPorts({
  profileDir: () => app.getPath("userData"),
  getBot: (botId) => botApplicationService.get(botId),
  modelSelection: (botId) => botApplicationService.modelSelection(BOT_DESKTOP_AUDIENCE_ID, botId),
  getBotAccess: (botId) => botApplicationService.getBotAccess(botId),
  capabilityCatalog: (botId) => botApplicationService.capabilityCatalog(BOT_DESKTOP_AUDIENCE_ID, botId),
  botWebSearchEnabled: (botId) => botApplicationService.botWebSearchEnabled(botId),
  updateBotAccess: (input) => botApplicationService.updateBotAccess({ audienceId: BOT_DESKTOP_AUDIENCE_ID, ...input }),
  updateBot: (input) => botApplicationService.updateBot(input),
  async cancelWakeUps(botId) {
    const { botWakeUps } = await import("../bot-wake-ups/wake-ups-main.js");
    await botWakeUps.cancelAll(botId);
  },
  async readComputer(botId) {
    if (!botComputersEnabled()) return null;
    const assigned = await botComputers().host.computer(botId);
    if (!assigned) return null;
    return assigned.computerId === BOT_COMPUTER_SHARED_ID
      ? { kind: "shared" }
      : { kind: "existing", computerId: assigned.computerId };
  },
  async listComputers() {
    if (!botComputersEnabled()) return [];
    const { vms } = await botComputers().host.status();
    return vms.map((vm) => ({ id: vm.id, name: vm.name, kind: vm.kind }));
  },
  async validateComputer(_botId, target) {
    if (!botComputersEnabled()) return "Bot computers need a Mac with Apple silicon.";
    const status = await botComputers().host.status();
    if (status.setup.kind !== "ready") return "Set up Bot computers in Settings first.";
    if (target.kind === "existing" && !status.vms.some((vm) => vm.id === target.computerId)) {
      return `No Bot computer with id "${target.computerId}" exists.`;
    }
    return undefined;
  },
  async assignComputer(botId, target) {
    if (!botComputersEnabled()) throw new Error("Bot computers need a Mac with Apple silicon.");
    await botComputers().host.assignComputer(botId, target);
  },
  broadcastChanged: (botId) => ipcMain.broadcast("bots:changed", { botId }),
  async appendEntry(botId, kind, data) {
    const { botSessionRuntime } = await import("../bot-runtime/bot-session-main.js");
    await (await botSessionRuntime()).appendEntry(botId, kind, data as JsonValue);
  },
}));
