// Fixtures for the durable Bot tool assembly: a Bot authority in Full or
// Custom shape (the object `botRuntimeAuthority` produces for each mode), a
// matching catalog, and extension deps wired through the real assembly,
// policy and exact joins. Tests mutate `state` to change the Bot's access
// between the offer and the call.

import { statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotCatalogConnectionResource, BotCatalogSkillResource } from "../../bot-capability-catalog-core.js";
import type {
  BotRuntimeEffectiveAuthority,
  BotRuntimeMcpToolAuthority,
} from "../../bot-runtime-authority.js";
import type { BotOrdinaryCapabilityKind } from "../../bot-capability-catalog-core.js";
import type { BotRuntimeResolvedSkill } from "../../bot-skill-inventory.js";
import type { McpServerInstructionSnapshot } from "../../mcp-server-instructions.js";
import { mcpAgentToolName } from "../../mcp-tool-identity.js";
import type { RegisteredSkill, SkillRegistrySnapshot } from "../../skill-registry.js";
import { skillToolKey } from "../../skill-registry-core.js";
import type {
  BotApprovalRequest,
  BotApprovalRequirement,
  BotExtensionDeps,
  BotToolCallCheck,
} from "../bot-extension.js";
import { createBotToolAssembly, type BotAdmission, type BotToolCandidate } from "../bot-tool-assembly.js";
import { createBotToolFacts } from "../bot-tool-facts.js";
import { fakeBot } from "./fixtures.js";

export const MAIL_SERVER = { id: "conn-mail", name: "Mail" } as const;
export const SEND_EMAIL_TOOL = mcpAgentToolName(MAIL_SERVER, "send_email");
export const READ_INBOX_TOOL = mcpAgentToolName(MAIL_SERVER, "read_inbox");

const MAIL_TOOLS: BotRuntimeMcpToolAuthority[] = [
  {
    toolId: "tool-send",
    name: "send_email",
    effect: "mutating",
    inputSchemaFingerprint: "in-send",
    outputSchemaFingerprint: "out-send",
    effectFingerprint: "effect-send",
    exactFingerprint: "tool-send",
  },
  {
    toolId: "tool-read",
    name: "read_inbox",
    effect: "read",
    inputSchemaFingerprint: "in-read",
    outputSchemaFingerprint: "out-read",
    effectFingerprint: "effect-read",
    exactFingerprint: "tool-read",
  },
];

const MAIL_CONNECTION = {
  sourceId: MAIL_SERVER.id,
  connectionFingerprint: "conn-fp",
  toolsetFingerprint: "toolset-fp",
  exactFingerprint: "conn-exact",
  tools: MAIL_TOOLS,
};

const NOTES_SKILL_CANDIDATE = { name: "Meal Notes", stableId: "stable-notes" };
export const NOTES_SKILL_TOOL = skillToolKey(NOTES_SKILL_CANDIDATE);
const NOTES_SKILL_GRANT = {
  sourceId: "skill-notes",
  identityFingerprint: "skill-id-fp",
  contentFingerprint: "skill-content-fp",
  exactFingerprint: "skill-exact-fp",
};

export interface AuthorityOptions {
  mode: "full" | "custom";
  home: string;
  connections?: boolean;
  skills?: boolean;
  other?: BotOrdinaryCapabilityKind[];
  botHome?: boolean;
  shell?: boolean;
  vision?: boolean;
}

/** Everything granted, as Full Access does when it is all available. */
export const FULL_GRANTS = {
  connections: true,
  skills: true,
  other: ["web", "computer_use", "subagents", "schedules"] as BotOrdinaryCapabilityKind[],
  botHome: true,
  shell: true,
  vision: true,
};

/** A Custom binding that grants none of the ported groups. */
export const CUSTOM_NONE = {
  connections: false,
  skills: false,
  other: [] as BotOrdinaryCapabilityKind[],
  botHome: false,
  shell: false,
  vision: false,
};

export function testAuthority(options: AuthorityOptions): BotRuntimeEffectiveAuthority {
  const stats = statSync(options.home, { bigint: true });
  const provider = {
    sourceProviderId: "faux",
    sourceModelId: "faux-model",
    connectionFingerprint: "p",
    providerExactFingerprint: "p",
    modelFingerprint: "m",
    modelExactFingerprint: "m",
  };
  return {
    audienceId: "desktop:local",
    botId: "bot-1",
    chatId: "chat-1",
    accessMode: options.mode,
    botPolicy: { revision: "1", epoch: "epoch:1" },
    chatPolicy: { mode: options.mode === "custom" ? "custom" : "inherit", revision: "1", epoch: "epoch:1" },
    catalogRevision: "catalog-1",
    provider,
    ...(options.vision ? { visionProvider: { ...provider, sourceProviderId: "vision", sourceModelId: "vision-model" } } : {}),
    files: { mode: options.botHome ? "scoped" : "off", botHome: options.botHome === true, approvedLocations: [] },
    shell: options.shell ? { enabled: true, shellFingerprint: "s", exactFingerprint: "s" } : { enabled: false },
    connections: options.connections ? [MAIL_CONNECTION] : [],
    skills: options.skills ? [NOTES_SKILL_GRANT] : [],
    otherCapabilities: (options.other ?? []).map((kind) => ({ kind, capabilityFingerprint: kind, exactFingerprint: kind })),
    managedHome: {
      botId: "bot-1",
      workspaceId: "bot-home-1",
      createdAt: 1,
      incarnation: { device: stats.dev.toString(), inode: stats.ino.toString() },
    },
    workingDirectory: options.home,
  } as unknown as BotRuntimeEffectiveAuthority;
}

