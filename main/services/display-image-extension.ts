import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathInside } from "../shared/path-containment.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ChatImageArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { CHAT_ARTIFACT_VERSION } from "../../renderer/shared/chat-artifacts.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../renderer/shared/attachment-contract.js";
import { isImageAttachmentPath, readPickedAttachments } from "./attachments.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import {
  DISPLAY_IMAGE_MIME_TYPES,
  MAX_DISPLAY_IMAGE_BYTES_PER_CHAT,
  MAX_DISPLAY_IMAGE_BYTES_PER_RESPONSE,
  MAX_DISPLAY_IMAGE_DIMENSION,
  MAX_DISPLAY_IMAGE_PIXELS,
  MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT,
  MAX_DISPLAY_IMAGE_PIXELS_PER_RESPONSE,
  MAX_DISPLAY_IMAGES_PER_CHAT,
  displayImageDimensions,
  displayedAssistantImageUsage,
  hasCanonicalBase64Padding,
  validateDisplayImageDimensions,
  type ImageDimensions,
} from "./display-image-limits.js";

export {
  MAX_DISPLAY_IMAGE_BYTES_PER_CHAT,
  MAX_DISPLAY_IMAGE_BYTES_PER_RESPONSE,
  MAX_DISPLAY_IMAGE_DIMENSION,
  MAX_DISPLAY_IMAGE_PIXELS,
  MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT,
  MAX_DISPLAY_IMAGE_PIXELS_PER_RESPONSE,
  MAX_DISPLAY_IMAGES_PER_CHAT,
  displayImageDimensions,
  displayedAssistantImageUsage,
  hasCanonicalBase64Padding,
  validateDisplayImageDimensions,
};

export const DISPLAY_IMAGE_EXTENSION_ID = "aiden.gui.display-image";
export const DISPLAY_IMAGE_TOOL_NAME = "display_image";

const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;

export interface DisplayImageExtensionOptions {
  /**
   * The authorized workspace that `display_image` reads from. A folderless
   * conversation omits it: the runtime then presents generated images only and
   * has no `display_image` tool.
   */
  workspaceRoot?: string;
  /** Stable only for this generation; combined with the Pi call id for artifact identity. */
  artifactNamespace?: string;
  existingChatImageBytes?: number;
  existingChatImageCount?: number;
  existingChatImagePixels?: number;
  onArtifact: (
    artifact: ChatImageArtifactV1,
    presentation: Readonly<ImageDimensions>,
    source: ImageArtifactSource,
  ) => boolean | void | Promise<boolean | void>;
  /** Test seam for deterministic cancellation immediately before presentation. */
  beforeArtifact?: () => void | Promise<void>;
}

export interface DisplayImageExtensionRuntime {
  /** The `display_image` contribution; absent without a workspace root. */
  extension: PiAgentRuntimeExtension | undefined;
  presentGeneratedImage(toolCallId: string, image: ImageContent, signal?: AbortSignal): Promise<void>;
}

/** Which tool call presented an image; the call id is Pi's raw provider id. */
export interface ImageArtifactSource {
  tool: "display_image" | "generate_image";
  toolCallId: string;
}

export interface DisplayImageExtensionScope {
  usageSource?: string;
  interactionSurface?: string;
  assistantMode: boolean;
  workspaceRoot?: string;
  permission: string;
  excluded: boolean;
}

/** Keep the GUI tool on ordinary attended workspace chat only. */
export function shouldEnableDisplayImageExtension(scope: DisplayImageExtensionScope): boolean {
  return shouldEnableImageGeneration(scope) && Boolean(scope.workspaceRoot);
}

/**
 * Image generation (and inline presentation of its results) runs in ordinary
 * attended chats. A workspace chat needs a file permission other than `none`;
 * a conversation with no workspace folder reads no files, so it gets image
 * generation regardless of the permission setting.
 */
export function shouldEnableImageGeneration(
  scope: Omit<DisplayImageExtensionScope, "workspaceRoot" | "permission"> &
    Partial<Pick<DisplayImageExtensionScope, "workspaceRoot" | "permission">>,
): boolean {
  return (
    scope.usageSource === "chat" &&
    scope.interactionSurface !== "telegram" &&
    !scope.assistantMode &&
    !scope.excluded &&
    !(scope.workspaceRoot && scope.permission === "none")
  );
}

