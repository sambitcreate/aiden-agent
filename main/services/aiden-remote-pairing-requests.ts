import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  AIDEN_REMOTE_BOT_CAPABILITIES,
  AIDEN_REMOTE_HOST_CAPABILITIES,
  AIDEN_REMOTE_LEGACY_CAPABILITIES,
  AIDEN_REMOTE_PROGRESS_CAPABILITIES,
  AIDEN_REMOTE_PROTOCOL_VERSION,
} from "./aiden-remote-protocol.js";
import type { AidenRemotePairingExchangeResponse } from "./aiden-remote-pairing.js";
import {
  AIDEN_PAIRING_GRANT_KIND,
  PAIRING_NONCE_BYTES,
  decodeBase64UrlExact,
  pairingRequestCommitment,
  pairingRequestMatchCode,
  parsePairingRequestPublicKey,
  sealPairingRequestEnvelope,
  type AidenPairingRequestEnvelope,
} from "./aiden-remote-sealed-envelope.js";
import type { AidenRemoteStateRegistry } from "./aiden-remote-state.js";

/** How long a request may wait for a decision, measured from creation. */
export const PAIRING_REQUEST_TTL_MS = 2 * 60_000;
/** How long a decided request stays readable so the requester learns the outcome. */
export const PAIRING_REQUEST_RETENTION_MS = 60_000;
/** Upper bound for one long-poll. */
export const PAIRING_REQUEST_POLL_TIMEOUT_MS = 25_000;
export const PAIRING_REQUEST_RATE_WINDOW_MS = 60_000;
export const PAIRING_REQUESTS_PER_SOURCE = 5;
export const PAIRING_REQUESTS_GLOBAL = 20;
export const MAX_OPEN_PAIRING_REQUESTS = 8;
export const MAX_OPEN_PAIRING_REQUESTS_PER_SOURCE = 2;
const MAX_RETAINED_PAIRING_REQUESTS = 64;
const MAX_RATE_LIMIT_SOURCES = 1_024;
const MAX_DEVICE_NAME_CHARACTERS = 80;
const MAX_CLIENT_VERSION_CHARACTERS = 40;
const POLL_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type AidenPairingRequestTransport = "lan" | "tailscale";
export type AidenPairingRequestDeviceType = "mac" | "linux";
/** The states a requester can observe. `approving` is reported as `pending`. */
export type AidenPairingRequestState =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";
type InternalState = AidenPairingRequestState | "approving";

export type AidenPairingRequestTrust =
  | { mode: "private-ca"; caCertificateDerBase64: string }
  | { mode: "system" };

/** The address and TLS identity a requester reached, for the match code and the grant. */
export interface AidenPairingRequestTransportIdentity {
  endpoint: string;
  serverSpkiSha256: string;
  trust: AidenPairingRequestTrust;
}

export interface AidenPairingRequestCreated {
  requestId: string;
  pollSecret: string;
  expiresAt: string;
  hostCommitment: string;
}

export interface AidenPairingRequestStatus {
  requestId: string;
  state: AidenPairingRequestState;
  expiresAt: string;
  envelope?: AidenPairingRequestEnvelope;
}

/** What the host UI shows for a request awaiting a decision. */
export interface AidenPairingRequestPrompt {
  requestId: string;
  deviceName: string;
  deviceType: AidenPairingRequestDeviceType;
  transport: AidenPairingRequestTransport;
  matchCode: string;
  expiresAt: string;
  /** True while an Allow is being committed. */
  approving: boolean;
}

export interface AidenPairingRequestDecisionResult {
  requestId: string;
  state: AidenPairingRequestState;
  /** Set when Allow was chosen but the credential could not be issued. */
  failed?: true;
}

/** The plaintext sealed inside an approved envelope. */
export interface AidenPairingRequestGrant {
  kind: typeof AIDEN_PAIRING_GRANT_KIND;
  requestId: string;
  trust: AidenPairingRequestTrust;
  exchange: AidenRemotePairingExchangeResponse;
}

