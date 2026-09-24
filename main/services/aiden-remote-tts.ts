import { randomUUID } from "node:crypto";
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
interface Session {
  owner: TtsOwner;
  authority: RemoteTtsAuthority;
  requestId: string | null;
  cancelledRequests: Set<string>;
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
  private readonly idleTimer: ReturnType<typeof setInterval>;
  constructor(private readonly service: ReturnType<typeof createTtsService>) {
    this.idleTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (Date.now() - session.touchedAt > 120_000) this.service.stop(session.owner);
      }
    }, 30_000);
    this.idleTimer.unref();
  }

  private session(authority: RemoteTtsAuthority): Session {
    if (this.closed || !authority.current()) throw new AidenRemoteServiceError("credential_revoked", "Read Aloud access is no longer available.", 403);
    const key = JSON.stringify([authority.deviceId, authority.chatId]);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.authority = authority;
      existing.touchedAt = Date.now();
      if (existing.owner.isDestroyed()) throw new AidenRemoteServiceError("credential_revoked", "Read Aloud access is no longer available.", 403);
      return existing;
    }
    // Never evict session identities: reconnect must not turn a possibly billed
    // operation into fresh synthesis. Bytes remain bounded by the shared store.
    if (this.sessions.size >= 256) throw new AidenRemoteServiceError("rate_limited", "The Read Aloud session limit was reached on the desktop.", 429);
    let invalidated = false;
    const listeners = new Set<() => void>();
    const session: Session = {
      authority, requestId: null, jobId: null, source: null, touchedAt: Date.now(), cancelledRequests: new Set(),
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
    const session = authority ? this.session(authority) : null;
    const status = await this.service.status(session?.owner ?? {
      documentId: "remote-tts-status", isDestroyed: () => this.closed,
      onInvalidated: () => () => undefined,
    }, authority?.chatId);
    if (session?.owner.isDestroyed()) throw new AidenRemoteServiceError("credential_revoked", "Read Aloud access was revoked.", 403);
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
    if (session.cancelledRequests.has(request.requestId)) throw new AidenRemoteServiceError("invalid_request", "Read Aloud was stopped before it started.", 409);
    session.requestId = request.requestId;
    try {
      const job = await this.service.start(session.owner, request);
      if (session.requestId === request.requestId) { session.jobId = job.jobId; session.source = request.source; }
      return job;
    } catch (error) {
      if (error instanceof TtsStartError) throw new AidenRemoteServiceError("invalid_request", error.safe.message, 409, false);
      throw error;
    }
  }

  async read(authority: RemoteTtsAuthority, jobId: string, segment: number, offset: number) {
    const session = this.session(authority);
    if (session.jobId !== jobId) throw new AidenRemoteServiceError("not_found", "This soundbite is unavailable.", 404);
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
    const session = this.session(authority);
    const requestId = (input as { requestId: string }).requestId;
    if (!requestId || requestId.length > 128) throw new AidenRemoteServiceError("invalid_request", "Invalid Read Aloud request identity.", 400);
    if (session.cancelledRequests.size >= 1024 && !session.cancelledRequests.has(requestId)) {
      session.invalidate();
      throw new AidenRemoteServiceError("rate_limited", "Read Aloud session limit reached.", 429);
    }
    session.cancelledRequests.add(requestId);
    if (session.requestId === requestId) this.service.stop(session.owner);
    return { ok: true };
  }

  suspend(): void {
    this.closed = true;
    for (const session of this.sessions.values()) this.service.stop(session.owner);
  }

  resume(): void { this.closed = false; }

  revokeDevice(deviceId: string): void {
    for (const session of this.sessions.values()) {
      if (session.authority.deviceId === deviceId) session.invalidate();
    }
  }

  close(): void {
    clearInterval(this.idleTimer);
    this.closed = true;
    for (const session of this.sessions.values()) session.invalidate();
    this.sessions.clear();
  }
}
