// A Bot's own browser for the desktop Bot panel.
//
// - `bots:browser:workspace(botId)` → `{ workspaceId }` of the Bot's browser,
//   or `null` for a Bot that is gone or has no home. The panel then reads and
//   drives it through the ordinary `browser:*` channels; asking for its state
//   from a window moves the Bot's browser into that window.

import { parseBotId } from "./bot-params.js";

export const BOT_BROWSER_WORKSPACE_CHANNEL = "bots:browser:workspace";

export interface BotBrowserHandlerDependencies {
  handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void;
  /** The Bot's browser workspace, admitted to the browser service; `null` when the Bot is gone. */
  workspace(botId: string): Promise<string | null>;
}

export function registerBotBrowserHandlers(dependencies: BotBrowserHandlerDependencies): void {
  dependencies.handle(BOT_BROWSER_WORKSPACE_CHANNEL, async (_event, botId) => {
    const workspaceId = await dependencies.workspace(parseBotId(botId));
    return workspaceId === null ? null : { workspaceId };
  });
}
