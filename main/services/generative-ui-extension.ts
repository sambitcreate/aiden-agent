import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { CHAT_ARTIFACT_VERSION } from "../../renderer/shared/chat-artifacts.js";
import {
  HTML_ARTIFACT_MIME_TYPE,
  MAX_HTML_ARTIFACT_BYTES,
  MAX_HTML_ARTIFACT_BYTES_PER_CHAT,
  MAX_HTML_ARTIFACTS_PER_CHAT,
  MAX_HTML_ARTIFACTS_PER_RESPONSE,
  MAX_HTML_ARTIFACT_TITLE_CHARS,
} from "../../renderer/shared/generative-ui.js";
import type { PiAgentRuntimeExtension } from "./pi-agent-runtime-harness.js";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import {
  htmlArtifactByteLength,
  requireGenerativeUiTitle,
  validateGenerativeUiHtml,
} from "./generative-ui-html.js";

export const GENERATIVE_UI_EXTENSION_ID = "aiden.gui.generative-ui";
export const GENERATIVE_UI_TOOL_NAME = "render_artifact";

const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

export interface GenerativeUiExtensionScope {
  usageSource?: string;
  interactionSurface?: string;
  assistantMode: boolean;
  workspaceRoot?: string;
  permission: string;
  excluded: boolean;
}

export function shouldEnableGenerativeUiExtension(scope: GenerativeUiExtensionScope): boolean {
  return (
    scope.usageSource === "chat" &&
    scope.interactionSurface !== "telegram" &&
    !scope.assistantMode &&
    Boolean(scope.workspaceRoot) &&
    scope.permission !== "none" &&
    !scope.excluded
  );
}

export function displayedAssistantHtmlUsage(
  messages: readonly {
    role: string;
    htmlArtifacts?: readonly { size: number }[];
  }[],
): { bytes: number; count: number } {
  let bytes = 0;
  let count = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const artifact of message.htmlArtifacts ?? []) {
      if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) continue;
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + artifact.size);
      count += 1;
    }
  }
  return { bytes, count };
}

export interface GenerativeUiExtensionOptions {
  workspaceRoot: string;
  artifactNamespace?: string;
  existingChatHtmlBytes?: number;
  existingChatHtmlCount?: number;
  preferArtifactThisTurn?: boolean;
  onArtifact: (artifact: ChatHtmlArtifactV1, html: string) => boolean | void | Promise<boolean | void>;
  beforeArtifact?: () => void | Promise<void>;
}

function resolveWorkspaceHtml(
  root: string,
  suppliedPath: string,
): { absolute: string; relative: string } {
  if (
    suppliedPath.length === 0 ||
    suppliedPath.length > 4096 ||
    suppliedPath.includes("\0") ||
    path.isAbsolute(suppliedPath) ||
    WINDOWS_ABSOLUTE_PATH.test(suppliedPath)
  ) {
    throw new Error("render_artifact path must be a relative workspace HTML file.");
  }
  const absolute = path.resolve(root, suppliedPath);
  const relative = path.relative(root, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path "${suppliedPath}" is outside the workspace folder.`);
  }
  const extension = path.extname(absolute).toLowerCase();
  if (!HTML_EXTENSIONS.has(extension)) {
    throw new Error(`${suppliedPath} is not an .html or .htm file.`);
  }
  return { absolute, relative };
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertNoSymlinkComponents(root: string, relative: string): Promise<void> {
  let current = root;
  const parts = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Path "${relative}" is not a regular workspace HTML file.`);
    }
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) {
      throw new Error(`Path "${relative}" is not a regular workspace HTML file.`);
    }
    if (last && !stat.isFile()) {
      throw new Error(`Path "${relative}" is not a regular workspace HTML file.`);
    }
  }
}

