import { isIPv4 } from "node:net";
import {
  hostIdentifier,
  type PeerDiscoveredDevice,
  type PeerDiscoveryState,
} from "../../renderer/shared/peer-host.js";
import {
  normalizeDnsName,
  type AidenTailscaleCommandRunner,
} from "./aiden-remote-tailscale.js";
import type { PeerBootstrapFactory } from "./peer-bootstrap-transport.js";
import type { PeerPairingTarget } from "./peer-host-registry.js";
import { peerRecord } from "./peer-pairing.js";

/** Health probes in flight at once, across Tailscale and LAN candidates. */
export const PEER_PROBE_CONCURRENCY = 4;
export const PEER_PROBE_TIMEOUT_MS = 3_000;
/** Online tailnet desktops probed per scan. */
export const MAX_TAILSCALE_CANDIDATES = 64;
/** Bonjour services probed per scan. */
export const MAX_LAN_CANDIDATES = 64;
/** A scan reads as searching for at least this long while Bonjour answers arrive. */
export const PEER_BROWSE_SETTLE_MS = 3_000;
const MAX_STATUS_CHARS = 256 * 1_024;
const MAX_STATUS_PEERS = 4_096;
const DESKTOP_OS = new Set(["macOS", "linux"]);

/** The fields of one resolved `_aiden-agent._tcp` service that discovery reads. */
export interface PeerBonjourService {
  host?: unknown;
  port?: unknown;
  addresses?: unknown;
  txt?: unknown;
}

/** Browse `_aiden-agent._tcp` until the returned function is called. */
export type PeerBonjourBrowse = (
  onService: (service: PeerBonjourService) => void,
) => () => void;

export interface PeerDiscoveryOptions {
  /** The fixed-path Tailscale CLI, or null when it is not installed. */
  tailscale(): Promise<AidenTailscaleCommandRunner | null>;
  bootstrap: PeerBootstrapFactory;
  browse: PeerBonjourBrowse;
  localInstanceId(): Promise<string>;
  pairedIds(): Promise<string[]>;
  publish(state: PeerDiscoveryState): void;
  /**
   * An installation answered at the IPv4 address Bonjour reported, under the
   * key `spki`. Paired connections may use the address for its `.local`
   * name when that key is the one they pinned.
   */
  lanAddress?(instanceId: string, address: string, spki: string | undefined): void;
  /** Defaults to `PEER_BROWSE_SETTLE_MS`. */
  browseSettleMs?: number;
}

/**
 * MagicDNS names of online desktop peers in `tailscale status --json`.
 * Phones, tablets, Windows nodes and offline peers are skipped; nothing
 * else in the status is read.
 */
export function parseTailscalePeerNames(serialized: string): string[] {
  if (serialized.length > MAX_STATUS_CHARS) return [];
  let root: Record<string, unknown>;
  try {
    root = peerRecord(JSON.parse(serialized));
  } catch {
    return [];
  }
  const peers = root.Peer;
  if (!peers || typeof peers !== "object" || Array.isArray(peers)) return [];
  const names: string[] = [];
  for (const value of Object.values(peers).slice(0, MAX_STATUS_PEERS)) {
    if (!value || typeof value !== "object") continue;
    const peer = value as Record<string, unknown>;
    if (peer.Online !== true || typeof peer.OS !== "string" || !DESKTOP_OS.has(peer.OS))
      continue;
    const name = normalizeDnsName(peer.DNSName);
    if (!name?.includes(".") || names.includes(name)) continue;
    names.push(name);
    if (names.length === MAX_TAILSCALE_CANDIDATES) break;
  }
  return names;
}

function txtInstance(txt: unknown): string | undefined {
  if (!txt || typeof txt !== "object") return undefined;
  const raw = (txt as Record<string, unknown>).instance;
  const value = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  try {
    return hostIdentifier(value);
  } catch {
    return undefined;
  }
}

