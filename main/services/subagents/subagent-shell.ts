import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type {
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { SubagentShellApprovalDetails } from "../../../renderer/shared/assistant.js";
import type { ToolApprovalPrompt } from "../tool-approval.js";
import type { Workspace } from "../types.js";
import {
  workspaceOperationRegistry,
  type WorkspaceOperationAdmission,
  type WorkspaceOperationRegistry,
} from "../workspace-operation-registry.js";
import { SubagentApprovalLedgerV2, type PrepareSubagentApprovalV2Input } from "./approval-v2.js";
import { subagentAuthorityDigestV2, type SubagentAuthorityV2 } from "./authority-v2.js";
import type { SubagentMcpMutationJournalV2 } from "./subagent-mcp-mutation.js";
import { sameSubagentAuthorityBindingV2 } from "./outbound-approval-v2.js";
import {
  pinSubagentShellWorkspaceRoot,
  runSubagentShellProductionInert,
  type SubagentShellResult,
  type SubagentShellWorkspaceRoot,
} from "./subagent-shell-runner-io.js";
import { subagentWorkspaceRevisionV2 } from "./subagent-workspace-write.js";
import { normalizeSubagentModelText } from "./model-text.js";

export const SUBAGENT_RUN_COMMAND_TOOL_NAME = "run_command";
export const SUBAGENT_SHELL_MODEL_COMMAND_CHARS = 16_384;
export const SUBAGENT_SHELL_RUNTIME_COMMAND_BYTES = 32 * 1024;
export const SUBAGENT_SHELL_TIMEOUT_MS = 120_000;
export const SUBAGENT_SHELL_APPROVAL_WINDOW_MS = 60_000;
export const SUBAGENT_SHELL_MODEL_RESULT_CHARS = 20_000;
const STREAM_BYTES = 512 * 1024;
const DIGEST_PREFIX = 12;

export interface SubagentShellToolBindingV2 {
  toolName: typeof SUBAGENT_RUN_COMMAND_TOOL_NAME;
}

interface PendingShell {
  approvalId: string;
  effectId: string;
  command: string;
  argumentDigest: string;
  effectDigest: string;
  authorityDigest: string;
  root: SubagentShellWorkspaceRoot;
  expiresAt: number;
  ledgerInput: PrepareSubagentApprovalV2Input;
  admission: WorkspaceOperationAdmission;
  owner: { effectId: string; approvalId: string; runId: string; chatId: string };
}

export interface SubagentShellGateV2 {
  beforeToolCall(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined>;
  execute(input: {
    toolCallId: string;
    toolName: string;
    arguments: unknown;
    signal?: AbortSignal;
  }): Promise<AgentToolResult<null>>;
  shutdown(): Promise<void>;
}

export interface SubagentShellBrokerV2Input {
  authority: SubagentAuthorityV2;
  childId: string;
  childLabel: string;
  workspace: Workspace;
  workspaceRoot: string;
  ledger: SubagentApprovalLedgerV2;
  journal: SubagentMcpMutationJournalV2;
  currentAuthority(runId: string): SubagentAuthorityV2 | undefined;
  currentWorkspace(workspaceId: string): Promise<Workspace | undefined>;
  validateWorkspace(workspace: Workspace): Promise<void>;
  requestApproval(
    descriptor: Omit<ToolApprovalPrompt, "approvalId">,
    signal: AbortSignal | undefined,
    ownerDocumentId: string,
  ): Promise<boolean>;
  runShell?: typeof runSubagentShellProductionInert;
  binary?: string;
  runSignal?: AbortSignal;
  registry?: WorkspaceOperationRegistry;
  now?: () => number;
  randomUUID?: () => string;
}

function blocked(reason: string): BeforeToolCallResult {
  return { block: true, reason };
}

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

function fieldsDigest(domain: string, ...fields: readonly string[]): string {
  const hash = createHash("sha256").update(`${domain}\0`, "utf8");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

function plainCommandArguments(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Invalid shell arguments.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== 1 ||
    !descriptors.command ||
    !("value" in descriptors.command) ||
    descriptors.command.enumerable !== true ||
    typeof descriptors.command.value !== "string"
  ) {
    throw new Error("Invalid shell arguments.");
  }
  const command = descriptors.command.value;
  const bytes = Buffer.from(command, "utf8");
  const forbidden = [...command].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return (
      point === 0 ||
      point === 0x0d ||
      point === 0x1b ||
      (point < 0x20 && point !== 0x09 && point !== 0x0a) ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x2028 ||
      point === 0x2029 ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    );
  });
  if (
    command.trim().length === 0 ||
    bytes.length > SUBAGENT_SHELL_RUNTIME_COMMAND_BYTES ||
    bytes.toString("utf8") !== command ||
    forbidden
  ) {
    throw new Error("Invalid shell command.");
  }
  return command;
}