export function createGenerativeUiExtensionRuntime(
  options: GenerativeUiExtensionOptions,
): { extension: PiAgentRuntimeExtension } {
  const lexicalRoot = path.resolve(options.workspaceRoot);
  const canonicalRoot = realpathSync(lexicalRoot);
  const rootIdentity = statSync(canonicalRoot);
  if (!rootIdentity.isDirectory()) throw new Error("The workspace root is not a directory.");
  const existingChatHtmlBytes = options.existingChatHtmlBytes ?? 0;
  const existingChatHtmlCount = options.existingChatHtmlCount ?? 0;
  if (
    !Number.isSafeInteger(existingChatHtmlBytes) ||
    existingChatHtmlBytes < 0 ||
    !Number.isSafeInteger(existingChatHtmlCount) ||
    existingChatHtmlCount < 0
  ) {
    throw new Error("Invalid existing chat HTML artifact usage.");
  }
  const artifactNamespace = options.artifactNamespace ?? randomUUID();
  let displayedCount = 0;
  let displayedBytes = 0;
  let serial = Promise.resolve();
  const titlesInGeneration = new Map<string, { mediaId: string; size: number }>();

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

  const tool: AgentTool = declarePiRuntimeReplay(
    {
      name: GENERATIVE_UI_TOOL_NAME,
      label: "Render Artifact",
      description:
        "Render an interactive HTML/CSS/JS visualization inline in the current Aiden chat. Use this for charts, diagrams, dashboards, interactive explainers, or UI mockups instead of huge Markdown tables. Provide either `html` (preferred) or a workspace-relative `.html` path. Vanilla HTML/CSS/JS only. Chart.js (`Chart`), Plotly (`Plotly`), and KaTeX (`katex`) are injected by Aiden—do not load CDN scripts or call network APIs. Do not use this for ordinary prose or raster images (use display_image).",
      parameters: Type.Object({
        title: Type.String({
          description: "Short visible title for the artifact frame.",
          minLength: 1,
          maxLength: MAX_HTML_ARTIFACT_TITLE_CHARS,
        }),
        html: Type.Optional(
          Type.String({
            description: "Complete HTML document or fragment. Mutually exclusive with path.",
            minLength: 1,
            maxLength: MAX_HTML_ARTIFACT_BYTES,
          }),
        ),
        path: Type.Optional(
          Type.String({
            description: "Workspace-relative .html file to copy into Aiden-owned storage.",
            minLength: 1,
            maxLength: 4096,
          }),
        ),
      }),
      execute: async (toolCallId, params, signal): Promise<AgentToolResult<null>> => {
        const previous = serial;
        let release!: () => void;
        serial = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          if (signal?.aborted) throw new Error("Artifact rendering was cancelled.");
          const input = params as { title?: unknown; html?: unknown; path?: unknown };
          const title = requireGenerativeUiTitle(input.title);
          const hasHtml = typeof input.html === "string" && input.html.length > 0;
          const hasPath = typeof input.path === "string" && input.path.length > 0;
          if (hasHtml === hasPath) {
            throw new Error("render_artifact requires exactly one of html or path.");
          }
          let html: string;
          let sourceLabel = "inline HTML";
          if (hasPath) {
            const resolved = resolveWorkspaceHtml(canonicalRoot, input.path as string);
            await assertWorkspaceRoot();
            await assertNoSymlinkComponents(canonicalRoot, resolved.relative);
            const noFollow =
              typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
            const handle = await fs.open(resolved.absolute, fsConstants.O_RDONLY | noFollow);
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size < 1 || stat.size > MAX_HTML_ARTIFACT_BYTES) {
                throw new Error(
                  `${resolved.relative} is missing or larger than ${MAX_HTML_ARTIFACT_BYTES.toLocaleString("en-US")} bytes.`,
                );
              }
              const bytes = Buffer.alloc(stat.size);
              const read = await handle.read(bytes, 0, stat.size, 0);
              const payload = bytes.subarray(0, read.bytesRead);
              html = payload.toString("utf8");
              if (!payload.equals(Buffer.from(html, "utf8"))) {
                throw new Error("Artifact HTML is not valid UTF-8.");
              }
            } finally {
              await handle.close();
            }
            await assertWorkspaceRoot();
            sourceLabel = resolved.relative;
          } else {
            html = input.html as string;
          }
          validateGenerativeUiHtml(html);
          const size = htmlArtifactByteLength(html);
          const replacing = titlesInGeneration.get(title);
          const nextBytes = displayedBytes - (replacing?.size ?? 0) + size;
          if (!replacing) {
            if (displayedCount >= MAX_HTML_ARTIFACTS_PER_RESPONSE) {
              throw new Error(
                `Up to ${MAX_HTML_ARTIFACTS_PER_RESPONSE} HTML artifacts can be rendered in one response.`,
              );
            }
            if (existingChatHtmlCount + displayedCount >= MAX_HTML_ARTIFACTS_PER_CHAT) {
              throw new Error(
                `This chat has reached its ${MAX_HTML_ARTIFACTS_PER_CHAT}-artifact limit.`,
              );
            }
          }
          if (
            nextBytes > MAX_HTML_ARTIFACTS_PER_RESPONSE * MAX_HTML_ARTIFACT_BYTES ||
            existingChatHtmlBytes + nextBytes > MAX_HTML_ARTIFACT_BYTES_PER_CHAT
          ) {
            throw new Error("HTML artifacts reached this response or chat's storage limit.");
          }
          await options.beforeArtifact?.();
          if (signal?.aborted) throw new Error("Artifact rendering was cancelled.");
          const mediaId =
            replacing?.mediaId ??
            createHash("sha256")
              .update(artifactNamespace)
              .update("\0")
              .update(toolCallId)
              .digest("hex");
          const id = createHash("sha256").update(html).digest("hex");
          const artifact: ChatHtmlArtifactV1 = {
            version: CHAT_ARTIFACT_VERSION,
            kind: "html",
            id,
            title,
            mimeType: HTML_ARTIFACT_MIME_TYPE,
            size,
            mediaId,
          };
          const presented = (await options.onArtifact(artifact, html)) !== false;
          if (presented && !replacing) {
            displayedCount += 1;
            displayedBytes = nextBytes;
            titlesInGeneration.set(title, { mediaId, size });
          } else if (presented && replacing) {
            displayedBytes = nextBytes;
            titlesInGeneration.set(title, { mediaId: replacing.mediaId, size });
          }
          return {
            content: [
              {
                type: "text",
                text: `Rendered artifact "${title}" inline from ${sourceLabel} (${size} bytes).`,
              },
            ],
            details: null,
          };
        } finally {
          release();
        }
      },
    },
    "never",
  );

  return {
    extension: {
      id: GENERATIVE_UI_EXTENSION_ID,
      systemPrompt:
        "Aiden can render interactive HTML visualizations inline with the render_artifact tool. Use it for charts, diagrams, dashboards, interactive explainers, and UI mockups instead of dumping large tables or asking the user to open a browser. Prefer vanilla HTML/CSS/JS. Chart.js, Plotly, and KaTeX are injected by the host—never fetch remote scripts or call network APIs from the artifact. Do not use render_artifact for ordinary prose or raster images (use display_image). Do not claim inline artifacts are unavailable while this tool is present." +
        (options.preferArtifactThisTurn
          ? " The user invoked /visualize for this turn; prefer render_artifact when a chart, diagram, dashboard, or interactive mockup would help."
          : ""),
      tools: [tool],
    },
  };
}

export function createGenerativeUiExtension(
  options: GenerativeUiExtensionOptions,
): PiAgentRuntimeExtension {
  return createGenerativeUiExtensionRuntime(options).extension;
}
