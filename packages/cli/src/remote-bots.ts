import { join } from "node:path";
import type { AppSettings } from "../../../main/services/types.js";
import { botMessagingEnabled } from "../../../renderer/shared/bot-messages.js";
import { JsonStore } from "./state.ts";
import {
  AidenRemoteBotSessionService,
  projectBotSessionState,
} from "../../../main/services/aiden-remote-bot-session.js";
import { createCliBotAvatars } from "./bot-avatars.ts";
import { AidenRemoteBotService } from "../../../main/services/aiden-remote-bots.js";
import { AidenRemoteBotFileService } from "../../../main/services/aiden-remote-bot-files.js";
import {
  createBotInboxProjectionService,
  mergeBotInboxActivityPreviews,
} from "../../../main/services/bot-inbox-projection.js";
import { AidenRemoteServiceError } from "../../../main/services/aiden-remote-errors.js";
import type {
  AidenIdempotencyLedger,
  AidenIdempotencySnapshot,
} from "../../../main/services/aiden-remote-operation-contract.js";
import { CLI_BOT_OWNER_AUDIENCE_ID, type createCliBots } from "./bots.ts";
import type { createCliRemoteChats } from "./remote-chats.ts";
import type { createDaemonChats } from "./daemon-chats.ts";
import {
  createBotLiveProjection,
  type BotLiveProjection,
} from "../../../main/services/bot-runtime/live-projection.js";
import {
  hostFeedBotSignals,
  type AidenRemoteHostFeedBotSignals,
} from "../../../main/services/aiden-remote-host-feed.js";

/** Four at a time, like the desktop: each read may open a Bot's transcript. */
async function eachBot<T>(
  ids: readonly string[],
  read: (id: string) => Promise<T>,
): Promise<Array<readonly [string, T]>> {
  const out: Array<readonly [string, T]> = [];
  for (let start = 0; start < ids.length; start += 4) {
    out.push(
      ...(await Promise.all(
        ids.slice(start, start + 4).map(async (id) => [id, await read(id)] as const),
      )),
    );
  }
  return out;
}

/**
 * The summary this host's Bot rows come from, as on the desktop: what waits on
 * the person (an approval), the run state, the newest reply and its line. A
 * Bot's transcript is read again only after its newest entry changes. As on
 * the desktop, a running Bot's feed stays open until its run settles, so the
 * end of every turn (a reply, a failure) reaches the host feed with its row.
 */
export function createCliBotSignals(
  durable: NonNullable<Awaited<ReturnType<typeof createCliBots>>["durable"]>,
) {
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        process.stderr.write(
          `aiden: Bot row listener failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  };
  const live: BotLiveProjection = createBotLiveProjection({
    conversation: (botId) => durable.runtime.conversation(botId),
    state: (botId) => durable.runtime.state(botId),
    quietInputs: (botId, ids) => durable.runtime.quietInputs(botId, ids),
    approvalPending: (botId) => durable.approvals.pending(botId).length > 0,
    // A run ended: its reply, or why it failed, is now readable.
    onRunSettled: () => changed(),
    onError: (botId, error) =>
      process.stderr.write(
        `aiden: Bot ${botId} row: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
  });
  // A turn started or ended, or a pause: the feed follows a running Bot to its end.
  const detach = [
    durable.stateChanges((botId, state) => {
      live.notifyState(botId, state);
      changed();
    }),
    durable.approvals.onChange(() => changed()),
  ];
  return {
    /** Host feed Bot rows (revisions 52 and 66): Needs you, Failed, last reply and its line. */
    botSignals: async (
      bots: readonly { id: string }[],
    ): Promise<ReadonlyMap<string, AidenRemoteHostFeedBotSignals>> =>
      new Map(
        await eachBot(
          bots.map((bot) => bot.id),
          async (id) => hostFeedBotSignals(await live.summary(id).catch(() => undefined)),
        ),
      ),
    /** Revision 68 (`bot:needs-you`): which Bots wait on the person, without reading transcripts. */
    botNeedsYou: async (botIds: readonly string[]): Promise<ReadonlySet<string>> =>
      new Set(
        (await eachBot(botIds, (id) => live.needsYou(id).catch(() => false)))
          .filter(([, waiting]) => waiting)
          .map(([id]) => id),
      ),
    /** A Bot's row changed: a turn started or ended, a pause, or an approval. */
    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      for (const off of detach) off();
      listeners.clear();
      return live.close();
    },
  };
}

