/**
 * The tools Aiden's MCP server offers outside apps (Claude Code, Codex, ...).
 *
 * Ported in spirit from T3 Code's MCP server (pingdotgg/t3code#33196): a small
 * catalog with terse descriptions and read/write annotations, where a
 * long-running turn is followed with a bounded wait instead of a stream.
 *
 * Every tool is declared `read` or `write`. A Read app sees and calls only
 * reads; a Supervised app may also start, continue and stop turns. Nothing
 * here can answer an approval or a question: those stay with the person, in
 * Aiden on this computer. Every call goes through the same chat and stream
 * services a paired phone uses, so workspace permissions, model resolution,
 * idempotency and revocation behave exactly as they do there.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { ASSISTANT_WORKSPACE_ID } from "../../renderer/shared/assistant.js";
import type { AidenMcpChatProvenance } from "./aiden-mcp-provenance.js";
import type { AidenRemoteChatService, AidenRemoteMessageProjection } from "./aiden-remote-chats.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteCapability } from "./aiden-remote-protocol.js";
import type { AidenRemoteStreamService, AidenRemoteStreamState } from "./aiden-remote-streams.js";
import type { AidenRemoteWorkspaceService } from "./aiden-remote-workspaces.js";

export const AIDEN_MCP_TOOL_PREFIX = "aiden_";

export type AidenMcpToolLevel = "read" | "write";

/** The app a request authenticated as. */
export interface AidenMcpApp {
  id: string;
  name: string;
  capabilities: ReadonlySet<AidenRemoteCapability>;
}

export interface AidenMcpServices {
  chats: Pick<AidenRemoteChatService, "listSummaries" | "messagesWindow" | "classify" | "runMutation" | "create" | "startTurn">;
  streams: Pick<AidenRemoteStreamService, "status" | "pendingApproval" | "pendingQuestion" | "cancel" | "watch">;
  workspaces: Pick<AidenRemoteWorkspaceService, "list">;
}

export interface AidenMcpLimits {
  /** Turns (chat_start plus chat_send) one app may start per minute. */
  turnsPerMinute: number;
  /** Runs one app may have going at once. */
  concurrentRuns: number;
  /** The longest a single `aiden_chat_wait` holds before answering `running`. */
  maxWaitSeconds: number;
}

export const DEFAULT_AIDEN_MCP_LIMITS: AidenMcpLimits = {
  turnsPerMinute: 10,
  concurrentRuns: 2,
  maxWaitSeconds: 55,
};

export interface AidenMcpToolDependencies {
  services(): Promise<AidenMcpServices>;
  /**
   * The Remote revocation fence (`AidenRemoteStateRegistry.acquireDeviceAuthorization`).
   * Throws once revocation began; a write holds the returned release until it
   * finishes, so revocation waits for it.
   */
  acquireAuthorization(appId: string, tracksMutationDrain: boolean): () => void;
  /** Local only: which app started a chat. Never projected anywhere. */
  recordProvenance?(chatId: string, provenance: AidenMcpChatProvenance): Promise<void>;
  appVersion: string;
  /** This computer's name, as the person sees it, so an app can say where to approve. */
  hostName(): Promise<string>;
  now?(): number;
  limits?: Partial<AidenMcpLimits>;
}

const WAIT_DEFAULT_SECONDS = 25;
const READ_DEFAULT_MESSAGES = 20;
const READ_MAX_MESSAGES = 50;
const LIST_DEFAULT_CHATS = 20;
const LIST_MAX_CHATS = 50;
/** One message's text, as an app reads it; longer text is cut and flagged. */
const MESSAGE_TEXT_LIMIT = 20_000;
const TURN_TEXT_LIMIT = 200_000;
const REQUEST_CACHE_LIMIT = 128;
const TERMINAL_STATES: ReadonlySet<AidenRemoteStreamState> = new Set(["done", "error", "cancelled", "interrupted"]);