/** What a chat turn registers for model operations and image presentation. */
export interface ModelOperationsChatPlan {
  /** generate_image, list_operation_models, list_image_references and generated-image presentation. */
  imageTools: boolean;
  /** The classify tool (workspace chats only). */
  classify: boolean;
  /** The display_image tool (workspace chats only). */
  displayImage: boolean;
  /** Add only a one-line "image generation isn't set up" system prompt hint. */
  setupHint: boolean;
  /**
   * Image staging is unavailable. In a workspace chat the turn fails with the
   * repair instructions; a folderless chat logs this and skips only the image pieces.
   */
  staging: "ok" | "fail" | "skip";
}

/**
 * Decide the model-operations wiring for one chat turn. Workspace chats keep
 * every operation tool (`list_operation_models` explains a missing image key);
 * folderless chats get only the image tools, and only when image generation is
 * set up, so a staging problem or missing key never breaks an ordinary chat.
 */
export function planModelOperationsForChat(
  scope: DisplayImageExtensionScope,
  state: { imageGenerationAvailable: boolean; stagingAvailable: boolean },
): ModelOperationsChatPlan {
  const none: ModelOperationsChatPlan = {
    imageTools: false,
    classify: false,
    displayImage: false,
    setupHint: false,
    staging: "ok",
  };
  if (!shouldEnableImageGeneration(scope)) return none;
  if (scope.workspaceRoot) {
    if (!state.stagingAvailable) return { ...none, staging: "fail" };
    return { ...none, imageTools: true, classify: true, displayImage: true };
  }
  if (!state.imageGenerationAvailable) return { ...none, setupHint: true };
  if (!state.stagingAvailable) return { ...none, staging: "skip" };
  return { ...none, imageTools: true };
}