export function createCliRemoteBots(
  agentDir: string,
  instanceId: string,
  runtime: Awaited<ReturnType<typeof createCliBots>>,
  daemon: ReturnType<typeof createDaemonChats>,
  chatApi: Awaited<ReturnType<typeof createCliRemoteChats>>,
  idempotency: AidenIdempotencyLedger,
  persistIdempotency: (value: AidenIdempotencySnapshot) => Promise<void>,
) {
  const settings = new JsonStore<AppSettings>(join(agentDir, "aiden.json"), {});
  const messaging = runtime.durable
    ? {
        enabled: async () => botMessagingEnabled(await settings.load()),
        setEnabled: async (enabled: boolean) => {
          await settings.update((value) => {
            if (enabled) delete value.botMessaging;
            else value.botMessaging = false;
          });
          return enabled;
        },
      }
    : undefined;
  const bots = new AidenRemoteBotService({
    ...(messaging ? { messaging } : {}),
    avatar: createCliBotAvatars(agentDir, instanceId),
    application: runtime.application,
    ...(runtime.durable
      ? {
          deleteBot: runtime.durable.runtime.deleteBot,
          sessionStates: async (ids: readonly string[]) =>
            new Map(
              await Promise.all(
                ids.map(
                  async (id) =>
                    [
                      id,
                      projectBotSessionState(await runtime.durable!.runtime.state(id)).state,
                    ] as const,
                ),
              ),
            ),
        }
      : {}),
    chatStore: daemon.chatStore,
    idempotency,
    persistIdempotency,
    log: (message, error) => {
      process.stderr.write(
        `aiden: ${message} (${error instanceof Error ? error.message : "unknown error"})\n`,
      );
    },
    inbox: {
      list: (deviceId, input) =>
        createBotInboxProjectionService({
          listBots: () => runtime.application.list(),
          listChatMetadata: () => daemon.chatStore.list(),
          projectBatch: async (request) =>
            mergeBotInboxActivityPreviews(
              request,
              await chatApi.streams.projectChatActivities(
                deviceId,
                request.map(({ chatId }) => chatId),
              ),
            ),
        }).list(input),
    },
    resolveProviderModel: async ({ audienceId, botId, providerId, modelId }) => {
      const lease = runtime.inventoryLeases.acquire();
      try {
        const defaultSelection =
          providerId === undefined || modelId === undefined
            ? await chatApi.models.resolve()
            : undefined;
        const retained = await runtime.capabilities.getBotBinding(botId);
        const snapshot = await runtime.catalog.snapshot({
          audienceId,
          botId,
          ...(retained ? { retainedBindings: [retained] } : {}),
        });
        lease.assertCurrent();
        const provider = snapshot.resources.providers.find((item) =>
          providerId
            ? item.option.id === providerId
            : item.sourceId === defaultSelection?.providerId,
        );
        const model = provider?.models.find((item) =>
          modelId ? item.option.id === modelId : item.sourceId === defaultSelection?.modelId,
        );
        if (!provider?.option.available || !model?.option.available)
          throw new AidenRemoteServiceError(
            "operation_stale",
            "Refresh the Bot capability list and choose an available model.",
            409,
            true,
          );
        return {
          providerId: provider.sourceId,
          model: model.sourceId,
          assertCurrent: lease.assertCurrent,
          release: lease.release,
        };
      } catch (error) {
        lease.release();
        throw error;
      }
    },
  });
  const botFiles = new AidenRemoteBotFileService({
    instanceId,
    botAudienceId: CLI_BOT_OWNER_AUDIENCE_ID,
    authority: runtime.authority,
    chats: daemon.chatStore,
  });
  const botSessions = runtime.durable
    ? new AidenRemoteBotSessionService({
        bots,
        runtime: async () => runtime.durable!.runtime,
        routines: runtime.routines,
        presets: runtime.durable.presets,
        approvals: runtime.durable.approvals,
        memory: runtime.durable.memory,
        // A pause or unpause from `aiden bots` changes only the state; open phone streams hear it here.
        stateChanges: runtime.durable.stateChanges,
      })
    : undefined;
  const signals = runtime.durable ? createCliBotSignals(runtime.durable) : undefined;
  // `signals` is for the host feed; the rest are Remote routes.
  return {
    bots,
    botFiles,
    ...(botSessions ? { botSessions } : {}),
    ...(signals ? { botNeedsYou: signals.botNeedsYou, signals } : {}),
  };
}
