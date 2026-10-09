import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { isPathInside } from "../shared/path-containment.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChatHtmlArtifactV1, HtmlArtifactLayout } from "../../renderer/shared/chat-artifacts.js";
import { CHAT_ARTIFACT_VERSION, isHtmlArtifactLayout } from "../../renderer/shared/chat-artifacts.js";
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
import {
  createSubagentFileMutatorClient,
  SubagentFileMutatorError,
} from "./subagents/subagent-file-mutator-io.js";
import {
  GENERATIVE_UI_GUIDE_MODULES,
  generativeUiGuide,
  isGenerativeUiGuideModule,
} from "./generative-ui-guide.js";
import type { InlineVisualsMode } from "../../renderer/shared/appearance.js";

export const GENERATIVE_UI_EXTENSION_ID = "aiden.gui.generative-ui";
export const VISUALIZE_GUIDE_TOOL_NAME = "visualize_guide" as const;
import { RENDER_ARTIFACT_TOOL_NAME } from "../../renderer/shared/generative-ui.js";

export const GENERATIVE_UI_TOOL_NAME = RENDER_ARTIFACT_TOOL_NAME;

const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

export interface GenerativeUiExtensionScope {
  usageSource?: string;
  interactionSurface?: string;
  assistantMode: boolean;
  /** Only needed for `path` rendering; inline HTML works in every chat. */
  workspaceRoot?: string;
  permission: string;
  excluded: boolean;
  /** The user's Settings → Appearance choice; automatic when absent. */
  inlineVisuals?: InlineVisualsMode;
  /** The user invoked /visualize for this turn. */
  visualize?: boolean;
}

