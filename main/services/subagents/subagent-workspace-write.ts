import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type {
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import {
  SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT,
  SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT,
  SUBAGENT_WORKSPACE_WRITE_DIGEST_PREFIX_LENGTH,
  SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT,
  SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT,
  SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT,
  isSubagentWorkspaceWriteApprovalDetails,
  type SubagentWorkspaceWriteApprovalDetails,
} from "../../../renderer/shared/assistant.js";
import type { Workspace } from "../types.js";
import type { ToolApprovalPrompt } from "../tool-approval.js";
import {
  workspaceOperationRegistry,
  type WorkspaceOperationAdmission,
  type WorkspaceOperationRegistry,
} from "../workspace-operation-registry.js";
import { SubagentApprovalLedgerV2, type PrepareSubagentApprovalV2Input } from "./approval-v2.js";
import {
  subagentAuthorityDigestV2,
  type SubagentAuthorityV2,
} from "./authority-v2.js";
import { sameSubagentAuthorityBindingV2 } from "./outbound-approval-v2.js";
import {
  canonicalSubagentFileRelativePath,
  pinSubagentWorkspaceRoot,
  SubagentFileMutationPreparer,
  SubagentFilePreparationError,
  type PreparedSubagentFileMutation,
} from "./subagent-file-mutation-core.js";
import {
  createSubagentFileMutatorClient,
  SubagentFileMutatorError,
  type SubagentFileMutatorClient,
} from "./subagent-file-mutator-io.js";

export const SUBAGENT_WRITE_FILE_TOOL_NAME = "write_file";
export const SUBAGENT_EDIT_FILE_TOOL_NAME = "edit_file";
export const SUBAGENT_WORKSPACE_WRITE_APPROVAL_WINDOW_MS = 60_000;

export interface SubagentWorkspaceWriteToolBindingV2 {
  toolName: typeof SUBAGENT_WRITE_FILE_TOOL_NAME | typeof SUBAGENT_EDIT_FILE_TOOL_NAME;
  operation: "write" | "edit";
}

type WriteArguments = { path: string; content: string };
type EditArguments = { path: string; old_string: string; new_string: string };
type MutationArguments = WriteArguments | EditArguments;
type WorkspaceWriteToolName = SubagentWorkspaceWriteToolBindingV2["toolName"];

interface MutationLifecycle {
  admission: WorkspaceOperationAdmission;
  signal: AbortSignal;
  client?: SubagentFileMutatorClient;
  settled: Promise<void>;
  release(): void;
}

interface PendingMutation {
  approvalId: string;
  expiresAt: number;
  toolName: WorkspaceWriteToolName;
  argumentDigest: string;
  authorityDigest: string;
  effect: PreparedSubagentFileMutation;
  client: SubagentFileMutatorClient;
  lifecycle: MutationLifecycle;
  signal: AbortSignal;
}

export interface SubagentWorkspaceWriteApprovalGateV2 {
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

export interface SubagentWorkspaceWriteApprovalBrokerV2Input {
  authority: SubagentAuthorityV2;
  childId: string;
  childLabel: string;
  workspace: Workspace;
  workspaceRoot: string;
  bindings: readonly SubagentWorkspaceWriteToolBindingV2[];
  ledger: SubagentApprovalLedgerV2;
  currentAuthority(runId: string): SubagentAuthorityV2 | undefined;
  currentWorkspace(workspaceId: string): Promise<Workspace | undefined>;
  validateWorkspace(workspace: Workspace): Promise<void>;
  requestApproval(
    descriptor: Omit<ToolApprovalPrompt, "approvalId">,
    signal: AbortSignal | undefined,
    ownerDocumentId: string,
  ): Promise<boolean>;
  runSignal?: AbortSignal;
  registry?: WorkspaceOperationRegistry;
  now?: () => number;
}

function textResult(text: string): AgentToolResult<null> {
  return { content: [{ type: "text", text }], details: null };
}

function blocked(reason: string): BeforeToolCallResult {
  return { block: true, reason };
}

function digestFields(...fields: string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function subagentWorkspaceRevisionV2(workspace: Workspace): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: workspace.id,
        folderPath: workspace.folderPath ?? null,
        permission: workspace.permission,
        managedWorktree: workspace.managedWorktree
          ? {
              repositoryPath: workspace.managedWorktree.repositoryPath,
              worktreePath: workspace.managedWorktree.worktreePath,
              branch: workspace.managedWorktree.branch,
              worktreeGitDir: workspace.managedWorktree.worktreeGitDir ?? null,
              ownershipToken: workspace.managedWorktree.ownershipToken ?? null,
              worktreeDevice: workspace.managedWorktree.worktreeDevice ?? null,
              worktreeInode: workspace.managedWorktree.worktreeInode ?? null,
              createdFromHead: workspace.managedWorktree.createdFromHead,
            }
          : null,
        updatedAt: workspace.updatedAt,
      }),
    )
    .digest("hex");
}

