import { cliSubagentIdentity } from "./subagent-identity.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotRuntimeAuthorityAdmission } from "../../../main/services/bot-runtime-authority.js";
import type { Chat } from "../../../main/services/types.js";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createSubagentTool } from "../../../main/services/subagents/subagent-tool.js";
import { SubagentSupervisor } from "../../../main/services/subagents/subagent-supervisor-core.js";
import { SubagentEventProjector } from "../../../main/services/subagents/subagent-event-projector.js";
import { createSubagentRunStore } from "../../../main/services/subagents/subagent-run-store-core.js";
import { createNativeSubagentRunStoreStorage } from "../../../main/services/subagents/subagent-run-store-io.js";
import { SUBAGENT_READ_TOOL_NAMES } from "../../../main/services/subagents/capability-profile.js";
import { createCliModelRuntime } from "./providers.ts";
import { resolveRuntimeFromContext } from "./pi-bridge/model-runtime.ts";
import { runCliSubagent } from "./subagent-process.ts";
import { acquireLease } from "./state.ts";

/** Bot investigations inherit exact admitted file tools; they cannot expand into host tools. */
export function createBotSubagentTool(agentDir: string, admission: BotRuntimeAuthorityAdmission, parentTools: AgentTool[], loadChat: () => Promise<Chat | null>) {
  const authority = admission.authority;
  const reads = parentTools.filter((tool) => (SUBAGENT_READ_TOOL_NAMES as readonly string[]).includes(tool.name));
  return createSubagentTool({ async execute(params, signal) {
    await admission.revalidateBeforeEffect();
    const combined = signal ? AbortSignal.any([signal, admission.signal]) : admission.signal;
    combined.throwIfAborted();
    const root = join(agentDir, "bot-subagent-history", createHash("sha256").update(authority.chatId).digest("hex"));
    const release = acquireLease(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const binary = join(dirname(process.env.AIDEN_CLI_ENTRY!), "native/aiden-subagent-run-store");
    const store = createSubagentRunStore(async () => root, { storageFactory: (directory) => createNativeSubagentRunStoreStorage(directory, binary) });
    let supervisor: SubagentSupervisor | undefined;
    try {
      const runtime = await resolveRuntimeFromContext({ modelRegistry: new ModelRegistry(await createCliModelRuntime(agentDir)) }, authority.provider.sourceProviderId, authority.provider.sourceModelId);
      const generationId = cliSubagentIdentity(randomUUID());
      const projector = new SubagentEventProjector({ generationId, chatId: cliSubagentIdentity(authority.chatId), workspaceId: cliSubagentIdentity(authority.managedHome.workspaceId), modelId: runtime.model.id,
        onSnapshot: async (snapshot) => { await store.upsert(snapshot); } });
      supervisor = new SubagentSupervisor({ generationId, chatId: cliSubagentIdentity(authority.chatId), workspaceId: cliSubagentIdentity(authority.managedHome.workspaceId),
        workspaceRoot: authority.workingDirectory, runtime, thinkingLevel: "off", permission: "full", inheritedCeiling: SUBAGENT_READ_TOOL_NAMES.filter((name) => reads.some((tool) => tool.name === name)),
        loadPersistedChatForFork: loadChat, projector,
        runChild: (input) => runCliSubagent(agentDir, input, reads, async () => { combined.throwIfAborted(); await admission.revalidateBeforeEffect(); }),
      });
      return await supervisor.execute(params, combined);
    } finally {
      try { await supervisor?.flush(); } finally { try { await store.close(); } finally { release(); } }
    }
  } }, [], false, [], false, false);
}


export async function deleteCliBotSubagentHistory(agentDir: string, chatId: string) {
  const root = join(agentDir, "bot-subagent-history", createHash("sha256").update(chatId).digest("hex"));
  if (!existsSync(root)) return;
  const release = acquireLease(root);
  const binary = join(dirname(process.env.AIDEN_CLI_ENTRY!), "native/aiden-subagent-run-store");
  const store = createSubagentRunStore(async () => root, { storageFactory: (directory) => createNativeSubagentRunStoreStorage(directory, binary) });
  try { await store.deleteChat(cliSubagentIdentity(chatId)); }
  finally { try { await store.close(); } finally { release(); } }
}
