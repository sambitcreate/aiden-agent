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
import { buildAgentTools } from "./tools.js";

/**
 * The exact GenerationContextOptions the last generation for a chat resolved
 * (system prompt + tool schemas after host-disclosed updates). The object is
 * mutated in place by the generation path, so a stored reference stays live
 * for the rest of the session.
 */
const generationProfiles = new Map<string, GenerationContextOptions>();

export function rememberChatContextProfile(
  chatId: string,
  options: GenerationContextOptions,
): void {
  generationProfiles.set(chatId, options);
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

function draftUserMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

/**
 * Static context for a chat that has not generated in this process lifetime.
 * Mirrors the ordinary desktop-chat assembly but never opens MCP connections
 * and skips generation-scoped tools (browser host, Computer Use, subagent
 * delegation factory). The result is an estimate — flagged "estimated" by the
 * projection — until the next real generation registers exact options.
 */
async function ambientContextOptions(
  chatId: string,
  contextWindow: number,
  supportsImages: boolean,
): Promise<GenerationContextOptions | undefined> {
  const chat = await chatStore.get(chatId);
  if (!chat) return undefined;
  const workspaceId = persistedChatWorkspaceId(chat.workspaceId);
  const workspace = workspaceId ? await configStore.getWorkspace(workspaceId) : undefined;
  const folderPath = workspace?.folderPath;
  const permission = workspace?.permission ?? "ask";
  const key = `${contextWindow}:${supportsImages}:${workspaceId ?? ""}:${folderPath ?? ""}:${permission}`;
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
  const systemPrompt = await buildSystemPrompt(
    folderPath,
    branch,
    permission,
    /* subagentsAvailable mirrors eligibility, not the ambient tool list. */
    Boolean(workspaceId && folderPath) && permission !== "none",
    skillsEnabled,
    skillSnapshot,
    new Set(tools.map((tool) => tool.name)),
  );
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
  draftText?: string,
): Promise<ChatContextPressureV1 | null> {
  const chat = await chatStore.get(chatId);
  if (!chat?.providerId || !chat.model) return null;
  let model;
  try {
    model = await resolveCompactionModelMetadata(chat.providerId, chat.model, chatId);
  } catch {
    return null;
  }
  const messages = await journalMessages(chatId, chat.createdAt);
  if (!messages) return null;
  const supportsImages = model.input.includes("image");
  const options =
    generationProfiles.get(chatId) ??
    (await ambientContextOptions(chatId, model.contextWindow, supportsImages));
  if (!options) return null;
  const projected =
    draftText && draftText.trim() ? [...messages, draftUserMessage(draftText)] : messages;
  return projectChatContextPressure(projected, options);
}
