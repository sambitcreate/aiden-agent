import {
  hostIdentifier,
  LOCAL_HOST_ID,
  MAX_PEER_HOSTS,
  type PeerHostView,
} from "../../renderer/shared/peer-host.js";
import {
  assertPeerPairingExpiry,
  peerRecord,
  peerStrings,
  peerText,
  type PeerPairing,
} from "./peer-pairing.js";
import type https from "node:https";
import {
  createPeerAgent,
  PeerTransport,
  PeerTransportError,
  validatePeerTrust,
  type PeerBinary,
  type PeerRequest,
  type PeerStreamEnd,
  type PeerTrust,
} from "./peer-transport.js";
import {
  AIDEN_REMOTE_CHAT_AGENTS_FEATURE,
  AIDEN_REMOTE_CHAT_QUESTION_PROMPTS_FEATURE,
  AIDEN_REMOTE_CHAT_SKILLS_FEATURE,
  AIDEN_REMOTE_CHAT_TASKS_FEATURE,
  AIDEN_REMOTE_HOST_EVENTS_FEATURE,
  AIDEN_REMOTE_RUN_CONTROL_FEATURE,
  AIDEN_REMOTE_RUN_STREAMS_FEATURE,
} from "./aiden-remote-protocol.js";

export interface StoredPeerHost extends PeerTrust {
  id: string;
  name: string;
  deviceId: string;
  credential: string;
  enabled: boolean;
  capabilities: string[];
  features: string[];
}

export interface PeerHostStorage {
  load(): Promise<StoredPeerHost[]>;
  save(hosts: StoredPeerHost[], isCurrent?: () => boolean): Promise<void>;
}

export interface PeerClient {
  json(input: PeerRequest): Promise<unknown>;
  /** Resolves when the stream ends cleanly; `void` means the server ended it (`eof`). */
  events(
    input: PeerRequest,
    onFrame: (frame: string) => void,
  ): Promise<PeerStreamEnd | void>;
  binary?(input: PeerRequest): Promise<PeerBinary>;
}

/**
 * Grants a desktop controller asks for after pairing, each gated by the
 * feature that proves the host serves it. Bot grants stay pairing-bound
 * (contract revision 19) and are never negotiated.
 */
const NEGOTIATED_GRANTS: ReadonlyArray<readonly [string, string]> = [
  ["tasks:read", AIDEN_REMOTE_CHAT_TASKS_FEATURE],
  ["agents:read", AIDEN_REMOTE_CHAT_AGENTS_FEATURE],
  ["questions:respond", AIDEN_REMOTE_CHAT_QUESTION_PROMPTS_FEATURE],
  ["skills:invoke", AIDEN_REMOTE_CHAT_SKILLS_FEATURE],
  ["host:events", AIDEN_REMOTE_HOST_EVENTS_FEATURE],
  ["runs:observe", AIDEN_REMOTE_RUN_STREAMS_FEATURE],
  ["runs:control", AIDEN_REMOTE_RUN_CONTROL_FEATURE],
];

/** Unary requests and streams (feed plus live runs) have separate budgets. */
export const PEER_UNARY_PER_HOST = 8;
export const PEER_UNARY_TOTAL = 32;
export const PEER_STREAMS_PER_HOST = 17;
export const PEER_STREAMS_TOTAL = 64;

export type PeerRequestPartition = "unary" | "stream";

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    [...left].sort().join("\n") === [...right].sort().join("\n")
  );
}