function plainDataArguments(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== "string" ||
        !("value" in descriptors[key]!) ||
        descriptors[key]!.enumerable !== true,
    )
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function parseArguments(toolName: WorkspaceWriteToolName, value: unknown): MutationArguments {
  const record = plainDataArguments(value);
  const expected =
    toolName === SUBAGENT_WRITE_FILE_TOOL_NAME
      ? ["content", "path"]
      : toolName === SUBAGENT_EDIT_FILE_TOOL_NAME
        ? ["new_string", "old_string", "path"]
        : [];
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  const path = canonicalSubagentFileRelativePath(record.path as string);
  if (
    path.length > SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT ||
    path.normalize("NFKC") !== path ||
    path.trim() !== path ||
    [...path].some((character) => unsafeApprovalCodePoint(character.codePointAt(0) ?? 0))
  ) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  if (toolName === SUBAGENT_WRITE_FILE_TOOL_NAME && typeof record.content === "string") {
    return Object.freeze({ path, content: record.content });
  }
  if (
    toolName === SUBAGENT_EDIT_FILE_TOOL_NAME &&
    typeof record.old_string === "string" &&
    record.old_string.length > 0 &&
    typeof record.new_string === "string"
  ) {
    return Object.freeze({
      path,
      old_string: record.old_string,
      new_string: record.new_string,
    });
  }
  throw new SubagentFilePreparationError("invalid_input");
}

function argumentDigest(toolName: WorkspaceWriteToolName, args: MutationArguments): string {
  return toolName === SUBAGENT_WRITE_FILE_TOOL_NAME
    ? digestFields(toolName, args.path, (args as WriteArguments).content)
    : digestFields(
        toolName,
        args.path,
        (args as EditArguments).old_string,
        (args as EditArguments).new_string,
      );
}

function unsafeApprovalCodePoint(point: number): boolean {
  return (
    point <= 0x1f ||
    (point >= 0x7f && point <= 0x9f) ||
    point === 0x061c ||
    point === 0x200e ||
    point === 0x200f ||
    (point >= 0x2028 && point <= 0x202e) ||
    (point >= 0x2066 && point <= 0x2069)
  );
}

function escapedCodePoint(point: number): string {
  return `\\u{${point.toString(16).padStart(4, "0")}}`;
}

function escapedPreviewLine(value: string): string {
  let result = "";
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    result +=
      unsafeApprovalCodePoint(point) && point !== 0x09
        ? escapedCodePoint(point)
        : character;
  }
  return result;
}

function approvalDisplayLabel(value: string, limit: number, fallback: string): string {
  const characters = [...value];
  const firstVisible = characters.findIndex((character) => character.trim().length > 0);
  let lastVisible = -1;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    if (characters[index]!.trim().length > 0) {
      lastVisible = index;
      break;
    }
  }
  const tokens = characters.map((character, index) => {
    const point = character.codePointAt(0) ?? 0;
    const boundaryWhitespace =
      character.trim().length === 0 && (index < firstVisible || index > lastVisible);
    return unsafeApprovalCodePoint(point) || boundaryWhitespace
      ? escapedCodePoint(point)
      : character;
  });
  if (tokens.length === 0) return fallback;
  const full = tokens.join("");
  if (full.length <= limit) return full;
  const marker = "…";
  let result = "";
  for (const token of tokens) {
    if (result.length + token.length + marker.length > limit) break;
    result += token;
  }
  return result.length > 0 ? `${result}${marker}` : fallback;
}

