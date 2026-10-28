// Durable bindings for the legacy Bot tools whose state belongs in the
// conversation rather than in a closure. Each reuses the legacy factory: the
// adapter builds the factory's tool per call from the conversation entries.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/chord";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createSuggestConnectionTool, type SuggestConnectionDeps } from "../bot-runtime-tools/suggest-connection.js";
import { createRoutineNotesTool, type BotRoutineNotesStore } from "../bot-routine-notes.js";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import { createBotRoutinesTool, type BotRoutinesToolDependencies } from "../schedule-tool.js";
import { botRoutineTaskIdOf } from "../scheduled-bot-routines.js";
import { createShareImageTool } from "../share-image-tool.js";
import type { Attachment } from "../types.js";
import {
  createVisionAnalysisTool,
  type VisionAnalysisToolDependencies,
} from "../vision-analysis-tool-core.js";
import { BOT_SHARED_IMAGE_ENTRY_KIND, imageAttachmentsFromEntries, sharedImageEntry } from "./bot-images.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import { BOT_CONNECT_CARD_ENTRY_KIND } from "./live-projection.js";
import type { BotToolCall } from "./tool-adapter.js";

/**
 * Whether the chat shows a card for `pluginId` still waiting: the newest such
 * card in the conversation's active context (`entries` newest first, as a
 * call reads them; a compaction's head marks where that context starts).
 */
export function connectCardPending(entries: readonly EntryRecord[], pluginId: string): boolean {
  let head: number | undefined;
  for (const entry of entries) {
    if (head !== undefined && entry.id < head) break;
    if (entry.kind === BOT_CONNECT_CARD_ENTRY_KIND) {
      const card = entry.data as { pluginId?: unknown; status?: unknown } | null;
      if (card?.pluginId === pluginId) return card.status === undefined || card.status === "pending";
    }
    if (head === undefined && entry.head !== undefined) head = entry.head;
  }
  return false;
}

/**
 * `suggest_connection`, bound per call: its card is appended to the calling
 * conversation (never submitted, so it can't resume a paused Bot), and a card
 * already waiting is read from there too. Never through the harness host,
 * whose per-Bot lock a pause, quit or delete holds while it waits for this call.
 */
export function suggestConnectionCandidate(
  botId: string,
  deps: Pick<SuggestConnectionDeps, "isConnected" | "isDismissed" | "botLacksConnection" | "chatLacksConnection">,
): BotToolCandidate {
  const unbound = async (): Promise<never> => {
    throw new Error("Suggesting a connection needs a Bot conversation.");
  };
  return {
    tool: createSuggestConnectionTool(botId, { ...deps, appendConnectCard: unbound, hasPendingCard: unbound }),
    replay: "unsafe",
    bind: (call) =>
      createSuggestConnectionTool(botId, {
        ...deps,
        appendConnectCard: (_botId, card) => call.appendEntry(BOT_CONNECT_CARD_ENTRY_KIND, { ...card }),
        hasPendingCard: async (_botId, pluginId) => connectCardPending(await call.entries(), pluginId),
      }),
  };
}

/**
 * `share_image` from the Bot folder. A shared image becomes an
 * `aiden.bot-shared-image` entry once the tool returns.
 */
export function shareImageCandidate(authority: Readonly<BotRuntimeEffectiveAuthority>): BotToolCandidate {
  const build = (share: (attachment: Attachment) => void) =>
    createShareImageTool({
      workspaceRoot: authority.workingDirectory,
      expectedWorkspaceIdentity: authority.managedHome.incarnation,
      scopeToWorkspace: true,
      share,
    });
  return {
    tool: build(() => {
      throw new Error("Sharing needs a Bot conversation.");
    }),
    replay: "unsafe",
    bind: (call) => {
      const shared: Attachment[] = [];
      const tool = build((attachment) => {
        shared.push(attachment);
      });
      return {
        ...tool,
        async execute(toolCallId, params, signal, onUpdate) {
          const result = await tool.execute(toolCallId, params, signal, onUpdate);
          for (const attachment of shared) {
            await call.appendEntry(BOT_SHARED_IMAGE_ENTRY_KIND, sharedImageEntry(attachment));
          }
          return result;
        },
      } satisfies AgentTool;
    },
  };
}

/**
 * Companion vision `inspect_image`. It reads the person's images from the
 * conversation's entries at call time and is replay-safe: it only reads.
 */