/** Candidate LAN endpoints for one service: its `.local` name, then one IPv4 address. */
export function lanEndpoints(service: PeerBonjourService): string[] {
  const port = service.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
    return [];
  const endpoints: string[] = [];
  const host = normalizeDnsName(service.host);
  if (host) endpoints.push(`https://${host}:${port}/api/aiden/v1`);
  const addresses = Array.isArray(service.addresses) ? service.addresses.slice(0, 8) : [];
  const ipv4 = addresses.find(
    (address): address is string =>
      typeof address === "string" &&
      /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u.test(address),
  );
  if (ipv4) endpoints.push(`https://${ipv4}:${port}/api/aiden/v1`);
  return endpoints;
}

interface Found extends Omit<PeerDiscoveredDevice, "paired"> {
  endpoint: string;
}

interface Session {
  controller: AbortController;
  stopBrowse: () => void;
  /** Endpoints already probed or queued in this scan. */
  probed: Set<string>;
  found: Map<string, Found>;
  queue: (() => Promise<void>)[];
  active: number;
  lanServices: number;
  tailscaleScan: Promise<void> | undefined;
  /** Until the settle window passes, Bonjour may still announce devices. */
  settle: ReturnType<typeof setTimeout> | undefined;
  self: Promise<string>;
}

/**
 * Finds other Aiden desktops only while the Add device sheet is open: one
 * `tailscale status` read and a Bonjour browse per scan, then a bounded
 * health probe for each candidate. Nothing is persisted and nothing runs
 * once `stop()` is called.
 */
export class PeerDiscovery {
  private session: Session | undefined;
  private emitted = 0;

  constructor(private readonly options: PeerDiscoveryOptions) {}

  get running(): boolean {
    return this.session !== undefined;
  }

  /** Begin a scan, or keep the current one. */
  start(): void {
    if (this.session) return;
    this.scan();
  }

  /** Forget what was found and scan again. */
  refresh(): void {
    this.stop(false);
    this.scan();
  }

  stop(publish = true): void {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    session.controller.abort();
    session.queue.length = 0;
    clearTimeout(session.settle);
    session.stopBrowse();
    if (publish) this.emit();
  }

  /** Where a discovered device would be paired, for the main process only. */
  target(id: string): PeerPairingTarget | undefined {
    const found = this.session?.found.get(id);
    return found
      ? { instanceId: found.id, endpoint: found.endpoint, route: found.route }
      : undefined;
  }