function sameRoot(left: SubagentShellWorkspaceRoot, right: SubagentShellWorkspaceRoot): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

function effectDigest(input: {
  command: string;
  root: SubagentShellWorkspaceRoot;
  authority: SubagentAuthorityV2;
  childId: string;
  toolCallId: string;
  expiresAt: number;
}): string {
  return fieldsDigest(
    "aiden-subagent-shell-effect-v2",
    input.command,
    input.root.path,
    input.root.device,
    input.root.inode,
    "/bin/zsh",
    "-f",
    "-c",
    "aiden-subagent",
    "minimal-private-0700-v1",
    "stdin=/dev/null",
    `stdout=${STREAM_BYTES}`,
    `stderr=${STREAM_BYTES}`,
    `timeout=${SUBAGENT_SHELL_TIMEOUT_MS}`,
    input.authority.treeRootId,
    input.authority.runId,
    input.childId,
    input.authority.chatId,
    input.authority.workspaceId,
    input.toolCallId,
    String(input.expiresAt),
    "rollout=phase5e-v1",
  );
}

function terminalDigest(state: string, text: string): string {
  return fieldsDigest("aiden-subagent-shell-terminal-v2", state, text);
}

function boundedStream(label: string, value: string): string {
  const safe = normalizeSubagentModelText(value);
  const allowance = Math.floor((SUBAGENT_SHELL_MODEL_RESULT_CHARS - 512) / 2);
  if (safe.length <= allowance) return `${label}:\n${safe || "(empty)"}`;
  const half = Math.floor((allowance - 80) / 2);
  return `${label}:\n${safe.slice(0, half)}\n… output truncated …\n${safe.slice(-half)}`;
}

