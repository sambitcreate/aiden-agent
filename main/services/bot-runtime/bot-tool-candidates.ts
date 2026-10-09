// Durable bindings for the legacy Bot tools whose state belongs in the
// conversation rather than in a closure. Each reuses the legacy factory: the
// adapter builds the factory's tool per call from the conversation entries.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/chord";
import type { EntryRecord } from "@earendil-works/pi-durable";
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
import type { BotToolCall } from "./tool-adapter.js";

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

/** Request ids of the routine inputs in a conversation, newest first. */
export function routineRequestIdsOf(entries: readonly EntryRecord[]): string[] {
  const requestIds: string[] = [];
  for (let index = entries.length - 1; index >= 0 && requestIds.length < ROUTINE_NOTICES_CHECKED; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== ROUTINE_NOTICE_KIND) continue;
    const data = entry.data as { notice?: unknown; requestId?: unknown } | undefined;
    if (data?.notice === "routine" && typeof data.requestId === "string") requestIds.push(data.requestId);
  }
  return requestIds;
}

/**
 * The routine whose run is calling: the first input of the Bot's current run
 * (`runningSubmissionId`) matched against the routine inputs in the
 * conversation. `undefined` when the run does not start with a routine input.
 */
export async function routineTaskIdOfRun(
  entries: readonly EntryRecord[],
  lookup: {
    runningSubmissionId(): Promise<string | undefined>;
    submissionIdOf(requestId: string): Promise<string | undefined>;
  },
): Promise<string | undefined> {
  const running = await lookup.runningSubmissionId();
  if (running === undefined) return undefined;
  for (const requestId of routineRequestIdsOf(entries)) {
    if ((await lookup.submissionIdOf(requestId)) === running) return botRoutineTaskIdOf(requestId);
  }
  return undefined;
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
