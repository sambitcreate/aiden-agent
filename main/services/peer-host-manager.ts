import {
  hostIdentifier,
  type PeerBlockedReason,
  type PeerConnectionState,
  type PeerFeedState,
  type PeerHostFeedChange,
  type PeerHostFeedMessage,
  type PeerHostFeedSnapshot,
  type PeerHostStatus,
  type PeerHostView,
  type PeerOperationError,
  type PeerOperationOutcome,
  type PeerRunEvent,
  type PeerRunFrameMessage,
  type PeerRunState,
  type PeerRunStreamState,
  type PeerRunSubscription,
  type PeerSupervisorState,
} from "../../renderer/shared/peer-host.js";
import {
  AIDEN_REMOTE_HOST_EVENTS_FEATURE,
  AIDEN_REMOTE_RUN_STREAMS_FEATURE,
} from "./aiden-remote-protocol.js";
import { PeerHostFeedCache } from "./peer-host-feed-cache.js";
import type { PeerRequestPartition } from "./peer-host-registry.js";
import {
  PEER_CHAT_MUTATIONS,
  PEER_RUN_OPERATIONS,
  peerOperationRequest,
  peerOperationResult,
} from "./peer-operation.js";
import {
  PeerRunStream,
  PeerRunSubscriptions,
  peerRunTarget,
  type PeerRunTimers,
} from "./peer-run-subscriptions.js";
import { parsePeerSseFrame, parsePeerStreamEnvelope } from "./peer-sse.js";
import {
  PeerTransportError,
  type PeerRequest,
  type PeerStreamEnd,
} from "./peer-transport.js";

export const PEER_HOST_FEED_CHANNEL = "remote:host-feed";
export const PEER_RUN_FRAME_CHANNEL = "remote:peer-run-frame";
export const PEER_HOST_STATE_CHANNEL = "remote:peer-host-state";

/** Reconnect delays after consecutive failures; the last step repeats. */
export const PEER_BACKOFF_STEPS_MS = [3_000, 4_000, 8_000, 16_000, 30_000] as const;
/** Each delay varies by up to this fraction either way, so hosts do not reconnect in lockstep. */
export const PEER_BACKOFF_JITTER = 0.2;
/** A connection that lasts this long resets the backoff schedule. */
export const PEER_STABLE_MS = 30_000;
/** Resume, unlock and network changes within this window cause one reconnect. */
export const PEER_WAKE_COALESCE_MS = 500;

/** The registry surface the manager drives; `PeerHostRegistry` satisfies it. */
export interface PeerManagerRegistry {
  list(): Promise<PeerHostView[]>;
  connect(id: string, signal?: AbortSignal): Promise<PeerHostView>;
  /** Verify a live host without replacing its feed or run streams. */
  probe?(id: string, signal?: AbortSignal): Promise<void>;
  preferReachableRoute?(id: string, signal?: AbortSignal): Promise<boolean>;
  request(
    id: string,
    input: Omit<PeerRequest, "credential">,
    onFrame?: (frame: string) => void,
    options?: { partition?: PeerRequestPartition; binary?: boolean; credentialIdentity?: string },
  ): Promise<unknown>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  onChanged(listener: () => void): () => void;
  attachConnectionState(
    state: (id: string) => PeerConnectionState | undefined,
  ): void;
}

export interface PeerHostManagerOptions {
  registry: PeerManagerRegistry;
  /** Sends one notification to every window. */
  broadcast(channel: string, payload: unknown): void;
  now?(): number;
  random?(): number;
  timers?: PeerRunTimers;
}

interface Supervisor {
  readonly hostId: string;
  view: PeerHostView;
  /** Fences every asynchronous result: only the current generation may act. */
  generation: number;
  state: PeerSupervisorState;
  feed: PeerFeedState;
  readonly cache: PeerHostFeedCache;
  /** Aborted when the generation's connection ends; feed and run streams link to it. */
  controller: AbortController;
  /** Consecutive failures; reset after `PEER_STABLE_MS` connected. */
  failures: number;
  retryTimer: unknown;
  stableTimer: unknown;
  routeTimer?: unknown;
  discoveryTimer?: unknown;
  probing?: boolean;
  lastSyncedAt?: number;
  failure?: PeerHostStatus["failure"];
}