function catalogConnection(): BotCatalogConnectionResource {
  return {
    option: { available: true },
    ...MAIL_CONNECTION,
    tools: MAIL_TOOLS.map((tool) => ({ ...tool })),
  } as unknown as BotCatalogConnectionResource;
}

function catalogSkill(): BotCatalogSkillResource {
  return { option: { available: true }, ...NOTES_SKILL_GRANT } as unknown as BotCatalogSkillResource;
}

export function notesSkillSnapshot(instructions = "Plan meals from the fridge."): SkillRegistrySnapshot {
  const skill = {
    ...NOTES_SKILL_CANDIDATE,
    description: "Meal planning notes",
    instructions,
    source: "configured",
    available: true,
    modelInvocable: true,
    invocationId: "inv-notes",
    toolKey: NOTES_SKILL_TOOL,
  } as unknown as RegisteredSkill;
  return {
    workspaceId: "bot-home-1",
    workspacePermission: "full",
    revision: "r1",
    fingerprint: "f1",
    catalog: [{ invocationId: "inv-notes" }],
    skills: [skill],
    available: [skill],
  } as unknown as SkillRegistrySnapshot;
}

function resolvedNotesSkill(snapshot: SkillRegistrySnapshot): BotRuntimeResolvedSkill {
  const skill = snapshot.available[0]!;
  return {
    sourceId: NOTES_SKILL_GRANT.sourceId,
    available: true,
    runtimeStableId: skill.stableId,
    label: skill.name,
    description: skill.description,
    instructions: skill.instructions,
  } as unknown as BotRuntimeResolvedSkill;
}

export interface AssemblyState {
  authority: BotRuntimeEffectiveAuthority;
  supportsImages: boolean;
  /** Admission fails (the Bot's access changed underneath). */
  revoked?: boolean;
  catalog: { connections: BotCatalogConnectionResource[]; skills: BotCatalogSkillResource[] };
  skillSnapshot: SkillRegistrySnapshot;
}

export function assemblyState(authority: BotRuntimeEffectiveAuthority, supportsImages = true): AssemblyState {
  return {
    authority,
    supportsImages,
    catalog: { connections: [catalogConnection()], skills: [catalogSkill()] },
    skillSnapshot: notesSkillSnapshot(),
  };
}

export function testAdmit(state: AssemblyState): (botId: string) => Promise<BotAdmission> {
  return async () => {
    if (state.revoked) throw new Error("This Bot's access changed. Review it in Advanced.");
    const authority = state.authority;
    const controller = new AbortController();
    return {
      authority,
      signal: controller.signal,
      revalidateBeforeEffect: async () => {
        if (state.revoked || state.authority !== authority) {
          throw new Error("This Bot's access changed while this tool was active.");
        }
      },
      release: () => controller.abort(new Error("released")),
    };
  };
}

export interface AssemblyDepsOptions {
  /** Candidate tools for the current authority (stand-ins for discovered tools). */
  candidates: (authority: BotRuntimeEffectiveAuthority) => BotToolCandidate[];
  approve?: (request: BotApprovalRequest) => Promise<"allow" | "deny">;
  approvalFor?: (toolName: string, call: BotToolCallCheck) => Promise<BotApprovalRequirement | null | undefined>;
  /** MCP server instructions captured while "discovering" the connection tools. */
  guidance?: McpServerInstructionSnapshot[];
}

export interface AssemblyDeps extends BotExtensionDeps {
  approvals: BotApprovalRequest[];
}

/** Extension deps that run the real assembly over `state`. */
export function assemblyDeps(state: AssemblyState, options: AssemblyDepsOptions): AssemblyDeps {
  const admit = testAdmit(state);
  const assembly = createBotToolAssembly({
    admit,
    sources: {
      facts: async (_botId, admission) =>
        createBotToolFacts({
          admission,
          supportsImages: state.supportsImages,
          fileLocations: admission.authority.files.botHome ? 1 : 0,
          catalog: async () => state.catalog,
          mcpServers: async () => [MAIL_SERVER],
          skills: async () => ({ snapshot: state.skillSnapshot, resolved: [resolvedNotesSkill(state.skillSnapshot)] }),
        }),
      candidates: async (_botId, admission) => ({
        tools: options.candidates(admission.authority),
        guidance: options.guidance ?? [],
      }),
      ...(options.approvalFor === undefined
        ? {}
        : { approvalFor: (_botId: string, toolName: string, call: BotToolCallCheck) => options.approvalFor!(toolName, call) }),
    },
  });
  const deps: AssemblyDeps = {
    approvals: [],
    loadBot: async (botId) => fakeBot(botId),
    systemSections: async (_bot, offered) => ["BASE", "PERSONA", "AUTHORITY", assembly.guidance("bot-1", offered.toolNames)],
    currentTools: (bot, turn) => assembly.currentTools(bot.id, turn),
    checkPolicy: (botId, toolName, call) => assembly.checkPolicy(botId, toolName, call),
    requestApproval: async (request) => {
      deps.approvals.push(request);
      return options.approve ? options.approve(request) : "allow";
    },
    readmit: async () => ({ ok: true }),
    imageInput: async () => state.supportsImages,
  };
  return deps;
}

/** Candidate list helper: wrap plain tools. */
export function plain(...tools: AgentTool[]): BotToolCandidate[] {
  return tools.map((tool) => ({ tool }));
}

/** A complete 1×1 PNG. */
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