function resolveWorkspaceImage(
  root: string,
  suppliedPath: string,
): {
  absolute: string;
  relative: string;
} {
  if (
    suppliedPath.length === 0 ||
    suppliedPath.length > 4096 ||
    suppliedPath.includes("\0") ||
    path.isAbsolute(suppliedPath) ||
    WINDOWS_ABSOLUTE_PATH.test(suppliedPath)
  ) {
    throw new Error("display_image requires a relative workspace image path.");
  }
  const absolute = path.resolve(root, suppliedPath);
  const relative = path.relative(root, absolute);
  if (!isPathInside(root, absolute, { allowRoot: false })) {
    throw new Error(`Path "${suppliedPath}" is outside the workspace folder.`);
  }
  if (!isImageAttachmentPath(absolute)) {
    throw new Error(`${suppliedPath} is not a supported raster image path.`);
  }
  return { absolute, relative };
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Create one chat-scoped Pi contribution; no tool is installed process-globally. */
export function createDisplayImageExtensionRuntime(
  options: DisplayImageExtensionOptions,
): DisplayImageExtensionRuntime {
  const workspace = options.workspaceRoot === undefined ? undefined : pinWorkspaceRoot(options.workspaceRoot);
  const existingChatImageBytes = options.existingChatImageBytes ?? 0;
  const existingChatImageCount = options.existingChatImageCount ?? 0;
  const existingChatImagePixels = options.existingChatImagePixels ?? 0;
  if (
    !Number.isSafeInteger(existingChatImageBytes) ||
    existingChatImageBytes < 0 ||
    !Number.isSafeInteger(existingChatImageCount) ||
    existingChatImageCount < 0 ||
    !Number.isSafeInteger(existingChatImagePixels) ||
    existingChatImagePixels < 0
  ) {
    throw new Error("Invalid existing chat image usage.");
  }
  const artifactNamespace = options.artifactNamespace ?? randomUUID();

  let displayedCount = 0;
  let displayedBytes = 0;
  let displayedPixels = 0;
  let serial = Promise.resolve();

  const present = async (
    artifact: ChatImageArtifactV1,
    dimensions: ImageDimensions,
    source: ImageArtifactSource,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const pixels = dimensions.width * dimensions.height;
    if (displayedCount >= MAX_ATTACHMENTS_PER_MESSAGE || existingChatImageCount + displayedCount >= MAX_DISPLAY_IMAGES_PER_CHAT) {
      throw new Error("Inline images reached this response or chat's image-count limit.");
    }
    if (displayedBytes + artifact.attachment.size > MAX_DISPLAY_IMAGE_BYTES_PER_RESPONSE ||
        existingChatImageBytes + displayedBytes + artifact.attachment.size > MAX_DISPLAY_IMAGE_BYTES_PER_CHAT) {
      throw new Error("Inline images reached this response or chat's storage limit.");
    }
    if (displayedPixels + pixels > MAX_DISPLAY_IMAGE_PIXELS_PER_RESPONSE ||
        existingChatImagePixels + displayedPixels + pixels > MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT) {
      throw new Error("Inline images reached this response or chat's decoded-pixel limit.");
    }
    const presented = (await options.onArtifact(artifact, dimensions, source)) !== false;
    if (presented) {
      displayedCount += 1;
      displayedBytes += artifact.attachment.size;
      displayedPixels += pixels;
    }
  };

  const createDisplayTool = ({ lexicalRoot, canonicalRoot, rootIdentity }: PinnedWorkspaceRoot): AgentTool => {
    const assertWorkspaceRoot = async (): Promise<void> => {
      const [currentCanonical, currentIdentity] = await Promise.all([
        fs.realpath(lexicalRoot),
        fs.stat(lexicalRoot),
      ]);
      if (
        currentCanonical !== canonicalRoot ||
        !currentIdentity.isDirectory() ||
        !sameIdentity(currentIdentity, rootIdentity)
      ) {
        throw new Error("The authorized workspace root changed during this generation.");
      }
    };

    return declarePiRuntimeReplay(
      {
        name: DISPLAY_IMAGE_TOOL_NAME,
        label: "Display Image",
        description:
          "Display an existing raster image from the workspace inline in Aiden's current chat. Use this after creating or rendering an image, or whenever the user asks to see one. Paths are relative to the workspace root.",
        parameters: Type.Object({
          path: Type.String({
            description: "Raster image path relative to the workspace folder.",
            minLength: 1,
            maxLength: 4096,
          }),
        }),
        execute: async (toolCallId, params, signal): Promise<AgentToolResult<null>> => {
          const previous = serial;
          let release!: () => void;
          serial = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          try {
            if (signal?.aborted) throw new Error("Image display was cancelled.");
            if (displayedCount >= MAX_ATTACHMENTS_PER_MESSAGE) {
              throw new Error(
                `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} images can be displayed in one response.`,
              );
            }
            if (existingChatImageCount + displayedCount >= MAX_DISPLAY_IMAGES_PER_CHAT) {
              throw new Error(
                `This chat has reached its ${MAX_DISPLAY_IMAGES_PER_CHAT}-image inline display limit.`,
              );
            }
            const remainingBytes = Math.min(
              MAX_DISPLAY_IMAGE_BYTES_PER_RESPONSE - displayedBytes,
              MAX_DISPLAY_IMAGE_BYTES_PER_CHAT - existingChatImageBytes - displayedBytes,
            );
            if (remainingBytes < 1) {
              throw new Error("Inline images reached this response or chat's storage limit.");
            }
            const suppliedPath = (params as { path: string }).path;
            // Read beneath the already-pinned canonical root so an authorized
            // workspace opened through a symlink remains usable. Descendant
            // symlinks are still rejected by the hardened attachment reader.
            const resolved = resolveWorkspaceImage(canonicalRoot, suppliedPath);
            await assertWorkspaceRoot();
            const [attachment] = await readPickedAttachments([resolved.absolute], {
              maxBatchBytes: remainingBytes,
              isActive: () => !signal?.aborted,
            });
            await assertWorkspaceRoot();
            if (!attachment || attachment.kind !== "image" || !attachment.data) {
              throw new Error(`${suppliedPath} could not be prepared as an inline image.`);
            }
            const dimensions = validateDisplayImageDimensions(
              Buffer.from(attachment.data, "base64"),
              attachment.mimeType,
              attachment.name,
            );
            const imagePixels = dimensions.width * dimensions.height;
            if (displayedPixels + imagePixels > MAX_DISPLAY_IMAGE_PIXELS_PER_RESPONSE) {
              throw new Error("Inline images reached this response's decoded-pixel limit.");
            }
            if (
              existingChatImagePixels + displayedPixels + imagePixels >
              MAX_DISPLAY_IMAGE_PIXELS_PER_CHAT
            ) {
              throw new Error("This chat has reached its inline-image decoded-pixel limit.");
            }
            await options.beforeArtifact?.();
            if (signal?.aborted) throw new Error("Image display was cancelled.");
            const artifact: ChatImageArtifactV1 = {
              version: CHAT_ARTIFACT_VERSION,
              kind: "image",
              attachment: {
                id: createHash("sha256")
                  .update(artifactNamespace)
                  .update("\0")
                  .update(toolCallId)
                  .digest("hex"),
                name: attachment.name,
                mimeType: attachment.mimeType,
                kind: "image",
                size: attachment.size,
                data: attachment.data,
              },
            };
            await present(artifact, dimensions, { tool: "display_image", toolCallId }, signal);
            return {
              content: [
                {
                  type: "text",
                  text: `Displayed ${resolved.relative} inline (${dimensions.width}×${dimensions.height}).`,
                },
              ],
              details: null,
            };
          } finally {
            release();
          }
        },
      },
      // Replaying a presentation side effect could duplicate an assistant artifact.
      "never",
    );
  };

  return {
    async presentGeneratedImage(toolCallId, image, signal) {
      const previous = serial;
      let release!: () => void;
      serial = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        signal?.throwIfAborted();
        if (!DISPLAY_IMAGE_MIME_TYPES.has(image.mimeType) || image.data.length > Math.ceil(MAX_DISPLAY_IMAGE_BYTES_PER_RESPONSE / 3) * 4) throw new Error("Invalid generated image.");
        const bytes = Buffer.from(image.data, "base64");
        if (bytes.toString("base64") !== image.data) throw new Error("Invalid generated image encoding.");
        const dimensions = validateDisplayImageDimensions(bytes, image.mimeType, "Generated image");
        const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice(6);
        await options.beforeArtifact?.();
        await present({
          version: CHAT_ARTIFACT_VERSION,
          kind: "image",
          attachment: {
            id: createHash("sha256").update(artifactNamespace).update("\0generated\0").update(toolCallId).update("\0").update(image.data).digest("hex"),
            name: `Generated image.${extension}`,
            kind: "image", mimeType: image.mimeType, size: bytes.length, data: image.data,
          },
        }, dimensions, { tool: "generate_image", toolCallId }, signal);
      } finally { release(); }
    },
    extension: workspace
      ? {
          id: DISPLAY_IMAGE_EXTENSION_ID,
          systemPrompt:
            "Aiden can display existing workspace raster images inline with the display_image tool. Use it when the user asks to see an image or when showing a visual artifact is useful. Do not claim inline image display is unavailable while this tool is present.",
          tools: [createDisplayTool(workspace)],
        }
      : undefined,
  };
}

interface PinnedWorkspaceRoot {
  lexicalRoot: string;
  canonicalRoot: string;
  rootIdentity: Stats;
}

function pinWorkspaceRoot(workspaceRoot: string): PinnedWorkspaceRoot {
  const lexicalRoot = path.resolve(workspaceRoot);
  const canonicalRoot = realpathSync(lexicalRoot);
  const rootIdentity = statSync(canonicalRoot);
  if (!rootIdentity.isDirectory()) throw new Error("The workspace root is not a directory.");
  return { lexicalRoot, canonicalRoot, rootIdentity };
}

export function createDisplayImageExtension(
  options: DisplayImageExtensionOptions & { workspaceRoot: string },
): PiAgentRuntimeExtension {
  return createDisplayImageExtensionRuntime(options).extension!;
}