const realTimers: PeerRunTimers = {
  set: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function peerBackoffDelay(failures: number, random: () => number): number {
  const step =
    PEER_BACKOFF_STEPS_MS[
      Math.min(Math.max(failures, 1), PEER_BACKOFF_STEPS_MS.length) - 1
    ]!;
  return Math.round(step * (1 + (random() * 2 - 1) * PEER_BACKOFF_JITTER));
}

/** Failures no retry can fix: only re-pairing, or disable and enable, clears them. */
function blockedReason(error: unknown): PeerBlockedReason | undefined {
  if (!(error instanceof PeerTransportError)) return undefined;
  if (error.code === "authentication_required") return "auth";
  if (error.code === "identity_changed") return "identity_changed";
  if (error.code === "unsupported_protocol") return "protocol";
  return undefined;
}

const BLOCKED_CODES: Record<PeerBlockedReason, "authentication_required" | "identity_changed" | "unsupported_protocol"> = {
  auth: "authentication_required",
  identity_changed: "identity_changed",
  protocol: "unsupported_protocol",
};

function answered(error: unknown, status?: number): error is PeerTransportError {
  return (
    error instanceof PeerTransportError &&
    error.code === "request_failed" &&
    error.status !== undefined &&
    (status === undefined
      ? error.status >= 400 && error.status < 500
      : error.status === status)
  );
}

function operationError(error: unknown): PeerOperationError {
  if (error instanceof PeerTransportError)
    return {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.remote
        ? { remoteCode: error.remote.code, retryable: error.remote.retryable }
        : {}),
      ...(error.remote?.details ? { details: { ...error.remote.details } } : {}),
    };
  return {
    code: "failed",
    message: error instanceof Error ? error.message : "The request failed.",
  };
}

function shares(view: PeerHostView, capability: string, feature: string): boolean {
  return view.capabilities.includes(capability) && view.features.includes(feature);
}

/** A stable digest of the non-internal addresses, to notice network changes. */
export function peerNetworkFingerprint(
  interfaces: Record<string, ReadonlyArray<{ address: string; internal: boolean }> | undefined>,
): string {
  return Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address)
    .sort()
    .join(",");
}

/**
 * Supervises every enabled paired host: one connection loop, one shared host
 * feed and the live run streams windows asked for. Disabled hosts have no
 * supervisor and therefore make no traffic.
 */
export class PeerHostManager {
  private readonly supervisors = new Map<string, Supervisor>();
  private known = new Map<string, PeerHostView>();
  /** Per-host high-water mark, so statuses stay monotonic across supervisors. */
  private readonly generations = new Map<string, number>();
  private readonly runs: PeerRunSubscriptions;
  private readonly waiters = new Map<PeerRunStream, () => void>();
  private readonly dropped = new WeakSet<PeerRunStream>();
  /** The newest run the feed announced for a chat stream, kept until it probes. */
  private readonly announced = new WeakMap<PeerRunStream, string>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timers: PeerRunTimers;
  private readonly detach: () => void;
  private readonly ready: Promise<void>;
  private syncing: Promise<void> | undefined;
  private resync = false;
  private wakeTimer: unknown;
  private closed = false;

  constructor(private readonly options: PeerHostManagerOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? realTimers;
    this.runs = new PeerRunSubscriptions({
      timers: this.timers,
      onDrop: (stream) => this.streamDropped(stream),
      feeds: () =>
        [...this.supervisors.values()].filter(
          (sup) => sup.feed === "syncing" || sup.feed === "live",
        ).length,
    });
    options.registry.attachConnectionState((id) => this.connectionState(id));
    this.detach = options.registry.onChanged(() => void this.sync());
    this.ready = this.sync();
  }

  /** Resolves once the first host list has been read. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  get supervising(): number {
    return this.supervisors.size;
  }

  statuses(): PeerHostStatus[] {
    return [...this.known.values()].map((view) => {
      const sup = this.supervisors.get(view.id);
      return sup ? this.status(sup) : this.disabledStatus(view.id);
    });
  }

  /** Last-known rows for one host, or null when it has no supervisor. */
  feedSnapshot(hostId: unknown): PeerHostFeedSnapshot | null {
    return this.supervisors.get(hostIdentifier(hostId))?.cache.snapshot() ?? null;
  }

