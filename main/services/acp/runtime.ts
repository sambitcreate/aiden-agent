/**
 * Harness-agnostic ACP session runtime behind a Pi provider.
 *
 * Adapted from pi-antigravity-acp-provider src/runtime.ts @ 07e369b (MIT)
 * with session and cancellation behaviour from T3 Code
 * apps/server/src/provider/acp/AcpSessionRuntime.ts @ f870c419fc (MIT).
 *
 * One ACP session serves one Aiden chat. A turn may span several Pi stream
 * calls: when the agent calls one of Aiden's bridged tools the stream ends
 * with `toolUse`, Aiden's agent loop runs the tool (approvals included), and
 * the next stream call resumes the same in-flight ACP prompt. Native agent
 * tools never become Pi tool calls; they are reported as timeline activity.
 */
import type {
  InitializeResponse,
  McpServer,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  Api,
  Message,
  Model,
  SimpleStreamOptions,
  ToolResultMessage,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { AcpToolCallTracker, timelineStepFor, type AcpToolActivity } from "./activity.js";
import { readClientTextFile, writeClientTextFile } from "./client-files.js";
import { AcpConnection } from "./connection.js";
import { AcpHarnessError, abortError, isAbortError } from "./errors.js";
import type { AcpHarnessDefinition, AcpLaunchPurpose, AcpModelProjection } from "./harness.js";
import type { AcpHostRegistry, AcpTurnHost } from "./host.js";
import { AcpMcpBridge, type BridgeInvocation } from "./mcp-bridge.js";
import { answerPermission } from "./permissions.js";
import { PiEventWriter } from "./pi-events.js";
import type { AcpProcess } from "./process.js";
import {
  buildFollowUpPrompt,
  buildPrompt,
  conversationMessages,
  hostInstructionsFor,
  messageFingerprint,
  messagesFingerprint,
} from "./prompt.js";
import type { AcpSessionStore } from "./session-store.js";
import { usageFromPrompt } from "./usage.js";

export interface AcpLaunchedProcess {
  process: AcpProcess;
  /** Close the process and release its runtime lease and temporary files. */
  dispose(): Promise<void>;
}

export interface AcpProcessLauncher {
  launch(
    purpose: AcpLaunchPurpose,
    cwd: string,
    observers?: { onStderrLine?(line: string): void },
  ): Promise<AcpLaunchedProcess>;
}

export interface AcpRuntimeOptions {
  /** Live sessions kept warm; idle ones beyond this are closed first. */
  maxLiveSessions?: number;
  idleTimeoutMs?: number;
  /** How long a cancelled turn may take to settle before its process is killed. */
  cancelGraceMs?: number;
  /** A bridged tool result must come back within this window. */
  toolTimeoutMs?: number;
}

interface PendingTool {
  invocation: BridgeInvocation;
  /** Whether the call has been shown to Pi as a tool call yet. */
  announced: boolean;
  resolve(result: CallToolResult): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Turn {
  completion: Promise<void>;
  controller: AbortController;
  abortRequested: boolean;
  failed?: boolean;
  /** Messages sent mid-turn that the agent must answer before the turn ends. */
  followUp: { context: TranscriptContext; boundary: number; count: number; fingerprint: string } | undefined;
  /** Absolute paths the user approved writing to during this turn (Ask mode). */
  writeGrants: Set<string>;
  /** Approved edits whose request named no path; each allows one write. */
  unscopedWriteGrants: number;
}

interface Binding {
  chatId: string;
  cwd: string;
  launched: AcpLaunchedProcess;
  connection: AcpConnection;
  initialize: InitializeResponse;
  sessionId: string;
  configOptions: SessionConfigOption[];
  modes: SessionModeState | undefined;
  currentMode: string | undefined;
  currentModel: string | undefined;
  messageCount: number;
  historyFingerprint: string;
  expectedAssistantFingerprint: string | undefined;
  pendingContextCount: number;
  pendingContextFingerprint: string;
  writer: PiEventWriter | undefined;
  /** The most recent stream of this turn, kept after it ends with toolUse. */
  lastWriter: PiEventWriter | undefined;
  host: AcpTurnHost | undefined;
  buffered: Array<{ kind: "text" | "thinking"; delta: string }>;
  pendingTools: Map<string, PendingTool>;
  toolBatchTimer: ReturnType<typeof setTimeout> | undefined;
  bridge: AcpMcpBridge | undefined;
  tracker: AcpToolCallTracker;
  startedActivities: Set<string>;
  lastPlan: string | undefined;
  queue: Promise<void>;
  turn: Turn | undefined;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  restored: boolean;
  closed: boolean;
  /** "Always allow" granted for edits in this session (Ask mode). */
  sessionWriteGrant: boolean;
}

export interface AcpRuntimeSnapshot {
  sessions: Array<{
    chatId: string;
    pid: number | undefined;
    alive: boolean;
    busy: boolean;
    restored: boolean;
    agentVersion: string | undefined;
    pendingTools: number;
  }>;
}

const DEFAULTS = {
  maxLiveSessions: 2,
  idleTimeoutMs: 10 * 60_000,
  cancelGraceMs: 15_000,
  toolTimeoutMs: 10 * 60_000,
} as const;
const TOOL_BATCH_MS = 100;

export class AcpHarnessRuntime {
  private readonly bindings = new Map<string, Promise<Binding>>();
  private readonly live = new Set<Binding>();
  private readonly options: Required<AcpRuntimeOptions>;
  private disposed = false;
  /** Closed while signing out: no chat or catalog process may start. */
  private admissionClosed = false;
  /**
   * Every launch from the moment it is admitted until its process is fully
   * disposed, so sign-out can drain launches that were still starting.
   */
  private readonly inflight = new Set<{ launched?: AcpLaunchedProcess; done: Promise<void> }>();

  /** Run `use` against a tracked launch; the record outlives disposal. */
  private async tracked<T>(
    launch: () => Promise<AcpLaunchedProcess>,
    use: (launched: AcpLaunchedProcess) => Promise<T>,
    disposeAfter: boolean,
  ): Promise<T> {
    let finish!: () => void;
    const record: { launched?: AcpLaunchedProcess; done: Promise<void> } = {
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.inflight.add(record);
    let launched: AcpLaunchedProcess | undefined;
    try {
      launched = await launch();
      record.launched = launched;
      // Admission may have closed while the process was starting.
      if (this.admissionClosed || this.disposed) {
        await launched.dispose();
        this.assertActive();
      }
      return await use(launched);
    } catch (error) {
      if (launched && !disposeAfter) await launched.dispose();
      throw error;
    } finally {
      if (launched && disposeAfter) await launched.dispose();
      this.inflight.delete(record);
      finish();
    }
  }
  /** Called when a chat discovers the saved sign-in stopped working. */
  onSignInLost: (() => void) | undefined;

  constructor(
    private readonly definition: AcpHarnessDefinition,
    private readonly launcher: AcpProcessLauncher,
    private readonly hosts: AcpHostRegistry,
    private readonly sessions: AcpSessionStore,
    options: AcpRuntimeOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  stream(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}) {
    const writer = new PiEventWriter(model);
    void this.run(model, context, options, writer).catch((error: unknown) => {
      writer.fail(error, options.signal?.aborted === true || isAbortError(error));
    });
    return writer.stream;
  }

  /** Authenticated catalog discovery in a throwaway session. */
  async discoverModels(cwd: string, signal?: AbortSignal): Promise<AcpModelProjection> {
    return this.withProcess("catalog", cwd, signal, async (connection) => {
      await connection.initialize(signal);
      const session = await connection.newSession(cwd, [], signal);
      return this.definition.projectModels(session.configOptions ?? []);
    });
  }

  /** Run `operation` against a short-lived process that is always disposed. */
  async withProcess<T>(
    purpose: AcpLaunchPurpose,
    cwd: string,
    signal: AbortSignal | undefined,
    operation: (connection: AcpConnection) => Promise<T>,
  ): Promise<T> {
    this.assertActive();
    if (signal?.aborted) throw abortError();
    return this.tracked(
      () => this.launcher.launch(purpose, cwd),
      (launched) => operation(new AcpConnection(launched.process, undefined, { fileSystem: false })),
      true,
    );
  }

  /** Close every session and forget saved bindings (used by sign-out). */
  async reset(): Promise<void> {
    await this.closeAll();
    this.sessions.clear();
  }

  /**
   * An authentication boundary: refuse new launches, then stop every running
   * agent process (chat sessions and short-lived catalog runs) and forget
   * saved sessions. Returns a function that reopens admission.
   */
  async closeAdmission(): Promise<() => void> {
    this.admissionClosed = true;
    await this.closeAll();
    const pending = [...this.inflight];
    await Promise.allSettled(pending.map((record) => record.launched?.dispose()));
    // Launches still starting dispose themselves on admission; wait for all.
    await Promise.allSettled(pending.map((record) => record.done));
    await this.closeAll();
    this.sessions.clear();
    return () => {
      this.admissionClosed = false;
    };
  }

  /** Close every session but stay usable; saved bindings are kept for resume. */
  async closeSessions(): Promise<void> {
    await this.closeAll();
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.closeAll();
  }

  get busy(): boolean {
    return [...this.live].some((binding) => binding.turn !== undefined);
  }

  get liveCount(): number {
    return this.live.size;
  }

  snapshot(): AcpRuntimeSnapshot {
    return {
      sessions: [...this.live].map((binding) => ({
        chatId: binding.chatId,
        pid: binding.launched.process.pid,
        alive: binding.launched.process.alive,
        busy: binding.turn !== undefined,
        restored: binding.restored,
        agentVersion: binding.initialize.agentInfo?.version ?? undefined,
        pendingTools: binding.pendingTools.size,
      })),
    };
  }

  private async run(
    model: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions,
    writer: PiEventWriter,
  ): Promise<void> {
    this.assertActive();
    const host = this.hosts.get(options.sessionId);
    if (!host) {
      throw new AcpHarnessError(
        "unavailable",
        `${this.definition.label} works only in ordinary desktop chats, not here. Choose another model for this conversation.`,
      );
    }
    const signal = options.signal;
    if (signal?.aborted) throw abortError();
    let binding = await this.bindingFor(host, signal);

    if (binding.pendingTools.size > 0) {
      if (await this.continueTurn(binding, host, context, writer, signal)) return;
      binding = await this.bindingFor(host, signal);
    }

    const previous = binding.queue;
    let release!: () => void;
    binding.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    if (binding.closed) {
      // The session closed while this turn waited its turn; start over.
      release();
      return this.run(model, context, options, writer);
    }
    let completeTurn: (() => void) | undefined;
    let turn: Turn | undefined;
    try {
      const conversation = conversationMessages(context);
      if (
        conversation.length < binding.messageCount ||
        messagesFingerprint(conversation.slice(0, binding.messageCount)) !== binding.historyFingerprint
      ) {
        // Rewind, edit, fork or compaction: ACP history cannot be edited, so
        // start a fresh session that receives a bounded reconstruction.
        this.sessions.remove(binding.chatId);
        release();
        await this.drop(binding, false);
        return this.run(model, context, options, writer);
      }
      clearTimeout(binding.idleTimer);
      binding.bridge?.setTools(host.bridgeableTools(getCurrentTools(context.messages)));
      await this.syncMode(binding, host, signal);
      await this.syncModel(binding, model, options, signal);

      const fresh = binding.messageCount === 0;
      let unseenStart = binding.messageCount;
      const expected = conversation[unseenStart];
      if (
        !fresh &&
        expected?.role === "assistant" &&
        binding.expectedAssistantFingerprint === messageFingerprint(expected)
      ) {
        unseenStart += 1;
      }
      const capabilities = binding.initialize.agentCapabilities?.promptCapabilities;
      const instructions = [this.definition.hostInstructionsPreamble, hostInstructionsFor(context)]
        .filter((part): part is string => !!part?.trim())
        .join("\n\n");
      const built = buildPrompt({
        context,
        fresh,
        unseenStart,
        hostInstructions: instructions,
        capabilities: {
          image: capabilities?.image === true,
          embeddedContext: capabilities?.embeddedContext === true,
        },
      });
      if (built.reconstructed && conversation.length > 1) {
        host.notice?.(`${this.definition.label} started a fresh session with a summary of earlier messages.`);
      }
      turn = {
        completion: new Promise<void>((resolve) => {
          completeTurn = resolve;
        }),
        controller: new AbortController(),
        abortRequested: false,
        followUp: undefined,
        writeGrants: new Set(),
        unscopedWriteGrants: 0,
      };
      binding.turn = turn;
      // Text the previous turn produced after its last stream ended is shown
      // first, instead of being dropped.
      binding.tracker.clear();
      binding.startedActivities.clear();
      binding.lastPlan = undefined;
      this.attachWriter(binding, writer, host, conversation);
      this.linkAbort(binding, turn, signal);

      let response = await binding.connection.prompt({ sessionId: binding.sessionId, prompt: built.prompt });
      while (turn.followUp && !turn.abortRequested && response.stopReason === "end_turn") {
        const follow: NonNullable<Turn["followUp"]> = turn.followUp;
        turn.followUp = undefined;
        const next = buildFollowUpPrompt(follow.context, follow.boundary, {
          image: capabilities?.image === true,
          embeddedContext: capabilities?.embeddedContext === true,
        });
        binding.pendingContextCount = follow.count;
        binding.pendingContextFingerprint = follow.fingerprint;
        if (next.length === 0) continue;
        const followed = await binding.connection.prompt({ sessionId: binding.sessionId, prompt: next });
        response = { ...followed, usage: addUsage(response.usage, followed.usage) };
      }
      // With no stream attached (the last one ended with toolUse), the reply
      // belongs to the last stream Pi recorded; never touch a delivered message.
      const active = binding.writer ?? binding.lastWriter ?? writer;
      this.flushBuffered(binding);
      // The agent saw this turn's input whether it finished or was stopped.
      if (!active.finished) {
        active.message.usage = usageFromPrompt(response as PromptResponse);
        active.message.rawStopReason = response.stopReason;
      }
      binding.messageCount = binding.pendingContextCount || built.messageCount;
      binding.historyFingerprint = binding.pendingContextFingerprint;
      binding.expectedAssistantFingerprint = messageFingerprint(active.message as Message);
      this.persist(binding);
      if (turn.abortRequested || response.stopReason === "cancelled") {
        active.fail(abortError(), true);
      } else if (response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests") {
        active.done("length");
      } else if (response.stopReason === "refusal") {
        turn.failed = true;
        active.fail(new AcpHarnessError("protocol", `${this.definition.label} declined this request.`));
      } else {
        active.done("stop");
      }
    } catch (error) {
      binding.writer?.fail(error, isAbortError(error) || signal?.aborted === true);
      if (turn) turn.failed = true;
      if (!binding.launched.process.alive) await this.drop(binding, false);
      throw error;
    } finally {
      // Only a turn that ended cleanly while no stream was attached carries its
      // last words into the next reply; a stopped or failed turn's leftovers
      // must not surface later.
      if (!turn || turn.abortRequested || turn.failed) binding.buffered = [];
      // Calls the agent abandoned must not keep a later stream waiting.
      cancelTools(binding, "The agent's turn ended before the tool finished.");
      completeTurn?.();
      if (binding.turn === turn) binding.turn = undefined;
      binding.writer = undefined;
      binding.lastWriter = undefined;
      binding.host = undefined;
      release();
      this.scheduleIdle(binding);
    }
  }

  /**
   * Resume an in-flight ACP prompt with the results of bridged tools. Returns
   * false when this stream call is not a continuation (the turn already ended,
   * or Pi stopped without returning a result); pending calls are then
   * resolved as failed so the agent's turn can settle, and the caller runs a
   * normal turn.
   */
  private async continueTurn(
    binding: Binding,
    host: AcpTurnHost,
    context: TranscriptContext,
    writer: PiEventWriter,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const turn = binding.turn;
    const conversation = conversationMessages(context);
    const announced = [...binding.pendingTools.values()].filter((pending) => pending.announced);
    const results = announced.map((pending) => ({
      pending,
      index: findToolResultIndex(conversation, pending.invocation.id, pending.invocation.name),
    }));
    if (!turn || results.length === 0 || results.some((result) => result.index < 0)) {
      cancelTools(binding, "The tool result never came back.");
      if (turn) {
        this.requestCancel(binding, turn);
        if (!(await settlesWithin(turn.completion, this.options.cancelGraceMs))) await this.drop(binding, false);
      }
      return false;
    }
    // Messages after the last tool result (for example, a message the user
    // sent mid-turn) are sent as a follow-up prompt once the agent finishes
    // the current one, so they are answered within this same turn.
    const boundary = Math.max(...results.map((result) => result.index)) + 1;
    // A message sent mid-turn stays owed until the follow-up prompt sends it,
    // even if the agent makes further tool calls first. Keep the earliest
    // unanswered position and refresh everything else to the latest view.
    const owedFrom = turn.followUp?.boundary ??
      (conversation.slice(boundary).some((message) => message.role === "user") ? boundary : undefined);
    if (owedFrom !== undefined) {
      turn.followUp = {
        context,
        boundary: owedFrom,
        count: conversation.length,
        fingerprint: messagesFingerprint(conversation),
      };
    }
    // While a message is owed, nothing from it onward counts as seen.
    this.attachWriter(binding, writer, host, conversation.slice(0, turn.followUp?.boundary ?? boundary));
    this.linkAbort(binding, turn, signal);
    // Tools discovered mid-turn (tool_search) become callable right away.
    binding.bridge?.setTools(host.bridgeableTools(getCurrentTools(context.messages)));
    try {
      await this.syncMode(binding, host, signal);
    } catch (error) {
      // Never resume a turn in a native mode broader than the folder now allows.
      writer.fail(error);
      cancelTools(binding, "The folder's permission changed.");
      this.requestCancel(binding, turn);
      return true;
    }
    for (const { pending, index } of results) {
      clearTimeout(pending.timer);
      binding.pendingTools.delete(pending.invocation.id);
      pending.resolve(toMcpResult(conversation[index] as ToolResultMessage));
    }
    // Calls that arrived while no stream was attached are announced now.
    this.announcePending(binding);
    await Promise.race([turn.completion, writer.stream.result().then(() => undefined)]);
    return true;
  }

  private attachWriter(binding: Binding, writer: PiEventWriter, host: AcpTurnHost, seen: readonly Message[]): void {
    binding.writer = writer;
    binding.lastWriter = writer;
    binding.host = host;
    binding.lastUsed = Date.now();
    binding.pendingContextCount = seen.length;
    binding.pendingContextFingerprint = messagesFingerprint(seen);
    this.flushBuffered(binding);
  }

  private requestCancel(binding: Binding, turn: Turn): void {
    if (turn.abortRequested) return;
    turn.abortRequested = true;
    turn.controller.abort();
    void binding.connection.cancel(binding.sessionId);
    // A clean cancel keeps the session; only an agent that will not settle is killed.
    const timer = setTimeout(() => {
      if (binding.turn === turn) void this.drop(binding, false);
    }, this.options.cancelGraceMs);
    timer.unref?.();
    void turn.completion.then(() => clearTimeout(timer));
  }

  private linkAbort(binding: Binding, turn: Turn, signal: AbortSignal | undefined): void {
    if (!signal) return;
    const abort = () => this.requestCancel(binding, turn);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void turn.completion.then(() => signal.removeEventListener("abort", abort));
  }

  private async bindingFor(
    host: AcpTurnHost,
    signal: AbortSignal | undefined,
    options: { fresh?: boolean } = {},
  ): Promise<Binding> {
    this.assertActive();
    const existing = this.bindings.get(host.chatId);
    if (existing) {
      const binding = await existing.catch(() => undefined);
      if (binding && !binding.closed && binding.launched.process.alive && binding.cwd === host.cwd) {
        return binding;
      }
      if (binding) await this.drop(binding, false);
      if (this.bindings.get(host.chatId) === existing) this.bindings.delete(host.chatId);
    }
    await this.makeRoom();
    const created = this.create(host, signal, options.fresh === true).catch((error: unknown) => {
      if (this.bindings.get(host.chatId) === created) this.bindings.delete(host.chatId);
      throw error;
    });
    this.bindings.set(host.chatId, created);
    return created;
  }

  private async makeRoom(): Promise<void> {
    while (this.live.size >= this.options.maxLiveSessions) {
      // Re-evaluate each time: a session may have started a turn meanwhile.
      const oldest = [...this.live]
        .filter((binding) => !binding.turn && binding.pendingTools.size === 0)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!oldest) return;
      await this.drop(oldest, true);
    }
  }

  private async create(host: AcpTurnHost, signal: AbortSignal | undefined, fresh: boolean): Promise<Binding> {
    let binding: Binding | undefined;
    let signInLost = false;
    let pendingLaunch: AcpLaunchedProcess | undefined;
    const observers = {
      onStderrLine: (line: string) => {
        if (signInLost || !this.definition.detectSignInPrompt?.(line)) return;
        // The agent is waiting for an interactive sign-in nobody will finish.
        signInLost = true;
        this.onSignInLost?.();
        if (binding) {
          binding.writer?.fail(this.signInError());
          void this.drop(binding, true);
        } else {
          void pendingLaunch?.dispose();
        }
      },
    };
    // The binding owns the process after this; tracking covers its start.
    const launched = await this.tracked(
      () => this.launcher.launch("chat", host.cwd, observers),
      async (value) => value,
      false,
    );
    pendingLaunch = launched;
    const connection = new AcpConnection(
      launched.process,
      {
        onUpdate: (notification) => this.onUpdate(binding, notification),
        onPermission: (request) => this.onPermission(binding, request),
        readTextFile: async (request) => {
          // Like writes, reads need a running turn: an idle agent between
          // turns gets no access to the chat's files.
          const current = binding?.host;
          if (!binding?.turn || !current) throw new AcpHarnessError("unavailable", "No response is running.");
          return readClientTextFile(request, {
            roots: current.roots,
            canWrite: () => false,
          });
        },
        writeTextFile: async (request) => {
          const current = binding?.host;
          const turn = binding?.turn;
          if (!binding || !current || !turn) throw new AcpHarnessError("unavailable", "No response is running.");
          // Evaluate once: a one-time grant must not be consumed by the recheck.
          const allowed = writeAllowed(binding, turn, current, request.path);
          return writeClientTextFile(request, {
            roots: current.roots,
            canWrite: () => allowed && (current.permission() === "full" || current.permission() === "ask"),
            onWrite: (file, before, after) => current.onFileWrite?.(file, before, after),
          });
        },
      },
      { fileSystem: this.definition.fileSystem },
    );
    let bridge: AcpMcpBridge | undefined;
    try {
      const initialize = await connection.initialize(signal);
      const reason = this.definition.validateInitialize(initialize, this.definition.release.version);
      if (reason) throw new AcpHarnessError("unavailable", reason);
      const mcpServers: McpServer[] = [];
      if (initialize.agentCapabilities?.mcpCapabilities?.http === true) {
        bridge = new AcpMcpBridge({
          tools: host.bridgeableTools([]),
          onCall: (invocation) => this.onBridgeCall(binding, invocation),
        });
        mcpServers.push(await bridge.start());
      }
      const saved = fresh ? undefined : this.sessions.get(host.chatId);
      let sessionId: string | undefined;
      let configOptions: SessionConfigOption[] = [];
      let modes: SessionModeState | undefined;
      let restored = false;
      if (saved && saved.cwd === host.cwd && initialize.agentCapabilities?.sessionCapabilities?.resume) {
        try {
          const resumed = await connection.resumeSession(saved.sessionId, host.cwd, mcpServers, signal);
          sessionId = saved.sessionId;
          configOptions = resumed.configOptions ?? [];
          modes = resumed.modes ?? undefined;
          restored = true;
        } catch (error) {
          if (isAbortError(error)) throw error;
          this.sessions.remove(host.chatId);
        }
      }
      if (!sessionId) {
        const created = await connection.newSession(host.cwd, mcpServers, signal);
        sessionId = created.sessionId;
        configOptions = created.configOptions ?? [];
        modes = created.modes ?? undefined;
      }
      binding = {
        chatId: host.chatId,
        cwd: host.cwd,
        launched,
        connection,
        initialize,
        sessionId,
        configOptions,
        modes,
        currentMode: modes?.currentModeId ?? currentConfigValue(configOptions, "mode"),
        currentModel: currentConfigValue(configOptions, "model"),
        messageCount: restored && saved ? saved.messageCount : 0,
        historyFingerprint: restored && saved ? saved.historyFingerprint : messagesFingerprint([]),
        expectedAssistantFingerprint: restored ? saved?.expectedAssistantFingerprint : undefined,
        pendingContextCount: 0,
        pendingContextFingerprint: messagesFingerprint([]),
        writer: undefined,
        lastWriter: undefined,
        host: undefined,
        buffered: [],
        pendingTools: new Map(),
        toolBatchTimer: undefined,
        bridge,
        tracker: new AcpToolCallTracker(),
        startedActivities: new Set(),
        lastPlan: undefined,
        queue: Promise.resolve(),
        turn: undefined,
        lastUsed: Date.now(),
        idleTimer: undefined,
        restored,
        closed: false,
        sessionWriteGrant: false,
      };
      const created = binding;
      this.live.add(created);
      void launched.process.exited.then(() => {
        if (!created.closed) void this.drop(created, false);
      });
      return created;
    } catch (error) {
      await Promise.allSettled([bridge?.close() ?? Promise.resolve(), launched.dispose()]);
      throw signInLost ? this.signInError() : error;
    }
  }

  private async syncMode(binding: Binding, host: AcpTurnHost, signal?: AbortSignal): Promise<void> {
    const desired = this.definition.nativeModeFor(host.permission());
    if (!desired || desired === binding.currentMode) return;
    const option = binding.configOptions.find(
      (candidate) => candidate.category === "mode" && candidate.type === "select",
    );
    if (option && selectValues(option).includes(desired)) {
      await binding.connection.setConfigOption(binding.sessionId, option.id, desired, signal);
    } else if (binding.modes?.availableModes.some((mode) => mode.id === desired)) {
      await binding.connection.setMode(binding.sessionId, desired, signal);
    } else {
      // The agent cannot express this permission. Never run with a broader
      // native mode than Aiden granted: refusals in onPermission still apply,
      // but a mode we cannot set must not silently default to auto-approve.
      if (host.permission() !== "full" && binding.currentMode === this.definition.nativeModeFor("full")) {
        throw new AcpHarnessError("unavailable", `${this.definition.label} could not switch to an approval mode.`);
      }
      return;
    }
    binding.currentMode = desired;
  }

  private async syncModel(
    binding: Binding,
    model: Model<Api>,
    options: SimpleStreamOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const desired = this.definition.nativeModelId(model, options.reasoning);
    if (!desired || desired === binding.currentModel) return;
    const option = binding.configOptions.find(
      (candidate) => (candidate.category === "model" || candidate.id === "model") && candidate.type === "select",
    );
    if (!option) {
      throw new AcpHarnessError("unavailable", `${this.definition.label} did not offer a model choice.`);
    }
    if (!selectValues(option).includes(desired)) {
      throw new AcpHarnessError(
        "unavailable",
        `${model.name} is not available for this ${this.definition.label} account. Choose another model.`,
      );
    }
    await binding.connection.setConfigOption(binding.sessionId, option.id, desired, signal);
    binding.currentModel = desired;
  }

  private onUpdate(binding: Binding | undefined, notification: SessionNotification): void {
    if (!binding || notification.sessionId !== binding.sessionId) return;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") this.emit(binding, "text", update.content.text);
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") this.emit(binding, "thinking", update.content.text);
        return;
      case "tool_call":
      case "tool_call_update": {
        const activity = binding.tracker.apply(update);
        if (this.definition.isSubagentCall?.(update)) binding.tracker.mark(activity.id, { subagent: true });
        this.reportActivity(binding, binding.tracker.get(activity.id) ?? activity);
        return;
      }
      case "plan": {
        const text = update.entries
          .map((entry) => `- [${entry.status === "completed" ? "x" : " "}] ${entry.content.replace(/\s+/gu, " ").slice(0, 300)}`)
          .join("\n");
        if (text && text !== binding.lastPlan) {
          binding.lastPlan = text;
          this.emit(binding, "thinking", `\n\nPlan:\n${text}\n`);
        }
        return;
      }
      case "config_option_update":
        binding.configOptions = update.configOptions;
        binding.currentMode = currentConfigValue(update.configOptions, "mode") ?? binding.currentMode;
        binding.currentModel = currentConfigValue(update.configOptions, "model") ?? binding.currentModel;
        return;
      case "current_mode_update":
        binding.currentMode = update.currentModeId;
        return;
      default:
        return;
    }
  }

  private emit(binding: Binding, kind: "text" | "thinking", delta: string): void {
    if (!delta) return;
    const writer = binding.writer;
    if (!writer || writer.finished) {
      if (binding.turn) binding.buffered.push({ kind, delta });
      return;
    }
    if (kind === "text") writer.text(delta);
    else writer.thinking(delta);
  }

  private flushBuffered(binding: Binding): void {
    const writer = binding.writer;
    if (!writer || writer.finished || binding.buffered.length === 0) return;
    const pending = binding.buffered.splice(0);
    for (const item of pending) {
      if (item.kind === "text") writer.text(item.delta);
      else writer.thinking(item.delta);
    }
  }

  private reportActivity(binding: Binding, activity: AcpToolActivity): void {
    const host = binding.host;
    if (!host || activity.mcp) return;
    const id = `acp:${binding.sessionId}:${activity.id}`;
    const step = timelineStepFor(activity, host.roots);
    if (!step) return;
    if (!binding.startedActivities.has(id)) {
      binding.startedActivities.add(id);
      host.activity.started(id, step.toolName, step.args);
    }
    if (activity.status === "running") host.activity.running(id);
    else if (activity.status === "completed") {
      host.activity.finished(
        id,
        "completed",
        activity.lineChanges ? { kind: "file_line_changes", version: 1, ...activity.lineChanges } : undefined,
      );
    } else if (activity.status === "failed") host.activity.finished(id, "failed");
  }

  private async onPermission(
    binding: Binding | undefined,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const host = binding?.host;
    if (!binding || !host || !binding.turn || request.sessionId !== binding.sessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const classification = this.definition.classifyPermission?.(request) ?? { kind: "approval" as const };
    const activity = binding.tracker.apply(request.toolCall);
    const id = `acp:${binding.sessionId}:${activity.id}`;
    const step = classification.kind === "approval" ? timelineStepFor(activity, host.roots) : undefined;
    if (step && !binding.startedActivities.has(id)) {
      binding.startedActivities.add(id);
      host.activity.started(id, step.toolName, step.args);
    }
    const turn = binding.turn;
    const response = await answerPermission(request, classification, host, turn.controller.signal, step ? id : undefined);
    const chosen =
      response.outcome.outcome === "selected"
        ? request.options.find((candidate) => candidate.optionId === (response.outcome as { optionId: string }).optionId)
        : undefined;
    if (chosen?.kind.startsWith("allow") && classification.kind === "approval" && isMutation(request.toolCall.kind)) {
      if (chosen.kind === "allow_always") binding.sessionWriteGrant = true;
      const paths = (request.toolCall.locations ?? []).map((location) => path.resolve(location.path));
      // Only a path-less edit may write an unnamed file; deletes and moves never do.
      if (paths.length === 0 && request.toolCall.kind === "edit") turn.unscopedWriteGrants += 1;
      for (const target of paths) turn.writeGrants.add(target);
    }
    if (step && (!chosen || chosen.kind.startsWith("reject"))) {
      host.activity.finished(id, chosen ? "blocked" : "cancelled");
    }
    return response;
  }

  private onBridgeCall(binding: Binding | undefined, invocation: BridgeInvocation): Promise<CallToolResult> {
    if (!binding?.turn || binding.turn.abortRequested) {
      return Promise.resolve(toolError("Aiden cannot run this tool right now."));
    }
    return new Promise<CallToolResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!binding.pendingTools.delete(invocation.id)) return;
        resolve(toolError("The tool did not finish in time."));
        // The Aiden tool may still finish later. End the agent's turn now so
        // that late result starts a clean prompt instead of resuming a turn
        // that already moved on without it.
        if (binding.turn) this.requestCancel(binding, binding.turn);
      }, this.options.toolTimeoutMs);
      timer.unref?.();
      binding.pendingTools.set(invocation.id, { invocation, announced: false, resolve, timer });
      this.announcePending(binding);
    });
  }

  /**
   * Show parked calls to Pi on the attached stream, then end that stream with
   * `toolUse` once a short batch window passes. A call that arrives while no
   * stream is attached waits for the next one.
   */
  private announcePending(binding: Binding): void {
    const writer = binding.writer;
    if (!writer || writer.finished) return;
    let announced = false;
    for (const pending of binding.pendingTools.values()) {
      if (pending.announced) continue;
      pending.announced = true;
      announced = true;
      writer.toolCall(pending.invocation.id, pending.invocation.name, pending.invocation.arguments);
    }
    if (!announced) return;
    if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
    binding.toolBatchTimer = setTimeout(() => {
      binding.toolBatchTimer = undefined;
      if (binding.writer === writer) {
        writer.done("toolUse");
        binding.writer = undefined;
      }
    }, TOOL_BATCH_MS);
    binding.toolBatchTimer.unref?.();
  }

  private persist(binding: Binding): void {
    this.sessions.save({
      chatId: binding.chatId,
      sessionId: binding.sessionId,
      cwd: binding.cwd,
      messageCount: binding.messageCount,
      historyFingerprint: binding.historyFingerprint,
      ...(binding.expectedAssistantFingerprint
        ? { expectedAssistantFingerprint: binding.expectedAssistantFingerprint }
        : {}),
    });
  }

  private scheduleIdle(binding: Binding): void {
    if (binding.closed) return;
    clearTimeout(binding.idleTimer);
    binding.idleTimer = setTimeout(() => {
      if (!binding.turn && binding.pendingTools.size === 0) void this.drop(binding, true);
    }, this.options.idleTimeoutMs);
    binding.idleTimer.unref?.();
  }

  /** Close one session. `keepRecord` keeps its saved binding for a later resume. */
  private async drop(binding: Binding, keepRecord: boolean): Promise<void> {
    if (binding.closed) return;
    binding.closed = true;
    clearTimeout(binding.idleTimer);
    this.live.delete(binding);
    const current = this.bindings.get(binding.chatId);
    if (current) {
      const value = await current.catch(() => undefined);
      if (value === binding && this.bindings.get(binding.chatId) === current) this.bindings.delete(binding.chatId);
    }
    if (!keepRecord) {
      // A session that died mid-turn may have state we never committed.
      if (binding.turn) this.sessions.remove(binding.chatId);
    }
    cancelTools(binding, "The agent session closed.");
    binding.buffered = [];
    binding.turn?.controller.abort();
    await Promise.allSettled([binding.bridge?.close() ?? Promise.resolve(), binding.launched.dispose()]);
  }

  private async closeAll(): Promise<void> {
    const pending = [...this.bindings.values()];
    this.bindings.clear();
    const resolved = await Promise.all(pending.map((value) => value.catch(() => undefined)));
    await Promise.allSettled(
      [...new Set([...this.live, ...resolved.filter((value): value is Binding => !!value)])].map((binding) =>
        this.drop(binding, true),
      ),
    );
  }

  private signInError(): AcpHarnessError {
    return new AcpHarnessError(
      "auth",
      `Your ${this.definition.label} sign-in expired. Sign in again in Settings → Providers.`,
    );
  }

  private assertActive(): void {
    if (this.disposed) throw new AcpHarnessError("unavailable", `${this.definition.label} is shutting down.`);
    if (this.admissionClosed) throw new AcpHarnessError("unavailable", `${this.definition.label} is signing out.`);
  }
}

