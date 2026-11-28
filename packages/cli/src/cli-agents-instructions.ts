import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentContext, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  AGENTS_INSTRUCTION_READ_BYTES,
  agentsInstructionNonce,
  createAgentsInstructionRefresher,
  withoutAgentsInstructions,
  type AgentsInstructionOptions,
} from "../../../main/services/agents-instructions.js";
import { createChatAgentsInstructions, type ChatAgentsInstructionOptions } from "../../../main/services/chat-prompt-sections.js";
import { chatPromptSecret, promptSectionDeviceKey } from "../../../main/services/prompt-section-secret.js";
import { decodeUtf8, readRegularFile } from "../../../main/services/regular-file-read.js";
import type { SubagentWorkspaceRootIdentity } from "../../../main/services/subagents/subagent-file-mutation-core.js";

export interface CanonicalDirectoryIdentity {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}

export async function captureCanonicalDirectoryIdentity(
  folderPath: string,
  options: { requireCanonicalPath?: boolean } = {},
): Promise<CanonicalDirectoryIdentity> {
  const linkStat = await fs.lstat(folderPath);
  if (!linkStat.isDirectory() || linkStat.isSymbolicLink()) {
    throw new Error("Workspace folder must be a canonical directory, not a symbolic link.");
  }
  const canonicalPath = await fs.realpath(folderPath);
  if (options.requireCanonicalPath && canonicalPath !== folderPath) {
    throw new Error("Workspace folder must match its canonical path.");
  }
  const stat = await fs.stat(canonicalPath, { bigint: true });
  if (!stat.isDirectory()) {
    throw new Error("Workspace folder is not a directory.");
  }
  return Object.freeze({
    lexicalPath: folderPath,
    canonicalPath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  });
}

export async function assertCanonicalDirectoryIdentity(expected: CanonicalDirectoryIdentity): Promise<void> {
  let linkStat: import("node:fs").Stats;
  let canonicalPath: string;
  let stat: import("node:fs").BigIntStats;
  try {
    linkStat = await fs.lstat(expected.lexicalPath);
    canonicalPath = await fs.realpath(expected.lexicalPath);
    stat = await fs.stat(canonicalPath, { bigint: true });
  } catch {
    throw new Error("Workspace folder identity changed. Start a new response.");
  }
  if (
    !linkStat.isDirectory() ||
    linkStat.isSymbolicLink() ||
    !stat.isDirectory() ||
    canonicalPath !== expected.canonicalPath ||
    stat.dev.toString() !== expected.device ||
    stat.ino.toString() !== expected.inode
  ) {
    throw new Error("Workspace folder identity changed. Start a new response.");
  }
}

async function assertInstructionRoot(root: SubagentWorkspaceRootIdentity): Promise<void> {
  let canonicalPath: string;
  let stat: import("node:fs").BigIntStats;
  try {
    canonicalPath = await fs.realpath(root.canonicalPath);
    stat = await fs.stat(canonicalPath, { bigint: true });
  } catch {
    throw new Error("AGENTS instruction root changed. Start a new response.");
  }
  if (
    !stat.isDirectory() ||
    canonicalPath !== root.canonicalPath ||
    stat.dev.toString() !== root.device ||
    stat.ino.toString() !== root.inode
  ) {
    throw new Error("AGENTS instruction root changed. Start a new response.");
  }
}

/** Single-link O_NOFOLLOW regular-file reader for CLI AGENTS.md instruction roots. */
export async function readCliAgentsInstructions(
  root: SubagentWorkspaceRootIdentity,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  await assertInstructionRoot(root);
  const filePath = path.join(root.canonicalPath, "AGENTS.md");
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("AGENTS.md must be a regular file with exactly one link, not a symbolic or hard link.");
  }
  const bytes = await readRegularFile(filePath, AGENTS_INSTRUCTION_READ_BYTES, {
    exclusiveIdentity: { device: String(stat.dev), inode: String(stat.ino) },
  });
  await assertInstructionRoot(root);
  signal?.throwIfAborted();
  return decodeUtf8(bytes);
}

export interface CliSessionInstructions {
  readonly extension: InlineExtension;
  bindSession(session: AgentSession): void;
}