  async setEnabled(hostId: string, enabled: boolean): Promise<void> {
    await this.options.registry.setEnabled(hostId, enabled);
    // A fresh supervisor starts with no backoff and no block.
    const sup = this.supervisors.get(hostId);
    if (sup) this.stop(sup);
    await this.sync();
  }

  async remove(hostId: string): Promise<void> {
    await this.options.registry.remove(hostId);
    const sup = this.supervisors.get(hostId);
    if (sup) this.stop(sup);
    await this.sync();
  }

  /**
   * The person asked to reconnect one host now. A host waiting out a
   * backoff restarts with a fresh schedule, and so does one blocked by a
   * protocol mismatch (they may have updated Aiden since). A connected or
   * connecting host is left alone. An auth or identity block clears only
   * through a re-pair (`repaired: true`) or by disabling and re-enabling it.
   * Unknown or disabled hosts are ignored.
   */
  async reconnect(hostId: unknown, options: { repaired?: boolean } = {}): Promise<void> {
    await this.ready;
    await this.sync();
    const sup = this.supervisors.get(hostIdentifier(hostId));
    if (this.closed || !sup) return;
    const state = sup.state;
    const restart =
      state.kind === "backoff" ||
      (state.kind === "blocked" && (options.repaired === true || state.reason === "protocol"));
    if (!restart) return;
    sup.failures = 0;
    this.start(sup);
  }

  /** Sleep/resume, unlock or a network change: reconnect every unblocked host once. */
  wake(): void {
    if (this.closed || this.wakeTimer !== undefined) return;
    this.wakeTimer = this.timers.set(() => {
      this.wakeTimer = undefined;
      for (const sup of [...this.supervisors.values()]) {
        if (sup.state.kind === "blocked") continue;
        if (sup.state.kind === "connected" && this.options.registry.probe) {
          if (sup.probing) continue;
          sup.probing = true;
          const generation = sup.generation;
          void this.options.registry.probe(sup.hostId, sup.controller.signal).catch((error: unknown) => {
            if (this.current(sup, generation)) this.fail(sup, generation, error);
          }).finally(() => { sup.probing = false; });
          void this.checkPreferredRoute(sup, generation);
          continue;
        }
        sup.failures = 0;
        this.start(sup);
      }
    }, PEER_WAKE_COALESCE_MS);
  }

