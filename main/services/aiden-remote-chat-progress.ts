import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { TodoSnapshotViewV1 } from "../../renderer/shared/todo.js";
import {
  parseSubagentRunSnapshot,
  type SubagentRunSnapshot,
} from "../../renderer/shared/subagent-runs.js";
import { sanitizeSubagentSnapshotText } from "../../renderer/shared/subagent-safe-text.js";
import { boundedUnicodePrefix } from "../../renderer/shared/unicode-prefix.js";
import { ChatProgressEvents } from "./chat-progress-events.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { openCursorSse, sseFrame, type CursorSseHandle, type CursorSsePull } from "./aiden-remote-sse.js";
import {
  parseAidenRemoteChatTaskProgress,
  parseAidenRemoteChatAgentRoster,
  AIDEN_REMOTE_CHAT_AGENT_TERMINAL_STATES,
  AIDEN_REMOTE_SSE_HEARTBEAT_MS,
  type AidenRemoteCapability,
  type AidenRemoteChatTaskProgress,
  type AidenRemoteChatAgentRoster,
  type AidenRemoteChatAgent,
} from "./aiden-remote-protocol.js";

interface ProgressChat {
  id: string;
  latestGenerationId?: string;
}

interface ProgressPorts {
  instanceId: string;
  events: ChatProgressEvents;
  /** Revalidate current device grant and retained Workspace/Bot ownership on every read. */
  authorize(
    deviceId: string,
    chatId: string,
    capability: "tasks:read" | "agents:read" | "app-controls:read",
  ): Promise<ProgressChat>;
  appControlsEnabled?(): Promise<boolean>;
  readTodo(chatId: string): Promise<TodoSnapshotViewV1>;
  readAgents(chatId: string): Promise<SubagentRunSnapshot[]>;
  /**
   * Public turn identity already issued for a generation (remote-created
   * turns). Other generations get a stable minted identity instead.
   */
  publicTurnId?(chatId: string, generationId: string): string | undefined;
  /**
   * Main-owned stop for one live foreground subagent run (the same control
   * path the desktop Subagents panel uses). The host resolves the chat's
   * persisted workspace itself. Resolves `false` when no live control
   * binding exists for that chat and run. Absent when the host
   * does not wire subagent control; the interrupt route is then unavailable.
   */
  stopAgent?(run: { chatId: string; runId: string }): Promise<boolean>;
  now?: () => number;
}

const PROGRESS_STREAMS_TOTAL = 64;
const PROGRESS_STREAMS_PER_DEVICE = 8;
const PROGRESS_RETRY_AFTER_SECONDS = 5;

type ProgressEventType = "task_update" | "agents_update" | "app_controls_changed";
type ProgressSnapshot = AidenRemoteChatTaskProgress | AidenRemoteChatAgentRoster | { revision: number };

const ACTIVITY = {
  reading: "Reading",
  listing: "Listing",
  matching: "Matching",
  searching: "Searching",
  inspecting: "Inspecting",
  composing: "Composing",
} as const;
const ROLES = {
  scout: "Scout",
  planner: "Planner",
  reviewer: "Reviewer",
  implementer: "Implementer",
} as const;

/** Dedicated full-snapshot observation; never grants access to a turn-owner stream. */
export class AidenRemoteChatProgressService {
  private readonly epoch = randomUUID();
  private revision = 0;
  private sequence = 0;
  private readonly versions = new Map<
    string,
    { digest: string; revision: number; updatedAt: string }
  >();
  private readonly subscribers = new Map<
    ServerResponse,
    { deviceId: string; close(): void }
  >();
  /**
   * Snapshot revisions each recent event's stream had delivered, keyed by the
   * process-wide event sequence. A reconnect that presents one of these
   * cursors (`after` / `Last-Event-ID`) for the same device and chat resumes
   * without resending snapshots it already received. Unknown cursors (another
   * process, evicted, or a different device/chat) keep the full-snapshot path.
   */
  private readonly cursors = new Map<
    number,
    { deviceId: string; chatId: string; sent: ReadonlyMap<string, number> }
  >();
  private readonly now: () => number;

  constructor(private readonly ports: ProgressPorts) {
    this.now = ports.now ?? Date.now;
  }