export function shouldEnableGenerativeUiExtension(scope: GenerativeUiExtensionScope): boolean {
  const mode = scope.inlineVisuals ?? "automatic";
  if (mode === "off" || (mode === "on_request" && scope.visualize !== true)) return false;
  return (
    scope.usageSource === "chat" &&
    scope.interactionSurface !== "telegram" &&
    !scope.assistantMode &&
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
  /** Absent in chats without workspace access: only inline `html` renders. */
  workspaceRoot?: string;
  artifactNamespace?: string;
  existingChatHtmlBytes?: number;
  existingChatHtmlCount?: number;
  preferArtifactThisTurn?: boolean;
  onArtifact: (
    artifact: ChatHtmlArtifactV1,
    html: string,
    context: { toolCallId: string; layout: HtmlArtifactLayout },
  ) => boolean | void | Promise<boolean | void>;
  beforeArtifact?: () => void | Promise<void>;
}

function resolveWorkspaceHtml(
  root: string,
  suppliedPath: string,
): { relative: string } {
  if (
    suppliedPath.length === 0 ||
    suppliedPath.length > 4096 ||
    suppliedPath.includes("\0") ||
    suppliedPath.includes("\\") ||
    path.isAbsolute(suppliedPath) ||
    WINDOWS_ABSOLUTE_PATH.test(suppliedPath)
  ) {
    throw new Error("render_artifact path must be a relative workspace HTML file.");
  }
  const absolute = path.resolve(root, suppliedPath);
  const relative = path.relative(root, absolute);
  if (!isPathInside(root, absolute, { allowRoot: false })) {
    throw new Error(`Path "${suppliedPath}" is outside the workspace folder.`);
  }
  const extension = path.extname(absolute).toLowerCase();
  if (!HTML_EXTENSIONS.has(extension)) {
    throw new Error(`${suppliedPath} is not an .html or .htm file.`);
  }
  return { relative };
}

function resolveWorkspaceRoot(workspaceRoot: string) {
  const canonicalRoot = realpathSync(path.resolve(workspaceRoot));
  const rootIdentity = statSync(canonicalRoot, { bigint: true });
  if (!rootIdentity.isDirectory()) throw new Error("The workspace root is not a directory.");
  return {
    canonicalRoot,
    identity: Object.freeze({
      canonicalPath: canonicalRoot,
      device: rootIdentity.dev.toString(10),
      inode: rootIdentity.ino.toString(10),
    }),
  };
}

export function createGenerativeUiExtensionRuntime(
  options: GenerativeUiExtensionOptions,
): { extension: PiAgentRuntimeExtension } {
  const workspace = options.workspaceRoot ? resolveWorkspaceRoot(options.workspaceRoot) : undefined;
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
  const titlesInGeneration = new Map<string, { mediaId: string; size: number; toolCallId: string }>();

  const tool: AgentTool = declarePiRuntimeReplay(
    {
      name: GENERATIVE_UI_TOOL_NAME,
      label: "Render Artifact",
      description:
        "Render an interactive HTML/CSS/JS visualization inline in the current Aiden chat, inside the reply at the point you call it. Use this for charts, diagrams, dashboards, interactive explainers, or UI mockups instead of huge Markdown tables. Provide either `html` (preferred) or a workspace-relative `.html` path. Vanilla HTML/CSS/JS only. Chart.js (`Chart`), Plotly (`Plotly`), and KaTeX (`katex`) are injected by Aiden—do not load CDN scripts or call network APIs. Do not use this for ordinary prose or raster images (use display_image).",
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
            description:
              "Workspace-relative .html file to copy into Aiden-owned storage. Needs workspace access; otherwise pass html.",
            minLength: 1,
            maxLength: 4096,
          }),
        ),
        layout: Type.Optional(
          Type.Union([Type.Literal("column"), Type.Literal("wide")], {
            description:
              "column (default): the reading column, about 690px wide, for charts, cards, diagrams, and small tools. wide: spans the whole chat pane (up to about 1280px) and follows the window size, for dashboards, UI mockups, multi-panel layouts, and wide tables.",
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
          const input = params as { title?: unknown; html?: unknown; path?: unknown; layout?: unknown };
          const title = requireGenerativeUiTitle(input.title);
          if (input.layout !== undefined && !isHtmlArtifactLayout(input.layout)) {
            throw new Error('render_artifact layout must be "column" or "wide".');
          }
          const layout: HtmlArtifactLayout = input.layout ?? "column";
          const hasHtml = typeof input.html === "string" && input.html.length > 0;
          const hasPath = typeof input.path === "string" && input.path.length > 0;
          if (hasHtml === hasPath) {
            throw new Error("render_artifact requires exactly one of html or path.");
          }
          let html: string;
          let sourceLabel = "inline HTML";
          if (hasPath) {
            if (!workspace) {
              throw new Error("render_artifact path requires workspace access; pass html instead.");
            }
            const resolved = resolveWorkspaceHtml(workspace.canonicalRoot, input.path as string);
            const relative = resolved.relative.split(path.sep).join("/");
            const reader = createSubagentFileMutatorClient({
              workspaceRoot: workspace.identity,
            });
            try {
              html = await reader.readHtml(randomUUID(), relative, signal);
            } catch (error) {
              if (error instanceof SubagentFileMutatorError && error.failure === "cancelled") {
                throw new Error("Artifact rendering was cancelled.");
              }
              throw new Error(`Path "${resolved.relative}" could not be read safely.`);
            } finally {
              await reader.close();
            }
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
          // A same-title replace stays where the visual first appeared.
          const placementCallId = replacing?.toolCallId ?? toolCallId;
          const presented =
            (await options.onArtifact(artifact, html, { toolCallId: placementCallId, layout })) !== false;
          if (presented && !replacing) {
            displayedCount += 1;
            displayedBytes = nextBytes;
            titlesInGeneration.set(title, { mediaId, size, toolCallId });
          } else if (presented && replacing) {
            displayedBytes = nextBytes;
            titlesInGeneration.set(title, { ...replacing, size });
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

  const guideTool: AgentTool = declarePiRuntimeReplay(
    {
      name: VISUALIZE_GUIDE_TOOL_NAME,
      label: "Visualize Guide",
      description:
        "Read Aiden's design guidance for inline visuals before your first render_artifact call in a conversation. Request only the modules you need.",
      parameters: Type.Object({
        modules: Type.Array(
          Type.Union(GENERATIVE_UI_GUIDE_MODULES.map((module) => Type.Literal(module))),
          { minItems: 1, maxItems: GENERATIVE_UI_GUIDE_MODULES.length },
        ),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<null>> => {
        const modules = (params as { modules?: unknown }).modules;
        if (!Array.isArray(modules) || modules.length === 0 || !modules.every(isGenerativeUiGuideModule)) {
          throw new Error(
            `visualize_guide modules must be one or more of: ${GENERATIVE_UI_GUIDE_MODULES.join(", ")}.`,
          );
        }
        return { content: [{ type: "text", text: generativeUiGuide(modules) }], details: null };
      },
    },
    "never",
  );

  return {
    extension: {
      id: GENERATIVE_UI_EXTENSION_ID,
      systemPrompt:
        "Aiden can draw inline visuals in this chat with render_artifact. Use one when a comparison, trend, structure, process, or interactive what-if is clearer as a visual than as prose — not for plain answers or raster images (use display_image), and usually at most one per reply. Each visual appears inside your reply in the Aiden desktop chat, at the point you call the tool, on the chat's own background (no frame or border), with its height following its content. It defaults to the reading column (about 690px wide); pass layout \"wide\" when it needs room, such as a dashboard, UI mockup, multi-panel layout, or wide table, and it will span the chat pane and follow the window size. Either way its width changes with the window, so build it fluid. Before your first visual in a conversation, call visualize_guide with the modules you need (design, html, charts, interactive). Keep the reply complete without the visual: state the key takeaway in a sentence. Never load remote scripts or call network APIs from a visual, and do not claim inline visuals are unavailable while these tools are present." +
        (options.preferArtifactThisTurn
          ? " The user invoked /visualize for this turn; prefer render_artifact when a chart, diagram, dashboard, or interactive mockup would help."
          : ""),
      tools: [tool, guideTool],
    },
  };
}

export function createGenerativeUiExtension(
  options: GenerativeUiExtensionOptions,
): PiAgentRuntimeExtension {
  return createGenerativeUiExtensionRuntime(options).extension;
}