export function parseStoredPeerHosts(value: unknown): StoredPeerHost[] {
  if (!Array.isArray(value) || value.length > MAX_PEER_HOSTS)
    throw new Error("Invalid paired-host registry.");
  const ids = new Set<string>();
  return value.map((item) => {
    const record = peerRecord(item);
    const id = hostIdentifier(record.id);
    if (
      ids.has(id) ||
      id === LOCAL_HOST_ID ||
      typeof record.enabled !== "boolean"
    )
      throw new Error("Invalid paired-host identity.");
    ids.add(id);
    const credential = peerText(record.credential, 43);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(credential))
      throw new Error("Invalid paired-host credential.");
    return {
      ...validatePeerTrust({
        endpoint: peerText(record.endpoint, 2048),
        serverSpkiSha256: peerText(record.serverSpkiSha256, 51),
        ...(record.caCertificateDerBase64 === undefined
          ? {}
          : {
              caCertificateDerBase64: peerText(
                record.caCertificateDerBase64,
                8192,
              ),
            }),
      }),
      id,
      credential,
      enabled: record.enabled,
      name: peerText(record.name, 80),
      deviceId: hostIdentifier(record.deviceId),
      capabilities: peerStrings(record.capabilities),
      features: peerStrings(record.features, 32),
    };
  });
}

interface Admitted {
  host: StoredPeerHost;
  epoch: number;
  controller: AbortController;
  pool: Map<string, Set<AbortController>>;
}

/** No mutable global target: each request captures one authenticated installation. */
export class PeerHostRegistry {
  private hosts: StoredPeerHost[] | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Map<string, Set<AbortController>>();
  private streams = new Map<string, Set<AbortController>>();
  private agents = new Map<string, https.Agent>();
  private negotiated = new Set<string>();
  private listeners = new Set<() => void>();
  private stateOverride:
    | ((id: string) => PeerHostView["state"] | undefined)
    | undefined;
  private states = new Map<string, PeerHostView["state"]>();
  private epochs = new Map<string, number>();
  private verified = new Set<string>();
  private pairings = new Map<string, AbortController>();
  private closed = false;
  private queued = 0;
  constructor(
    private readonly options: {
      storage: PeerHostStorage;
      localInstanceId(): Promise<string>;
      clientVersion: string;
      deviceName: string;
      platform: "mac" | "linux";
      client?(trust: PeerTrust): PeerClient;
      changed?(): void;
    },
  ) {}

