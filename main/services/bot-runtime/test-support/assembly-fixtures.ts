// Fixtures for the durable Bot tool assembly: a Bot authority in Full or
// Custom shape (the object `botRuntimeAuthority` produces for each mode), a
// matching catalog, and extension deps wired through the real assembly,
// policy and exact joins. Tests mutate `state` to change the Bot's access
// between the offer and the call.

import type { BotPlans } from "../../bot-plans/plans.js";
import { statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotCatalogConnectionResource, BotCatalogSkillResource } from "../../bot-capability-catalog-core.js";
import type {
  BotRuntimeEffectiveAuthority,
  BotRuntimeMcpToolAuthority,
} from "../../bot-runtime-authority.js";
import type { BotOrdinaryCapabilityKind } from "../../bot-capability-catalog-core.js";
import type { BotRuntimeResolvedSkill } from "../../bot-skill-inventory.js";
import { markMcpAgentTool, mcpAgentToolName } from "../../mcp-tool-identity.js";
import { tagMcpAgentTool } from "../../mcp-agent-tool-descriptor.js";
import { botMcpLiveToolGrantFacts } from "../../bot-tool-authority.js";
import type { SubagentMcpRemoteTool } from "../../subagents/subagent-mcp-read.js";
import type { RegisteredSkill, SkillRegistrySnapshot } from "../../skill-registry.js";
import { skillToolKey } from "../../skill-registry-core.js";
import type { BotHandoffAnswer } from "../../../../renderer/shared/bot-handoffs.js";
import type { BotRule } from "../../../../renderer/shared/bot-rules.js";
import type {
  BotApprovalRequest,
  BotExtensionDeps,
  BotRuleHandoffRecord,
  BotRuleHandoffRequest,
  BotToolCallCheck,
} from "../bot-extension.js";
import {
  createBotToolAssembly,
  type BotAdmission,
  type BotAllowListPort,
  type BotToolAssembly,
  type BotLiveApproval,
  type BotToolCandidate,
} from "../bot-tool-assembly.js";
import { createBotToolFacts } from "../bot-tool-facts.js";
import { botIngressAllowsTool } from "../bot-tool-policy.js";
import { fakeBot } from "./fixtures.js";

export const MAIL_SERVER = { id: "conn-mail", name: "Mail" } as const;
const MAIL_INVENTORY = { configured: [MAIL_SERVER], inventory: ["send_email", "read_inbox"] };
export const SEND_EMAIL_TOOL = mcpAgentToolName(MAIL_SERVER, "send_email", MAIL_INVENTORY);
export const READ_INBOX_TOOL = mcpAgentToolName(MAIL_SERVER, "read_inbox", MAIL_INVENTORY);
/**
 * The Mail tools as the MCP manager builds them: generated names carrying
 * their MCP identity and the tools/list entry they were built from.
 */
const MAIL_BUILT_TOOLS = mailRemoteTools().map((remote) =>
  tagMcpAgentTool(
    markMcpAgentTool(
      { name: mcpAgentToolName(MAIL_SERVER, remote.name, MAIL_INVENTORY) },
      { serverId: MAIL_SERVER.id, toolName: remote.name },
    ),
    remote,
  ),
);

/** The tools/list entries the Mail server advertised when the Bot was granted them. */
export function mailRemoteTools(): SubagentMcpRemoteTool[] {
  return [
    {
      name: "send_email",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "read_inbox",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ];
}

const MAIL_TOOLS: BotRuntimeMcpToolAuthority[] = mailRemoteTools().map((tool) => {
  const facts = botMcpLiveToolGrantFacts(tool);
  if (!facts) throw new Error("Mail fixture tool is unusable.");
  return facts;
});

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
  /**
   * The Mail server's live tools/list entries. Changing one models a server
   * that changed a tool while the catalog (a cached scope) stayed the same.
   */
  liveMailTools: SubagentMcpRemoteTool[];
  /** Optional freshly built identities for tests adding server tools. */
  builtMailTools?: readonly { readonly name: string }[];
  skillSnapshot: SkillRegistrySnapshot;
  /** The Bot has its own computer (Bot computers set up and given). */
  hasComputer?: boolean;
}

