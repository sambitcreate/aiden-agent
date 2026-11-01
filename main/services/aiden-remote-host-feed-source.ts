// The `/host/events` feed's one transcript-free read, shared by the desktop
// host and `aiden serve`: chat summaries, workspaces (with their cached
// repository identity) and Bot rows in both audience shapes. Each host passes
// what it owns; a host without live Bot summaries passes no `botSignals`.

import type { AidenRemoteChatService } from "./aiden-remote-chats.js";
import { projectBotSummaryIssuesForAudience } from "./aiden-remote-bot-issues.js";
import { LEGACY_AUDIENCE, projectBotSummaryForAudience } from "./aiden-remote-bot-handoffs.js";
import type {
  AidenRemoteHostFeedBot,
  AidenRemoteHostFeedBotSignals,
  AidenRemoteHostFeedSource,
  AidenRemoteRepositoryIdentity,
} from "./aiden-remote-host-feed.js";
import type { AidenRemoteBotList, AidenRemoteBotSummary } from "./aiden-remote-protocol.js";
import { projectAidenRemoteWorkspace } from "./aiden-remote-workspaces.js";
import type { Workspace } from "./types.js";

export interface AidenRemoteHostFeedSourceInputs {
  chats: Pick<AidenRemoteChatService, "hostFeedChats">;
  listWorkspaces(): Promise<readonly Workspace[]>;
  /** Credential-free repository identity from the cached origin; never a git call. */
  repositoryIdentity?(folderPath: string): AidenRemoteRepositoryIdentity | undefined;
  /** Undefined when the host serves no Bots. */
  listBots?(): Promise<Pick<AidenRemoteBotList, "bots">>;
  /**
   * Revision 48: each Bot's Needs you, Failed and last reply. A Bot missing
   * from the map (or a host without this) sends its row without them.
   */
  botSignals?(
    bots: readonly AidenRemoteBotSummary[],
  ): Promise<ReadonlyMap<string, AidenRemoteHostFeedBotSignals>>;
}

export function createAidenRemoteHostFeedSource(
  inputs: AidenRemoteHostFeedSourceInputs,
): AidenRemoteHostFeedSource {
  return {
    read: async () => {
      const [{ summaries, botChatIds }, workspaceRows, botList] = await Promise.all([
        inputs.chats.hostFeedChats(),
        inputs.listWorkspaces(),
        inputs.listBots ? inputs.listBots() : Promise.resolve(undefined),
      ]);
      const bots = botList?.bots ?? [];
      const signals = bots.length > 0 && inputs.botSignals ? await inputs.botSignals(bots) : undefined;
      return {
        summaries,
        botChatIds,
        workspaces: workspaceRows.map((workspace) => {
          const repository = workspace.folderPath
            ? inputs.repositoryIdentity?.(workspace.folderPath)
            : undefined;
          return {
            ...projectAidenRemoteWorkspace(workspace),
            ...(repository ? { repository } : {}),
          };
        }),
        // A desktop without `bot:handoffs` gets the revision-35 rows (a paused
        // Bot reads as unavailable); a holder gets `paused` (revision 37).
        // `issueCount` (revision 42) is a phone shape: the host feed keeps
        // its revision-40 rows for every desktop.
        bots: bots.map((bot) => ({
          ...projectBotSummaryIssuesForAudience(
            projectBotSummaryForAudience(bot, LEGACY_AUDIENCE),
            { issues: false },
          ),
          ...signals?.get(bot.id),
        })) as unknown as AidenRemoteHostFeedBot[],
        handoffBots: bots.map((bot) => ({
          ...projectBotSummaryIssuesForAudience(
            projectBotSummaryForAudience(bot, { handoffs: true }),
            { issues: false },
          ),
          ...signals?.get(bot.id),
        })) as unknown as AidenRemoteHostFeedBot[],
      };
    },
  };
}