export function visionCandidate(
  authority: Readonly<BotRuntimeEffectiveAuthority>,
  options: {
    revalidateBeforeEffect(): Promise<void>;
    dependencies: VisionAnalysisToolDependencies;
  },
): BotToolCandidate | undefined {
  const vision = authority.visionProvider;
  if (vision === undefined) return undefined;
  const build = (attachments: readonly Attachment[]) =>
    createVisionAnalysisTool(
      {
        attachments,
        authority: {
          providerId: vision.sourceProviderId,
          modelId: vision.sourceModelId,
          revalidateBeforeEffect: options.revalidateBeforeEffect,
        },
      },
      options.dependencies,
    );
  const schema = build([]);
  return {
    tool: schema,
    replay: "safe",
    bind: (call) => ({
      ...schema,
      async execute(toolCallId, params, signal, onUpdate) {
        const tool = build(imageAttachmentsFromEntries(await call.entries()));
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    }),
  };
}

/** The `aiden.bot-notice` kind that precedes a routine's input (`bot-session-service.ts`). */
const ROUTINE_NOTICE_KIND = "aiden.bot-notice";
/** How many recent routine inputs are checked when binding a call to its routine. */
const ROUTINE_NOTICES_CHECKED = 32;

/** Request ids of the routine inputs in a conversation, newest first (`entries` newest first, as a call reads them). */
export function routineRequestIdsOf(entries: readonly EntryRecord[]): string[] {
  const requestIds: string[] = [];
  for (const entry of entries) {
    if (requestIds.length >= ROUTINE_NOTICES_CHECKED) break;
    if (entry.kind !== ROUTINE_NOTICE_KIND) continue;
    const data = entry.data as { notice?: unknown; requestId?: unknown } | undefined;
    if (data?.notice === "routine" && typeof data.requestId === "string") requestIds.push(data.requestId);
  }
  return requestIds;
}

/**
 * The routine whose run is making `call`: of the routine inputs in the
 * calling conversation, the one an active run owns (its submission is
 * `placed`), the oldest when the run serves several. `undefined` when the run
 * serves no routine input. Read through the call itself, never through the
 * harness host, whose per-Bot lock a pause, quit or delete holds while it
 * waits for this call.
 */
export async function routineTaskIdOfCall(call: Pick<BotToolCall, "entries" | "submissions">): Promise<string | undefined> {
  const requestIds = routineRequestIdsOf(await call.entries());
  if (requestIds.length === 0) return undefined;
  const records = await call.submissions(requestIds);
  let taskId: string | undefined;
  records.forEach((record, index) => {
    if (record?.status === "placed") taskId = botRoutineTaskIdOf(requestIds[index]!);
  });
  return taskId;
}

/**
 * `routine_notes`, bound per call to the routine whose run is calling it.
 * Ingress (`botIngressAllowsTool`) offers it to routine runs only.
 */
export function routineNotesCandidate(
  botId: string,
  options: {
    notes: Pick<BotRoutineNotesStore, "set" | "delete">;
    /** The routine task id of the calling run, read from the conversation. */
    taskIdOf(call: BotToolCall): Promise<string | undefined>;
  },
): BotToolCandidate {
  const build = (taskId: () => Promise<string | undefined>) =>
    createRoutineNotesTool({ botId, notes: options.notes, taskId });
  return {
    tool: build(async () => undefined),
    // Setting or deleting a key twice leaves the same notes.
    replay: "safe",
    bind: (call) => build(() => options.taskIdOf(call)),
  };
}

/**
 * The Bot's `routines` tool. A proposal's card is appended to the calling
 * conversation, so it shows exactly where the Bot suggested it.
 */
export function routinesCandidate(
  botId: string,
  dependencies: Omit<BotRoutinesToolDependencies, "propose"> & {
    propose(
      botId: string,
      input: Parameters<BotRoutinesToolDependencies["propose"]>[1],
      append: (kind: string, data: Record<string, unknown>) => Promise<void>,
    ): Promise<{ ok: true; proposalId: string } | { ok: false; code: string; error: string }>;
  },
): BotToolCandidate {
  const build = (append: (kind: string, data: Record<string, unknown>) => Promise<void>) =>
    createBotRoutinesTool(botId, {
      list: dependencies.list,
      pause: dependencies.pause,
      propose: (id, input) => dependencies.propose(id, input, append),
    });
  return {
    tool: build(async () => {
      throw new Error("Suggesting a routine needs a Bot conversation.");
    }),
    replay: "unsafe",
    bind: (call) => build((kind, data) => call.appendEntry(kind, data as JsonValue)),
  };
}