export function assemblyState(authority: BotRuntimeEffectiveAuthority, supportsImages = true): AssemblyState {
  return {
    authority,
    supportsImages,
    catalog: { connections: [catalogConnection()], skills: [catalogSkill()] },
    liveMailTools: mailRemoteTools(),
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
  allowList?: BotAllowListPort;
  plans?: Pick<BotPlans, "cover" | "admit">;
  /** Candidate tools for the current authority (stand-ins for discovered tools). */
  candidates: (authority: BotRuntimeEffectiveAuthority) => BotToolCandidate[];
  approve?: (request: BotApprovalRequest) => Promise<"allow" | "deny">;
  approvalFor?: (toolName: string, call: BotToolCallCheck) => Promise<BotLiveApproval | undefined>;
  /** The Bot's effective rules, read on every call. Absent: no rules port. */
  rules?: () => readonly BotRule[] | Promise<readonly BotRule[]>;
  /** Answers rule hand-off cards. Absent: no one to ask (rule hand-offs block). */
  requestHandoff?: (request: BotRuleHandoffRequest) => Promise<BotHandoffAnswer>;
  botName?: string;
  /** Settings → Bots: routine runs go ahead without asking, read on every call. Absent: no port. */
  routinesGoAhead?: () => boolean;
}

export interface AssemblyDeps extends BotExtensionDeps {
  approvalRequirements: BotToolAssembly["approvalRequirements"];
  approvals: BotApprovalRequest[];
  /** Rule hand-off cards asked, in order. */
  handoffs: BotRuleHandoffRequest[];
  /** Rule hand-off rows recorded, one per tool call. */
  records: BotRuleHandoffRecord[];
}

/** Extension deps that run the real assembly over `state`. */
export function assemblyDeps(state: AssemblyState, options: AssemblyDepsOptions): AssemblyDeps {
  const admit = testAdmit(state);
  const assembly = createBotToolAssembly({
    admit,
    ...(options.plans ? { plans: options.plans } : {}),
    ...(options.allowList ? { allowList: options.allowList } : {}),
    sources: {
      facts: async (_botId, admission) =>
        createBotToolFacts({
          admission,
          supportsImages: state.supportsImages,
          fileLocations: admission.authority.files.botHome ? 1 : 0,
          hasComputer: state.hasComputer === true,
          catalog: async () => state.catalog,
          mcpTools: async () => state.builtMailTools ?? MAIL_BUILT_TOOLS,
          liveMcpTools: async () =>
            new Map(state.liveMailTools.map((tool) => [mcpAgentToolName(MAIL_SERVER, tool.name, MAIL_INVENTORY), tool] as const)),
          skills: async () => ({ snapshot: state.skillSnapshot, resolved: [resolvedNotesSkill(state.skillSnapshot)] }),
        }),
      candidates: async (_botId, admission) => ({
        tools: options.candidates(admission.authority),
      }),
      ...(options.approvalFor === undefined
        ? {}
        : { approvalFor: (_botId: string, toolName: string, call: BotToolCallCheck) => options.approvalFor!(toolName, call) }),
    },
    ...(options.rules === undefined ? {} : { rules: async () => options.rules!() }),
    ...(options.botName === undefined ? {} : { botName: async () => options.botName }),
    ...(options.routinesGoAhead === undefined ? {} : { routinesGoAhead: async () => options.routinesGoAhead!() }),
  });
  const deps: AssemblyDeps = {
    approvals: [],
    approvalRequirements: (...args) => assembly.approvalRequirements(...args),
    handoffs: [],
    records: [],
    loadBot: async (botId) => fakeBot(botId),
    systemSections: async (_bot, offered) => ["BASE", "PERSONA", "AUTHORITY", assembly.guidance("bot-1", offered.toolNames)],
    currentTools: (bot, turn) => assembly.currentTools(bot.id, turn),
    checkPolicy: (botId, toolName, call) => assembly.checkPolicy(botId, toolName, call),
    turnAllows: botIngressAllowsTool,
    requestApproval: async (request) => {
      deps.approvals.push(request);
      const answer = options.approve ? await options.approve(request) : "allow";
      return { id: request.waitId, authorizationFingerprint: request.authorizationFingerprint, answer, source: "person" };
    },
    ...(options.requestHandoff === undefined
      ? {}
      : {
          requestHandoff: async (request: BotRuleHandoffRequest) => {
            deps.handoffs.push(request);
            return options.requestHandoff!(request);
          },
        }),
    // Idempotent per tool call, as production is.
    recordHandoff: async (record) => {
      if (!deps.records.some((entry) => entry.toolCallId === record.toolCallId)) deps.records.push(record);
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

/** A real durable crash scenario shared with the parent's recovery assertions. */
export interface PlanReplayArgs {
  profileDir: string;
  home: string;
  botId: string;
  phase: "reserved" | "admitted" | "before-intent";
  safe: boolean;
  nested?: boolean;
  identity?: boolean;
}

export async function planReplayDeps(args: PlanReplayArgs, emit?: (tag: string, value: unknown) => void) {
  const { createBotPlans } = await import("../../bot-plans/plans.js");
  const { botPlanProposalFingerprint } = await import("../../bot-plans/validate.js");
  const { countingTool, blockingUntilAborted } = await import("./fixtures.js");
  const toolName = args.safe ? "web_search" : SEND_EMAIL_TOOL;
  const proposal: import("../../bot-plans/validate.js").BotPlanProposal = {
    title: "Replay test", why: "Exercise durable execution admission", steps: ["Do the operation"],
    items: args.safe ? [{ id: "i1", kind: "site", host: "search.example", max: 2 }] : [{
      id: "i1", kind: "connector", app: "Mail", action: "send mail", max: 2,
      tools: [{ modelName: SEND_EMAIL_TOOL, serverId: MAIL_SERVER.id, remoteName: "send_email", title: "Send mail" }],
    }],
    authorization: { policyRevision: "1", bindingRevision: "binding-1", proposalFingerprint: "", rules: [] },
  };
  proposal.authorization.proposalFingerprint = botPlanProposalFingerprint(proposal);
  const plans = createBotPlans({ profileDir: args.profileDir, knownBot: async () => true,
    revalidate: async () => undefined, revokeAccess() {} });
  const tool = countingTool(toolName, async (_params, signal) => {
    if (!emit) return "recovered";
    emit("TOOL_RUNNING", toolName);
    return blockingUntilAborted(signal);
  });
  const state = assemblyState(testAuthority({ mode: "full", home: args.home, ...FULL_GRANTS }));
  let covers = 0;
  const deps = assemblyDeps(state, {
    plans: { cover: (...input) => { covers++; return plans.cover(...input); }, admit: async (permit, start) => {
      if (emit && args.phase === "reserved") { emit("RESERVED", permit.executionId); await new Promise<never>(() => undefined); }
      return plans.admit(permit, start);
    } },
    candidates: () => [{ tool, mcp: !args.safe, replay: args.safe ? "safe" : "unsafe" }],
    // The harmless safe read deliberately gets a live host approval in this
    // fixture. No real mutating/MCP tool is relabelled replay-safe.
    approvalFor: args.safe ? async () => ({ approval: { summary: "Read search results" },
      action: { surface: "browser", tool: "browser_click", url: "https://search.example/results" } }) : args.phase === "before-intent" ? async () => ({
      approval: { summary: "Send mail", onAllow: emit ? async () => { emit("BEFORE_INTENT", toolName); await new Promise<never>(() => undefined); } : undefined },
      action: { surface: "mcp", modelName: SEND_EMAIL_TOOL, serverId: MAIL_SERVER.id, remoteName: "send_email", summary: "Send mail", destructive: "additive" },
    }) : undefined,
    approve: async () => "deny",
  });
  return { plans, proposal, deps, tool, state, covers: () => covers };
}

/** A replay-safe harmless read exposes only host identity observations to the test. */
export async function inputIdentityDeps(args: PlanReplayArgs, observe: (ids: readonly string[]) => void, hold = false) {
  const { countingTool, blockingUntilAborted } = await import("./fixtures.js");
  const tool = countingTool("web_search");
  const state = assemblyState(testAuthority({ mode: "full", home: args.home, ...FULL_GRANTS }));
  const deps = assemblyDeps(state, { candidates: () => [{ tool, replay: "safe", bind: call => ({ ...tool, async execute(...params) {
    observe(await call.runInputIds!());
    if (hold) await blockingUntilAborted(call.signal);
    return tool.execute(...params);
  } }) }] });
  return { deps, tool };
}

/** `kill-harness.mjs scenario` entry point; no test registration or provider I/O. */
export async function run(args: PlanReplayArgs, emit: (tag: string, value: unknown) => void): Promise<void> {
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const { createBotRegistry } = await import("../bot-extension.js");
  const { createBotHarnessHost } = await import("../harness-host.js");
  const { createFauxModels, FAUX_MODEL_REF } = await import("./faux.js");
  const replay = args.identity ? undefined : await planReplayDeps(args, emit);
  const f = replay ?? await inputIdentityDeps(args, ids => emit("INPUT_IDS", ids), true);
  if (replay) {
    const wait = replay.plans.request({ botId: args.botId, planId: "replay-plan", toolCallId: "proposal", proposal: replay.proposal,
      requestIds: ["replay-run"], signal: undefined });
    await replay.plans.current(args.botId);
    await replay.plans.respond(args.botId, "replay-plan", "approve");
    await wait;
  }
  const { models } = createFauxModels([fauxAssistantMessage([args.nested
    ? fauxToolCall("codemode", { code: `text(await tools.${f.tool.name}({text:'test'}))` }, { id: "script-1" })
    : fauxToolCall(f.tool.name, { text: "test" }, { id: "same-provider-id" })], { stopReason: "toolUse" })]);
  const registries = new Map<string, ReturnType<typeof createBotRegistry>>();
  const host = await createBotHarnessHost({ profileDir: args.profileDir, models, buildRegistry: id => {
    const registry = createBotRegistry(id, f.deps); registries.set(id, registry); return registry;
  } });
  if ("unavailable" in host) throw new Error("Profile locked");
  const { conversation } = await host.open(args.botId);
  await registries.get(args.botId)!.refresh();
  await conversation.configure({ model: FAUX_MODEL_REF }, BACKGROUND_CONTEXT);
  const submission = await conversation.submit({ type: "input", content: "go", ...(args.identity ? {} : { requestId: "replay-run" }) }, BACKGROUND_CONTEXT);
  emit("SUBMITTED", String(submission.id));
}