function buildSessionInstructions(
  refresher: Awaited<ReturnType<typeof createAgentsInstructionRefresher>>,
  sectionKey: string,
): { refresh(signal?: AbortSignal): Promise<void>; instructions: CliSessionInstructions } {
  let currentBlock = "";
  let injectedBlock = "";
  const refresh = async (signal?: AbortSignal): Promise<void> => {
    const probe: AgentContext = { messages: [], tools: [] };
    const next = await refresher.apply(probe, signal);
    if (next !== probe) {
      const patch = next.messages.at(-1) as { sections?: Record<string, string | null> } | undefined;
      currentBlock = patch?.sections?.[sectionKey] ?? "";
    }
  };
  const instructions: CliSessionInstructions = {
    extension: {
      name: "aiden-agents-instructions",
      factory(pi) {
        pi.on("before_agent_start", (event) => {
          injectedBlock = currentBlock;
          if (!currentBlock) return undefined;
          return {
            systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${currentBlock}` : currentBlock,
          };
        });
      },
    },
    bindSession(session: AgentSession) {
      const previousTransform = session.agent.transformContext;
      session.agent.transformContext = async (messages, requestSignal) => {
        await refresh(requestSignal);
        const transformed = previousTransform ? await previousTransform(messages, requestSignal) : messages;
        if (currentBlock === injectedBlock) return transformed;
        const previousBlock = injectedBlock;
        injectedBlock = currentBlock;
        const first = transformed[0] as ({ role?: string; content?: unknown; sections?: Record<string, string | null> } & AgentMessage) | undefined;
        if (first && first.role === "system" && typeof first.content === "string" && !first.sections) {
          let nextContent: string;
          if (previousBlock && first.content.includes(previousBlock)) {
            nextContent = currentBlock
              ? first.content.replace(previousBlock, () => currentBlock)
              : withoutAgentsInstructions(first.content);
          } else {
            const stripped = withoutAgentsInstructions(first.content);
            nextContent = currentBlock ? (stripped ? `${stripped}\n\n${currentBlock}` : currentBlock) : stripped;
          }
          return [{ ...first, content: nextContent } as AgentMessage, ...transformed.slice(1)];
        }
        return [
          ...transformed,
          {
            role: "system",
            content: "",
            sections: { [sectionKey]: currentBlock || null },
            timestamp: Date.now(),
          } as unknown as AgentMessage,
        ];
      };
    },
  };
  return { refresh, instructions };
}

export async function createCliChatSessionInstructions(
  options: Omit<ChatAgentsInstructionOptions, "read">,
  initialSignal?: AbortSignal,
): Promise<CliSessionInstructions> {
  const secret = chatPromptSecret(promptSectionDeviceKey(options.userDataDir), options.chatId);
  const sectionKey = `agents-instructions-${agentsInstructionNonce(secret)}`;
  const refresher = await createChatAgentsInstructions({
    ...options,
    read: readCliAgentsInstructions,
  });
  const { refresh, instructions } = buildSessionInstructions(refresher, sectionKey);
  await refresh(initialSignal);
  return instructions;
}

export async function createCliScheduledSessionInstructions(
  options: Omit<AgentsInstructionOptions, "chatSecret" | "read"> & { agentDir: string; scheduleKey: string },
  initialSignal?: AbortSignal,
): Promise<CliSessionInstructions> {
  const { agentDir, scheduleKey, ...rest } = options;
  const chatSecret = chatPromptSecret(
    promptSectionDeviceKey(agentDir),
    `schedule:${createHash("sha256").update(scheduleKey).digest("hex")}`,
  );
  const sectionKey = `agents-instructions-${agentsInstructionNonce(chatSecret)}`;
  const refresher = await createAgentsInstructionRefresher({
    ...rest,
    chatSecret,
    read: readCliAgentsInstructions,
  });
  const { refresh, instructions } = buildSessionInstructions(refresher, sectionKey);
  await refresh(initialSignal);
  return instructions;
}

export function bindCliSessionAuthority(session: AgentSession, assertAuthority: (signal?: AbortSignal) => Promise<void>): void {
  const previousTransform = session.agent.transformContext;
  session.agent.transformContext = async (messages, requestSignal) => {
    await assertAuthority(requestSignal);
    return previousTransform ? previousTransform(messages, requestSignal) : messages;
  };
}