function diffPreview(before: string, after: string): { preview: string; truncated: boolean } {
  const full = [
    "--- current",
    "+++ proposed",
    ...before.split(/\r\n|\n|\r/u).map((line) => `-${escapedPreviewLine(line)}`),
    ...after.split(/\r\n|\n|\r/u).map((line) => `+${escapedPreviewLine(line)}`),
  ].join("\n");
  if (full.length <= SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT) {
    return { preview: full, truncated: false };
  }
  const marker = "\n… preview truncated …\n";
  const available = SUBAGENT_WORKSPACE_WRITE_DIFF_PREVIEW_LIMIT - marker.length;
  return {
    preview: `${full.slice(0, Math.floor(available / 2))}${marker}${full.slice(
      -(available - Math.floor(available / 2)),
    )}`,
    truncated: true,
  };
}

function approvalDetails(input: {
  childLabel: string;
  workspace: Workspace;
  effect: PreparedSubagentFileMutation;
  before: string;
}): SubagentWorkspaceWriteApprovalDetails {
  const preview = diffPreview(input.before, input.effect.postimage.content);
  const operation =
    input.effect.operation === "edit"
      ? "edit"
      : input.effect.expectedRevision === "absent"
        ? "create"
        : "replace";
  const details: SubagentWorkspaceWriteApprovalDetails = {
    kind: "subagent-workspace-write",
    operation,
    childLabel: approvalDisplayLabel(
      input.childLabel,
      SUBAGENT_WORKSPACE_WRITE_CHILD_LABEL_LIMIT,
      "Subagent",
    ),
    path: input.effect.relativePath,
    workspaceLabel: approvalDisplayLabel(
      input.workspace.name,
      SUBAGENT_WORKSPACE_WRITE_WORKSPACE_LABEL_LIMIT,
      "Workspace",
    ),
    worktreeLabel: input.workspace.managedWorktree
      ? approvalDisplayLabel(
          input.workspace.managedWorktree.branch,
          SUBAGENT_WORKSPACE_WRITE_WORKTREE_LABEL_LIMIT,
          "Managed worktree",
        )
      : null,
    isManagedWorktree: input.workspace.managedWorktree !== undefined,
    preDigestPrefix:
      input.effect.expectedRevision === "absent"
        ? null
        : input.effect.expectedRevision.slice(0, SUBAGENT_WORKSPACE_WRITE_DIGEST_PREFIX_LENGTH),
    postDigestPrefix: input.effect.postimage.sha256.slice(
      0,
      SUBAGENT_WORKSPACE_WRITE_DIGEST_PREFIX_LENGTH,
    ),
    beforeBytes: Buffer.byteLength(input.before, "utf8"),
    afterBytes: input.effect.postimage.bytes,
    diffPreview: preview.preview,
    diffTruncated: preview.truncated,
    commandWillRun: false,
    refuseIfChanged: true,
  };
  if (!isSubagentWorkspaceWriteApprovalDetails(details)) {
    throw new SubagentFilePreparationError("invalid_input");
  }
  return details;
}

function fixedMutationError(error: unknown): Error {
  if (error instanceof SubagentFileMutatorError) return new Error(error.message);
  if (error instanceof SubagentFilePreparationError) return new Error(error.message);
  return new Error("The requested workspace operation could not be completed safely.");
}

export function createSubagentWorkspaceWriteTools(): {
  tools: AgentTool[];
  bindings: SubagentWorkspaceWriteToolBindingV2[];
} {
  const unavailable = async (): Promise<AgentToolResult<null>> => {
    throw new Error("Subagent workspace-write execution broker is unavailable.");
  };
  return {
    tools: [
      {
        name: SUBAGENT_WRITE_FILE_TOOL_NAME,
        label: "Write File",
        description:
          "Create or replace one workspace-relative text file after exact attended approval. No command runs.",
        parameters: Type.Object(
          {
            path: Type.String({ maxLength: SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT }),
            content: Type.String(),
          },
          { additionalProperties: false },
        ),
        execute: unavailable,
      },
      {
        name: SUBAGENT_EDIT_FILE_TOOL_NAME,
        label: "Edit File",
        description:
          "Replace exactly one occurrence in one workspace-relative text file after exact attended approval. No command runs.",
        parameters: Type.Object(
          {
            path: Type.String({ maxLength: SUBAGENT_WORKSPACE_WRITE_PATH_LIMIT }),
            old_string: Type.String(),
            new_string: Type.String(),
          },
          { additionalProperties: false },
        ),
        execute: unavailable,
      },
    ],
    bindings: [
      { toolName: SUBAGENT_WRITE_FILE_TOOL_NAME, operation: "write" },
      { toolName: SUBAGENT_EDIT_FILE_TOOL_NAME, operation: "edit" },
    ],
  };
}

