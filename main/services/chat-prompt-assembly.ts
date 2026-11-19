// The per-request system prompt and tool list of a desktop chat generation,
// from the chat's base prompt and admitted tools. llm-client builds every
// generation's head through these functions, and the prompt-prefix harness
// builds its requests through the same ones, so a change that moves a byte
// of the prefix between turns shows up in the harness the way it would on
// the wire.
//
// Everything here is synchronous and side-effect free apart from the base
// prompt, which reads the skill listing it is given.

import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { applyCustomModelToolPolicy, type CustomModelOptions } from "../../renderer/shared/custom-model-options.js";
import { buildSystemPromptWithSections, type ChatSystemPromptPermission } from "./chat-system-prompt.js";
import { MEMORY_EXTENSION_ID } from "./memory-context.js";
import { createOnDemandTools, type OnDemandTools } from "./on-demand-tools.js";
import {
  extensionSkillsPrompt,
  resolvePiAgentRuntimeContributionSnapshot,
  type PiAgentRuntimeExtension,
  type PiRuntimeContributionSnapshot,
} from "./pi-agent-runtime-harness.js";
import type { AgentHarnessResources } from "./pi-legacy-harness.js";
import { isPiCodemodeCallable, partitionPiCodemodeTools } from "./pi-runtime-tool.js";
import type { SkillRegistrySnapshot } from "./skill-registry.js";

export interface WorkspaceChatBasePromptInput {
  folderPath: string | undefined;
  branch: string | undefined;
  permission: ChatSystemPromptPermission;
  skillSnapshot?: SkillRegistrySnapshot;
  /** The chat's tools with runtime extension tools added, which decide the guidance sections. */
  tools: readonly Pick<AgentTool, "name">[];
  noWorkspace?: boolean;
}

/** The base prompt of an ordinary workspace chat, and the skills listing inside it. */
export async function buildWorkspaceChatBasePrompt(
  input: WorkspaceChatBasePromptInput,
): Promise<{ systemPrompt: string; skills?: string }> {
  const toolNames = new Set(input.tools.map((tool) => tool.name));
  const { systemPrompt, sections } = await buildSystemPromptWithSections(
    input.folderPath,
    input.branch,
    input.permission,
    toolNames.has("subagent"),
    true,
    input.skillSnapshot,
    toolNames,
    input.noWorkspace ?? false,
  );
  return { systemPrompt, ...(sections.skills ? { skills: sections.skills } : {}) };
}

export interface ChatPromptAssemblyInput {
  /** The mode's base prompt: workspace, Assistant, or automation. */
  basePrompt: string;
  /** The skills listing inside `basePrompt`, for the context meter. */
  baseSkills?: string;
  /** Adds the Bot runtime contract after the base prompt; only Bot chats pass it. */
  withBotInstructions?: (basePrompt: string) => string;
  /** The chat's admitted tools, before extension contributions. */
  tools: readonly AgentTool[];
  resources: AgentHarnessResources;
  extensions: readonly PiAgentRuntimeExtension[];
  extensionRevision?: number;
  modelOptions?: CustomModelOptions;
  /** Workspace chats with codemode declare rarely used tools only once the model loads them. */
  allowOnDemandTools: boolean;
}

export interface ChatPromptAssembly {
  basePrompt: string;
  /** `basePrompt` plus the Bot contract, before extension contributions. */
  botPrompt: string;
  /** Extension contributions with the model's tool policy applied. */
  contributions: PiRuntimeContributionSnapshot;
  /** The prompt the transcript head carries. */
  systemPrompt: string;
  /** What each prompt part adds, for the context meter's per-category breakdown. */
  promptSections: { skills: string; memory: string; "bot-instructions": string };
  /** Tools the provider sees declared, before on-demand tools are held back. */
  declared: AgentTool[];
  /** MCP tools a script reaches through codemode instead of a declaration. */
  deferredTools: AgentTool[];
  onDemandTools?: OnDemandTools;
  /** Held-back tools a script can still call. */
  onDemandCallable: AgentTool[];
  /** The tools to declare at the start of a run over `history` (the chat so far). */
  toolsFor(history: readonly AgentMessage[]): AgentTool[];
}

export function assembleChatPrompt(input: ChatPromptAssemblyInput): ChatPromptAssembly {
  const botPrompt = input.withBotInstructions ? input.withBotInstructions(input.basePrompt) : input.basePrompt;
  const resolved = resolvePiAgentRuntimeContributionSnapshot(
    botPrompt,
    input.tools,
    input.resources,
    input.extensions,
    input.extensionRevision ?? 0,
  );
  const contributions = applyCustomModelToolPolicy(resolved, input.modelOptions);
  const promptSections = {
    skills: (input.baseSkills ?? "") + extensionSkillsPrompt(resolved.extensions),
    memory: resolved.extensions
      .find((extension) => extension.id === MEMORY_EXTENSION_ID)
      ?.volatileSystemPrompt?.trim() ?? "",
    "bot-instructions": botPrompt.slice(input.basePrompt.length),
  };
  // Freeze only the already-admitted MCP inventory. The provider sees the
  // discovery/script tools; nested calls still use the ordinary host gates.
  const { declared, deferred: deferredTools } = partitionPiCodemodeTools(contributions.tools);
  const onDemandTools = input.allowOnDemandTools && declared.some((tool) => tool.name === "codemode")
    ? createOnDemandTools(declared)
    : undefined;
  // Held-back tools a script can call join the callable inventory the way
  // late MCP tools do, so loading one later never collides with the frozen deferred set.
  const onDemandCallable = onDemandTools?.onDemand.filter((tool) => isPiCodemodeCallable(tool)) ?? [];
  return {
    basePrompt: input.basePrompt,
    botPrompt,
    contributions,
    systemPrompt: contributions.systemPrompt,
    promptSections,
    declared,
    deferredTools,
    ...(onDemandTools ? { onDemandTools } : {}),
    onDemandCallable,
    // Tools this chat already loaded or called stay declared from the start.
    toolsFor: (history) => (onDemandTools ? onDemandTools.initialTools(history) : declared),
  };
}
