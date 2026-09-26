import { createHash, randomUUID } from "node:crypto";
import { TTS_LIMITS, parseTtsStartRequest, type TtsSourceRef } from "../../renderer/shared/tts.js";
import type { TtsOwner } from "./tts/service.js";
import { TtsStartError, type createTtsService } from "./tts/service.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";

export const REMOTE_TTS_FEATURE = "tts-v1";
export interface RemoteTtsAuthority {
  deviceId: string;
  chatId: string;
  current(): boolean;
  authorize(): Promise<void>;
}
interface IntentEntry { pending: number; retained: boolean }

interface Session {
  owner: TtsOwner;
  authority: RemoteTtsAuthority;
  requestId: string | null;
  sourceIntents: Set<string>;
  requestIntents: Set<string>;
  jobId: string | null;
  source: TtsSourceRef | null;
  touchedAt: number;
  invalidate(): void;
}

/** Playback-only adapter. No mobile settings, credentials, voice or cache mutations.
 * TODO: mobile configuration requires a separately authorized future contract.
 */
export class AidenRemoteTtsService {
  private sessions = new Map<string, Session>();
  private closed = false;
  private readonly revokedDevices = new Set<string>();
  // Compact, bounded anti-rebilling ledgers outlive evictable playback sessions.
  private readonly sourceIntents = new Map<string, IntentEntry>();
  private readonly requestIntents = new Map<string, IntentEntry>();
  private readonly cancelledIntents = new Set<string>();
  private reserveIntent(ledger: Map<string, IntentEntry>, local: Set<string>, key: string) {
    const entry = ledger.get(key) ?? { pending: 0, retained: false };
    entry.pending += 1;
    ledger.set(key, entry);
    local.add(key);
    return (retain: boolean) => {
      entry.pending -= 1;
      entry.retained ||= retain;
      // One preflight rejection must not erase a concurrent or accepted start.
      if (entry.pending === 0 && !entry.retained && ledger.get(key) === entry) {
        ledger.delete(key);
        local.delete(key);
      }
    };
  }
  private intent(authority: RemoteTtsAuthority, value: unknown): string {
    return createHash("sha256").update(JSON.stringify([authority.deviceId, authority.chatId, value])).digest("hex");
  }
  private reclaimIdle(capacity = false): void {
    if (this.closed) return;
    for (const [key, session] of this.sessions) {
      const idle = this.now() - session.touchedAt > 120_000;
      if (idle) this.service.stop(session.owner);
      if (session.owner.isDestroyed() || (capacity && idle)) {
        session.invalidate();
        this.sessions.delete(key);
      }
    }
  }
  private readonly idleTimer: ReturnType<typeof setInterval>;
  constructor(private readonly service: ReturnType<typeof createTtsService>, private readonly now: () => number = Date.now) {
    this.idleTimer = setInterval(() => this.reclaimIdle(), 30_000);
    this.idleTimer.unref();
  }

  private lookup(authority: RemoteTtsAuthority): Session | undefined {
    if (this.closed || this.revokedDevices.has(authority.deviceId) || !authority.current()) throw new AidenRemoteServiceError("credential_revoked", "Read Aloud access is no longer available.", 403);
    const session = this.sessions.get(JSON.stringify([authority.deviceId, authority.chatId]));
    if (session) {
      session.authority = authority;
      session.touchedAt = this.now();
      if (session.owner.isDestroyed()) throw new AidenRemoteServiceError("credential_revoked", "Read Aloud access is no longer available.", 403);
    }
    return session;
  }

  private session(authority: RemoteTtsAuthority): Session {
    const existing = this.lookup(authority);
    if (existing) return existing;
    const key = JSON.stringify([authority.deviceId, authority.chatId]);
    if (this.sessions.size >= 256) this.reclaimIdle(true);
    if (this.sessions.size >= 256) throw new AidenRemoteServiceError("rate_limited", "The Read Aloud session limit was reached on the desktop.", 429);
    let invalidated = false;
    const listeners = new Set<() => void>();
    const session: Session = {
      authority, requestId: null, jobId: null, source: null, touchedAt: this.now(), sourceIntents: new Set(), requestIntents: new Set(),
      invalidate: () => {
        if (invalidated) return;
        invalidated = true;
        for (const callback of [...listeners]) callback();
        listeners.clear();
      },
      owner: {
        kind: "remote",
        documentId: `remote-tts:${randomUUID()}`,
        isDestroyed: () => {
          if (!session.authority.current()) session.invalidate();
          return invalidated || this.closed;
        },
        authorizeSource: async (chatId) => {
          if (chatId !== session.authority.chatId || session.owner.isDestroyed()) throw new Error("Remote speech authorization changed.");
          try { await session.authority.authorize(); }
          catch (error) { session.invalidate(); throw error; }
          if (session.owner.isDestroyed()) throw new Error("Remote speech authorization changed.");
        },
        onInvalidated: (callback) => {
          if (invalidated) { callback(); return () => undefined; }
          listeners.add(callback);
          return () => { listeners.delete(callback); };
        },
      },
    };
    this.sessions.set(key, session);
    return session;
  }