  /**
   * One closed operation. Errors come back as typed outcomes. A mutation whose
   * outcome is ambiguous is reconciled with one read and never replayed.
   */
  async call(
    hostId: unknown,
    operation: unknown,
    signal?: AbortSignal,
    options: { credentialIdentity?: string } = {},
  ): Promise<PeerOperationOutcome> {
    let id: string;
    let request: Omit<PeerRequest, "credential">;
    try {
      id = hostIdentifier(hostId);
      request = peerOperationRequest(operation);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_request",
          message: error instanceof Error ? error.message : "Invalid request.",
        },
      };
    }
    await this.ready;
    const sup = this.supervisors.get(id);
    if (sup?.state.kind === "blocked") {
      const code = BLOCKED_CODES[sup.state.reason];
      return { ok: false, error: { code, message: new PeerTransportError(code).message } };
    }
    // Only the connection that admitted the request may be blocked by its failure.
    const admitted = sup?.controller;
    const record = operation as Record<string, unknown>;
    let raw: unknown;
    try {
      raw = await this.options.registry.request(
        id,
        { ...request, ...(signal ? { signal } : {}) },
        undefined,
        { ...(record.operation === "attachmentContent" ? { binary: true } : {}), ...options },
      );
    } catch (error) {
      if (
        sup &&
        blockedReason(error) &&
        this.supervisors.get(id) === sup &&
        sup.controller === admitted &&
        !admitted.signal.aborted
      )
        this.fail(sup, sup.generation, error);
      const ambiguous =
        (request.method ?? "GET") !== "GET" &&
        error instanceof PeerTransportError &&
        (error.code === "unavailable" || error.code === "invalid_response");
      if (!ambiguous) return { ok: false, error: operationError(error) };
      const reconciled = signal?.aborted ? undefined : await this.reconcile(id, record);
      return {
        ok: false,
        error: {
          code: "outcome_unknown",
          message: "The other device may not have applied this change.",
          ...(reconciled === undefined ? {} : { reconciled }),
        },
      };
    }
    try {
      return { ok: true, value: await peerOperationResult(operation, raw) };
    } catch {
      return {
        ok: false,
        error: {
          code: "invalid_response",
          message: new PeerTransportError("invalid_response").message,
        },
      };
    }
  }

  /**
   * Join (or open) the shared live stream for a chat's current run or one run.
   * `afterSequence` applies to run targets; a chat target replays its current
   * run's buffer from the start because the caller cannot know that run.
   */
  async runSubscribe(
    hostId: unknown,
    target: unknown,
    afterSequence: unknown,
    owner: string,
  ): Promise<PeerRunSubscription> {
    const id = hostIdentifier(hostId);
    const parsed = peerRunTarget(target);
    const after = afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || (after as number) < 0)
      throw new Error("Invalid run cursor.");
    await this.ready;
    if (this.closed) throw new Error("Device connections are closed.");
    const sup = this.supervisors.get(id);
    if (!sup) throw new Error("This device is disabled or unavailable.");
    if (!shares(sup.view, "runs:observe", AIDEN_REMOTE_RUN_STREAMS_FEATURE))
      throw new Error("This device does not share live runs.");
    const opening = "runId" in parsed ? (after as number) : 0;
    const { subscriptionId, stream, created } = this.runs.acquire(id, parsed, owner, opening);
    if (created) void this.runStream(stream);
    return stream.view(subscriptionId, opening);
  }

  runUnsubscribe(subscriptionId: unknown, owner: string): boolean {
    if (typeof subscriptionId !== "string" || subscriptionId.length > 64) return false;
    return this.runs.release(subscriptionId, owner);
  }

  /** A window closed or navigated: release everything it held. */
  releaseOwner(owner: string): void {
    this.runs.releaseOwner(owner);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    if (this.wakeTimer !== undefined) this.timers.clear(this.wakeTimer);
    for (const sup of this.supervisors.values()) {
      this.clearTimers(sup);
      sup.controller.abort();
    }
    this.runs.close();
    for (const wake of [...this.waiters.values()]) wake();
  }

  // Supervisors -------------------------------------------------------------

  private sync(): Promise<void> {
    if (this.syncing) {
      this.resync = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.resync = false;
        await this.syncOnce();
      } while (this.resync && !this.closed);
    })().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    let views: PeerHostView[];
    try {
      views = await this.options.registry.list();
    } catch {
      return;
    }
    if (this.closed) return;
    this.known = new Map(views.map((view) => [view.id, view]));
    for (const view of views) {
      const sup = this.supervisors.get(view.id);
      if (!view.enabled) {
        if (sup) this.stop(sup);
        continue;
      }
      if (!sup) {
        this.create(view);
        continue;
      }
      sup.view = view;
      if (sup.state.kind === "connected" && sup.routeTimer === undefined) this.scheduleRouteCheck(sup, sup.generation);
      // Grants refreshed while connected may enable the feed.
      if (
        sup.state.kind === "connected" &&
        sup.feed === "unsupported" &&
        shares(view, "host:events", AIDEN_REMOTE_HOST_EVENTS_FEATURE)
      )
        void this.runFeed(sup, sup.generation);
    }
    for (const sup of [...this.supervisors.values()])
      if (!this.known.has(sup.hostId)) this.stop(sup);
  }

  private create(view: PeerHostView): void {
    const sup: Supervisor = {
      hostId: view.id,
      view,
      generation: this.generations.get(view.id) ?? 0,
      state: { kind: "disabled" },
      feed: "off",
      cache: new PeerHostFeedCache(view.id),
      controller: new AbortController(),
      failures: 0,
      retryTimer: undefined,
      stableTimer: undefined,
    };
    this.supervisors.set(view.id, sup);
    this.start(sup);
  }

  private stop(sup: Supervisor): void {
    if (this.supervisors.get(sup.hostId) !== sup) return;
    this.supervisors.delete(sup.hostId);
    this.clearTimers(sup);
    sup.controller.abort();
    for (const stream of this.runs.forHost(sup.hostId)) this.setStreamState(stream, "gone");
    this.runs.dropHost(sup.hostId);
    const generation = Math.max(this.generations.get(sup.hostId) ?? 0, sup.generation) + 1;
    this.generations.set(sup.hostId, generation);
    this.options.broadcast(PEER_HOST_STATE_CHANNEL, this.disabledStatus(sup.hostId));
  }

  private current(sup: Supervisor, generation: number): boolean {
    return (
      !this.closed &&
      this.supervisors.get(sup.hostId) === sup &&
      sup.generation === generation
    );
  }

  private transition(sup: Supervisor, state: PeerSupervisorState): number {
    sup.generation += 1;
    this.generations.set(sup.hostId, sup.generation);
    sup.state = state;
    this.publish(sup);
    return sup.generation;
  }

  private clearTimers(sup: Supervisor): void {
    if (sup.retryTimer !== undefined) this.timers.clear(sup.retryTimer);
    if (sup.stableTimer !== undefined) this.timers.clear(sup.stableTimer);
    if (sup.routeTimer !== undefined) this.timers.clear(sup.routeTimer);
    if (sup.discoveryTimer !== undefined) this.timers.clear(sup.discoveryTimer);
    sup.retryTimer = undefined;
    sup.stableTimer = undefined;
    sup.routeTimer = undefined;
    sup.discoveryTimer = undefined;
  }

  private start(sup: Supervisor): void {
    this.clearTimers(sup);
    sup.controller.abort();
    this.leaveConnected(sup);
    sup.controller = new AbortController();
    const signal = sup.controller.signal;
    const generation = this.transition(sup, {
      kind: "connecting",
      attempt: sup.failures + 1,
    });
    this.options.registry.connect(sup.hostId, signal).then(
      (view) => {
        if (!this.current(sup, generation)) return;
        sup.view = view;
        const live = this.transition(sup, { kind: "connected", since: this.now() });
        sup.stableTimer = this.timers.set(() => {
          sup.stableTimer = undefined;
          if (this.current(sup, live)) sup.failures = 0;
        }, PEER_STABLE_MS);
        void this.runFeed(sup, live);
        this.scheduleRouteCheck(sup, live);
        this.scheduleRouteDiscovery(sup, live);
        this.wakeHost(sup.hostId);
      },
      (error: unknown) => this.fail(sup, generation, error),
    );
  }

  private async checkPreferredRoute(sup: Supervisor, generation: number): Promise<void> {
    if (!this.options.registry.preferReachableRoute || !this.current(sup, generation)) return;
    try {
      const better = await this.options.registry.preferReachableRoute(sup.hostId, sup.controller.signal);
      if (better && this.current(sup, generation)) this.start(sup);
    } catch { /* Route preference must never interrupt a working fallback. */ }
  }

  private scheduleRouteDiscovery(sup: Supervisor, generation: number): void {
    if (!this.options.registry.probe || sup.view.activeRouteKind !== "lan" || sup.view.hasSuppressedRoutes
      || !sup.view.features.includes("peer-routes-v1")
      || sup.view.routes?.some((route) => route.kind === "tailscale")) return;
    // Optional host discovery takes at most 15s ownership + 5s TLS. One
    // follow-up per connection learns its result without replacing live feeds
    // or adding an idle polling loop; the read itself keeps the 5s probe bound.
    sup.discoveryTimer = this.timers.set(() => {
      sup.discoveryTimer = undefined;
      if (!this.current(sup, generation) || sup.view.hasSuppressedRoutes
        || sup.view.routes?.some((route) => route.kind === "tailscale")) return;
      void this.options.registry.probe!(sup.hostId, sup.controller.signal).catch((error: unknown) => {
        if (this.current(sup, generation)) this.fail(sup, generation, error);
      });
    }, 25_000);
  }

  private scheduleRouteCheck(sup: Supervisor, generation: number): void {
    if (!this.options.registry.preferReachableRoute || sup.view.activeRouteKind !== "tailscale" || !sup.view.routes?.some((route) => route.kind === "lan")) return;
    sup.routeTimer = this.timers.set(() => {
      sup.routeTimer = undefined;
      void this.checkPreferredRoute(sup, generation).finally(() => {
        if (this.current(sup, generation)) this.scheduleRouteCheck(sup, generation);
      });
    }, 30_000);
  }

  private fail(sup: Supervisor, generation: number, error: unknown): void {
    if (!this.current(sup, generation)) return;
    this.clearTimers(sup);
    sup.controller.abort();
    this.leaveConnected(sup);
    const reason = blockedReason(error);
    sup.failure = error instanceof PeerTransportError && error.code === "invalid_response"
      ? "invalid_response"
      : "unreachable";
    if (reason) {
      this.transition(sup, { kind: "blocked", reason });
    } else {
      sup.failures += 1;
      const delay = peerBackoffDelay(sup.failures, this.random);
      const waiting = this.transition(sup, {
        kind: "backoff",
        attempt: sup.failures,
        retryAt: this.now() + delay,
      });
      sup.retryTimer = this.timers.set(() => {
        sup.retryTimer = undefined;
        if (this.current(sup, waiting)) this.start(sup);
      }, delay);
    }
    this.wakeHost(sup.hostId);
  }

  /** Offline rows stay, marked stale. */
  private leaveConnected(sup: Supervisor): void {
    sup.feed = "off";
    for (const change of sup.cache.markStale(sup.cache.epoch !== null))
      this.broadcastFeed(sup, change);
  }

  private status(sup: Supervisor): PeerHostStatus {
    return {
      hostId: sup.hostId,
      generation: sup.generation,
      state: { ...sup.state },
      feed: sup.feed,
      stale: sup.cache.stale,
      ...(sup.lastSyncedAt === undefined ? {} : { lastSyncedAt: sup.lastSyncedAt }),
      ...(sup.failure === undefined ? {} : { failure: sup.failure }),
    };
  }

  private disabledStatus(hostId: string): PeerHostStatus {
    return {
      hostId,
      generation: this.generations.get(hostId) ?? 0,
      state: { kind: "disabled" },
      feed: "off",
      stale: false,
    };
  }

  private publish(sup: Supervisor): void {
    this.options.broadcast(PEER_HOST_STATE_CHANNEL, this.status(sup));
  }

  private connectionState(id: string): PeerConnectionState | undefined {
    const sup = this.supervisors.get(id);
    if (!sup) return undefined;
    switch (sup.state.kind) {
      case "connecting":
      case "connected":
      case "disabled":
        return sup.state.kind;
      default:
        return "unavailable";
    }
  }

  // Host feed ---------------------------------------------------------------

  private setFeed(sup: Supervisor, feed: PeerFeedState): void {
    if (sup.feed === feed) return;
    sup.feed = feed;
    this.publish(sup);
  }

  private broadcastFeed(sup: Supervisor, change: PeerHostFeedChange): void {
    this.options.broadcast(PEER_HOST_FEED_CHANNEL, {
      hostId: sup.hostId,
      epoch: sup.cache.epoch,
      sequence: sup.cache.sequence,
      change,
    } satisfies PeerHostFeedMessage);
  }

  private feedLive(sup: Supervisor): void {
    sup.lastSyncedAt = this.now();
    sup.failure = undefined;
    for (const change of sup.cache.markStale(false)) this.broadcastFeed(sup, change);
    this.setFeed(sup, "live");
  }

  private async runFeed(sup: Supervisor, generation: number): Promise<void> {
    if (!shares(sup.view, "host:events", AIDEN_REMOTE_HOST_EVENTS_FEATURE)) {
      this.setFeed(sup, "unsupported");
      return;
    }
    this.setFeed(sup, "syncing");
    try {
      while (this.current(sup, generation)) {
        const end = await this.feedConnection(sup, generation);
        if (!this.current(sup, generation)) return;
        if (end === "unsupported") {
          this.setFeed(sup, "unsupported");
          return;
        }
        // The session cap is routine: resume from the cursor.
        if (end !== "capped") throw new PeerTransportError("unavailable");
      }
    } catch (error) {
      this.fail(sup, generation, error);
    }
  }

  private async feedConnection(
    sup: Supervisor,
    generation: number,
  ): Promise<PeerStreamEnd["reason"] | "unsupported"> {
    // A snapshot cut off mid-delivery is resent whole.
    sup.cache.abandonPartial();
    const link = linkedController(sup.controller.signal);
    let failure: unknown;
    const cursor = sup.cache.cursor();
    try {
      const end = (await this.options.registry.request(
        sup.hostId,
        {
          path: "/host/events",
          signal: link.controller.signal,
          ...(cursor === undefined ? {} : { lastEventId: cursor }),
          onOpen: () => {
            // A resumed feed may stay silent until something changes.
            if (this.current(sup, generation) && sup.cache.epoch !== null) this.feedLive(sup);
          },
        },
        (frame) => {
          if (failure !== undefined || !this.current(sup, generation)) return;
          try {
            const changes = sup.cache.apply(
              parsePeerStreamEnvelope(parsePeerSseFrame(frame), "host feed"),
            );
            for (const change of changes) {
              this.broadcastFeed(sup, change);
              if (change.type === "run.state") this.feedRun(sup.hostId, change.run);
            }
            if (sup.cache.epoch !== null) this.feedLive(sup);
          } catch (error) {
            failure = error;
            link.controller.abort();
          }
        },
        { partition: "stream" },
      )) as PeerStreamEnd;
      if (failure !== undefined) throw failure;
      return end.reason;
    } catch (error) {
      if (failure !== undefined) throw failure;
      // An older host, or one that withdrew the grant, answers 403 or 404.
      if (answered(error, 403) || answered(error, 404)) return "unsupported";
      throw error;
    } finally {
      link.detach();
    }
  }

  /**
   * A chat's other run wakes its parked chat-target stream, even when the feed
   * first reports that run already finished. The announcement is remembered
   * so one that lands before the stream parks still makes it probe.
   */
  private feedRun(hostId: string, run: PeerRunState): void {
    for (const stream of this.runs.forHost(hostId)) {
      if (!("chatId" in stream.target) || stream.chatId !== run.chatId || stream.runId === run.runId)
        continue;
      this.announced.set(stream, run.runId);
      this.wakeStream(stream);
    }
  }

  // Live run streams --------------------------------------------------------

  private wait(stream: PeerRunStream, ms?: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: unknown;
      const done = () => {
        if (this.waiters.get(stream) === done) this.waiters.delete(stream);
        if (timer !== undefined) this.timers.clear(timer);
        resolve();
      };
      this.waiters.set(stream, done);
      if (ms !== undefined) timer = this.timers.set(done, ms);
    });
  }

  private wakeStream(stream: PeerRunStream): void {
    this.waiters.get(stream)?.();
  }

  private wakeHost(hostId: string): void {
    for (const stream of this.runs.forHost(hostId)) this.wakeStream(stream);
  }

  private streamDropped(stream: PeerRunStream): void {
    this.dropped.add(stream);
    stream.loop += 1;
    stream.controller?.abort();
    this.wakeStream(stream);
  }

  private setStreamState(stream: PeerRunStream, state: PeerRunStreamState): void {
    if (stream.state === state) return;
    stream.state = state;
    this.options.broadcast(PEER_RUN_FRAME_CHANNEL, {
      kind: "state",
      hostId: stream.hostId,
      key: stream.key,
      runId: stream.runId,
      chatId: stream.chatId,
      state,
    } satisfies PeerRunFrameMessage);
  }

  private broadcastRunEvent(stream: PeerRunStream, event: PeerRunEvent): void {
    this.options.broadcast(PEER_RUN_FRAME_CHANNEL, {
      kind: "event",
      hostId: stream.hostId,
      key: stream.key,
      runId: event.streamId,
      chatId: stream.chatId,
      event,
    } satisfies PeerRunFrameMessage);
  }

  /**
   * One shared stream's connection loop. A run target ends with its run; a
   * chat target parks when its run ends and probes the chat's current run
   * again when the feed announces a newer run or the host reconnects.
   */
  private async runStream(stream: PeerRunStream): Promise<void> {
    const loop = ++stream.loop;
    const alive = () => !this.closed && stream.loop === loop && !this.dropped.has(stream);
    const chatTarget = "chatId" in stream.target;
    let failures = 0;
    let parked = false;
    let probe = chatTarget;
    while (alive()) {
      const sup = this.supervisors.get(stream.hostId);
      if (!sup || sup.state.kind !== "connected") {
        this.setStreamState(stream, "waiting");
        await this.wait(stream);
        if (parked) {
          // The host reconnected: its chat may have started a run meanwhile.
          parked = false;
          probe = true;
        }
        continue;
      }
      if (!chatTarget && stream.ended) {
        this.setStreamState(stream, "ended");
        return;
      }
      if (parked) {
        const next = this.announced.get(stream);
        if (next === undefined || next === stream.runId) {
          this.setStreamState(stream, "idle");
          await this.wait(stream);
        }
        parked = false;
        probe = true;
        continue;
      }
      const generation = sup.generation;
      const resume = !probe && stream.runId !== null;
      // A probe reads the chat's current run, which covers every earlier announcement.
      if (!resume) this.announced.delete(stream);
      const link = linkedController(sup.controller.signal);
      stream.controller = link.controller;
      let failure: unknown;
      try {
        const end = (await this.options.registry.request(
          stream.hostId,
          {
            path: resume
              ? `/runs/${encodeURIComponent(stream.runId!)}/events`
              : `/chats/${encodeURIComponent(stream.chatId!)}/runs/current/events`,
            signal: link.controller.signal,
            ...(resume && stream.cursor > 0 ? { lastEventId: String(stream.cursor) } : {}),
            onOpen: () => {
              if (alive() && this.current(sup, generation)) this.setStreamState(stream, "streaming");
            },
          },
          (frame) => {
            if (failure !== undefined || !alive() || !this.current(sup, generation)) return;
            try {
              const event = parsePeerStreamEnvelope(parsePeerSseFrame(frame), "run stream");
              // The chat's current run may be newer than the one this stream followed.
              if (!resume && event.streamId !== stream.runId) stream.switchRun(event.streamId);
              if (stream.accept(event)) {
                failures = 0;
                this.broadcastRunEvent(stream, event);
              }
            } catch (error) {
              failure = error;
              link.controller.abort();
            }
          },
          { partition: "stream" },
        )) as PeerStreamEnd;
        if (failure !== undefined) throw failure;
        probe = false;
        if (end.reason === "capped") continue;
        if (stream.ended) {
          parked = chatTarget;
          continue;
        }
        // The host closed a run that has not ended: retry after a pause.
        failures += 1;
        await this.wait(stream, peerBackoffDelay(failures, this.random));
      } catch (error) {
        const cause = failure ?? error;
        if (!alive()) return;
        if (!this.current(sup, generation)) continue;
        if (blockedReason(cause)) {
          this.fail(sup, generation, cause);
          continue;
        }
        if (answered(cause, 404) || answered(cause, 400)) {
          // The run is gone (or the cursor no longer names it).
          if (!chatTarget) {
            this.setStreamState(stream, "gone");
            return;
          }
          if (resume) probe = true;
          else parked = true;
          continue;
        }
        if (answered(cause)) {
          // Refused, e.g. a Bot chat this device may not read.
          this.setStreamState(stream, "gone");
          return;
        }
        failures += 1;
        await this.wait(stream, peerBackoffDelay(failures, this.random));
      } finally {
        link.detach();
        if (stream.controller === link.controller) stream.controller = undefined;
      }
    }
  }

  private async reconcile(
    hostId: string,
    operation: Record<string, unknown>,
  ): Promise<unknown> {
    const name = operation.operation;
    const resourceId = operation.resourceId;
    if (typeof name !== "string" || typeof resourceId !== "string") return undefined;
    if (PEER_RUN_OPERATIONS.has(name)) {
      const run = this.supervisors.get(hostId)?.cache.run(resourceId);
      return run ? { run: { ...run } } : undefined;
    }
    if (!PEER_CHAT_MUTATIONS.has(name)) return undefined;
    const read = { operation: "chat", resourceId };
    try {
      return {
        chat: await peerOperationResult(
          read,
          await this.options.registry.request(hostId, peerOperationRequest(read)),
        ),
      };
    } catch (error) {
      return answered(error, 404) ? { chat: null } : undefined;
    }
  }
}

function linkedController(parent: AbortSignal): {
  controller: AbortController;
  detach(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    detach: () => parent.removeEventListener("abort", abort),
  };
}
