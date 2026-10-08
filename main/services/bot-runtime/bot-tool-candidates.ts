// Durable bindings for the legacy Bot tools whose state belongs in the
// conversation rather than in a closure. Each reuses the legacy factory: the
// adapter builds the factory's tool per call from the conversation entries.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import { createShareImageTool } from "../share-image-tool.js";
import type { Attachment } from "../types.js";
import {
  createVisionAnalysisTool,
  type VisionAnalysisToolDependencies,
} from "../vision-analysis-tool-core.js";
import { BOT_SHARED_IMAGE_ENTRY_KIND, imageAttachmentsFromEntries, sharedImageEntry } from "./bot-images.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";

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