  async status(authority?: RemoteTtsAuthority) {
    const session = authority ? this.lookup(authority) : null;
    const status = await this.service.status(session?.owner ?? {
      documentId: "remote-tts-status", isDestroyed: () => this.closed || (authority != null && !authority.current()),
      onInvalidated: () => () => undefined,
    }, authority?.chatId);
    if ((authority && !authority.current()) || session?.owner.isDestroyed()) throw new AidenRemoteServiceError("credential_revoked", "Read Aloud access was revoked.", 403);
    return {
      enabled: status.settings.enabled, ready: status.synthesisReady,
      settingsRevision: status.settingsRevision,
      source: status.latestSource.source,
      job: session?.jobId ? this.service.jobStatus(session.owner, session.jobId) : null,
    };
  }

  async start(authority: RemoteTtsAuthority, input: unknown) {
    let request;
    try { request = parseTtsStartRequest(input); }
    catch { throw new AidenRemoteServiceError("invalid_request", "Invalid Read Aloud request.", 400); }
    if (request.source.chatId !== authority.chatId) throw new AidenRemoteServiceError("invalid_request", "Read Aloud source does not match this chat.", 400);
    const session = this.session(authority);
    await session.owner.authorizeSource!(authority.chatId);
    const requestIntent = this.intent(authority, request.requestId);
    const sourceIntent = this.intent(authority, [request.source.messageId, request.source.sourceRevision]);
    if (this.cancelledIntents.has(requestIntent)) throw new AidenRemoteServiceError("invalid_request", "Read Aloud was stopped before it started.", 409);
    if ((this.requestIntents.has(requestIntent) && !session.requestIntents.has(requestIntent)) ||
      (this.sourceIntents.has(sourceIntent) && !session.sourceIntents.has(sourceIntent))) {
      throw new AidenRemoteServiceError("not_found", "This soundbite session expired. It will not be generated again automatically.", 404);
    }
    if ((!this.sourceIntents.has(sourceIntent) && this.sourceIntents.size >= 16_384) ||
      (!this.requestIntents.has(requestIntent) && this.requestIntents.size >= 16_384)) {
      throw new AidenRemoteServiceError("rate_limited", "The Read Aloud intent limit was reached on the desktop.", 429);
    }
    const settleSource = this.reserveIntent(this.sourceIntents, session.sourceIntents, sourceIntent);
    const settleRequest = this.reserveIntent(this.requestIntents, session.requestIntents, requestIntent);
    let retain = true; // Accepted or uncertain work remains fenced after eviction.
    session.requestId = request.requestId;
    try {
      const job = await this.service.start(session.owner, request);
      if (session.requestId === request.requestId) { session.jobId = job.jobId; session.source = request.source; }
      return job;
    } catch (error) {
      if (error instanceof TtsStartError) {
        retain = error.safe.generationMayHaveBeenBilled;
        throw new AidenRemoteServiceError("invalid_request", error.safe.message, 409, false);
      }
      throw error;
    } finally {
      settleSource(retain);
      settleRequest(retain);
    }
  }

  async read(authority: RemoteTtsAuthority, jobId: string, segment: number, offset: number) {
    const session = this.lookup(authority);
    if (!session || session.jobId !== jobId) throw new AidenRemoteServiceError("not_found", "This soundbite is unavailable.", 404);
    const status = await this.service.status(session.owner, authority.chatId);
    if (status.latestSource.source?.sourceRevision !== session.source?.sourceRevision ||
      status.latestSource.source?.messageId !== session.source?.messageId) {
      throw new AidenRemoteServiceError("not_found", "The response changed before its audio could be read.", 404);
    }
    if (!status.settings.enabled) throw new AidenRemoteServiceError("capability_denied", "Enable Read Aloud on the desktop.", 403);
    const audio = this.service.readAudio(session.owner, jobId, segment, offset, TTS_LIMITS.audioReadMaxBytes);
    if (!audio) throw new AidenRemoteServiceError("not_found", "This soundbite is no longer retained. It will not be generated again automatically.", 404);
    return { ...audio, bytes: undefined, bytesBase64: Buffer.from(audio.bytes).toString("base64") };
  }

  stop(authority: RemoteTtsAuthority, input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).join() !== "requestId" || typeof (input as { requestId?: unknown }).requestId !== "string") {
      throw new AidenRemoteServiceError("invalid_request", "Invalid Read Aloud stop request.", 400);
    }
    const session = this.lookup(authority);
    const requestId = (input as { requestId: string }).requestId;
    if (!requestId || requestId.length > 128) throw new AidenRemoteServiceError("invalid_request", "Invalid Read Aloud request identity.", 400);
    const intent = this.intent(authority, requestId);
    if (this.cancelledIntents.size >= 16_384 && !this.cancelledIntents.has(intent)) {
      if (session?.requestId === requestId) this.service.stop(session.owner);
      throw new AidenRemoteServiceError("rate_limited", "Read Aloud intent limit reached.", 429);
    }
    this.cancelledIntents.add(intent);
    if (session?.requestId === requestId) this.service.stop(session.owner);
    return { ok: true };
  }

  suspend(): void {
    this.closed = true;
    for (const session of this.sessions.values()) this.service.stop(session.owner);
  }

  resume(): void { this.closed = false; }

  revokeDevice(deviceId: string): void {
    if (this.revokedDevices.size >= 16_384) { this.close(); return; }
    this.revokedDevices.add(deviceId);
    for (const [key, session] of this.sessions) {
      if (session.authority.deviceId === deviceId) { session.invalidate(); this.sessions.delete(key); }
    }
  }

  close(): void {
    clearInterval(this.idleTimer);
    this.closed = true;
    for (const session of this.sessions.values()) session.invalidate();
    this.sessions.clear();
    this.sourceIntents.clear(); this.requestIntents.clear(); this.cancelledIntents.clear();
  }
}
