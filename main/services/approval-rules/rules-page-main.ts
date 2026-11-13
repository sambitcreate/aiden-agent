/** Electron-main wiring for the rules page: each row read from, and removed through, its own store. */

import { logger } from "../../platform.js";
import { APPROVAL_RULE_AIDEN_TOOLS, type ApprovalRulePickerOption } from "../../../renderer/shared/approval-rules.js";
import { configStore } from "../config-store.js";
import { toolApprovalRules } from "../tool-approval-rules-main.js";
import { workspaceApplicationService } from "../workspace-application-service-main.js";
import { applySettingsEffects } from "../settings-application-effects.js";
import { hostPlatformCapabilities } from "../host-platform-capabilities.js";
import { approvalRules } from "./store-main.js";
import { createApprovalRulesPage, type ApprovalRulesPage } from "./rules-page.js";

let page: ApprovalRulesPage | undefined;

/** Built lazily: the Bot services load with the Bot runtime, not with Settings. */
export function approvalRulesPage(): ApprovalRulesPage {
  const bots = hostPlatformCapabilities().bots;
  page ??= createApprovalRulesPage({
    book: approvalRules,
    workspaceExact: toolApprovalRules,
    botAllowed: bots ? {
      list: async () => (await import("../bot-runtime/bot-session-main.js")).botAllowList.list(),
      remove: async (botId, entryId) => (await import("../bot-runtime/bot-session-main.js")).botAllowList.remove(botId, entryId),
      targets: (botId) => toolApprovalRules.listBot(botId),
    } : undefined,
    botRules: bots ? {
      get: async (botId) => (await import("../bot-rules/store-main.js")).botRules.get(botId),
      update: async (botId, revision, change) => (await import("../bot-rules/store-main.js")).botRules.update(botId, revision, change),
    } : undefined,
    computerUseEverywhere: {
      get: async () => (await configStore.getSettings()).computerUseAlwaysAllow === true,
      turnOff: async () => {
        const patch = { computerUseAlwaysAllow: false };
        await applySettingsEffects(await configStore.setSettings(patch), patch);
      },
    },
    bots: async () => {
      if (!bots) return [];
      const { botApplicationService } = await import("../bot-application-service-main.js");
      return (await botApplicationService.list()).map((bot) => ({ id: bot.id, name: bot.name }));
    },
    workspaces: async () => (await workspaceApplicationService.list()).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      permission: workspace.permission,
      approvalMode: workspace.approvalMode,
      macGrants: workspace.macGrants,
    })),
    revokeWorkspaceMac: async (workspaceId, grant) => {
      await workspaceApplicationService.update(workspaceId, { revokeMacGrant: grant });
    },
    picker: async () => {
      const options: ApprovalRulePickerOption[] = APPROVAL_RULE_AIDEN_TOOLS.map((tool) => ({
        target: { kind: "tool", tool: tool.tool },
        label: tool.label,
        group: "Aiden",
        ...(tool.description ? { description: tool.description } : {}),
      }));
      for (const server of await configStore.listMcpServers()) {
        options.push({ target: { kind: "connector", serverId: server.id }, label: server.name, group: "Connected apps", description: "Every tool of this app" });
      }
      return options;
    },
    log: (message, error) => logger.warn("approvals", message, error),
  });
  return page;
}