const ID = { pattern: "^[A-Za-z0-9._:-]{1,128}$", maxLength: 128 } as const;
const CLIENT_REQUEST_ID = Type.String({
  pattern: "^[A-Za-z0-9._:-]{8,96}$",
  minLength: 8,
  maxLength: 96,
  description: "A unique id you choose for this request. Retrying with the same id never starts a second turn.",
});
const TURN_TEXT = Type.String({ minLength: 1, maxLength: TURN_TEXT_LIMIT, description: "The message to send." });

type ToolHandler = (app: AidenMcpApp, args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult>;

interface ToolDefinition {
  name: string;
  level: AidenMcpToolLevel;
  /** The capability the app must hold. */
  capability: AidenRemoteCapability;
  title: string;
  description: string;
  schema: TSchema;
  annotations: NonNullable<Tool["annotations"]>;
  handler: ToolHandler;
}

class ToolRefusal extends Error {}

/**
 * Owns the tool catalog and per-app state (rate limit, runs in flight, waits).
 * One runner lives as long as the MCP server; each HTTP request uses it.
 */
export class AidenMcpToolRunner {
  private readonly tools: ToolDefinition[];
  private readonly limits: AidenMcpLimits;
  private readonly now: () => number;
  private readonly turnTimes = new Map<string, number[]>();
  private readonly runs = new Map<string, Set<string>>();
  private readonly waits = new Map<string, Set<AbortController>>();
  /** In-flight and recent turn requests, so a retry replays instead of counting again. */
  private readonly requests = new Map<string, Promise<CallToolResult>>();

  constructor(private readonly dependencies: AidenMcpToolDependencies) {
    this.limits = { ...DEFAULT_AIDEN_MCP_LIMITS, ...dependencies.limits };
    this.now = dependencies.now ?? Date.now;
    this.tools = this.defineTools();
  }

  /** The level of a tool, or undefined for a name Aiden does not offer. */
  levelOf(name: string): AidenMcpToolLevel | undefined {
    return this.tools.find((tool) => tool.name === name)?.level;
  }

  /** The tools this app may call. A Read app is never shown a write tool. */
  list(app: AidenMcpApp): Tool[] {
    return this.tools
      .filter((tool) => app.capabilities.has(tool.capability))
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        // Plain JSON Schema: TypeBox metadata never reaches the wire.
        inputSchema: JSON.parse(JSON.stringify(tool.schema)) as Tool["inputSchema"],
        annotations: { title: tool.title, ...tool.annotations },
      }));
  }

  async call(app: AidenMcpApp, name: string, args: unknown, signal: AbortSignal): Promise<CallToolResult> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) return toolError("Aiden has no tool with that name.");
    if (!app.capabilities.has(tool.capability)) {
      return toolError(
        tool.level === "write"
          ? "This app is connected to Aiden with Read access, so it cannot start, send or stop turns."
          : "This app does not have access to that Aiden tool.",
      );
    }
    const input = args ?? {};
    if (!input || typeof input !== "object" || Array.isArray(input) || !Value.Check(tool.schema, input)) {
      return toolError("The arguments do not match the tool's schema.");
    }
    let release: () => void;
    try {
      release = this.dependencies.acquireAuthorization(app.id, tool.level === "write");
    } catch {
      return toolError("This app was disconnected from Aiden.");
    }
    try {
      return await tool.handler(app, input as Record<string, unknown>, signal);
    } catch (error) {
      if (error instanceof ToolRefusal) return toolError(error.message);
      if (error instanceof AidenRemoteServiceError) return toolError(error.message);
      return toolError("Aiden could not complete this request.");
    } finally {
      release();
    }
  }

  /** Forgets an app's limiter state and ends its waits. Run when the app is revoked. */
  revokeApp(appId: string): void {
    for (const controller of this.waits.get(appId) ?? []) controller.abort();
    this.waits.delete(appId);
    this.turnTimes.delete(appId);
    this.runs.delete(appId);
    for (const key of [...this.requests.keys()]) {
      if (key.startsWith(`${appId}\u0000`)) this.requests.delete(key);
    }
  }

  private defineTools(): ToolDefinition[] {
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    return [
      {
        name: "aiden_server_info",
        level: "read",
        capability: "server:read",
        title: "Aiden server info",
        description: "Which Aiden this is, which computer it runs on, and this app's access.",
        schema: Type.Object({}, { additionalProperties: false }),
        annotations: read,
        handler: async (app) => this.serverInfo(app),
      },
      {
        name: "aiden_workspace_list",
        level: "read",
        capability: "chat:read",
        title: "List workspaces",
        description: "List the person's Aiden workspaces. A new chat starts in one of these.",
        schema: Type.Object({}, { additionalProperties: false }),
        annotations: read,
        handler: async () => this.workspaceList(),
      },
      {
        name: "aiden_chat_list",
        level: "read",
        capability: "chat:read",
        title: "List chats",
        description: "List recent Aiden chats, newest first. Pass nextCursor back to page.",
        schema: Type.Object(
          {
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIST_MAX_CHATS })),
            cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          },
          { additionalProperties: false },
        ),
        annotations: { ...read, idempotentHint: false },
        handler: async (_app, args) => this.chatList(args),
      },
      {
        name: "aiden_chat_read",
        level: "read",
        capability: "chat:read",
        title: "Read a chat",
        description: "Read a chat's most recent messages. Pass `before` (a message id) to read older ones.",
        schema: Type.Object(
          {
            chatId: Type.String(ID),
            before: Type.Optional(Type.String(ID)),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: READ_MAX_MESSAGES })),
          },
          { additionalProperties: false },
        ),
        annotations: { ...read, idempotentHint: false },
        handler: async (_app, args) => this.chatRead(args),
      },
      {
        name: "aiden_chat_wait",
        level: "read",
        capability: "chat:read",
        title: "Wait for a run",
        description:
          "Wait until a run you started stops running, or the timeout passes. Returns running, waiting_for_approval, waiting_for_input, done or failed. Approvals and questions are answered by the person in Aiden; call again to keep waiting.",
        schema: Type.Object(
          {
            chatId: Type.String(ID),
            runId: Type.String(ID),
            timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: this.limits.maxWaitSeconds })),
          },
          { additionalProperties: false },
        ),
        annotations: { ...read, idempotentHint: false },
        handler: async (app, args, signal) => this.chatWait(app, args, signal),
      },
      {
        name: "aiden_chat_start",
        level: "write",
        capability: "chat:write",
        title: "Start a chat",
        description:
          "Start a new Aiden chat in a workspace and send its first message. Tools run with that workspace's permissions; approvals go to the person in Aiden. Follow the run with aiden_chat_wait.",
        schema: Type.Object(
          {
            clientRequestId: CLIENT_REQUEST_ID,
            workspaceId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$", maxLength: 128 }),
            text: TURN_TEXT,
            providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
            modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          },
          { additionalProperties: false },
        ),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        handler: async (app, args) => this.turnRequest(app, args, () => this.chatStart(app, args)),
      },
      {
        name: "aiden_chat_send",
        level: "write",
        capability: "chat:write",
        title: "Send a message",
        description: "Send a follow-up message to an Aiden chat. Follow the run with aiden_chat_wait.",
        schema: Type.Object(
          { clientRequestId: CLIENT_REQUEST_ID, chatId: Type.String(ID), text: TURN_TEXT },
          { additionalProperties: false },
        ),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        handler: async (app, args) => this.turnRequest(app, args, () => this.chatSend(app, args)),
      },
      {
        name: "aiden_chat_stop",
        level: "write",
        capability: "chat:write",
        title: "Stop a run",
        description: "Stop a run this app started. Stopping a finished run does nothing.",
        schema: Type.Object({ chatId: Type.String(ID), runId: Type.String(ID) }, { additionalProperties: false }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        handler: async (app, args) => this.chatStop(app, args),
      },
    ];
  }

  private async serverInfo(app: AidenMcpApp): Promise<CallToolResult> {
    return toolResult({
      name: "Aiden",
      version: this.dependencies.appVersion,
      computer: await this.dependencies.hostName(),
      app: { name: app.name, access: app.capabilities.has("chat:write") ? "supervised" : "read" },
      tools: this.list(app).map((tool) => tool.name),
    });
  }

  private async workspaceList(): Promise<CallToolResult> {
    return toolResult({
      workspaces: (await offeredWorkspaces(await this.dependencies.services())).map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        hasFolder: workspace.hasFolder,
        toolPermission: workspace.permission,
      })),
    });
  }

  private async chatList(args: Record<string, unknown>): Promise<CallToolResult> {
    const { chats } = await this.dependencies.services();
    const page = await chats.listSummaries(
      (args.limit as number | undefined) ?? LIST_DEFAULT_CHATS,
      args.cursor as string | undefined,
    );
    return toolResult({
      chats: page.summaries.map((summary) => ({
        id: summary.id,
        workspaceId: summary.workspaceId,
        title: summary.title,
        updatedAt: summary.updatedAt,
        running: summary.activity === "active",
        ...(summary.lastRunFailed ? { lastRunFailed: true } : {}),
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  }

  private async chatRead(args: Record<string, unknown>): Promise<CallToolResult> {
    const services = await this.dependencies.services();
    const chatId = args.chatId as string;
    await requireOrdinaryChat(services, chatId);
    const window = await services.chats.messagesWindow(chatId, {
      ...(typeof args.before === "string" ? { before: args.before } : {}),
      limit: (args.limit as number | undefined) ?? READ_DEFAULT_MESSAGES,
    });
    return toolResult({
      chatId: window.chatId,
      workspaceId: window.workspaceId,
      title: window.title,
      messages: window.messages.map(projectMessage),
      hasOlder: window.hasOlder,
    });
  }

  private async chatWait(app: AidenMcpApp, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const services = await this.dependencies.services();
    const chatId = args.chatId as string;
    const runId = args.runId as string;
    await requireOrdinaryChat(services, chatId);
    const timeoutMs = ((args.timeoutSeconds as number | undefined) ?? Math.min(WAIT_DEFAULT_SECONDS, this.limits.maxWaitSeconds)) * 1_000;
    const first = await this.runSnapshot(services, app, chatId, runId);
    if (first.state !== "running" || signal.aborted) return toolResult(first);

    const controller = new AbortController();
    const appWaits = this.waits.get(app.id) ?? new Set<AbortController>();
    appWaits.add(controller);
    this.waits.set(app.id, appWaits);
    let detach: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await new Promise<"changed" | "timeout" | "closed" | "aborted">((resolve) => {
        const abort = () => resolve("aborted");
        signal.addEventListener("abort", abort, { once: true });
        controller.signal.addEventListener("abort", () => resolve("closed"), { once: true });
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        try {
          detach = services.streams.watch(app.id, runId, {
            onChange: () => {
              // Most events (text deltas, tool output) leave the run running;
              // only a state change answers the wait.
              void this.runSnapshot(services, app, chatId, runId)
                .then((snapshot) => {
                  if (snapshot.state !== "running") resolve("changed");
                })
                .catch(() => resolve("changed"));
            },
            onClose: () => resolve("closed"),
          });
        } catch {
          resolve("changed");
        }
      });
      if (outcome === "closed") throw new ToolRefusal("This app was disconnected from Aiden.");
      if (outcome === "aborted") return toolError("The wait ended because the request closed.");
      return toolResult(await this.runSnapshot(services, app, chatId, runId));
    } finally {
      if (timer) clearTimeout(timer);
      detach?.();
      appWaits.delete(controller);
      if (appWaits.size === 0 && this.waits.get(app.id) === appWaits) this.waits.delete(app.id);
    }
  }

  private async chatStart(app: AidenMcpApp, args: Record<string, unknown>): Promise<CallToolResult> {
    const services = await this.dependencies.services();
    const clientRequestId = args.clientRequestId as string;
    const providerId = args.providerId as string | undefined;
    const modelId = args.modelId as string | undefined;
    // Only a workspace aiden_workspace_list offers: never a one-chat folder or the assistant's own.
    if (!(await offeredWorkspaces(services)).some((workspace) => workspace.id === args.workspaceId)) {
      throw new ToolRefusal("Aiden has no workspace with that id. List them with aiden_workspace_list.");
    }
    this.admitTurn(services, app);
    const chat = await services.chats.create(app.id, `mcp-create:${clientRequestId}`, {
      workspaceId: args.workspaceId,
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
    });
    await this.dependencies.recordProvenance?.(chat.id, {
      kind: "app",
      appId: app.id,
      name: app.name,
      startedAt: this.now(),
    }).catch(() => undefined);
    // The first turn goes through the same mutation fence as any other turn.
    const classification = await requireOrdinaryChat(services, chat.id);
    const turn = await services.chats.runMutation(app.id, chat.id, classification, () =>
      services.chats.startTurn(app.id, chat.id, `mcp-turn:${clientRequestId}`, { text: args.text }),
    );
    this.trackRun(app.id, turn.streamId);
    return toolResult({ chatId: chat.id, turnId: turn.turnId, runId: turn.streamId, state: "running" });
  }

  private async chatSend(app: AidenMcpApp, args: Record<string, unknown>): Promise<CallToolResult> {
    const services = await this.dependencies.services();
    const chatId = args.chatId as string;
    const classification = await requireOrdinaryChat(services, chatId);
    this.admitTurn(services, app);
    const turn = await services.chats.runMutation(app.id, chatId, classification, () =>
      services.chats.startTurn(app.id, chatId, `mcp-turn:${args.clientRequestId as string}`, { text: args.text }),
    );
    this.trackRun(app.id, turn.streamId);
    return toolResult({ chatId, turnId: turn.turnId, runId: turn.streamId, state: "running" });
  }

  private async chatStop(app: AidenMcpApp, args: Record<string, unknown>): Promise<CallToolResult> {
    const services = await this.dependencies.services();
    const chatId = args.chatId as string;
    const runId = args.runId as string;
    const classification = await requireOrdinaryChat(services, chatId);
    const status = ownedRunStatus(services, app, chatId, runId);
    if (TERMINAL_STATES.has(status.state)) {
      return toolResult({ chatId, runId, stopped: false, state: waitState(status.state) });
    }
    await services.chats.runMutation(app.id, chatId, classification, () =>
      services.streams.cancel(app.id, runId, `mcp-stop:${runId}`),
    );
    return toolResult({ chatId, runId, stopped: true });
  }

  /**
   * Turn requests with the same clientRequestId share one outcome, so a retry
   * replays the first answer and is not counted against the rate limit again.
   */
  private turnRequest(
    app: AidenMcpApp,
    args: Record<string, unknown>,
    run: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const key = `${app.id}\u0000${args.clientRequestId as string}`;
    const existing = this.requests.get(key);
    if (existing) return existing;
    const pending = run().catch((error: unknown) => {
      // A refusal or failure is not cached: the app may retry once it clears.
      this.requests.delete(key);
      throw error;
    });
    this.requests.set(key, pending);
    while (this.requests.size > REQUEST_CACHE_LIMIT) {
      const oldest = this.requests.keys().next().value;
      if (oldest === undefined) break;
      this.requests.delete(oldest);
    }
    return pending;
  }

  /** Refuses a turn over this app's rate or concurrency limit, then counts it. */
  private admitTurn(services: AidenMcpServices, app: AidenMcpApp): void {
    const now = this.now();
    const recent = (this.turnTimes.get(app.id) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= this.limits.turnsPerMinute) {
      this.turnTimes.set(app.id, recent);
      const retryAfter = Math.max(1, Math.ceil((60_000 - (now - recent[0]!)) / 1_000));
      throw new ToolRefusal(
        `This app started ${this.limits.turnsPerMinute} turns in the last minute. Try again in ${retryAfter} seconds.`,
      );
    }
    const running = this.liveRuns(services, app.id);
    if (running >= this.limits.concurrentRuns) {
      throw new ToolRefusal(
        `This app already has ${running} runs going in Aiden. Wait for one to finish or stop one first.`,
      );
    }
    recent.push(now);
    this.turnTimes.set(app.id, recent);
  }

  private liveRuns(services: AidenMcpServices, appId: string): number {
    const runs = this.runs.get(appId);
    if (!runs) return 0;
    for (const runId of [...runs]) {
      try {
        if (TERMINAL_STATES.has(services.streams.status(appId, runId).state)) runs.delete(runId);
      } catch {
        runs.delete(runId);
      }
    }
    return runs.size;
  }

  private trackRun(appId: string, runId: string): void {
    const runs = this.runs.get(appId) ?? new Set<string>();
    runs.add(runId);
    this.runs.set(appId, runs);
  }

  private async runSnapshot(
    services: AidenMcpServices,
    app: AidenMcpApp,
    chatId: string,
    runId: string,
  ): Promise<Record<string, unknown>> {
    const status = ownedRunStatus(services, app, chatId, runId);
    const base = { chatId, runId };
    const approveIn = `Aiden on ${await this.dependencies.hostName()}`;
    if (!TERMINAL_STATES.has(status.state)) {
      if (services.streams.pendingQuestion(app.id, runId)) {
        return { ...base, state: "waiting_for_input", answerIn: approveIn };
      }
      const approval = services.streams.pendingApproval(app.id, runId);
      if (approval || status.state === "waiting_for_approval") {
        return {
          ...base,
          state: "waiting_for_approval",
          approveIn,
          ...(approval
            ? { approval: { toolName: approval.toolName, summary: approval.summary, expiresAt: approval.expiresAt } }
            : {}),
        };
      }
      return { ...base, state: "running" };
    }
    if (status.state === "done" || status.state === "cancelled") {
      const reply = await lastAssistantMessage(services, chatId).catch(() => undefined);
      return {
        ...base,
        state: "done",
        outcome: status.state === "cancelled" ? "stopped" : "completed",
        ...(reply ? { reply } : {}),
      };
    }
    return { ...base, state: "failed", reason: status.state === "interrupted" ? "interrupted" : "error" };
  }
}

/** The workspaces an outside app may start chats in: the person's named ones. */
async function offeredWorkspaces(services: AidenMcpServices) {
  const { workspaces } = await services.workspaces.list();
  return workspaces.filter((workspace) => workspace.noWorkspace !== true && workspace.id !== ASSISTANT_WORKSPACE_ID);
}

/** Bot chats are not offered to outside apps; they read as missing. */
async function requireOrdinaryChat(
  services: AidenMcpServices,
  chatId: string,
): Promise<Awaited<ReturnType<AidenMcpServices["chats"]["classify"]>>> {
  const classification = await services.chats.classify(chatId);
  if (classification.botId) throw new ToolRefusal("This Aiden chat no longer exists.");
  return classification;
}

function ownedRunStatus(services: AidenMcpServices, app: AidenMcpApp, chatId: string, runId: string) {
  let status;
  try {
    status = services.streams.status(app.id, runId);
  } catch {
    throw new ToolRefusal("Aiden no longer tracks this run. Read the chat with aiden_chat_read for its result.");
  }
  if (status.chatId !== chatId) {
    throw new ToolRefusal("Aiden no longer tracks this run. Read the chat with aiden_chat_read for its result.");
  }
  return status;
}

function waitState(state: AidenRemoteStreamState): string {
  if (state === "done" || state === "cancelled") return "done";
  if (TERMINAL_STATES.has(state)) return "failed";
  return state === "waiting_for_approval" ? state : "running";
}

async function lastAssistantMessage(services: AidenMcpServices, chatId: string) {
  const window = await services.chats.messagesWindow(chatId, { limit: 5 });
  const message = [...window.messages].reverse().find((candidate) => candidate.role === "assistant");
  return message ? projectMessage(message) : undefined;
}

function projectMessage(message: AidenRemoteMessageProjection) {
  const text = [...message.text];
  return {
    id: message.id,
    role: message.role,
    text: text.length > MESSAGE_TEXT_LIMIT ? text.slice(0, MESSAGE_TEXT_LIMIT).join("") : message.text,
    ...(text.length > MESSAGE_TEXT_LIMIT ? { truncated: true } : {}),
    createdAt: message.createdAt,
    ...(message.outcome ? { outcome: message.outcome.status } : {}),
  };
}

function toolResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