  private locked<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("Device connections are closed."));
    if (this.queued >= 64)
      return Promise.reject(new Error("Too many pending device operations."));
    this.queued++;
    const run = this.tail
      .then(() => {
        if (this.closed) throw new Error("Device connections are closed.");
        return work();
      })
      .finally(() => {
        this.queued--;
      });
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async load(): Promise<StoredPeerHost[]> {
    if (!this.hosts)
      this.hosts = parseStoredPeerHosts(await this.options.storage.load());
    return this.hosts;
  }
  private client(trust: PeerTrust, hostId?: string): PeerClient {
    const injected = this.options.client?.(trust);
    if (injected) return injected;
    // Pairing runs before a host exists and keeps a single-use connection.
    if (hostId === undefined) return new PeerTransport(trust);
    let agent = this.agents.get(hostId);
    if (!agent) {
      agent = createPeerAgent(trust);
      this.agents.set(hostId, agent);
    }
    return new PeerTransport(trust, { agent });
  }
  private invalidate(id: string): void {
    this.verified.delete(id);
    this.negotiated.delete(id);
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    for (const controller of this.active.get(id) ?? []) controller.abort();
    for (const controller of this.streams.get(id) ?? []) controller.abort();
    this.active.delete(id);
    this.streams.delete(id);
    this.agents.get(id)?.destroy();
    this.agents.delete(id);
  }
  private notify(): void {
    this.options.changed?.();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One observer must not break host bookkeeping.
      }
    }
  }
  /** Observe pairing, enablement, removal and refreshed grants. */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Once a supervisor is attached, it owns each enabled host's coarse state. */
  attachConnectionState(
    state: (id: string) => PeerHostView["state"] | undefined,
  ): void {
    this.stateOverride = state;
  }

  private async verify(
    host: StoredPeerHost,
    client: PeerClient,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<void> {
    if (this.verified.has(host.id)) return;
    // Only completed verification is shared. Concurrent callers retain independent cancellation.
    const server = peerRecord(
      await client.json({
        path: "/server",
        credential: host.credential,
        signal,
      }),
    );
    if (!current()) throw new Error("Device operation was superseded.");
    if (server.protocolVersion !== 1)
      throw new PeerTransportError("unsupported_protocol");
    if (server.instanceId !== host.id)
      throw new PeerTransportError("identity_changed");
    const capabilities = peerStrings(server.capabilities);
    const features = peerStrings(server.features ?? [], 32);
    const advertised = Array.isArray(server.serverCapabilities)
      ? peerStrings(server.serverCapabilities)
      : undefined;
    await this.refreshGrants(host.id, capabilities, features, current);
    this.verified.add(host.id);
    if (this.negotiated.has(host.id)) return;
    this.negotiated.add(host.id);
    const missing = NEGOTIATED_GRANTS.filter(
      ([grant, feature]) =>
        !capabilities.includes(grant) &&
        features.includes(feature) &&
        (advertised === undefined || advertised.includes(grant)),
    ).map(([grant]) => grant);
    if (missing.length === 0) return;
    try {
      const upgraded = peerRecord(
        await client.json({
          method: "POST",
          path: "/device/capabilities",
          credential: host.credential,
          signal,
          body: { accepts: missing },
        }),
      );
      if (current())
        await this.refreshGrants(
          host.id,
          peerStrings(upgraded.capabilities),
          features,
          current,
        );
    } catch {
      // An older host without the route, or a refusal, leaves the existing grants in place.
    }
  }
  /** Persist the grants and features a host reports, so views and gates stay current. */
  private async refreshGrants(
    id: string,
    capabilities: string[],
    features: string[],
    current: () => boolean,
  ): Promise<void> {
    const stored = this.hosts?.find((entry) => entry.id === id);
    if (
      !stored ||
      (sameStrings(stored.capabilities, capabilities) &&
        sameStrings(stored.features, features))
    )
      return;
    await this.locked(async () => {
      if (!current()) return;
      const hosts = await this.load();
      if (!hosts.some((entry) => entry.id === id)) return;
      const next = hosts.map((entry) =>
        entry.id === id ? { ...entry, capabilities, features } : entry,
      );
      await this.options.storage.save(next, current);
      this.hosts = next;
      this.notify();
    });
  }
  private view(host: StoredPeerHost): PeerHostView {
    return {
      id: host.id,
      name: host.name,
      enabled: host.enabled,
      state: host.enabled
        ? (this.stateOverride?.(host.id) ??
          this.states.get(host.id) ??
          "disconnected")
        : "disabled",
      features: [...host.features],
      capabilities: [...host.capabilities],
    };
  }
  list(): Promise<PeerHostView[]> {
    return this.locked(async () =>
      (await this.load()).map((host) => this.view(host)),
    );
  }

  async pair(
    pairing: PeerPairing,
    signal?: AbortSignal,
  ): Promise<PeerHostView> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const current = () => !this.closed && !controller.signal.aborted;
    const assertCurrent = () => {
      if (!current()) throw new Error("Pairing was cancelled.");
    };
    let reserved = false;
    try {
      await this.locked(async () => {
        assertCurrent();
        const hosts = await this.load();
        if (
          pairing.instanceId === (await this.options.localInstanceId()) ||
          pairing.instanceId === LOCAL_HOST_ID
        )
          throw new Error("This is the current Aiden installation.");
        assertCurrent();
        if (
          hosts.some((host) => host.id === pairing.instanceId) ||
          this.pairings.has(pairing.instanceId)
        )
          throw new Error("This device is already paired or pairing.");
        if (
          hosts.length + this.pairings.size >= MAX_PEER_HOSTS ||
          this.pairings.size >= 2
        )
          throw new Error(
            "The saved or pairing device limit has been reached.",
          );
        assertPeerPairingExpiry(pairing.expiresAt);
        this.pairings.set(pairing.instanceId, controller);
        reserved = true;
      });
      const client = this.client(pairing);
      const exchange = peerRecord(
        await client.json({
          method: "POST",
          path: "/pairing/exchange",
          signal: controller.signal,
          body: {
            secret: pairing.secret,
            deviceName: this.options.deviceName,
            deviceType: this.options.platform,
            clientVersion: this.options.clientVersion,
            acceptsDisplayName: true,
            // Desktop controllers opt into Bot and progress grants, which carry the
            // revision 19 host feed, run-stream and run-control capabilities.
            acceptsBotCapabilities: true,
            acceptsProgressCapabilities: true,
          },
        }),
      );
      assertCurrent();
      if (
        exchange.protocolVersion !== 1 ||
        exchange.instanceId !== pairing.instanceId ||
        exchange.endpoint !== pairing.endpoint ||
        exchange.serverSpkiSha256 !== pairing.serverSpkiSha256
      )
        throw new Error("The pairing identity did not match.");
      const credential = peerText(exchange.credential, 43);
      const server = peerRecord(
        await client.json({
          path: "/server",
          credential,
          signal: controller.signal,
        }),
      );
      assertCurrent();
      if (
        server.instanceId !== pairing.instanceId ||
        server.protocolVersion !== 1
      )
        throw new Error("The paired server identity changed.");
      const grants = peerStrings(exchange.capabilities);
      const serverGrants = peerStrings(server.capabilities);
      const host = parseStoredPeerHosts([
        {
          id: pairing.instanceId,
          name: peerText(server.name, 80),
          deviceId: exchange.deviceId,
          credential,
          enabled: true,
          endpoint: pairing.endpoint,
          serverSpkiSha256: pairing.serverSpkiSha256,
          ...(pairing.caCertificateDerBase64
            ? { caCertificateDerBase64: pairing.caCertificateDerBase64 }
            : {}),
          capabilities: grants.filter((grant) => serverGrants.includes(grant)),
          features: peerStrings(server.features ?? [], 32),
        },
      ])[0]!;
      return await this.locked(async () => {
        assertCurrent();
        const hosts = await this.load();
        if (
          hosts.some((entry) => entry.id === host.id) ||
          hosts.length >= MAX_PEER_HOSTS
        )
          throw new Error("Paired devices changed during pairing.");
        await this.options.storage.save([...hosts, host], current);
        this.hosts = [...hosts, host];
        this.states.set(host.id, "connected");
        this.notify();
        return this.view(host);
      });
    } finally {
      signal?.removeEventListener("abort", abort);
      if (reserved) this.pairings.delete(pairing.instanceId);
    }
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.locked(async () => {
      const hosts = await this.load();
      if (!hosts.some((host) => host.id === id))
        throw new Error("Unknown paired device.");
      const next = hosts.map((host) =>
        host.id === id ? { ...host, enabled } : host,
      );
      await this.options.storage.save(next);
      this.hosts = next;
      this.invalidate(id);
      this.states.set(id, "disconnected");
      this.notify();
    });
  }
  remove(id: string): Promise<void> {
    return this.locked(async () => {
      const next = (await this.load()).filter((host) => host.id !== id);
      await this.options.storage.save(next);
      this.hosts = next;
      this.invalidate(id);
      this.states.delete(id);
      this.epochs.delete(id);
      this.notify();
    });
  }

  /**
   * Verify one enabled host now: identity, protocol, refreshed grants and one
   * negotiation attempt per session. This is the supervisor's connect step.
   */
  async connect(id: string, signal?: AbortSignal): Promise<PeerHostView> {
    const admitted = await this.admit(id, "unary");
    this.verified.delete(id);
    await this.run(id, admitted, signal, async () => undefined);
    const host = this.hosts?.find((entry) => entry.id === id);
    if (!host?.enabled)
      throw new Error("This device is disabled or unavailable.");
    return this.view(host);
  }

  private admit(id: string, partition: PeerRequestPartition): Promise<Admitted> {
    return this.locked(async () => {
      const found = (await this.load()).find(
        (candidate) => candidate.id === hostIdentifier(id),
      );
      if (this.closed) throw new Error("Device connections are closed.");
      if (!found?.enabled)
        throw new Error("This device is disabled or unavailable.");
      const pool = partition === "stream" ? this.streams : this.active;
      const pending = pool.get(id) ?? new Set<AbortController>();
      const total = [...pool.values()].reduce((sum, set) => sum + set.size, 0);
      const full =
        partition === "stream"
          ? pending.size >= PEER_STREAMS_PER_HOST || total >= PEER_STREAMS_TOTAL
          : pending.size >= PEER_UNARY_PER_HOST || total >= PEER_UNARY_TOTAL;
      if (full) throw new Error("Too many pending device operations.");
      const controller = new AbortController();
      pending.add(controller);
      pool.set(id, pending);
      return {
        host: { ...found },
        epoch: this.epochs.get(id) ?? 0,
        controller,
        pool,
      };
    });
  }

  private async run<T>(
    id: string,
    admitted: Admitted,
    signal: AbortSignal | undefined,
    work: (
      host: StoredPeerHost,
      client: PeerClient,
      current: () => boolean,
    ) => Promise<T>,
  ): Promise<T> {
    const { host, epoch, controller, pool } = admitted;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const current = () =>
      !this.closed &&
      !controller.signal.aborted &&
      (this.epochs.get(id) ?? 0) === epoch;
    try {
      if (!current()) throw new Error("Device operation was superseded.");
      const client = this.client(host, host.id);
      await this.verify(host, client, controller.signal, current);
      if (!current()) throw new Error("Device operation was superseded.");
      const result = await work(host, client, current);
      if (!current()) throw new Error("Device operation was superseded.");
      this.states.set(id, "connected");
      return result;
    } catch (error) {
      // A 4xx is an answer from a reachable, verified peer, e.g. an older Aiden
      // without an optional route. 401/403 arrive as authentication_required.
      const answered =
        error instanceof PeerTransportError &&
        error.code === "request_failed" &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500;
      if (current() && answered) {
        this.states.set(id, "connected");
      } else if (current()) {
        this.states.set(id, "unavailable");
        this.verified.delete(id);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      pool.get(id)?.delete(controller);
      if (pool.get(id)?.size === 0) pool.delete(id);
    }
  }

  /**
   * One authenticated request to an enabled host. With `onFrame` it is a
   * stream and resolves with how the stream ended; streams normally use the
   * `stream` partition so they never starve unary operations.
   */
  async request(
    id: string,
    input: Omit<PeerRequest, "credential">,
    onFrame?: (frame: string) => void,
    options: { partition?: PeerRequestPartition; binary?: boolean } = {},
  ): Promise<unknown> {
    const admitted = await this.admit(id, options.partition ?? "unary");
    return this.run(
      id,
      admitted,
      input.signal,
      async (host, client, current) => {
        const request = {
          ...input,
          credential: host.credential,
          signal: admitted.controller.signal,
        };
        if (onFrame) {
          const end = await client.events(request, (frame) => {
            if (current()) onFrame(frame);
          });
          return end ?? ({ reason: "eof" } satisfies PeerStreamEnd);
        }
        if (options.binary) {
          if (!client.binary) throw new PeerTransportError("invalid_response");
          return client.binary(request);
        }
        return client.json(request);
      },
    );
  }

  /**
   * Pinned trust and credential for an enabled host, for main's simulator relay
   * upstream. Callers must never pass either to a renderer.
   */
  relayTarget(
    id: string,
  ): Promise<{ trust: PeerTrust; credential: string } | null> {
    return this.locked(async () => {
      const found = (await this.load()).find((host) => host.id === id);
      if (!found?.enabled) return null;
      return {
        trust: {
          endpoint: found.endpoint,
          serverSpkiSha256: found.serverSpkiSha256,
          ...(found.caCertificateDerBase64
            ? { caCertificateDerBase64: found.caCertificateDerBase64 }
            : {}),
        },
        credential: found.credential,
      };
    });
  }

  close(): void {
    this.closed = true;
    for (const controller of this.pairings.values()) controller.abort();
    for (const id of new Set([
      ...this.active.keys(),
      ...this.streams.keys(),
      ...this.agents.keys(),
    ]))
      this.invalidate(id);
  }
}
