/**
 * Per-generation host services an ACP turn needs from Aiden.
 *
 * A Pi provider only sees `(model, context, options)`. An ACP agent also needs
 * the chat's folder, its live permission, Aiden's approval card, and the
 * activity timeline. The generation that owns a chat registers a host for the
 * duration of its run; the ACP runtime looks it up by Pi `sessionId` (the chat
 * id). No host means the turn is not an attended desktop chat, and the runtime
 * refuses it rather than running an agent nobody can supervise.
 */
import type { Tool } from "@earendil-works/pi-ai";

import type { AcpHostPermission, AcpQuestion } from "./harness.js";

export type AcpApprovalOutcome = "allow_once" | "allow_always" | "reject" | "cancelled";

export interface AcpApprovalRequest {
  /** Stable id of the agent's tool call this approval is for. */
  toolCallId: string;
  kind: "command" | "file_change" | "file_read" | "fetch" | "other";
  title: string;
  /** Workspace-relative paths, when known. */
  paths: string[];
  /** Agent-supplied warning attached to "always allow". */
  warning?: string;
  /** Whether the agent offered an "always allow" option. */
  offersAlways: boolean;
}

export type AcpActivityTerminalStatus = "completed" | "failed" | "blocked" | "cancelled";

export interface AcpTurnHost {
  chatId: string;
  /** The agent's working directory. */
  cwd: string;
  /** Directories file callbacks may touch; the first is the workspace. */
  roots: readonly string[];
  permission(): AcpHostPermission;
  /** Ask the user through Aiden's approval surface. */
  requestApproval(request: AcpApprovalRequest, signal: AbortSignal): Promise<AcpApprovalOutcome>;
  /** Ask a fixed-choice question; resolves to an option id, or undefined when dismissed. */
  askQuestion?(question: AcpQuestion, signal: AbortSignal): Promise<string | undefined>;
  activity: {
    started(id: string, toolName: string, args: Record<string, unknown>): void;
    running(id: string): void;
    finished(id: string, status: AcpActivityTerminalStatus, details?: unknown): void;
  };
  /** Tools from Aiden's own set the agent may call through the bridge. */
  bridgeableTools(tools: readonly Tool[]): Tool[];
  /** A short, quiet notice for the user (for example, context reconstruction). */
  notice?(text: string): void;
  onFileWrite?(absolutePath: string, before: string | undefined, after: string): void;
}

export class AcpHostRegistry {
  private readonly hosts = new Map<string, AcpTurnHost>();

  /** Register for one generation. The returned function unregisters only this host. */
  register(host: AcpTurnHost): () => void {
    this.hosts.set(host.chatId, host);
    return () => {
      if (this.hosts.get(host.chatId) === host) this.hosts.delete(host.chatId);
    };
  }

  get(chatId: string | undefined): AcpTurnHost | undefined {
    return chatId ? this.hosts.get(chatId) : undefined;
  }
}
