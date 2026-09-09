import {
  hostIdentifier,
  LOCAL_HOST_ID,
  MAX_PEER_HOSTS,
  type PeerHostView,
} from "../../renderer/shared/peer-host.js";
import {
  peerRecord,
  peerStrings,
  peerText,
  type PeerPairing,
} from "./peer-pairing.js";
import {
  PeerTransport,
  validatePeerTrust,
  type PeerRequest,
  type PeerTrust,
} from "./peer-transport.js";

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
  events(input: PeerRequest, onFrame: (frame: string) => void): Promise<void>;
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

/** No mutable global target: each request captures one authenticated installation. */
export class PeerHostRegistry {
  private hosts: StoredPeerHost[] | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private active = new Map<string, Set<AbortController>>();
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
  private client(trust: PeerTrust): PeerClient {
    return this.options.client?.(trust) ?? new PeerTransport(trust);
  }
  private invalidate(id: string): void {
    this.verified.delete(id);
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    for (const controller of this.active.get(id) ?? []) controller.abort();
    this.active.delete(id);
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
    if (server.protocolVersion !== 1 || server.instanceId !== host.id)
      throw new Error(
        "The paired server identity changed. Pair this device again.",
      );
    peerStrings(server.capabilities);
    peerStrings(server.features ?? [], 32);
    this.verified.add(host.id);
  }
  private view(host: StoredPeerHost): PeerHostView {
    return {
      id: host.id,
      name: host.name,
      enabled: host.enabled,
      state: host.enabled
        ? (this.states.get(host.id) ?? "disconnected")
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
        if (
          !Number.isFinite(Date.parse(pairing.expiresAt)) ||
          Date.parse(pairing.expiresAt) <= Date.now()
        )
          throw new Error("Pairing code expired.");
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
        this.options.changed?.();
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
      this.options.changed?.();
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
      this.options.changed?.();
    });
  }

  async request(
    id: string,
    input: Omit<PeerRequest, "credential">,
    onFrame?: (frame: string) => void,
  ): Promise<unknown> {
    const { host, epoch, controller } = await this.locked(async () => {
      const found = (await this.load()).find(
        (candidate) => candidate.id === hostIdentifier(id),
      );
      if (this.closed) throw new Error("Device connections are closed.");
      if (!found?.enabled)
        throw new Error("This device is disabled or unavailable.");
      const pending = this.active.get(id) ?? new Set<AbortController>();
      if (
        pending.size >= 8 ||
        [...this.active.values()].reduce((sum, set) => sum + set.size, 0) >= 32
      )
        throw new Error("Too many pending device operations.");
      const controller = new AbortController();
      pending.add(controller);
      this.active.set(id, pending);
      return {
        host: { ...found },
        epoch: this.epochs.get(id) ?? 0,
        controller,
      };
    });
    const abort = () => controller.abort();
    if (input.signal?.aborted) abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const current = () =>
      !this.closed &&
      !controller.signal.aborted &&
      (this.epochs.get(id) ?? 0) === epoch;
    try {
      if (!current()) throw new Error("Device operation was superseded.");
      const client = this.client(host);
      await this.verify(host, client, controller.signal, current);
      if (!current()) throw new Error("Device operation was superseded.");
      const request = {
        ...input,
        credential: host.credential,
        signal: controller.signal,
      };
      const result = onFrame
        ? await client.events(request, (frame) => {
            if (current()) onFrame(frame);
          })
        : await client.json(request);
      if (!current()) throw new Error("Device operation was superseded.");
      this.states.set(id, "connected");
      return result;
    } catch (error) {
      if (current()) {
        this.states.set(id, "unavailable");
        this.verified.delete(id);
      }
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.active.get(id)?.delete(controller);
      if (this.active.get(id)?.size === 0) this.active.delete(id);
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.pairings.values()) controller.abort();
    for (const id of this.active.keys()) this.invalidate(id);
  }
}
