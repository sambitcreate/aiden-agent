import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { TodoSnapshotViewV1 } from "../../renderer/shared/todo.js";
import {
  parseSubagentRunSnapshot,
  type SubagentRunSnapshot,
} from "../../renderer/shared/subagent-runs.js";
import { sanitizeSubagentSnapshotText } from "../../renderer/shared/subagent-safe-text.js";
import { ChatProgressEvents } from "./chat-progress-events.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  parseAidenRemoteChatTaskProgress,
  parseAidenRemoteChatAgentRoster,
  AIDEN_REMOTE_CHAT_AGENT_TERMINAL_STATES,
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
    capability: "tasks:read" | "agents:read",
  ): Promise<ProgressChat>;
  readTodo(chatId: string): Promise<TodoSnapshotViewV1>;
  readAgents(chatId: string): Promise<SubagentRunSnapshot[]>;
  now?: () => number;
}

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
  private readonly now: () => number;

  constructor(private readonly ports: ProgressPorts) {
    this.now = ports.now ?? Date.now;
  }

  private publicId(kind: string, chatId: string, privateId: string): string {
    return `${kind}_${createHash("sha256")
      .update(JSON.stringify([this.ports.instanceId, kind, chatId, privateId]))
      .digest("base64url")}`;
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
          (run) => this.publicId("turn", chatId, run.generationId) === turnId,
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
          sanitizeSubagentSnapshotText(run.label).slice(0, 120) ||
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
          sanitizeSubagentSnapshotText(run.modelId).slice(0, 160) || "Model",
        turns: run.turns,
        tools: run.tools,
        tokens: run.tokens,
        ...(run.milestones ? { milestones: run.milestones } : {}),
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
        turnId: this.publicId("turn", chatId, id),
        startedAt: new Date(startedAt).toISOString(),
      }));
    const value = {
      version: 1,
      chatId,
      ...(generationId
        ? { turnId: this.publicId("turn", chatId, generationId) }
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

  async openEvents(
    deviceId: string,
    chatId: string,
    grants: ReadonlySet<AidenRemoteCapability>,
    _after: number,
    response: ServerResponse,
  ): Promise<void> {
    if (!grants.has("tasks:read") && !grants.has("agents:read")) {
      throw new AidenRemoteServiceError(
        "capability_denied",
        "Progress access is unavailable.",
        403,
      );
    }
    if (
      this.subscribers.size >= 64 ||
      [...this.subscribers.values()].filter(
        (entry) => entry.deviceId === deviceId,
      ).length >= 8
    ) {
      throw new AidenRemoteServiceError(
        "rate_limited",
        "Too many progress connections.",
        429,
      );
    }
    let closed = false;
    let running = false;
    let dirty = false;
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const sent = new Map<string, number>();
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
      if (scheduled) clearTimeout(scheduled);
      this.subscribers.delete(response);
      response.end();
    };
    const write = (
      type: "task_update" | "agents_update",
      snapshot: AidenRemoteChatTaskProgress | AidenRemoteChatAgentRoster,
    ) => {
      if (closed || sent.get(type) === snapshot.revision) return;
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
      response.write(
        `id: ${event.sequence}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
      // A single bounded snapshot can exceed the socket high-water mark. Allow
      // that write to drain; close only genuinely slow consumers with >1 MiB queued.
      if (response.writableLength > 1_048_576) close();
    };
    const refresh = async () => {
      dirty = true;
      if (running || closed) return;
      running = true;
      try {
        if (dirty && !closed) {
          dirty = false;
          if (grants.has("tasks:read"))
            write("task_update", await this.taskSnapshot(deviceId, chatId));
          if (grants.has("agents:read"))
            write("agents_update", await this.agentRoster(deviceId, chatId));
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
    response.on("close", close);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    await refresh();
    if (!closed) {
      heartbeat = setInterval(() => {
        // Also revalidate idle subscriptions after chat deletion/authority changes.
        void refresh();
        if (!closed) response.write(": heartbeat\n\n");
        if (response.writableLength > 1_048_576) close();
      }, 15_000);
      heartbeat.unref();
    }
  }

  revokeDevice(deviceId: string): void {
    for (const entry of this.subscribers.values())
      if (entry.deviceId === deviceId) entry.close();
  }

  close(): void {
    for (const entry of this.subscribers.values()) entry.close();
    this.versions.clear();
  }
}
