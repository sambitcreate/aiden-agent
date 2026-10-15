import { randomUUID } from "node:crypto";
import type {
  PeerRunEvent,
  PeerRunStreamState,
  PeerRunSubscription,
} from "../../renderer/shared/peer-host.js";
import type {
  LocalRunCursor,
  LocalRunFrame,
  LocalRunFrameMessage,
} from "../../renderer/shared/local-run-frames.js";
import {
  hostRunEndedEvent,
  hostRunGapSnapshotEvent,
  hostRunWireEvent,
} from "./aiden-remote-host-runs.js";
import type { HostRunRegistry, HostRunState, HostRunSummary } from "./host-run-registry.js";

/** One frame batch per display frame: deltas arriving within it share one IPC message. */
export const LOCAL_RUN_BATCH_MS = 16;
/** Journal events read per flush; a longer backlog continues on the next frame. */
const MAX_EVENTS_PER_FLUSH = 256;

export type LocalRunObserverRegistry = Pick<
  HostRunRegistry,
  "currentRunForChat" | "read" | "subscribe" | "onChange"
>;

/** The renderer document that subscribed. Frames go to it alone. */
export interface LocalRunObserverTarget {
  /** Stable for one document; a reload or navigation is a new target. */
  readonly key: string;
  isDestroyed(): boolean;
  send(message: LocalRunFrameMessage): void;
  /** Runs once when the document goes away; returns a detach function. */
  onInvalidated(listener: () => void): () => void;
}

export interface LocalRunObserversOptions {
  registry: LocalRunObserverRegistry;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  batchMs?: number;
  maxEventsPerFlush?: number;
  newId?(): string;
}

interface Observation {
  readonly id: string;
  readonly target: LocalRunObserverTarget;
  readonly chatId: string;
  runId: string | null;
  /** The last journal sequence delivered for `runId`. */
  cursor: number;
  ended: boolean;
  state: PeerRunStreamState;
  releaseRun: () => void;
  queued: LocalRunFrame[];
  timer: unknown;
}

