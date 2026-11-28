import type { HostPlatformCapabilities } from "../services/host-platform-capabilities.js";
import type { LazyIpcGroup } from "./lazy-ipc-core.js";

export const BOT_ROUTINE_CHANNELS = [
  "bots:routines:list",
  "bots:routines:create",
  "bots:routines:update",
  "bots:routines:delete",
  "bots:routines:runNow",
  "bots:routineProposals:respond",
] as const;

export const BOT_COMPUTER_CHANNELS = [
  "botComputers:status",
  "botComputers:setUp",
  "botComputers:updateBase",
  "botComputers:cancelSetUp",
  "botComputers:setUpElementControl",
  "botComputers:checkPermissions",
  "botComputers:skipPermissions",
  "botComputers:baseViewerGrant",
  "botComputers:removeEverything",
  "botComputers:updateSettings",
  "botComputers:give",
  "botComputers:reset",
  "botComputers:remove",
  "botComputers:stop",
  "botComputers:viewerGrant",
  "botComputers:takeOver",
  "botComputers:giveBack",
  "botComputers:pointer",
] as const;

export const BOT_CHANNELS = [
  "bots:getAccessNotice",
  "bots:acknowledgeAccessNotice",
  "bots:acceptFirstBotAccess",
  "bots:getTelegramAccessNotice",
  "bots:acknowledgeTelegramAccessNotice",
  "bots:create",
  "bots:getCapabilityCatalog",
  "bots:getModelThinkingLevels",
  "bots:getBotAccess",
  "bots:updateBotAccess",
  "bots:list",
  "bots:get",
  "bots:getCanonicalPhoto",
  "bots:sessionState",
  "bots:send",
  "bots:resume",
  "bots:dismiss",
  "bots:pause",
  "bots:unpause",
  "bots:withdraw",
  "bots:stop",
  "bots:createFromPreset",
  "bots:createFirst",
  "bots:presetBots",
  "bots:introduce",
  "bots:connections:grant",
  "bots:connections:dismiss",
  "bots:photo:set",
  "bots:photo:remove",
  "bots:live:subscribe",
  "bots:live:unsubscribe",
  "bots:live:summary",
  "bots:approve",
  "bots:allowed:list",
  "bots:allowed:remove",
  "bots:pendingApprovals",
  "bots:answerQuestion",
  "bots:answerAccessRequest",
  "bots:plans:respond",
  "bots:answerHandoff",
  "bots:openHandoff",
  "bots:issues:act",
  "bots:issues:list",
  "bots:connectorWatches:list",
  "bots:connectorWatches:discoverSources",
  "bots:connectorWatches:create",
  "bots:connectorWatches:update",
  "bots:connectorWatches:setEnabled",
  "bots:connectorWatches:remove",
  "bots:connectorWatches:testCheck",
  "bots:connectorWatches:runNow",
  "bots:openWork:snapshot",
  "bots:openWork:mutate",
  "bots:openWork:evidence",
  "bots:pendingChanges:retired",
  "bots:routineModels:read",
  "bots:routineModels:catalog",
  "bots:routineModels:runs",
  "bots:routineModels:save",
  "bots:routineModels:resumeStatus",
  "bots:routineModels:directory",
  "bots:peers:settings",
  "bots:peers:catalog",
  "bots:peers:mutate",
  "bots:peers:exchanges",
  "bots:peers:exchange",
  "bots:peers:stop",
  "bots:peers:evidence",
  "bots:eventRoutines:list",
  "bots:eventRoutines:create",
  "bots:eventRoutines:update",
  "bots:eventRoutines:remove",
  "bots:eventRoutines:rotateLink",
  "bots:skillProposals:respond",
  "bots:settingsChanges:respond",
  "bots:learning:get",
  "bots:learning:undo",
  "bots:learning:undoInChat",
  "bots:lessons:respond",
  "bots:lessons:remove",
  "bots:health:report",
  "bots:health:check",
  "bots:memory:get",
  "bots:memory:edit",
  "bots:rules:get",
  "bots:rules:update",
  "bots:files:list",
  "bots:files:read",
  "bots:browser:workspace",
  "bots:delete",
  "bots:update",
  "bots:getTelegramBinding",
  "bots:listTelegramTargets",
  "bots:bindTelegram",
  "bots:unbindTelegram",
] as const;

export const BOT_BUBBLE_CHANNELS = [
  "bots:bubbles:state",
  "bots:bubbles:bubble",
  "bots:bubbles:close",
  "bots:bubbles:open",
  "bots:bubbles:move",
  "bots:bubbles:bringBack",
  "bots:bubbles:forgetRecent",
  "bots:bubbles:setInteractive",
  "bots:bubbles:setDragging",
  "bots:bubbles:transitionShown",
  "bots:bubbles:overlayInfo",
] as const;

export interface BotSurfaceLazyGroupOptions<TEvent = unknown> {
  capabilities: Pick<HostPlatformCapabilities, "bots" | "botComputers">;
  registerGroup: <TChannel extends string>(
    name: string,
    channels: readonly TChannel[],
    loadRegistrar: () => Promise<() => void>,
  ) => LazyIpcGroup<TEvent>;
  botRoutines: () => Promise<() => void>;
  bots: () => Promise<() => void>;
  botBubbles: () => Promise<() => void>;
  botComputers: () => Promise<() => void>;
}

/**
 * Registers Bot IPC lazy forwarders only on platforms whose main-owned host
 * policy supports Bots and/or Apple-silicon Bot computers.
 */
export function registerBotSurfaceLazyGroups<TEvent = unknown>(
  options: BotSurfaceLazyGroupOptions<TEvent>,
): LazyIpcGroup<TEvent>[] {
  const groups: LazyIpcGroup<TEvent>[] = [];

  if (options.capabilities.bots) {
    groups.push(
      options.registerGroup("bot-routines", BOT_ROUTINE_CHANNELS, options.botRoutines),
      options.registerGroup("bots", BOT_CHANNELS, options.bots),
      options.registerGroup("bot-bubbles", BOT_BUBBLE_CHANNELS, options.botBubbles),
    );
  }

  if (options.capabilities.botComputers) {
    groups.push(
      options.registerGroup("bot-computers", BOT_COMPUTER_CHANNELS, options.botComputers),
    );
  }

  return groups;
}