  async state(): Promise<PeerDiscoveryState> {
    const session = this.session;
    if (!session) return { scanning: false, devices: [] };
    const paired = new Set(await this.options.pairedIds().catch(() => []));
    const devices = [...session.found.values()]
      .map(({ endpoint: _endpoint, ...device }) => ({ ...device, paired: paired.has(device.id) }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return {
      scanning:
        session.tailscaleScan !== undefined ||
        session.settle !== undefined ||
        session.active > 0 ||
        session.queue.length > 0,
      devices,
    };
  }

  /** Publish the latest state; an older read never overwrites a newer one. */
  emit(): void {
    const sequence = ++this.emitted;
    void this.state().then((state) => {
      if (sequence === this.emitted) this.options.publish(state);
    });
  }

  private scan(): void {
    const session: Session = {
      controller: new AbortController(),
      stopBrowse: () => undefined,
      probed: new Set(),
      found: new Map(),
      queue: [],
      active: 0,
      lanServices: 0,
      tailscaleScan: undefined,
      settle: undefined,
      self: this.options.localInstanceId().catch(() => ""),
    };
    this.session = session;
    session.tailscaleScan = this.scanTailscale(session).finally(() => {
      session.tailscaleScan = undefined;
      if (this.session === session) this.emit();
    });
    try {
      session.stopBrowse = this.options.browse((service) => this.lanService(session, service));
      session.settle = setTimeout(() => {
        session.settle = undefined;
        if (this.session === session) this.emit();
      }, this.options.browseSettleMs ?? PEER_BROWSE_SETTLE_MS);
    } catch {
      // Local discovery is unavailable; Tailscale and setup codes still work.
    }
    this.emit();
  }

  private async scanTailscale(session: Session): Promise<void> {
    let names: string[];
    try {
      const runner = await this.options.tailscale();
      if (!runner || this.session !== session) return;
      names = parseTailscalePeerNames(await runner.run(["status", "--json"]));
    } catch {
      return;
    }
    if (this.session !== session) return;
    for (const name of names) this.enqueue(session, `https://${name}/api/aiden/v1`, "tailscale");
  }

  private lanService(session: Session, service: PeerBonjourService): void {
    if (this.session !== session || session.lanServices >= MAX_LAN_CANDIDATES) return;
    session.lanServices += 1;
    const instance = txtInstance(service.txt);
    // A device Tailscale already reached needs no LAN probe.
    if (instance && session.found.get(instance)?.route === "tailscale") return;
    const endpoints = lanEndpoints(service).filter((endpoint) => !session.probed.has(endpoint));
    if (endpoints.length === 0) return;
    for (const endpoint of endpoints) session.probed.add(endpoint);
    this.schedule(session, async () => {
      for (const endpoint of endpoints) if (await this.probe(session, endpoint, "lan")) return;
    });
  }

  private enqueue(session: Session, endpoint: string, route: Found["route"]): void {
    if (session.probed.has(endpoint)) return;
    session.probed.add(endpoint);
    this.schedule(session, async () => {
      await this.probe(session, endpoint, route);
    });
  }

  private schedule(session: Session, work: () => Promise<void>): void {
    session.queue.push(work);
    this.drain(session);
    this.emit();
  }

  private drain(session: Session): void {
    while (this.session === session && session.active < PEER_PROBE_CONCURRENCY) {
      const work = session.queue.shift();
      if (!work) return;
      session.active += 1;
      void work().finally(() => {
        session.active -= 1;
        if (this.session !== session) return;
        this.drain(session);
        this.emit();
      });
    }
  }

  /** True when the endpoint answered as an Aiden desktop. */
  private async probe(session: Session, endpoint: string, route: Found["route"]): Promise<boolean> {
    let health: Record<string, unknown>;
    let spki: string | undefined;
    try {
      const client = this.options.bootstrap({
        endpoint,
        mode: route === "tailscale" ? "webpki" : "unverified",
      });
      health = peerRecord(
        await client.json({
          path: "/health?detail=host",
          timeoutMs: PEER_PROBE_TIMEOUT_MS,
          signal: session.controller.signal,
        }),
      );
      spki = client.observedSpki;
    } catch {
      return false;
    }
    if (this.session !== session || health.ok !== true || health.protocolVersion !== 1) return false;
    let id: string;
    try {
      id = hostIdentifier(health.instanceId);
    } catch {
      return false;
    }
    if (id === (await session.self) || this.session !== session) return true;
    const address = route === "lan" ? new URL(endpoint).hostname : undefined;
    if (address && isIPv4(address)) this.options.lanAddress?.(id, address, spki);
    const existing = session.found.get(id);
    if (existing && (existing.route === "tailscale" || route === "lan")) return true;
    // Bounded by Unicode characters, as the host counts them, so a cut never
    // splits a surrogate pair.
    const name =
      typeof health.displayName === "string"
        ? [...health.displayName.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/gu, " ").trim()]
            .slice(0, 80)
            .join("")
        : "";
    session.found.set(id, {
      id,
      name: name || "Aiden desktop",
      ...(health.platform === "mac" || health.platform === "linux"
        ? { platform: health.platform }
        : {}),
      route,
      pairingRequests: health.pairingRequests === true,
      endpoint,
    });
    this.emit();
    return true;
  }
}