export interface AidenPairingRequestServiceDependencies {
  instanceId: string;
  devices: Pick<AidenRemoteStateRegistry, "issueDevice" | "revokeDevice">;
  /** The persisted "Accept connection requests" setting. */
  accepting(): boolean;
  resolveTransport(
    transport: AidenPairingRequestTransport,
  ): Promise<AidenPairingRequestTransportIdentity>;
  displayName(): string;
  botCapabilitiesSupported(): boolean;
  hostCapabilitiesSupported(): boolean;
  /** Called whenever the set of prompts or their state may have changed. */
  onChanged?(): void;
  now?(): number;
  randomBytes?(size: number): Buffer;
  /** Run `callback` after `delayMs`; returns a cancel function. */
  schedule?(delayMs: number, callback: () => void): () => void;
  pollTimeoutMs?: number;
}

interface PairingRequestRecord {
  requestId: string;
  secretDigest: Buffer;
  source: string;
  transport: AidenPairingRequestTransport;
  identity: AidenPairingRequestTransportIdentity;
  deviceName: string;
  deviceType: AidenPairingRequestDeviceType;
  clientVersion: string;
  publicKey: string;
  hostNonce: Buffer;
  matchCode?: string;
  createdAt: number;
  expiresAt: number;
  expiresAtIso: string;
  state: InternalState;
  envelope?: AidenPairingRequestEnvelope;
  issuedDeviceId?: string;
  delivered: boolean;
  waiter?: () => void;
  cancelTimer?: () => void;
}

function invalidRequest(message = "Connection request details are invalid."): AidenRemoteServiceError {
  return new AidenRemoteServiceError("invalid_request", message, 400);
}

function notFound(): AidenRemoteServiceError {
  return new AidenRemoteServiceError(
    "not_found",
    "This connection request does not exist or has finished.",
    404,
  );
}

function closed(): AidenRemoteServiceError {
  return new AidenRemoteServiceError(
    "pairing_closed",
    "This computer is not accepting connection requests.",
    403,
  );
}

function rateLimited(retryAfterMs: number): AidenRemoteServiceError {
  return new AidenRemoteServiceError(
    "rate_limited",
    "Too many connection requests. Try again shortly.",
    429,
    true,
    { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)) },
  );
}

function digestSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function characterLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

/**
 * The requester's display name is an unauthenticated claim. Collapse
 * whitespace and refuse control, format (including bidirectional overrides
 * and zero-width characters) and separator characters so the host prompt
 * cannot be visually spoofed.
 */
export function sanitizePairingRequestDeviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[ \t]+/gu, " ");
  if (
    normalized.length === 0 ||
    characterLength(normalized) > MAX_DEVICE_NAME_CHARACTERS ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

interface ParsedCreate {
  deviceName: string;
  deviceType: AidenPairingRequestDeviceType;
  publicKey: string;
  clientVersion: string;
}

function parseCreateBody(value: unknown): ParsedCreate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  const record = value as Record<string, unknown>;
  const allowed = new Set(["deviceName", "deviceType", "publicKey", "clientVersion"]);
  const keys = Object.keys(record);
  if (
    keys.some((key) => !allowed.has(key)) ||
    !keys.includes("deviceName") ||
    !keys.includes("deviceType") ||
    !keys.includes("publicKey")
  ) {
    throw invalidRequest();
  }
  if (record.deviceType === "iphone" || record.deviceType === "ipad") {
    // Phones keep the QR and setup-code flow, which proves physical presence.
    throw new AidenRemoteServiceError(
      "capability_denied",
      "Connection requests are available to desktop devices only.",
      403,
    );
  }
  if (record.deviceType !== "mac" && record.deviceType !== "linux") throw invalidRequest();
  const deviceName = sanitizePairingRequestDeviceName(record.deviceName);
  if (!deviceName) throw invalidRequest("The device name is not valid.");
  if (!parsePairingRequestPublicKey(record.publicKey)) {
    throw invalidRequest("The device key is not valid.");
  }
  let clientVersion = "unknown";
  if (record.clientVersion !== undefined) {
    if (
      typeof record.clientVersion !== "string" ||
      record.clientVersion.length === 0 ||
      characterLength(record.clientVersion) > MAX_CLIENT_VERSION_CHARACTERS ||
      !/^[\x21-\x7e]+$/u.test(record.clientVersion)
    ) {
      throw invalidRequest();
    }
    clientVersion = record.clientVersion;
  }
  return {
    deviceName,
    deviceType: record.deviceType,
    publicKey: record.publicKey as string,
    clientVersion,
  };
}

