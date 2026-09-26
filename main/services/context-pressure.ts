// Composer context meter: exposes the runtime's own next-request projection
// (projectChatContextUsage over the Pi journal + the generation's static
// context) as a renderer-safe snapshot. Nothing here invents a second token
// estimator; the same projectNextContextUsage that gates compaction produces
// the numbers, so the meter trips exactly when the runtime would compact.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatContextPressureV1 } from "../../renderer/shared/context-pressure.js";
import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { chatStore } from "./chat-store.js";
import { configStore } from "./config-store.js";
import { gitInfo } from "./git.js";
import { projectChatContextPressure, type GenerationContextOptions } from "./generation-context.js";
import { resolveCompactionModelMetadata } from "./model-runtime.js";
import { piCompactionSessionStore } from "./pi-compaction-session-store.js";
import { skillRegistry } from "./skill-registry-main.js";
import { buildSystemPrompt } from "./chat-system-prompt.js";
import { aidenConfigDir } from "./aiden-config-dir.js";
import {
  agentsInstructionFingerprint,
  withAgentsInstructionsEstimate,
  type AgentsInstructionRoots,
} from "./agents-instructions.js";
import {
  createGenerationContextProfile,
  nextRequestContextOptions,
  rememberedContextOptions,
  type GenerationContextProfile,
  type GenerationContextScope,
} from "./context-profile.js";
import { buildAgentTools } from "./tools.js";
import { draftUserPiMessage } from "./generation-messages.js";

const generationProfiles = new Map<string, GenerationContextProfile>();

/**
 * Callers register right after the runtime applied AGENTS.md to `options`
 * (generation start, and each pre-request projection).
 */
export function rememberChatContextProfile(
  chatId: string,
  options: GenerationContextOptions,
  scope?: GenerationContextScope,
): void {
  generationProfiles.set(chatId, createGenerationContextProfile(options, scope));
}

export function forgetChatContextProfile(chatId: string): void {
  generationProfiles.delete(chatId);
  ambientProfiles.delete(chatId);
  journalSnapshots.delete(chatId);
}

interface AmbientProfile {
  key: string;
  options: GenerationContextOptions;
}
const ambientProfiles = new Map<string, AmbientProfile>();

interface JournalSnapshot {
  at: number;
  messages: AgentMessage[];
}
const journalSnapshots = new Map<string, JournalSnapshot>();
/** Freshness window for draft-typing recomputes; explicit triggers bypass via draftText=undefined callers passing force. */
const JOURNAL_SNAPSHOT_TTL_MS = 1_500;

interface DraftContextPressureSelection {
  providerId?: string;
  modelId?: string;
  attachments?: {
    id: string;
    name: string;
    kind: "image" | "text";
    mimeType: string;
    textLength?: number;
  }[];
}

/**
 * Rebuild a draft attachment descriptor into the shape `draftUserPiMessage`
 * consumes. The estimator prices each image part flat and each text
 * attachment by character count, so only the payload lengths need to match —
 * never the bytes themselves.
 */
function draftAttachmentsForProjection(
  attachments: DraftContextPressureSelection["attachments"],
): Parameters<typeof draftUserPiMessage>[1] {
  return attachments?.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    size: attachment.textLength ?? 0,
    ...(attachment.kind === "image"
      ? { data: "x" }
      : { text: "x".repeat(attachment.textLength ?? 0) }),
  }));
}

/**
 * Static context for a chat that has not generated in this process lifetime.
 * Mirrors the ordinary desktop-chat assembly but never opens MCP connections
 * and skips generation-scoped tools (browser host, Computer Use, subagent
 * delegation factory). The result is an estimate — flagged "estimated" by the
 * projection — until the next real generation registers exact options.
 */
/**
 * The chat's currently authorized workspace scope and the AGENTS.md roots a
 * desktop generation started now would read (llm-client appends global and
 * workspace guidance before every provider request).
 */
async function currentInstructionScope(chatWorkspaceId: string | undefined) {
  const workspaceId = persistedChatWorkspaceId(chatWorkspaceId);
  const workspace = workspaceId ? await configStore.getWorkspace(workspaceId) : undefined;
  const folderPath = workspace?.folderPath;
  const permission = workspace?.permission ?? "ask";
  const instructionRoots: AgentsInstructionRoots = {
    globalRoot: aidenConfigDir(),
    workspaceRoot: permission !== "none" ? folderPath : undefined,
  };
  return { workspaceId, workspace, folderPath, permission, instructionRoots };
}