  private publicId(kind: string, chatId: string, privateId: string): string {
    return `${kind}_${createHash("sha256")
      .update(JSON.stringify([this.ports.instanceId, kind, chatId, privateId]))
      .digest("base64url")}`;
  }

  private turnPublicId(chatId: string, generationId: string): string {
    return (
      this.ports.publicTurnId?.(chatId, generationId) ??
      this.publicId("turn", chatId, generationId)
    );
  }

  private version(key: string, value: unknown) {
    const digest = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    const cached = this.versions.get(key);
    if (cached?.digest === digest)
      return {
        epoch: this.epoch,
        revision: cached.revision,
        updatedAt: cached.updatedAt,
      };
    const next = {
      digest,
      revision: ++this.revision,
      updatedAt: new Date(this.now()).toISOString(),
    };
    // Bounded metadata only; evicted entries receive a newer process-wide revision.
    if (this.versions.size >= 512)
      this.versions.delete(this.versions.keys().next().value!);
    this.versions.set(key, next);
    return {
      epoch: this.epoch,
      revision: next.revision,
      updatedAt: next.updatedAt,
    };
  }

  async taskSnapshot(
    deviceId: string,
    chatId: string,
  ): Promise<AidenRemoteChatTaskProgress> {
    await this.ports.authorize(deviceId, chatId, "tasks:read");
    const ticket = this.ports.events.revision(chatId);
    const active = this.ports.events.current(chatId);
    // A running session can contain uncommitted tool results. Only its durable
    // callback is allowed to publish task state; idle reads replay the journal.
    const todo = active
      ? (active.todo ?? {
          version: 1 as const,
          chatId,
          availability: "unavailable" as const,
          unavailableReason: "unsupported" as const,
          tasks: [],
        })
      : await this.ports.readTodo(chatId);
    await this.ports.authorize(deviceId, chatId, "tasks:read");
    if (ticket !== this.ports.events.revision(chatId))
      return this.taskSnapshot(deviceId, chatId);
    let value = {
      version: 1,
      chatId,
      availability: todo.availability,
      ...(todo.availability === "unavailable"
        ? { unavailableReason: todo.unavailableReason ?? "invalid_snapshot" }
        : {}),
      tasks: todo.tasks.map(
        ({ id, subject, status, activeForm, blockedBy }) => ({
          id,
          subject,
          status,
          ...(activeForm ? { activeForm } : {}),
          ...(blockedBy ? { blockedBy } : {}),
        }),
      ),
    };
    // Individually bounded labels/dependencies can still exceed the native
    // 1 MiB response/frame budget after JSON escaping. Keep room for metadata
    // and the SSE envelope; never send a snapshot that clients cannot decode.
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1_000_000) {
      value = {
        version: 1, chatId, availability: "unavailable",
        unavailableReason: "invalid_snapshot", tasks: [],
      };
    }
    return parseAidenRemoteChatTaskProgress({
      ...value,
      ...this.version(`tasks:${chatId}`, value),
    });
  }

  async agentRoster(
    deviceId: string,
    chatId: string,
    turnId?: string,
  ): Promise<AidenRemoteChatAgentRoster> {
    const ticket = this.ports.events.revision(chatId);
    const chat = await this.ports.authorize(deviceId, chatId, "agents:read");
    const rawRuns = await this.ports.readAgents(chatId);
    const runs = rawRuns.map((value) => parseSubagentRunSnapshot(value));
    if (runs.some((run) => !run || run.chatId !== chatId)) {
      const value = {
        version: 1,
        chatId,
        availability: "unavailable",
        unavailableReason: "invalid_snapshot",
        agents: [],
      };
      await this.ports.authorize(deviceId, chatId, "agents:read");
      if (ticket !== this.ports.events.revision(chatId))
        return this.agentRoster(deviceId, chatId, turnId);
      return parseAidenRemoteChatAgentRoster({
        ...value,
        ...this.version(`agents:${chatId}:${turnId ?? "current"}`, value),
      });
    }
    const snapshots = (runs as SubagentRunSnapshot[]).filter(
      (run) => run.version === 1 || run.execution === "foreground",
    );
    const active = this.ports.events.current(chatId);
    const generationId = turnId
      ? snapshots.find(
          (run) => this.turnPublicId(chatId, run.generationId) === turnId,
        )?.generationId
      : (active?.generationId ??
        chat.latestGenerationId ??
        snapshots.reduce<SubagentRunSnapshot | undefined>(
          (latest, run) =>
            !latest || run.startedAt > latest.startedAt ? run : latest,
          undefined,
        )?.generationId);
    if (turnId && !generationId)
      throw new AidenRemoteServiceError(
        "not_found",
        "This turn is unavailable.",
        404,
      );
    const selected = snapshots.filter(
      (run) => run.generationId === generationId,
    );
    // Never silently drop a parent or report an incorrect count when corrupt/oversized.
    if (selected.length > 64)
      throw new AidenRemoteServiceError(
        "internal_error",
        "Agent progress is unavailable.",
        500,
      );
    const agents: AidenRemoteChatAgent[] = selected.map((run) => {
      const terminal = AIDEN_REMOTE_CHAT_AGENT_TERMINAL_STATES.has(run.state);
      const state =
        !terminal && active?.generationId !== run.generationId
          ? "interrupted"
          : run.state;
      const finished = AIDEN_REMOTE_CHAT_AGENT_TERMINAL_STATES.has(state);
      const milestone = run.milestones?.[run.milestones.length - 1];
      return {
        agentId: this.publicId("agent", chatId, run.runId),
        ...(run.version === 2 && run.parentRunId
          ? { parentAgentId: this.publicId("agent", chatId, run.parentRunId) }
          : {}),
        depth: run.version === 2 ? run.depth : 1,
        revision: run.revision,
        role: run.role,
        label:
          boundedUnicodePrefix(sanitizeSubagentSnapshotText(run.label), 120) ||
          ROLES[run.role],
        // Private child instructions and reports are deliberately not projected.
        taskPreview: `${ROLES[run.role]} task`,
        state,
        ...(milestone ? { activity: ACTIVITY[milestone] } : {}),
        startedAt: new Date(run.startedAt).toISOString(),
        updatedAt: new Date(run.updatedAt).toISOString(),
        ...(finished
          ? {
              finishedAt: new Date(
                run.finishedAt ?? run.updatedAt,
              ).toISOString(),
            }
          : {}),
        modelId:
          boundedUnicodePrefix(sanitizeSubagentSnapshotText(run.modelId), 160) || "Model",
        turns: run.turns,
        tools: run.tools,
        tokens: run.tokens,
        // The contract requires unique kinds; the upstream journal only skips
        // consecutive duplicates, so dedupe first-occurrence before emitting.
        ...(run.milestones
          ? { milestones: [...new Set(run.milestones)] }
          : {}),
        // Closed producer facts (truncation/filtering) are safe to project;
        // raw error and warning strings stay private to the parent chat.
        ...(run.projectionNotices?.length
          ? { notices: [...new Set(run.projectionNotices)] }
          : {}),
      };
    });
    await this.ports.authorize(deviceId, chatId, "agents:read");
    if (ticket !== this.ports.events.revision(chatId))
      return this.agentRoster(deviceId, chatId, turnId);
    const prior = new Map<string, number>();
    for (const run of snapshots) {
      if (run.generationId === generationId) continue;
      prior.set(
        run.generationId,
        Math.min(prior.get(run.generationId) ?? run.startedAt, run.startedAt),
      );
    }
    const previousTurns = [...prior]
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
      .slice(0, 16)
      .map(([id, startedAt]) => ({
        turnId: this.turnPublicId(chatId, id),
        startedAt: new Date(startedAt).toISOString(),
      }));
    const value = {
      version: 1,
      chatId,
      ...(generationId
        ? { turnId: this.turnPublicId(chatId, generationId) }
        : {}),
      availability: "ready",
      agents,
      ...(previousTurns.length ? { previousTurns } : {}),
    };
    return parseAidenRemoteChatAgentRoster({
      ...value,
      ...this.version(`agents:${chatId}:${turnId ?? "current"}`, value),
    });
  }

  get supportsAgentInterrupt(): boolean {
    return typeof this.ports.stopAgent === "function";
  }

  /**
   * Stop one running delegated agent in the chat's active turn. The caller
   * addresses the agent only by its projection-minted public `agentId`; the
   * private run ID is resolved here from the chat's own durable roster.
   * Already-finished (or abandoned) agents are an idempotent no-op. The
   * response is the refreshed current-turn roster.
   */
  async interruptAgent(
    deviceId: string,
    chatId: string,
    agentId: string,
  ): Promise<AidenRemoteChatAgentRoster> {
    const stopAgent = this.ports.stopAgent;
    if (!stopAgent) {
      throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
    }
    await this.ports.authorize(deviceId, chatId, "agents:read");
    const runs = (await this.ports.readAgents(chatId)).map((value) =>
      parseSubagentRunSnapshot(value),
    );
    const target = runs.find(
      (run): run is SubagentRunSnapshot =>
        run !== undefined &&
        run.chatId === chatId &&
        this.publicId("agent", chatId, run.runId) === agentId,
    );
    if (!target) {
      throw new AidenRemoteServiceError("not_found", "This agent is unavailable.", 404);
    }
    const active = this.ports.events.current(chatId);
    const live =
      !AIDEN_REMOTE_CHAT_AGENT_TERMINAL_STATES.has(target.state) &&
      active?.generationId === target.generationId;
    if (live) {
      if (target.version !== 2) {
        throw new AidenRemoteServiceError(
          "operation_stale",
          "This agent cannot be stopped from this device.",
          409,
        );
      }
      // Revalidate immediately before the side effect: the durable read above
      // is asynchronous and the device grant or chat ownership may have moved.
      await this.ports.authorize(deviceId, chatId, "agents:read");
      let handled = false;
      try {
        handled = await stopAgent({
          chatId,
          runId: target.runId,
        });
      } catch {
        handled = false;
      }
      if (!handled) {
        throw new AidenRemoteServiceError(
          "operation_stale",
          "This agent is no longer controllable. Refresh and try again.",
          409,
        );
      }
    }
    return this.agentRoster(deviceId, chatId);
  }

  async openEvents(
    deviceId: string,
    chatId: string,
    grants: ReadonlySet<AidenRemoteCapability>,
    after: number,
    response: ServerResponse,
    epoch?: string,
  ): Promise<void> {
    let observesControls = Boolean(grants.has("app-controls:read") && this.ports.appControlsEnabled);
    if (observesControls) {
      try {
        await this.ports.authorize(deviceId, chatId, "app-controls:read");
      } catch (error) {
        if (!(error instanceof AidenRemoteServiceError) ||
            !["not_found", "capability_denied"].includes(error.code) ||
            (!grants.has("tasks:read") && !grants.has("agents:read"))) throw error;
        // An inapplicable projection (e.g. Bot controls) cannot tear down
        // separately authorized task/agent progress.
        observesControls = false;
      }
    }
    if (!grants.has("tasks:read") && !grants.has("agents:read") && !observesControls) {
      throw new AidenRemoteServiceError(
        "capability_denied",
        "Progress access is unavailable.",
        403,
      );
    }
    // The response emits "close" once; a client that dropped during the
    // awaits above would never release a registered slot.
    if (response.destroyed || response.writableEnded) return;
    // A phone that changed networks can leave half-open streams behind until
    // the socket times out. Its newest stream replaces its oldest one, so a
    // reconnecting device is never locked out by its own stale connections.
    const own = [...this.subscribers.values()].filter((entry) => entry.deviceId === deviceId);
    if (own.length >= PROGRESS_STREAMS_PER_DEVICE) own[0]!.close();
    if (this.subscribers.size >= PROGRESS_STREAMS_TOTAL) {
      throw new AidenRemoteServiceError(
        "rate_limited",
        "Too many progress connections. Try again shortly.",
        429,
        true,
        { retryAfterSeconds: PROGRESS_RETRY_AFTER_SECONDS },
      );
    }
    let closed = false;
    let running = false;
    let dirty = false;
    let unsubscribe = () => {};
    let revalidate: ReturnType<typeof setInterval> | undefined;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const resumed = after > 0 && (epoch === undefined || epoch === this.epoch) ? this.cursors.get(after) : undefined;
    const isResumed = resumed?.deviceId === deviceId && resumed.chatId === chatId;
    // Native clients drop live control snapshots when a stream disconnects, so
    // every successful subscription re-announces the controls revision even
    // when a warm resume suppresses unchanged task/agent snapshots.
    const sent = new Map<string, number>(
      isResumed
        ? [...resumed.sent].filter(([type]) => type !== "app_controls_changed")
        : [],
    );
    // Snapshots are full state, so a client that cannot keep up only needs the
    // newest of each kind: at most one per kind waits while the socket drains.
    const pending = new Map<ProgressEventType, ProgressSnapshot>();
    let handle: CursorSseHandle | undefined;
    const release = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (revalidate) clearInterval(revalidate);
      if (scheduled) clearTimeout(scheduled);
      pending.clear();
      if (this.subscribers.get(response)?.close === close) this.subscribers.delete(response);
    };
    const close = () => {
      release();
      if (handle) handle.close();
      else response.destroy();
    };
    const offer = (type: ProgressEventType, snapshot: ProgressSnapshot) => {
      if (closed) return;
      if (sent.get(type) === snapshot.revision) pending.delete(type);
      else pending.set(type, snapshot);
    };
    const pull = (): CursorSsePull => {
      const frames: string[] = [];
      for (const [type, snapshot] of pending) {
        pending.delete(type);
        if (sent.get(type) === snapshot.revision) continue;
        sent.set(type, snapshot.revision);
        const event = {
          protocolVersion: 1,
          streamId: chatId,
          sequence: ++this.sequence,
          timestamp: new Date(this.now()).toISOString(),
          type,
          terminal: false,
          payload: snapshot,
        };
        frames.push(sseFrame(String(event.sequence), type, event));
        if (this.cursors.size >= 1024)
          this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(event.sequence, { deviceId, chatId, sent: new Map(sent) });
      }
      return { frames };
    };
    const refresh = async () => {
      dirty = true;
      if (running || closed) return;
      running = true;
      try {
        if (dirty && !closed) {
          dirty = false;
          if (grants.has("tasks:read"))
            offer("task_update", await this.taskSnapshot(deviceId, chatId));
          if (grants.has("agents:read"))
            offer("agents_update", await this.agentRoster(deviceId, chatId));
          if (observesControls) await this.authorizeControls(deviceId, chatId);
          if (observesControls)
            offer("app_controls_changed", { revision: this.ports.events.appControlsRevision() });
          handle?.wake();
        }
      } catch {
        close();
      } finally {
        running = false;
        if (dirty && !closed) schedule();
      }
    };
    const schedule = () => {
      dirty = true;
      if (scheduled || running || closed) return;
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void refresh();
      }, 100);
      scheduled.unref();
    };
    // Subscribe before asynchronous reads so updates during hydration cannot be lost.
    unsubscribe = this.ports.events.subscribe(chatId, () => {
      schedule();
    });
    this.subscribers.set(response, { deviceId, close });
    handle = openCursorSse(response, {
      pull,
      onClose: release,
      headers: {
        "cache-control": "no-cache, no-store",
        "aiden-progress-resumed": String(isResumed),
      },
    });
    await refresh();
    if (closed) return;
    // Idle subscriptions still lose access when the device grant, the chat or
    // its Workspace/Bot ownership changes. That check is cheap; snapshots are
    // rebuilt only when the chat publishes a change.
    // A check slower than the heartbeat is never stacked by the next tick.
    let revalidating = false;
    revalidate = setInterval(() => {
      if (revalidating) return;
      revalidating = true;
      void (async () => {
        try {
          if (grants.has("tasks:read")) await this.ports.authorize(deviceId, chatId, "tasks:read");
          if (grants.has("agents:read")) await this.ports.authorize(deviceId, chatId, "agents:read");
          if (observesControls) await this.authorizeControls(deviceId, chatId);
        } catch {
          close();
        } finally {
          revalidating = false;
        }
      })();
    }, AIDEN_REMOTE_SSE_HEARTBEAT_MS);
    revalidate.unref();
  }

  private async authorizeControls(deviceId: string, chatId: string): Promise<void> {
    await this.ports.authorize(deviceId, chatId, "app-controls:read");
    if (!(await this.ports.appControlsEnabled?.())) throw new Error("App controls were revoked.");
  }

  revokeDevice(deviceId: string): void {
    for (const entry of this.subscribers.values())
      if (entry.deviceId === deviceId) entry.close();
    for (const [sequence, cursor] of this.cursors)
      if (cursor.deviceId === deviceId) this.cursors.delete(sequence);
  }

  close(): void {
    for (const entry of this.subscribers.values()) entry.close();
    this.versions.clear();
    this.cursors.clear();
  }
}