function parseRevealBody(value: unknown): Buffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "requesterNonce") throw invalidRequest();
  const nonce = decodeBase64UrlExact(record.requesterNonce, PAIRING_NONCE_BYTES);
  if (!nonce) throw invalidRequest("The requester nonce is not valid.");
  return nonce;
}

function publicState(state: InternalState): AidenPairingRequestState {
  return state === "approving" ? "pending" : state;
}

function isOpen(record: PairingRequestRecord): boolean {
  return record.state === "pending" || record.state === "approving";
}

function defaultSchedule(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Host side of unauthenticated desktop connection requests.
 *
 * Requests live only in memory and are bounded by per-source and global
 * rate limits and by an open-request cap. A credential exists only after the
 * person allows the request in the app; it is persisted before the sealed
 * envelope is published, and rolled back when it cannot be delivered.
 */
export class AidenRemotePairingRequestService {
  private readonly records = new Map<string, PairingRequestRecord>();
  private readonly sourceAttempts = new Map<string, number[]>();
  private globalAttempts: number[] = [];
  private readonly retirements = new Map<string, () => void>();
  private readonly orphanedDeviceIds = new Set<string>();
  private closed = false;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly schedule: (delayMs: number, callback: () => void) => () => void;
  private readonly pollTimeoutMs: number;

  constructor(private readonly dependencies: AidenPairingRequestServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.randomBytes ?? cryptoRandomBytes;
    this.schedule = dependencies.schedule ?? defaultSchedule;
    this.pollTimeoutMs = Math.min(
      dependencies.pollTimeoutMs ?? PAIRING_REQUEST_POLL_TIMEOUT_MS,
      PAIRING_REQUEST_POLL_TIMEOUT_MS,
    );
  }

  /** Whether new requests are admitted right now. */
  accepting(): boolean {
    return !this.closed && this.dependencies.accepting();
  }

  async create(
    body: unknown,
    context: { source: string; transport: AidenPairingRequestTransport },
  ): Promise<AidenPairingRequestCreated> {
    if (!this.accepting()) throw closed();
    this.admit(context.source);
    const input = parseCreateBody(body);
    let identity: AidenPairingRequestTransportIdentity;
    try {
      identity = await this.dependencies.resolveTransport(context.transport);
    } catch {
      throw new AidenRemoteServiceError(
        "pairing_closed",
        "This computer cannot accept connection requests on this connection right now.",
        403,
      );
    }
    // The transport lookup awaited; the setting or the service may have
    // changed meanwhile. Capacity is checked after the await so no other
    // create can interleave between the check and the insert.
    if (!this.accepting()) throw closed();
    this.assertCapacity(context.source);

    const now = this.now();
    const requestId = `pairreq_${this.random(24).toString("base64url")}`;
    const pollSecret = this.random(32).toString("base64url");
    const hostNonce = Buffer.from(this.random(PAIRING_NONCE_BYTES));
    const expiresAt = now + PAIRING_REQUEST_TTL_MS;
    const record: PairingRequestRecord = {
      requestId,
      secretDigest: digestSecret(pollSecret),
      source: context.source,
      transport: context.transport,
      identity,
      deviceName: input.deviceName,
      deviceType: input.deviceType,
      clientVersion: input.clientVersion,
      publicKey: input.publicKey,
      hostNonce,
      createdAt: now,
      expiresAt,
      expiresAtIso: new Date(expiresAt).toISOString(),
      state: "pending",
      delivered: false,
    };
    record.cancelTimer = this.schedule(PAIRING_REQUEST_TTL_MS, () => this.expire(record));
    this.records.set(requestId, record);
    return {
      requestId,
      pollSecret,
      expiresAt: record.expiresAtIso,
      hostCommitment: pairingRequestCommitment(requestId, hostNonce),
    };
  }

  /**
   * One-shot nonce exchange. The host nonce was committed to at creation, so
   * neither side can choose its nonce after seeing the other's. The prompt
   * appears only now, when both sides can derive the same match code.
   */
  reveal(requestId: string, secret: string | undefined, body: unknown): { hostNonce: string } {
    const record = this.authorize(requestId, secret);
    const requesterNonce = parseRevealBody(body);
    if (record.matchCode !== undefined) {
      throw new AidenRemoteServiceError(
        "pairing_already_used",
        "This connection request was already started.",
        409,
      );
    }
    this.expireIfDue(record);
    if (record.state === "expired") {
      throw new AidenRemoteServiceError(
        "pairing_expired",
        "This connection request expired.",
        403,
      );
    }
    if (record.state !== "pending") throw closed();
    record.matchCode = pairingRequestMatchCode({
      requesterPublicKey: record.publicKey,
      serverSpkiSha256: record.identity.serverSpkiSha256,
      requestId: record.requestId,
      requesterNonce,
      hostNonce: record.hostNonce,
    });
    this.changed();
    return { hostNonce: record.hostNonce.toString("base64url") };
  }

  /**
   * Long-poll for the request's state. Returns at once when the request is
   * decided, otherwise when it changes, after the poll timeout, when a newer
   * poll replaces this one, or when `signal` aborts.
   */
  async poll(
    requestId: string,
    secret: string | undefined,
    signal?: AbortSignal,
  ): Promise<AidenPairingRequestStatus> {
    const record = this.authorize(requestId, secret);
    this.expireIfDue(record);
    if (isOpen(record) && !signal?.aborted) {
      // One waiter per request: a newer poll answers the older one now.
      record.waiter?.();
      await new Promise<void>((resolve) => {
        let settled = false;
        let cancelTimeout: () => void = () => undefined;
        const finish = () => {
          if (settled) return;
          settled = true;
          cancelTimeout();
          signal?.removeEventListener("abort", finish);
          if (record.waiter === finish) record.waiter = undefined;
          resolve();
        };
        record.waiter = finish;
        cancelTimeout = this.schedule(this.pollTimeoutMs, finish);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return this.status(record, signal?.aborted !== true);
  }

  /**
   * Requester-side cancel. An approved request is withdrawn too, delivered
   * or not: only the requester can open the envelope, so a requester that
   * cancels after collecting it is abandoning its own credential (it could
   * not confirm or save the pairing). The issued device is revoked.
   */
  async cancel(requestId: string, secret: string | undefined): Promise<{ requestId: string; state: AidenPairingRequestState }> {
    const record = this.authorize(requestId, secret);
    this.expireIfDue(record);
    if (isOpen(record)) {
      this.finish(record, "cancelled");
    } else if (record.state === "approved") {
      record.envelope = undefined;
      const deviceId = record.issuedDeviceId;
      record.issuedDeviceId = undefined;
      record.state = "cancelled";
      this.changed();
      if (deviceId) await this.revokeIssued(deviceId);
    }
    return { requestId, state: publicState(record.state) };
  }

  /** Requests awaiting a decision, oldest first, for the host UI. */
  list(): AidenPairingRequestPrompt[] {
    const now = this.now();
    return [...this.records.values()]
      .filter((record) => isOpen(record) && record.matchCode !== undefined && now < record.expiresAt)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => ({
        requestId: record.requestId,
        deviceName: record.deviceName,
        deviceType: record.deviceType,
        transport: record.transport,
        matchCode: record.matchCode!,
        expiresAt: record.expiresAtIso,
        approving: record.state === "approving",
      }));
  }

  /**
   * The person's decision from the host UI. A request that is no longer
   * pending is reported as it stands; a second decision never acts.
   */
  async respond(
    requestId: string,
    decision: "allow" | "deny",
  ): Promise<AidenPairingRequestDecisionResult | null> {
    const record = this.records.get(requestId);
    if (!record) return null;
    this.expireIfDue(record);
    if (record.state !== "pending" || record.matchCode === undefined) {
      return { requestId, state: publicState(record.state) };
    }
    if (decision === "deny") {
      this.finish(record, "denied");
      return { requestId, state: "denied" };
    }
    // Claim the request synchronously so a concurrent decision, cancel or
    // expiry observes `approving` and cannot act a second time.
    record.state = "approving";
    this.changed();
    return this.approve(record);
  }

  /** Cancel every open request (the setting was turned off). */
  cancelOpen(): void {
    for (const record of [...this.records.values()]) {
      if (isOpen(record)) this.finish(record, "cancelled");
    }
  }

  /** Stop admitting requests, cancel open ones and revoke undelivered grants. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelOpen();
    const revocations: Promise<void>[] = [];
    for (const record of [...this.records.values()]) {
      if (record.state === "approved" && !record.delivered && record.issuedDeviceId) {
        revocations.push(this.revokeIssued(record.issuedDeviceId));
      }
      record.waiter?.();
      record.cancelTimer?.();
    }
    for (const cancel of this.retirements.values()) cancel();
    this.retirements.clear();
    this.records.clear();
    for (const deviceId of [...this.orphanedDeviceIds]) {
      revocations.push(this.revokeIssued(deviceId));
    }
    await Promise.all(revocations);
    this.changed();
  }

  private async approve(record: PairingRequestRecord): Promise<AidenPairingRequestDecisionResult> {
    const stillApproving = () =>
      !this.closed &&
      this.records.get(record.requestId) === record &&
      record.state === "approving" &&
      this.now() < record.expiresAt;
    const acceptsBotCapabilities = this.dependencies.botCapabilitiesSupported();
    let issued: Awaited<ReturnType<AidenRemoteStateRegistry["issueDevice"]>>;
    try {
      issued = await this.dependencies.devices.issueDevice({
        name: record.deviceName,
        type: record.deviceType,
        clientVersion: record.clientVersion,
        // Exactly what /pairing/exchange grants a desktop that accepts the
        // Bot and progress vocabularies.
        capabilities: [
          ...AIDEN_REMOTE_LEGACY_CAPABILITIES,
          ...(acceptsBotCapabilities ? AIDEN_REMOTE_BOT_CAPABILITIES : []),
          ...AIDEN_REMOTE_PROGRESS_CAPABILITIES,
          ...(this.dependencies.hostCapabilitiesSupported() ? AIDEN_REMOTE_HOST_CAPABILITIES : []),
        ],
        acceptsBotCapabilities,
        acceptsProgressCapabilities: true,
        authorizeCommit: stillApproving,
      });
    } catch {
      // Nothing durable was written (the commit was refused or the write
      // failed), so there is nothing to roll back.
      if (record.state === "approving") this.finish(record, "cancelled");
      return { requestId: record.requestId, state: publicState(record.state), failed: true };
    }

    if (!stillApproving()) {
      // Cancelled, expired or closed after the device record committed.
      await this.revokeIssued(issued.device.id);
      if (record.state === "approving") this.finish(record, "cancelled");
      return { requestId: record.requestId, state: publicState(record.state) };
    }

    let envelope: AidenPairingRequestEnvelope;
    try {
      const grant: AidenPairingRequestGrant = {
        kind: AIDEN_PAIRING_GRANT_KIND,
        requestId: record.requestId,
        trust: record.identity.trust,
        exchange: {
          protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
          instanceId: this.dependencies.instanceId,
          deviceId: issued.device.id,
          credential: issued.credential,
          capabilities: [...issued.device.capabilities],
          endpoint: record.identity.endpoint,
          serverSpkiSha256: record.identity.serverSpkiSha256,
          displayName: this.dependencies.displayName(),
        },
      };
      envelope = sealPairingRequestEnvelope({
        requestId: record.requestId,
        expiresAt: record.expiresAtIso,
        requesterPublicKey: record.publicKey,
        plaintext: Buffer.from(JSON.stringify(grant), "utf8"),
        randomBytes: this.random,
      });
    } catch {
      await this.revokeIssued(issued.device.id);
      if (record.state === "approving") this.finish(record, "cancelled");
      return { requestId: record.requestId, state: publicState(record.state), failed: true };
    }

    record.issuedDeviceId = issued.device.id;
    record.envelope = envelope;
    this.finish(record, "approved");
    return { requestId: record.requestId, state: "approved" };
  }

  private status(record: PairingRequestRecord, deliver: boolean): AidenPairingRequestStatus {
    const state = publicState(record.state);
    if (state === "approved" && record.envelope) {
      if (deliver) record.delivered = true;
      return {
        requestId: record.requestId,
        state,
        expiresAt: record.expiresAtIso,
        envelope: record.envelope,
      };
    }
    return { requestId: record.requestId, state, expiresAt: record.expiresAtIso };
  }

  private authorize(requestId: string, secret: string | undefined): PairingRequestRecord {
    const record = this.records.get(requestId);
    // Digest both sides so the comparison is constant-time in the secret,
    // and answer an unknown request and a wrong secret identically.
    const wellFormed = typeof secret === "string" && POLL_SECRET_PATTERN.test(secret);
    const presented = digestSecret(wellFormed ? secret : "");
    const expected = record?.secretDigest ?? digestSecret("\u0000");
    const matches = timingSafeEqual(presented, expected);
    if (!record || !wellFormed || !matches) throw notFound();
    return record;
  }

  private expireIfDue(record: PairingRequestRecord): void {
    if (record.state === "pending" && this.now() >= record.expiresAt) this.expire(record);
  }

  private expire(record: PairingRequestRecord): void {
    if (this.records.get(record.requestId) !== record) return;
    if (isOpen(record)) this.finish(record, "expired");
  }

  private finish(record: PairingRequestRecord, state: Exclude<InternalState, "pending" | "approving">): void {
    record.state = state;
    record.cancelTimer?.();
    record.cancelTimer = undefined;
    record.waiter?.();
    this.retirements.get(record.requestId)?.();
    this.retirements.set(
      record.requestId,
      this.schedule(PAIRING_REQUEST_RETENTION_MS, () => {
        void this.retireAndRevoke(record);
      }),
    );
    this.changed();
  }

  private async retireAndRevoke(record: PairingRequestRecord): Promise<void> {
    if (this.records.get(record.requestId) !== record) return;
    const undelivered = record.state === "approved" && !record.delivered ? record.issuedDeviceId : undefined;
    this.retire(record.requestId);
    // Nobody collected this credential before its record retired.
    if (undelivered) await this.revokeIssued(undelivered);
  }

  private retire(requestId: string): void {
    const record = this.records.get(requestId);
    this.retirements.get(requestId)?.();
    this.retirements.delete(requestId);
    if (!record) return;
    record.cancelTimer?.();
    record.waiter?.();
    record.envelope = undefined;
    this.records.delete(requestId);
  }

  private async revokeIssued(deviceId: string): Promise<void> {
    try {
      await this.dependencies.devices.revokeDevice(deviceId);
      this.orphanedDeviceIds.delete(deviceId);
    } catch {
      // The credential never left this process. Keep the id so close()
      // retries; a failed retry leaves a device no client can authenticate as.
      this.orphanedDeviceIds.add(deviceId);
    }
  }

  private admit(source: string): void {
    const now = this.now();
    const windowStart = now - PAIRING_REQUEST_RATE_WINDOW_MS;
    this.globalAttempts = this.globalAttempts.filter((time) => time > windowStart);
    const attempts = (this.sourceAttempts.get(source) ?? []).filter((time) => time > windowStart);
    if (!this.sourceAttempts.has(source) && this.sourceAttempts.size >= MAX_RATE_LIMIT_SOURCES) {
      for (const [key, times] of this.sourceAttempts) {
        if (!times.some((time) => time > windowStart)) this.sourceAttempts.delete(key);
      }
      if (this.sourceAttempts.size >= MAX_RATE_LIMIT_SOURCES) {
        throw rateLimited(PAIRING_REQUEST_RATE_WINDOW_MS);
      }
    }
    if (attempts.length >= PAIRING_REQUESTS_PER_SOURCE) {
      this.sourceAttempts.set(source, attempts);
      throw rateLimited(attempts[0]! + PAIRING_REQUEST_RATE_WINDOW_MS - now);
    }
    if (this.globalAttempts.length >= PAIRING_REQUESTS_GLOBAL) {
      throw rateLimited(this.globalAttempts[0]! + PAIRING_REQUEST_RATE_WINDOW_MS - now);
    }
    attempts.push(now);
    this.sourceAttempts.set(source, attempts);
    this.globalAttempts.push(now);
  }

  private assertCapacity(source: string): void {
    const now = this.now();
    const open = [...this.records.values()].filter(isOpen);
    const soonest = (records: PairingRequestRecord[]) =>
      Math.min(...records.map((record) => record.expiresAt)) - now;
    const fromSource = open.filter((record) => record.source === source);
    if (fromSource.length >= MAX_OPEN_PAIRING_REQUESTS_PER_SOURCE) throw rateLimited(soonest(fromSource));
    if (open.length >= MAX_OPEN_PAIRING_REQUESTS) throw rateLimited(soonest(open));
    if (this.records.size >= MAX_RETAINED_PAIRING_REQUESTS) {
      throw rateLimited(PAIRING_REQUEST_RETENTION_MS);
    }
  }

  private changed(): void {
    try {
      this.dependencies.onChanged?.();
    } catch {
      // A UI notification failure must not change a request's outcome.
    }
  }
}