function modelResult(result: SubagentShellResult): string {
  const status = [
    `Shell outcome: ${result.outcome}`,
    result.exitCode === undefined ? "" : `Exit code: ${result.exitCode}`,
    result.signal === undefined ? "" : `Signal: ${result.signal}`,
    `Cleanup confirmed: ${result.cleanupConfirmed ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const text = `${status}\n\n${boundedStream("Untrusted stdout", result.stdout)}\n\n${boundedStream("Untrusted stderr", result.stderr)}`;
  return text.slice(0, SUBAGENT_SHELL_MODEL_RESULT_CHARS);
}

export function createSubagentShellTool(): {
  tool: AgentTool;
  binding: SubagentShellToolBindingV2;
} {
  return {
    tool: {
      name: SUBAGENT_RUN_COMMAND_TOOL_NAME,
      label: "Run approved host command",
      description:
        "Run one exact command with full macOS-user host authority after attended Allow once approval. Minimal environment only; no OS sandbox or rollback.",
      parameters: Type.Object(
        {
          command: Type.String({
            minLength: 1,
            maxLength: SUBAGENT_SHELL_MODEL_COMMAND_CHARS,
            description:
              "Exact command bytes. Multiline is allowed; controls and ambiguous text are rejected.",
          }),
        },
        { additionalProperties: false },
      ),
      execute: async () => {
        throw new Error("Subagent shell execution requires the main-owned approval broker.");
      },
    },
    binding: { toolName: SUBAGENT_RUN_COMMAND_TOOL_NAME },
  };
}

export function createSubagentShellBrokerV2(
  input: SubagentShellBrokerV2Input,
): SubagentShellGateV2 {
  if (
    input.authority.execution !== "foreground" ||
    input.authority.capabilities.shell !== true ||
    input.workspace.permission === "none" ||
    input.workspace.folderPath !== input.workspaceRoot ||
    subagentWorkspaceRevisionV2(input.workspace) !== input.authority.workspaceRevision
  ) {
    throw new Error("Subagent shell authority is unavailable.");
  }
  const now = input.now ?? Date.now;
  const allocate = input.randomUUID ?? randomUUID;
  const registry = input.registry ?? workspaceOperationRegistry;
  const runShell = input.runShell ?? runSubagentShellProductionInert;
  const pending = new Map<string, PendingShell>();
  const active = new Set<AbortController>();
  let shuttingDown = false;

  const liveAuthority = (): SubagentAuthorityV2 => {
    const current = input.currentAuthority(input.authority.runId);
    if (
      !sameSubagentAuthorityBindingV2(input.authority, current) ||
      current.expiresAt <= now() ||
      current.capabilities.shell !== true
    ) {
      throw new Error("Subagent shell authority expired or was revoked.");
    }
    return current;
  };
  const liveWorkspace = async (): Promise<Workspace> => {
    const workspace = await input.currentWorkspace(input.authority.workspaceId);
    if (
      !workspace ||
      workspace.permission === "none" ||
      workspace.folderPath !== input.workspaceRoot ||
      subagentWorkspaceRevisionV2(workspace) !== input.authority.workspaceRevision
    ) {
      throw new Error("Subagent shell workspace changed.");
    }
    await input.validateWorkspace(workspace);
    return workspace;
  };
  const cancel = async (prepared: PendingShell): Promise<void> => {
    input.ledger.deny(prepared.approvalId, input.authority.ownerDocumentId);
    try {
      await input.journal.cancelEffectBeforeDispatch(prepared.owner);
    } catch {
      // Existing prepared evidence remains fail-closed.
    }
    prepared.admission.release();
  };

  return {
    beforeToolCall: async (context, callerSignal) => {
      if (context.toolCall.name !== SUBAGENT_RUN_COMMAND_TOOL_NAME) return undefined;
      if (shuttingDown || pending.has(context.toolCall.id)) {
        return blocked("This subagent shell call is unavailable.");
      }
      const admission = registry.admit(input.authority.workspaceId);
      const signal = AbortSignal.any(
        [callerSignal, input.runSignal, admission.signal].filter(
          (candidate): candidate is AbortSignal => candidate !== undefined,
        ),
      );
      let prepared: PendingShell | undefined;
      try {
        const command = plainCommandArguments(context.toolCall.arguments);
        const authority = liveAuthority();
        await liveWorkspace();
        const root = await pinSubagentShellWorkspaceRoot(input.workspaceRoot);
        const expiresAt = Math.min(authority.expiresAt, now() + SUBAGENT_SHELL_APPROVAL_WINDOW_MS);
        const argumentDigest = fieldsDigest("aiden-subagent-shell-argument-v2", command);
        const rootDigest = fieldsDigest(
          "aiden-subagent-shell-root-v2",
          root.path,
          root.device,
          root.inode,
        );
        const calculatedEffectDigest = effectDigest({
          command,
          root,
          authority,
          childId: input.childId,
          toolCallId: context.toolCall.id,
          expiresAt,
        });
        const authorityDigest = subagentAuthorityDigestV2(authority);
        const ledgerInput: PrepareSubagentApprovalV2Input = {
          treeRootId: authority.treeRootId,
          runId: authority.runId,
          childId: input.childId,
          chatId: authority.chatId,
          workspaceId: authority.workspaceId,
          ownerDocumentId: authority.ownerDocumentId,
          toolCallId: context.toolCall.id,
          toolName: SUBAGENT_RUN_COMMAND_TOOL_NAME,
          authorityRevision: authority.authorityRevision,
          arguments: {
            argumentDigest,
            effectDigest: calculatedEffectDigest,
            rootDigest,
          },
          expiresAt,
        };
        const approved = input.ledger.prepare(ledgerInput);
        const effectId = `effect-${allocate()}`;
        const owner = {
          effectId,
          approvalId: approved.approvalId,
          runId: authority.runId,
          chatId: authority.chatId,
        };
        prepared = {
          approvalId: approved.approvalId,
          effectId,
          command,
          argumentDigest,
          effectDigest: calculatedEffectDigest,
          authorityDigest,
          root,
          expiresAt,
          ledgerInput,
          admission,
          owner,
        };
        await input.journal.prepareEffect({
          ...owner,
          childId: input.childId,
          toolCallId: context.toolCall.id,
          toolName: SUBAGENT_RUN_COMMAND_TOOL_NAME,
          effectKind: "shell",
          argumentDigest,
          effectDigest: calculatedEffectDigest,
          authorityDigest,
          expiresAt,
        });
        const worktree = input.workspace.managedWorktree;
        const details: SubagentShellApprovalDetails = {
          kind: "subagent-shell",
          childLabel: input.childLabel,
          command,
          initialCwd: root.path,
          shell: "/bin/zsh -f -c",
          argumentDigestPrefix: argumentDigest.slice(0, DIGEST_PREFIX),
          rootDigestPrefix: rootDigest.slice(0, DIGEST_PREFIX),
          effectDigestPrefix: calculatedEffectDigest.slice(0, DIGEST_PREFIX),
          timeoutMs: SUBAGENT_SHELL_TIMEOUT_MS,
          stdoutLimitBytes: STREAM_BYTES,
          stderrLimitBytes: STREAM_BYTES,
          workspaceLabel: input.workspace.name,
          isManagedWorktree: Boolean(worktree),
          worktreeLabel: worktree?.branch ?? null,
          environmentProfile: "minimal-private-0700-v1",
          osSandboxed: false,
          rollbackAvailable: false,
          outputSentToModel: true,
          arbitraryNetworkAvailable: true,
          detachedProcessesMaySurvive: true,
        };
        const allowed = await input.requestApproval(
          {
            streamId: authority.generationId,
            toolCallId: context.toolCall.id,
            toolName: SUBAGENT_RUN_COMMAND_TOOL_NAME,
            summary: `Run a full-host command for ${input.childLabel}`,
            details,
          },
          signal,
          authority.ownerDocumentId,
        );
        if (!allowed || signal.aborted) {
          await cancel(prepared);
          return blocked(
            allowed ? "This shell call was cancelled." : "The user denied this shell call.",
          );
        }
        const current = liveAuthority();
        await liveWorkspace();
        const repinned = await pinSubagentShellWorkspaceRoot(input.workspaceRoot);
        if (
          !sameRoot(root, repinned) ||
          subagentAuthorityDigestV2(current) !== authorityDigest ||
          !input.ledger.authorize(approved.approvalId, current.ownerDocumentId, ledgerInput)
        ) {
          await cancel(prepared);
          return blocked("This shell approval expired or changed.");
        }
        await input.journal.authorizeEffect(owner);
        pending.set(context.toolCall.id, prepared);
        return undefined;
      } catch {
        if (prepared) await cancel(prepared);
        else admission.release();
        return blocked("This shell call could not be prepared safely.");
      }
    },
    execute: async (effect) => {
      const prepared = pending.get(effect.toolCallId);
      pending.delete(effect.toolCallId);
      if (!prepared || effect.toolName !== SUBAGENT_RUN_COMMAND_TOOL_NAME) {
        if (prepared) await cancel(prepared);
        throw new Error("This shell call has no live one-shot approval.");
      }
      const controller = new AbortController();
      active.add(controller);
      const signal = AbortSignal.any(
        [controller.signal, effect.signal, input.runSignal, prepared.admission.signal].filter(
          (candidate): candidate is AbortSignal => candidate !== undefined,
        ),
      );
      let dispatchStarted = false;
      let terminal = false;
      const finishUnknown = async () => {
        if (terminal) return;
        terminal = true;
        try {
          await input.journal.finishEffect({
            ...prepared.owner,
            state: "unknown",
            terminalDigest: terminalDigest("unknown", "Shell outcome or cleanup is unconfirmed."),
          });
        } catch {
          // Unknown remains the only truthful caller outcome.
        }
      };
      try {
        const command = plainCommandArguments(effect.arguments);
        const authority = liveAuthority();
        await liveWorkspace();
        const root = await pinSubagentShellWorkspaceRoot(input.workspaceRoot);
        if (
          command !== prepared.command ||
          !sameRoot(root, prepared.root) ||
          signal.aborted ||
          prepared.expiresAt <= now() ||
          subagentAuthorityDigestV2(authority) !== prepared.authorityDigest ||
          !input.ledger.consume(prepared.approvalId, prepared.ledgerInput)
        ) {
          await cancel(prepared);
          throw new Error("The shell approval expired or changed.");
        }
        await input.journal.markEffectDispatchStarted(prepared.owner);
        dispatchStarted = true;
        const result = await runShell({
          workspaceRoot: prepared.root,
          command: prepared.command,
          effectDigest: prepared.effectDigest,
          timeoutMs: SUBAGENT_SHELL_TIMEOUT_MS,
          signal,
          binary: input.binary,
        });
        if (result.outcome === "cleanup_unconfirmed" || !result.cleanupConfirmed) {
          await finishUnknown();
          return textResult(modelResult(result));
        }
        const rendered = modelResult(result);
        await input.journal.finishEffect({
          ...prepared.owner,
          state:
            result.outcome === "exited" && result.exitCode === 0 ? "completed" : "remote_error",
          terminalDigest: terminalDigest(result.outcome, rendered),
        });
        terminal = true;
        if (signal.aborted) throw signal.reason;
        return textResult(rendered);
      } catch (error) {
        if (dispatchStarted) await finishUnknown();
        else await cancel(prepared);
        if (signal.aborted) throw signal.reason ?? error;
        throw error;
      } finally {
        controller.abort(new Error("Shell call settled."));
        active.delete(controller);
        prepared.admission.release();
      }
    },
    shutdown: async () => {
      shuttingDown = true;
      for (const controller of active) controller.abort(new Error("The subagent run ended."));
      for (const prepared of pending.values()) await cancel(prepared);
      pending.clear();
    },
  };
}