function isTerminal(state: HostRunState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

/**
 * Mirrors this process's own host-run journal into renderer documents that
 * are watching a chat they did not start. Each observation follows the chat's
 * current run, batches its events into one message per frame, and is released
 * when its document unsubscribes, navigates or is destroyed. With nobody
 * watching, it holds no registry subscription and no change listener.
 */
export class LocalRunObservers {
  private readonly observations = new Map<string, Observation>();
  private readonly targets = new Map<string, { detach: () => void; ids: Set<string> }>();
  private offChange: (() => void) | null = null;
  private readonly batchMs: number;
  private readonly maxEventsPerFlush: number;
  private readonly newId: () => string;

  constructor(private readonly options: LocalRunObserversOptions) {
    this.batchMs = options.batchMs ?? LOCAL_RUN_BATCH_MS;
    this.maxEventsPerFlush = options.maxEventsPerFlush ?? MAX_EVENTS_PER_FLUSH;
    this.newId = options.newId ?? (() => `local-run-${randomUUID()}`);
  }

  /** Live observations (diagnostics and tests). */
  get size(): number {
    return this.observations.size;
  }

  /**
   * Starts following `chatId`'s current run. The result carries every event
   * after `cursor` (or the whole retained run when the cursor names another
   * run); later events arrive as batched frames. A run that had already ended
   * before an observer without its cursor arrived is reported `ended` without
   * a replay, since the persisted transcript already holds it.
   */
  observe(target: LocalRunObserverTarget, chatId: string, cursor?: LocalRunCursor): PeerRunSubscription {
    if (target.isDestroyed()) throw new Error("The application document changed.");
    const observation: Observation = {
      id: this.newId(),
      target,
      chatId,
      runId: null,
      cursor: 0,
      ended: false,
      state: "idle",
      releaseRun: () => {},
      queued: [],
      timer: undefined,
    };
    this.observations.set(observation.id, observation);
    this.bindTarget(target, observation.id);
    this.offChange ??= this.options.registry.onChange((summary, removed) => this.runChanged(summary, removed));

    const summary = this.options.registry.currentRunForChat(chatId);
    let events: PeerRunEvent[] = [];
    if (summary) {
      const resumes = cursor !== undefined && cursor.runId === summary.runId && cursor.sequence <= summary.lastSequence;
      observation.runId = summary.runId;
      if (isTerminal(summary.state) && !resumes) {
        observation.cursor = summary.lastSequence;
        observation.ended = true;
        observation.state = "ended";
      } else {
        observation.cursor = resumes ? cursor.sequence : 0;
        observation.state = "streaming";
        events = this.drain(observation);
        // The subscription itself reports the resulting state.
        observation.queued.length = 0;
        if (!observation.ended) this.subscribeRun(observation);
      }
    }
    return {
      subscriptionId: observation.id,
      key: observation.id,
      runId: observation.runId,
      chatId,
      state: observation.state,
      events,
      truncated: false,
    };
  }

  /** Stops one observation; only its own document may stop it. */
  unobserve(targetKey: string, subscriptionId: string): boolean {
    const observation = this.observations.get(subscriptionId);
    if (!observation || observation.target.key !== targetKey) return false;
    this.release(observation);
    return true;
  }

  /** Releases everything a document was watching. */
  releaseTarget(targetKey: string): void {
    const bound = this.targets.get(targetKey);
    if (!bound) return;
    for (const id of [...bound.ids]) {
      const observation = this.observations.get(id);
      if (observation) this.release(observation);
    }
  }

  private bindTarget(target: LocalRunObserverTarget, id: string): void {
    let bound = this.targets.get(target.key);
    if (!bound) {
      const ids = new Set<string>();
      bound = { ids, detach: () => {} };
      this.targets.set(target.key, bound);
      bound.detach = target.onInvalidated(() => this.releaseTarget(target.key));
    }
    bound.ids.add(id);
  }

  private release(observation: Observation): void {
    if (this.observations.get(observation.id) !== observation) return;
    this.observations.delete(observation.id);
    observation.releaseRun();
    observation.releaseRun = () => {};
    if (observation.timer !== undefined) this.options.clearTimer(observation.timer);
    observation.timer = undefined;
    const bound = this.targets.get(observation.target.key);
    if (bound) {
      bound.ids.delete(observation.id);
      if (bound.ids.size === 0) {
        this.targets.delete(observation.target.key);
        bound.detach();
      }
    }
    if (this.observations.size === 0 && this.offChange) {
      this.offChange();
      this.offChange = null;
    }
  }

  private subscribeRun(observation: Observation): void {
    const runId = observation.runId;
    if (runId === null) return;
    observation.releaseRun = this.options.registry.subscribe(runId, () => this.schedule(observation));
  }

  private schedule(observation: Observation): void {
    if (observation.timer !== undefined || this.observations.get(observation.id) !== observation) return;
    observation.timer = this.options.setTimer(() => {
      observation.timer = undefined;
      this.flush(observation);
    }, this.batchMs);
  }

  private setState(observation: Observation, state: PeerRunStreamState): void {
    if (observation.state === state) return;
    observation.state = state;
    observation.queued.push({ kind: "state", runId: observation.runId, state });
  }

  /** Reads what the journal holds past the cursor, closing the run when it is complete. */
  private drain(observation: Observation): PeerRunEvent[] {
    const runId = observation.runId;
    if (runId === null || observation.ended) return [];
    const events: PeerRunEvent[] = [];
    while (events.length < this.maxEventsPerFlush) {
      let read;
      try {
        read = this.options.registry.read(runId, observation.cursor, this.maxEventsPerFlush - events.length);
      } catch {
        // The run was evicted while observed; the persisted transcript has the rest.
        this.endRun(observation, "gone");
        return events;
      }
      if (read.kind === "snapshot_required") {
        const gap = hostRunGapSnapshotEvent(read, "full");
        events.push(gap);
        observation.cursor = gap.sequence;
        continue;
      }
      for (const event of read.events) {
        events.push(hostRunWireEvent(event, read.summary.chatId, "full"));
        observation.cursor = event.sequence;
      }
      if (isTerminal(read.summary.state) && observation.cursor === read.summary.lastSequence) {
        events.push(hostRunEndedEvent(read.summary));
        this.endRun(observation, "ended");
        return events;
      }
      if (read.events.length === 0 || observation.cursor === read.summary.lastSequence) return events;
    }
    // More remains than one flush carries; continue on the next frame.
    this.schedule(observation);
    return events;
  }

  private endRun(observation: Observation, state: "ended" | "gone"): void {
    observation.ended = true;
    observation.releaseRun();
    observation.releaseRun = () => {};
    this.setState(observation, state);
  }

  private flush(observation: Observation): void {
    if (this.observations.get(observation.id) !== observation) return;
    if (observation.target.isDestroyed()) {
      this.releaseTarget(observation.target.key);
      return;
    }
    const frames: LocalRunFrame[] = [];
    for (const event of this.drain(observation)) frames.push({ kind: "event", event });
    // State changes (ended, gone, a newly adopted run) follow the events that caused them.
    frames.push(...observation.queued.splice(0));
    if (observation.ended || observation.runId === null) this.adoptCurrentRun(observation, frames);
    if (frames.length === 0) return;
    try {
      observation.target.send({ subscriptionId: observation.id, chatId: observation.chatId, frames });
    } catch {
      // The document went away between the check and the send.
      this.releaseTarget(observation.target.key);
    }
  }

  /** A parked observation picks up the chat's next run. */
  private adoptCurrentRun(observation: Observation, frames: LocalRunFrame[]): void {
    const current = this.options.registry.currentRunForChat(observation.chatId);
    if (!current || current.runId === observation.runId || isTerminal(current.state)) return;
    observation.runId = current.runId;
    observation.cursor = 0;
    observation.ended = false;
    observation.state = "streaming";
    frames.push({ kind: "state", runId: current.runId, state: "streaming" });
    for (const event of this.drain(observation)) frames.push({ kind: "event", event });
    frames.push(...observation.queued.splice(0));
    if (!observation.ended) this.subscribeRun(observation);
  }

  private runChanged(summary: HostRunSummary, removed: boolean): void {
    for (const observation of this.observations.values()) {
      if (observation.chatId !== summary.chatId) continue;
      if (removed) {
        if (summary.runId === observation.runId && !observation.ended) {
          this.endRun(observation, "gone");
          this.schedule(observation);
        }
        continue;
      }
      // A new run in a parked chat: deliver it on the next frame.
      if (summary.runId !== observation.runId && (observation.runId === null || observation.ended)) {
        this.schedule(observation);
      }
    }
  }
}