export function createSubagentWorkspaceWriteApprovalBrokerV2(
  input: SubagentWorkspaceWriteApprovalBrokerV2Input,
): SubagentWorkspaceWriteApprovalGateV2 {
  const now = input.now ?? Date.now;
  const registry = input.registry ?? workspaceOperationRegistry;
  const bindings = new Map<string, SubagentWorkspaceWriteToolBindingV2>(
    input.bindings.map((binding) => [binding.toolName, binding]),
  );
  if (
    input.authority.execution !== "foreground" ||
    input.authority.capabilities.workspaceWrite !== true ||
    (input.workspace.permission !== "ask" && input.workspace.permission !== "full") ||
    input.workspace.folderPath !== input.workspaceRoot ||
    subagentWorkspaceRevisionV2(input.workspace) !== input.authority.workspaceRevision ||
    bindings.size !== input.bindings.length ||
    input.bindings.some(
      (binding) =>
        (binding.toolName === SUBAGENT_WRITE_FILE_TOOL_NAME && binding.operation !== "write") ||
        (binding.toolName === SUBAGENT_EDIT_FILE_TOOL_NAME && binding.operation !== "edit"),
    )
  ) {
    throw new Error("Subagent workspace-write authority is unavailable.");
  }
  const authorized = new Map<string, PendingMutation>();
  const reservedToolCallIds = new Set<string>();
  const lifecycles = new Map<string, MutationLifecycle>();
  let shuttingDown = false;

  const admitLifecycle = (toolCallId: string, callerSignal?: AbortSignal): MutationLifecycle => {
    const admission = registry.admit(input.authority.workspaceId);
    const signal = AbortSignal.any(
      [callerSignal, input.runSignal, admission.signal].filter(
        (candidate): candidate is AbortSignal => candidate !== undefined,
      ),
    );
    let resolveSettled = () => {};
    let released = false;
    const lifecycle: MutationLifecycle = {
      admission,
      signal,
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      release: () => {
        if (released) return;
        released = true;
        lifecycles.delete(toolCallId);
        reservedToolCallIds.delete(toolCallId);
        admission.release();
        resolveSettled();
      },
    };
    lifecycles.set(toolCallId, lifecycle);
    if (shuttingDown) admission.cancel(new Error("The subagent run ended."));
    return lifecycle;
  };

  const liveAuthority = (): SubagentAuthorityV2 => {
    const current = input.currentAuthority(input.authority.runId);
    if (
      !sameSubagentAuthorityBindingV2(input.authority, current) ||
      current.expiresAt <= now() ||
      current.capabilities.workspaceWrite !== true
    ) {
      throw new Error("Subagent workspace-write authority expired or was revoked.");
    }
    return current;
  };

  const liveWorkspace = async (signal: AbortSignal): Promise<Workspace> => {
    if (signal.aborted) throw new SubagentFilePreparationError("cancelled");
    const workspace = await input.currentWorkspace(input.authority.workspaceId);
    if (
      signal.aborted ||
      !workspace ||
      workspace.folderPath !== input.workspaceRoot ||
      (workspace.permission !== "ask" && workspace.permission !== "full") ||
      subagentWorkspaceRevisionV2(workspace) !== input.authority.workspaceRevision
    ) {
      throw new SubagentFilePreparationError(signal.aborted ? "cancelled" : "conflict");
    }
    await input.validateWorkspace(workspace);
    if (signal.aborted) throw new SubagentFilePreparationError("cancelled");
    return workspace;
  };

  const ledgerInput = (
    authority: SubagentAuthorityV2,
    pending: Pick<PendingMutation, "expiresAt" | "argumentDigest" | "authorityDigest" | "effect">,
    toolCallId: string,
    toolName: WorkspaceWriteToolName,
  ): PrepareSubagentApprovalV2Input => ({
    treeRootId: authority.treeRootId,
    runId: authority.runId,
    childId: input.childId,
    chatId: authority.chatId,
    workspaceId: authority.workspaceId,
    ownerDocumentId: authority.ownerDocumentId,
    toolCallId,
    toolName,
    authorityRevision: authority.authorityRevision,
    arguments: {
      originalArgumentDigest: pending.argumentDigest,
      effectDigest: pending.effect.effectDigest,
      workspaceRevision: authority.workspaceRevision,
      authorityDigest: pending.authorityDigest,
    },
    expiresAt: pending.expiresAt,
  });

  const cleanup = async (toolCallId: string, pending: PendingMutation): Promise<void> => {
    authorized.delete(toolCallId);
    if (pending.approvalId) {
      input.ledger.deny(pending.approvalId, input.authority.ownerDocumentId);
    }
    try {
      await pending.client.close();
    } catch {
      // The client kills and bounded-drains itself on reconciliation failure.
    } finally {
      pending.lifecycle.release();
    }
  };

  const beforeToolCall: SubagentWorkspaceWriteApprovalGateV2["beforeToolCall"] = async (
    context,
    callerSignal,
  ) => {
    const binding = bindings.get(context.toolCall.name);
    if (!binding) return undefined;
    if (shuttingDown) {
      return blocked("This subagent workspace-write broker is shutting down.");
    }
    if (reservedToolCallIds.has(context.toolCall.id)) {
      return blocked("This subagent workspace-write call was already prepared.");
    }
    reservedToolCallIds.add(context.toolCall.id);
    let args: MutationArguments;
    try {
      args = parseArguments(binding.toolName, context.args);
      liveAuthority();
    } catch {
      reservedToolCallIds.delete(context.toolCall.id);
      return blocked("This subagent workspace-write request is invalid or no longer authorized.");
    }
    const lifecycle = admitLifecycle(context.toolCall.id, callerSignal);
    const { signal } = lifecycle;
    let client: SubagentFileMutatorClient | undefined;
    let pending: PendingMutation | undefined;
    let retained = false;
    try {
      const workspace = await liveWorkspace(signal);
      const root = await pinSubagentWorkspaceRoot(input.workspaceRoot, signal);
      client = createSubagentFileMutatorClient({ workspaceRoot: root });
      lifecycle.client = client;
      const preparer = new SubagentFileMutationPreparer();
      const inspection = await client.inspect(preparer.createEffectId(), args.path, signal);
      const effect =
        binding.operation === "write"
          ? preparer.prepareWrite({
              inspection,
              content: (args as WriteArguments).content,
            })
          : preparer.prepareEdit({
              inspection,
              oldString: (args as EditArguments).old_string,
              newString: (args as EditArguments).new_string,
            });
      await client.prepare(effect, signal);
      const authority = liveAuthority();
      const expiresAt = Math.min(
        authority.expiresAt,
        now() + SUBAGENT_WORKSPACE_WRITE_APPROVAL_WINDOW_MS,
      );
      pending = {
        approvalId: "",
        expiresAt,
        toolName: binding.toolName,
        argumentDigest: argumentDigest(binding.toolName, args),
        authorityDigest: subagentAuthorityDigestV2(authority),
        effect,
        client,
        lifecycle,
        signal,
      };
      const prepared = input.ledger.prepare(
        ledgerInput(authority, pending, context.toolCall.id, binding.toolName),
      );
      pending.approvalId = prepared.approvalId;
      const details = approvalDetails({
        childLabel: input.childLabel,
        workspace,
        effect,
        before: inspection.currentContent ?? "",
      });
      const allowed = await input.requestApproval(
        {
          streamId: authority.generationId,
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          summary: `${details.operation} ${JSON.stringify(details.path)} in ${JSON.stringify(
            details.workspaceLabel,
          )}`,
          details,
        },
        signal,
        authority.ownerDocumentId,
      );
      if (!allowed || signal.aborted) {
        await cleanup(context.toolCall.id, pending);
        return blocked(
          signal.aborted
            ? "This subagent workspace-write operation was cancelled."
            : "The user denied this subagent workspace-write operation.",
        );
      }
      const currentAuthority = liveAuthority();
      await liveWorkspace(signal);
      if (
        subagentAuthorityDigestV2(currentAuthority) !== pending.authorityDigest ||
        !input.ledger.authorize(
          pending.approvalId,
          currentAuthority.ownerDocumentId,
          ledgerInput(currentAuthority, pending, context.toolCall.id, binding.toolName),
        )
      ) {
        await cleanup(context.toolCall.id, pending);
        return blocked("This subagent workspace-write approval expired or changed.");
      }
      authorized.set(context.toolCall.id, pending);
      retained = true;
      return undefined;
    } catch (error) {
      if (pending) await cleanup(context.toolCall.id, pending);
      else {
        try {
          await client?.close();
        } catch {
          // Client close owns forced process cleanup.
        }
      }
      return blocked(fixedMutationError(error).message);
    } finally {
      if (!retained && lifecycles.get(context.toolCall.id) === lifecycle) {
        lifecycle.release();
      }
    }
  };

  const execute: SubagentWorkspaceWriteApprovalGateV2["execute"] = async (effect) => {
    const pending = authorized.get(effect.toolCallId);
    authorized.delete(effect.toolCallId);
    if (!pending) {
      throw new Error("This subagent workspace-write call has no live one-shot approval.");
    }
    let commitConfirmed = false;
    let cleanupPreserved = false;
    try {
      if (pending.toolName !== effect.toolName) {
        throw new SubagentFilePreparationError("conflict");
      }
      const args = parseArguments(pending.toolName, effect.arguments);
      const authority = liveAuthority();
      await liveWorkspace(pending.signal);
      if (
        pending.signal.aborted ||
        argumentDigest(effect.toolName, args) !== pending.argumentDigest ||
        subagentAuthorityDigestV2(authority) !== pending.authorityDigest ||
        !input.ledger.consume(
          pending.approvalId,
          ledgerInput(authority, pending, effect.toolCallId, effect.toolName),
        )
      ) {
        throw new SubagentFilePreparationError(
          pending.signal.aborted ? "cancelled" : "conflict",
        );
      }
      const commit = await pending.client.commit(
        pending.effect.effectId,
        effect.signal ? AbortSignal.any([pending.signal, effect.signal]) : pending.signal,
      );
      commitConfirmed = true;
      if (commit.recoveryName) {
        await pending.client.finalize(pending.effect.effectId);
      }
      return textResult("The approved workspace file change was committed.");
    } catch (error) {
      if (
        pending.client.currentState === "committed" ||
        pending.client.currentState === "indeterminate"
      ) {
        try {
          await pending.client.preserve(pending.effect.effectId);
          cleanupPreserved = true;
        } catch {
          // Preserve failure cannot upgrade an unknown outcome to success.
        }
      }
      if (commitConfirmed) {
        throw new Error(
          cleanupPreserved
            ? "The approved workspace file change was committed, but its recovery cleanup could not be confirmed. A recovery artifact was preserved."
            : "The approved workspace file change was committed, but its recovery cleanup outcome is unknown.",
        );
      }
      throw fixedMutationError(error);
    } finally {
      input.ledger.deny(pending.approvalId, input.authority.ownerDocumentId);
      try {
        await pending.client.close();
      } catch {
        // The target outcome has already been reported from commit/finalize.
      } finally {
        pending.lifecycle.release();
      }
    }
  };

  return {
    beforeToolCall,
    execute,
    shutdown: async () => {
      shuttingDown = true;
      const active = [...lifecycles.entries()];
      const settling = active.map(([, { settled }]) => settled);
      for (const [, lifecycle] of active) {
        lifecycle.admission.cancel(new Error("The subagent run ended."));
      }
      for (const [toolCallId, pending] of authorized) {
        authorized.delete(toolCallId);
        input.ledger.deny(pending.approvalId, input.authority.ownerDocumentId);
      }
      await Promise.allSettled(
        active.map(([, lifecycle]) => lifecycle.client?.close()),
      );
      for (const [, lifecycle] of active) lifecycle.release();
      await Promise.allSettled(settling);
    },
  };
}
