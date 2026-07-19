// Chat generation via pi's embedded agent loop (@earendil-works/pi-agent-core +
// pi-ai). A fresh Agent runs per generation: it owns multi-step tool calling
// (folder-scoped coding tools, Exa search, Agent Skills, MCP servers) and
// streams assistant text. Text deltas and tool activity are pushed to the
// renderer as broadcasts.
//
// Workspaces bind a folder + a permission level. In "ask" mode the agent pauses
// before any mutating tool (write/edit/run_command) via pi's `beforeToolCall`
// hook and waits for the user to Allow or Deny in the UI.

import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { ipcMain, logger } from "../platform.js";
import { buildAgentTools } from "./tools.js";
import { APPROVAL_TOOL_NAMES, summarizeToolCall } from "./coding-tools.js";
import { gitInfo } from "./git.js";
import { modelsCatalog } from "./models-catalog.js";
import { configStore } from "./config-store.js";
import { resolveModelRuntime } from "./model-runtime.js";
import type { ApprovalDecision, ChatStartParams, WorkspacePermission } from "./types.js";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

const active = new Map<string, { agent: Agent; workspaceId?: string }>();
/** Approval requests awaiting a user decision, keyed by approvalId. */
const pendingApprovals = new Map<string, (allowed: boolean) => void>();

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function buildSystemPrompt(folderPath: string | undefined, branch: string | undefined, permission: WorkspacePermission): string {
  const base =
    "You are Pi, a capable AI assistant. Respond clearly and concisely, using Markdown for formatting and fenced code blocks for code.";
  if (!folderPath || permission === "none") {
    return `${base} Call the available tools when they help answer the user's request.`;
  }
  const git = branch ? ` It is a git repository on branch \`${branch}\`.` : "";
  return (
    `${base}\n\n` +
    `You are working inside the folder: ${folderPath}.${git} ` +
    "You have tools to read, search, list, and edit files and to run shell commands in this folder. " +
    "All file paths are relative to this folder. Prefer editing existing files over creating new ones, " +
    "read a file before editing it, and keep changes surgical. " +
    (permission === "ask"
      ? "The user must approve each file write and shell command before it runs."
      : "You may make changes and run commands directly.")
  );
}

// Aiden Agent stores plain user/assistant text (+ optional attachments).
// Rehydrate the transcript into pi messages so the agent continues from full
// history. Image attachments are only sent when the model supports vision; text
// attachments are always inlined as extra context.
function toPiMessages(params: ChatStartParams, model: Model<Api>, vision: boolean): Message[] {
  const now = Date.now();
  return params.messages.map((m): Message => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: m.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: now,
      };
    }

    const attachments = m.attachments ?? [];
    if (attachments.length === 0) {
      return { role: "user", content: m.content, timestamp: now };
    }

    // Build a content block array: text files inlined, images as image blocks.
    const parts: (TextContent | ImageContent)[] = [];
    const textFiles = attachments.filter((a) => a.kind === "text" && a.text);
    const textPrefix = textFiles
      .map((a) => `Attached file: ${a.name}\n\`\`\`\n${a.text}\n\`\`\``)
      .join("\n\n");
    const combinedText = [textPrefix, m.content].filter(Boolean).join("\n\n");
    if (combinedText) parts.push({ type: "text", text: combinedText });
    if (vision) {
      for (const a of attachments) {
        if (a.kind === "image" && a.data) parts.push({ type: "image", data: a.data, mimeType: a.mimeType });
      }
    }
    return { role: "user", content: parts.length ? parts : m.content, timestamp: now };
  });
}

function newApprovalId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const llmClient = {
  async start(streamId: string, params: ChatStartParams): Promise<void> {
    const runtime = await resolveModelRuntime(params.providerId, params.model);
    const { provider, model, apiKey, streams } = runtime;

    // Resolve the workspace: folder + permission drive the tool set + approvals.
    const workspace = params.workspaceId ? await configStore.getWorkspace(params.workspaceId) : undefined;
    const permission: WorkspacePermission = workspace?.permission ?? "ask";
    const folderPath = workspace?.folderPath;
    const git = folderPath ? await gitInfo(folderPath) : { isRepo: false };

    const tools = await buildAgentTools({ workspaceRoot: folderPath, permission });
    // Only forward image attachments to vision-capable models (models.dev).
    const modelInfo = await modelsCatalog.info(provider.id, params.model);

    const deniedToolCalls = new Set<string>();
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(folderPath, git.branch, permission),
        model,
        tools,
        messages: toPiMessages(params, model, modelInfo.vision),
      },
      getApiKey: () => apiKey ?? undefined,
      streamFn: (m, context, options) =>
        streams.streamSimple(m, context, {
          ...options,
          apiKey: options?.apiKey ?? apiKey ?? undefined,
        }),
      // In "ask" mode, pause before mutating tools until the user approves.
      beforeToolCall: async (context, signal) => {
        if (permission !== "ask" || !APPROVAL_TOOL_NAMES.has(context.toolCall.name)) return undefined;
        const approvalId = newApprovalId();
        const summary = summarizeToolCall(context.toolCall.name, context.args);
        ipcMain.broadcast("chat:approval", { streamId, approvalId, toolName: context.toolCall.name, summary });
        const allowed = await new Promise<boolean>((resolve) => {
          pendingApprovals.set(approvalId, resolve);
          if (signal?.aborted) resolve(false);
          else signal?.addEventListener("abort", () => resolve(false), { once: true });
        });
        pendingApprovals.delete(approvalId);
        if (!allowed && !signal?.aborted) deniedToolCalls.add(context.toolCall.id);
        return allowed ? undefined : { block: true, reason: "The user denied this action." };
      },
    });
    active.set(streamId, { agent, workspaceId: params.workspaceId });

    let full = "";
    let errored: string | null = null;

    agent.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const e = event.assistantMessageEvent;
          if (e.type === "text_delta") {
            full += e.delta;
            ipcMain.broadcast("chat:delta", { streamId, delta: e.delta });
          } else if (e.type === "error" && e.reason === "error") {
            errored = e.error.errorMessage ?? "Generation failed.";
          }
          break;
        }
        case "tool_execution_start":
          ipcMain.broadcast("chat:tool", { streamId, phase: "call", toolName: event.toolName });
          break;
        case "tool_execution_end": {
          const denied = deniedToolCalls.delete(event.toolCallId);
          ipcMain.broadcast("chat:tool", {
            streamId,
            phase: denied ? "blocked" : event.isError ? "error" : "result",
            toolName: event.toolName,
          });
          break;
        }
        default:
          break;
      }
    });

    void (async () => {
      try {
        await agent.continue();
        if (errored) {
          ipcMain.broadcast("chat:error", { streamId, message: errored });
        } else {
          // Covers both normal completion and user abort (partial `full`).
          ipcMain.broadcast("chat:done", { streamId, content: full });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("pi", `Generation failed for stream ${streamId}`, error);
        ipcMain.broadcast("chat:error", { streamId, message });
      } finally {
        active.delete(streamId);
      }
    })();
  },

  /** Resolve a pending tool-approval request from the UI. */
  approve(approvalId: string, decision: ApprovalDecision): void {
    const resolve = pendingApprovals.get(approvalId);
    if (resolve) resolve(decision === "allow");
  },

  cancel(streamId: string): void {
    active.get(streamId)?.agent.abort();
  },

  /** Stop generations whose tool set was snapshotted from this workspace. */
  cancelWorkspace(workspaceId: string): void {
    for (const entry of active.values()) {
      if (entry.workspaceId === workspaceId) entry.agent.abort();
    }
  },
};