async function ambientContextOptions(
  chatId: string,
  contextWindow: number,
  supportsImages: boolean,
): Promise<GenerationContextOptions | undefined> {
  const chat = await chatStore.get(chatId);
  if (!chat) return undefined;
  const { workspaceId, workspace, folderPath, permission, instructionRoots } =
    await currentInstructionScope(chat.workspaceId);
  const instructionFingerprint = await agentsInstructionFingerprint(instructionRoots);
  const key = `${contextWindow}:${supportsImages}:${workspaceId ?? ""}:${folderPath ?? ""}:${permission}:${instructionFingerprint}`;
  const cached = ambientProfiles.get(chatId);
  if (cached?.key === key) return cached.options;
  const settings = await configStore.getSettings();
  const skillsEnabled = settings.skillsEnabled !== false;
  const skillSnapshot =
    skillsEnabled && workspace ? await skillRegistry.snapshot(workspace.id) : undefined;
  const git =
    folderPath &&
    (await gitInfo(folderPath).then(
      (info) => info,
      () => ({ isRepo: false as const }),
    ));
  const branch = git && git.isRepo ? git.branch : undefined;
  const tools = await buildAgentTools({
    workspaceId,
    workspaceRoot: folderPath,
    skillSnapshot,
    permission,
    allowScheduling: true,
    // Passive reads must never connect to MCP servers just to measure context.
    allowMcpTools: false,
    // The delegation tool is bound to a live supervisor factory per generation.
    allowSubagents: false,
    includeCodingTools: true,
  });
  const hostPrompt = await buildSystemPrompt(
    folderPath,
    branch,
    permission,
    /* subagentsAvailable mirrors eligibility, not the ambient tool list. */
    Boolean(workspaceId && folderPath) && permission !== "none",
    skillsEnabled,
    skillSnapshot,
    new Set(tools.map((tool) => tool.name)),
  );
  const systemPrompt = await withAgentsInstructionsEstimate(hostPrompt, instructionRoots);
  const options: GenerationContextOptions = {
    contextWindow,
    systemPrompt,
    tools,
    supportsImages,
    providerId: chat.providerId,
    modelId: chat.model,
  };
  ambientProfiles.set(chatId, { key, options });
  return options;
}

async function journalMessages(
  chatId: string,
  createdAt: number,
): Promise<AgentMessage[] | undefined> {
  const cached = journalSnapshots.get(chatId);
  if (cached && Date.now() - cached.at < JOURNAL_SNAPSHOT_TTL_MS) {
    return cached.messages;
  }
  const opened = await piCompactionSessionStore.openChatIfEligible(chatId, { createdAt });
  if (!opened.session) return undefined;
  const context = await opened.session.buildContext();
  journalSnapshots.set(chatId, { at: Date.now(), messages: context.messages });
  return context.messages;
}

/** A generation just wrote to the journal; drop the cached message snapshot. */
export function invalidateChatContextJournal(chatId: string): void {
  journalSnapshots.delete(chatId);
}

/**
 * Project next-request context pressure for a chat. Returns null when the
 * chat has no selected model or its journal cannot be opened — the composer
 * then shows the quiet "unknown" state instead of a fabricated number.
 */
export async function chatContextPressure(
  chatId: string,
  draft?: { draftText?: string } & DraftContextPressureSelection,
): Promise<ChatContextPressureV1 | null> {
  const chat = await chatStore.get(chatId);
  if (!chat) return null;
  // The composer selection leads the persisted chat pair — a model the user
  // just picked in the picker must price the next request before it commits.
  // An empty selection id (picker not settled) falls back like an absent one.
  const providerId = draft?.providerId || chat.providerId;
  const modelId = draft?.modelId || chat.model;
  if (!providerId || !modelId) return null;
  let model;
  try {
    model = await resolveCompactionModelMetadata(providerId, modelId, chatId);
  } catch {
    return null;
  }
  const messages = await journalMessages(chatId, chat.createdAt);
  if (!messages) return null;
  const supportsImages = model.input.includes("image");
  const currentScope = await currentInstructionScope(chat.workspaceId);
  const overrides = await configStore
    .getProvider(providerId)
    .then((provider) => provider?.modelMetadata?.[modelId]?.overrides)
    .catch(() => undefined);
  const base =
    (await rememberedContextOptions(generationProfiles.get(chatId), {
      providerId,
      modelId,
      contextWindow: model.contextWindow,
      supportsImages,
      instructionRoots: currentScope.instructionRoots,
      permission: currentScope.permission,
      toolsDisabled: overrides?.toolCall === false,
    })) ?? (await ambientContextOptions(chatId, model.contextWindow, supportsImages));
  if (!base) return null;
  // Keep the generation-accurate static context (tools + system prompt) while
  // overriding the fields a live model/provider change rewrites, including a
  // custom model's tool policy (tool calls disabled sends no tools).
  const options = nextRequestContextOptions(base, {
    providerId,
    modelId,
    contextWindow: model.contextWindow,
    supportsImages,
    overrides,
  });
  const hasDraft =
    (draft?.draftText !== undefined && draft.draftText.trim() !== "") ||
    (draft?.attachments?.length ?? 0) > 0;
  const projected = hasDraft
    ? [
        ...messages,
        draftUserPiMessage(
          draft?.draftText ?? "",
          draftAttachmentsForProjection(draft?.attachments),
          supportsImages,
        ),
      ]
    : messages;
  return projectChatContextPressure(projected, options);
}