function addUsage(
  left: PromptResponse["usage"],
  right: PromptResponse["usage"],
): PromptResponse["usage"] {
  if (!left) return right;
  if (!right) return left;
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    thoughtTokens: (left.thoughtTokens ?? 0) + (right.thoughtTokens ?? 0),
    cachedReadTokens: (left.cachedReadTokens ?? 0) + (right.cachedReadTokens ?? 0),
    cachedWriteTokens: (left.cachedWriteTokens ?? 0) + (right.cachedWriteTokens ?? 0),
  };
}

function isMutation(kind: string | null | undefined): boolean {
  return kind === "edit" || kind === "delete" || kind === "move";
}

/**
 * Full permits any write inside the roots. Ask permits only writes the user
 * approved this turn (or "always" for the session). Read-only and no-access
 * permit none, whatever the agent's native mode allows.
 */
function writeAllowed(binding: Binding, turn: Turn, host: AcpTurnHost, requested: string): boolean {
  const permission = host.permission();
  if (permission === "full") return true;
  if (permission !== "ask") return false;
  if (binding.sessionWriteGrant) return true;
  // An "allow once" covers one write to that path.
  if (turn.writeGrants.delete(path.resolve(requested))) return true;
  if (turn.unscopedWriteGrants > 0) {
    turn.unscopedWriteGrants -= 1;
    return true;
  }
  return false;
}

function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== "select") return [];
  const output: string[] = [];
  for (const entry of option.options) {
    if ("value" in entry) output.push(entry.value);
    else for (const nested of entry.options) output.push(nested.value);
  }
  return output;
}

function currentConfigValue(options: readonly SessionConfigOption[], category: string): string | undefined {
  const option = options.find(
    (candidate) => (candidate.category === category || candidate.id === category) && candidate.type === "select",
  );
  return option && option.type === "select" ? option.currentValue : undefined;
}

function findToolResultIndex(messages: readonly Message[], id: string, name: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "toolResult" && message.toolCallId === id && message.toolName === name) return index;
  }
  return -1;
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function toMcpResult(message: ToolResultMessage): CallToolResult {
  return {
    content: message.content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : { type: "image" as const, data: block.data, mimeType: block.mimeType },
    ),
    isError: message.isError,
  };
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function cancelTools(binding: Binding, reason: string): void {
  if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
  binding.toolBatchTimer = undefined;
  for (const pending of binding.pendingTools.values()) {
    clearTimeout(pending.timer);
    pending.resolve(toolError(reason));
  }
  binding.pendingTools.clear();
}
