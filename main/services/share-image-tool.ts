import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { MAX_IMAGE_BYTES, imageBytesMatchMime } from "./attachments.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import type { Attachment } from "./types.js";

export const SHARE_IMAGE_TOOL_NAME = "share_image";

export interface ShareImageToolDependencies {
  workspaceRoot: string;
  share(attachment: Attachment): void;
  /** Bot callers use a workspace-only path contract; ordinary callers retain existing behavior. */
  scopeToWorkspace?: boolean;
  expectedWorkspaceIdentity?: { readonly device: string; readonly inode: string };
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function verifyScopedWorkspace(
  dependencies: ShareImageToolDependencies,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new Error("Image sharing was cancelled.");
  const canonical = await fs.realpath(dependencies.workspaceRoot);
  const metadata = await fs.stat(canonical, { bigint: true });
  if (!metadata.isDirectory()) {
    throw new Error("The authorized image folder changed during this response.");
  }
  const expected = dependencies.expectedWorkspaceIdentity;
  if (
    expected &&
    (metadata.dev.toString() !== expected.device || metadata.ino.toString() !== expected.inode)
  ) {
    throw new Error("The authorized image folder changed during this response.");
  }
  return canonical;
}

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

function completeImage(bytes: Buffer, mimeType: "image/png" | "image/jpeg"): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 2 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  }
  const trailer = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  return bytes.length >= trailer.length && bytes.subarray(-trailer.length).equals(trailer);
}

function detectedMimeType(bytes: Buffer): "image/png" | "image/jpeg" | undefined {
  if (imageBytesMatchMime(bytes, "image/png") && completeImage(bytes, "image/png")) {
    return "image/png";
  }
  if (imageBytesMatchMime(bytes, "image/jpeg") && completeImage(bytes, "image/jpeg")) {
    return "image/jpeg";
  }
  return undefined;
}

function safeDisplayName(filePath: string, mimeType: "image/png" | "image/jpeg"): string {
  const fallback = mimeType === "image/png" ? "Image.png" : "Image.jpg";
  const leaf = Array.from(path.basename(filePath))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .trim();
  return Array.from(leaf || fallback).slice(0, 255).join("");
}

async function readVerifiedImage(filePath: string, signal?: AbortSignal): Promise<{
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg";
  resolvedPath: string;
}> {
  if (signal?.aborted) throw signal.reason ?? new Error("Image sharing was cancelled.");
  const resolvedPath = await fs.realpath(filePath);
  const before = await fs.lstat(resolvedPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_IMAGE_BYTES) {
    throw new Error("Choose a PNG or JPEG image no larger than 8 MB.");
  }
  const handle = await fs.open(
    resolvedPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("The image changed before Aiden could share it.");
    }
    const bytes = await handle.readFile();
    if (signal?.aborted) throw signal.reason ?? new Error("Image sharing was cancelled.");
    const after = await fs.lstat(resolvedPath);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== bytes.length ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error("The image changed while Aiden was reading it.");
    }
    const mimeType = detectedMimeType(bytes);
    if (!mimeType) throw new Error("Only complete PNG and JPEG images can be shared in chat.");
    return { bytes, mimeType, resolvedPath };
  } finally {
    await handle.close();
  }
}

export function createShareImageTool(dependencies: ShareImageToolDependencies): AgentTool {
  return declarePiRuntimeReplay({
    name: SHARE_IMAGE_TOOL_NAME,
    label: "Share Image",
    description:
      "Attach a PNG or JPEG file from this Mac to your response so the user can receive it in Aiden on Mac, iPhone, or iPad. This is an outbound sharing tool: it cannot inspect an image or add one to model input. Never call it to view, understand, or analyze an image. Images attached by the user are already supplied in the conversation when the selected model supports vision. Use this tool only when the user asks to see or receive a local image file. Relative paths start at the active workspace; absolute paths are accepted after user approval.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative or absolute path to the PNG or JPEG." }),
    }),
    execute: async (_toolCallId, rawParams, signal): Promise<AgentToolResult<null>> => {
      const suppliedPath = (rawParams as { path?: unknown }).path;
      if (typeof suppliedPath !== "string" || suppliedPath.trim().length === 0) {
        throw new Error("An image path is required.");
      }
      const scopedRoot = dependencies.scopeToWorkspace
        ? await verifyScopedWorkspace(dependencies, signal)
        : undefined;
      const requestedPath = path.isAbsolute(suppliedPath)
        ? path.normalize(suppliedPath)
        : path.resolve(scopedRoot ?? dependencies.workspaceRoot, suppliedPath);
      const image = await readVerifiedImage(requestedPath, signal);
      if (scopedRoot && !pathInside(scopedRoot, image.resolvedPath)) {
        throw new Error("Bot images must come from this Bot's folder.");
      }
      if (scopedRoot) await verifyScopedWorkspace(dependencies, signal);
      const attachment: Attachment = {
        id: `shared_${randomUUID()}`,
        name: safeDisplayName(image.resolvedPath, image.mimeType),
        mimeType: image.mimeType,
        kind: "image",
        size: image.bytes.length,
        data: image.bytes.toString("base64"),
      };
      dependencies.share(attachment);
      return textResult(
        JSON.stringify({ shared: true, name: attachment.name, size: attachment.size }),
      );
    },
  }, "never");
}
